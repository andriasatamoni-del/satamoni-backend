// المرحلة 4B: سداد مورد - Accounts Payable (مدين) مقابل Cash/Bank (دائن). رصيد المورد بيتحسب من سطور
// حساب 2100 المرتبطة بيه (reference_type='supplier') - مفيش عمود "رصيد" مخزّن (كان هيعمل drift).
// Procurement v2 STEP C: السداد بقى ممكن (اختياري) يتخصص على فاتورة مورد محددة (supplierInvoiceId) بدل
// ما يفضل بس على الرصيد العام للمورد - نفس القيد المحاسبي بالظبط (مفيش فرق في الترحيل نفسه)، بس بيتتبّع
// إجمالي المسدد على الفاتورة دي وبيحدّث حالتها (APPROVED → PARTIALLY_PAID/PAID) عشان تقفيلها يبقى واضح
const express = require("express");
const router = express.Router();
const pool = require("../db/pool");
const { requireAuth, requireRole, assertOwnBranch } = require("../middleware/auth");
const { requirePermission } = require("../middleware/permissions");
const { logAudit } = require("../db/audit");
const { postJournalEntry, getOrCreateBranchCashAccount, getAccountByCode } = require("../db/accounting-engine");

const PAYABLE_INVOICE_STATUSES = ["APPROVED", "PARTIALLY_PAID"];
const INVOICE_TOLERANCE = 0.01;

