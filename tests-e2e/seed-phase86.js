// المرحلة 8.6: تجهيز قاعدة بيانات مخصصة لتشغيل Playwright ضد سيناريوهات المرحلة 8.6 تحديدًا -
// فرع + كاشير/مدير فرع/محاسب (باسورد موحّد Pw12345678) + منيو (صنف + حجم) + مادة خام + عرض (كومبو)
// + طرق دفع (كاش/فيزا/آجل) - مش قاعدة Jest (فاضية دايمًا) ولا قاعدة التطوير المشتركة. بيصفّر القاعدة
// بالكامل (DROP+CREATE) وينشئ schema.sql من جديد في كل تشغيلة عشان يبقى معزول ونضيف.
const fs = require("fs");
const path = require("path");
const { Client } = require("pg");
const bcrypt = require("bcryptjs");

const E2E_DB_URL = process.env.E2E_DATABASE_URL || "postgresql://postgres:test123@localhost:5432/satamoni_e2e_86";
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

  const branch = await db.query("INSERT INTO branches (name) VALUES ('فرع-8.6-بلايرايت') RETURNING id");
  const branchId = branch.rows[0].id;

  await db.query(
    `INSERT INTO users (branch_id, name, email, password_hash, role) VALUES
     ($1,'كاشير-8.6-بلايرايت','pw-cashier86@test.local',$2,'cashier'),
     ($1,'مدير-8.6-بلايرايت','pw-manager86@test.local',$2,'branch_manager'),
     (NULL,'محاسب-8.6-بلايرايت','pw-accountant86@test.local',$2,'accountant')`,
    [branchId, passwordHash]
  );

  await db.query(
    `INSERT INTO payment_methods (name, kind) VALUES ('كاش', 'cash'), ('فيزا', 'card_or_wallet'), ('آجل', 'credit')`
  );

  const cat = await db.query("INSERT INTO menu_categories (name) VALUES ('8.6-بلايرايت-قسم') RETURNING id");
  const pizza = await db.query("INSERT INTO menu_items (category_id, name) VALUES ($1,'بيتزا-8.6-بلايرايت') RETURNING id", [cat.rows[0].id]);
  const pizzaVariant = await db.query("INSERT INTO menu_item_variants (item_id, label, price) VALUES ($1,'وسط',80) RETURNING id", [pizza.rows[0].id]);
  const fries = await db.query("INSERT INTO menu_items (category_id, name) VALUES ($1,'بطاطس-8.6-بلايرايت') RETURNING id", [cat.rows[0].id]);
  const friesVariant = await db.query("INSERT INTO menu_item_variants (item_id, label, price) VALUES ($1,'عادي',25) RETURNING id", [fries.rows[0].id]);
  await db.query("INSERT INTO menu_item_modifiers (item_id, name, price_delta) VALUES ($1,'إضافة جبنة',10)", [pizza.rows[0].id]);

  const combo = await db.query("INSERT INTO combos (name, price) VALUES ('عرض عائلي-8.6-بلايرايت', 150) RETURNING id");
  await db.query("INSERT INTO combo_items (combo_id, variant_id, quantity) VALUES ($1,$2,2)", [combo.rows[0].id, pizzaVariant.rows[0].id]);
  await db.query("INSERT INTO combo_items (combo_id, variant_id, quantity) VALUES ($1,$2,1)", [combo.rows[0].id, friesVariant.rows[0].id]);

  await db.query(
    "INSERT INTO inventory_items (name, unit, item_type) VALUES ('دقيق-8.6-بلايرايت', 'كيلو', 'raw')"
  );

  console.log(`تم تجهيز قاعدة Playwright للمرحلة 8.6: ${dbName} (فرع #${branchId})`);
  await db.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
