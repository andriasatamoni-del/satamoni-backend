const express = require("express");
const router = express.Router();
const pool = require("../db/pool");

// GET /api/config - كل إعدادات الموقع في نداء واحد
// (مناطق التوصيل + طرق الدفع) - الفروع والمنيو ليهم /api/branches و /api/menu
router.get("/", async (req, res) => {
  try {
    const areas = await pool.query("SELECT * FROM delivery_areas ORDER BY id");
    const payments = await pool.query(
      "SELECT * FROM payment_methods WHERE enabled = TRUE ORDER BY id"
    );
    res.json({
      deliveryAreas: areas.rows.map((a) => ({
        id: a.id,
        name: a.name,
        fee: Number(a.fee),
        etaMinutes: a.eta_minutes,
        minOrder: Number(a.min_order),
      })),
      paymentMethods: payments.rows.map((p) => ({
        id: p.id,
        name: p.name,
        note: p.note,
        enabled: p.enabled,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/config/full - كل حاجة محتاجها الواجهة في نداء واحد (منيو + فروع + مناطق + دفع)
router.get("/full", async (req, res) => {
  try {
    const [menu, branches, areas, payments] = await Promise.all([
      pool.query(`
        SELECT mi.id, mi.name, mi.description, mi.image_url AS image, mi.is_best AS best,
               mc.name AS category,
               json_agg(json_build_object('id', v.id, 'label', v.label, 'price', v.price) ORDER BY v.id) AS variants
        FROM menu_items mi
        JOIN menu_categories mc ON mc.id = mi.category_id
        JOIN menu_item_variants v ON v.item_id = mi.id
        WHERE mi.is_active = TRUE
        GROUP BY mi.id, mc.name
        ORDER BY mc.name, mi.id
      `),
      pool.query("SELECT * FROM branches WHERE is_central_kitchen = FALSE ORDER BY id"),
      pool.query("SELECT * FROM delivery_areas ORDER BY id"),
      pool.query("SELECT * FROM payment_methods WHERE enabled = TRUE ORDER BY id"),
    ]);

    res.json({
      menu: menu.rows,
      branches: branches.rows.map((b) => ({
        id: b.id, name: b.name, address: b.address, phone: b.phone,
        hours: b.hours, lat: b.lat, lng: b.lng,
      })),
      deliveryAreas: areas.rows.map((a) => ({
        id: a.id, name: a.name, fee: Number(a.fee),
        etaMinutes: a.eta_minutes, minOrder: Number(a.min_order),
      })),
      paymentMethods: payments.rows.map((p) => ({
        id: p.id, name: p.name, note: p.note, enabled: p.enabled,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
