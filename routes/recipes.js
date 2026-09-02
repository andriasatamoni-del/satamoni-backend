const express = require("express");
const router = express.Router();
const pool = require("../db/pool");
const { requireAuth, requireRole } = require("../middleware/auth");
const { requirePermission } = require("../middleware/permissions");
const { logAudit } = require("../db/audit");
const {
  explodeRecipeConsumption, computeRecipeCost, projectVersionToLegacyTable,
  getRecipeVersionDetail, getIngredientUsage,
} = require("../db/recipe-engine");

const EDITABLE_STATUSES = ["DRAFT", "REJECTED"];

async function insertIngredients(client, recipeVersionId, ingredients) {
  for (const ing of ingredients) {
    if (!ing.ingredientItemId || !ing.quantity || Number(ing.quantity) <= 0) {
      throw new Error("كل مكوّن لازم يكون له صنف وكمية أكبر من صفر");
    }
    await client.query(
      `INSERT INTO recipe_ingredients
        (recipe_version_id, ingredient_item_id, quantity, unit, wastage_percent, yield_percent,
         preparation_loss_percent, cost_method, is_optional, substitute_for_ingredient_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [recipeVersionId, ing.ingredientItemId, ing.quantity, ing.unit || null,
       ing.wastagePercent || 0, ing.yieldPercent ?? 100, ing.preparationLossPercent || 0,
       ing.costMethod || "AVERAGE", !!ing.isOptional, ing.substituteForIngredientId || null]
    );
  }
}

// POST /api/recipes - إنشاء وصفة جديدة + أول نسخة DRAFT بيها
// {recipeType: 'sellable_variant'|'manufactured_item', variantId?, inventoryItemId?,
//  yieldQuantity, yieldUnit, preparationLossPercent?, cookingLossPercent?, notes?,
//  ingredients: [{ingredientItemId, quantity, unit?, wastagePercent?, yieldPercent?, preparationLossPercent?, costMethod?, isOptional?, substituteForIngredientId?}]}
router.post("/", requireAuth, requirePermission("recipes.create"), async (req, res) => {
  const {
    recipeType, variantId, inventoryItemId, yieldQuantity = 1, yieldUnit,
    preparationLossPercent = 0, cookingLossPercent = 0, notes, ingredients,
  } = req.body;
  if (!["sellable_variant", "manufactured_item"].includes(recipeType)) {
    return res.status(400).json({ error: "نوع الوصفة غير معروف" });
  }
  if (recipeType === "sellable_variant" && !variantId) return res.status(400).json({ error: "لازم تحدد الحجم/الصنف المباع" });
  if (recipeType === "manufactured_item" && !inventoryItemId) return res.status(400).json({ error: "لازم تحدد الصنف المصنّع الناتج" });
  if (!Array.isArray(ingredients) || ingredients.length === 0) return res.status(400).json({ error: "لازم مكوّن واحد على الأقل" });
  if (recipeType === "manufactured_item" && ingredients.some((i) => Number(i.ingredientItemId) === Number(inventoryItemId))) {
    return res.status(400).json({ error: "الصنف الناتج مينفعش يكون مكوّن في وصفته هو نفسه" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const recipeResult = await client.query(
      `INSERT INTO recipes (recipe_type, variant_id, inventory_item_id) VALUES ($1,$2,$3) RETURNING *`,
      [recipeType, recipeType === "sellable_variant" ? variantId : null, recipeType === "manufactured_item" ? inventoryItemId : null]
    );
    const recipe = recipeResult.rows[0];

    const versionResult = await client.query(
      `INSERT INTO recipe_versions
        (recipe_id, version_number, status, yield_quantity, yield_unit, preparation_loss_percent, cooking_loss_percent, notes, created_by)
       VALUES ($1,1,'DRAFT',$2,$3,$4,$5,$6,$7) RETURNING *`,
      [recipe.id, yieldQuantity, yieldUnit || null, preparationLossPercent, cookingLossPercent, notes || null, req.user.id]
    );
    const version = versionResult.rows[0];
    await insertIngredients(client, version.id, ingredients);

    await logAudit(client, {
      userId: req.user.id, action: "RECIPE_CREATED", entityType: "recipe_version", entityId: version.id,
      newValues: { recipeType, variantId, inventoryItemId, ingredients }, req,
    });

    await client.query("COMMIT");
    res.status(201).json({ recipe, version });
  } catch (err) {
    await client.query("ROLLBACK");
    if (err.code === "23505") return res.status(409).json({ error: "الوصفة دي موجودة بالفعل لنفس الصنف" });
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// POST /api/recipes/:recipeId/versions - نسخة جديدة DRAFT لوصفة موجودة (تعديل حقيقي = نسخة جديدة، مش تعديل نسخة قديمة)
router.post("/:recipeId/versions", requireAuth, requirePermission("recipes.create", "recipes.edit"), async (req, res) => {
  const { yieldQuantity = 1, yieldUnit, preparationLossPercent = 0, cookingLossPercent = 0, notes, ingredients } = req.body;
  if (!Array.isArray(ingredients) || ingredients.length === 0) return res.status(400).json({ error: "لازم مكوّن واحد على الأقل" });

  const client = await pool.connect();
  try {
    const recipeRes = await client.query("SELECT * FROM recipes WHERE id = $1", [req.params.recipeId]);
    if (recipeRes.rows.length === 0) return res.status(404).json({ error: "الوصفة مش موجودة" });
    const recipe = recipeRes.rows[0];
    if (recipe.recipe_type === "manufactured_item" && ingredients.some((i) => Number(i.ingredientItemId) === Number(recipe.inventory_item_id))) {
      return res.status(400).json({ error: "الصنف الناتج مينفعش يكون مكوّن في وصفته هو نفسه" });
    }

    await client.query("BEGIN");
    const maxVersion = await client.query("SELECT COALESCE(MAX(version_number),0) AS max FROM recipe_versions WHERE recipe_id = $1", [recipe.id]);
    const nextVersionNumber = Number(maxVersion.rows[0].max) + 1;

    const versionResult = await client.query(
      `INSERT INTO recipe_versions
        (recipe_id, version_number, status, yield_quantity, yield_unit, preparation_loss_percent, cooking_loss_percent, notes, created_by)
       VALUES ($1,$2,'DRAFT',$3,$4,$5,$6,$7,$8) RETURNING *`,
      [recipe.id, nextVersionNumber, yieldQuantity, yieldUnit || null, preparationLossPercent, cookingLossPercent, notes || null, req.user.id]
    );
    const version = versionResult.rows[0];
    await insertIngredients(client, version.id, ingredients);

    await logAudit(client, {
      userId: req.user.id, action: "RECIPE_VERSION_CREATED", entityType: "recipe_version", entityId: version.id,
      metadata: { recipeId: recipe.id, versionNumber: nextVersionNumber }, newValues: { ingredients }, req,
    });

    await client.query("COMMIT");
    res.status(201).json(version);
  } catch (err) {
    await client.query("ROLLBACK");
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// PATCH /api/recipes/versions/:versionId - تعديل نسخة لسه DRAFT أو REJECTED بس (نسخة اتستخدمت فعليًا
// (APPROVED/ACTIVE/ARCHIVED) غير قابلة للتعديل إطلاقًا - أي تغيير حقيقي لازم نسخة جديدة)
router.patch("/versions/:versionId", requireAuth, requirePermission("recipes.edit"), async (req, res) => {
  const { yieldQuantity, yieldUnit, preparationLossPercent, cookingLossPercent, notes, ingredients } = req.body;
  const client = await pool.connect();
  try {
    const versionRes = await client.query("SELECT * FROM recipe_versions WHERE id = $1", [req.params.versionId]);
    if (versionRes.rows.length === 0) return res.status(404).json({ error: "نسخة الوصفة مش موجودة" });
    const before = versionRes.rows[0];
    if (!EDITABLE_STATUSES.includes(before.status)) {
      return res.status(400).json({ error: "النسخة دي اتستخدمت بالفعل (مش DRAFT/REJECTED) - غير قابلة للتعديل، اعمل نسخة جديدة" });
    }

    const fields = [];
    const values = [];
    let i = 1;
    if (yieldQuantity !== undefined) { fields.push(`yield_quantity = $${i++}`); values.push(yieldQuantity); }
    if (yieldUnit !== undefined) { fields.push(`yield_unit = $${i++}`); values.push(yieldUnit); }
    if (preparationLossPercent !== undefined) { fields.push(`preparation_loss_percent = $${i++}`); values.push(preparationLossPercent); }
    if (cookingLossPercent !== undefined) { fields.push(`cooking_loss_percent = $${i++}`); values.push(cookingLossPercent); }
    if (notes !== undefined) { fields.push(`notes = $${i++}`); values.push(notes); }
    fields.push(`updated_at = now()`);

    await client.query("BEGIN");
    if (fields.length > 0) {
      values.push(req.params.versionId);
      await client.query(`UPDATE recipe_versions SET ${fields.join(", ")} WHERE id = $${i}`, values);
    }
    if (Array.isArray(ingredients)) {
      await client.query("DELETE FROM recipe_ingredients WHERE recipe_version_id = $1", [req.params.versionId]);
      await insertIngredients(client, req.params.versionId, ingredients);
    }
    await logAudit(client, {
      userId: req.user.id, action: "RECIPE_EDITED", entityType: "recipe_version", entityId: Number(req.params.versionId),
      oldValues: before, newValues: req.body, req,
    });
    await client.query("COMMIT");
    const updated = await pool.query("SELECT * FROM recipe_versions WHERE id = $1", [req.params.versionId]);
    res.json(updated.rows[0]);
  } catch (err) {
    await client.query("ROLLBACK");
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// POST /api/recipes/versions/:versionId/submit - DRAFT/REJECTED → PENDING_APPROVAL
router.post("/versions/:versionId/submit", requireAuth, requirePermission("recipes.submit"), async (req, res) => {
  try {
    const versionRes = await pool.query("SELECT * FROM recipe_versions WHERE id = $1", [req.params.versionId]);
    if (versionRes.rows.length === 0) return res.status(404).json({ error: "نسخة الوصفة مش موجودة" });
    if (!EDITABLE_STATUSES.includes(versionRes.rows[0].status)) {
      return res.status(400).json({ error: "النسخة دي مش في حالة قابلة للتقديم للاعتماد" });
    }
    const result = await pool.query(
      `UPDATE recipe_versions SET status = 'PENDING_APPROVAL', submitted_at = now(), updated_at = now() WHERE id = $1 RETURNING *`,
      [req.params.versionId]
    );
    await logAudit(pool, {
      userId: req.user.id, action: "RECIPE_SUBMITTED", entityType: "recipe_version", entityId: Number(req.params.versionId), req,
    });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/recipes/versions/:versionId/approve - PENDING_APPROVAL → APPROVED (أدمن بس)
router.post("/versions/:versionId/approve", requireAuth, requireRole("admin"), requirePermission("recipes.approve"), async (req, res) => {
  try {
    const versionRes = await pool.query("SELECT * FROM recipe_versions WHERE id = $1", [req.params.versionId]);
    if (versionRes.rows.length === 0) return res.status(404).json({ error: "نسخة الوصفة مش موجودة" });
    if (versionRes.rows[0].status !== "PENDING_APPROVAL") return res.status(400).json({ error: "النسخة دي مش في انتظار اعتماد" });
    const result = await pool.query(
      `UPDATE recipe_versions SET status = 'APPROVED', approved_by = $1, approved_at = now(), updated_at = now() WHERE id = $2 RETURNING *`,
      [req.user.id, req.params.versionId]
    );
    await logAudit(pool, {
      userId: req.user.id, action: "RECIPE_APPROVED", entityType: "recipe_version", entityId: Number(req.params.versionId), req,
    });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/recipes/versions/:versionId/reject - PENDING_APPROVAL → REJECTED (أدمن بس) - {rejectionReason}
router.post("/versions/:versionId/reject", requireAuth, requireRole("admin"), requirePermission("recipes.approve"), async (req, res) => {
  const { rejectionReason } = req.body;
  if (!rejectionReason) return res.status(400).json({ error: "لازم سبب الرفض" });
  try {
    const versionRes = await pool.query("SELECT * FROM recipe_versions WHERE id = $1", [req.params.versionId]);
    if (versionRes.rows.length === 0) return res.status(404).json({ error: "نسخة الوصفة مش موجودة" });
    if (versionRes.rows[0].status !== "PENDING_APPROVAL") return res.status(400).json({ error: "النسخة دي مش في انتظار اعتماد" });
    const result = await pool.query(
      `UPDATE recipe_versions SET status = 'REJECTED', rejected_by = $1, rejection_reason = $2, updated_at = now() WHERE id = $3 RETURNING *`,
      [req.user.id, rejectionReason, req.params.versionId]
    );
    await logAudit(pool, {
      userId: req.user.id, action: "RECIPE_REJECTED", entityType: "recipe_version", entityId: Number(req.params.versionId),
      metadata: { rejectionReason }, req,
    });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/recipes/versions/:versionId/activate - APPROVED → ACTIVE (أدمن بس) - بيؤرشف النسخة النشطة
// القديمة تلقائيًا (لو موجودة)، بيتأكد الأول إن مفيش دورة (Recipe A → B → A) ولا وحدة ناقصة تحويلها،
// وبعدين بيسقط النسخة الجديدة على الجدول المسطّح القديم عشان البيع/التصنيع الحالي يقراها فورًا
router.post("/versions/:versionId/activate", requireAuth, requireRole("admin"), requirePermission("recipes.activate"), async (req, res) => {
  const client = await pool.connect();
  try {
    const versionRes = await client.query("SELECT * FROM recipe_versions WHERE id = $1", [req.params.versionId]);
    if (versionRes.rows.length === 0) return res.status(404).json({ error: "نسخة الوصفة مش موجودة" });
    const version = versionRes.rows[0];
    if (version.status !== "APPROVED") return res.status(400).json({ error: "النسخة دي لازم تتاعتمد الأول قبل التفعيل" });

    try {
      await explodeRecipeConsumption(client, version.id, 1, new Set());
    } catch (err) {
      if (err.code === "CIRCULAR_RECIPE" || err.code === "NO_UNIT_CONVERSION") {
        return res.status(400).json({ error: `الوصفة دي فيها مشكلة تمنع التفعيل: ${err.message}` });
      }
      throw err;
    }

    await client.query("BEGIN");
    const previousActive = await client.query(
      "SELECT * FROM recipe_versions WHERE recipe_id = $1 AND status = 'ACTIVE'", [version.recipe_id]
    );
    if (previousActive.rows.length > 0) {
      await client.query(
        `UPDATE recipe_versions SET status = 'ARCHIVED', archived_at = now(), effective_to = now(), updated_at = now() WHERE id = $1`,
        [previousActive.rows[0].id]
      );
      await logAudit(client, {
        userId: req.user.id, action: "RECIPE_ARCHIVED", entityType: "recipe_version", entityId: previousActive.rows[0].id,
        metadata: { supersededBy: version.id }, req,
      });
    }

    const updated = await client.query(
      `UPDATE recipe_versions SET status = 'ACTIVE', activated_at = now(), effective_from = now(), updated_at = now() WHERE id = $1 RETURNING *`,
      [version.id]
    );
    await projectVersionToLegacyTable(client, version.id);

    await logAudit(client, {
      userId: req.user.id, action: "RECIPE_ACTIVATED", entityType: "recipe_version", entityId: version.id, req,
    });

    await client.query("COMMIT");
    res.json(updated.rows[0]);
  } catch (err) {
    await client.query("ROLLBACK");
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// POST /api/recipes/versions/:versionId/archive - أرشفة يدوية لنسخة ACTIVE (من غير ما نفعّل بديل - مثلًا
// وقف صنف من المنيو خالص) - أدمن بس
router.post("/versions/:versionId/archive", requireAuth, requireRole("admin"), requirePermission("recipes.archive"), async (req, res) => {
  try {
    const versionRes = await pool.query("SELECT * FROM recipe_versions WHERE id = $1", [req.params.versionId]);
    if (versionRes.rows.length === 0) return res.status(404).json({ error: "نسخة الوصفة مش موجودة" });
    if (versionRes.rows[0].status !== "ACTIVE") return res.status(400).json({ error: "النسخة دي مش نشطة أصلًا" });
    const result = await pool.query(
      `UPDATE recipe_versions SET status = 'ARCHIVED', archived_at = now(), effective_to = now(), updated_at = now() WHERE id = $1 RETURNING *`,
      [req.params.versionId]
    );
    await logAudit(pool, {
      userId: req.user.id, action: "RECIPE_ARCHIVED", entityType: "recipe_version", entityId: Number(req.params.versionId), req,
    });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/recipes - كل الوصفات مع ملخص نسختها النشطة
router.get("/", requireAuth, requirePermission("recipes.view"), async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT r.*, mi.name AS item_name, v.label AS variant_label, ii.name AS inventory_item_name,
              av.id AS active_version_id, av.version_number AS active_version_number
       FROM recipes r
       LEFT JOIN menu_item_variants v ON v.id = r.variant_id
       LEFT JOIN menu_items mi ON mi.id = v.item_id
       LEFT JOIN inventory_items ii ON ii.id = r.inventory_item_id
       LEFT JOIN recipe_versions av ON av.recipe_id = r.id AND av.status = 'ACTIVE'
       ORDER BY r.id DESC`
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/recipes/:id - وصفة + كل نسخها
router.get("/:id", requireAuth, requirePermission("recipes.view"), async (req, res) => {
  try {
    const recipe = await pool.query("SELECT * FROM recipes WHERE id = $1", [req.params.id]);
    if (recipe.rows.length === 0) return res.status(404).json({ error: "الوصفة مش موجودة" });
    const versions = await pool.query(
      `SELECT rv.*, u1.name AS created_by_name, u2.name AS approved_by_name
       FROM recipe_versions rv
       LEFT JOIN users u1 ON u1.id = rv.created_by
       LEFT JOIN users u2 ON u2.id = rv.approved_by
       WHERE rv.recipe_id = $1 ORDER BY rv.version_number DESC`,
      [req.params.id]
    );
    res.json({ recipe: recipe.rows[0], versions: versions.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/recipes/versions/:versionId - نسخة واحدة بالتفصيل (مكونات + تكلفة نظرية محسوبة)
router.get("/versions/:versionId", requireAuth, requirePermission("recipes.view"), async (req, res) => {
  try {
    const detail = await getRecipeVersionDetail(pool, req.params.versionId);
    if (!detail) return res.status(404).json({ error: "نسخة الوصفة مش موجودة" });
    res.json(detail);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/recipes/usage/:itemId - المرحلة 8.29 (شاشة الأصناف): كل الوصفات النشطة اللي بتستخدم الصنف
// ده كمكوّن (مادة خام أو صنف مصنّع) - "يستخدم في"
router.get("/usage/:itemId", requireAuth, requirePermission("recipes.view"), async (req, res) => {
  try {
    const usage = await getIngredientUsage(pool, req.params.itemId);
    res.json(usage);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/recipes/versions/:versionId/impact - مقارنة تكلفة النسخة دي بالنسخة النشطة الحالية لنفس
// الوصفة (قبل التفعيل - يساعد في قرار تسعير المنيو)
router.get("/versions/:versionId/impact", requireAuth, requirePermission("recipes.view"), async (req, res) => {
  try {
    const version = await pool.query("SELECT * FROM recipe_versions WHERE id = $1", [req.params.versionId]);
    if (version.rows.length === 0) return res.status(404).json({ error: "نسخة الوصفة مش موجودة" });
    const activeVersion = await pool.query(
      "SELECT * FROM recipe_versions WHERE recipe_id = $1 AND status = 'ACTIVE'", [version.rows[0].recipe_id]
    );
    const newCost = await computeRecipeCost(pool, req.params.versionId, 1);
    let oldCost = null;
    if (activeVersion.rows.length > 0) {
      oldCost = await computeRecipeCost(pool, activeVersion.rows[0].id, 1);
    }
    const oldTotal = oldCost ? oldCost.totalCost : null;
    const difference = oldTotal != null ? newCost.totalCost - oldTotal : null;
    const differencePercent = oldTotal ? (difference / oldTotal) * 100 : null;
    res.json({
      oldVersionId: activeVersion.rows[0]?.id || null, oldCost: oldTotal,
      newVersionId: Number(req.params.versionId), newCost: newCost.totalCost,
      difference, differencePercent, incomplete: newCost.incomplete || (oldCost && oldCost.incomplete),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
