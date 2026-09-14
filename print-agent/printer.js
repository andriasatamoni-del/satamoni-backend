// طبقة الطباعة الفعلية - Puppeteer بيفتح نسخة Chromium معزولة تمامًا وبيطبع بنفس آلية المتصفح العادي
// بالظبط (window.print() فعليًا، مش توليد PDF وسيط) - نفس الآلية اللي شاشات ستاموني القديمة
// (print-tickets.js، زرار "إعادة طباعة" في متابعة الطلبات) بتستخدمها وبتطبع صح على نفس الطابعة دايمًا.
//
// جرّبنا الأول توليد PDF بحجم مضبوط وبعته بـpdf-to-printer (SumatraPDF) - اتأكد فعليًا على XP-D200N
// إنه بيطبع الإيصالات الطويلة صح، لكن تذاكر المطبخ القصيرة كانت بتطلع منزّحة/مقطوعة رغم كل محاولات
// ضبط المقاس - بينما "إعادة طباعة" من متابعة الطلبات (اللي بتستخدم window.print() من المتصفح مباشرة)
// كانت بتطبع نفس المحتوى صح تمامًا كل مرة. يبقى المشكلة مش في المحتوى ولا في الطابعة - في مسار
// SumatraPDF نفسه. الحل: نستخدم نفس آلية window.print() المضمونة، بس من غير المستخدم يشوف أي حاجة
// (--kiosk-printing بيمنع ظهور نافذة/dialog الطباعة، ونافذة Chromium نفسها برّه حدود الشاشة تمامًا).
//
// قيد واحد مهم: --kiosk-printing بيطبع على "الطابعة الافتراضية" في ويندوز بس (مش بيقبل تحديد طابعة
// لكل طبعة لوحدها زي pdf-to-printer). عشان نفضل نقدر نوجّه لأكتر من طابعة (كاشير/مطبخ/دليفري)، بنغيّر
// الطابعة الافتراضية لحظيًا قبل كل أمر طباعة (setDefaultPrinter) - آمن لأن الطابور بيتعالج واحد واحد
// بالترتيب (index.js) مش بالتوازي، فمفيش تعارض بين أمرين بيغيّروا الافتراضية في نفس اللحظة.
const puppeteer = require("puppeteer");
const { exec } = require("child_process");
const { promisify } = require("util");
const execAsync = promisify(exec);

let browserPromise = null;
function getBrowser() {
  if (!browserPromise) {
    browserPromise = puppeteer.launch({
      headless: false, // لازم non-headless عشان window.print() يوصل فعليًا لطابور طباعة ويندوز
      args: [
        "--kiosk-printing", // يطبع فورًا صامت من غير أي نافذة/dialog تأكيد
        "--window-position=-3000,-3000", // برّه حدود الشاشة تمامًا - المستخدم مايشوفهاش خالص
        "--window-size=420,600",
      ],
    });
  }
  return browserPromise;
}

