// نظام ترحيل تلقائي بسيط للتغييرات اللي بتتضاف على db/schema.sql بعد أول تثبيت - مشكلة كانت بتتكرر
// طول المشروع: schema.sql نفسه بيستخدم مرة واحدة بس وقت التثبيت الأول (CREATE TABLE)، فأي عمود/جدول
// جديد بيتضاف بعد كده في الكود مكانش بيوصل لقاعدة البيانات الحقيقية إلا لو حد شغّل ALTER TABLE يدوي على
// السيرفر مباشرة. النظام ده بيحل المشكلة دي نهائيًا: أي ملف جديد في db/migrations/ بيتشغل تلقائيًا مع
// كل بدء تشغيل للسيرفر (نفس startCommand بتاع render.yaml اللي بيشغل db/ensure-schema.js أصلًا)، وبيتسجل
// مرة واحدة بس في جدول schema_migrations عشان مايتكررش لو السيرفر اتعاد تشغيله عشرات المرات.
//
// عشان تضيف تغيير جديد في القاعدة مستقبلًا:
//   1) عدّل db/schema.sql (عشان أي تثبيت جديد من الصفر ياخد الشكل النهائي على طول)
//   2) اعمل ملف جديد في db/migrations/ برقم تسلسلي أكبر من اللي قبله (مثلًا 0002_اسم_وصفي.js)
//      بنفس شكل db/migrations/0001_loyalty_redeem_columns.js - لازم يستخدم DDL آمن التكرار
//      (ADD COLUMN IF NOT EXISTS...) عشان يفضل آمن حتى لو اتشغل أكتر من مرة بالغلط
// مفيش خطوة يدوية على السيرفر الحقيقي محتاجة تتعمل تاني - أول push بعد كده هيطبّق الترحيل لوحده.
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const pool = require("./pool");

const MIGRATIONS_DIR = path.join(__dirname, "migrations");

async function runMigrations(client) {
  // الجدول ده موجود أصلًا في db/schema.sql (كان بس تتبّع خفيف بالاسم قبل ما نظام الترحيل ده يتبنى) -
  // نفس التركيب بالظبط هنا (IF NOT EXISTS بيسيبه زي ما هو لو موجود بالفعل، مش بيعمل نسخة تانية مختلفة)
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id          SERIAL PRIMARY KEY,
      name        TEXT NOT NULL UNIQUE,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  const applied = await client.query("SELECT name FROM schema_migrations");
  const appliedNames = new Set(applied.rows.map((r) => r.name));

  const files = fs.existsSync(MIGRATIONS_DIR)
    ? fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".js")).sort()
    : [];

  for (const file of files) {
    if (appliedNames.has(file)) continue;
    const migration = require(path.join(MIGRATIONS_DIR, file));
    console.log(`جاري تطبيق الترحيل: ${file}`);
    await client.query("BEGIN");
    try {
      await migration.up(client);
      await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
      await client.query("COMMIT");
      console.log(`تم تطبيق الترحيل: ${file}`);
    } catch (err) {
      await client.query("ROLLBACK");
      // 23505 = مفتاح مكرر - سيرفر تاني (نسخة قديمة بتتقفل مع بدء الجديدة على Render) سبقنا وطبّقه
      // خلاص في نفس اللحظة تقريبًا. مش خطأ حقيقي - تجاهله واستمر للترحيل اللي بعده
      if (err.code === "23505") {
        console.log(`الترحيل ${file} اتطبّق بالفعل من عملية تانية بالتوازي - تخطّي`);
        continue;
      }
      console.error(`فشل الترحيل ${file}:`, err.message);
      throw err;
    }
  }
}

module.exports = { runMigrations };

if (require.main === module) {
  (async () => {
    const client = await pool.connect();
    try {
      await runMigrations(client);
    } finally {
      client.release();
      await pool.end();
    }
  })().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
