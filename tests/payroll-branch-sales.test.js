// HR-3: مبيعات الفروع الشهرية (لمقارنة تكلفة الرواتب بالمبيعات) - كانت بتتسجل يدويًا في جدول
// department_sales (رقم بيدخله حد بنفسه، مش مربوط بالأوردرات الفعلية). دلوقتي GET /api/payroll/branch-sales
// بيحسب المبيعات 100% تلقائيًا من orders الحقيقية (نفس مصدر الإيراد في قائمة الدخل - services/revenue-engine.js)
// وبيقارنها بتكلفة الرواتب الفعلية لنفس الفرع (services/payroll-engine.js) - مفيش إدخال يدوي خالص.
const { app, request, pool, seedUser, login, authed } = require("./helpers");
const { computePayrollCostByBranch } = require("../services/payroll-engine");

let branchId, emptyBranchId;
let adminToken, accountantToken, managerToken;

beforeAll(async () => {
  const b = await pool.query("INSERT INTO branches (name) VALUES ('فرع-مبيعات-رواتب-جست') RETURNING id");
  branchId = b.rows[0].id;
  const eb = await pool.query("INSERT INTO branches (name) VALUES ('فرع-فاضي-مبيعات-رواتب-جست') RETURNING id");
  emptyBranchId = eb.rows[0].id;

  await seedUser({ name: "أدمن-مبيعات-رواتب", email: "admin-branchsales@jest.test", role: "admin" });
  await seedUser({ branchId, name: "مدير فرع-مبيعات-رواتب", email: "manager-branchsales@jest.test", role: "branch_manager" });
  adminToken = await login("admin-branchsales@jest.test");
  managerToken = await login("manager-branchsales@jest.test");

  // موظف بصمة تلقائي مرتبط بالفرع - عشان تكلفة الرواتب تطلع رقم حقيقي مش صفر لشهر أغسطس 2097
  const emp = await pool.query(
    `INSERT INTO employees (name, department, attendance_system, base_salary, shift, is_active)
     VALUES ('كاشير-مبيعات-رواتب-جست', 'تشغيل الفرع', 'fingerprint_auto', 4500, 'morning', TRUE) RETURNING id`
  );
  await pool.query(
    "INSERT INTO employee_fingerprint_codes (employee_id, branch_id, device_code) VALUES ($1,$2,'DEV-BSALES-JEST')",
    [emp.rows[0].id, branchId]
  );
  await pool.query(
    `INSERT INTO attendance_punches (branch_id, device_code, punch_date, clock_in, clock_out)
     SELECT $1, 'DEV-BSALES-JEST', d::date, '10:00', '20:00'
     FROM generate_series('2097-08-01'::date, '2097-08-31'::date, '1 day') AS d`,
    [branchId]
  );

  // أوردرات فعلية في أغسطس 2097 - 3 مكتملة (1000 لكل واحد) + طلب واحد ملغي (500) لازم يتستبعد من المبيعات
  await pool.query(
    `INSERT INTO orders (branch_id, source, order_type, total, vat_amount, status, created_at)
     VALUES
       ($1, 'pos', 'takeaway', 1000, 0, 'completed', '2097-08-05 12:00:00'),
       ($1, 'pos', 'takeaway', 1000, 0, 'completed', '2097-08-10 12:00:00'),
       ($1, 'pos', 'takeaway', 1000, 0, 'completed', '2097-08-20 12:00:00'),
       ($1, 'pos', 'takeaway', 500, 0, 'cancelled', '2097-08-15 12:00:00')`,
    [branchId]
  );
  // طلب من شهر تاني (سبتمبر) على نفس الفرع - لازم يتستبعد لأنه مش ضمن الشهر المطلوب
  await pool.query(
    `INSERT INTO orders (branch_id, source, order_type, total, vat_amount, status, created_at)
     VALUES ($1, 'pos', 'takeaway', 9999, 0, 'completed', '2097-09-01 12:00:00')`,
    [branchId]
  );
});

afterAll(async () => {
  await pool.end();
});

describe("GET /api/payroll/branch-sales - مبيعات الفروع تلقائيًا من الأوردرات", () => {
  test("مدير فرع ممنوع (نفس صلاحيات باقي /api/payroll)", async () => {
    const res = await request(app).get("/api/payroll/branch-sales?year=2097&month=8").set(authed(managerToken));
    expect(res.status).toBe(403);
  });

  test("من غير year/month -> 400", async () => {
    const res = await request(app).get("/api/payroll/branch-sales").set(authed(adminToken));
    expect(res.status).toBe(400);
  });

  test("المبيعات = مجموع الأوردرات المكتملة بس (الملغي والشهر التاني مستبعدين)، وتكلفة الرواتب بتطابق computePayrollCostByBranch", async () => {
    const expectedPayroll = await computePayrollCostByBranch(pool, 2097, 8);
    const res = await request(app).get("/api/payroll/branch-sales?year=2097&month=8").set(authed(adminToken));
    expect(res.status).toBe(200);
    expect(res.body.year).toBe(2097);
    expect(res.body.month).toBe(8);

    const row = res.body.branches.find((r) => r.branchId === branchId);
    expect(row).toBeTruthy();
    expect(Number(row.sales)).toBe(3000);
    expect(Number(row.payrollCost)).toBeCloseTo(expectedPayroll.byBranch[branchId] || 0, 2);
    expect(row.payrollCost).toBeGreaterThan(0);
    expect(row.ratio).toBeCloseTo(row.payrollCost / 3000, 5);
  });

  test("فرع من غير أي أوردرات - المبيعات صفر والنسبة null", async () => {
    const res = await request(app).get("/api/payroll/branch-sales?year=2097&month=8").set(authed(adminToken));
    const row = res.body.branches.find((r) => r.branchId === emptyBranchId);
    expect(row).toBeTruthy();
    expect(Number(row.sales)).toBe(0);
    expect(row.ratio).toBeNull();
    expect(row.overWarnThreshold).toBe(false);
  });
});
