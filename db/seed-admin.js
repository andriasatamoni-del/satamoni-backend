// إنشاء أول حساب أدمن في النظام (مرة واحدة بعد الـ migrate)
// الإعدادات بتتاخد من متغيرات البيئة: ADMIN_NAME, ADMIN_EMAIL, ADMIN_PASSWORD
require("dotenv").config();
const bcrypt = require("bcryptjs");
const pool = require("./pool");

async function main() {
  const name = process.env.ADMIN_NAME || "Admin";
  const email = process.env.ADMIN_EMAIL;
  const password = process.env.ADMIN_PASSWORD;

  if (!email || !password) {
    console.error("لازم تحدد ADMIN_EMAIL و ADMIN_PASSWORD في .env قبل تشغيل السكريبت ده");
    process.exit(1);
  }

  const passwordHash = await bcrypt.hash(password, 10);

  await pool.query(
    `INSERT INTO users (name, email, password_hash, role, branch_id)
     VALUES ($1, $2, $3, 'admin', NULL)
     ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, name = EXCLUDED.name`,
    [name, email, passwordHash]
  );

  console.log(`تم إنشاء/تحديث حساب الأدمن: ${email}`);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
