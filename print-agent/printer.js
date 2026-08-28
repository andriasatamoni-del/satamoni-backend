// طبقة الطباعة الفعلية - Puppeteer بيرندر محتوى الـjob (HTML جاهز من db/print-templates.js) لـPDF بحجم
// ورق الطابعة الحرارية بالظبط (عرض ثابت + ارتفاع محسوب من طول المحتوى فعليًا، زي أي إيصال حراري حقيقي)،
// وبعدين pdf-to-printer بيبعت الـPDF ده صامت تمامًا (من غير أي نافذة/print dialog) للطابعة المستهدفة
// بالاسم بالظبط (os_printer_name). ده الحل اللي بيتجنب المشكلة اللي واجهناها فعليًا مع Chrome العادي
// (--kiosk-printing بيتأثر بأي نسخة Chrome شغالة بالفعل على الجهاز) - Puppeteer هنا بيشغّل نسخة Chromium
// منعزلة تمامًا عن أي حاجة تانية شغالة على الجهاز.
const puppeteer = require("puppeteer");
const { print: printPdf, getPrinters } = require("pdf-to-printer");
const fs = require("fs");
const os = require("os");
const path = require("path");

let browserPromise = null;
function getBrowser() {
  if (!browserPromise) {
    browserPromise = puppeteer.launch({ headless: true });
  }
  return browserPromise;
}

// PX -> MM (96 DPI، نفس معيار CSS القياسي) + هامش بسيط تحت عشان أي فاصل/سطر أخير ميتقصش
function pxToMm(px) {
  return (px * 25.4) / 96;
}

async function renderHtmlToPdf(html, paperWidthMm) {
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.setContent(html, { waitUntil: "load" });
    const heightPx = await page.evaluate(() => document.body.scrollHeight);
    const widthMm = paperWidthMm || 80;
    // اتأكد فعليًا على XP-D200N: مستندات قصيرة (تذكرة صنف واحد، ~30-40mm ارتفاع) طلعت مقلوبة landscape
    // وبخط صغير جدًا. السبب الحقيقي: صفحة عرضها (80mm) أكبر من ارتفاعها (30mm) شكلها هندسيًا landscape
    // (عرض > ارتفاع)، ومحرك الطباعة/الدرايفر بيتعامل مع أي صفحة عرضها أكبر من ارتفاعها كـlandscape
    // تلقائيًا بغض النظر عن نية المحتوى - "-print-settings noscale" (تحت) بيوقف التكبير/التصغير بس مش
    // كافي لوحده. الحل الحقيقي: الارتفاع مينفعش يفضل أصغر من العرض أبدًا - نضمن كده إن الصفحة تفضل
    // portrait هندسيًا دايمًا (ارتفاع >= عرض)، حتى لو ده معناه مساحة بيضا فاضية تحت في التذاكر القصيرة -
    // ده تكلفة ورق بسيطة جدًا مقابل ضمان الطباعة صح كل مرة
    const heightMm = Math.max(widthMm + 10, Math.ceil(pxToMm(heightPx)) + 8);
    const pdfPath = path.join(os.tmpdir(), `satamoni-print-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.pdf`);
    await page.pdf({
      path: pdfPath, width: `${widthMm}mm`, height: `${heightMm}mm`,
      printBackground: true, margin: { top: 0, bottom: 0, left: 0, right: 0 },
    });
    return pdfPath;
  } finally {
    await page.close();
  }
}

// {html, paperWidthMm, osPrinterName} - بيرمي استثناء لو فشلت الطباعة (الـcaller في index.js مسؤول عن
// تبليغ الباك إند FAILED وعدم إيقاف باقي الطابور)
async function printJobContent({ html, paperWidthMm, osPrinterName }) {
  if (!osPrinterName) throw new Error("الطابعة دي معندهاش اسم نظام تشغيل (os_printer_name) مسجّل - ظبّطها من إعدادات الطباعة");
  const pdfPath = await renderHtmlToPdf(html, paperWidthMm);
  try {
    // pdf-to-printer (SumatraPDF من جواه) افتراضيًا بيعمل "Fit to Page" - بيكبّر/يصغّر أي PDF عشان يملي
    // حجم الورق المُعرَّف في درايفر الطابعة نفسه في ويندوز، حتى لو الـPDF نفسه متولّد بحجم مضبوط بالظبط.
    // "noscale" بيوقف ده - الطباعة بتحصل بالمقاس الحقيقي 1:1 اللي احنا حددناه (paperWidthMm/heightMm)
    // بدل ما تتصغّر/تتكبّر تلقائي. مشكلة الاتجاه (landscape) اتحلت من مصدرها في renderHtmlToPdf فوق -
    // بضمان إن الصفحة تفضل portrait هندسيًا دايمًا، مش هنا
    await printPdf(pdfPath, { printer: osPrinterName, win32: ["-print-settings", "noscale"] });
  } finally {
    fs.unlink(pdfPath, () => {});
  }
}

async function closeBrowser() {
  if (browserPromise) {
    const b = await browserPromise;
    await b.close();
    browserPromise = null;
  }
}

module.exports = { printJobContent, closeBrowser, listSystemPrinters: getPrinters };
