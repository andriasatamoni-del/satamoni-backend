const express = require("express");
const router = express.Router();
const pool = require("../db/pool");
const { requireAuth, requireRole } = require("../middleware/auth");

const canView = requireRole("admin", "callcenter", "branch_manager", "cashier", "accountant");
const canEdit = requireRole("admin", "callcenter", "branch_manager");

// GET /api/customers?q=  - بحث بالاسم أو رقم التليفون (لشاشة الكول سنتر)
// GET /api/customers?phone=  - بروفايل عميل واحد كامل (إحصائياته + آخر طلباته) - بيدوّر في phone و phone2 معًا
// GET /api/customers  (من غير q ولا phone) - دليل كل العملاء، الأحدث نشاطًا الأول (لشاشة بيانات العملاء)
router.get("/", requireAuth, canView, async (req, res) => {
  const { q, phone } = req.query;
  try {
    if (!q && !phone) {
      const result = await pool.query(
        `SELECT c.phone, c.name, c.loyalty_points, COALESCE(s.orders_count, 0) AS orders_count,
                COALESCE(s.total_spent, 0) AS total_spent, s.last_order_at
         FROM customers c
         LEFT JOIN v_customer_order_stats s ON s.phone = c.phone
         ORDER BY s.last_order_at DESC NULLS LAST
         LIMIT 200`
      );
      return res.json(result.rows.map((r) => ({
        phone: r.phone, name: r.name, loyaltyPoints: r.loyalty_points,
        ordersCount: Number(r.orders_count), totalSpent: Number(r.total_spent), lastOrderAt: r.last_order_at,
      })));
    }

    if (phone) {
      const customer = await pool.query(
        "SELECT * FROM customers WHERE phone = $1 OR phone2 = $1", [phone]
      );
      if (customer.rows.length === 0) {
        return res.json({
          phone, phone2: null, name: null, notes: null, addressDetails: null, deliveryAreaId: null,
          distinguishingMark: null, loyaltyPoints: 0, ordersCount: 0, totalSpent: 0, lastOrderAt: null,
          recentOrders: [], isRegistered: false,
        });
      }
      const row = customer.rows[0];
      const stats = await pool.query("SELECT * FROM v_customer_order_stats WHERE phone = $1", [row.phone]);
      const recentOrders = await pool.query(
        `SELECT id, branch_id, order_type, total, status, payment_status, created_at
         FROM orders WHERE customer_phone = $1 OR customer_phone = $2
         ORDER BY created_at DESC LIMIT 20`,
        [row.phone, row.phone2]
      );
      return res.json({
        phone: row.phone,
        phone2: row.phone2,
        name: row.name,
        notes: row.notes,
        addressDetails: row.address_details,
        deliveryAreaId: row.delivery_area_id,
        distinguishingMark: row.distinguishing_mark,
        loyaltyPoints: row.loyalty_points,
        isRegistered: true,
        ordersCount: Number(stats.rows[0]?.orders_count || 0),
        totalSpent: Number(stats.rows[0]?.total_spent || 0),
        lastOrderAt: stats.rows[0]?.last_order_at || null,
        recentOrders: recentOrders.rows,
      });
    }

    if (q) {
      const result = await pool.query(
        `SELECT c.*, COALESCE(s.orders_count, 0) AS orders_count, COALESCE(s.total_spent, 0) AS total_spent,
                s.last_order_at
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

// GET /api/customers/dormant?days=30 - عملاء سجّلوا طلب قبل كده بس مطلبوش تاني من X يوم -
// مرتبين بالأكتر إنفاقًا الأول (أعلى قيمة تستاهل تتصل بيها للاسترجاع)
router.get("/dormant", requireAuth, canView, async (req, res) => {
  const days = Number(req.query.days) || 30;
  if (days <= 0) return res.status(400).json({ error: "عدد الأيام لازم يكون أكبر من صفر" });
  try {
    const result = await pool.query(
      `SELECT c.phone, c.phone2, c.name, c.loyalty_points,
              s.orders_count, s.total_spent, s.last_order_at
       FROM customers c
       JOIN v_customer_order_stats s ON s.phone = c.phone
       WHERE s.last_order_at < now() - ($1 || ' days')::interval
       ORDER BY s.total_spent DESC`,
      [days]
    );
    res.json({
      days,
      customers: result.rows.map((r) => ({
        phone: r.phone, phone2: r.phone2, name: r.name, loyaltyPoints: r.loyalty_points,
        ordersCount: Number(r.orders_count), totalSpent: Number(r.total_spent), lastOrderAt: r.last_order_at,
        daysSinceLastOrder: Math.floor((Date.now() - new Date(r.last_order_at).getTime()) / 86400000),
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/customers/:phone - تحديث بيانات العميل (بينشئ العميل لو مش موجود) - ده اللي بيسجل بيانات
// العميل كاملة وقت طلب الدليفري (رقمين تليفون، عنوان تفصيلي، منطقة، علامة مميزة، نقاط ولاء)
router.patch("/:phone", requireAuth, canEdit, async (req, res) => {
  const { phone } = req.params;
  const { notes, loyaltyPoints, name, phone2, addressDetails, deliveryAreaId, distinguishingMark } = req.body;
  if ([notes, loyaltyPoints, name, phone2, addressDetails, deliveryAreaId, distinguishingMark].every((v) => v === undefined)) {
    return res.status(400).json({ error: "مفيش حاجة تتعدل" });
  }
  try {
    const result = await pool.query(
      `INSERT INTO customers (phone, name, notes, loyalty_points, phone2, address_details, delivery_area_id, distinguishing_mark)
       VALUES ($1, $2, $3, COALESCE($4, 0), $5, $6, $7, $8)
       ON CONFLICT (phone) DO UPDATE SET
         name = COALESCE($2, customers.name),
         notes = COALESCE($3, customers.notes),
         loyalty_points = COALESCE($4, customers.loyalty_points),
         phone2 = COALESCE($5, customers.phone2),
         address_details = COALESCE($6, customers.address_details),
         delivery_area_id = COALESCE($7, customers.delivery_area_id),
         distinguishing_mark = COALESCE($8, customers.distinguishing_mark),
         updated_at = now()
       RETURNING *`,
      [phone, name ?? null, notes ?? null, loyaltyPoints ?? null, phone2 ?? null,
       addressDetails ?? null, deliveryAreaId ?? null, distinguishingMark ?? null]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
