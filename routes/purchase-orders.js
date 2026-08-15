// المرحلة 4A: أمر الشراء الرسمي لمورد محدد. الاستلام الفعلي منفصل تمامًا (goods-receipts.js) - PO هنا
// بيسجل الالتزام (الكمية/السعر المتفق عليه) بس، مفيش أي لمسة للمخزون هنا خالص.
const express = require("express");
const router = express.Router();
const pool = require("../db/pool");
const { requireAuth, requireRole, assertOwnBranch } = require("../middleware/auth");
const { requirePermission } = require("../middleware/permissions");
const { logAudit } = require("../db/audit");

const EDITABLE_STATUSES = ["DRAFT"];

function computeTotals(items) {
  let subtotal = 0, discount = 0, tax = 0;
  for (const it of items) {
    const lineSubtotal = Number(it.orderedQuantity) * Number(it.unitPrice);
    subtotal += lineSubtotal;
    discount += Number(it.discount) || 0;
    tax += Number(it.tax) || 0;
  }
  return { subtotal, discount, tax, total: subtotal - discount + tax };
}

async function insertItems(client, purchaseOrderId, items) {
  for (const it of items) {
    if (!it.inventoryItemId || !it.orderedQuantity || Number(it.orderedQuantity) <= 0 || it.unitPrice === undefined || Number(it.unitPrice) < 0) {
      throw new Error("كل صنف لازم يكون له كمية أكبر من صفر وسعر صحيح");
    }
    const lineTotal = Number(it.orderedQuantity) * Number(it.unitPrice) - (Number(it.discount) || 0) + (Number(it.tax) || 0);
    await client.query(
      `INSERT INTO purchase_order_items (purchase_order_id, inventory_item_id, ordered_quantity, unit, unit_price, discount, tax, total)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [purchaseOrderId, it.inventoryItemId, it.orderedQuantity, it.unit || null, it.unitPrice,
       it.discount || 0, it.tax || 0, lineTotal]
    );
  }
}

// السعر الساري حاليًا (المسجّل في supplier_items، المرحلة 4A) - previousPrice لمقارنة انحراف السعر (بند 11)
async function currentSupplierPrice(client, supplierId, inventoryItemId) {
  const res = await client.query(
    `SELECT unit_price FROM supplier_items WHERE supplier_id = $1 AND inventory_item_id = $2 AND effective_to IS NULL`,
    [supplierId, inventoryItemId]
  );
  return res.rows[0]?.unit_price != null ? Number(res.rows[0].unit_price) : null;
}

function priceVariance(previousPrice, newPrice) {
  if (previousPrice == null) return { previousPrice: null, newPrice, difference: null, differencePercent: null };
  const difference = newPrice - previousPrice;
  return {
    previousPrice, newPrice, difference,
    differencePercent: previousPrice !== 0 ? (difference / previousPrice) * 100 : null,
  };
}

// POST /api/purchase-orders - {supplierId, branchId, purchaseRequestId?, expectedDeliveryDate?, paymentTerms?,
//  currency?, notes?, idempotencyKey?, items:[{inventoryItemId, orderedQuantity, unit?, unitPrice, discount?, tax?}]}
router.post("/", requireAuth, requirePermission("purchasing.create"), async (req, res) => {
  const {
    supplierId, branchId, purchaseRequestId, expectedDeliveryDate, paymentTerms,
    currency, notes, idempotencyKey, items,
  } = req.body;
  if (!supplierId || !branchId) return res.status(400).json({ error: "لازم تحدد المورد والفرع" });
  if (!assertOwnBranch(req.user, branchId)) return res.status(403).json({ error: "معندكش صلاحية تنشئ أمر شراء لفرع تاني" });
  if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: "لازم صنف واحد على الأقل" });

  const client = await pool.connect();
  try {
    const supplier = await client.query("SELECT * FROM suppliers WHERE id = $1", [supplierId]);
    if (supplier.rows.length === 0) return res.status(404).json({ error: "المورد مش موجود" });
    if (supplier.rows[0].status !== "ACTIVE") return res.status(400).json({ error: "المورد ده مش نشط (INACTIVE/BLOCKED) - مينفعش تعمله أمر شراء" });

    let purchaseRequest = null;
    if (purchaseRequestId) {
      const prRes = await client.query("SELECT * FROM purchase_requests WHERE id = $1", [purchaseRequestId]);
      if (prRes.rows.length === 0) return res.status(404).json({ error: "طلب الشراء المرتبط مش موجود" });
      purchaseRequest = prRes.rows[0];
      if (purchaseRequest.status !== "APPROVED") return res.status(400).json({ error: "طلب الشراء المرتبط لازم يكون APPROVED الأول" });
      if (String(purchaseRequest.branch_id) !== String(branchId)) return res.status(400).json({ error: "طلب الشراء ده لفرع تاني" });
    }

    const { subtotal, discount, tax, total } = computeTotals(items);

    await client.query("BEGIN");
    let po;
    try {
      po = await client.query(
        `INSERT INTO purchase_orders
          (supplier_id, branch_id, purchase_request_id, expected_delivery_date, payment_terms, currency,
           subtotal, discount, tax, total, notes, created_by, idempotency_key)
         VALUES ($1,$2,$3,$4,$5,COALESCE($6,$7),$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
        [supplierId, branchId, purchaseRequestId || null, expectedDeliveryDate || null, paymentTerms || null,
         currency || null, supplier.rows[0].default_currency, subtotal, discount, tax, total, notes || null,
         req.user.id, idempotencyKey || null]
      );
    } catch (err) {
      if (err.code === "23505" && idempotencyKey) {
        // لازم ROLLBACK الأول - الـtransaction بقت "aborted" بعد الخطأ، وأي query تاني (حتى SELECT)
        // هيترفض لحد ما تعمل ROLLBACK/COMMIT (نفس باج اتصلح قبل كده في orders.js بالظبط)
        await client.query("ROLLBACK");
        const existing = await client.query("SELECT * FROM purchase_orders WHERE idempotency_key = $1", [idempotencyKey]);
        return res.status(200).json({ ...existing.rows[0], duplicate: true });
      }
      throw err;
    }
    await insertItems(client, po.rows[0].id, items);

    if (purchaseRequest) {
      await client.query(`UPDATE purchase_requests SET status = 'CONVERTED_TO_PO', updated_at = now() WHERE id = $1`, [purchaseRequest.id]);
      await logAudit(client, {
        branchId, userId: req.user.id, action: "PURCHASE_REQUEST_CONVERTED_TO_PO", entityType: "purchase_request",
        entityId: purchaseRequest.id, metadata: { purchaseOrderId: po.rows[0].id }, req,
      });
    }

    await logAudit(client, {
      branchId, userId: req.user.id, action: "PURCHASE_ORDER_CREATED", entityType: "purchase_order",
      entityId: po.rows[0].id, newValues: { supplierId, items, total }, req,
    });
    await client.query("COMMIT");
    res.status(201).json({ ...po.rows[0], duplicate: false });
  } catch (err) {
    await client.query("ROLLBACK");
    res.status(400).json({ error: err.message });
  } finally {
    client.release();
  }
});

