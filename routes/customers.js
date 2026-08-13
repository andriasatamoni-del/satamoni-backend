const express = require("express");
const router = express.Router();
const pool = require("../db/pool");
const { requireAuth, requireRole } = require("../middleware/auth");

const canView = requireRole("admin", "callcenter", "branch_manager", "cashier", "accountant");
const canEdit = requireRole("admin", "callcenter", "branch_manager");

// GET /api/customers?q=  - بحث بالاسم أو رقم التليفون (لشاشة الكول سنتر)
// GET /api/customers?phone=  - بروفايل عميل واحد كامل (إحصائياته + آخر طلباته)
router.get("/", requireAuth, canView, async (req, res) => {
  const { q, phone } = req.query;
  try {
    if (phone) {
      const customer = await pool.query("SELECT * FROM customers WHERE phone = $1", [phone]);
      if (customer.rows.length === 0) {
        return res.json({ phone, name: null, notes: null, ordersCount: 0, totalSpent: 0, lastOrderAt: null, recentOrders: [] });
      }
      const stats = await pool.query("SELECT * FROM v_customer_order_stats WHERE phone = $1", [phone]);
      const recentOrders = await pool.query(
        `SELECT id, branch_id, order_type, total, status, created_at
         FROM orders WHERE customer_phone = $1
         ORDER BY created_at DESC LIMIT 20`,
        [phone]
      );
      return res.json({
        ...customer.rows[0],
        ordersCount: Number(stats.rows[0]?.orders_count || 0),
        totalSpent: Number(stats.rows[0]?.total_spent || 0),
        lastOrderAt: stats.rows[0]?.last_order_at || null,
        recentOrders: recentOrders.rows,
      });
    }

    if (q) {
      const result = await pool.query(
        `SELECT c.*, COALESCE(s.orders_count, 0) AS orders_count, COALESCE(s.total_spent, 0) AS total_spent
         FROM customers c
         LEFT JOIN v_customer_order_stats s ON s.phone = c.phone
         WHERE c.phone ILIKE $1 OR c.name ILIKE $1
         ORDER BY s.last_order_at DESC NULLS LAST
         LIMIT 30`,
        [`%${q}%`]
      );
      return res.json(result.rows);
    }

    return res.status(400).json({ error: "لازم q (بحث) أو phone (بروفايل)" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/customers/:phone - تحديث ملاحظات/نقاط ولاء العميل (بينشئ العميل لو مش موجود)
router.patch("/:phone", requireAuth, canEdit, async (req, res) => {
  const { phone } = req.params;
  const { notes, loyaltyPoints, name } = req.body;
  if (notes === undefined && loyaltyPoints === undefined && name === undefined) {
    return res.status(400).json({ error: "مفيش حاجة تتعدل" });
  }
  try {
    const result = await pool.query(
      `INSERT INTO customers (phone, name, notes, loyalty_points)
       VALUES ($1, $2, $3, COALESCE($4, 0))
       ON CONFLICT (phone) DO UPDATE SET
         name = COALESCE($2, customers.name),
         notes = COALESCE($3, customers.notes),
         loyalty_points = COALESCE($4, customers.loyalty_points),
         updated_at = now()
       RETURNING *`,
      [phone, name ?? null, notes ?? null, loyaltyPoints ?? null]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
