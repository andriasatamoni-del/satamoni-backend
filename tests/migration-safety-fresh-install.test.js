// المرحلة 7U: تدقيق الترحيل (Migration Audit) - بيحاكي تسلسل النشر الحقيقي بالظبط: npm run migrate
// (= psql -f db/schema.sql على قاعدة فاضية جديدة تمامًا) ثم db/migrate.js (بيتشغل تلقائيًا مع كل بدء
// تشغيل سيرفر عبر startCommand في render.yaml). ده مختلف عمدًا عن باقي كل اختبارات المشروع - كلهم
// بيشتغلوا ضد قاعدة الـJest اللي بتتبني من tests/global-setup.js (DROP+CREATE من schema.sql بس، من
// غير ما db/migrate.js يتشغل عليها خالص أبدًا) - يعني أي باج في تفاعل schema.sql مع db/migrations/*.js
// كان أعمى تمامًا لكل الاختبارات التانية. الاختبار ده اتكتب بعد ما لقينا فعليًا بالظبط الباج ده
// (migration 0012 كانت بترمي duplicate_table - مش duplicate_object - وقت تشغيلها بعد schema.sql
// جديد فيه نفس الـconstraint أصلًا، يعني أي نشر إنتاج جديد كان هيقع وقت الإقلاع) - الاختبار ده بيقفل
// عليه عشان النوع ده من الباج يتلقط تلقائيًا في المستقبل، مش بس بفحص يدوي.
const fs = require("fs");
const path = require("path");
const { Pool, Client } = require("pg");
const { TEST_DATABASE_URL } = require("./db-config");
const { runMigrations } = require("../db/migrate");

const FRESH_DB_NAME = "satamoni_migration_safety_test";

function withDbName(url, dbName) {
  const u = new URL(url);
  u.pathname = `/${dbName}`;
  return u.toString();
}

const maintenanceUrl = withDbName(TEST_DATABASE_URL, "postgres");
const freshDbUrl = withDbName(TEST_DATABASE_URL, FRESH_DB_NAME);

describe("تدقيق 7U: تسلسل النشر الحقيقي - schema.sql على قاعدة فاضية ثم db/migrate.js فوقها", () => {
  let freshPool;

  beforeAll(async () => {
    const admin = new Client({ connectionString: maintenanceUrl });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${FRESH_DB_NAME}`);
    await admin.query(`CREATE DATABASE ${FRESH_DB_NAME}`);
    await admin.end();

    freshPool = new Pool({ connectionString: freshDbUrl });
    const schemaSql = fs.readFileSync(path.join(__dirname, "../db/schema.sql"), "utf8");
    await freshPool.query(schemaSql);
  }, 30000);

  afterAll(async () => {
    if (freshPool) await freshPool.end();
    const admin = new Client({ connectionString: maintenanceUrl });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${FRESH_DB_NAME}`);
    await admin.end();
  }, 15000);

  test("تشغيل db/migrate.js بعد npm run migrate مباشرة - لازم ينجح من غير أي استثناء", async () => {
    const client = await freshPool.connect();
    try {
      await runMigrations(client); // لو رمت استثناء، الاختبار بيفشل تلقائيًا من غير أي assertion زيادة
    } finally {
      client.release();
    }
  });

  test("تشغيل db/migrate.js تاني (idempotency) - لازم يكون no-op تمامًا", async () => {
    const client = await freshPool.connect();
    try {
      await runMigrations(client);
      const count = await client.query("SELECT COUNT(*)::int AS c FROM schema_migrations");
      expect(count.rows[0].c).toBeGreaterThan(0);
    } finally {
      client.release();
    }
  });
});
