// استيراد مناطق التوصيل الحقيقية لكل فرع من ملف JSON (المرحلة 7A - كانت مناطق التوصيل عامة مشتركة
// بين كل الفروع، اتضاف عمود branch_id يربطها بالفرع الصحيح). آمن تشغيله أكتر من مرة (upsert بالاسم+الفرع).
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const pool = require("./pool");

const DATA_FILE = process.argv[2] || path.join(__dirname, "seed-data", "delivery-areas.json");

async function main() {
  const rows = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const branches = await client.query("SELECT id, name FROM branches");
    const branchIdByName = new Map(branches.rows.map((b) => [b.name, b.id]));

    let inserted = 0;
    let skipped = 0;
    for (const row of rows) {
      const branchId = branchIdByName.get(row.branchName);
      if (!branchId) {
        console.log(`تخطيت "${row.name}" - فرع غير معروف: ${row.branchName}`);
        skipped++;
        continue;
      }
      await client.query(
        `INSERT INTO delivery_areas (name, fee, eta_minutes, branch_id)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (name, branch_id) DO UPDATE SET fee = EXCLUDED.fee, eta_minutes = EXCLUDED.eta_minutes`,
        [row.name, row.fee, row.etaMinutes, branchId]
      );
      inserted++;
    }

    await client.query("COMMIT");
    console.log(`تم استيراد/تحديث ${inserted} منطقة توصيل، اتخطى ${skipped}`);
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
