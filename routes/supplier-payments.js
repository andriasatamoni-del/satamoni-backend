// المرحلة 4B: سداد مورد - Accounts Payable (مدين) مقابل Cash/Bank (دائن). رصيد المورد بيتحسب من سطور
// حساب 2100 المرتبطة بيه (reference_type='supplier') - مفيش عمود "رصيد" مخزّن (كان هيعمل drift).
const express = require("express");
const router = express.Router();
const pool = require("../db/pool");
const { requireAuth, requireRole, assertOwnBranch } = require("../middleware/auth");
const { requirePermission } = require("../middleware/permissions");
const { logAudit } = require("../db/audit");
const { postJournalEntry, getOrCreateBranchCashAccount, getAccountByCode } = require("../db/accounting-engine");

// POST /api/supplier-payments - {supplierId, branchId, amount, paymentMethodId?, referenceNumber?, notes?, idempotencyKey?}
router.post("/", requireAuth, requirePermission("purchasing.create", "accounting.create"), async (req, res) => {
  const { supplierId, branchId, amount, paymentDate, paymentMethodId, referenceNumber, notes, idempotencyKey } = req.body;
  if (!supplierId || !branchId || !amount || Number(amount) <= 0) {
    return res.status(400).json({ error: "لازم مورد وفرع ومبلغ أكبر من صفر" });
  }
  if (!assertOwnBranch(req.user, branchId)) return res.status(403).json({ error: "معندكش صلاحية تسجل سداد من فرع تاني" });

  const client = await pool.connect();
  try {
    const supplier = await client.query("SELECT * FROM suppliers WHERE id = $1", [supplierId]);
    if (supplier.rows.length === 0) return res.status(404).json({ error: "المورد مش موجود" });

    if (idempotencyKey) {
      const existing = await client.query("SELECT * FROM supplier_payments WHERE idempotency_key = $1", [idempotencyKey]);
      if (existing.rows.length > 0) return res.status(200).json({ ...existing.rows[0], duplicate: true });
    }

    await client.query("BEGIN");
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
        `INSERT INTO supplier_payments (supplier_id, branch_id, payment_date, amount, payment_method_id, reference_number, notes, idempotency_key, created_by)
         VALUES ($1,$2,COALESCE($3,CURRENT_DATE),$4,$5,$6,$7,$8,$9) RETURNING *`,
        [supplierId, branchId, paymentDate || null, amount, paymentMethodId || null, referenceNumber || null, notes || null, idempotencyKey || null, req.user.id]
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

    await logAudit(client, {
      branchId, userId: req.user.id, action: "SUPPLIER_PAYMENT_CREATED", entityType: "supplier_payment", entityId: payment.rows[0].id,
      newValues: { supplierId, amount, journalEntryId: je.entry.id }, req,
    });
    await client.query("COMMIT");
    res.status(201).json({ ...payment.rows[0], journal_entry_id: je.entry.id, duplicate: false });
  } catch (err) {
    await client.query("ROLLBACK");
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
