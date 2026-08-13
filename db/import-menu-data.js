// استيراد المنيو والريسبي من ملف JSON (اتعمل export له من شيت تكلفة المنيو بتاع ساتاموني).
// آمن تشغيله أكتر من مرة (upsert بالاسم) - أي تعديل يتحصل في db/seed-data/satamoni-menu.json
// وتشغّل السكريبت تاني هيحدّث الأسعار/التكاليف/الريسبي عشان يبقوا مطابقين للملف بالظبط.
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const pool = require("./pool");

const DATA_FILE = process.argv[2] || path.join(__dirname, "seed-data", "satamoni-menu.json");

async function main() {
  const data = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // ---- المكونات ----
    const ingredientIds = new Map();
    for (const ing of data.ingredients) {
      const result = await client.query(
        `INSERT INTO inventory_items (name, unit, unit_cost)
         VALUES ($1, $2, $3)
         ON CONFLICT (name) DO UPDATE SET unit = EXCLUDED.unit, unit_cost = EXCLUDED.unit_cost
         RETURNING id`,
        [ing.name, ing.unit, ing.unitCost]
      );
      ingredientIds.set(ing.name, result.rows[0].id);
    }
    console.log(`المكونات: ${ingredientIds.size}`);

    // ---- الأقسام ----
    const categoryIds = new Map();
    for (const catName of data.categories) {
      const result = await client.query(
        `INSERT INTO menu_categories (name) VALUES ($1)
         ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
         RETURNING id`,
        [catName]
      );
      categoryIds.set(catName, result.rows[0].id);
    }
    console.log(`الأقسام: ${categoryIds.size}`);

    // ---- الأصناف + الأحجام + الريسبي ----
    let itemCount = 0;
    let variantCount = 0;
    let recipeLineCount = 0;
    let skippedIngredients = new Set();

    for (const item of data.items) {
      const categoryId = categoryIds.get(item.category);
      if (!categoryId) {
        console.log(`  تخطيت الصنف "${item.name}" - قسم غير معروف: ${item.category}`);
        continue;
      }

      const itemResult = await client.query(
        `INSERT INTO menu_items (category_id, name, description, is_best)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (category_id, name) DO UPDATE SET
           description = EXCLUDED.description, is_best = EXCLUDED.is_best
         RETURNING id`,
        [categoryId, item.name, item.description || null, item.isBest || false]
      );
      const itemId = itemResult.rows[0].id;
      itemCount++;

      for (const variant of item.variants) {
        const variantResult = await client.query(
          `INSERT INTO menu_item_variants (item_id, label, price)
           VALUES ($1, $2, $3)
           ON CONFLICT (item_id, label) DO UPDATE SET price = EXCLUDED.price
           RETURNING id`,
          [itemId, variant.label, variant.price]
        );
        const variantId = variantResult.rows[0].id;
        variantCount++;

        for (const line of item.recipe || []) {
          const ingredientId = ingredientIds.get(line.ingredient);
          if (!ingredientId) {
            skippedIngredients.add(line.ingredient);
            continue;
          }
          await client.query(
            `INSERT INTO menu_item_variant_ingredients (variant_id, inventory_item_id, quantity_per_unit)
             VALUES ($1, $2, $3)
             ON CONFLICT (variant_id, inventory_item_id) DO UPDATE SET quantity_per_unit = EXCLUDED.quantity_per_unit`,
            [variantId, ingredientId, line.quantityPerUnit]
          );
          recipeLineCount++;
        }
      }
    }

    await client.query("COMMIT");
    console.log(`الأصناف: ${itemCount}`);
    console.log(`الأحجام/الأسعار: ${variantCount}`);
    console.log(`سطور الريسبي: ${recipeLineCount}`);
    if (skippedIngredients.size > 0) {
      console.log(`تحذير - مكونات في الريسبي مش موجودة في الكتالوج: ${[...skippedIngredients].join(", ")}`);
    }
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
