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

// {html, paperWidthMm, osPrinterName} - بيرمي استثناء لو فشلت الطباعة (الـcaller في index.js مسؤول عن
// تبليغ الباك إند FAILED وعدم إيقاف باقي الطابور)
async function printJobContent({ html, osPrinterName }) {
  if (!osPrinterName) throw new Error("الطابعة دي معندهاش اسم نظام تشغيل (os_printer_name) مسجّل - ظبّطها من إعدادات الطباعة");
  await setDefaultPrinter(osPrinterName);
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.setContent(html, { waitUntil: "load" });
    await page.evaluate(() => window.print());
    // مفيش dialog نستنى قفوله (kiosk-printing بيطبع صامت فورًا) - بس محتاجين نسيب وقت كافي قبل ما نقفل
    // الصفحة عشان نضمن إن أمر الطباعة اتبعت فعليًا لطابور ويندوز قبل ما ننتقل للـjob اللي بعده
    await new Promise((r) => setTimeout(r, 2000));
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
