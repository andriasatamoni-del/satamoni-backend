// محرك الوصفات: حساب الاستهلاك الفعلي (النظري) لكل مكوّن، بما فيه الانفجار عبر الوصفات الفرعية
// (sub-recipes) لحد ما يوصل لمكونات خام بس، مع منع أي دورة (Recipe A → B → A).
const { convertQuantity } = require("./unit-conversion");

// الكمية الفعلية من مكوّن واحد لكل وحدة ناتج (بعد احتساب الهالك/نسبة الاستفادة/فقد التحضير على مستوى
// المكوّن نفسه، وفقد التحضير/الطهي على مستوى الوصفة كاملة، مقسومة على كمية الإنتاج (yield) للوصفة)
function effectiveQuantityPerUnit(ingredient, recipeVersion) {
  const qty = Number(ingredient.quantity);
  const yieldFactor = Number(ingredient.yield_percent) > 0 ? Number(ingredient.yield_percent) / 100 : 1;
  const wastageFactor = 1 + Number(ingredient.wastage_percent) / 100;
  const ingredientPrepLossFactor = 1 + Number(ingredient.preparation_loss_percent) / 100;
  const rawNeeded = (qty / yieldFactor) * wastageFactor * ingredientPrepLossFactor;

  const recipeYield = Number(recipeVersion.yield_quantity) > 0 ? Number(recipeVersion.yield_quantity) : 1;
  const recipePrepLossFactor = 1 + Number(recipeVersion.preparation_loss_percent) / 100;
  const recipeCookingLossFactor = 1 + Number(recipeVersion.cooking_loss_percent) / 100;

  return (rawNeeded / recipeYield) * recipePrepLossFactor * recipeCookingLossFactor;
}

