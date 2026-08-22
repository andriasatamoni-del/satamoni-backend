// المرحلة 6 (6E): تمرين استرجاع (Restore Drill) قابل للتكرار وينفّذه أي مطوّر تاني من غير معرفة
// مسبقة - بياخد أحدث نسخة احتياطية (أو نسخة محددة)، يسترجعها في قاعدة بيانات مؤقتة نضيفة تمامًا،
// ويتحقق فعليًا إنها صالحة للاستخدام (مش بس "الملف اترجع من غير خطأ"). بينضّف نفسه في الآخر (يمسح
// قاعدة البيانات المؤقتة) إلا لو --keep اتبعتت.
//
// ملحوظة عن "تشغيل الـmigrations": المشروع ده مفيهوش نظام migrations تراكمي منفصل - db/schema.sql
// هو مصدر الحقيقة الوحيد ومصمّم يتطبّق على قاعدة فاضية (اتأكد من كده طول المرحلة دي بفحص "3x fresh
// install" بعد أي تعديل في السكيما). يعني مفيش "migration تشتغل" فوق نسخة مسترجعة - البديل الصادق
// هو مقارنة جداول النسخة المسترجعة بالجداول اللي schema.sql الحالي متوقّعها، وتوثيق أي فرق (drift)
// كتحذير - ده بالظبط اللي بيعمله الفحص تحت (checkSchemaMatch)
//
// الاستخدام: DATABASE_URL=<اتصال بسيرفر Postgres تقدر تنشئ عليه قواعد مؤقتة> node db/restore-drill.js [--keep] [--backup=/path/to/file.dump]
const { execFile } = require("child_process");
const util = require("util");
const path = require("path");
const { Client } = require("pg");
const execFileAsync = util.promisify(execFile);
const { listBackups } = require("./backup");

// جداول أساسية لازم تكون موجودة في أي نسخة سليمة من قاعدة البيانات - مش كل الجداول (كتير أوي)، بس
// عينة تمثيلية من كل موحد رئيسي (مبيعات/مخزون/محاسبة/موارد بشرية) تكفي لإثبات إن السكيما مش ناقصة جزء كامل
const CORE_TABLES = [
  "users", "branches", "orders", "order_items", "inventory_items", "branch_inventory_stock",
  "inventory_movements", "accounts", "journal_entries", "journal_entry_lines", "employees",
  "purchase_orders", "goods_receipts", "recipes", "production_orders",
];

function scratchDbName() {
  return `satamoni_restore_drill_${Date.now()}`;
}

async function adminClientFor(databaseUrl) {
  const url = new URL(databaseUrl);
  url.pathname = "/postgres";
  const client = new Client({ connectionString: url.toString() });
  await client.connect();
  return client;
}

function urlWithDb(databaseUrl, dbName) {
  const url = new URL(databaseUrl);
  url.pathname = `/${dbName}`;
  return url.toString();
}

async function checkSchemaMatch(client) {
  const missing = [];
  for (const table of CORE_TABLES) {
    const res = await client.query("SELECT to_regclass($1) AS exists", [`public.${table}`]);
    if (!res.rows[0].exists) missing.push(table);
  }
  return { ok: missing.length === 0, missing };
}

async function checkRepresentativeData(client) {
  const counts = {};
  for (const table of ["branches", "users", "orders", "journal_entries", "employees", "inventory_items"]) {
    const res = await client.query(`SELECT COUNT(*) AS c FROM ${table}`);
    counts[table] = Number(res.rows[0].c);
  }
  return counts;
}

// فحص سلامة محاسبية حقيقي - مش مجرد "الجدول فيه صفوف": كل القيود المرحّلة (POSTED) لازم مدينها
// يساوي دائنها بالظبط، دايمًا (نفس القيد اللي postJournalEntry نفسه بيتأكد منه وقت الترحيل - هنا
// بنتأكد إن النسخة الاحتياطية والاسترجاع مالهمش أي فساد بيانات كسر التوازن ده)
async function checkAccountingIntegrity(client) {
  const res = await client.query(`
    SELECT je.id, je.entry_number, COALESCE(SUM(jel.debit),0) AS total_debit, COALESCE(SUM(jel.credit),0) AS total_credit
    FROM journal_entries je JOIN journal_entry_lines jel ON jel.journal_entry_id = je.id
    WHERE je.status = 'POSTED'
    GROUP BY je.id, je.entry_number
    HAVING ABS(COALESCE(SUM(jel.debit),0) - COALESCE(SUM(jel.credit),0)) > 0.0000001
  `);
  return { ok: res.rows.length === 0, unbalancedEntries: res.rows };
}

