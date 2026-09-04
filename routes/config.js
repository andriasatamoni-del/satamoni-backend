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
        branchId: a.branch_id,
      })),
      paymentMethods: payments.rows.map((p) => ({
        id: p.id,
        name: p.name,
        note: p.note,
        kind: p.kind,
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
    const [menu, branches, areas, payments, combos, comboItems] = await Promise.all([
      pool.query(`
        SELECT mi.id, mi.name, mi.description, mi.image_url AS image, mi.is_best AS best,
               mc.name AS category, mc.display_order AS "categoryOrder", mc.menu_group AS "menuGroup",
               json_agg(jsonb_build_object('id', v.id, 'label', v.label, 'price', v.price, 'talabatPrice', v.talabat_price) ORDER BY v.id) AS variants,
               COALESCE(
                 (SELECT json_agg(jsonb_build_object(
                    'id', m.id, 'name', m.name, 'priceDelta', m.price_delta,
                    'variantPrices', COALESCE(
                      (SELECT jsonb_object_agg(vp.variant_id, vp.price_delta) FROM menu_item_modifier_variant_prices vp WHERE vp.modifier_id = m.id),
                      '{}'::jsonb
                    )
                  ) ORDER BY m.id)
                  FROM menu_item_modifiers m WHERE m.item_id = mi.id AND m.is_active = TRUE),
                 '[]'
               ) AS modifiers
        FROM menu_items mi
        JOIN menu_categories mc ON mc.id = mi.category_id
        JOIN menu_item_variants v ON v.item_id = mi.id
        WHERE mi.is_active = TRUE
        GROUP BY mi.id, mc.name, mc.display_order, mc.menu_group
        ORDER BY mc.display_order, mc.name, mi.id
      `),
      pool.query("SELECT * FROM branches WHERE is_central_kitchen = FALSE ORDER BY id"),
      pool.query("SELECT * FROM delivery_areas ORDER BY id"),
      pool.query("SELECT * FROM payment_methods WHERE enabled = TRUE ORDER BY id"),
      pool.query("SELECT * FROM combos WHERE is_active = TRUE ORDER BY id"),
      pool.query(`
        SELECT ci.combo_id, ci.variant_id, ci.quantity, mv.label, mi.name AS item_name
        FROM combo_items ci
        JOIN menu_item_variants mv ON mv.id = ci.variant_id
        JOIN menu_items mi ON mi.id = mv.item_id
      `),
    ]);

    res.json({
      menu: menu.rows,
      branches: branches.rows.map((b) => ({
        id: b.id, name: b.name, address: b.address, phone: b.phone,
        hours: b.hours, lat: b.lat, lng: b.lng, supportsDineIn: b.supports_dine_in,
        // المرحلة 8.43: NULL يعني الفرع مش شغال بوضع محلي/مزامنة خالص - متصل بالمركزي مباشرة زي دايمًا
        lastSyncedAt: b.last_synced_at,
      })),
      deliveryAreas: areas.rows.map((a) => ({
        id: a.id, name: a.name, fee: Number(a.fee),
        etaMinutes: a.eta_minutes, minOrder: Number(a.min_order),
        branchId: a.branch_id,
      })),
      paymentMethods: payments.rows.map((p) => ({
        id: p.id, name: p.name, note: p.note, kind: p.kind, enabled: p.enabled,
      })),
      combos: combos.rows.map((c) => ({
        id: c.id, name: c.name, price: Number(c.price),
        items: comboItems.rows.filter((it) => it.combo_id === c.id),
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
  const { name, fee = 0, minOrder = 0, etaMinutes = 30, branchId = null } = req.body;
  if (!name) return res.status(400).json({ error: "لازم اسم المنطقة" });
  try {
    const result = await pool.query(
      `INSERT INTO delivery_areas (name, fee, min_order, eta_minutes, branch_id)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [name, fee, minOrder, etaMinutes, branchId]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/config/delivery-areas/:id
router.patch("/delivery-areas/:id", requireAuth, requireRole("admin"), async (req, res) => {
  const { id } = req.params;
  const { name, fee, minOrder, etaMinutes, branchId } = req.body;
  const fields = [];
  const values = [];
  let i = 1;
  if (name !== undefined) { fields.push(`name = $${i++}`); values.push(name); }
  if (fee !== undefined) { fields.push(`fee = $${i++}`); values.push(fee); }
  if (minOrder !== undefined) { fields.push(`min_order = $${i++}`); values.push(minOrder); }
  if (etaMinutes !== undefined) { fields.push(`eta_minutes = $${i++}`); values.push(etaMinutes); }
  if (branchId !== undefined) { fields.push(`branch_id = $${i++}`); values.push(branchId); }
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
// kind: 'cash' (بيتحصّل لحظيًا) | 'card_or_wallet' (فيزا/محفظة/إنستاباي، بيفضل تحت التحصيل) | 'credit' (آجل، تسوية شهرية)
router.post("/payment-methods", requireAuth, requireRole("admin"), async (req, res) => {
  const { name, note, kind = "cash", enabled = true } = req.body;
  if (!name) return res.status(400).json({ error: "لازم اسم طريقة الدفع" });
  if (!["cash", "card_or_wallet", "credit"].includes(kind)) {
    return res.status(400).json({ error: "نوع طريقة دفع غير معروف" });
  }
  try {
    const result = await pool.query(
      "INSERT INTO payment_methods (name, note, kind, enabled) VALUES ($1, $2, $3, $4) RETURNING *",
      [name, note || null, kind, enabled]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/config/payment-methods/:id - تعديل أو تفعيل/تعطيل طريقة دفع
router.patch("/payment-methods/:id", requireAuth, requireRole("admin"), async (req, res) => {
  const { id } = req.params;
  const { name, note, kind, enabled } = req.body;
  if (kind !== undefined && !["cash", "card_or_wallet", "credit"].includes(kind)) {
    return res.status(400).json({ error: "نوع طريقة دفع غير معروف" });
  }
  const fields = [];
  const values = [];
  let i = 1;
  if (name !== undefined) { fields.push(`name = $${i++}`); values.push(name); }
  if (note !== undefined) { fields.push(`note = $${i++}`); values.push(note); }
  if (kind !== undefined) { fields.push(`kind = $${i++}`); values.push(kind); }
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
