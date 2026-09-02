// المرحلة 8.35: استيراد بيانات الرواتب الحقيقية (موظفين + بصمة + حضور المطبخ المركزي + سلف/جزاءات/مكافآت)
// مباشرة من ملف "ستاموني - نظام حساب المرتبات الشهري" (نفس الشكل بالظبط اللي شرحه شيت "التعليمات" جوه
// الملف نفسه) - عشان يتكرر كل شهر (يوليو، أغسطس...) من غير ما حد يحتاج يبعتلنا الملف نتعامل معاه يدويًا.
//
// قواعد الاستبعاد (بالظبط زي ما طلب صاحب العمل): أي صف موظف من غير اسم حقيقي، أو من غير راتب فعلي
// (صفر/فاضي)، أو صف مثال/قالب - يتستبعد تمامًا. بصمات الفروع: بس أيام فيها بصمة دخول أو خروج حقيقية
// (مش أيام "اجازة" التلقائية) لموظف متضمّن فعلاً، وبس شهر/سنة الاستيراد المطلوب (يوم خارج نطاق الشهر
// بيتستبعد زي ما شيت البصمة نفسه بيعمل بالظبط).
const ExcelJS = require("exceljs");

// مطابقة اسم الفرع بالحرف بالظبط بتفشل بسهولة مع الأسماء العربية - نفس الاسم اللي شكله متطابق بصريًا
// ممكن يتكتب بأكتر من شكل يونيكود مختلف فعليًا (زي "الإبراهيمية" بهمزة تحت الألف مقابل "الابراهيمية"
// بألف عادية، أو "ة" مقابل "ه" في الآخر) حسب طريقة كتابة الشخص اللي سجّل اسم الفرع أول مرة في السيستم.
// عشان استيراد شهري متكرر (يوليو، أغسطس...) يفضل شغال من غير ما نضطر نلاحق كل اختلاف إملائي بالعين،
// بنطابق أسماء الفروع بعد تطبيع بسيط (شيل الهمزات/التشكيل، توحيد الألف والياء والتاء المربوطة) بدل
// المطابقة الحرفية - بس التخزين والعرض في الداتابيز بيفضلوا زي ما هم بالظبط (التطبيع للمطابقة بس)
function normalizeArabicName(s) {
  return String(s || "")
    .trim()
    .replace(/[ً-ْٰـ]/g, "") // تشكيل + تطويل
    .replace(/[أإآا]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/\s+/g, " ");
}

const ATTENDANCE_SYSTEM_MAP = {
  "بصمة تلقائي": "fingerprint_auto",
  "يدوي (بدون بصمة)": "manual",
  "بدون تتبع حضور": "none",
};
const SHIFT_MAP = { "صباحي": "morning", "مسائي": "evening", "بيني": "flexible" };
const WAGE_TYPE_MAP = { "شهري ثابت": "fixed_monthly", "بالساعة": "hourly" };
const ADJUSTMENT_TYPE_MAP = { "سلفة": "advance", "جزاء": "penalty", "مكافأة": "bonus" };
const FINGERPRINT_BRANCH_COLUMNS = [
  { col: 15, branchName: "الإبراهيمية" },
  { col: 16, branchName: "العصافرة" },
  { col: 17, branchName: "محرم بك" },
];
const PUNCH_SHEETS = [
  { sheetName: "بصمة - الإبراهيمية", branchName: "الإبراهيمية" },
  { sheetName: "بصمة - العصافرة", branchName: "العصافرة" },
  { sheetName: "بصمة - محرم بك", branchName: "محرم بك" },
];

function cellValue(cell) {
  if (!cell) return null;
  const v = cell.value;
  if (v && typeof v === "object" && !(v instanceof Date)) {
    if (v.result !== undefined) return v.result; // خلية معادلة - القيمة المحسوبة المخزّنة
    if (v.text !== undefined) return v.text; // rich text
  }
  return v;
}

