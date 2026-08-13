const express = require("express");
const router = express.Router();
const pool = require("../db/pool");
const { requireAuth, requireRole } = require("../middleware/auth");

async function attachItems(combos) {
  if (combos.length === 0) return [];
  const comboIds = combos.map((c) => c.id);
  const items = await pool.query(
    `SELECT ci.combo_id, ci.variant_id, ci.quantity, mv.label, mv.price, mi.name AS item_name
     FROM combo_items ci
     JOIN menu_item_variants mv ON mv.id = ci.variant_id
     JOIN menu_items mi ON mi.id = mv.item_id
     WHERE ci.combo_id = ANY($1)`,
    [comboIds]
  );
  return combos.map((c) => ({
    ...c,
    items: items.rows.filter((it) => it.combo_id === c.id),
  }));
}

// GET /api/combos - العروض النشطة بس (للكاشير/الموقع/الكول سنتر)
router.get("/", async (req, res) => {
  try {
    const combos = await pool.query("SELECT * FROM combos WHERE is_active = TRUE ORDER BY id");
    res.json(await attachItems(combos.rows));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/combos/all - كل العروض (نشطة وغير نشطة) - أدمن بس، لشاشة الإدارة
router.get("/all", requireAuth, requireRole("admin"), async (req, res) => {
  try {
    const combos = await pool.query("SELECT * FROM combos ORDER BY id");
    res.json(await attachItems(combos.rows));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/combos - إضافة عرض جديد (أدمن بس)
// {name, price, items: [{variantId, quantity}]}
router.post("/", requireAuth, requireRole("admin"), async (req, res) => {
  const { name, price, items } = req.body;
  if (!name || price === undefined || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: "لازم اسم وسعر وصنف واحد على الأقل" });
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const comboResult = await client.query(
      "INSERT INTO combos (name, price) VALUES ($1, $2) RETURNING id",
      [name, price]
    );
    const comboId = comboResult.rows[0].id;
    for (const it of items) {
      await client.query(
        "INSERT INTO combo_items (combo_id, variant_id, quantity) VALUES ($1, $2, $3)",
        [comboId, it.variantId, it.quantity || 1]
      );
    }
    await client.query("COMMIT");
    res.status(201).json({ id: comboId });
  } catch (err) {
    await client.query("ROLLBACK");
    if (err.code === "23505") return res.status(409).json({ error: "العرض ده موجود بالفعل" });
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// PATCH /api/combos/:id - تعديل اسم/سعر/تفعيل عرض (أدمن بس)
router.patch("/:id", requireAuth, requireRole("admin"), async (req, res) => {
  const { name, price, isActive } = req.body;
  const fields = [];
  const values = [];
  let i = 1;
  if (name !== undefined) { fields.push(`name = $${i++}`); values.push(name); }
  if (price !== undefined) { fields.push(`price = $${i++}`); values.push(price); }
  if (isActive !== undefined) { fields.push(`is_active = $${i++}`); values.push(isActive); }
  if (fields.length === 0) return res.status(400).json({ error: "مفيش حاجة تتعدل" });

  values.push(req.params.id);
  try {
    const result = await pool.query(
      `UPDATE combos SET ${fields.join(", ")} WHERE id = $${i} RETURNING *`,
      values
    );
    if (result.rows.length === 0) return res.status(404).json({ error: "العرض مش موجود" });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/combos/:id/items - استبدال أصناف العرض بالكامل (أدمن بس)
router.put("/:id/items", requireAuth, requireRole("admin"), async (req, res) => {
  const { items } = req.body;
  if (!Array.isArray(items)) return res.status(400).json({ error: "لازم قايمة أصناف" });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM combo_items WHERE combo_id = $1", [req.params.id]);
    for (const it of items) {
      await client.query(
        "INSERT INTO combo_items (combo_id, variant_id, quantity) VALUES ($1, $2, $3)",
        [req.params.id, it.variantId, it.quantity || 1]
      );
    }
    await client.query("COMMIT");
    res.json({ ok: true });
  } catch (err) {
    await client.query("ROLLBACK");
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

module.exports = router;
