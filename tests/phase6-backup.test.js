// المرحلة 6 (6E): اختبار حقيقي لسياسة الاحتفاظ بالنسخ الاحتياطية + تمرين استرجاع كامل فعلي (مش مجرد
// قراءة كود) - نسخة احتياطية حقيقية بـpg_dump من قاعدة الاختبار (فيها بيانات حقيقية من كل الاختبارات
// اللي فاتت)، استرجاع فعلي بـpg_restore في قاعدة مؤقتة، وتحقق فعلي من السكيما/البيانات/توازن القيود
const fs = require("fs");
const path = require("path");
const os = require("os");
const { pool, seedUser } = require("./helpers");
const { applyRetentionPolicy, createBackup } = require("../db/backup");
const { runDrill } = require("../db/restore-drill");
const { postJournalEntry } = require("../db/accounting-engine");

afterAll(async () => {
  await pool.end();
});

describe("6E: سياسة الاحتفاظ بالنسخ (30 يوم يوميًا / 12 شهر شهريًا / سنويًا للأبد)", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "satamoni-backup-test-"));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function touchBackup(dir, date) {
    const pad = (n) => String(n).padStart(2, "0");
    const name = `satamoni-${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}-120000.dump`;
    fs.writeFileSync(path.join(dir, name), "fake dump content");
    return name;
  }

  test("كل النسخ جوه آخر 30 يوم بتتحفظ كلها من غير أي حذف", () => {
    const now = new Date("2026-06-15T00:00:00Z");
    const names = [];
    for (let i = 0; i < 10; i++) {
      names.push(touchBackup(tmpDir, new Date(now.getTime() - i * 24 * 60 * 60 * 1000)));
    }
    const result = applyRetentionPolicy(tmpDir, now);
    expect(result.deleted).toBe(0);
    expect(result.kept).toBe(10);
    names.forEach((n) => expect(fs.existsSync(path.join(tmpDir, n))).toBe(true));
  });

  test("نسخ أقدم من 30 يوم وأحدث من 12 شهر - نسخة واحدة بس بتتحفظ لكل شهر (الأقدم في الشهر)", () => {
    const now = new Date("2026-06-15T00:00:00Z");
    // 3 نسخ في نفس الشهر (مارس 2026)، كلها أقدم من 30 يوم من "الآن" وأحدث من سنة
    const mar1 = touchBackup(tmpDir, new Date("2026-03-01T00:00:00Z"));
    const mar15 = touchBackup(tmpDir, new Date("2026-03-15T00:00:00Z"));
    const mar28 = touchBackup(tmpDir, new Date("2026-03-28T00:00:00Z"));

    applyRetentionPolicy(tmpDir, now);

    expect(fs.existsSync(path.join(tmpDir, mar1))).toBe(true); // الأقدم في الشهر - بيتحفظ
    expect(fs.existsSync(path.join(tmpDir, mar15))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, mar28))).toBe(false);
  });

  test("نسخ أقدم من 12 شهر - نسخة واحدة بس بتتحفظ لكل سنة (الأقدم في السنة) للأبد", () => {
    const now = new Date("2026-06-15T00:00:00Z");
    const jan2023 = touchBackup(tmpDir, new Date("2023-01-05T00:00:00Z"));
    const jun2023 = touchBackup(tmpDir, new Date("2023-06-10T00:00:00Z"));
    const dec2023 = touchBackup(tmpDir, new Date("2023-12-20T00:00:00Z"));

    applyRetentionPolicy(tmpDir, now);

    expect(fs.existsSync(path.join(tmpDir, jan2023))).toBe(true); // الأقدم في سنة 2023 - بيتحفظ للأبد
    expect(fs.existsSync(path.join(tmpDir, jun2023))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, dec2023))).toBe(false);
  });

  test("ملفات مش بصيغة اسم النسخ المتوقعة بيتم تجاهلها تمامًا (مش بتتمسح ومش بتتحسب)", () => {
    fs.writeFileSync(path.join(tmpDir, "random-file.txt"), "not a backup");
    const now = new Date("2026-06-15T00:00:00Z");
    const result = applyRetentionPolicy(tmpDir, now);
    expect(result.kept).toBe(0);
    expect(fs.existsSync(path.join(tmpDir, "random-file.txt"))).toBe(true); // اتجاهل، مش اتمسح
  });
});

describe("6E: تمرين استرجاع كامل فعلي (backup حقيقي بـpg_dump → restore حقيقي بـpg_restore → تحقق فعلي)", () => {
  let tmpBackupDir;
  const adminDatabaseUrl = process.env.DATABASE_URL.replace(/\/[^/]+$/, "/postgres");

  // بيانات محلية للاختبار ده بس (مش معتمدين على وجود بيانات من ملفات اختبار تانية اتشغّلت قبل كده -
  // الاختبار ده لازم ينجح لوحده حتى لو اتشغّل بمفرده) - مستخدم + قيد محاسبي متزن حقيقي، عشان فحص
  // "البيانات التمثيلية" و"توازن القيود المحاسبية" يبقى له حاجة حقيقية يتحقق منها مش أصفار
  beforeAll(async () => {
    tmpBackupDir = fs.mkdtempSync(path.join(os.tmpdir(), "satamoni-restore-drill-test-"));
    const userId = await seedUser({ name: "مستخدم-م6-نسخة-احتياطية", email: "backup-drill-p6@jest.test", role: "admin" });
    const cash = await pool.query("SELECT id FROM accounts WHERE code = '1100'");
    const sales = await pool.query("SELECT id FROM accounts WHERE code = '4100'");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await postJournalEntry(client, {
        entryDate: new Date().toISOString().slice(0, 10), description: "قيد اختبار تمرين الاسترجاع",
        sourceType: "manual", lines: [
          { accountId: cash.rows[0].id, debit: 100 },
          { accountId: sales.rows[0].id, credit: 100 },
        ], userId, autoPost: true,
      });
      await client.query("COMMIT");
    } finally {
      client.release();
    }
  });
  afterAll(() => {
    fs.rmSync(tmpBackupDir, { recursive: true, force: true });
  });

  test("نسخة احتياطية حقيقية (فيها بيانات مزروعة محليًا للاختبار ده) + تمرين استرجاع كامل - لازم ينجح", async () => {
    const backupPath = await createBackup(tmpBackupDir);
    expect(fs.existsSync(backupPath)).toBe(true);
    expect(fs.statSync(backupPath).size).toBeGreaterThan(1024);

    const report = await runDrill({ databaseUrl: adminDatabaseUrl, backupFile: backupPath, keep: false });

    expect(report.success).toBe(true);
    expect(report.schemaCheck.ok).toBe(true);
    expect(report.accountingCheck.ok).toBe(true);
    // القاعدة اللي بنعمل منها نسخة هي نفسها قاعدة الاختبار اللي شغّلنا عليها باقي الاختبارات - لازم
    // يبقى فيها بيانات حقيقية (مش صفر) على الأقل في جدول واحد أساسي زي users
    expect(report.dataCheck.users).toBeGreaterThan(0);
  }, 30000);
});