function textOf(cell) {
  const v = cellValue(cell);
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

function numberOf(cell) {
  const v = cellValue(cell);
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function timeOf(cell) {
  // خلايا الوقت في Excel بترجع Date (بتاريخ 1899/1900 وهمي) - إحنا محتاجين HH:MM بس
  const v = cellValue(cell);
  if (!v) return null;
  if (v instanceof Date) {
    const hh = String(v.getUTCHours()).padStart(2, "0");
    const mm = String(v.getUTCMinutes()).padStart(2, "0");
    return `${hh}:${mm}`;
  }
  return null;
}

function isTemplateRow(name) {
  return name.startsWith("اسم الموظف - مثال");
}
function isNoNameCode(name) {
  return /^كود\s+\S+\s*-\s*بدون اسم/.test(name);
}

function parseEmployeesSheet(workbook) {
  const sheet = workbook.getWorksheet("قاعدة بيانات الموظفين");
  if (!sheet) throw new Error("الشيت 'قاعدة بيانات الموظفين' مش موجود في الملف");

  const employees = []; // متضمّنة فعلاً - جاهزة للاستيراد
  const excluded = []; // مستبعدة (سبب واضح) - للشفافية بس، مش هتتحفظ
  const needsReview = []; // اسم + راتب حقيقيين، لكن ناقصها قسم/وظيفة - محتاجة تكميل يدوي قبل ما تتضاف

  sheet.eachRow((row, rowNumber) => {
    if (rowNumber < 3) return; // صف 1 عنوان، صف 2 هيدر
    const code = textOf(row.getCell(1));
    const rawName = textOf(row.getCell(2));
    if (!code && !rawName) return; // صف فاضي تمامًا

    const name = rawName;
    if (!name) {
      excluded.push({ row: rowNumber, code, reason: "من غير اسم" });
      return;
    }
    if (isTemplateRow(name)) {
      excluded.push({ row: rowNumber, code, name, reason: "صف مثال/قالب" });
      return;
    }
    if (isNoNameCode(name)) {
      excluded.push({ row: rowNumber, code, name, reason: "كود بصمة من غير اسم حقيقي" });
      return;
    }

    const baseSalary = numberOf(row.getCell(7)) || 0;
    if (!baseSalary) {
      excluded.push({ row: rowNumber, code, name, reason: "من غير راتب فعلي (صفر أو فاضي)" });
      return;
    }

    const department = textOf(row.getCell(3));
    const jobTitle = textOf(row.getCell(4));
    if (!department || !jobTitle) {
      needsReview.push({
        row: rowNumber, code, name, department, jobTitle, baseSalary,
        reason: "من غير قسم أو وظيفة محدّدة - أضفه يدويًا من شاشة الموظفين بعد ما تحدّد قسمه",
      });
      return;
    }

    const attendanceSystemRaw = textOf(row.getCell(5));
    const attendanceSystem = ATTENDANCE_SYSTEM_MAP[attendanceSystemRaw] || null;
    if (!attendanceSystem) {
      needsReview.push({
        row: rowNumber, code, name, department, jobTitle, baseSalary,
        reason: `نظام حضور غير معروف: "${attendanceSystemRaw || ""}"`,
      });
      return;
    }

    const fingerprintCodes = {};
    for (const { col, branchName } of FINGERPRINT_BRANCH_COLUMNS) {
      const dc = textOf(row.getCell(col));
      if (dc) fingerprintCodes[branchName] = dc;
    }

    employees.push({
      employeeCode: code,
      name,
      department,
      jobTitle,
      attendanceSystem,
      hireDate: (() => {
        const v = cellValue(row.getCell(6));
        return v instanceof Date ? v.toISOString().slice(0, 10) : null;
      })(),
      baseSalary,
      workingDaysPerMonth: numberOf(row.getCell(8)) || 26,
      shift: SHIFT_MAP[textOf(row.getCell(9))] || null,
      phone: textOf(row.getCell(11)),
      notes: textOf(row.getCell(12)),
      wageType: WAGE_TYPE_MAP[textOf(row.getCell(13))] || "fixed_monthly",
      hourlyRate: numberOf(row.getCell(14)) || 0,
      fingerprintCodes,
      restrictedBranchName: textOf(row.getCell(19)),
      countDay31: textOf(row.getCell(20)) === "نعم",
    });
  });

  return { employees, excluded, needsReview };
}

function parsePunchSheets(workbook, includedEmployees, targetYear, targetMonth) {
  // عشان بس نستورد بصمات موظفين متضمّنين فعلاً (استبعاد "بصمة ملهاش موظف حقيقي وراها")
  const validDeviceCodesByBranch = {};
  for (const emp of includedEmployees) {
    for (const [branchName, code] of Object.entries(emp.fingerprintCodes)) {
      if (!validDeviceCodesByBranch[branchName]) validDeviceCodesByBranch[branchName] = new Set();
      validDeviceCodesByBranch[branchName].add(String(code).trim());
    }
  }

  const punchesByBranch = {};
  const warnings = [];

  for (const { sheetName, branchName } of PUNCH_SHEETS) {
    const sheet = workbook.getWorksheet(sheetName);
    if (!sheet) continue;
    const rows = [];
    const validCodes = validDeviceCodesByBranch[branchName] || new Set();

    sheet.eachRow((row, rowNumber) => {
      if (rowNumber < 4) return; // صف 1 عنوان، صف 2 تعليمات، صف 3 هيدر
      const deviceCode = textOf(row.getCell(2));
      if (!deviceCode) return;
      const dateVal = cellValue(row.getCell(4));
      if (!(dateVal instanceof Date)) return;
      if (dateVal.getUTCFullYear() !== targetYear || dateVal.getUTCMonth() + 1 !== targetMonth) return;

      const clockIn = timeOf(row.getCell(5));
      const clockOut = timeOf(row.getCell(6));
      if (!clockIn && !clockOut) return; // يوم "اجازة" تلقائي - مفيش بصمة حقيقية، مش هيتستورد كسطر

      if (!validCodes.has(deviceCode)) return; // كود بصمة مش تابع لموظف متضمّن فعلاً

      const y = dateVal.getUTCFullYear();
      const m = String(dateVal.getUTCMonth() + 1).padStart(2, "0");
      const d = String(dateVal.getUTCDate()).padStart(2, "0");
      rows.push({ deviceCode, date: `${y}-${m}-${d}`, clockIn, clockOut });
    });

    if (rows.length > 0) punchesByBranch[branchName] = rows;
  }

  return { punchesByBranch, warnings };
}

function parseCentralKitchenSheet(workbook, includedEmployeeCodes) {
  const sheet = workbook.getWorksheet("حضور المطبخ المركزي (يدوي)");
  if (!sheet) return [];
  const rows = [];
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber < 4) return;
    const code = textOf(row.getCell(1));
    if (!code || !includedEmployeeCodes.has(code)) return;
    rows.push({
      employeeCode: code,
      presentDays: numberOf(row.getCell(3)) || 0,
      absentDays: numberOf(row.getCell(4)) || 0,
      totalLateMinutes: numberOf(row.getCell(5)) || 0,
      manualDeduction: numberOf(row.getCell(6)) || 0,
      notes: textOf(row.getCell(7)),
    });
  });
  return rows;
}

