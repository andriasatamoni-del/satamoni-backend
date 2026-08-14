const express = require("express");
const router = express.Router();
const pool = require("../db/pool");
const { requireAuth, requireRole } = require("../middleware/auth");

// GET /api/menu - المنيو النشط بس مع الأصناف والأسعار (شكل جاهز للموقع/الكاشير)
// كل صنف بييجي بمرفقاته المتاحة (modifiers) عشان شاشة البيع تعرضها وقت الإضافة للسلة
router.get("/", async (req, res) => {
  try {
    const items = await pool.query(`
      SELECT mi.id, mi.name, mi.description, mi.image_url, mi.is_best,
             mc.name AS category, mc.display_order AS category_order, mc.menu_group,
             json_agg(jsonb_build_object('id', v.id, 'label', v.label, 'price', v.price, 'talabatPrice', v.talabat_price) ORDER BY v.id) FILTER (WHERE v.id IS NOT NULL) AS variants,
             COALESCE(
               (SELECT json_agg(jsonb_build_object('id', m.id, 'name', m.name, 'priceDelta', m.price_delta) ORDER BY m.id)
                FROM menu_item_modifiers m WHERE m.item_id = mi.id AND m.is_active = TRUE),
               '[]'
             ) AS modifiers
      FROM menu_items mi
      JOIN menu_categories mc ON mc.id = mi.category_id
      JOIN menu_item_variants v ON v.item_id = mi.id
      WHERE mi.is_active = TRUE
      GROUP BY mi.id, mc.name, mc.display_order, mc.menu_group
      ORDER BY mc.display_order, mc.name, mi.id
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
    const result = await pool.query("SELECT * FROM menu_categories ORDER BY display_order, name");
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/menu/categories - إضافة قسم جديد (بيتزا / برجر ...)
router.post("/categories", requireAuth, requireRole("admin"), async (req, res) => {
  const { name, displayOrder = 0, menuGroup = "regular" } = req.body;
  if (!name) return res.status(400).json({ error: "لازم اسم القسم" });
  try {
    const result = await pool.query(
      "INSERT INTO menu_categories (name, display_order, menu_group) VALUES ($1, $2, $3) RETURNING *",
      [name, displayOrder, menuGroup]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    if (err.code === "23505") return res.status(409).json({ error: "القسم ده موجود بالفعل" });
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/menu/categories/:id - تعديل ترتيب الظهور أو المجموعة (عادي/صيامي) أو الاسم
router.patch("/categories/:id", requireAuth, requireRole("admin"), async (req, res) => {
  const { id } = req.params;
  const { name, displayOrder, menuGroup } = req.body;
  if (menuGroup !== undefined && !["regular", "fasting"].includes(menuGroup)) {
    return res.status(400).json({ error: "مجموعة منيو غير معروفة" });
  }
  const fields = [];
  const values = [];
  let i = 1;
  if (name !== undefined) { fields.push(`name = $${i++}`); values.push(name); }
  if (displayOrder !== undefined) { fields.push(`display_order = $${i++}`); values.push(displayOrder); }
  if (menuGroup !== undefined) { fields.push(`menu_group = $${i++}`); values.push(menuGroup); }
  if (fields.length === 0) return res.status(400).json({ error: "مفيش حاجة تتعدل" });

  values.push(id);
  try {
    const result = await pool.query(
      `UPDATE menu_categories SET ${fields.join(", ")} WHERE id = $${i} RETURNING *`,
      values
    );
    if (result.rows.length === 0) return res.status(404).json({ error: "القسم مش موجود" });
    res.json(result.rows[0]);
  } catch (err) {
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
      GROUP BY mi.id, mc.name, mc.display_order
      ORDER BY mc.display_order, mc.name, mi.id
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

// ---------------- مرفقات الصنف (إضافة موتزريلا / بدون طماطم ...) ----------------

// GET /api/menu/items/:id/modifiers - كل مرفقات الصنف (نشطة وغير نشطة، لشاشة الإدارة)
router.get("/items/:id/modifiers", requireAuth, requireRole("admin"), async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM menu_item_modifiers WHERE item_id = $1 ORDER BY id",
      [req.params.id]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/menu/items/:id/modifiers - إضافة مرفق جديد للصنف
router.post("/items/:id/modifiers", requireAuth, requireRole("admin"), async (req, res) => {
  const { name, priceDelta = 0 } = req.body;
  if (!name) return res.status(400).json({ error: "لازم اسم المرفق" });
  try {
    const result = await pool.query(
      "INSERT INTO menu_item_modifiers (item_id, name, price_delta) VALUES ($1, $2, $3) RETURNING *",
      [req.params.id, name, priceDelta]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    if (err.code === "23505") return res.status(409).json({ error: "المرفق ده موجود بالفعل للصنف ده" });
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/menu/modifiers/:id - تعديل اسم/سعر/تفعيل مرفق
router.patch("/modifiers/:id", requireAuth, requireRole("admin"), async (req, res) => {
  const { id } = req.params;
  const { name, priceDelta, isActive } = req.body;
  const fields = [];
  const values = [];
  let i = 1;
  if (name !== undefined) { fields.push(`name = $${i++}`); values.push(name); }
  if (priceDelta !== undefined) { fields.push(`price_delta = $${i++}`); values.push(priceDelta); }
  if (isActive !== undefined) { fields.push(`is_active = $${i++}`); values.push(isActive); }
  if (fields.length === 0) return res.status(400).json({ error: "مفيش حاجة تتعدل" });

  values.push(id);
  try {
    const result = await pool.query(
      `UPDATE menu_item_modifiers SET ${fields.join(", ")} WHERE id = $${i} RETURNING *`,
      values
    );
    if (result.rows.length === 0) return res.status(404).json({ error: "المرفق مش موجود" });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/menu/modifiers/:id
router.delete("/modifiers/:id", requireAuth, requireRole("admin"), async (req, res) => {
  try {
    const result = await pool.query(
      "DELETE FROM menu_item_modifiers WHERE id = $1 RETURNING id",
      [req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: "المرفق مش موجود" });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
