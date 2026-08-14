const express = require("express");
const router = express.Router();
const pool = require("../db/pool");
const { requireAuth, requireRole, assertOwnBranch } = require("../middleware/auth");

// GET /api/kitchen-transfers?branchId=&date= - تحويلات سنتر كيتشن للفروع (مع تفاصيل الأصناف)
router.get(
  "/",
  requireAuth,
  requireRole("admin", "accountant", "branch_manager"),
  async (req, res) => {
    let { branchId, date } = req.query;
    if (req.user.role === "branch_manager") {
      if (branchId && !assertOwnBranch(req.user, branchId)) {
        return res.status(403).json({ error: "معندكش صلاحية تشوف تحويلات فرع تاني" });
      }
      branchId = req.user.branchId;
    }
    try {
      const transfers = await pool.query(
        `SELECT kt.*, b.name AS to_branch_name
         FROM kitchen_transfers kt
         JOIN branches b ON b.id = kt.to_branch_id
         WHERE ($1::int IS NULL OR kt.to_branch_id = $1)
           AND ($2::date IS NULL OR kt.business_date = $2)
         ORDER BY kt.business_date DESC, kt.id DESC`,
        [branchId || null, date || null]
      );
      const transferIds = transfers.rows.map((t) => t.id);
      const items = transferIds.length
        ? (await pool.query(
            `SELECT kti.kitchen_transfer_id, kti.inventory_item_id, kti.quantity, ii.name, ii.unit
             FROM kitchen_transfer_items kti
             JOIN inventory_items ii ON ii.id = kti.inventory_item_id
             WHERE kti.kitchen_transfer_id = ANY($1)`,
            [transferIds]
          )).rows
        : [];
      const result = transfers.rows.map((t) => ({
        ...t,
        items: items.filter((it) => it.kitchen_transfer_id === t.id),
      }));
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

// POST /api/kitchen-transfers - سنتر كيتشن بيبعت بضاعة بالتكلفة لفرع (مبلغ إجمالي بس، من غير تفصيل أصناف) - أدمن بس
router.post("/", requireAuth, requireRole("admin"), async (req, res) => {
  const { toBranchId, businessDate, amountAtCost, notes } = req.body;
  if (!toBranchId || !businessDate || !amountAtCost) {
    return res.status(400).json({ error: "بيانات ناقصة" });
  }
  try {
    const result = await pool.query(
      `INSERT INTO kitchen_transfers (to_branch_id, business_date, amount_at_cost, notes)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [toBranchId, businessDate, amountAtCost, notes || null]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/kitchen-transfers/itemized - تحويل فعلي بأصناف وكميات محددة (بينزل من مخزون السنتر كيتشن
// ويزود مخزون الفرع المستقبِل تلقائيًا)، ولو مربوط بطلبية فرع بيقفلها "fulfilled"
// {fromBranchId, toBranchId, businessDate, items: [{inventoryItemId, quantity}], kitchenOrderId, notes}
router.post("/itemized", requireAuth, requireRole("admin", "branch_manager"), async (req, res) => {
  const { fromBranchId, toBranchId, businessDate, items, kitchenOrderId, notes } = req.body;
  if (!fromBranchId || !toBranchId || !businessDate || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: "بيانات ناقصة" });
  }
  if (!assertOwnBranch(req.user, fromBranchId)) {
    return res.status(403).json({ error: "معندكش صلاحية تحوّل من الفرع/السنتر كيتشن ده" });
  }

  const client = await pool.connect();
  try {
    const branchCheck = await client.query("SELECT is_central_kitchen FROM branches WHERE id = $1", [fromBranchId]);
    if (branchCheck.rows.length === 0 || !branchCheck.rows[0].is_central_kitchen) {
      return res.status(400).json({ error: "التحويل المفصّل ده بيتم بس من فرع السنتر كيتشن" });
    }

    const itemIds = items.map((it) => it.inventoryItemId);
    const costRows = await client.query(
      "SELECT id, COALESCE(unit_cost, 0) AS unit_cost FROM inventory_items WHERE id = ANY($1)",
      [itemIds]
    );
    const costByItem = new Map(costRows.rows.map((r) => [r.id, Number(r.unit_cost)]));
    const amountAtCost = items.reduce(
      (sum, it) => sum + (costByItem.get(it.inventoryItemId) || 0) * it.quantity,
      0
    );

    await client.query("BEGIN");

    const transferResult = await client.query(
      `INSERT INTO kitchen_transfers (to_branch_id, business_date, amount_at_cost, notes, kitchen_order_id)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [toBranchId, businessDate, amountAtCost, notes || null, kitchenOrderId || null]
    );
    const transferId = transferResult.rows[0].id;

    for (const it of items) {
      await client.query(
        `INSERT INTO kitchen_transfer_items (kitchen_transfer_id, inventory_item_id, quantity)
         VALUES ($1, $2, $3)`,
        [transferId, it.inventoryItemId, it.quantity]
      );

      // ينزل من مخزون السنتر كيتشن
      await client.query(
        `INSERT INTO branch_inventory_stock (branch_id, inventory_item_id, quantity)
         VALUES ($1, $2, -($3::numeric))
         ON CONFLICT (branch_id, inventory_item_id) DO UPDATE SET quantity = branch_inventory_stock.quantity - $3::numeric`,
        [fromBranchId, it.inventoryItemId, it.quantity]
      );
      await client.query(
        `INSERT INTO inventory_movements (branch_id, inventory_item_id, movement_type, quantity, business_date, notes)
         VALUES ($1, $2, 'transfer_out', -($3::numeric), $4, $5)`,
        [fromBranchId, it.inventoryItemId, it.quantity, businessDate, notes || null]
      );

      // بيزود مخزون الفرع المستقبِل
      await client.query(
        `INSERT INTO branch_inventory_stock (branch_id, inventory_item_id, quantity)
         VALUES ($1, $2, $3::numeric)
         ON CONFLICT (branch_id, inventory_item_id) DO UPDATE SET quantity = branch_inventory_stock.quantity + $3::numeric`,
        [toBranchId, it.inventoryItemId, it.quantity]
      );
      await client.query(
        `INSERT INTO inventory_movements (branch_id, inventory_item_id, movement_type, quantity, business_date, notes)
         VALUES ($1, $2, 'transfer_in', $3::numeric, $4, $5)`,
        [toBranchId, it.inventoryItemId, it.quantity, businessDate, notes || null]
      );
    }

    if (kitchenOrderId) {
      await client.query("UPDATE kitchen_orders SET status = 'fulfilled' WHERE id = $1", [kitchenOrderId]);
    }

    await client.query("COMMIT");
    res.status(201).json({ transferId, amountAtCost });
  } catch (err) {
    await client.query("ROLLBACK");
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

module.exports = router;