function parseAdjustmentsSheet(workbook, includedEmployeeCodes, targetYear, targetMonth) {
  const sheet = workbook.getWorksheet("السلف والجزاءات والمكافآت");
  if (!sheet) return [];
  const rows = [];
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber < 3) return; // صف 1 عنوان، صف 2 هيدر
    const dateVal = cellValue(row.getCell(1));
    const code = textOf(row.getCell(2));
    const typeRaw = textOf(row.getCell(4));
    const amount = numberOf(row.getCell(5));
    if (!(dateVal instanceof Date) || !code || !typeRaw || !amount) return;
    if (dateVal.getUTCFullYear() !== targetYear || dateVal.getUTCMonth() + 1 !== targetMonth) return;
    if (!includedEmployeeCodes.has(code)) return;
    const adjustmentType = ADJUSTMENT_TYPE_MAP[typeRaw];
    if (!adjustmentType) return;

    const y = dateVal.getUTCFullYear();
    const m = String(dateVal.getUTCMonth() + 1).padStart(2, "0");
    const d = String(dateVal.getUTCDate()).padStart(2, "0");
    rows.push({
      employeeCode: code, entryDate: `${y}-${m}-${d}`, adjustmentType, amount,
      notes: textOf(row.getCell(6)),
    });
  });
  return rows;
}

async function parsePayrollWorkbook(buffer, { targetYear, targetMonth }) {
  if (!targetYear || !targetMonth || targetMonth < 1 || targetMonth > 12) {
    throw new Error("لازم تحدد سنة وشهر صحيحين للاستيراد");
  }
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);

  const { employees, excluded, needsReview } = parseEmployeesSheet(workbook);
  const includedEmployeeCodes = new Set(employees.map((e) => e.employeeCode));

  const { punchesByBranch, warnings } = parsePunchSheets(workbook, employees, targetYear, targetMonth);
  const manualAttendance = parseCentralKitchenSheet(workbook, includedEmployeeCodes);
  const adjustments = parseAdjustmentsSheet(workbook, includedEmployeeCodes, targetYear, targetMonth);

  return { employees, excluded, needsReview, punchesByBranch, manualAttendance, adjustments, warnings };
}

module.exports = { parsePayrollWorkbook, normalizeArabicName };
