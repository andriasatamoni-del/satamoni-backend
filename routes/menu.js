const express = require("express");
const router = express.Router();
const multer = require("multer");
const pool = require("../db/pool");
const { requireAuth, requireRole } = require("../middleware/auth");
const { requirePermission } = require("../middleware/permissions");
const { logAudit } = require("../db/audit");
const { logPriceChange } = require("../db/menu-price-history");
const {
  readStatementGrid, buildPricesWorkbook, buildRecipesWorkbook, parsePricesGrid, parseRecipesGrid,
} = require("../db/menu-excel-io");

const menuExcelUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

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
      WHERE mi.is_active = TRUE AND mc.is_active = TRUE
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
  const { name, displayOrder, menuGroup, isActive } = req.body;
  if (menuGroup !== undefined && !["regular", "fasting"].includes(menuGroup)) {
    return res.status(400).json({ error: "مجموعة منيو غير معروفة" });
  }
  const fields = [];
  const values = [];
  let i = 1;
  if (name !== undefined) { fields.push(`name = $${i++}`); values.push(name); }
  if (displayOrder !== undefined) { fields.push(`display_order = $${i++}`); values.push(displayOrder); }
  if (menuGroup !== undefined) { fields.push(`menu_group = $${i++}`); values.push(menuGroup); }
  if (isActive !== undefined) { fields.push(`is_active = $${i++}`); values.push(!!isActive); }
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

