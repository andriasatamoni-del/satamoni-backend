// المرحلة 8.35: استيراد ملف "ستاموني - نظام حساب المرتبات الشهري" (موظفين + بصمة 3 فروع + حضور المطبخ
// المركزي اليدوي + سلف/جزاءات/مكافآت) - بنبني نسخة مصغّرة من نفس شكل الملف الحقيقي بالظبط (نفس أسماء
// الشيتات، نفس ترتيب الأعمدة) عشان نتأكد من قواعد الاستبعاد (بدون اسم/بدون راتب فعلي/صف مثال/بدون بصمة
// حقيقية) وسلوك الاستيراد (upsert آمن التكرار، استبعاد شهر خارج النطاق، تجاهل فرع مش موجود بتحذير).
const ExcelJS = require("exceljs");
const { app, request, pool, seedUser, login, authed } = require("./helpers");

async function buildWorkbook() {
  const wb = new ExcelJS.Workbook();

  const emp = wb.addWorksheet("قاعدة بيانات الموظفين");
  emp.addRow(["قاعدة بيانات الموظفين"]);
  emp.addRow(["كود الموظف الداخلي", "الاسم بالكامل", "القسم", "الوظيفة", "نظام الحضور", "تاريخ التعيين",
    "الراتب الأساسي الشهري", "أيام العمل بالشهر", "الشيفت", "وقت الدخول الافتراضي", "الهاتف", "ملاحظات",
    "نوع الأجر", "أجر الساعة (جنيه)", "كود بصمة الإبراهيمية", "كود بصمة العصافرة", "كود بصمة محرم بك",
    "تحقق من تكرار الكود", "احسب الراتب من فرع واحد فقط (اختياري)", "احتساب يوم 31 في الشهر؟"]);
  // موظف عادي متضمّن - بصمة تلقائي بفرع الإبراهيمية-جست
  emp.addRow(["E9001", "أحمد اختبار-جست", "بيتزا", "شيف بيتزا", "بصمة تلقائي", null, 9000, 26, "صباحي",
    null, null, null, "شهري ثابت", 0, "501", null, null, null, null, "لا"]);
  // صف مثال/قالب - لازم يتستبعد
  emp.addRow(["E9002", "اسم الموظف - مثال (تجربة)", "بيتزا", "شيف بيتزا", "بصمة تلقائي", "2025-01-01",
    3500, 26, "صباحي", null, null, "صف مثال", "شهري ثابت", 0, null, null, null, null, null, "لا"]);
  // كود بصمة من غير اسم حقيقي - لازم يتستبعد
  emp.addRow(["E9003", "كود 999 - بدون اسم", null, null, "بصمة تلقائي", null, 0, 26, "صباحي", null, null,
    null, "شهري ثابت", 0, "502", null, null, null, null, "لا"]);
  // اسم حقيقي بس راتب صفر - لازم يتستبعد
  emp.addRow(["E9004", "سارة اختبار-جست", "بيتزا", "مساعد شيف بيتزا", "بصمة تلقائي", null, 0, 26, "صباحي",
    null, null, "أكمل الراتب", "شهري ثابت", 0, null, null, null, null, null, "لا"]);
  // اسم وراتب حقيقيين بس من غير قسم/وظيفة - يروح needsReview مش يتستورد
  emp.addRow(["E9005", "منى اختبار-جست", null, null, "بصمة تلقائي", null, 5000, 26, "صباحي", null, null,
    null, "شهري ثابت", 0, null, null, null, null, null, "لا"]);
  // موظف مطبخ مركزي يدوي - للحضور اليدوي
  emp.addRow(["E9006", "يوسف اختبار-جست", "المطبخ المركزي", "ستيوارد", "يدوي (بدون بصمة)", null, 4000, 26,
    null, null, null, null, "شهري ثابت", 0, null, null, null, null, null, "لا"]);
  // موظف بدون تتبع حضور - للسلف/الجزاءات فقط
  emp.addRow(["E9007", "محاسبة اختبار-جست", "حسابات", "محاسب", "بدون تتبع حضور", null, 8000, 26, null,
    null, null, null, "شهري ثابت", 0, null, null, null, null, null, "لا"]);
  // راتب مكتوب رقميًا رغم ملاحظة "غير مؤكد" - المستخدم قرر نستورده زي ما هو مكتوب
  emp.addRow(["E9008", "بيشوي اختبار-جست", "تشغيل الفرع", "كاشير", "بصمة تلقائي", null, 4800, 26, "مسائي",
    null, null, "⚠ الراتب الأساسي غير معروف - أكمله", "شهري ثابت", 0, null, null, "701", null, null, "لا"]);

  const punch1 = wb.addWorksheet("بصمة - الإبراهيمية");
  punch1.addRow(["سجل البصمة - فرع الإبراهيمية"]);
  punch1.addRow(["تعليمات..."]);
  punch1.addRow(["Emp No.", "AC-No.", "Name", "Date", "Clock In", "Clock Out", "Work Time"]);
  punch1.addRow([1, "501", "test", new Date(Date.UTC(2026, 6, 1)), new Date(1899, 11, 31, 10, 0), new Date(1899, 11, 31, 20, 0), null]);
  punch1.addRow([1, "501", "test", new Date(Date.UTC(2026, 6, 2)), null, null, null]); // يوم اجازة - من غير بصمة حقيقية
  punch1.addRow([1, "501", "test", new Date(Date.UTC(2026, 7, 1)), new Date(1899, 11, 31, 10, 0), null, null]); // شهر خارج النطاق (أغسطس)
  punch1.addRow([2, "999", "unknown", new Date(Date.UTC(2026, 6, 3)), new Date(1899, 11, 31, 10, 0), null, null]); // كود مش تابع لموظف متضمّن

  const punch2 = wb.addWorksheet("بصمة - محرم بك");
  punch2.addRow(["سجل البصمة - فرع محرم بك"]);
  punch2.addRow(["تعليمات..."]);
  punch2.addRow(["Emp No.", "AC-No.", "Name", "Date", "Clock In", "Clock Out", "Work Time"]);
  punch2.addRow([1, "701", "test2", new Date(Date.UTC(2026, 6, 5)), new Date(1899, 11, 31, 20, 0), null, null]);

  const ck = wb.addWorksheet("حضور المطبخ المركزي (يدوي)");
  ck.addRow(["حضور المطبخ المركزي"]);
  ck.addRow(["تعليمات..."]);
  ck.addRow(["كود الموظف الداخلي", "الاسم", "أيام الحضور", "أيام الغياب", "إجمالي دقائق التأخير", "خصم يدوي إضافي (جنيه)", "ملاحظات"]);
  ck.addRow(["E9006", "يوسف اختبار-جست", 26, 0, 0, 50, "ملاحظة اختبار"]);
  ck.addRow(["E9099", "كود موظف مش موجود", 20, 6, 0, 0, null]); // كوده مش من ضمن الموظفين المتضمّنين - يتجاهل

  const adj = wb.addWorksheet("السلف والجزاءات والمكافآت");
  adj.addRow(["السلف والجزاءات والمكافآت"]);
  adj.addRow(["التاريخ", "كود الموظف", "الاسم", "النوع", "المبلغ (جنيه)", "ملاحظات"]);
  adj.addRow([new Date(Date.UTC(2026, 6, 31)), "E9007", "محاسبة اختبار-جست", "سلفة", 1500, "سلفة يوليو"]);
  adj.addRow([new Date(Date.UTC(2026, 6, 15)), "E9001", "أحمد اختبار-جست", "مكافأة", 200, "بونص"]);
  adj.addRow([new Date(Date.UTC(2026, 5, 30)), "E9007", "محاسبة اختبار-جست", "سلفة", 999, "شهر تاني - مش هيتستورد"]); // يونيو - خارج نطاق الاستيراد (يوليو)

  return wb.xlsx.writeBuffer();
}

