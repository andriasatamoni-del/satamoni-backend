// Feature-recovery mission, E2E fixture audit: tests-e2e/phase8f-regression.spec.js,
// phase8g-printing.spec.js and phase8h-recovery.spec.js were all added to the repo in the same
// commit as phase86/87 (a squashed/consolidated history point - see FINAL REPORT for evidence),
// but unlike phase86/87 they never got their own committed seed script - only seed-phase86.js and
// seed-phase87.js exist. This script reconstructs exactly what those 3 specs need, reading their
// assertions directly rather than guessing: pw-cashier@test.local / pw-callcenter@test.local /
// pw-driver@test.local / pw-branch_manager@test.local / pw-accountant@test.local /
// pw-admin@test.local (unsuffixed emails, all password Pw12345678 - matches the literal strings
// each spec's login() calls use), one branch, one menu item+variant+payment methods (same minimal
// POS fixture as seed-phase86.js), and one employees row named 'موظف بلايرايت' (phase8f-regression
// asserts the payroll "employees" tab contains exactly that text - the "-بلايرايت" suffix is this
// repo's own established Playwright-fixture naming convention, not a guessed historical value).
const fs = require("fs");
const path = require("path");
const { Client } = require("pg");
const bcrypt = require("bcryptjs");

const E2E_DB_URL = process.env.E2E_DATABASE_URL || "postgresql://postgres:test123@localhost:5432/satamoni_e2e_8fgh";
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

  const branch = await db.query("INSERT INTO branches (name) VALUES ('فرع-8FGH-بلايرايت') RETURNING id");
  const branchId = branch.rows[0].id;

  await db.query(
    `INSERT INTO users (branch_id, name, email, password_hash, role) VALUES
     ($1,'كاشير-8FGH-بلايرايت','pw-cashier@test.local',$2,'cashier'),
     ($1,'مدير-8FGH-بلايرايت','pw-branch_manager@test.local',$2,'branch_manager'),
     (NULL,'محاسب-8FGH-بلايرايت','pw-accountant@test.local',$2,'accountant'),
     (NULL,'أدمن-8FGH-بلايرايت','pw-admin@test.local',$2,'admin'),
     ($1,'كول سنتر-8FGH-بلايرايت','pw-callcenter@test.local',$2,'callcenter'),
     ($1,'سائق-8FGH-بلايرايت','pw-driver@test.local',$2,'driver')`,
    [branchId, passwordHash]
  );

  await db.query(
    `INSERT INTO payment_methods (name, kind) VALUES ('كاش', 'cash'), ('فيزا', 'card_or_wallet'), ('آجل', 'credit')`
  );

  const cat = await db.query("INSERT INTO menu_categories (name) VALUES ('8FGH-بلايرايت-قسم') RETURNING id");
  const pizza = await db.query("INSERT INTO menu_items (category_id, name) VALUES ($1,'بيتزا-8FGH-بلايرايت') RETURNING id", [cat.rows[0].id]);
  await db.query("INSERT INTO menu_item_variants (item_id, label, price) VALUES ($1,'وسط',80)", [pizza.rows[0].id]);

  // phase8f-regression.spec.js: "أدمن - تبويب الموظفين بيظهر الموظف اللي اتعمل seed" يتحقق من
  // النص "موظف بلايرايت" حرفيًا في تبويب الموظفين بشاشة الرواتب
  await db.query(
    `INSERT INTO employees (name, department, attendance_system, restricted_branch_id)
     VALUES ('موظف بلايرايت', 'الإدارة', 'manual', $1)`,
    [branchId]
  );

  console.log(`تم تجهيز قاعدة Playwright لِ8F/8G/8H: ${dbName} (فرع #${branchId})`);
  await db.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
