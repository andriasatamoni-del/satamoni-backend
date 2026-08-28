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
    const heightMm = Math.max(30, Math.ceil(pxToMm(heightPx)) + 8);
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
    await printPdf(pdfPath, { printer: osPrinterName });
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