// POST /api/supplier-payments - {supplierId, branchId, amount, supplierInvoiceId?, paymentMethodId?, referenceNumber?, notes?, idempotencyKey?}
router.post("/", requireAuth, requirePermission("purchasing.create", "accounting.create"), async (req, res) => {
  const { supplierId, branchId, amount, supplierInvoiceId, paymentDate, paymentMethodId, referenceNumber, notes, idempotencyKey } = req.body;
  if (!supplierId || !branchId || !amount || Number(amount) <= 0) {
    return res.status(400).json({ error: "لازم مورد وفرع ومبلغ أكبر من صفر" });
  }
  // المرحلة 6.5 (متابعة): assertOwnBranch كان بيتطبّق على أي دور مش أدمن - المحاسب (accountant) دور
  // مركزي غير مربوط بفرع (branch_id = NULL) بالتصميم، فكان بيترفض دايمًا مهما كان الفرع المحدد، رغم
  // إن الـendpoint نفسه صراحة بيقبل صلاحية accounting.create كبديل لـpurchasing.create (سطر الـpermission
  // فوق). ده تناقض حقيقي اتكشف في التحقق التشغيلي (Phase 6.5): محاسب عنده صلاحية معلنة للسداد بس
  // مايقدرش يستخدمها لأي فرع خالص. الفحص هنا بقى مقصور على مدير الفرع بس (نفس النمط المستخدم فعليًا
  // في routes/expenses.js وفي GET / في نفس الملف ده) - أدوار مركزية (أدمن/محاسب) وصولها عبر الفروع
  // بالتصميم، مش لازم تتقيّد بفرع واحد
  if (req.user.role === "branch_manager" && !assertOwnBranch(req.user, branchId)) {
    return res.status(403).json({ error: "معندكش صلاحية تسجل سداد من فرع تاني" });
  }

  const client = await pool.connect();
  try {
    const supplier = await client.query("SELECT * FROM suppliers WHERE id = $1", [supplierId]);
    if (supplier.rows.length === 0) return res.status(404).json({ error: "المورد مش موجود" });

    if (idempotencyKey) {
      const existing = await client.query("SELECT * FROM supplier_payments WHERE idempotency_key = $1", [idempotencyKey]);
      if (existing.rows.length > 0) return res.status(200).json({ ...existing.rows[0], duplicate: true });
    }

    await client.query("BEGIN");

    // لو السداد مخصص على فاتورة محددة: قفل صف الفاتورة (FOR UPDATE) قبل أي حساب - عشان سدادين متزامنين
    // على نفس الفاتورة يتسلسلوا (مش يعدّوا "المتبقي" مع بعض ويعملوا سداد زيادة). نفس نمط قفل GRN/production
    // order قبل أي فحص حالة في باقي المشروع بالظبط
    let invoice = null;
    if (supplierInvoiceId) {
      const invRes = await client.query("SELECT * FROM supplier_invoices WHERE id = $1 FOR UPDATE", [supplierInvoiceId]);
      if (invRes.rows.length === 0) throw Object.assign(new Error("فاتورة المورد المحددة مش موجودة"), { code: "INVOICE_PAYMENT_VALIDATION" });
      invoice = invRes.rows[0];
      if (Number(invoice.supplier_id) !== Number(supplierId)) throw Object.assign(new Error("الفاتورة دي تابعة لمورد تاني"), { code: "INVOICE_PAYMENT_VALIDATION" });
      if (Number(invoice.branch_id) !== Number(branchId)) throw Object.assign(new Error("الفاتورة دي تابعة لفرع تاني"), { code: "INVOICE_PAYMENT_VALIDATION" });
      if (!PAYABLE_INVOICE_STATUSES.includes(invoice.status)) {
        throw Object.assign(new Error("الفاتورة دي مش في حالة قابلة للسداد (لازم تكون معتمدة الأول)"), { code: "INVOICE_PAYMENT_VALIDATION" });
      }
      const paidRes = await client.query(
        "SELECT COALESCE(SUM(amount), 0) AS paid FROM supplier_payments WHERE supplier_invoice_id = $1", [supplierInvoiceId]
      );
      const alreadyPaid = Number(paidRes.rows[0].paid);
      if (alreadyPaid + Number(amount) > Number(invoice.total) + INVOICE_TOLERANCE) {
        throw Object.assign(
          new Error(`المبلغ أكبر من المتبقي على الفاتورة (المتبقي ${(Number(invoice.total) - alreadyPaid).toFixed(2)})`),
          { code: "INVOICE_PAYMENT_VALIDATION" }
        );
      }
    }

    const ap = await getAccountByCode(client, "2100");
    let cashAccount;
    let paymentMethodKind = "cash";
    if (paymentMethodId) {
      const pm = await client.query("SELECT kind FROM payment_methods WHERE id = $1", [paymentMethodId]);
      paymentMethodKind = pm.rows[0]?.kind || "cash";
    }
    cashAccount = paymentMethodKind === "cash"
      ? await getOrCreateBranchCashAccount(client, branchId)
      : await getAccountByCode(client, "1200");

    let payment;
    try {
      payment = await client.query(
        `INSERT INTO supplier_payments (supplier_id, branch_id, payment_date, amount, supplier_invoice_id, payment_method_id, reference_number, notes, idempotency_key, created_by)
         VALUES ($1,$2,COALESCE($3,CURRENT_DATE),$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [supplierId, branchId, paymentDate || null, amount, supplierInvoiceId || null, paymentMethodId || null,
         referenceNumber || null, notes || null, idempotencyKey || null, req.user.id]
      );
    } catch (err) {
      if (err.code === "23505" && idempotencyKey) {
        await client.query("ROLLBACK");
        const existing = await client.query("SELECT * FROM supplier_payments WHERE idempotency_key = $1", [idempotencyKey]);
        return res.status(200).json({ ...existing.rows[0], duplicate: true });
      }
      throw err;
    }

    const je = await postJournalEntry(client, {
      entryDate: payment.rows[0].payment_date, description: `سداد مورد: ${supplier.rows[0].name}`,
      sourceType: "supplier_payment", sourceId: payment.rows[0].id, branchId,
      lines: [
        { accountId: ap.id, debit: amount, referenceType: "supplier", referenceId: Number(supplierId), description: `سداد لـ${supplier.rows[0].name}` },
        { accountId: cashAccount.id, credit: amount },
      ],
      idempotencyKey: `supplier-payment-${payment.rows[0].id}`, userId: req.user.id,
    });
    await client.query("UPDATE supplier_payments SET journal_entry_id = $1 WHERE id = $2", [je.entry.id, payment.rows[0].id]);

    if (invoice) {
      const totalPaidRes = await client.query(
        "SELECT COALESCE(SUM(amount), 0) AS paid FROM supplier_payments WHERE supplier_invoice_id = $1", [supplierInvoiceId]
      );
      const totalPaid = Number(totalPaidRes.rows[0].paid);
      const newStatus = totalPaid >= Number(invoice.total) - INVOICE_TOLERANCE ? "PAID" : "PARTIALLY_PAID";
      await client.query("UPDATE supplier_invoices SET status = $1, updated_at = now() WHERE id = $2", [newStatus, supplierInvoiceId]);
    }

    await logAudit(client, {
      branchId, userId: req.user.id, action: "SUPPLIER_PAYMENT_CREATED", entityType: "supplier_payment", entityId: payment.rows[0].id,
      newValues: { supplierId, amount, supplierInvoiceId: supplierInvoiceId || null, journalEntryId: je.entry.id }, req,
    });
    await client.query("COMMIT");
    res.status(201).json({ ...payment.rows[0], journal_entry_id: je.entry.id, duplicate: false });
  } catch (err) {
    await client.query("ROLLBACK");
    if (err.code === "INVOICE_PAYMENT_VALIDATION") return res.status(400).json({ error: err.message });
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// GET /api/supplier-payments?supplierId=&branchId=
router.get("/", requireAuth, requirePermission("purchasing.view", "accounting.view"), async (req, res) => {
  let { supplierId, branchId } = req.query;
  if (req.user.role === "branch_manager") branchId = req.user.branchId;
  const conditions = [];
  const values = [];
  let i = 1;
  if (supplierId) { conditions.push(`sp.supplier_id = $${i++}`); values.push(supplierId); }
  if (branchId) { conditions.push(`sp.branch_id = $${i++}`); values.push(branchId); }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  try {
    const result = await pool.query(
      `SELECT sp.*, s.name AS supplier_name, b.name AS branch_name
       FROM supplier_payments sp JOIN suppliers s ON s.id = sp.supplier_id JOIN branches b ON b.id = sp.branch_id
       ${where} ORDER BY sp.id DESC LIMIT 500`,
      values
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/supplier-payments/balance/:supplierId - رصيد المورد الحالي (مجموع سطور 2100 المرتبطة بيه)
// status <> 'DRAFT' (مش status = 'POSTED' بس) عمدًا: لو قيد اتعكس، حالته بتبقى REVERSED مش POSTED، فلو
// استبعدناه هيفضل بيحسب أثره الأصلي "متجاهل" بينما قيد العكس (POSTED) بيتحسب - يعني بدل ما يترصّدوا صفر
// (الأصلي + العكسي = لا أثر) هيظهر وكأن بس العكس حصل. الاستبعاد الصح الوحيد هو المسودات (DRAFT) اللي لسه
// مترحّلتش خالص
router.get("/balance/:supplierId", requireAuth, requirePermission("purchasing.view", "accounting.view"), async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT COALESCE(SUM(jel.credit) - SUM(jel.debit), 0) AS balance
       FROM journal_entry_lines jel
       JOIN journal_entries je ON je.id = jel.journal_entry_id
       WHERE jel.reference_type = 'supplier' AND jel.reference_id = $1 AND je.status <> 'DRAFT'`,
      [req.params.supplierId]
    );
    res.json({ supplierId: Number(req.params.supplierId), balance: Number(result.rows[0].balance) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
