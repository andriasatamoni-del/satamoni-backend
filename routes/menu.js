const express = require("express");
const router = express.Router();
const pool = require("../db/pool");
const { requireAuth, requireRole } = require("../middleware/auth");
const { requirePermission } = require("../middleware/permissions");
const { logAudit } = require("../db/audit");
const { logPriceChange } = require("../db/menu-price-history");
const { getActiveRecipeForConsumer, getRecipeVersionDetail } = require("../db/recipe-engine");

// المرحلة 8.29 (شاشة الأصناف): admin/branch_manager(بما فيهم مدير السنتر كيتشن)/accountant - نفس
// مجموعة الأدوار اللي عندها inventory.view بالظبط، عشان شاشة الأصناف تقدر تعرض أصناف المنيو وتفاصيلها.
// بيانات المنيو مش حساسة أصلًا (متاحة بالكامل من غير أي auth عبر GET /api/menu العام)
const menuReaders = requireRole("admin", "branch_manager", "accountant");

// GET /api/menu - المنيو النشط بس مع الأصناف والأسعار (شكل جاهز للموقع/الكاشير)
// كل صنف بييجي بمرفقاته المتاحة (modifiers) عشان شاشة البيع تعرضها وقت الإضافة للسلة
router.get("/", async (req, res) => {
  try {
    const items = await pool.query(`
      SELECT mi.id, mi.name, mi.description, mi.image_url, mi.is_best,
             mc.name AS category, mc.display_order AS category_order, mc.menu_group,
             json_agg(jsonb_build_object('id', v.id, 'label', v.label, 'price', v.price, 'talabatPrice', v.talabat_price) ORDER BY v.id) FILTER (WHERE v.id IS NOT NULL) AS variants,
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

// GET /api/menu/items?search= - كل الأصناف (نشطة وغير نشطة) لشاشة إدارة المنيو
// المرحلة 8.29: بحث اختياري بالاسم (بحث جزئي غير حساس لحالة الحروف) - إضافي بالكامل
router.get("/items", requireAuth, menuReaders, async (req, res) => {
  const { search } = req.query;
  try {
    const items = await pool.query(`
      SELECT mi.id, mi.name, mi.description, mi.image_url, mi.is_best, mi.is_active,
             mi.category_id, mc.name AS category,
             COALESCE(json_agg(json_build_object('id', v.id, 'label', v.label, 'price', v.price, 'talabatPrice', v.talabat_price) ORDER BY v.id)
               FILTER (WHERE v.id IS NOT NULL), '[]') AS variants
      FROM menu_items mi
      JOIN menu_categories mc ON mc.id = mi.category_id
      LEFT JOIN menu_item_variants v ON v.item_id = mi.id
      ${search ? "WHERE mi.name ILIKE $1" : ""}
      GROUP BY mi.id, mc.name, mc.display_order
      ORDER BY mc.display_order, mc.name, mi.id
    `, search ? [`%${search}%`] : []);
    res.json(items.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/menu/items/:id/detail - المرحلة 8.29: شاشة "الأصناف" - صنف منيو بكل تفاصيله (بيانات أساسية +
// كل حجم/variant بسعره ووصفته وتكلفته وهامش ربحه). قراءة بس، بيستخدم recipe-engine الموجود من غير أي
// حساب تكلفة جديد
router.get("/items/:id/detail", requireAuth, menuReaders, async (req, res) => {
  try {
    const itemRes = await pool.query(
      `SELECT mi.*, mc.name AS category_name FROM menu_items mi
       JOIN menu_categories mc ON mc.id = mi.category_id WHERE mi.id = $1`,
      [req.params.id]
    );
    if (itemRes.rows.length === 0) return res.status(404).json({ error: "الصنف مش موجود" });
    const item = itemRes.rows[0];

    const variantsRes = await pool.query(
      "SELECT * FROM menu_item_variants WHERE item_id = $1 ORDER BY id",
      [req.params.id]
    );
    const variants = [];
    for (const v of variantsRes.rows) {
      const activeRecipe = await getActiveRecipeForConsumer(pool, { variantId: v.id });
      let recipe = null;
      if (activeRecipe) recipe = await getRecipeVersionDetail(pool, activeRecipe.version_id);
      const cost = recipe?.cost?.totalCost ?? null;
      const price = Number(v.price);
      const margin = cost != null ? price - cost : null;
      variants.push({
        ...v,
        recipe,
        foodCostPercent: cost != null && price > 0 ? (cost / price) * 100 : null,
        margin,
        marginPercent: margin != null && price > 0 ? (margin / price) * 100 : null,
      });
    }

    res.json({ item, variants });
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

// المرحلة 8.16: POST /api/menu/talabat-prices/import - استيراد أسعار طلبات بالجملة على المنيو كامل
// بدل ما المالك يعدّل كل صنف لوحده. نفس منطق db/import-talabat-prices.js (السكريبت اللي كان بيتشغّل
// من التيرمينال مباشرة على الداتابيز) بس كـ endpoint فعلي يقدر المالك/الأدمن يستخدمه من واجهة المنيو -
// عشان معندوش وصول مباشر لتيرمينال السيرفر على staging/production. كل صف بيتعالج لوحده (مش transaction
// واحدة للكل) عشان الصفوف اللي متطابقتش (اسم صنف/حجم غلط) متمنعش الصفوف الصحيحة من التحديث
router.post("/talabat-prices/import", requireAuth, requireRole("admin"), async (req, res) => {
  const { rows } = req.body;
  if (!Array.isArray(rows) || rows.length === 0) {
    return res.status(400).json({ error: "لازم قايمة صفوف [اسم الصنف, اسم الحجم, السعر]" });
  }
  const updated = [];
  const notFound = [];
  try {
    for (const row of rows) {
      const [itemName, variantLabel, talabatPrice] = Array.isArray(row) ? row : [];
      if (!itemName || !variantLabel || talabatPrice === undefined || talabatPrice === null || Number.isNaN(Number(talabatPrice))) {
        notFound.push(`${itemName || "?"} (${variantLabel || "?"}) - بيانات الصف غير صحيحة`);
        continue;
      }
      const before = await pool.query(
        `SELECT v.id, v.talabat_price FROM menu_item_variants v
         JOIN menu_items i ON i.id = v.item_id
         WHERE i.name = $1 AND v.label = $2`,
        [itemName, variantLabel]
      );
      if (before.rows.length === 0) {
        notFound.push(`${itemName} (${variantLabel}) - مش موجود في المنيو`);
        continue;
      }
      const variantId = before.rows[0].id;
      await pool.query("UPDATE menu_item_variants SET talabat_price = $1 WHERE id = $2", [Number(talabatPrice), variantId]);
      await logPriceChange(pool, {
        entityType: "variant", entityId: variantId, fieldName: "talabat_price",
        oldPrice: before.rows[0].talabat_price, newPrice: Number(talabatPrice), changedBy: req.user.id,
      });
      updated.push({ itemName, variantLabel, oldPrice: before.rows[0].talabat_price, newPrice: Number(talabatPrice) });
    }
    await logAudit(pool, {
      userId: req.user.id, action: "TALABAT_PRICES_BULK_IMPORT", entityType: "menu_item_variant", entityId: null,
      newValues: { updatedCount: updated.length, notFoundCount: notFound.length }, req,
    });
    res.json({ updatedCount: updated.length, updated, notFound });
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
    const before = await pool.query("SELECT label, price, talabat_price FROM menu_item_variants WHERE id = $1", [id]);
    const result = await pool.query(
      `UPDATE menu_item_variants SET ${fields.join(", ")} WHERE id = $${i} RETURNING *`,
      values
    );
    if (result.rows.length === 0) return res.status(404).json({ error: "الحجم مش موجود" });
    if (price !== undefined && before.rows[0] && Number(before.rows[0].price) !== Number(price)) {
      await logAudit(pool, {
        userId: req.user.id, action: "PRICE_CHANGE", entityType: "menu_variant", entityId: Number(id),
        oldValues: { price: before.rows[0].price }, newValues: { price }, req,
      });
      await logPriceChange(pool, {
        entityType: "variant", entityId: Number(id), fieldName: "price",
        oldPrice: before.rows[0].price, newPrice: price, changedBy: req.user.id,
      });
    }
    if (talabatPrice !== undefined && before.rows[0]) {
      await logPriceChange(pool, {
        entityType: "variant", entityId: Number(id), fieldName: "talabat_price",
        oldPrice: before.rows[0].talabat_price, newPrice: talabatPrice, changedBy: req.user.id,
      });
    }
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
// كل مرفق بييجي بـ variantPrices: أسعار مخصوصة لأحجام معيّنة (لو موجودة) غير السعر الافتراضي، وبـ
// excludedIngredientName لو المرفق ده من نوع "بدون" مربوط بمكوّن من وصفة الصنف (المرحلة 8.9)
router.get("/items/:id/modifiers", requireAuth, requireRole("admin"), async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT m.*, ii.name AS excluded_ingredient_name, COALESCE(
         (SELECT jsonb_object_agg(vp.variant_id, vp.price_delta) FROM menu_item_modifier_variant_prices vp WHERE vp.modifier_id = m.id),
         '{}'::jsonb
       ) AS variant_prices
       FROM menu_item_modifiers m
       LEFT JOIN inventory_items ii ON ii.id = m.excluded_ingredient_item_id
       WHERE m.item_id = $1 ORDER BY m.id`,
      [req.params.id]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/menu/items/:id/ingredients - مكوّنات وصفة الصنف (كل أحجامه مجمّعة، بدون تكرار) - عشان شاشة
// إدارة المرفقات تقدر تعرض قايمة "استبعاد مكوّن" وقت إنشاء مرفق من نوع "بدون" (المرحلة 8.9)
router.get("/items/:id/ingredients", requireAuth, requireRole("admin"), async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT DISTINCT ii.id, ii.name, ii.unit
       FROM menu_item_variant_ingredients mvi
       JOIN menu_item_variants v ON v.id = mvi.variant_id
       JOIN inventory_items ii ON ii.id = mvi.inventory_item_id
       WHERE v.item_id = $1
       ORDER BY ii.name`,
      [req.params.id]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// المرفق من نوع "بدون" لازم يستبعد مكوّن فعلي من وصفة نفس الصنف - مش أي صنف مخزون عشوائي (غلطة إدارية
// أو محاولة تلاعب هتبوّظ حساب الاستهلاك/التكلفة بصمت). NULL (بدون استبعاد) دايمًا مسموح.
async function assertIngredientBelongsToItem(itemId, excludedIngredientItemId) {
  if (excludedIngredientItemId == null) return;
  const check = await pool.query(
    `SELECT 1 FROM menu_item_variant_ingredients mvi
     JOIN menu_item_variants v ON v.id = mvi.variant_id
     WHERE v.item_id = $1 AND mvi.inventory_item_id = $2 LIMIT 1`,
    [itemId, excludedIngredientItemId]
  );
  if (check.rows.length === 0) {
    throw Object.assign(new Error("المكوّن ده مش جزء من وصفة الصنف ده"), { code: "INVALID_PARAMETER" });
  }
}

// POST /api/menu/items/:id/modifiers - إضافة مرفق جديد للصنف - excludedIngredientItemId اختياري
// (المرحلة 8.9): لو محدد، لازم يكون مكوّن فعلي من وصفة الصنف ده
router.post("/items/:id/modifiers", requireAuth, requireRole("admin"), async (req, res) => {
  const { name, priceDelta = 0, excludedIngredientItemId = null } = req.body;
  if (!name) return res.status(400).json({ error: "لازم اسم المرفق" });
  try {
    await assertIngredientBelongsToItem(req.params.id, excludedIngredientItemId);
    const result = await pool.query(
      `INSERT INTO menu_item_modifiers (item_id, name, price_delta, excluded_ingredient_item_id)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [req.params.id, name, priceDelta, excludedIngredientItemId]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    if (err.code === "23505") return res.status(409).json({ error: "المرفق ده موجود بالفعل للصنف ده" });
    if (err.code === "INVALID_PARAMETER") return res.status(400).json({ error: err.message, code: err.code });
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/menu/modifiers/:id - تعديل اسم/سعر/تفعيل مرفق - وكمان excludedIngredientItemId (المرحلة
// 8.9): null صراحة بيشيل ربط الاستبعاد (يرجّعه مرفق عادي)، undefined (مش متبعوت) يسيبه زي ما هو
router.patch("/modifiers/:id", requireAuth, requireRole("admin"), async (req, res) => {
  const { id } = req.params;
  const { name, priceDelta, isActive, excludedIngredientItemId } = req.body;
  const fields = [];
  const values = [];
  let i = 1;
  if (name !== undefined) { fields.push(`name = $${i++}`); values.push(name); }
  if (priceDelta !== undefined) { fields.push(`price_delta = $${i++}`); values.push(priceDelta); }
  if (isActive !== undefined) { fields.push(`is_active = $${i++}`); values.push(isActive); }
  if (excludedIngredientItemId !== undefined) { fields.push(`excluded_ingredient_item_id = $${i++}`); values.push(excludedIngredientItemId); }
  if (fields.length === 0) return res.status(400).json({ error: "مفيش حاجة تتعدل" });

  values.push(id);
  try {
    if (excludedIngredientItemId !== undefined) {
      const existing = await pool.query("SELECT item_id FROM menu_item_modifiers WHERE id = $1", [id]);
      if (existing.rows.length === 0) return res.status(404).json({ error: "المرفق مش موجود" });
      await assertIngredientBelongsToItem(existing.rows[0].item_id, excludedIngredientItemId);
    }
    const before = await pool.query("SELECT price_delta FROM menu_item_modifiers WHERE id = $1", [id]);
    const result = await pool.query(
      `UPDATE menu_item_modifiers SET ${fields.join(", ")} WHERE id = $${i} RETURNING *`,
      values
    );
    if (result.rows.length === 0) return res.status(404).json({ error: "المرفق مش موجود" });
    if (priceDelta !== undefined && before.rows[0]) {
      await logPriceChange(pool, {
        entityType: "modifier", entityId: Number(id), fieldName: "price_delta",
        oldPrice: before.rows[0].price_delta, newPrice: priceDelta, changedBy: req.user.id,
      });
    }
    res.json(result.rows[0]);
  } catch (err) {
    if (err.code === "INVALID_PARAMETER") return res.status(400).json({ error: err.message, code: err.code });
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

// PUT /api/menu/modifiers/:id/variant-prices/:variantId - سعر مخصوص للمرفق ده على حجم معيّن
// (لو "اضافة سدق" سعرها مختلف على بيتزا وسط عن فطير كبير، كل حجم بيتسجل سعره لوحده هنا)
router.put("/modifiers/:id/variant-prices/:variantId", requireAuth, requireRole("admin"), async (req, res) => {
  const { priceDelta } = req.body;
  if (priceDelta === undefined || priceDelta === null) return res.status(400).json({ error: "لازم تحدد السعر" });
  try {
    const before = await pool.query(
      "SELECT price_delta FROM menu_item_modifier_variant_prices WHERE modifier_id = $1 AND variant_id = $2",
      [req.params.id, req.params.variantId]
    );
    const result = await pool.query(
      `INSERT INTO menu_item_modifier_variant_prices (modifier_id, variant_id, price_delta)
       VALUES ($1, $2, $3)
       ON CONFLICT (modifier_id, variant_id) DO UPDATE SET price_delta = EXCLUDED.price_delta
       RETURNING *`,
      [req.params.id, req.params.variantId, priceDelta]
    );
    await logPriceChange(pool, {
      entityType: "modifier_variant_price", entityId: Number(req.params.id), variantId: Number(req.params.variantId),
      fieldName: "price_delta", oldPrice: before.rows[0]?.price_delta ?? null, newPrice: priceDelta, changedBy: req.user.id,
    });
    res.json(result.rows[0]);
  } catch (err) {
    if (err.code === "23503") return res.status(400).json({ error: "المرفق أو الحجم ده مش موجود" });
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/menu/modifiers/:id/variant-prices/:variantId - إلغاء السعر المخصوص (يرجع للسعر الافتراضي)
router.delete("/modifiers/:id/variant-prices/:variantId", requireAuth, requireRole("admin"), async (req, res) => {
  try {
    await pool.query(
      "DELETE FROM menu_item_modifier_variant_prices WHERE modifier_id = $1 AND variant_id = $2",
      [req.params.id, req.params.variantId]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------- المرحلة 7O: سجل تاريخ الأسعار ----------------

// GET /api/menu/variants/:id/price-history - كل تغييرات سعر الحجم (الأساسي وسعر طلبات) بترتيب الأحدث أولًا
router.get("/variants/:id/price-history", requireAuth, requireRole("admin"), async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT h.*, u.name AS changed_by_name FROM menu_price_history h
       LEFT JOIN users u ON u.id = h.changed_by
       WHERE h.entity_type = 'variant' AND h.entity_id = $1
       ORDER BY h.changed_at DESC`,
      [req.params.id]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/menu/modifiers/:id/price-history - سعر المرفق الافتراضي، أو ?variantId= لسعره المخصوص على حجم معيّن
router.get("/modifiers/:id/price-history", requireAuth, requireRole("admin"), async (req, res) => {
  const { variantId } = req.query;
  try {
    const result = variantId
      ? await pool.query(
          `SELECT h.*, u.name AS changed_by_name FROM menu_price_history h
           LEFT JOIN users u ON u.id = h.changed_by
           WHERE h.entity_type = 'modifier_variant_price' AND h.entity_id = $1 AND h.variant_id = $2
           ORDER BY h.changed_at DESC`,
          [req.params.id, variantId]
        )
      : await pool.query(
          `SELECT h.*, u.name AS changed_by_name FROM menu_price_history h
           LEFT JOIN users u ON u.id = h.changed_by
           WHERE h.entity_type = 'modifier' AND h.entity_id = $1
           ORDER BY h.changed_at DESC`,
          [req.params.id]
        );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
