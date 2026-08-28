// المرحلة 8.7: تجهيز قاعدة بيانات مخصصة لتشغيل Playwright ضد سيناريوهات القبول التشغيلي - نفس نمط
// tests-e2e/seed-phase86.js بالظبط، زودنا عليه بس صنف باسم طويل جدًا (اختبار وضوح السلة/الالتفاف
// النصي على شاشات صغيرة) ومادتين خام إضافيتين لفاتورة المشترى.
const fs = require("fs");
const path = require("path");
const { Client } = require("pg");
const bcrypt = require("bcryptjs");

const E2E_DB_URL = process.env.E2E_DATABASE_URL || "postgresql://postgres:test123@localhost:5432/satamoni_e2e_87";
const PASSWORD = "Pw12345678";

async function main() {
  const dbName = new URL(E2E_DB_URL).pathname.replace(/^\//, "");
  const adminUrl = E2E_DB_URL.replace(`/${dbName}`, "/postgres");

  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await admin.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`, [dbName]);
  } catch (e) { /* تجاهل */ }
  await admin.query(`DROP DATABASE IF EXISTS "${dbName}"`);
  await admin.query(`CREATE DATABASE "${dbName}"`);
  await admin.end();

  const schemaSql = fs.readFileSync(path.join(__dirname, "..", "db", "schema.sql"), "utf8");
  const db = new Client({ connectionString: E2E_DB_URL });
  await db.connect();
  await db.query(schemaSql);

  const passwordHash = await bcrypt.hash(PASSWORD, 10);

  const branch = await db.query("INSERT INTO branches (name) VALUES ('فرع-8.7-بلايرايت') RETURNING id");
  const branchId = branch.rows[0].id;

  await db.query(
    `INSERT INTO users (branch_id, name, email, password_hash, role) VALUES
     ($1,'كاشير-8.7-بلايرايت','pw-cashier87@test.local',$2,'cashier'),
     ($1,'مدير-8.7-بلايرايت','pw-manager87@test.local',$2,'branch_manager'),
     (NULL,'محاسب-8.7-بلايرايت','pw-accountant87@test.local',$2,'accountant'),
     (NULL,'أدمن-8.7-بلايرايت','pw-admin87@test.local',$2,'admin')`,
    [branchId, passwordHash]
  );

  await db.query(
    `INSERT INTO payment_methods (name, kind) VALUES ('كاش', 'cash'), ('فيزا', 'card_or_wallet'), ('آجل', 'credit')`
  );

  const cat = await db.query("INSERT INTO menu_categories (name) VALUES ('8.7-بلايرايت-قسم') RETURNING id");
  const pizza = await db.query("INSERT INTO menu_items (category_id, name) VALUES ($1,'بيتزا-8.7-بلايرايت') RETURNING id", [cat.rows[0].id]);
  const pizzaVariant = await db.query("INSERT INTO menu_item_variants (item_id, label, price) VALUES ($1,'وسط',80) RETURNING id", [pizza.rows[0].id]);
  const fries = await db.query("INSERT INTO menu_items (category_id, name) VALUES ($1,'بطاطس-8.7-بلايرايت') RETURNING id", [cat.rows[0].id]);
  const friesVariant = await db.query("INSERT INTO menu_item_variants (item_id, label, price) VALUES ($1,'عادي',25) RETURNING id", [fries.rows[0].id]);
  await db.query("INSERT INTO menu_item_modifiers (item_id, name, price_delta) VALUES ($1,'إضافة جبنة',10)", [pizza.rows[0].id]);

  // اسم صنف طويل جدًا - اختبار وضوح السلة/الالتفاف النصي على شاشات صغيرة (المرحلة 8.7، القسم 15)
  const longItem = await db.query(
    "INSERT INTO menu_items (category_id, name) VALUES ($1,'بيتزا سوبر مكس لحمة مفرومة وفراخ وسجق وبيبروني وفلفل ألوان وزيتون وذرة وجبنة موزاريلا إضافية') RETURNING id",
    [cat.rows[0].id]
  );
  await db.query("INSERT INTO menu_item_variants (item_id, label, price) VALUES ($1,'عائلي كبير جدًا',250)", [longItem.rows[0].id]);

  const combo = await db.query("INSERT INTO combos (name, price) VALUES ('عرض عائلي-8.7-بلايرايت', 150) RETURNING id");
  await db.query("INSERT INTO combo_items (combo_id, variant_id, quantity) VALUES ($1,$2,2)", [combo.rows[0].id, pizzaVariant.rows[0].id]);
  await db.query("INSERT INTO combo_items (combo_id, variant_id, quantity) VALUES ($1,$2,1)", [combo.rows[0].id, friesVariant.rows[0].id]);

  await db.query(
    "INSERT INTO inventory_items (name, unit, item_type) VALUES ('دقيق-8.7-بلايرايت', 'كيلو', 'raw'), ('جبنة-8.7-بلايرايت', 'كيلو', 'raw')"
  );

  console.log(`تم تجهيز قاعدة Playwright للمرحلة 8.7: ${dbName} (فرع #${branchId})`);
  await db.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