// بيرجع {raw: Map(inventoryItemId -> {quantity, unit}), incomplete: bool} - raw فيها مكونات خام بس
// (بعد ما أي مكوّن مصنّع له وصفة نشطة اتفكّ لمكوناته هو كمان، متكرر لحد ما يوصل لخام). incomplete=true
// لو أي مكوّن مصنّع في السلسلة معندوش وصفة نشطة (مينفعش نفكّه، بنعامله كخام بالغلط - تنبيه في الاستهلاك)
//
// المرحلة 3.1: versionCache اختياري (Map) - نسخة وصفة اتستخدمت فعليًا (APPROVED/ACTIVE/ARCHIVED) غير
// قابلة للتعديل إطلاقًا، يعني فكّها لمكوناته الخام بالنسبة لوحدة واحدة ثابت للأبد ومينفعش يتغيّر - الفك
// خطي تمامًا في quantityProduced (كل حساباته ضرب/قسمة بس)، فبدل ما تقارير كتير تنادي عليه لكل أوردر/أمر
// تصنيع لوحده (N+1 حقيقي)، نخزن نتيجة "لكل وحدة واحدة" مرة واحدة لكل نسخة ونضربها في أي كمية مطلوبة -
// من غير ما نلمس أي كولر قديم (كل الكولرز الحاليين بيمرروا null، يعني سلوكهم زي ما هو بالظبط)
async function explodeRecipeConsumption(client, recipeVersionId, quantityProduced, visitedRecipeIds = new Set(), versionCache = null) {
  if (versionCache && versionCache.has(recipeVersionId)) {
    const cached = versionCache.get(recipeVersionId);
    if (visitedRecipeIds.has(cached.recipeId)) {
      const err = new Error("الوصفة دي بترجع لنفسها في السلسلة (Recipe A → B → A) - دورة ممنوعة");
      err.code = "CIRCULAR_RECIPE";
      throw err;
    }
    const raw = new Map();
    for (const [itemId, data] of cached.rawPerUnit) {
      raw.set(itemId, { quantity: data.quantity * Number(quantityProduced), unit: data.unit });
    }
    return { raw, incomplete: cached.incomplete };
  }

  const versionRes = await client.query("SELECT * FROM recipe_versions WHERE id = $1", [recipeVersionId]);
  if (versionRes.rows.length === 0) throw new Error("نسخة الوصفة مش موجودة");
  const recipeVersion = versionRes.rows[0];

  if (visitedRecipeIds.has(recipeVersion.recipe_id)) {
    const err = new Error("الوصفة دي بترجع لنفسها في السلسلة (Recipe A → B → A) - دورة ممنوعة");
    err.code = "CIRCULAR_RECIPE";
    throw err;
  }
  const nextVisited = new Set(visitedRecipeIds);
  nextVisited.add(recipeVersion.recipe_id);

  const ingredientsRes = await client.query(
    `SELECT ri.*, ii.item_type, ii.unit AS item_unit
     FROM recipe_ingredients ri
     JOIN inventory_items ii ON ii.id = ri.ingredient_item_id
     WHERE ri.recipe_version_id = $1`,
    [recipeVersionId]
  );

  const raw = new Map();
  let incomplete = false;

  for (const ing of ingredientsRes.rows) {
    const perUnit = effectiveQuantityPerUnit(ing, recipeVersion);
    const totalInIngredientUnit = perUnit * Number(quantityProduced);
    const totalInStockUnit = await convertQuantity(client, totalInIngredientUnit, ing.unit || ing.item_unit, ing.item_unit);

    let subActiveVersionId = null;
    if (ing.item_type === "manufactured") {
      const subRecipe = await client.query(
        `SELECT rv.id FROM recipes r JOIN recipe_versions rv ON rv.recipe_id = r.id
         WHERE r.inventory_item_id = $1 AND r.recipe_type = 'manufactured_item' AND rv.status = 'ACTIVE'`,
        [ing.ingredient_item_id]
      );
      if (subRecipe.rows.length > 0) subActiveVersionId = subRecipe.rows[0].id;
    }

    if (subActiveVersionId) {
      const sub = await explodeRecipeConsumption(client, subActiveVersionId, totalInStockUnit, nextVisited, versionCache);
      if (sub.incomplete) incomplete = true;
      for (const [itemId, data] of sub.raw) {
        const existing = raw.get(itemId);
        raw.set(itemId, { quantity: (existing?.quantity || 0) + data.quantity, unit: data.unit });
      }
    } else {
      if (ing.item_type === "manufactured") incomplete = true; // مصنّع بلا وصفة نشطة - بيتعامل كخام بالغلط
      const existing = raw.get(ing.ingredient_item_id);
      raw.set(ing.ingredient_item_id, { quantity: (existing?.quantity || 0) + totalInStockUnit, unit: ing.item_unit });
    }
  }

  if (versionCache && Number(quantityProduced) > 0) {
    const rawPerUnit = new Map();
    for (const [itemId, data] of raw) {
      rawPerUnit.set(itemId, { quantity: data.quantity / Number(quantityProduced), unit: data.unit });
    }
    versionCache.set(recipeVersionId, { recipeId: recipeVersion.recipe_id, rawPerUnit, incomplete });
  }

  return { raw, incomplete };
}

// تكلفة نظرية لوحدة واحدة من ناتج الوصفة (أو أي كمية) - بتستخدم unit_cost الحالي (مش تاريخي؛ التكلفة
// التاريخية الحقيقية محفوظة في order_items.cost_at_sale وقت البيع نفسه، الدالة دي لتسعير/معاينة مستقبلية)
async function computeRecipeCost(client, recipeVersionId, quantity = 1) {
  const { raw, incomplete } = await explodeRecipeConsumption(client, recipeVersionId, quantity, new Set());
  const itemIds = [...raw.keys()];
  if (itemIds.length === 0) return { totalCost: 0, incomplete };
  const costs = await client.query("SELECT id, unit_cost FROM inventory_items WHERE id = ANY($1)", [itemIds]);
  const costByItem = new Map(costs.rows.map((r) => [r.id, r.unit_cost != null ? Number(r.unit_cost) : null]));
  let totalCost = 0;
  let costIncomplete = incomplete;
  for (const [itemId, data] of raw) {
    const cost = costByItem.get(itemId);
    if (cost == null) { costIncomplete = true; continue; }
    totalCost += cost * data.quantity;
  }
  return { totalCost, incomplete: costIncomplete, raw };
}

