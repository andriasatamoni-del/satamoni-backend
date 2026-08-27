// المرحلة 7N: مرتجع مشتريات - إرجاع بضاعة للمورد (تالفة/غلط/منتهية الصلاحية) في أي وقت بعد الاستلام،
// مستقل عن /goods-receipts/:id/cancel (اللي بيرجّع سند استلام كامل بشرط مفيش منه حاجة اتصرفت). هنا
// ممكن نرجّع كمية جزئية من صنف/دفعة معينة حتى لو باقي السند اتصرف عادي، من غير ما نلمس الـPO/GRN خالص.
const express = require("express");
const router = express.Router();
const pool = require("../db/pool");
const { requireAuth, assertOwnBranch } = require("../middleware/auth");
const { requirePermission } = require("../middleware/permissions");
const { logAudit } = require("../db/audit");
const { postInventoryMovement } = require("../db/inventory-ledger");
const { postJournalEntry, getAccountByCode } = require("../db/accounting-engine");

// POST /api/purchase-returns - {branchId, supplierId?, goodsReceiptId?, reason, notes?,
//  items:[{inventoryItemId, batchId?, quantity, unit, unitCost?}]}
router.post("/", requireAuth, requirePermission("purchasing.create"), async (req, res) => {
  const { branchId, supplierId, goodsReceiptId, reason, notes, items } = req.body;
  if (!branchId || !reason) return res.status(400).json({ error: "الفرع وسبب المرتجع مطلوبين" });
  if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: "لازم صنف واحد على الأقل" });
  if (!assertOwnBranch(req.user, branchId)) return res.status(403).json({ error: "معندكش صلاحية تسجّل مرتجع لفرع تاني" });
  for (const it of items) {
    if (!it.inventoryItemId || !it.quantity || Number(it.quantity) <= 0 || !it.unit) {
      return res.status(400).json({ error: "كل صنف لازم inventoryItemId وكمية أكبر من صفر ووحدة" });
    }
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const ret = await client.query(
      `INSERT INTO purchase_returns (branch_id, supplier_id, goods_receipt_id, reason, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [branchId, supplierId || null, goodsReceiptId || null, reason, notes || null, req.user.id]
    );
    const retId = ret.rows[0].id;
    let totalValue = 0;
    let valueIncomplete = false;
    for (const it of items) {
      let unitCost = it.unitCost != null ? Number(it.unitCost) : null;
      if (unitCost == null && it.batchId) {
        const batch = await client.query("SELECT unit_cost FROM inventory_batches WHERE id = $1", [it.batchId]);
        if (batch.rows[0]?.unit_cost != null) unitCost = Number(batch.rows[0].unit_cost);
      }
      if (unitCost == null) {
        const item = await client.query("SELECT unit_cost FROM inventory_items WHERE id = $1", [it.inventoryItemId]);
        if (item.rows[0]?.unit_cost != null) unitCost = Number(item.rows[0].unit_cost);
      }
      const lineValue = unitCost != null ? unitCost * Number(it.quantity) : null;
      if (lineValue == null) valueIncomplete = true;
      else totalValue += lineValue;
      await client.query(
        `INSERT INTO purchase_return_items (purchase_return_id, inventory_item_id, batch_id, quantity, unit, unit_cost, line_value)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [retId, it.inventoryItemId, it.batchId || null, it.quantity, it.unit, unitCost, lineValue]
      );
    }
    await client.query(
      "UPDATE purchase_returns SET total_value = $2 WHERE id = $1",
      [retId, valueIncomplete ? null : totalValue]
    );
    await logAudit(client, {
      branchId, userId: req.user.id, action: "PURCHASE_RETURN_CREATED", entityType: "purchase_return", entityId: retId, req,
    });
    await client.query("COMMIT");
    const full = await pool.query("SELECT * FROM purchase_returns WHERE id = $1", [retId]);
    res.status(201).json(full.rows[0]);
  } catch (err) {
    await client.query("ROLLBACK");
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// GET /api/purchase-returns?branchId=&status=&supplierId=
router.get("/", requireAuth, requirePermission("purchasing.view"), async (req, res) => {
  const { branchId, status, supplierId } = req.query;
  const conditions = [];
  const params = [];
  if (branchId) { params.push(branchId); conditions.push(`pr.branch_id = $${params.length}`); }
  else if (req.user.role !== "admin" && req.user.branchId) { params.push(req.user.branchId); conditions.push(`pr.branch_id = $${params.length}`); }
  if (status) { params.push(status); conditions.push(`pr.status = $${params.length}`); }
  if (supplierId) { params.push(supplierId); conditions.push(`pr.supplier_id = $${params.length}`); }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  try {
    const result = await pool.query(
      `SELECT pr.*, s.name AS supplier_name, b.name AS branch_name
       FROM purchase_returns pr
       LEFT JOIN suppliers s ON s.id = pr.supplier_id
       LEFT JOIN branches b ON b.id = pr.branch_id
       ${where}
       ORDER BY pr.id DESC LIMIT 200`,
      params
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/purchase-returns/:id
router.get("/:id", requireAuth, requirePermission("purchasing.view"), async (req, res) => {
  try {
    const ret = await pool.query(
      `SELECT pr.*, s.name AS supplier_name, b.name AS branch_name FROM purchase_returns pr
       LEFT JOIN suppliers s ON s.id = pr.supplier_id LEFT JOIN branches b ON b.id = pr.branch_id
       WHERE pr.id = $1`,
      [req.params.id]
    );
    if (ret.rows.length === 0) return res.status(404).json({ error: "مرتجع المشتريات مش موجود" });
    if (!assertOwnBranch(req.user, ret.rows[0].branch_id)) return res.status(403).json({ error: "معندكش صلاحية تشوف مرتجع فرع تاني" });
    const items = await pool.query(
      `SELECT pri.*, ii.name AS item_name FROM purchase_return_items pri
       JOIN inventory_items ii ON ii.id = pri.inventory_item_id WHERE pri.purchase_return_id = $1`,
      [req.params.id]
    );
    res.json({ ...ret.rows[0], items: items.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/purchase-returns/:id/post - بيرحّل المرتجع فعليًا: بيخصم المخزون (RETURN_TO_SUPPLIER) وبيعمل
// قيد محاسبي (DR الموردون / CR المخزون - بيقلل المديونية للمورد، زي عكس قيد الاستلام بالظبط)
router.post("/:id/post", requireAuth, requirePermission("purchasing.create", "purchasing.approve"), async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const ret = await client.query("SELECT * FROM purchase_returns WHERE id = $1 FOR UPDATE", [req.params.id]);
    if (ret.rows.length === 0) { await client.query("ROLLBACK"); return res.status(404).json({ error: "مرتجع المشتريات مش موجود" }); }
    if (!assertOwnBranch(req.user, ret.rows[0].branch_id)) {
      await client.query("ROLLBACK");
      return res.status(403).json({ error: "معندكش صلاحية ترحّل مرتجع فرع تاني" });
    }
    if (ret.rows[0].status === "POSTED") { await client.query("ROLLBACK"); return res.status(200).json({ ...ret.rows[0], duplicate: true }); }
    if (ret.rows[0].status !== "DRAFT") { await client.query("ROLLBACK"); return res.status(400).json({ error: "مرتجع المشتريات ده مش في حالة قابلة للترحيل" }); }

    const items = await client.query("SELECT * FROM purchase_return_items WHERE purchase_return_id = $1", [req.params.id]);
    let totalCost = 0;
    let valueIncomplete = false;
    for (const item of items.rows) {
      let unitCost = item.unit_cost != null ? Number(item.unit_cost) : null;
      if (item.batch_id) {
        const batch = await client.query(
          "SELECT remaining_quantity, unit_cost FROM inventory_batches WHERE id = $1 FOR UPDATE", [item.batch_id]
        );
        if (batch.rows.length === 0) throw Object.assign(new Error("الدفعة المحددة مش موجودة"), { code: "BATCH_NOT_FOUND" });
        if (Number(batch.rows[0].remaining_quantity) < Number(item.quantity)) {
          throw Object.assign(new Error(`الكمية المتبقية في الدفعة (${batch.rows[0].remaining_quantity}) أقل من كمية المرتجع (${item.quantity})`), { code: "INSUFFICIENT_BATCH_QUANTITY" });
        }
        if (unitCost == null && batch.rows[0].unit_cost != null) unitCost = Number(batch.rows[0].unit_cost);
        await client.query(
          "UPDATE inventory_batches SET remaining_quantity = remaining_quantity - $2, status = CASE WHEN remaining_quantity - $2 <= 0 THEN 'depleted' ELSE status END WHERE id = $1",
          [item.batch_id, item.quantity]
        );
        const { movement } = await postInventoryMovement(client, {
          branchId: ret.rows[0].branch_id, inventoryItemId: item.inventory_item_id, quantity: -Number(item.quantity),
          movementType: "RETURN_TO_SUPPLIER", referenceType: "purchase_return", referenceId: ret.rows[0].id,
          unit: item.unit, unitCost, batchId: item.batch_id, userId: req.user.id,
          skipBatchConsumption: true, negativeStockOverrideApproved: true,
          idempotencyKey: `purchase-return-item-${item.id}`,
        });
        if (movement.total_cost != null) totalCost += Number(movement.total_cost); else valueIncomplete = true;
      } else {
        const { movement } = await postInventoryMovement(client, {
          branchId: ret.rows[0].branch_id, inventoryItemId: item.inventory_item_id, quantity: -Number(item.quantity),
          movementType: "RETURN_TO_SUPPLIER", referenceType: "purchase_return", referenceId: ret.rows[0].id,
          unit: item.unit, unitCost, userId: req.user.id,
          negativeStockOverrideApproved: true,
          idempotencyKey: `purchase-return-item-${item.id}`,
        });
        if (movement.total_cost != null) totalCost += Number(movement.total_cost); else valueIncomplete = true;
      }
    }

    if (totalCost > 0) {
      const inventoryAccount = await getAccountByCode(client, "1400");
      const apAccount = await getAccountByCode(client, "2100");
      await postJournalEntry(client, {
        entryDate: new Date().toISOString().slice(0, 10), description: `مرتجع مشتريات #${ret.rows[0].id}`,
        sourceType: "purchase_return", sourceId: ret.rows[0].id, branchId: ret.rows[0].branch_id,
        lines: [
          { accountId: apAccount.id, debit: totalCost, referenceType: "supplier", referenceId: ret.rows[0].supplier_id },
          { accountId: inventoryAccount.id, credit: totalCost, description: valueIncomplete ? "تكلفة جزئية (تكلفة ناقصة لبعض الأصناف)" : null },
        ],
        idempotencyKey: `purchase-return-${ret.rows[0].id}`, userId: req.user.id,
      });
    }

    const posted = await client.query(
      "UPDATE purchase_returns SET status = 'POSTED', posted_by = $1, posted_at = now(), total_value = $2 WHERE id = $3 RETURNING *",
      [req.user.id, valueIncomplete ? ret.rows[0].total_value : totalCost, req.params.id]
    );
    await logAudit(client, {
      branchId: ret.rows[0].branch_id, userId: req.user.id, action: "PURCHASE_RETURN_POSTED", entityType: "purchase_return", entityId: ret.rows[0].id, req,
    });
    await client.query("COMMIT");
    res.json({ ...posted.rows[0], duplicate: false });
  } catch (err) {
    await client.query("ROLLBACK");
    if (err.code === "BATCH_NOT_FOUND" || err.code === "INSUFFICIENT_BATCH_QUANTITY") return res.status(400).json({ error: err.message });
    if (err.code === "INSUFFICIENT_STOCK" || err.code === "INSUFFICIENT_STOCK_NEEDS_APPROVAL") return res.status(400).json({ error: err.message });
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// POST /api/purchase-returns/:id/cancel - DRAFT بس (POSTED نهائي - مفيش استرجاع بعد ما البضاعة فعليًا
// خرجت للمورد، زي ما هو موضّح في docs/PURCHASE-RETURNS.md)
router.post("/:id/cancel", requireAuth, requirePermission("purchasing.cancel"), async (req, res) => {
  try {
    const ret = await pool.query("SELECT * FROM purchase_returns WHERE id = $1", [req.params.id]);
    if (ret.rows.length === 0) return res.status(404).json({ error: "مرتجع المشتريات مش موجود" });
    if (!assertOwnBranch(req.user, ret.rows[0].branch_id)) return res.status(403).json({ error: "معندكش صلاحية تلغي مرتجع فرع تاني" });
    if (ret.rows[0].status !== "DRAFT") return res.status(400).json({ error: "مرتجع مُرحّل مينفعش يتلغي - المسودة بس اللي ممكن تتلغي" });
    const result = await pool.query(
      "UPDATE purchase_returns SET status = 'CANCELLED', cancelled_by = $1, cancelled_at = now() WHERE id = $2 RETURNING *",
      [req.user.id, req.params.id]
    );
    await logAudit(pool, {
      branchId: ret.rows[0].branch_id, userId: req.user.id, action: "PURCHASE_RETURN_CANCELLED", entityType: "purchase_return", entityId: ret.rows[0].id, req,
    });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
