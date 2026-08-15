// بيحدّث talabat_price للأصناف اللي مباعة فعليًا على تطبيق طلبات، من ملف
// db/seed-data/talabat-prices.json: [[اسم الصنف, حجمه, سعر طلبات], ...].
// أي حجم مش موجود في الملف ده بيفضل talabat_price بتاعه NULL (يعني مش مباع على طلبات حاليًا).
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const pool = require("./pool");

const DATA_FILE = process.argv[2] || path.join(__dirname, "seed-data", "talabat-prices.json");

async function main() {
  const mapping = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  let updated = 0;
  const notFound = [];

  for (const [itemName, variantLabel, talabatPrice] of mapping) {
    const result = await pool.query(
      `UPDATE menu_item_variants v
       SET talabat_price = $3
       FROM menu_items i
       WHERE v.item_id = i.id AND i.name = $1 AND v.label = $2
       RETURNING v.id`,
      [itemName, variantLabel, talabatPrice]
    );
    if (result.rows.length === 0) {
      notFound.push(`${itemName} (${variantLabel})`);
    } else {
      updated++;
    }
  }

  console.log(`اتحدث سعر طلبات لـ ${updated} صنف`);
  if (notFound.length > 0) {
    console.log(`تحذير - مش موجودين في المنيو الأساسي: ${notFound.join(", ")}`);
  }
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
