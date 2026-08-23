// بيتشغل قبل السيرفر مباشرة مع كل بدء تشغيل (render.yaml: startCommand)، مش بس أول مرة.
// لو الجداول مش موجودة خالص، بينشئها من db/schema.sql (تثبيت أول مرة زي Render Blueprint).
// وفي الحالتين (تثبيت جديد أو قاعدة موجودة بالفعل) بيشغّل بعد كده أي ترحيل (migration) جديد لسه ما
// اتطبّقش على القاعدة دي بالتحديد - كده أي عمود/جدول جديد بيتضاف في الكود بعد أول تثبيت بيوصل للقاعدة
// الحقيقية تلقائي مع أول push، من غير ما حد يحتاج يشغّل ALTER TABLE يدوي على السيرفر (db/migrate.js)
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const bcrypt = require("bcryptjs");
const pool = require("./pool");
const { runMigrations } = require("./migrate");

async function main() {
  const existing = await pool.query("SELECT to_regclass('public.users') AS exists");
  if (!existing.rows[0].exists) {
    console.log("مفيش جداول لسه، بنشئ الـ schema...");
    const schemaSql = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8");
    await pool.query(schemaSql);
    console.log("تم إنشاء الجداول.");
  } else {
    console.log("الجداول موجودة بالفعل، مفيش داعي لإعادة الإنشاء.");
  }

  const migrationClient = await pool.connect();
  try {
    await runMigrations(migrationClient);
  } finally {
    migrationClient.release();
  }

  const adminEmail = process.env.ADMIN_EMAIL;
  const adminPassword = process.env.ADMIN_PASSWORD;
  if (adminEmail && adminPassword) {
    const passwordHash = await bcrypt.hash(adminPassword, 10);
    await pool.query(
      `INSERT INTO users (name, email, password_hash, role, branch_id)
       VALUES ($1, $2, $3, 'admin', NULL)
       ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, name = EXCLUDED.name`,
      [process.env.ADMIN_NAME || "Admin", adminEmail, passwordHash]
    );
    console.log(`تم التأكد من حساب الأدمن: ${adminEmail}`);
  } else {
    console.log("ADMIN_EMAIL/ADMIN_PASSWORD مش متحددين، تم تخطي إنشاء حساب الأدمن.");
  }

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