// بيغيّر الطابعة الافتراضية في ويندوز لحظيًا - لازم يحصل قبل كل window.print() عشان --kiosk-printing
// يستهدف الطابعة الصح. PowerShell (Win32_Printer + SetDefaultPrinter) موجود افتراضيًا في أي ويندوز 10/11
async function setDefaultPrinter(osPrinterName) {
  const escaped = osPrinterName.replace(/'/g, "''");
  const cmd = `powershell -NoProfile -Command "(Get-CimInstance -ClassName Win32_Printer -Filter \\"Name='${escaped}'\\") | Invoke-CimMethod -MethodName SetDefaultPrinter"`;
  await execAsync(cmd);
}

// المرحلة 9A-10: قبل كده markPrinted() في index.js كان بيتنادى بمجرد ما window.print() يرجع من غير
// استثناء - يعني بمجرد ما Chromium يسلّم أمر الطباعة لطابور ويندوز، مش بمجرد ما الورقة تخرج فعليًا من
// الطابعة. لو الطابعة كانت أوفلاين/الورق خلص/الكابل اتقطع لحظة الإرسال، Chromium برضو بيرجّع نجاح عادي
// (هو مسؤوليته تسليم الأمر للسبولر بس، مش تأكيد الطباعة الفعلية) - فالـjob كان بيتسجل PRINTED في
// القاعدة رغم إن مفيش ورقة خرجت خالص، ومحدش كان هيعرف غير لو الكاشير لاحظ بنفسه.
//
// الحل جزئين: (1) فحص حالة الطابعة نفسها قبل الإرسال - لو أوفلاين/فيها مشكلة معروفة بالفعل، نرفض
// المحاولة من الأساس برسالة واضحة بدل فشل غامض بعدين. (2) فحص طابور السبولر بعد الإرسال - لو الـjob
// لسه عالق فيه بحالة خطأ (ورق خلص أثناء الطباعة، الطابعة اتفصلت لحظة الإرسال...) ده أقرب دليل فعلي
// متاح لنا إن الطباعة الحقيقية فشلت رغم إن window.print() رجع من غير استثناء. الاتنين بيستخدموا
// PrintManagement module (Get-Printer/Get-PrintJob) الموجود افتراضيًا في ويندوز 10/11 - مفيش تثبيت إضافي
async function getPrinterStatus(osPrinterName) {
  const escaped = osPrinterName.replace(/'/g, "''");
  const cmd = `powershell -NoProfile -Command "Get-Printer -Name '${escaped}' | Select-Object PrinterStatus, WorkOffline | ConvertTo-Json -Compress"`;
  const { stdout } = await execAsync(cmd);
  const trimmed = stdout.trim();
  return trimmed ? JSON.parse(trimmed) : {};
}

async function getStuckSpoolerJobs(osPrinterName) {
  const escaped = osPrinterName.replace(/'/g, "''");
  const cmd =
    `powershell -NoProfile -Command "Get-PrintJob -PrinterName '${escaped}' -ErrorAction SilentlyContinue | ` +
    `Where-Object { $_.JobStatus -match 'Error|PaperOut|PrinterOffline|UserIntervention|Blocked|PaperProblem' } | ` +
    `Select-Object Id, JobStatus | ConvertTo-Json -Compress"`;
  const { stdout } = await execAsync(cmd);
  const trimmed = stdout.trim();
  if (!trimmed) return [];
  const parsed = JSON.parse(trimmed);
  return Array.isArray(parsed) ? parsed : [parsed];
}

// {html, osPrinterName} - بيرمي استثناء لو فشلت الطباعة فعليًا (الـcaller في index.js مسؤول عن
// تبليغ الباك إند FAILED وعدم إيقاف باقي الطابور)
async function printJobContent({ html, osPrinterName }) {
  if (!osPrinterName) throw new Error("الطابعة دي معندهاش اسم نظام تشغيل (os_printer_name) مسجّل - ظبّطها من إعدادات الطباعة");

  const statusBefore = await getPrinterStatus(osPrinterName);
  if (statusBefore.WorkOffline || (statusBefore.PrinterStatus && statusBefore.PrinterStatus !== "Normal")) {
    throw new Error(`الطابعة ${osPrinterName} مش جاهزة حاليًا (${statusBefore.PrinterStatus || "أوفلاين"}) - راجعها (ورق/كابل/تشغيل) قبل المحاولة تاني`);
  }

  await setDefaultPrinter(osPrinterName);
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.setContent(html, { waitUntil: "load" });
    await page.evaluate(() => window.print());
    // مفيش dialog نستنى قفوله (kiosk-printing بيطبع صامت فورًا) - بس محتاجين نسيب وقت كافي قبل ما نتحقق
    // من السبولر عشان نضمن إن أمر الطباعة اتسلّم فعليًا لطابور ويندوز الأول
    await new Promise((r) => setTimeout(r, 2000));

    const stuckJobs = await getStuckSpoolerJobs(osPrinterName);
    if (stuckJobs.length > 0) {
      throw new Error(
        `أمر الطباعة عالق في طابور ${osPrinterName} بحالة خطأ (${stuckJobs.map((j) => j.JobStatus).join(", ")}) - الورقة متأكدناش إنها خرجت فعليًا`
      );
    }
  } finally {
    await page.close();
  }
}

async function closeBrowser() {
  if (browserPromise) {
    const b = await browserPromise;
    await b.close();
    browserPromise = null;
  }
}

module.exports = { printJobContent, closeBrowser };
