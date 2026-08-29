// استيراد بيانات السنتر كيتشن من db/seed-data/central-kitchen.json (اتعمل export له من
// شيت تحليل التصنيع والموردين بتاع ستاموني): مواد خام جديدة، تحديث نوع الأصناف المصنّعة
// اللي كانت موجودة بالفعل، وصفات التصنيع، والموردين وأسعارهم.
// آمن تشغيله أكتر من مرة (upsert بالاسم).
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const pool = require("./pool");

const DATA_FILE = process.argv[2] || path.join(__dirname, "seed-data", "central-kitchen.json");

async function main() {
  const data = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // ---- المواد الخام ----
    // ملاحظة: لو المكوّن موجود بالفعل، وحدته متتلمسش هنا خالص - عشان متبوظش معنى
    // كميات موجودة بالفعل في ريسبيهات تانية بتفترض الوحدة الحالية. الاستيراد ده بيضيف
    // مكونات جديدة بس، مش بيعدّل وحدة حاجة موجودة (استخدم PATCH /api/inventory/items/:id
    // لو محتاج تصحح وحدة صنف موجود فعلًا).
    const itemIds = new Map();
    for (const raw of data.rawMaterials) {
      const result = await client.query(
        `INSERT INTO inventory_items (name, unit, item_type)
         VALUES ($1, $2, 'raw')
         ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
         RETURNING id`,
        [raw.name, raw.unit]
      );
      itemIds.set(raw.name, result.rows[0].id);
    }
    console.log(`المواد الخام: ${itemIds.size}`);

    // ---- تحديث نوع الأصناف المصنّعة + وصفات التصنيع ----
    let updatedToManufactured = 0;
    let recipeLineCount = 0;
    const skippedIngredients = new Set();

    for (const product of data.manufacturedProducts) {
      const result = await client.query(
        `UPDATE inventory_items SET item_type = 'manufactured' WHERE name = $1 RETURNING id`,
        [product.name]
      );
      if (result.rows.length === 0) {
        console.log(`  تخطيت "${product.name}" - مش موجود في الكتالوج`);
        continue;
      }
      const outputItemId = result.rows[0].id;
      updatedToManufactured++;

      for (const line of product.recipe) {
        const inputItemId = itemIds.get(line.ingredient);
        if (!inputItemId) {
          skippedIngredients.add(line.ingredient);
          continue;
        }
        await client.query(
          `INSERT INTO manufacturing_recipe_items (output_item_id, input_item_id, quantity_per_unit)
           VALUES ($1, $2, $3)
           ON CONFLICT (output_item_id, input_item_id) DO UPDATE SET quantity_per_unit = EXCLUDED.quantity_per_unit`,
          [outputItemId, inputItemId, line.quantityPerUnit]
        );
        recipeLineCount++;
      }
    }
    console.log(`الأصناف اللي اتحدثت لـ"مصنّع": ${updatedToManufactured}`);
    console.log(`سطور وصفات التصنيع: ${recipeLineCount}`);
    if (skippedIngredients.size > 0) {
      console.log(`تحذير - مكونات مش موجودة: ${[...skippedIngredients].join(", ")}`);
    }

    // ---- الموردين وأسعارهم ----
    const supplierIds = new Map();
    for (const name of data.suppliers) {
      const result = await client.query(
        `INSERT INTO suppliers (name) VALUES ($1)
         ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
         RETURNING id`,
        [name]
      );
      supplierIds.set(name, result.rows[0].id);
    }
    console.log(`الموردين: ${supplierIds.size}`);

    let priceLinks = 0;
    for (const link of data.supplierPrices) {
      const itemId = itemIds.get(link.itemName);
      const supplierId = supplierIds.get(link.supplier);
      if (!itemId || !supplierId) continue;
      await client.query(
        `INSERT INTO inventory_item_suppliers (inventory_item_id, supplier_id, unit_price)
         VALUES ($1, $2, $3)
         ON CONFLICT (inventory_item_id, supplier_id) DO UPDATE SET unit_price = EXCLUDED.unit_price`,
        [itemId, supplierId, link.unitPrice]
      );
      priceLinks++;
    }
    console.log(`روابط سعر الصنف/المورد: ${priceLinks}`);

    await client.query("COMMIT");
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
