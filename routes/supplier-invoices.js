// Procurement v2 STEP B: فاتورة المورد - طبقة مطابقة (reconciliation) فوق دورة GRN الموجودة، مش استبدال
// أو تكرار ليها. الـGRN وقت /post هو اللي بيرحّل DR 1400/CR 2100 فعليًا (routes/goods-receipts.js) -
// الفاتورة هنا بترصد "المورد طالبنا بكام فعليًا" وتقارنه بالقيمة اللي اترحّلت بالفعل من الـGRN المرتبطة
// (grn_unit_price المحفوظة لحظة إنشاء سطر الفاتورة). الفرق (variance_amount = subtotal - matched_total)
// هو الوحيد اللي بيتحوّل لقيد محاسبي واحد وقت /approve - مش قيد AP كامل تاني، عشان القاعدة الصريحة
// "مفيش تكرار لقيد الـAP". الصيغة دي عمومية فعليًا: سطر مربوط بالكامل بقيمة الـGRN → فرق صفر → مفيش قيد.
// سطر مش مربوط بأي GRN خالص (زي شحن/خدمة على نفس فاتورة المورد) → matched_total له = صفر → الفرق = كامل
// قيمته → بيترحّل مرة واحدة بس (صح، لأنه أصلًا معندوش أي قيد سابق يتكرر معاه)
const express = require("express");
const router = express.Router();
const pool = require("../db/pool");
const { requireAuth, assertOwnBranch } = require("../middleware/auth");
const { requirePermission } = require("../middleware/permissions");
const { logAudit } = require("../db/audit");
const { postJournalEntry, reverseJournalEntry, getAccountByCode } = require("../db/accounting-engine");

const VARIANCE_TOLERANCE = 0.01; // نفس سماحية التقريب المستخدمة في باقي القيود المالية بالمشروع
const CANCELLABLE_STATUSES = ["DRAFT", "MATCHED", "VARIANCE_PENDING", "APPROVED"];