// وقت تفعيل نسخة وصفة جديدة، بنكتب استهلاكها الفعّال (لكل وحدة مباعة/منتجة) في الجدول المسطّح القديم
// (menu_item_variant_ingredients أو manufacturing_recipe_items) - عشان خصم المخزون وقت البيع
// (routes/orders.js) وتصنيع /api/inventory/produce يفضلوا شغالين زي ما هم بالظبط من غير أي تعديل،
// وبيقروا آخر نسخة معتمدة تلقائيًا. ملحوظة: الإسقاط ده بيكتب الوصفة "مسطّحة" (بعد فك أي sub-recipe)
// عشان الجداول القديمة أصلًا مصممة لمكونات خام مباشرة بس
async function projectVersionToLegacyTable(client, recipeVersionId) {
  const versionRes = await client.query(
    `SELECT rv.*, r.recipe_type, r.variant_id, r.inventory_item_id AS recipe_output_item_id
     FROM recipe_versions rv JOIN recipes r ON r.id = rv.recipe_id
     WHERE rv.id = $1`,
    [recipeVersionId]
  );
  if (versionRes.rows.length === 0) throw new Error("نسخة الوصفة مش موجودة");
  const version = versionRes.rows[0];

  const { raw } = await explodeRecipeConsumption(client, recipeVersionId, 1, new Set());

  if (version.recipe_type === "sellable_variant") {
    await client.query("DELETE FROM menu_item_variant_ingredients WHERE variant_id = $1", [version.variant_id]);
    for (const [itemId, data] of raw) {
      await client.query(
        `INSERT INTO menu_item_variant_ingredients (variant_id, inventory_item_id, quantity_per_unit)
         VALUES ($1, $2, $3)
         ON CONFLICT (variant_id, inventory_item_id) DO UPDATE SET quantity_per_unit = menu_item_variant_ingredients.quantity_per_unit + $3`,
        [version.variant_id, itemId, data.quantity]
      );
    }
  } else {
    await client.query("DELETE FROM manufacturing_recipe_items WHERE output_item_id = $1", [version.recipe_output_item_id]);
    for (const [itemId, data] of raw) {
      if (itemId === version.recipe_output_item_id) continue; // أمان إضافي - مايكتبش الناتج كمكوّن لنفسه
      await client.query(
        `INSERT INTO manufacturing_recipe_items (output_item_id, input_item_id, quantity_per_unit)
         VALUES ($1, $2, $3)
         ON CONFLICT (output_item_id, input_item_id) DO UPDATE SET quantity_per_unit = manufacturing_recipe_items.quantity_per_unit + $3`,
        [version.recipe_output_item_id, itemId, data.quantity]
      );
    }
  }
}

// المرحلة 8.29 (شاشة الأصناف): نسخة وصفة بالتفصيل - مكوناتها المباشرة (مش مفكوكة) + تكلفة كل سطر (كمية
// × unit_cost الحالي للمكوّن نفسه) + التكلفة الإجمالية النظرية (من computeRecipeCost، بتاخد في الاعتبار
// أي وصفات فرعية متداخلة صح). مستخرجة من منطق GET /api/recipes/versions/:versionId الأصلي بالظبط -
// نفس الاستعلام والحساب، من غير أي تكرار لمنطق التسعير - بس بقت دالة قابلة لإعادة الاستخدام من شاشات تانية
// (زي شاشة الأصناف) بدل ما تتكرر
async function getRecipeVersionDetail(client, recipeVersionId) {
  const version = await client.query("SELECT * FROM recipe_versions WHERE id = $1", [recipeVersionId]);
  if (version.rows.length === 0) return null;
  const ingredients = await client.query(
    `SELECT ri.*, ii.name AS item_name, ii.unit AS item_unit, ii.item_type, ii.unit_cost
     FROM recipe_ingredients ri JOIN inventory_items ii ON ii.id = ri.ingredient_item_id
     WHERE ri.recipe_version_id = $1`,
    [recipeVersionId]
  );
  let cost = null;
  try {
    cost = await computeRecipeCost(client, recipeVersionId, 1);
  } catch (e) { /* لو فيه مشكلة تحويل وحدات، رجّع النسخة من غيرها بس */ }
  const ingredientsWithLineCost = ingredients.rows.map((ing) => ({
    ...ing,
    line_cost: ing.unit_cost != null ? Number(ing.unit_cost) * Number(ing.quantity) : null,
  }));
  return {
    version: version.rows[0],
    ingredients: ingredientsWithLineCost,
    cost: cost ? { totalCost: cost.totalCost, incomplete: cost.incomplete } : null,
  };
}

