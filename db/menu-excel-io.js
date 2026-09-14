// استيراد/تصدير شيت إكسيل للمنيو - تعديل جماعي للأسعار أو الريسبي بدل ما كل صنف يتعدّل لوحده من الشاشة.
// نفس فلسفة استيراد كشوف التسوية (db/payment-reconciliation-import.js): الشيت المُصدَّر من النظام نفسه
// بعناوين أعمدة ثابتة (عشان مفيش تخمين أعمى لأعمدة)، بيتحمّل تاني بعد التعديل، وبيتقرا بنفس القارئ العام
// (readStatementGrid بيتعامل مع .xlsx و.csv بنفس الـAPI).
const ExcelJS = require("exceljs");
const { readStatementGrid } = require("./payment-reconciliation-import");

const PRICE_HEADERS = ["القسم", "الصنف", "الحجم", "السعر العادي", "سعر طلبات"];
const RECIPE_HEADERS = ["القسم", "الصنف", "الحجم", "المكوّن", "الكمية لكل وحدة", "الوحدة (للعرض فقط - متتعدلش)"];

async function buildWorkbook(headers, rows, sheetName) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(sheetName);
  sheet.addRow(headers);
  sheet.getRow(1).font = { bold: true };
  for (const row of rows) sheet.addRow(row);
  sheet.columns.forEach((col) => { col.width = 24; });
  return workbook.xlsx.writeBuffer();
}

// rows: [{category, item, variant, price, talabatPrice}]
async function buildPricesWorkbook(rows) {
  return buildWorkbook(
    PRICE_HEADERS,
    rows.map((r) => [r.category, r.item, r.variant, r.price, r.talabatPrice ?? ""]),
    "أسعار المنيو"
  );
}

// rows: [{category, item, variant, ingredient, quantityPerUnit, unit}]
async function buildRecipesWorkbook(rows) {
  return buildWorkbook(
    RECIPE_HEADERS,
    rows.map((r) => [r.category, r.item, r.variant, r.ingredient, r.quantityPerUnit, r.unit]),
    "ريسبي المنيو"
  );
}

// أول صف بيتشال لو أول خلية فيه = "القسم" (عنوان الشيت المُصدَّر) - الشيت مُصدَّر من النظام نفسه فمفيش
// داعي لتخمين، بس بنتأكد بدل ما نفترض دايمًا عشان لو حد مسح صف العناوين بالغلط منعملش تخطي غلط لأول صف بيانات
function stripHeaderRow(grid) {
  if (grid.length > 0 && String(grid[0][0] ?? "").trim() === "القسم") return grid.slice(1);
  return grid;
}

function cellText(v) {
  return v === null || v === undefined ? "" : String(v).trim();
}

function cellNumber(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
}

function parsePricesGrid(grid) {
  return stripHeaderRow(grid)
    .filter((r) => r.some((c) => c !== null && c !== undefined && c !== ""))
    .map((r) => ({
      category: cellText(r[0]),
      item: cellText(r[1]),
      variant: cellText(r[2]),
      price: cellNumber(r[3]),
      talabatPrice: cellNumber(r[4]),
    }));
}

function parseRecipesGrid(grid) {
  return stripHeaderRow(grid)
    .filter((r) => r.some((c) => c !== null && c !== undefined && c !== ""))
    .map((r) => ({
      category: cellText(r[0]),
      item: cellText(r[1]),
      variant: cellText(r[2]),
      ingredient: cellText(r[3]),
      quantityPerUnit: cellNumber(r[4]),
    }));
}

module.exports = {
  readStatementGrid, buildPricesWorkbook, buildRecipesWorkbook, parsePricesGrid, parseRecipesGrid,
};