// GET /api/purchase-orders?branchId=&status=&supplierId=
router.get("/", requireAuth, requirePermission("purchasing.view"), async (req, res) => {
  let { branchId, status, supplierId } = req.query;
  if (req.user.role === "branch_manager") branchId = req.user.branchId;
  const conditions = [];
  const values = [];
  let i = 1;
  if (branchId) { conditions.push(`po.branch_id = $${i++}`); values.push(branchId); }
  if (status) { conditions.push(`po.status = $${i++}`); values.push(status); }
  if (supplierId) { conditions.push(`po.supplier_id = $${i++}`); values.push(supplierId); }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  try {
    const result = await pool.query(
      `SELECT po.*, s.name AS supplier_name, b.name AS branch_name,
              COALESCE(SUM(poi.ordered_quantity), 0) AS total_ordered_quantity,
              COALESCE(SUM(poi.received_quantity), 0) AS total_received_quantity
       FROM purchase_orders po
       JOIN suppliers s ON s.id = po.supplier_id
       JOIN branches b ON b.id = po.branch_id
       LEFT JOIN purchase_order_items poi ON poi.purchase_order_id = po.id
       ${where}
       GROUP BY po.id, s.name, b.name
       ORDER BY po.id DESC LIMIT 200`,
      values
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/purchase-orders/:id - تفاصيل + كل صنف مع remaining_quantity وانحراف السعر عن آخر سعر مسجّل للمورد
router.get("/:id", requireAuth, requirePermission("purchasing.view"), async (req, res) => {
  try {
    const po = await pool.query(
      `SELECT po.*, s.name AS supplier_name, b.name AS branch_name
       FROM purchase_orders po JOIN suppliers s ON s.id = po.supplier_id JOIN branches b ON b.id = po.branch_id
       WHERE po.id = $1`,
      [req.params.id]
    );
    if (po.rows.length === 0) return res.status(404).json({ error: "أمر الشراء مش موجود" });
    if (req.user.role === "branch_manager" && !assertOwnBranch(req.user, po.rows[0].branch_id)) {
      return res.status(403).json({ error: "معندكش صلاحية تشوف أمر شراء فرع تاني" });
    }
    const itemsRes = await pool.query(
      `SELECT poi.*, ii.name AS item_name, ii.unit AS item_unit
       FROM purchase_order_items poi JOIN inventory_items ii ON ii.id = poi.inventory_item_id
       WHERE poi.purchase_order_id = $1`,
      [req.params.id]
    );
    const items = [];
    for (const it of itemsRes.rows) {
      const previousPrice = await currentSupplierPrice(pool, po.rows[0].supplier_id, it.inventory_item_id);
      items.push({
        ...it,
        remainingQuantity: Number(it.ordered_quantity) - Number(it.received_quantity),
        ...priceVariance(previousPrice, Number(it.unit_price)),
      });
    }
    res.json({ purchaseOrder: po.rows[0], items });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/purchase-orders/:id/price-variance - نفس بيانات الانحراف بس منفصلة (بند 11 - تقرير إداري)
router.get("/:id/price-variance", requireAuth, requirePermission("purchasing.view"), async (req, res) => {
  try {
    const po = await pool.query("SELECT supplier_id, branch_id FROM purchase_orders WHERE id = $1", [req.params.id]);
    if (po.rows.length === 0) return res.status(404).json({ error: "أمر الشراء مش موجود" });
    if (req.user.role === "branch_manager" && !assertOwnBranch(req.user, po.rows[0].branch_id)) {
      return res.status(403).json({ error: "معندكش صلاحية تشوف أمر شراء فرع تاني" });
    }
    const itemsRes = await pool.query(
      `SELECT poi.inventory_item_id, poi.unit_price, ii.name AS item_name
       FROM purchase_order_items poi JOIN inventory_items ii ON ii.id = poi.inventory_item_id
       WHERE poi.purchase_order_id = $1`,
      [req.params.id]
    );
    const rows = [];
    for (const it of itemsRes.rows) {
      const previousPrice = await currentSupplierPrice(pool, po.rows[0].supplier_id, it.inventory_item_id);
      rows.push({
        inventoryItemId: it.inventory_item_id, itemName: it.item_name,
        ...priceVariance(previousPrice, Number(it.unit_price)),
      });
    }
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/purchase-orders/:id - تعديل لسه DRAFT بس
router.patch("/:id", requireAuth, requirePermission("purchasing.edit"), async (req, res) => {
  const { expectedDeliveryDate, paymentTerms, currency, notes, items } = req.body;
  const client = await pool.connect();
  try {
    const before = await client.query("SELECT * FROM purchase_orders WHERE id = $1", [req.params.id]);
    if (before.rows.length === 0) return res.status(404).json({ error: "أمر الشراء مش موجود" });
    if (!assertOwnBranch(req.user, before.rows[0].branch_id)) return res.status(403).json({ error: "معندكش صلاحية تعدّل أمر شراء فرع تاني" });
    if (!EDITABLE_STATUSES.includes(before.rows[0].status)) {
      return res.status(400).json({ error: "أمر الشراء ده مش في حالة قابلة للتعديل (DRAFT بس)" });
    }

    const fields = [];
    const values = [];
    let i = 1;
    if (expectedDeliveryDate !== undefined) { fields.push(`expected_delivery_date = $${i++}`); values.push(expectedDeliveryDate); }
    if (paymentTerms !== undefined) { fields.push(`payment_terms = $${i++}`); values.push(paymentTerms); }
    if (currency !== undefined) { fields.push(`currency = $${i++}`); values.push(currency); }
    if (notes !== undefined) { fields.push(`notes = $${i++}`); values.push(notes); }

    await client.query("BEGIN");
    if (Array.isArray(items)) {
      await client.query("DELETE FROM purchase_order_items WHERE purchase_order_id = $1", [req.params.id]);
      await insertItems(client, req.params.id, items);
      const totals = computeTotals(items);
      fields.push(`subtotal = $${i++}`); values.push(totals.subtotal);
      fields.push(`discount = $${i++}`); values.push(totals.discount);
      fields.push(`tax = $${i++}`); values.push(totals.tax);
      fields.push(`total = $${i++}`); values.push(totals.total);
    }
    fields.push("updated_at = now()");
    values.push(req.params.id);
    await client.query(`UPDATE purchase_orders SET ${fields.join(", ")} WHERE id = $${i}`, values);

    await logAudit(client, {
      branchId: before.rows[0].branch_id, userId: req.user.id, action: "PURCHASE_ORDER_EDITED",
      entityType: "purchase_order", entityId: Number(req.params.id), oldValues: before.rows[0], newValues: req.body, req,
    });
    await client.query("COMMIT");
    const updated = await pool.query("SELECT * FROM purchase_orders WHERE id = $1", [req.params.id]);
    res.json(updated.rows[0]);
  } catch (err) {
    await client.query("ROLLBACK");
    res.status(400).json({ error: err.message });
  } finally {
    client.release();
  }
});

// POST /api/purchase-orders/:id/submit - DRAFT → SUBMITTED
router.post("/:id/submit", requireAuth, requirePermission("purchasing.submit"), async (req, res) => {
  try {
    const po = await pool.query("SELECT * FROM purchase_orders WHERE id = $1", [req.params.id]);
    if (po.rows.length === 0) return res.status(404).json({ error: "أمر الشراء مش موجود" });
    if (!assertOwnBranch(req.user, po.rows[0].branch_id)) return res.status(403).json({ error: "معندكش صلاحية تقدّم أمر شراء فرع تاني" });
    if (po.rows[0].status !== "DRAFT") return res.status(400).json({ error: "أمر الشراء ده مش في حالة قابلة للتقديم" });
    const result = await pool.query(
      `UPDATE purchase_orders SET status = 'SUBMITTED', submitted_at = now(), updated_at = now() WHERE id = $1 RETURNING *`,
      [req.params.id]
    );
    await logAudit(pool, {
      branchId: po.rows[0].branch_id, userId: req.user.id, action: "PURCHASE_ORDER_SUBMITTED",
      entityType: "purchase_order", entityId: Number(req.params.id), req,
    });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/purchase-orders/:id/approve - SUBMITTED → APPROVED (أدمن بس - اللي بينشئ الـPO ميقدرش
// يعتمدها لوحده إلا لو عنده purchasing.approve أصلًا، ودي أدمن بس زي recipes.approve/production.approve)
router.post("/:id/approve", requireAuth, requireRole("admin"), requirePermission("purchasing.approve"), async (req, res) => {
  try {
    const po = await pool.query("SELECT * FROM purchase_orders WHERE id = $1", [req.params.id]);
    if (po.rows.length === 0) return res.status(404).json({ error: "أمر الشراء مش موجود" });
    if (po.rows[0].status !== "SUBMITTED") return res.status(400).json({ error: "أمر الشراء ده مش في انتظار اعتماد" });
    const result = await pool.query(
      `UPDATE purchase_orders SET status = 'APPROVED', approved_by = $1, approved_at = now(), updated_at = now() WHERE id = $2 RETURNING *`,
      [req.user.id, req.params.id]
    );
    await logAudit(pool, {
      branchId: po.rows[0].branch_id, userId: req.user.id, action: "PURCHASE_ORDER_APPROVED",
      entityType: "purchase_order", entityId: Number(req.params.id), req,
    });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/purchase-orders/:id/cancel - أي حالة قبل FULLY_RECEIVED/CLOSED - مينفعش يرجّع بضاعة اتستلمت
// بالفعل (ده مسار مرتجع مورد منفصل، مش إلغاء PO)، بس بيوقف أي استلام تاني ليها
router.post("/:id/cancel", requireAuth, requirePermission("purchasing.cancel"), async (req, res) => {
  const { reason } = req.body;
  try {
    const po = await pool.query("SELECT * FROM purchase_orders WHERE id = $1", [req.params.id]);
    if (po.rows.length === 0) return res.status(404).json({ error: "أمر الشراء مش موجود" });
    if (!assertOwnBranch(req.user, po.rows[0].branch_id)) return res.status(403).json({ error: "معندكش صلاحية تلغي أمر شراء فرع تاني" });
    if (["FULLY_RECEIVED", "CLOSED", "CANCELLED"].includes(po.rows[0].status)) {
      return res.status(400).json({ error: "أمر الشراء ده مش قابل للإلغاء في حالته الحالية" });
    }
    const result = await pool.query(
      `UPDATE purchase_orders SET status = 'CANCELLED', cancelled_by = $1, cancelled_at = now(), updated_at = now() WHERE id = $2 RETURNING *`,
      [req.user.id, req.params.id]
    );
    await logAudit(pool, {
      branchId: po.rows[0].branch_id, userId: req.user.id, action: "PURCHASE_ORDER_CANCELLED",
      entityType: "purchase_order", entityId: Number(req.params.id), metadata: { reason }, req,
    });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/purchase-orders/:id/close - FULLY_RECEIVED → CLOSED (إقفال إداري بعد التسوية الكاملة)
router.post("/:id/close", requireAuth, requirePermission("purchasing.edit"), async (req, res) => {
  try {
    const po = await pool.query("SELECT * FROM purchase_orders WHERE id = $1", [req.params.id]);
    if (po.rows.length === 0) return res.status(404).json({ error: "أمر الشراء مش موجود" });
    if (!assertOwnBranch(req.user, po.rows[0].branch_id)) return res.status(403).json({ error: "معندكش صلاحية تقفل أمر شراء فرع تاني" });
    if (po.rows[0].status !== "FULLY_RECEIVED") return res.status(400).json({ error: "أمر الشراء لازم يكون مستلم بالكامل الأول" });
    const result = await pool.query(
      `UPDATE purchase_orders SET status = 'CLOSED', updated_at = now() WHERE id = $1 RETURNING *`, [req.params.id]
    );
    await logAudit(pool, {
      branchId: po.rows[0].branch_id, userId: req.user.id, action: "PURCHASE_ORDER_CLOSED",
      entityType: "purchase_order", entityId: Number(req.params.id), req,
    });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
