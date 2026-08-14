const express = require("express");
const router = express.Router();
const pool = require("../db/pool");
const { requireAuth, requireRole } = require("../middleware/auth");

// GET /api/menu - المنيو النشط بس مع الأصناف والأسعار (شكل جاهز للموقع/الكاشير)
router.get("/", async (req, res) => {
  try {
    const items = await pool.query(`
      SELECT mi.id, mi.name, mi.description, mi.image_url, mi.is_best,
             mc.name AS category,
             json_agg(json_build_object('id', v.id, 'label', v.label, 'price', v.price, 'talabatPrice', v.talabat_price)) AS variants
      FROM menu_items mi
      JOIN menu_categories mc ON mc.id = mi.category_id
      JOIN menu_item_variants v ON v.item_id = mi.id
      WHERE mi.is_active = TRUE
      GROUP BY mi.id, mc.name
      ORDER BY mc.name, mi.id
    `);
    res.json(items.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------- إدارة المنيو (أدمن بس) ----------------

// GET /api/menu/categories
router.get("/categories", requireAuth, requireRole("admin"), async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM menu_categories ORDER BY name");
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/menu/categories - إضافة قسم جديد (بيتزا / برجر ...)
router.post("/categories", requireAuth, requireRole("admin"), async (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: "لازم اسم القسم" });
  try {
    const result = await pool.query(
      "INSERT INTO menu_categories (name) VALUES ($1) RETURNING *",
      [name]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    if (err.code === "23505") return res.status(409).json({ error: "القسم ده موجود بالفعل" });
    res.status(500).json({ error: err.message });
  }
});

// GET /api/menu/items - كل الأصناف (نشطة وغير نشطة) لشاشة إدارة المنيو
router.get("/items", requireAuth, requireRole("admin"), async (req, res) => {
  try {
    const items = await pool.query(`
      SELECT mi.id, mi.name, mi.description, mi.image_url, mi.is_best, mi.is_active,
             mi.category_id, mc.name AS category,
             COALESCE(json_agg(json_build_object('id', v.id, 'label', v.label, 'price', v.price, 'talabatPrice', v.talabat_price) ORDER BY v.id)
               FILTER (WHERE v.id IS NOT NULL), '[]') AS variants
      FROM menu_items mi
      JOIN menu_categories mc ON mc.id = mi.category_id
      LEFT JOIN menu_item_variants v ON v.item_id = mi.id
      GROUP BY mi.id, mc.name
      ORDER BY mc.name, mi.id
    `);
    res.json(items.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/menu/items - إضافة صنف جديد (من غير أحجام لسه)
router.post("/items", requireAuth, requireRole("admin"), async (req, res) => {
  const { categoryId, name, description, imageUrl, isBest = false } = req.body;
  if (!categoryId || !name) return res.status(400).json({ error: "لازم قسم واسم الصنف" });
  try {
    const result = await pool.query(
      `INSERT INTO menu_items (category_id, name, description, image_url, is_best)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [categoryId, name, description || null, imageUrl || null, isBest]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/menu/items/:id - تعديل صنف (بما فيه تفعيل/تعطيل)
router.patch("/items/:id", requireAuth, requireRole("admin"), async (req, res) => {
  const { id } = req.params;
  const { categoryId, name, description, imageUrl, isBest, isActive } = req.body;
  const fields = [];
  const values = [];
  let i = 1;

  if (categoryId !== undefined) { fields.push(`category_id = $${i++}`); values.push(categoryId); }
  if (name !== undefined) { fields.push(`name = $${i++}`); values.push(name); }
  if (description !== undefined) { fields.push(`description = $${i++}`); values.push(description); }
  if (imageUrl !== undefined) { fields.push(`image_url = $${i++}`); values.push(imageUrl); }
  if (isBest !== undefined) { fields.push(`is_best = $${i++}`); values.push(isBest); }
  if (isActive !== undefined) { fields.push(`is_active = $${i++}`); values.push(isActive); }
  if (fields.length === 0) return res.status(400).json({ error: "مفيش حاجة تتعدل" });

  values.push(id);
  try {
    const result = await pool.query(
      `UPDATE menu_items SET ${fields.join(", ")} WHERE id = $${i} RETURNING *`,
      values
    );
    if (result.rows.length === 0) return res.status(404).json({ error: "الصنف مش موجود" });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/menu/items/:id/variants - إضافة حجم/سعر لصنف (وسط / كبير / عادي)
// talabatPrice اختياري - سعر مختلف لتطبيق طلبات (سيبه فاضي لو الصنف مش مباع هناك)
router.post("/items/:id/variants", requireAuth, requireRole("admin"), async (req, res) => {
  const { id } = req.params;
  const { label, price, talabatPrice } = req.body;
  if (!label || price === undefined) return res.status(400).json({ error: "لازم اسم الحجم والسعر" });
  try {
    const result = await pool.query(
      "INSERT INTO menu_item_variants (item_id, label, price, talabat_price) VALUES ($1, $2, $3, $4) RETURNING *",
      [id, label, price, talabatPrice ?? null]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/menu/variants/:id - تعديل حجم/سعر/سعر طلبات
router.patch("/variants/:id", requireAuth, requireRole("admin"), async (req, res) => {
  const { id } = req.params;
  const { label, price, talabatPrice } = req.body;
  const fields = [];
  const values = [];
  let i = 1;
  if (label !== undefined) { fields.push(`label = $${i++}`); values.push(label); }
  if (price !== undefined) { fields.push(`price = $${i++}`); values.push(price); }
  if (talabatPrice !== undefined) { fields.push(`talabat_price = $${i++}`); values.push(talabatPrice); }
  if (fields.length === 0) return res.status(400).json({ error: "مفيش حاجة تتعدل" });

  values.push(id);
  try {
    const result = await pool.query(
      `UPDATE menu_item_variants SET ${fields.join(", ")} WHERE id = $${i} RETURNING *`,
      values
    );
    if (result.rows.length === 0) return res.status(404).json({ error: "الحجم مش موجود" });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/menu/variants/:id - حذف حجم غلط بالغلط
router.delete("/variants/:id", requireAuth, requireRole("admin"), async (req, res) => {
  try {
    const result = await pool.query(
      "DELETE FROM menu_item_variants WHERE id = $1 RETURNING id",
      [req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: "الحجم مش موجود" });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