// المرحلة 8.29: الوصفة النشطة (لو موجودة) لصنف مباع (variantId) أو صنف مصنّع (inventoryItemId) - بيرجّع
// {recipeId, versionId, versionNumber} أو null. استعلام مباشر على recipes/recipe_versions، مفيش أي
// حساب أو فك وصفة هنا خالص
async function getActiveRecipeForConsumer(client, { variantId, inventoryItemId }) {
  const column = variantId ? "variant_id" : "inventory_item_id";
  const value = variantId || inventoryItemId;
  if (!value) return null;
  const result = await client.query(
    `SELECT r.id AS recipe_id, rv.id AS version_id, rv.version_number
     FROM recipes r JOIN recipe_versions rv ON rv.recipe_id = r.id
     WHERE r.${column} = $1 AND rv.status = 'ACTIVE'`,
    [value]
  );
  return result.rows[0] || null;
}

// المرحلة 8.29 (مُصلَّحة): كل الأماكن اللي المكوّن ده مستخدم فيها - "يستخدم في" لشاشة الأصناف. لأصناف
// المنيو (sellable_variant) بنقرا من menu_item_variant_ingredients **مباشرة** - ده الجدول اللي orders.js
// فعليًا بيحسب منه cost_at_sale الحقيقية وقت البيع (مش recipe_ingredients/recipe_versions، اللي
// لأصناف المنيو مجرد رابط تتبّع تاريخي اختياري منفصل تمامًا عن التكلفة - راجع routes/orders.js حوالين
// "المرحلة 3: تسجيل نسخة الوصفة اللي كانت ACTIVE وقت البيع"). لو اعتمدنا على recipe_versions هنا زي
// قبل كده، أي صنف منيو اتضافت وصفته من شاشة المنيو القديمة (PUT /api/inventory/recipe/:variantId) من
// غير ما يمر بمحرك الوصفات هيفضل مش ظاهر هنا رغم إن له وصفة وتكلفة حقيقية شغالة فعليًا وقت البيع.
// للأصناف المصنّعة (manufactured_item) recipe_versions لسه المصدر الصح (production.js بيتطلبها فعليًا).
async function getIngredientUsage(client, ingredientItemId) {
  const result = await client.query(
    `SELECT 'sellable_variant' AS recipe_type, NULL::int AS recipe_id, NULL::int AS version_id, NULL::int AS version_number,
            mvi.quantity_per_unit AS quantity, NULL::text AS unit,
            v.id AS variant_id, v.label AS variant_label, mi.id AS menu_item_id, mi.name AS menu_item_name,
            NULL::int AS manufactured_item_id, NULL::text AS manufactured_item_name
     FROM menu_item_variant_ingredients mvi
     JOIN menu_item_variants v ON v.id = mvi.variant_id
     JOIN menu_items mi ON mi.id = v.item_id
     WHERE mvi.inventory_item_id = $1
     UNION ALL
     SELECT r.recipe_type, r.id AS recipe_id, rv.id AS version_id, rv.version_number,
            ri.quantity, ri.unit,
            NULL::int AS variant_id, NULL::text AS variant_label, NULL::int AS menu_item_id, NULL::text AS menu_item_name,
            ii2.id AS manufactured_item_id, ii2.name AS manufactured_item_name
     FROM recipe_ingredients ri
     JOIN recipe_versions rv ON rv.id = ri.recipe_version_id AND rv.status = 'ACTIVE'
     JOIN recipes r ON r.id = rv.recipe_id AND r.recipe_type = 'manufactured_item'
     JOIN inventory_items ii2 ON ii2.id = r.inventory_item_id
     WHERE ri.ingredient_item_id = $1
     ORDER BY menu_item_name, manufactured_item_name`,
    [ingredientItemId]
  );
  return result.rows;
}

module.exports = {
  effectiveQuantityPerUnit, explodeRecipeConsumption, computeRecipeCost, projectVersionToLegacyTable,
  getRecipeVersionDetail, getActiveRecipeForConsumer, getIngredientUsage,
};