// بيبني سطور الفاتورة، بيتحقق من كل سطر، وبيحسب matched_total/variance بمقارنة كل سطر بسطر الـGRN
// المرتبط بيه (لو موجود) - كل ده جوه transaction واحدة مفتوحة بالفعل (client من الكولر)
async function buildInvoiceLines(client, { supplierId, branchId, lines }) {
  let subtotal = 0;
  let matchedTotal = 0;
  const prepared = [];

  for (const raw of lines) {
    const inventoryItemId = Number(raw.inventoryItemId);
    const invoicedQuantity = Number(raw.invoicedQuantity);
    const unitPrice = Number(raw.unitPrice);
    if (!inventoryItemId) throw new Error("كل سطر فاتورة لازم صنف مخزون محدد");
    if (!invoicedQuantity || invoicedQuantity <= 0) throw new Error("كمية الفاتورة لازم تكون أكبر من صفر");
    if (unitPrice == null || Number.isNaN(unitPrice) || unitPrice < 0) throw new Error("سعر الوحدة لازم يكون رقم صحيح أكبر من أو يساوي صفر");

    let grnUnitPrice = null;
    let goodsReceiptItemId = raw.goodsReceiptItemId ? Number(raw.goodsReceiptItemId) : null;
    if (goodsReceiptItemId) {
      const grnItem = await client.query(
        `SELECT gri.*, gr.supplier_id, gr.branch_id, gr.status AS grn_status
         FROM goods_receipt_items gri JOIN goods_receipts gr ON gr.id = gri.goods_receipt_id
         WHERE gri.id = $1`,
        [goodsReceiptItemId]
      );
      if (grnItem.rows.length === 0) throw new Error(`سطر استلام البضاعة #${goodsReceiptItemId} مش موجود`);
      const g = grnItem.rows[0];
      if (g.grn_status !== "POSTED") throw new Error(`سند الاستلام المرتبط بسطر #${goodsReceiptItemId} لسه مش مرحّل (POSTED) - مينفعش تفوتر عليه`);
      if (Number(g.supplier_id) !== Number(supplierId)) throw new Error(`سطر الاستلام #${goodsReceiptItemId} تابع لمورد تاني`);
      if (Number(g.branch_id) !== Number(branchId)) throw new Error(`سطر الاستلام #${goodsReceiptItemId} تابع لفرع تاني`);
      if (Number(g.inventory_item_id) !== inventoryItemId) throw new Error(`سطر الاستلام #${goodsReceiptItemId} لصنف مختلف عن الصنف المحدد في سطر الفاتورة`);

      // حماية من الفوترة الزيادة عن اللي اتقبل فعليًا في الاستلام - نفس فلسفة over-receive في GRN، بس
      // من غير override (ده تحقق سلامة بيانات، مش قرار تشغيلي محتاج موافقة PIN)
      const alreadyInvoiced = await client.query(
        `SELECT COALESCE(SUM(sil.invoiced_quantity), 0) AS qty
         FROM supplier_invoice_lines sil JOIN supplier_invoices si ON si.id = sil.supplier_invoice_id
         WHERE sil.goods_receipt_item_id = $1 AND si.status <> 'CANCELLED'`,
        [goodsReceiptItemId]
      );
      const alreadyQty = Number(alreadyInvoiced.rows[0].qty);
      if (alreadyQty + invoicedQuantity > Number(g.accepted_quantity) + 0.0000001) {
        throw new Error(`الكمية المفوترة لسطر الاستلام #${goodsReceiptItemId} (${alreadyQty + invoicedQuantity}) أكبر من الكمية المقبولة فعليًا (${g.accepted_quantity})`);
      }
      grnUnitPrice = Number(g.unit_price);
    }

    const lineTotal = invoicedQuantity * unitPrice;
    const grnLineValue = grnUnitPrice != null ? grnUnitPrice * invoicedQuantity : 0;
    const lineVariance = goodsReceiptItemId ? lineTotal - grnLineValue : 0;

    subtotal += lineTotal;
    if (goodsReceiptItemId) matchedTotal += grnLineValue;

    prepared.push({
      goodsReceiptItemId, inventoryItemId, invoicedQuantity, unit: raw.unit || null,
      unitPrice, lineTotal, grnUnitPrice, variance: lineVariance,
    });
  }

  return { prepared, subtotal, matchedTotal };
}

