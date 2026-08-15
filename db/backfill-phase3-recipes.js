// المرحلة 3 - سكريبت توافق/ترحيل (compatibility migration)، مش تصحيح تلقائي صامت: أي صنف مباع
// (menu_item_variant_ingredients) أو مصنّع (manufacturing_recipe_items) عنده بالفعل وصفة "مسطّحة"
// في الجداول القديمة (من قبل محرك الوصفات نفسه) بياخد وصفة نسخة 1 ACTIVE جديدة في recipes/recipe_versions
// بنفس المكونات بالظبط - عشان يدخل نظام الإصدارات/الاعتماد الجديد من غير ما يتغيّر سلوك خصم المخزون أو
// حساب التكلفة وقت البيع إطلاقًا (لسه بيقرا من نفس الجدول المسطّح، اللي محتواه هنا مش هيتغيّر).
// كمان بيربط (best-effort) order_items.recipe_version_id للطلبات القديمة اللي اتسجلت قبل المرحلة 3 -
// بالنسخة 1 دي بالظبط (تقريب معقول، لأن قبل المرحلة 3 مكانش فيه غير نسخة واحدة فعليًا أصلًا - الجدول
// المسطّح نفسه). ده رابط تتبّع بس - مش بيلمس cost_at_sale المحفوظة وقت البيع، ومينفعش يلمسها.
//
// آمن يتشغّل أكتر من مرة (idempotent): كل إنشاء محروس بـWHERE NOT EXISTS، وربط order_items بـWHERE
// recipe_version_id IS NULL بس. آمن يتشغّل على قاعدة فيها بيانات فعلًا - مفيش أي DELETE ولا تعديل على
// بيانات موجودة غير recipe_version_id (عمود جديد مفيش له قيمة قبل كده أصلًا).
require("dotenv").config();
const pool = require("./pool");

const MIGRATION_NAME = "phase3-recipe-backfill-from-legacy-tables";

async function main() {
  const client = await pool.connect();
  try {
    const already = await client.query("SELECT 1 FROM schema_migrations WHERE name = $1", [MIGRATION_NAME]);
    if (already.rows.length > 0) {
      console.log(`السكريبت ده اتشغّل قبل كده (${MIGRATION_NAME}) - هيتأكد بس من أي صنف جديد اتضاف بعد كده من غير وصفة.`);
    }

    await client.query("BEGIN");

    // ---- 1) أصناف مباعة (sellable_variant) لسه معندهاش recipe ----
    const variantsNeedingRecipe = await client.query(`
      SELECT DISTINCT mvi.variant_id
      FROM menu_item_variant_ingredients mvi
      WHERE NOT EXISTS (SELECT 1 FROM recipes r WHERE r.recipe_type = 'sellable_variant' AND r.variant_id = mvi.variant_id)
    `);
    let variantsBackfilled = 0;
    for (const { variant_id: variantId } of variantsNeedingRecipe.rows) {
      const recipe = await client.query(
        `INSERT INTO recipes (recipe_type, variant_id) VALUES ('sellable_variant', $1) RETURNING id`,
        [variantId]
      );
      const version = await client.query(
        `INSERT INTO recipe_versions
          (recipe_id, version_number, status, yield_quantity, notes, effective_from, activated_at)
         VALUES ($1, 1, 'ACTIVE', 1,
           'مُرحّلة تلقائيًا من menu_item_variant_ingredients (سكريبت توافق المرحلة 3) - لم تمر بدورة اعتماد جديدة',
           now(), now())
         RETURNING id`,
        [recipe.rows[0].id]
      );
      const ingredients = await client.query(
        `SELECT inventory_item_id, quantity_per_unit FROM menu_item_variant_ingredients WHERE variant_id = $1`,
        [variantId]
      );
      for (const ing of ingredients.rows) {
        await client.query(
          `INSERT INTO recipe_ingredients (recipe_version_id, ingredient_item_id, quantity, yield_percent, cost_method)
           VALUES ($1, $2, $3, 100, 'AVERAGE')`,
          [version.rows[0].id, ing.inventory_item_id, ing.quantity_per_unit]
        );
      }
      variantsBackfilled++;
    }

    // ---- 2) أصناف مصنّعة (manufactured_item) لسه معندهاش recipe ----
    const itemsNeedingRecipe = await client.query(`
      SELECT DISTINCT mri.output_item_id
      FROM manufacturing_recipe_items mri
      WHERE NOT EXISTS (SELECT 1 FROM recipes r WHERE r.recipe_type = 'manufactured_item' AND r.inventory_item_id = mri.output_item_id)
    `);
    let manufacturedBackfilled = 0;
    for (const { output_item_id: outputItemId } of itemsNeedingRecipe.rows) {
      const recipe = await client.query(
        `INSERT INTO recipes (recipe_type, inventory_item_id) VALUES ('manufactured_item', $1) RETURNING id`,
        [outputItemId]
      );
      const version = await client.query(
        `INSERT INTO recipe_versions
          (recipe_id, version_number, status, yield_quantity, notes, effective_from, activated_at)
         VALUES ($1, 1, 'ACTIVE', 1,
           'مُرحّلة تلقائيًا من manufacturing_recipe_items (سكريبت توافق المرحلة 3) - لم تمر بدورة اعتماد جديدة',
           now(), now())
         RETURNING id`,
        [recipe.rows[0].id]
      );
      const ingredients = await client.query(
        `SELECT input_item_id, quantity_per_unit FROM manufacturing_recipe_items WHERE output_item_id = $1`,
        [outputItemId]
      );
      for (const ing of ingredients.rows) {
        await client.query(
          `INSERT INTO recipe_ingredients (recipe_version_id, ingredient_item_id, quantity, yield_percent, cost_method)
           VALUES ($1, $2, $3, 100, 'AVERAGE')`,
          [version.rows[0].id, ing.input_item_id, ing.quantity_per_unit]
        );
      }
      manufacturedBackfilled++;
    }

    // ---- 3) ربط order_items.recipe_version_id للطلبات القديمة (best-effort - تقريب معقول، مش إعادة حساب) ----
    const backfillOrderItems = await client.query(`
      UPDATE order_items oi
      SET recipe_version_id = rv.id
      FROM recipes r JOIN recipe_versions rv ON rv.recipe_id = r.id AND rv.status = 'ACTIVE'
      WHERE r.recipe_type = 'sellable_variant' AND r.variant_id = oi.variant_id
        AND oi.variant_id IS NOT NULL AND oi.recipe_version_id IS NULL
      RETURNING oi.id
    `);

    await client.query(
      `INSERT INTO schema_migrations (name) VALUES ($1) ON CONFLICT (name) DO NOTHING`,
      [MIGRATION_NAME]
    );

    await client.query("COMMIT");
    console.log(`تم: ${variantsBackfilled} وصفة صنف مباع، ${manufacturedBackfilled} وصفة صنف مصنّع، ${backfillOrderItems.rows.length} سطر طلب قديم اترابط بنسخة وصفة.`);
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("فشل سكريبت الترحيل:", err);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

main();