// DELETE /api/menu/categories/:id - حذف قسم فاضي بالكامل (من غير أي صنف فيه) - لو فيه أصناف، لازم
// تتحذف/تتنقل لقسم تاني الأول (مش بنحذفهم تلقائي معاه، عشان محدش يفقد صنف بالغلط وهو مقصوده يحذف قسم بس)
router.delete("/categories/:id", requireAuth, requireRole("admin"), async (req, res) => {
  try {
    const items = await pool.query("SELECT COUNT(*)::int AS c FROM menu_items WHERE category_id = $1", [req.params.id]);
    if (items.rows[0].c > 0) {
      return res.status(400).json({ error: `القسم ده فيه ${items.rows[0].c} صنف - احذفهم الأول أو انقلهم لقسم تاني` });
    }
    const result = await pool.query("DELETE FROM menu_categories WHERE id = $1 RETURNING id", [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: "القسم مش موجود" });
    res.json({ ok: true });
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

// GET /api/menu/items/:id/detail - المرحلة 8.29 (مُصلَّحة): شاشة "الأصناف" - صنف منيو بكل تفاصيله
// (بيانات أساسية + كل حجم/variant بسعره ووصفته وتكلفته وهامش ربحه). الوصفة والتكلفة هنا بتتقرا **مباشرة
// من menu_item_variant_ingredients** بدل recipe_versions - ده الجدول اللي orders.js فعليًا بيحسب منه
// cost_at_sale الحقيقية وقت البيع (نفس المعادلة بالظبط: SUM(quantity_per_unit × unit_cost)). كان
// الكود القديم بيقرا من recipe_versions اللي لأصناف المنيو (sellable_variant) مجرد رابط تتبّع تاريخي
// اختياري منفصل عن التكلفة الحقيقية - فأي صنف اتضافت وصفته من شاشة المنيو (PUT /api/inventory/recipe/
// :variantId، المسار الوحيد اللي شاشة المنيو بتستخدمه) كان بيظهر هنا "مفيش وصفة" رغم إن له وصفة وتكلفة
// حقيقية شغالة فعليًا وقت البيع - نفس الجدول قراءة وكتابة هنا يقفل الفجوة دي نهائيًا
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
      const ingRes = await pool.query(
        `SELECT mvi.inventory_item_id, mvi.quantity_per_unit, ii.name AS item_name, ii.unit AS item_unit,
                ii.item_type, ii.unit_cost
         FROM menu_item_variant_ingredients mvi
         JOIN inventory_items ii ON ii.id = mvi.inventory_item_id
         WHERE mvi.variant_id = $1
         ORDER BY ii.name`,
        [v.id]
      );
      let recipe = null;
      if (ingRes.rows.length > 0) {
        const ingredients = ingRes.rows.map((r) => ({
          ingredient_item_id: r.inventory_item_id, quantity: Number(r.quantity_per_unit),
          item_name: r.item_name, item_unit: r.item_unit, item_type: r.item_type, unit_cost: r.unit_cost,
          line_cost: r.unit_cost != null ? Number(r.unit_cost) * Number(r.quantity_per_unit) : null,
        }));
        const totalCost = ingredients.reduce((s, i) => s + (i.line_cost || 0), 0);
        const incomplete = ingredients.some((i) => i.unit_cost == null);
        recipe = { ingredients, cost: { totalCost, incomplete } };
      }
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

// DELETE /api/menu/items/:id - حذف صنف نهائيًا (وأحجامه/وصفاته/مرفقاته معاه - كلهم CASCADE من الصنف).
// لو الصنف ده اتباع في أوردر حقيقي قبل كده، قاعدة البيانات نفسها بترفض الحذف (order_items بتشاور عليه
// من غير CASCADE عمدًا - تاريخ البيع محفوظ) - نرجّع رسالة واضحة تقول له يعطّله بدل ما يحذفه
router.delete("/items/:id", requireAuth, requireRole("admin"), async (req, res) => {
  try {
    const result = await pool.query("DELETE FROM menu_items WHERE id = $1 RETURNING id", [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: "الصنف مش موجود" });
    res.json({ ok: true });
  } catch (err) {
    if (err.code === "23503") {
      return res.status(400).json({ error: "الصنف ده اتباع في أوردرات حقيقية قبل كده - منقدرش نحذفه، استخدم تعطيله بدل كده" });
    }
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

// ---------------- تصدير/استيراد شيت إكسيل (تعديل جماعي للأسعار أو الريسبي) ----------------
// الفكرة: تصدير شيت بالحالة الحالية، تعديله يدويًا في إكسيل، ورفعه تاني - الاستيراد بيحدّث بس (مش بيضيف
// أصناف/أحجام جديدة، ومش بيحذف صنف/حجم غير موجود في الشيت) عشان يفضل آمن زي استيراد أسعار طلبات القديم
// بالظبط. كل استيراد له preview (من غير أي كتابة في الداتابيز) قبل commit، عشان صاحب المطعم يشوف التغييرات
// قبل ما تتنفذ فعليًا - مهم خصوصًا لشيت الريسبي لأن الاستبدال فيه كامل (راجع التعليق فوق /recipes/import/commit)

async function loadPriceSheetRows() {
  const result = await pool.query(`
    SELECT mc.name AS category, mi.name AS item, v.label AS variant, v.price, v.talabat_price AS "talabatPrice"
    FROM menu_item_variants v
    JOIN menu_items mi ON mi.id = v.item_id
    JOIN menu_categories mc ON mc.id = mi.category_id
    ORDER BY mc.display_order, mi.name, v.id
  `);
  // NUMERIC بيرجع كـstring من node-pg - لازم Number() هنا عشان خلايا الإكسيل تتكتب كأرقام حقيقية مش نص
  return result.rows.map((r) => ({
    ...r, price: Number(r.price), talabatPrice: r.talabatPrice == null ? null : Number(r.talabatPrice),
  }));
}

// GET /api/menu/prices/export - شيت إكسيل بكل الأصناف/الأحجام وأسعارها الحالية (العادي + طلبات)
router.get("/prices/export", requireAuth, requireRole("admin"), async (req, res) => {
  try {
    const rows = await loadPriceSheetRows();
    const buffer = await buildPricesWorkbook(rows);
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", 'attachment; filename="menu-prices.xlsx"');
    res.send(Buffer.from(buffer));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// بيرجع {changes, unchangedCount, notFound} من غير أي كتابة - مستخدمة من preview وcommit الاتنين عشان
// منطق المطابقة/الحساب يفضل مكرر مكان واحد بس
async function computePriceImportChanges(buffer, originalName) {
  const grid = await readStatementGrid(buffer, originalName);
  const parsedRows = parsePricesGrid(grid);
  const changes = [];
  const notFound = [];
  let unchangedCount = 0;

  for (const row of parsedRows) {
    if (!row.item || !row.variant || row.price === null || Number.isNaN(row.price) || Number.isNaN(row.talabatPrice)) {
      notFound.push(`${row.item || "?"} (${row.variant || "?"}) - بيانات الصف غير صحيحة`);
      continue;
    }
    const found = await pool.query(
      `SELECT v.id, v.price, v.talabat_price FROM menu_item_variants v
       JOIN menu_items mi ON mi.id = v.item_id
       WHERE mi.name = $1 AND v.label = $2`,
      [row.item, row.variant]
    );
    if (found.rows.length === 0) {
      notFound.push(`${row.item} (${row.variant}) - مش موجود في المنيو`);
      continue;
    }
    const current = found.rows[0];
    const priceChanged = Number(current.price) !== Number(row.price);
    const talabatChanged = (current.talabat_price == null ? null : Number(current.talabat_price)) !==
      (row.talabatPrice === null ? null : Number(row.talabatPrice));
    if (!priceChanged && !talabatChanged) { unchangedCount++; continue; }
    changes.push({
      variantId: current.id, category: row.category, item: row.item, variant: row.variant,
      oldPrice: Number(current.price), newPrice: row.price,
      oldTalabatPrice: current.talabat_price == null ? null : Number(current.talabat_price),
      newTalabatPrice: row.talabatPrice,
    });
  }
  return { changes, unchangedCount, notFound };
}

// POST /api/menu/prices/import/preview - {file} multipart -> التغييرات المتوقعة من غير أي كتابة فعلية
router.post("/prices/import/preview", requireAuth, requireRole("admin"), (req, res, next) => {
  menuExcelUpload.single("file")(req, res, (err) => {
    if (!err) return next();
    if (err.code === "LIMIT_FILE_SIZE") return res.status(400).json({ error: "الملف كبير جدًا (الحد الأقصى 10 ميجا)" });
    res.status(400).json({ error: err.message });
  });
}, async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "لازم ترفع ملف CSV أو Excel" });
  try {
    const result = await computePriceImportChanges(req.file.buffer, req.file.originalname);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /api/menu/prices/import/commit - بيطبّق نفس التغييرات اللي preview وريها بالظبط (بيعيد تحليل نفس
// الملف بدل ما يستنى الـclient يبعت التغييرات تاني، عشان مفيش فرصة يتلاعب حد بالأرقام بين preview وcommit)
router.post("/prices/import/commit", requireAuth, requireRole("admin"), (req, res, next) => {
  menuExcelUpload.single("file")(req, res, (err) => {
    if (!err) return next();
    if (err.code === "LIMIT_FILE_SIZE") return res.status(400).json({ error: "الملف كبير جدًا (الحد الأقصى 10 ميجا)" });
    res.status(400).json({ error: err.message });
  });
}, async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "لازم ترفع ملف CSV أو Excel" });
  try {
    const { changes, notFound } = await computePriceImportChanges(req.file.buffer, req.file.originalname);
    for (const change of changes) {
      await pool.query("UPDATE menu_item_variants SET price = $1, talabat_price = $2 WHERE id = $3",
        [change.newPrice, change.newTalabatPrice, change.variantId]);
      if (Number(change.oldPrice) !== Number(change.newPrice)) {
        await logPriceChange(pool, {
          entityType: "variant", entityId: change.variantId, fieldName: "price",
          oldPrice: change.oldPrice, newPrice: change.newPrice, changedBy: req.user.id,
        });
      }
      if ((change.oldTalabatPrice ?? null) !== (change.newTalabatPrice ?? null)) {
        await logPriceChange(pool, {
          entityType: "variant", entityId: change.variantId, fieldName: "talabat_price",
          oldPrice: change.oldTalabatPrice, newPrice: change.newTalabatPrice, changedBy: req.user.id,
        });
      }
    }
    await logAudit(pool, {
      userId: req.user.id, action: "MENU_PRICES_BULK_IMPORT", entityType: "menu_item_variant", entityId: null,
      newValues: { updatedCount: changes.length, notFoundCount: notFound.length, fileName: req.file.originalname }, req,
    });
    res.json({ updatedCount: changes.length, notFound });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

async function loadRecipeSheetRows() {
  const result = await pool.query(`
    SELECT mc.name AS category, mi.name AS item, v.label AS variant,
           ii.name AS ingredient, mvi.quantity_per_unit AS "quantityPerUnit", ii.unit
    FROM menu_item_variant_ingredients mvi
    JOIN menu_item_variants v ON v.id = mvi.variant_id
    JOIN menu_items mi ON mi.id = v.item_id
    JOIN menu_categories mc ON mc.id = mi.category_id
    JOIN inventory_items ii ON ii.id = mvi.inventory_item_id
    ORDER BY mc.display_order, mi.name, v.id, ii.name
  `);
  // NUMERIC بيرجع كـstring من node-pg - لازم Number() هنا عشان خلايا الإكسيل تتكتب كأرقام حقيقية مش نص
  return result.rows.map((r) => ({ ...r, quantityPerUnit: Number(r.quantityPerUnit) }));
}

// GET /api/menu/recipes/export - شيت إكسيل بكل الأصناف/الأحجام ومكوّناتها الحالية (سطر لكل مكوّن)
router.get("/recipes/export", requireAuth, requireRole("admin"), async (req, res) => {
  try {
    const rows = await loadRecipeSheetRows();
    const buffer = await buildRecipesWorkbook(rows);
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", 'attachment; filename="menu-recipes.xlsx"');
    res.send(Buffer.from(buffer));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// بيجمّع صفوف الشيت حسب (الصنف، الحجم) - كل مجموعة = الريسبي الجديد الكامل للحجم ده (استبدال كامل، مش
// إضافة/تحديث سطر بسطر) - لو صنف/حجم مش موجود أصلاً في الشيت، مبيتلمسش خالص (فرق عن "موجود بصفوف فاضية")
function groupRecipeRows(parsedRows) {
  const groups = new Map();
  for (const row of parsedRows) {
    if (!row.item || !row.variant) continue; // صف ناقص بيانات أساسية - هيتسجل تحت كـnotFound لو محتاج
    const key = `${row.item} ${row.variant}`;
    if (!groups.has(key)) groups.set(key, { category: row.category, item: row.item, variant: row.variant, lines: [] });
    groups.get(key).lines.push(row);
  }
  return [...groups.values()];
}

// بيرجع {variantChanges, unchangedVariantsCount, notFoundVariants, notFoundIngredients} من غير أي كتابة
async function computeRecipeImportChanges(buffer, originalName) {
  const grid = await readStatementGrid(buffer, originalName);
  const parsedRows = parseRecipesGrid(grid);
  const groups = groupRecipeRows(parsedRows);

  const variantChanges = [];
  const notFoundVariants = [];
  const notFoundIngredients = [];
  let unchangedVariantsCount = 0;

  for (const group of groups) {
    const variantRes = await pool.query(
      `SELECT v.id FROM menu_item_variants v
       JOIN menu_items mi ON mi.id = v.item_id
       WHERE mi.name = $1 AND v.label = $2`,
      [group.item, group.variant]
    );
    if (variantRes.rows.length === 0) {
      notFoundVariants.push(`${group.item} (${group.variant}) - مش موجود في المنيو`);
      continue;
    }
    const variantId = variantRes.rows[0].id;

    const newLines = [];
    for (const line of group.lines) {
      if (!line.ingredient || line.quantityPerUnit === null || Number.isNaN(line.quantityPerUnit) || line.quantityPerUnit <= 0) {
        notFoundIngredients.push(`${group.item} (${group.variant}) - "${line.ingredient || "?"}" - كمية غير صحيحة، اتجاهل`);
        continue;
      }
      const ingRes = await pool.query("SELECT id FROM inventory_items WHERE name = $1", [line.ingredient]);
      if (ingRes.rows.length === 0) {
        notFoundIngredients.push(`${group.item} (${group.variant}) - "${line.ingredient}" - مكوّن مش موجود في الكتالوج، اتجاهل`);
        continue;
      }
      newLines.push({ inventoryItemId: ingRes.rows[0].id, ingredient: line.ingredient, quantityPerUnit: line.quantityPerUnit });
    }

    const currentRes = await pool.query(
      `SELECT ii.id AS inventory_item_id, ii.name AS ingredient, mvi.quantity_per_unit AS "quantityPerUnit"
       FROM menu_item_variant_ingredients mvi JOIN inventory_items ii ON ii.id = mvi.inventory_item_id
       WHERE mvi.variant_id = $1`,
      [variantId]
    );
    const currentById = new Map(currentRes.rows.map((r) => [r.inventory_item_id, r]));
    const newById = new Map(newLines.map((r) => [r.inventoryItemId, r]));

    const added = newLines.filter((r) => !currentById.has(r.inventoryItemId))
      .map((r) => ({ ingredient: r.ingredient, quantityPerUnit: r.quantityPerUnit }));
    const removed = currentRes.rows.filter((r) => !newById.has(r.inventory_item_id))
      .map((r) => ({ ingredient: r.ingredient, quantityPerUnit: Number(r.quantityPerUnit) }));
    const changed = newLines.filter((r) => {
      const cur = currentById.get(r.inventoryItemId);
      return cur && Number(cur.quantityPerUnit) !== Number(r.quantityPerUnit);
    }).map((r) => ({
      ingredient: r.ingredient, oldQuantityPerUnit: Number(currentById.get(r.inventoryItemId).quantityPerUnit), newQuantityPerUnit: r.quantityPerUnit,
    }));

    if (added.length === 0 && removed.length === 0 && changed.length === 0) { unchangedVariantsCount++; continue; }
    variantChanges.push({
      variantId, category: group.category, item: group.item, variant: group.variant,
      added, removed, changed, newLines,
    });
  }
  return { variantChanges, unchangedVariantsCount, notFoundVariants, notFoundIngredients };
}

// POST /api/menu/recipes/import/preview - {file} multipart -> التغييرات المتوقعة (إضافة/حذف/تعديل كمية
// كل مكوّن لكل حجم) من غير أي كتابة فعلية
router.post("/recipes/import/preview", requireAuth, requireRole("admin"), (req, res, next) => {
  menuExcelUpload.single("file")(req, res, (err) => {
    if (!err) return next();
    if (err.code === "LIMIT_FILE_SIZE") return res.status(400).json({ error: "الملف كبير جدًا (الحد الأقصى 10 ميجا)" });
    res.status(400).json({ error: err.message });
  });
}, async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "لازم ترفع ملف CSV أو Excel" });
  try {
    const { variantChanges, unchangedVariantsCount, notFoundVariants, notFoundIngredients } =
      await computeRecipeImportChanges(req.file.buffer, req.file.originalname);
    res.json({
      variantChanges: variantChanges.map(({ newLines, ...rest }) => rest), // newLines داخلي بس (للcommit)
      unchangedVariantsCount, notFoundVariants, notFoundIngredients,
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /api/menu/recipes/import/commit - استبدال كامل لريسبي كل حجم ظهر في الشيت (نفس منطق/فلسفة
// PUT /api/inventory/recipe/:variantId بالظبط - DELETE ثم INSERT، مسجّل بنفس RECIPE_CHANGE audit action)
// أي حجم مش موجود في الشيت أصلاً بيفضل من غير ما يتلمس خالص
router.post("/recipes/import/commit", requireAuth, requireRole("admin"), (req, res, next) => {
  menuExcelUpload.single("file")(req, res, (err) => {
    if (!err) return next();
    if (err.code === "LIMIT_FILE_SIZE") return res.status(400).json({ error: "الملف كبير جدًا (الحد الأقصى 10 ميجا)" });
    res.status(400).json({ error: err.message });
  });
}, async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "لازم ترفع ملف CSV أو Excel" });
  try {
    const { variantChanges, notFoundVariants, notFoundIngredients } =
      await computeRecipeImportChanges(req.file.buffer, req.file.originalname);

    for (const change of variantChanges) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const before = await client.query(
          `SELECT inventory_item_id, quantity_per_unit FROM menu_item_variant_ingredients WHERE variant_id = $1`,
          [change.variantId]
        );
        await client.query("DELETE FROM menu_item_variant_ingredients WHERE variant_id = $1", [change.variantId]);
        for (const line of change.newLines) {
          await client.query(
            `INSERT INTO menu_item_variant_ingredients (variant_id, inventory_item_id, quantity_per_unit) VALUES ($1, $2, $3)`,
            [change.variantId, line.inventoryItemId, line.quantityPerUnit]
          );
        }
        await logAudit(client, {
          userId: req.user.id, action: "RECIPE_CHANGE", entityType: "menu_variant", entityId: change.variantId,
          oldValues: { ingredients: before.rows }, newValues: { ingredients: change.newLines, source: "excel_bulk_import" }, req,
        });
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }
    }

    await logAudit(pool, {
      userId: req.user.id, action: "MENU_RECIPES_BULK_IMPORT", entityType: "menu_item_variant", entityId: null,
      newValues: { updatedVariantsCount: variantChanges.length, notFoundVariantsCount: notFoundVariants.length, fileName: req.file.originalname }, req,
    });
    res.json({ updatedVariantsCount: variantChanges.length, notFoundVariants, notFoundIngredients });
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
