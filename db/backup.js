// المرحلة 6 (6E): نسخ احتياطي يومي لقاعدة البيانات - pg_dump بصيغة custom (-Fc) عشان تدعم pg_restore
// الانتقائي واختياريًا ضغط أعلى من SQL نصي عادي. مصمّم يتشغّل عن طريق cron خارجي (أو مهمة مجدولة على
// أي مزوّد استضافة) - السكريبت ده نفسه مبيعملش جدولة، بس بينفّذ نسخة واحدة + سياسة الاحتفاظ في كل مرة
// يتشغّل. ملحوظة مهمة (Render أو أي مزوّد Postgres مُدار مشابه): لو الخطة المدفوعة بتوفر نسخ احتياطي
// تلقائي + Point-In-Time Recovery (PITR) على مستوى WAL، ده لازم يكون طبقة الحماية الأساسية (بيغطي أي
// لحظة، مش بس وقت التشغيل اليومي) - النسخ هنا طبقة إضافية محمولة (ملف .dump مستقل عن المزوّد، ينفع
// لأي استضافة/نقل يدوي/أرشفة خارجية) مش بديل عن PITR الحقيقي على مستوى قاعدة البيانات.
//
// الاستخدام: DATABASE_URL=postgres://... BACKUP_DIR=/path/to/backups node db/backup.js
// سياسة الاحتفاظ (بعد كل نسخة ناجحة): كل نسخة يومية من آخر 30 يوم بتفضل، بعد كده نسخة واحدة بس شهريًا
// لغاية 12 شهر، بعد كده نسخة واحدة بس سنويًا للأبد - الباقي بيتمسح.
const { execFile } = require("child_process");
const fs = require("fs");
const path = require("path");
const util = require("util");
const execFileAsync = util.promisify(execFile);

const BACKUP_DIR = process.env.BACKUP_DIR || path.join(__dirname, "..", "backups");
const DAILY_RETENTION_DAYS = Number(process.env.BACKUP_DAILY_RETENTION_DAYS || 30);
const MONTHLY_RETENTION_MONTHS = Number(process.env.BACKUP_MONTHLY_RETENTION_MONTHS || 12);
const FILENAME_RE = /^satamoni-(\d{4})(\d{2})(\d{2})-(\d{6})\.dump$/;

function timestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

async function createBackup(dir = BACKUP_DIR) {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("لازم تحدد DATABASE_URL");
  fs.mkdirSync(dir, { recursive: true });

  const filename = `satamoni-${timestamp()}.dump`;
  const fullPath = path.join(dir, filename);
  console.log(`جاري النسخ الاحتياطي إلى ${fullPath} ...`);
  await execFileAsync("pg_dump", ["-Fc", databaseUrl, "-f", fullPath]);

  const sizeBytes = fs.statSync(fullPath).size;
  if (sizeBytes < 1024) {
    // ملف بحجم أقل من 1 كيلوبايت غالبًا يعني pg_dump فشل بصمت أو القاعدة فاضية بشكل غير متوقع - مش
    // لازم نسيب نسخة فاشلة تبان كأنها نجحت في السجل
    throw new Error(`ملف النسخة صغير جدًا (${sizeBytes} بايت) - على الأرجح فشل النسخ`);
  }
  console.log(`تم النسخ الاحتياطي بنجاح: ${filename} (${(sizeBytes / 1024 / 1024).toFixed(2)} ميجابايت)`);
  return fullPath;
}

// بيرجّع كل ملفات النسخ الموجودة، متفرزة بالتاريخ المستخرج من اسم الملف نفسه (مش وقت تعديل الملف -
// أوثق وبيفضل صحيح حتى لو الملف اتنقل/اتنسخ لمكان تاني بعدين). dir قابل للتمرير صراحة (بدل الاعتماد
// على BACKUP_DIR الثابت وقت تحميل الموديول) عشان يتقدر يتاختبر بمجلدات مؤقتة من غير أي state مشترك
function listBackups(dir = BACKUP_DIR) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .map((name) => {
      const m = FILENAME_RE.exec(name);
      if (!m) return null;
      const date = new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00Z`);
      return { name, fullPath: path.join(dir, name), date, year: Number(m[1]), month: Number(m[2]) };
    })
    .filter(Boolean)
    .sort((a, b) => a.date - b.date);
}

function applyRetentionPolicy(dir = BACKUP_DIR, now = new Date()) {
  const backups = listBackups(dir);
  const dailyCutoff = new Date(now.getTime() - DAILY_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const monthlyCutoff = new Date(now);
  monthlyCutoff.setMonth(monthlyCutoff.getMonth() - MONTHLY_RETENTION_MONTHS);

  const toKeep = new Set();
  const keptMonths = new Set(); // "YYYY-MM" - أول نسخة نشوفها في كل شهر (الأقدم، بالترتيب الصاعد) هي اللي بتتحفظ
  const keptYears = new Set(); // "YYYY" - نفس الفكرة سنويًا

  for (const b of backups) {
    if (b.date >= dailyCutoff) {
      toKeep.add(b.name); // جوه نافذة الـ30 يوم - كله بيتحفظ
      continue;
    }
    if (b.date >= monthlyCutoff) {
      const key = `${b.year}-${b.month}`;
      if (!keptMonths.has(key)) { keptMonths.add(key); toKeep.add(b.name); }
      continue;
    }
    const key = String(b.year);
    if (!keptYears.has(key)) { keptYears.add(key); toKeep.add(b.name); }
  }

  let deleted = 0;
  for (const b of backups) {
    if (!toKeep.has(b.name)) {
      fs.unlinkSync(b.fullPath);
      console.log(`اتمسحت (خارج سياسة الاحتفاظ): ${b.name}`);
      deleted++;
    }
  }
  console.log(`سياسة الاحتفاظ: ${toKeep.size} نسخة محفوظة، ${deleted} اتمسحت`);
  return { kept: toKeep.size, deleted };
}

async function main() {
  await createBackup();
  applyRetentionPolicy();
}

if (require.main === module) {
  main().catch((err) => {
    console.error("فشل النسخ الاحتياطي:", err.message);
    process.exit(1);
  });
}

module.exports = { createBackup, listBackups, applyRetentionPolicy, BACKUP_DIR };
