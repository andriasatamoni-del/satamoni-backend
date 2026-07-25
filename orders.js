const express = require("express");
const router = express.Router();
const pool = require("../db/pool");

// POST /api/orders - إنشاء طلب جديد (من الموقع أو من شاشة الكاشير)
// ده اللي هيستبدل window.storage في ملف الموقع الحالي
router.post("/", async (req, res) => {
  const client = await pool.connect();
  try {
    const {
      branchId, source, orderType, tableNumber,
      deliveryAreaId, addressDetails, customerName, customerPhone,
      paymentMethodId, items, deliveryFee = 0, discount = 0,
    } = req.body;

    await client.query("BEGIN");

    const subtotal = items.reduce((s, it) => s + it.unitPrice * it.quantity, 0);
    const total = subtotal + deliveryFee - discount;

    const orderResult = await client.query(
      `INSERT INTO orders
        (branch_id, source, order_type, table_number, delivery_area_id,
         address_details, customer_name, customer_phone, payment_method_id,
         subtotal, delivery_fee, discount, total, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'pending')
       RETURNING id`,
      [branchId, source || "website", orderType, tableNumber, deliveryAreaId,
       addressDetails, customerName, customerPhone, paymentMethodId,
       subtotal, deliveryFee, discount, total]
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

// GET /api/orders?branchId=&date= - عرض طلبات فرع في يوم معين
router.get("/", async (req, res) => {
  const { branchId, date } = req.query;
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
});

module.exports = router;
