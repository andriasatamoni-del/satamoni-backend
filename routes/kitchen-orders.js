const express = require("express");
const router = express.Router();
const pool = require("../db/pool");
const { requireAuth, requireRole, assertOwnBranch } = require("../middleware/auth");

// GET /api/kitchen-orders?branchId=&status= - طلبيات الفروع للسنتر كيتشن
// مدير الفرع/الكاشير يشوفوا طلبيات فرعهم بس، الأدمن يشوف كل حاجة (قايمة تنفيذ السنتر كيتشن)
router.get(
  "/",
  requireAuth,
  requireRole("admin", "branch_manager", "cashier"),
  async (req, res) => {
    let { branchId, status } = req.query;
    // أدمن أو موظف السنتر كيتشن يشوفوا طلبيات كل الفروع (عشان ينفذوها) - غيرهم فرعهم بس
    if (req.user.role !== "admin" && !req.user.isCentralKitchen) {
      if (branchId && !assertOwnBranch(req.user, branchId)) {
        return res.status(403).json({ error: "معندكش صلاحية تشوف طلبيات فرع تاني" });
      }
      branchId = req.user.branchId;
    }
    try {
      const orders = await pool.query(
        `SELECT ko.*, b.name AS branch_name
         FROM kitchen_orders ko
         JOIN branches b ON b.id = ko.branch_id
         WHERE ($1::int IS NULL OR ko.branch_id = $1)
           AND ($2::text IS NULL OR ko.status = $2)
         ORDER BY ko.created_at DESC`,
        [branchId || null, status || null]
      );
      const orderIds = orders.rows.map((o) => o.id);
      const items = orderIds.length
        ? (await pool.query(
            `SELECT koi.kitchen_order_id, koi.inventory_item_id, koi.quantity_requested, ii.name, ii.unit
             FROM kitchen_order_items koi
             JOIN inventory_items ii ON ii.id = koi.inventory_item_id
             WHERE koi.kitchen_order_id = ANY($1)`,
            [orderIds]
          )).rows
        : [];
      const result = orders.rows.map((o) => ({
        ...o,
        items: items.filter((it) => it.kitchen_order_id === o.id),
      }));
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

// POST /api/kitchen-orders - فرع بيطلب أصناف من السنتر كيتشن
// {branchId, items: [{inventoryItemId, quantityRequested}], notes}
router.post(
  "/",
  requireAuth,
  requireRole("admin", "branch_manager", "cashier"),
  async (req, res) => {
    const { branchId, items, notes } = req.body;
    if (!branchId || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "لازم فرع وأصناف مطلوبة" });
    }
    if (!assertOwnBranch(req.user, branchId)) {
      return res.status(403).json({ error: "معندكش صلاحية تطلب لفرع تاني" });
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const orderResult = await client.query(
        `INSERT INTO kitchen_orders (branch_id, notes, created_by)
         VALUES ($1, $2, $3) RETURNING id`,
        [branchId, notes || null, req.user.id]
      );
      const orderId = orderResult.rows[0].id;
      for (const it of items) {
        await client.query(
          `INSERT INTO kitchen_order_items (kitchen_order_id, inventory_item_id, quantity_requested)
           VALUES ($1, $2, $3)`,
          [orderId, it.inventoryItemId, it.quantityRequested]
        );
      }
      await client.query("COMMIT");
      res.status(201).json({ orderId });
    } catch (err) {
      await client.query("ROLLBACK");
      res.status(500).json({ error: err.message });
    } finally {
      client.release();
    }
  }
);

// PATCH /api/kitchen-orders/:id - إلغاء طلبية (أدمن أو مدير الفرع الطالب)
router.patch("/:id", requireAuth, requireRole("admin", "branch_manager"), async (req, res) => {
  const { status } = req.body;
  if (status !== "cancelled") return res.status(400).json({ error: "التعديل المسموح بيه هنا إلغاء بس" });
  try {
    const existing = await pool.query("SELECT branch_id, status FROM kitchen_orders WHERE id = $1", [req.params.id]);
    if (existing.rows.length === 0) return res.status(404).json({ error: "الطلبية مش موجودة" });
    if (!assertOwnBranch(req.user, existing.rows[0].branch_id)) {
      return res.status(403).json({ error: "معندكش صلاحية تلغي طلبية فرع تاني" });
    }
    if (existing.rows[0].status !== "pending") {
      return res.status(400).json({ error: "الطلبية دي اتنفذت أو اتلغت بالفعل" });
    }
    const result = await pool.query(
      "UPDATE kitchen_orders SET status = 'cancelled' WHERE id = $1 RETURNING *",
      [req.params.id]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
