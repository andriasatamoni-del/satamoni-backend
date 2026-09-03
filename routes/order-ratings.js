// المرحلة 8.40: صفحة تقييم عامة للعميل (public/rate.html) - من غير أي تسجيل دخول، مقفولة بـ
// orders.rating_token (توكن عشوائي مش رقم الطلب لوحده) عشان محدش يقدر يشوف/يقيّم طلب مش بتاعه بمجرد
// تخمين رقم الطلب. تقييم واحد بس لكل طلب (order_ratings.order_id UNIQUE) - إعادة الإرسال بنفس اللينك
// بتحدّث نفس التقييم مش تنشئ واحد جديد.
const express = require("express");
const router = express.Router();
const pool = require("../db/pool");

async function loadOrderForToken(orderId, token) {
  if (!token) return null;
  const result = await pool.query(
    `SELECT o.id, o.order_type, o.created_at, b.name AS branch_name
     FROM orders o LEFT JOIN branches b ON b.id = o.branch_id
     WHERE o.id = $1 AND o.rating_token = $2`,
    [orderId, token]
  );
  return result.rows[0] || null;
}

// GET /api/order-ratings/:orderId?token=... - بيانات الطلب المختصرة + أي تقييم سابق (لو العميل فتح
// نفس اللينك تاني بعد ما قيّم بالفعل)
router.get("/:orderId", async (req, res) => {
  const orderId = Number(req.params.orderId);
  if (!Number.isInteger(orderId)) return res.status(400).json({ error: "رقم طلب غير صالح" });
  try {
    const order = await loadOrderForToken(orderId, req.query.token);
    if (!order) return res.status(404).json({ error: "اللينك ده غير صالح" });

    const items = await pool.query(
      `SELECT COALESCE(mi.name, c.name, 'صنف') AS name, miv.label AS variant, oi.quantity
       FROM order_items oi
       LEFT JOIN menu_items mi ON mi.id = oi.item_id
       LEFT JOIN menu_item_variants miv ON miv.id = oi.variant_id
       LEFT JOIN combos c ON c.id = oi.combo_id
       WHERE oi.order_id = $1 ORDER BY oi.id`,
      [orderId]
    );
    const existing = await pool.query("SELECT stars, comment FROM order_ratings WHERE order_id = $1", [orderId]);

    res.json({
      orderId: order.id,
      branchName: order.branch_name,
      orderType: order.order_type,
      createdAt: order.created_at,
      items: items.rows,
      existingRating: existing.rows[0] || null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/order-ratings/:orderId - {token, stars, comment?} - إنشاء/تحديث التقييم
router.post("/:orderId", async (req, res) => {
  const orderId = Number(req.params.orderId);
  if (!Number.isInteger(orderId)) return res.status(400).json({ error: "رقم طلب غير صالح" });
  const { token, stars, comment } = req.body;
  if (!Number.isInteger(stars) || stars < 1 || stars > 5) {
    return res.status(400).json({ error: "لازم تختار تقييم من 1 لـ5 نجوم" });
  }
  try {
    const order = await loadOrderForToken(orderId, token);
    if (!order) return res.status(404).json({ error: "اللينك ده غير صالح" });

    const branch = await pool.query("SELECT branch_id FROM orders WHERE id = $1", [orderId]);
    await pool.query(
      `INSERT INTO order_ratings (order_id, branch_id, stars, comment)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (order_id) DO UPDATE SET stars = $3, comment = $4, updated_at = now()`,
      [orderId, branch.rows[0]?.branch_id || null, stars, (comment || "").trim() || null]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
