const express = require("express");
const router = express.Router();
const pool = require("../db/pool");
const { requireAuth, requireRole, assertOwnBranch } = require("../middleware/auth");

// طلبات الموقع (source=website) عامة من غير تسجيل دخول.
// طلبات الكاشير (source=pos) لازم كاشير/مدير فرع/أدمن مسجل دخول، وعلى فرعه بس.
function requirePosAuthIfNeeded(req, res, next) {
  if (req.body.source !== "pos") return next();
  requireAuth(req, res, (err) => {
    if (err) return next(err);
    requireRole("cashier", "branch_manager", "admin")(req, res, next);
  });
}

// POST /api/orders - إنشاء طلب جديد (من الموقع أو من شاشة الكاشير)
// ده اللي هيستبدل window.storage في ملف الموقع الحالي
router.post("/", requirePosAuthIfNeeded, async (req, res) => {
  const client = await pool.connect();
  try {
    const {
      branchId, source, orderType, tableNumber,
      deliveryAreaId, addressDetails, customerName, customerPhone,
      paymentMethodId, items, deliveryFee = 0, discount = 0,
    } = req.body;

    if (source === "pos" && !assertOwnBranch(req.user, branchId)) {
      return res.status(403).json({ error: "معندكش صلاحية تسجل طلب على فرع تاني" });
    }

    await client.query("BEGIN");

    const subtotal = items.reduce((s, it) => s + it.unitPrice * it.quantity, 0);
    const total = subtotal + deliveryFee - discount;
    const createdBy = source === "pos" ? req.user.id : null;

    const orderResult = await client.query(
      `INSERT INTO orders
        (branch_id, source, order_type, table_number, delivery_area_id,
         address_details, customer_name, customer_phone, payment_method_id,
         created_by, subtotal, delivery_fee, discount, total, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'pending')
       RETURNING id`,
      [branchId, source || "website", orderType, tableNumber, deliveryAreaId,
       addressDetails, customerName, customerPhone, paymentMethodId,
       createdBy, subtotal, deliveryFee, discount, total]
    );
    const orderId = orderResult.rows[0].id;

    for (const it of items) {
      await client.query(
        `INSERT INTO order_items (order_id, item_id, variant_id, quantity, unit_price, line_total)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [orderId, it.itemId, it.variantId, it.quantity, it.unitPrice, it.unitPrice * it.quantity]
      );
    }

    await client.query("COMMIT");
    res.status(201).json({ orderId, subtotal, total });
  } catch (err) {
    await client.query("ROLLBACK");
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// GET /api/orders?branchId=&date= - عرض طلبات فرع في يوم معين (موظفين مسجلين دخول بس)
router.get(
  "/",
  requireAuth,
  requireRole("cashier", "branch_manager", "accountant", "admin"),
  async (req, res) => {
    let { branchId, date } = req.query;

    if (req.user.role !== "admin" && req.user.role !== "accountant") {
      if (branchId && !assertOwnBranch(req.user, branchId)) {
        return res.status(403).json({ error: "معندكش صلاحية تشوف طلبات فرع تاني" });
      }
      branchId = req.user.branchId;
    }

    try {
      const result = await pool.query(
        `SELECT * FROM orders
         WHERE ($1::int IS NULL OR branch_id = $1)
           AND ($2::date IS NULL OR created_at::date = $2)
         ORDER BY created_at DESC`,
        [branchId || null, date || null]
      );
      res.json(result.rows);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

module.exports = router;
