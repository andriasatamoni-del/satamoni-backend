// Payment Control & Reconciliation - Phase 2: استيراد ملفات (CSV/Excel) لكشوف طلبات/فيزا/إنستاباي/
// أورانج كاش بدل إدخال كل سطر يدوي في تبويب المطابقة. لحظة كتابة الكود ده، مفيش ملف حقيقي من أي مزوّد
// (طلبات/فيزا/إنستاباي/أورانج كاش) اتاح للمراجعة - فبدل ما نخمّن أسماء أعمدة ثابتة ونخاطر إننا نقرأ عمود
// غلط بصمت (خطر حقيقي في أداة كشف احتيال)، الاستيراد هنا **موضعي بالكامل**: بنعرض للمحاسب عيّنة من صفوف
// الملف الخام وهو بيحدد بنفسه أي عمود التاريخ/المبلغ/المرجع (routes/payment-control.js::/import/preview
// ثم /import/commit) - نفس فلسفة "الإنسان بيقرر، النظام بيقارن" بتاعة المطابقة كلها. لما ملف حقيقي
// يتاح، ممكن نضيف تخمين تلقائي لأسماء الأعمدة فوق الآلية دي من غير ما نغيّرها (تحسين، مش استبدال).
const ExcelJS = require("exceljs");
const { Readable } = require("stream");

const MAX_PREVIEW_ROWS = 15;

// بيقرا أي ملف (.csv أو .xlsx) لشبكة صفوف خام (arrays of cell values) - ExcelJS بيتعامل مع الاتنين
// بنفس الـAPI تقريبًا؛ الفرق بس في طريقة القراءة (csv.read لملف نصي، xlsx.load لملف ثنائي حقيقي)
async function readStatementGrid(buffer, originalName) {
  const workbook = new ExcelJS.Workbook();
  const isCsv = /\.csv$/i.test(originalName || "");
  try {
    if (isCsv) {
      await workbook.csv.read(Readable.from([buffer.toString("utf8")]));
    } else {
      await workbook.xlsx.load(buffer);
    }
  } catch (err) {
    throw new Error(`تعذّرت قراءة الملف - اتأكد إنه CSV أو Excel (.xlsx) سليم: ${err.message}`);
  }
  const worksheet = workbook.worksheets[0];
  if (!worksheet) throw new Error("الملف مفيهوش أي شيت بيانات");

  const grid = [];
  worksheet.eachRow({ includeEmpty: false }, (row) => {
    // row.values[0] فاضي دايمًا (ExcelJS بيرقّم الأعمدة من 1) - بنشيله عشان الصف يبدأ من العمود الأول فعليًا
    const values = row.values.slice(1).map((v) => (v && typeof v === "object" && v.text !== undefined ? v.text : v));
    grid.push(values);
  });
  if (grid.length === 0) throw new Error("الملف مفيهوش أي صفوف");
  return grid;
}

// معاينة سريعة لأول كام صف - عشان شاشة الاستيراد تعرضهم للمحاسب يختار الأعمدة بناءً عليهم
async function previewStatementFile(buffer, originalName) {
  const grid = await readStatementGrid(buffer, originalName);
  const columnCount = Math.max(...grid.map((r) => r.length));
  return {
    columnCount,
    totalRows: grid.length,
    sampleRows: grid.slice(0, MAX_PREVIEW_ROWS),
  };
}

// تطبيع خلية تاريخ - ExcelJS بيرجّع خلايا التاريخ الحقيقية في xlsx كـJS Date object جاهز. النص الخام
// (من CSV أو عمود نصي في xlsx) بيتقرا بصيغ شائعة محليًا - DD/MM/YYYY هي الافتراض عند الغموض (مش
// MM/DD/YYYY الأمريكي) لأنها الأكثر شيوعًا في كشوف حساب مصرية/إقليمية. لو الصيغة مختلفة فعليًا في ملف
// حقيقي، ده أول حاجة تتظبط لاحقًا بمعاينة الأعمدة نفسها (مش تخمين أعمى في الكود)
function normalizeDateCell(value) {
  if (value instanceof Date && !isNaN(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    // رقم تسلسلي بتاع Excel (نادر من ExcelJS نفسه لأنه بيحوّل التواريخ الحقيقية أوتوماتيك، لكن ممكن
    // يحصل لو الملف نفسه مخزّن فيه رقم خام) - يوم 0 = 1899-12-30 في نظام Excel
    const epoch = new Date(Date.UTC(1899, 11, 30));
    const d = new Date(epoch.getTime() + value * 86400000);
    return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
  }
  if (typeof value === "string") {
    const s = value.trim();
    if (!s) return null;
    let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
    m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
    if (m) {
      const [, d, mo, y] = m;
      return `${y}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}`;
    }
    const parsed = new Date(s);
    if (!isNaN(parsed.getTime())) return parsed.toISOString().slice(0, 10);
  }
  return null;
}

// تطبيع خلية مبلغ - بيشيل رمز العملة/فواصل الآلاف/مسافات، بيفهم الأقواس كسالب (اتفاقية محاسبية شائعة
// لمبالغ مرتجعة/مدينة في بعض الكشوف)
function normalizeAmountCell(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    let s = value.trim();
    if (!s) return null;
    const isNegativeParens = /^\(.*\)$/.test(s);
    s = s.replace(/[(),\s]/g, "").replace(/[^\d.\-]/g, "");
    const n = parseFloat(s);
    if (isNaN(n)) return null;
    return isNegativeParens ? -Math.abs(n) : n;
  }
  return null;
}

// بيحوّل الشبكة الخام لصفوف {externalDate, externalAmount, externalReference} حسب اختيار المحاسب
// للأعمدة - أي صف فيه تاريخ أو مبلغ مش مفهوم بيتسجل في errors (برقم الصف) وبيتخطّى، مش بيوقف باقي
// الاستيراد (نفس فلسفة استيراد الرواتب: صف واحد غلط ميبوّظش الملف كله)
function extractStatementRows(grid, { dateColumn, amountColumn, referenceColumn, hasHeaderRow }) {
  const rows = hasHeaderRow ? grid.slice(1) : grid;
  const startRowNumber = hasHeaderRow ? 2 : 1;
  const extracted = [];
  const errors = [];

  rows.forEach((row, i) => {
    const rowNumber = startRowNumber + i;
    if (row.every((c) => c === null || c === undefined || c === "")) return; // صف فاضي بالكامل - تجاهل صامت

    const externalDate = normalizeDateCell(row[dateColumn]);
    const externalAmount = normalizeAmountCell(row[amountColumn]);
    const externalReference = referenceColumn !== null && referenceColumn !== undefined
      ? (row[referenceColumn] !== undefined && row[referenceColumn] !== null ? String(row[referenceColumn]).trim() : null)
      : null;

    if (!externalDate) { errors.push({ row: rowNumber, message: "تاريخ غير مفهوم" }); return; }
    if (externalAmount === null || externalAmount === undefined) { errors.push({ row: rowNumber, message: "مبلغ غير مفهوم" }); return; }
    if (externalAmount <= 0) { errors.push({ row: rowNumber, message: "المبلغ لازم يكون أكبر من صفر" }); return; }

    extracted.push({ externalDate, externalAmount, externalReference, rowNumber });
  });

  return { rows: extracted, errors };
}

module.exports = { readStatementGrid, previewStatementFile, extractStatementRows, normalizeDateCell, normalizeAmountCell };
