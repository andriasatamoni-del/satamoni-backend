const express = require("express");
const router = express.Router();
const pool = require("../db/pool");
const { requireAuth, requireRole } = require("../middleware/auth");

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
               json_agg(json_build_object('id', v.id, 'label', v.label, 'price', v.price, 'talabatPrice', v.talabat_price) ORDER BY v.id) AS variants
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

// ---------------- إدارة مناطق التوصيل وطرق الدفع (أدمن بس) ----------------

// GET /api/config/delivery-areas - كل المناطق (بما فيها لو فيه أي حاجة معطّلة مستقبلًا)
router.get("/delivery-areas", requireAuth, requireRole("admin"), async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM delivery_areas ORDER BY id");
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/config/delivery-areas - إضافة منطقة توصيل جديدة
router.post("/delivery-areas", requireAuth, requireRole("admin"), async (req, res) => {
  const { name, fee = 0, minOrder = 0, etaMinutes = 30 } = req.body;
  if (!name) return res.status(400).json({ error: "لازم اسم المنطقة" });
  try {
    const result = await pool.query(
      `INSERT INTO delivery_areas (name, fee, min_order, eta_minutes)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [name, fee, minOrder, etaMinutes]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/config/delivery-areas/:id
router.patch("/delivery-areas/:id", requireAuth, requireRole("admin"), async (req, res) => {
  const { id } = req.params;
  const { name, fee, minOrder, etaMinutes } = req.body;
  const fields = [];
  const values = [];
  let i = 1;
  if (name !== undefined) { fields.push(`name = $${i++}`); values.push(name); }
  if (fee !== undefined) { fields.push(`fee = $${i++}`); values.push(fee); }
  if (minOrder !== undefined) { fields.push(`min_order = $${i++}`); values.push(minOrder); }
  if (etaMinutes !== undefined) { fields.push(`eta_minutes = $${i++}`); values.push(etaMinutes); }
  if (fields.length === 0) return res.status(400).json({ error: "مفيش حاجة تتعدل" });

  values.push(id);
  try {
    const result = await pool.query(
      `UPDATE delivery_areas SET ${fields.join(", ")} WHERE id = $${i} RETURNING *`,
      values
    );
    if (result.rows.length === 0) return res.status(404).json({ error: "المنطقة مش موجودة" });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/config/payment-methods - كل طرق الدفع (بما فيها المعطّلة)
router.get("/payment-methods", requireAuth, requireRole("admin"), async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM payment_methods ORDER BY id");
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/config/payment-methods - إضافة طريقة دفع جديدة
router.post("/payment-methods", requireAuth, requireRole("admin"), async (req, res) => {
  const { name, note, enabled = true } = req.body;
  if (!name) return res.status(400).json({ error: "لازم اسم طريقة الدفع" });
  try {
    const result = await pool.query(
      "INSERT INTO payment_methods (name, note, enabled) VALUES ($1, $2, $3) RETURNING *",
      [name, note || null, enabled]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/config/payment-methods/:id - تعديل أو تفعيل/تعطيل طريقة دفع
router.patch("/payment-methods/:id", requireAuth, requireRole("admin"), async (req, res) => {
  const { id } = req.params;
  const { name, note, enabled } = req.body;
  const fields = [];
  const values = [];
  let i = 1;
  if (name !== undefined) { fields.push(`name = $${i++}`); values.push(name); }
  if (note !== undefined) { fields.push(`note = $${i++}`); values.push(note); }
  if (enabled !== undefined) { fields.push(`enabled = $${i++}`); values.push(enabled); }
  if (fields.length === 0) return res.status(400).json({ error: "مفيش حاجة تتعدل" });

  values.push(id);
  try {
    const result = await pool.query(
      `UPDATE payment_methods SET ${fields.join(", ")} WHERE id = $${i} RETURNING *`,
      values
    );
    if (result.rows.length === 0) return res.status(404).json({ error: "طريقة الدفع مش موجودة" });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