// POST /api/supplier-invoices - {supplierId, branchId, purchaseOrderId?, supplierInvoiceNumber, invoiceDate?,
//  dueDate?, currency?, tax?, notes?, idempotencyKey?, lines:[{goodsReceiptItemId?, inventoryItemId,
//  invoicedQuantity, unit?, unitPrice}]}
// بتتطابق فورًا وقت الإنشاء (مفيش خطوة /match منفصلة) - الحالة الناتجة MATCHED لو الفرق داخل السماحية،
// وإلا VARIANCE_PENDING (لسه محتاجة اعتماد صريح واعي بالفرق قبل الترحيل)
router.post("/", requireAuth, requirePermission("purchasing.create"), async (req, res) => {
  const {
    supplierId, branchId, purchaseOrderId, supplierInvoiceNumber, invoiceDate, dueDate,
    currency, tax, notes, idempotencyKey, lines,
  } = req.body;
  if (!supplierId || !branchId) return res.status(400).json({ error: "لازم مورد وفرع" });
  if (!supplierInvoiceNumber || !String(supplierInvoiceNumber).trim()) return res.status(400).json({ error: "لازم رقم فاتورة المورد" });
  if (!Array.isArray(lines) || lines.length === 0) return res.status(400).json({ error: "لازم سطر واحد على الأقل" });
  if (req.user.role === "branch_manager" && !assertOwnBranch(req.user, branchId)) {
    return res.status(403).json({ error: "معندكش صلاحية تسجل فاتورة مورد لفرع تاني" });
  }

  const client = await pool.connect();
  try {
    const supplier = await client.query("SELECT * FROM suppliers WHERE id = $1", [supplierId]);
    if (supplier.rows.length === 0) return res.status(404).json({ error: "المورد مش موجود" });

    if (idempotencyKey) {
      const existing = await client.query("SELECT * FROM supplier_invoices WHERE idempotency_key = $1", [idempotencyKey]);
      if (existing.rows.length > 0) return res.status(200).json({ ...existing.rows[0], duplicate: true });
    }
    const dup = await client.query(
      "SELECT id FROM supplier_invoices WHERE supplier_id = $1 AND supplier_invoice_number = $2",
      [supplierId, supplierInvoiceNumber]
    );
    if (dup.rows.length > 0) {
      return res.status(409).json({ error: "رقم الفاتورة ده مسجّل بالفعل لنفس المورد", code: "DUPLICATE_INVOICE_NUMBER" });
    }

    await client.query("BEGIN");
    const { prepared, subtotal, matchedTotal } = await buildInvoiceLines(client, { supplierId, branchId, lines });
    const taxAmount = tax != null ? Number(tax) : 0;
    const total = subtotal + taxAmount;
    const varianceAmount = subtotal - matchedTotal;
    const status = Math.abs(varianceAmount) <= VARIANCE_TOLERANCE ? "MATCHED" : "VARIANCE_PENDING";

    let invoice;
    try {
      invoice = await client.query(
        `INSERT INTO supplier_invoices
          (supplier_id, branch_id, purchase_order_id, supplier_invoice_number, invoice_date, due_date, currency,
           subtotal, tax, total, matched_total, variance_amount, status, notes, idempotency_key, created_by)
         VALUES ($1,$2,$3,$4,COALESCE($5,CURRENT_DATE),$6,COALESCE($7,'EGP'),$8,$9,$10,$11,$12,$13,$14,$15,$16)
         RETURNING *`,
        [supplierId, branchId, purchaseOrderId || null, supplierInvoiceNumber, invoiceDate || null, dueDate || null,
         currency || null, subtotal, taxAmount, total, matchedTotal, varianceAmount, status, notes || null,
         idempotencyKey || null, req.user.id]
      );
    } catch (err) {
      if (err.code === "23505" && idempotencyKey) {
        await client.query("ROLLBACK");
        const existing = await client.query("SELECT * FROM supplier_invoices WHERE idempotency_key = $1", [idempotencyKey]);
        return res.status(200).json({ ...existing.rows[0], duplicate: true });
      }
      throw err;
    }

    for (const line of prepared) {
      await client.query(
        `INSERT INTO supplier_invoice_lines
          (supplier_invoice_id, goods_receipt_item_id, inventory_item_id, invoiced_quantity, unit, unit_price,
           line_total, grn_unit_price, variance_amount)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [invoice.rows[0].id, line.goodsReceiptItemId, line.inventoryItemId, line.invoicedQuantity, line.unit,
         line.unitPrice, line.lineTotal, line.grnUnitPrice, line.variance]
      );
    }

    await logAudit(client, {
      branchId, userId: req.user.id, action: "SUPPLIER_INVOICE_CREATED", entityType: "supplier_invoice",
      entityId: invoice.rows[0].id, newValues: { supplierInvoiceNumber, subtotal, total, varianceAmount, status }, req,
    });
    await client.query("COMMIT");
    res.status(201).json({ ...invoice.rows[0], duplicate: false });
  } catch (err) {
    await client.query("ROLLBACK");
    res.status(400).json({ error: err.message });
  } finally {
    client.release();
  }
});

// GET /api/supplier-invoices?supplierId=&branchId=&status=
router.get("/", requireAuth, requirePermission("purchasing.view"), async (req, res) => {
  let { supplierId, branchId, status } = req.query;
  if (req.user.role === "branch_manager") branchId = req.user.branchId;
  const conditions = [];
  const values = [];
  let i = 1;
  if (supplierId) { conditions.push(`si.supplier_id = $${i++}`); values.push(supplierId); }
  if (branchId) { conditions.push(`si.branch_id = $${i++}`); values.push(branchId); }
  if (status) { conditions.push(`si.status = $${i++}`); values.push(status); }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  try {
    const result = await pool.query(
      `SELECT si.*, s.name AS supplier_name, b.name AS branch_name
       FROM supplier_invoices si JOIN suppliers s ON s.id = si.supplier_id JOIN branches b ON b.id = si.branch_id
       ${where} ORDER BY si.id DESC LIMIT 500`,
      values
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/supplier-invoices/:id
router.get("/:id", requireAuth, requirePermission("purchasing.view"), async (req, res) => {
  try {
    const invoice = await pool.query(
      `SELECT si.*, s.name AS supplier_name, b.name AS branch_name
       FROM supplier_invoices si JOIN suppliers s ON s.id = si.supplier_id JOIN branches b ON b.id = si.branch_id
       WHERE si.id = $1`,
      [req.params.id]
    );
    if (invoice.rows.length === 0) return res.status(404).json({ error: "فاتورة المورد مش موجودة" });
    if (req.user.role === "branch_manager" && !assertOwnBranch(req.user, invoice.rows[0].branch_id)) {
      return res.status(403).json({ error: "معندكش صلاحية تشوف فاتورة فرع تاني" });
    }
    const lines = await pool.query(
      `SELECT sil.*, ii.name AS item_name, gri.goods_receipt_id
       FROM supplier_invoice_lines sil
       JOIN inventory_items ii ON ii.id = sil.inventory_item_id
       LEFT JOIN goods_receipt_items gri ON gri.id = sil.goods_receipt_item_id
       WHERE sil.supplier_invoice_id = $1`,
      [req.params.id]
    );
    const payments = await pool.query(
      "SELECT id, amount, payment_date, status FROM supplier_payments WHERE supplier_invoice_id = $1 ORDER BY id",
      [req.params.id]
    );
    res.json({ invoice: invoice.rows[0], lines: lines.rows, payments: payments.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/supplier-invoices/:id/approve - بيرحّل قيد الفرق بس (لو موجود) ويحوّل الحالة لـAPPROVED.
// من MATCHED أو VARIANCE_PENDING بس - اعتماد فاتورة فيها فرق لازم يكون قرار واعي (نفس فلسفة موافقة
// الاستلام الزايد)، مش تلقائي أبدًا
router.post("/:id/approve", requireAuth, requirePermission("purchasing.approve"), async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const invoice = await client.query("SELECT * FROM supplier_invoices WHERE id = $1 FOR UPDATE", [req.params.id]);
    if (invoice.rows.length === 0) { await client.query("ROLLBACK"); return res.status(404).json({ error: "فاتورة المورد مش موجودة" }); }
    if (!assertOwnBranch(req.user, invoice.rows[0].branch_id)) {
      await client.query("ROLLBACK");
      return res.status(403).json({ error: "معندكش صلاحية تعتمد فاتورة فرع تاني" });
    }
    if (invoice.rows[0].status === "APPROVED") {
      await client.query("ROLLBACK");
      return res.status(200).json({ ...invoice.rows[0], duplicate: true });
    }
    if (!["MATCHED", "VARIANCE_PENDING"].includes(invoice.rows[0].status)) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "الفاتورة دي مش في حالة قابلة للاعتماد" });
    }

    const varianceAmount = Number(invoice.rows[0].variance_amount);
    let journalEntryId = null;
    if (Math.abs(varianceAmount) > 0.0000001) {
      const inventoryAccount = await getAccountByCode(client, "1400");
      const apAccount = await getAccountByCode(client, "2100");
      const lines = varianceAmount > 0
        ? [
            { accountId: inventoryAccount.id, debit: varianceAmount, description: `فرق فاتورة مورد #${invoice.rows[0].id} عن قيمة الاستلام` },
            { accountId: apAccount.id, credit: varianceAmount, referenceType: "supplier", referenceId: invoice.rows[0].supplier_id },
          ]
        : [
            { accountId: apAccount.id, debit: -varianceAmount, referenceType: "supplier", referenceId: invoice.rows[0].supplier_id },
            { accountId: inventoryAccount.id, credit: -varianceAmount, description: `فرق فاتورة مورد #${invoice.rows[0].id} عن قيمة الاستلام` },
          ];
      const je = await postJournalEntry(client, {
        entryDate: new Date().toISOString().slice(0, 10),
        description: `فرق فاتورة مورد #${invoice.rows[0].id} (${invoice.rows[0].supplier_invoice_number})`,
        sourceType: "supplier_invoice_variance", sourceId: invoice.rows[0].id, branchId: invoice.rows[0].branch_id,
        lines, idempotencyKey: `supplier-invoice-variance-${invoice.rows[0].id}`, userId: req.user.id,
      });
      journalEntryId = je.entry.id;
    }

    const updated = await client.query(
      `UPDATE supplier_invoices SET status = 'APPROVED', approved_by = $1, approved_at = now(),
              variance_journal_entry_id = $2, updated_at = now()
       WHERE id = $3 RETURNING *`,
      [req.user.id, journalEntryId, req.params.id]
    );
    await logAudit(client, {
      branchId: invoice.rows[0].branch_id, userId: req.user.id, action: "SUPPLIER_INVOICE_APPROVED",
      entityType: "supplier_invoice", entityId: invoice.rows[0].id, metadata: { varianceAmount, journalEntryId }, req,
    });
    await client.query("COMMIT");
    res.json({ ...updated.rows[0], duplicate: false });
  } catch (err) {
    await client.query("ROLLBACK");
    res.status(400).json({ error: err.message });
  } finally {
    client.release();
  }
});