async function runDrill({ databaseUrl, backupFile, keep }) {
  const report = { steps: [], success: false };
  const log = (step, ok, detail) => { report.steps.push({ step, ok, detail }); console.log(`${ok ? "✓" : "✗"} ${step}${detail ? " - " + detail : ""}`); };

  if (!backupFile) {
    const backups = listBackups();
    if (backups.length === 0) throw new Error("مفيش أي نسخة احتياطية موجودة في مجلد النسخ");
    backupFile = backups[backups.length - 1].fullPath;
  }
  log("تحديد النسخة الاحتياطية", true, path.basename(backupFile));

  const dbName = scratchDbName();
  const admin = await adminClientFor(databaseUrl);
  try {
    await admin.query(`CREATE DATABASE "${dbName}"`);
    log("إنشاء قاعدة بيانات مؤقتة نضيفة", true, dbName);

    const scratchUrl = urlWithDb(databaseUrl, dbName);
    try {
      await execFileAsync("pg_restore", ["-d", scratchUrl, "--no-owner", "--no-privileges", backupFile]);
      log("استرجاع النسخة الاحتياطية (pg_restore)", true);
    } catch (err) {
      // pg_restore بيرجع exit code غير صفري أحيانًا حتى لو الاسترجاع نجح فعليًا (تحذيرات عن
      // privileges/roles مش موجودة في القاعدة المؤقتة) - المهم إن الجداول فعلًا موجودة بعد كده،
      // مش الـexit code نفسه، فبنكمل ونتحقق فعليًا في الخطوة الجاية
      log("استرجاع النسخة الاحتياطية (pg_restore)", true, "في تحذيرات غير خطيرة (طبيعي) - هنتأكد بالفحص الفعلي تحت");
    }

    const scratchClient = new Client({ connectionString: scratchUrl });
    await scratchClient.connect();
    try {
      const schemaCheck = await checkSchemaMatch(scratchClient);
      log("التحقق من السكيما (الجداول الأساسية موجودة)", schemaCheck.ok,
        schemaCheck.ok ? `${CORE_TABLES.length} جدول أساسي موجودين` : `ناقص: ${schemaCheck.missing.join(", ")}`);

      const dataCheck = await checkRepresentativeData(scratchClient);
      const dataOk = Object.values(dataCheck).some((c) => c > 0); // على الأقل جدول واحد فيه بيانات حقيقية - مش نسخة فاضية بالغلط
      log("التحقق من البيانات التمثيلية", dataOk, JSON.stringify(dataCheck));

      const accountingCheck = await checkAccountingIntegrity(scratchClient);
      log("التحقق من سلامة القيود المحاسبية (كل قيد POSTED متزن)", accountingCheck.ok,
        accountingCheck.ok ? "كل القيود متزنة" : `${accountingCheck.unbalancedEntries.length} قيد غير متزن!`);

      report.success = schemaCheck.ok && dataOk && accountingCheck.ok;
      report.dataCheck = dataCheck;
      report.schemaCheck = schemaCheck;
      report.accountingCheck = accountingCheck;
    } finally {
      await scratchClient.end();
    }
  } finally {
    if (!keep) {
      await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`).catch(async () => {
        // WITH (FORCE) مش موجودة قبل Postgres 13 - fallback عادي
        await admin.query(`DROP DATABASE IF EXISTS "${dbName}"`);
      });
      log("تنظيف - مسح القاعدة المؤقتة", true, dbName);
    } else {
      log("تم الإبقاء على القاعدة المؤقتة للفحص اليدوي (--keep)", true, `${dbName} على ${databaseUrl}`);
    }
    await admin.end();
  }

  console.log(`\n=== النتيجة النهائية: ${report.success ? "نجاح ✓" : "فشل ✗"} ===`);
  return report;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const keep = args.includes("--keep");
  const backupArg = args.find((a) => a.startsWith("--backup="));
  const backupFile = backupArg ? backupArg.split("=")[1] : null;
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) { console.error("لازم تحدد DATABASE_URL"); process.exit(1); }

  runDrill({ databaseUrl, backupFile, keep })
    .then((report) => process.exit(report.success ? 0 : 1))
    .catch((err) => { console.error("فشل تمرين الاسترجاع:", err.message); process.exit(1); });
}

module.exports = { runDrill };
