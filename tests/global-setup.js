// بيتشغل مرة واحدة بس قبل كل ملفات الاختبار (jest globalSetup) - بيصفّر قاعدة الاختبار بالكامل
// (DROP + CREATE) وينشئ الـschema من db/schema.sql، عشان كل تشغيل لـ"npm test" يبدأ من صفر نضيف
// ومعزول تمامًا عن أي قاعدة تطوير أو إنتاج حقيقية.
const fs = require("fs");
const path = require("path");
const { Client } = require("pg");
const { TEST_DATABASE_URL } = require("./db-config");

module.exports = async () => {
  const dbName = new URL(TEST_DATABASE_URL).pathname.replace(/^\//, "");
  const adminUrl = TEST_DATABASE_URL.replace(`/${dbName}`, "/postgres");

  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await admin.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`, [dbName]);
  } catch (e) { /* تجاهل */ }
  await admin.query(`DROP DATABASE IF EXISTS "${dbName}"`);
  await admin.query(`CREATE DATABASE "${dbName}"`);
  await admin.end();

  const schemaSql = fs.readFileSync(path.join(__dirname, "..", "db", "schema.sql"), "utf8");
  const testDb = new Client({ connectionString: TEST_DATABASE_URL });
  await testDb.connect();
  await testDb.query(schemaSql);
  await testDb.end();
};