let adminToken, accountantToken, cashierToken;

beforeAll(async () => {
  // عمدًا من غير "العصافرة" - محتاجينها مش موجودة عشان نتأكد إن الاستيراد بيحذّر بس ومايعملش فرع تلقائي
  await pool.query("INSERT INTO branches (name) VALUES ('الإبراهيمية'), ('محرم بك') ON CONFLICT DO NOTHING");
  await seedUser({ name: "أدمن-استيراد-رواتب", email: "admin-payroll-import@jest.test", role: "admin" });
  await seedUser({ name: "محاسب-استيراد-رواتب", email: "accountant-payroll-import@jest.test", role: "accountant" });
  await seedUser({ name: "كاشير-استيراد-رواتب", email: "cashier-payroll-import@jest.test", role: "cashier" });
  adminToken = await login("admin-payroll-import@jest.test");
  accountantToken = await login("accountant-payroll-import@jest.test");
  cashierToken = await login("cashier-payroll-import@jest.test");
});

afterAll(async () => {
  await pool.end();
});

describe("استيراد ملف الرواتب الشهري (Excel)", () => {
  test("مش مسموح لغير أدمن/محاسب", async () => {
    const buffer = await buildWorkbook();
    const res = await request(app)
      .post("/api/payroll/import-excel").set(authed(cashierToken))
      .field("year", "2026").field("month", "7")
      .attach("file", buffer, "payroll.xlsx");
    expect(res.status).toBe(403);
  });

  test("بدون ملف - 400", async () => {
    const res = await request(app)
      .post("/api/payroll/import-excel").set(authed(adminToken))
      .field("year", "2026").field("month", "7");
    expect(res.status).toBe(400);
  });

  test("سنة/شهر غير صحيحين - 400", async () => {
    const buffer = await buildWorkbook();
    const res = await request(app)
      .post("/api/payroll/import-excel").set(authed(adminToken))
      .field("year", "2026").field("month", "13")
      .attach("file", buffer, "payroll.xlsx");
    expect(res.status).toBe(400);
  });

  let empIdByCode = {};

  test("استيراد يوليو 2026 - الموظفين المتضمّنين بس، والاستبعاد/needsReview صح", async () => {
    const buffer = await buildWorkbook();
    const res = await request(app)
      .post("/api/payroll/import-excel").set(authed(adminToken))
      .field("year", "2026").field("month", "7")
      .attach("file", buffer, "payroll.xlsx");

    expect(res.status).toBe(201);
    expect(res.body.employeesCreated).toBe(4); // E9001, E9006, E9007, E9008 (4 المتضمّنين فعلاً)

    const excludedReasons = res.body.excluded.map((e) => e.reason);
    expect(res.body.excluded.length).toBe(3); // القالب، كود بدون اسم، راتب صفر
    expect(excludedReasons.some((r) => r.includes("قالب"))).toBe(true);
    expect(excludedReasons.some((r) => r.includes("كود بصمة من غير اسم"))).toBe(true);
    expect(excludedReasons.some((r) => r.includes("راتب فعلي"))).toBe(true);

    expect(res.body.needsReview.length).toBe(1);
    expect(res.body.needsReview[0].name).toBe("منى اختبار-جست");

    const emps = await pool.query(
      "SELECT id, employee_code, name, department, base_salary FROM employees WHERE employee_code LIKE 'E900%'"
    );
    expect(emps.rows.length).toBe(4);
    emps.rows.forEach((e) => { empIdByCode[e.employee_code] = e.id; });
    // من غير اسم/راتب صفر/قالب - مفيش أي صف منهم في الداتابيز خالص
    const namesInDb = emps.rows.map((e) => e.name);
    expect(namesInDb).not.toContain("سارة اختبار-جست");
    expect(namesInDb).not.toContain("منى اختبار-جست");
    expect(namesInDb.some((n) => n.includes("مثال"))).toBe(false);

    // بيشوي اتسجّل بالراتب المكتوب زي ما هو رغم ملاحظة "غير معروف"
    const bishoy = emps.rows.find((e) => e.employee_code === "E9008");
    expect(Number(bishoy.base_salary)).toBe(4800);
  });

  test("بصمات الإبراهيمية: يوم حقيقي بس، مش يوم الاجازة ولا شهر أغسطس ولا كود مجهول", async () => {
    const branch = await pool.query("SELECT id FROM branches WHERE name = 'الإبراهيمية'");
    const punches = await pool.query(
      "SELECT * FROM attendance_punches WHERE branch_id = $1 AND device_code = '501'", [branch.rows[0].id]
    );
    expect(punches.rows.length).toBe(1);
    expect(punches.rows[0].punch_date.toISOString().slice(0, 10)).toBe("2026-07-01");

    const unknown = await pool.query(
      "SELECT * FROM attendance_punches WHERE branch_id = $1 AND device_code = '999'", [branch.rows[0].id]
    );
    expect(unknown.rows.length).toBe(0);
  });

  test("بصمات محرم بك اتسجّلت لكود بيشوي (701)", async () => {
    const branch = await pool.query("SELECT id FROM branches WHERE name = 'محرم بك'");
    const punches = await pool.query(
      "SELECT * FROM attendance_punches WHERE branch_id = $1 AND device_code = '701'", [branch.rows[0].id]
    );
    expect(punches.rows.length).toBe(1);
  });

  test("حضور المطبخ المركزي اليدوي - يوسف بس (كود مجهول اتجاهل)", async () => {
    const rows = await pool.query(
      "SELECT * FROM central_kitchen_manual_attendance WHERE employee_id = $1 AND year=2026 AND month=7",
      [empIdByCode["E9006"]]
    );
    expect(rows.rows.length).toBe(1);
    expect(Number(rows.rows[0].manual_deduction)).toBe(50);
  });

  test("السلف/الجزاءات/المكافآت: يوليو بس (يونيو اتستبعد)، والمبالغ صح", async () => {
    const rows = await pool.query(
      "SELECT * FROM payroll_adjustments WHERE employee_id IN ($1,$2) ORDER BY amount",
      [empIdByCode["E9001"], empIdByCode["E9007"]]
    );
    expect(rows.rows.length).toBe(2);
    expect(rows.rows.map((r) => Number(r.amount)).sort((a, b) => a - b)).toEqual([200, 1500]);
    expect(rows.rows.every((r) => r.entry_date.toISOString().slice(0, 7) === "2026-07")).toBe(true);
  });

  test("رفع نفس الملف تاني لنفس الشهر - upsert آمن (مفيش تكرار، مفيش خطأ)", async () => {
    const buffer = await buildWorkbook();
    const res = await request(app)
      .post("/api/payroll/import-excel").set(authed(accountantToken))
      .field("year", "2026").field("month", "7")
      .attach("file", buffer, "payroll.xlsx");
    expect(res.status).toBe(201);
    expect(res.body.employeesCreated).toBe(0);
    expect(res.body.employeesUpdated).toBe(4);
    expect(res.body.adjustmentsImported).toBe(0);
    expect(res.body.adjustmentsSkippedDuplicate).toBe(2);

    const emps = await pool.query("SELECT COUNT(*) FROM employees WHERE employee_code LIKE 'E900%'");
    expect(Number(emps.rows[0].count)).toBe(4); // لسه 4 بالظبط، مفيش تكرار

    const punches = await pool.query(
      "SELECT COUNT(*) FROM attendance_punches WHERE device_code IN ('501','701')"
    );
    expect(Number(punches.rows[0].count)).toBe(2); // لسه نفس العدد، مفيش تكرار
  });

  test("فرع مش موجود في السيستم - تحذير واضح وتجاهل بصماته بس (مفيش إنشاء فرع تلقائي)", async () => {
    const wb = new ExcelJS.Workbook();
    const emp = wb.addWorksheet("قاعدة بيانات الموظفين");
    emp.addRow(["قاعدة بيانات الموظفين"]);
    emp.addRow(["كود الموظف الداخلي", "الاسم بالكامل", "القسم", "الوظيفة", "نظام الحضور", "تاريخ التعيين",
      "الراتب الأساسي الشهري", "أيام العمل بالشهر", "الشيفت", "وقت الدخول الافتراضي", "الهاتف", "ملاحظات",
      "نوع الأجر", "أجر الساعة (جنيه)", "كود بصمة الإبراهيمية", "كود بصمة العصافرة", "كود بصمة محرم بك",
      "تحقق من تكرار الكود", "احسب الراتب من فرع واحد فقط (اختياري)", "احتساب يوم 31 في الشهر؟"]);
    emp.addRow(["E9020", "فرع غريب اختبار-جست", "فطير", "شيف فطير", "بصمة تلقائي", null, 9500, 26,
      "صباحي", null, null, null, "شهري ثابت", 0, null, "801", null, null, null, "لا"]);
    const buffer = await wb.xlsx.writeBuffer();

    const res = await request(app)
      .post("/api/payroll/import-excel").set(authed(adminToken))
      .field("year", "2026").field("month", "7")
      .attach("file", buffer, "payroll.xlsx");
    expect(res.status).toBe(201);
    expect(res.body.warnings.some((w) => w.includes("العصافرة"))).toBe(true);

    const branches = await pool.query("SELECT COUNT(*) FROM branches WHERE name = 'العصافرة'");
    expect(Number(branches.rows[0].count)).toBe(0); // مفيش فرع اتعمل تلقائي بالغلط بمجرد ظهور اسمه في الشيت
  });
});