// POST /api/supplier-invoices/:id/cancel - {reason?} - متاح طالما مفيش سداد اتخصص عليها. لو كانت APPROVED
// وليها قيد فرق مرحّل، بيتعكس (قيد جديد معكوس، نفس فلسفة إلغاء GRN)
router.post("/:id/cancel", requireAuth, requirePermission("purchasing.cancel"), async (req, res) => {
  const { reason } = req.body;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const invoice = await client.query("SELECT * FROM supplier_invoices WHERE id = $1 FOR UPDATE", [req.params.id]);
    if (invoice.rows.length === 0) { await client.query("ROLLBACK"); return res.status(404).json({ error: "فاتورة المورد مش موجودة" }); }
    if (!assertOwnBranch(req.user, invoice.rows[0].branch_id)) {
      await client.query("ROLLBACK");
      return res.status(403).json({ error: "معندكش صلاحية تلغي فاتورة فرع تاني" });
    }
    if (invoice.rows[0].status === "CANCELLED") {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "الفاتورة دي اتلغت بالفعل" });
    }
    if (!CANCELLABLE_STATUSES.includes(invoice.rows[0].status)) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "الفاتورة دي متسدد عليها بالفعل - مينفعش تتلغي" });
    }
    const paymentCheck = await client.query(
      "SELECT COUNT(*)::int AS n FROM supplier_payments WHERE supplier_invoice_id = $1", [req.params.id]
    );
    if (paymentCheck.rows[0].n > 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "فيه سدادات مخصصة على الفاتورة دي بالفعل - مينفعش تتلغي" });
    }

    if (invoice.rows[0].variance_journal_entry_id) {
      await reverseJournalEntry(client, {
        originalEntryId: invoice.rows[0].variance_journal_entry_id, entryDate: new Date().toISOString().slice(0, 10),
        reason: `إلغاء فاتورة مورد - ${reason || ""}`, userId: req.user.id,
        idempotencyKey: `supplier-invoice-variance-cancel-${invoice.rows[0].id}`,
      });
    }

    const updated = await client.query(
      `UPDATE supplier_invoices SET status = 'CANCELLED', cancelled_by = $1, cancelled_at = now(), updated_at = now()
       WHERE id = $2 RETURNING *`,
      [req.user.id, req.params.id]
    );
    await logAudit(client, {
      branchId: invoice.rows[0].branch_id, userId: req.user.id, action: "SUPPLIER_INVOICE_CANCELLED",
      entityType: "supplier_invoice", entityId: invoice.rows[0].id, metadata: { reason }, req,
    });
    await client.query("COMMIT");
    res.json(updated.rows[0]);
  } catch (err) {
    await client.query("ROLLBACK");
    res.status(400).json({ error: err.message });
  } finally {
    client.release();
  }
});

module.exports = router;
