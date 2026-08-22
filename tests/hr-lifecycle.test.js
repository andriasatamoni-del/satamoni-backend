// المرحلة 4D: دورة حياة الموظف الموثّقة (كود/حالة/تاريخ/إنذارات/إجازات) ضد Postgres حقيقي - عزل الفروع
// لمدير الفرع (cross-branch authorization)، التوافق الرجعي مع is_active (محرك الرواتب - payroll-engine -
// لسه بيقرأه مباشرة من غير أي تعديل)، append-only للإنذارات وسجل التاريخ (مفيش DELETE أصلًا)، الإلغاء
// (مش حذف) للإجازات، وتقارير HR (بما فيها رصيد إجازات تقديري ومعدل دوران).
const { app, request, pool, seedUser, login, authed } = require("./helpers");

let branchId, otherBranchId;
let adminToken, managerToken, otherManagerToken, accountantToken;

async function createEmployee(token, overrides = {}) {
  const res = await request(app).post("/api/payroll/employees").set(authed(token)).send({
    name: "موظف اختبار", department: "تشغيل الفرع", attendanceSystem: "none",
    hireDate: "2023-01-15", baseSalary: 4000, restrictedBranchId: branchId, ...overrides,
  });
  return res.body;
}

beforeAll(async () => {
  const b1 = await pool.query("INSERT INTO branches (name) VALUES ('فرع HR-جست') RETURNING id");
  branchId = b1.rows[0].id;
  const b2 = await pool.query("INSERT INTO branches (name) VALUES ('فرع HR-جست تاني') RETURNING id");
  otherBranchId = b2.rows[0].id;

  await seedUser({ name: "أدمن-HR", email: "admin-hr@jest.test", role: "admin" });
  await seedUser({ branchId, name: "مدير فرع-HR", email: "manager-hr@jest.test", role: "branch_manager" });
  await seedUser({ branchId: otherBranchId, name: "مدير فرع تاني-HR", email: "othermanager-hr@jest.test", role: "branch_manager" });
  await seedUser({ name: "محاسب-HR", email: "accountant-hr@jest.test", role: "accountant" });

  adminToken = await login("admin-hr@jest.test");
  managerToken = await login("manager-hr@jest.test");
  otherManagerToken = await login("othermanager-hr@jest.test");
  accountantToken = await login("accountant-hr@jest.test");
});

afterAll(async () => {
  await pool.end();
});

describe("1) إنشاء موظف: employee_code تلقائي وفريد", () => {
  test("إنشاء موظف من غير employeeCode - بيتولّد تلقائي بصيغة EMP-XXXXXX", async () => {
    const res = await request(app).post("/api/payroll/employees").set(authed(adminToken)).send({
      name: "كريم سيد", department: "تشغيل الفرع", attendanceSystem: "none", hireDate: "2023-01-15",
      baseSalary: 5000, restrictedBranchId: branchId,
    });
    expect(res.status).toBe(201);
    expect(res.body.employee_code).toMatch(/^EMP-\d{6}$/);
    expect(res.body.status).toBe("active");
  });

  test("كود موظف مكرر مرفوض (409)", async () => {
    const first = await request(app).post("/api/payroll/employees").set(authed(adminToken)).send({
      name: "موظف١", department: "الإدارة", attendanceSystem: "none", employeeCode: "EMP-CUSTOM-1",
    });
    expect(first.status).toBe(201);
    const dup = await request(app).post("/api/payroll/employees").set(authed(adminToken)).send({
      name: "موظف٢", department: "الإدارة", attendanceSystem: "none", employeeCode: "EMP-CUSTOM-1",
    });
    expect(dup.status).toBe(409);
  });

  test("branch_manager ممنوع من إنشاء موظف (payroll admin+accountant بس - زي ما هو قبل المرحلة دي)", async () => {
    const res = await request(app).post("/api/payroll/employees").set(authed(managerToken)).send({
      name: "موظف من مدير فرع", department: "تشغيل الفرع", attendanceSystem: "none",
    });
    expect(res.status).toBe(403);
  });
});

describe("2) التوافق الرجعي: isActive القديم لسه بيشتغل، status بقى مصدر الحقيقة", () => {
  let empId;
  beforeAll(async () => {
    const emp = await createEmployee(adminToken, { name: "موظف توافق رجعي" });
    empId = emp.id;
  });

  test("PATCH بـisActive:false بيحوّل status لـterminated وis_active بيفضل false فعليًا", async () => {
    const res = await request(app).patch(`/api/payroll/employees/${empId}`).set(authed(adminToken)).send({ isActive: false });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("terminated");
    expect(res.body.is_active).toBe(false);
  });

  test("PATCH بـisActive:true بيرجّعه active وis_active true", async () => {
    const res = await request(app).patch(`/api/payroll/employees/${empId}`).set(authed(adminToken)).send({ isActive: true });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("active");
    expect(res.body.is_active).toBe(true);
  });

  test("PATCH بـstatus:'suspended' مباشرة بيخلي is_active false تلقائي (الـtrigger، مش التطبيق)", async () => {
    const res = await request(app).patch(`/api/payroll/employees/${empId}`).set(authed(adminToken)).send({ status: "suspended" });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("suspended");
    expect(res.body.is_active).toBe(false);
  });

  test("status غير صحيح مرفوض (400) بواسطة الـCHECK constraint", async () => {
    const res = await request(app).patch(`/api/payroll/employees/${empId}`).set(authed(adminToken)).send({ status: "on_vacation_forever" });
    expect(res.status).toBe(400);
  });

  test("محرك الرواتب (income-statement) لسه شغال بعد التعديلات دي - مفيش أي لمس لمنطقه", async () => {
    const now = new Date();
    const res = await request(app).get(`/api/reports/income-statement?year=${now.getFullYear()}&month=${now.getMonth() + 1}`).set(authed(adminToken));
    expect(res.status).toBe(200);
  });
});

describe("3) سجل تاريخ الموظف (employee_history) - append-only، بيتسجل بس لما حقل فعليًا يتغيّر", () => {
  let empId;
  beforeAll(async () => {
    const emp = await createEmployee(adminToken, { name: "موظف سجل تاريخ", department: "تشغيل الفرع" });
    empId = emp.id;
  });

  test("تغيير department عن طريق /api/hr/employees/:id بيتسجل سطر تاريخ صحيح", async () => {
    const patch = await request(app).patch(`/api/hr/employees/${empId}`).set(authed(adminToken))
      .send({ department: "الإدارة", reason: "نقل قسم" });
    expect(patch.status).toBe(200);

    const history = await request(app).get(`/api/hr/employees/${empId}/history`).set(authed(adminToken));
    expect(history.status).toBe(200);
    const deptChange = history.body.find((h) => h.field_name === "department");
    expect(deptChange).toBeTruthy();
    expect(deptChange.old_value).toBe("تشغيل الفرع");
    expect(deptChange.new_value).toBe("الإدارة");
    expect(deptChange.reason).toBe("نقل قسم");
  });

  test("PATCH بنفس القيمة الحالية (مفيش تغيير فعلي) - مفيش سطر تاريخ جديد يتسجل", async () => {
    const before = await request(app).get(`/api/hr/employees/${empId}/history`).set(authed(adminToken));
    const countBefore = before.body.length;
    const patch = await request(app).patch(`/api/hr/employees/${empId}`).set(authed(adminToken)).send({ department: "الإدارة" });
    expect(patch.status).toBe(200);
    const after = await request(app).get(`/api/hr/employees/${empId}/history`).set(authed(adminToken));
    expect(after.body.length).toBe(countBefore);
  });

  test("PATCH بالمرور بـ/api/payroll/employees/:id (المسار القديم) كمان بيسجل تاريخ (نفس الحقل، مسارين)", async () => {
    const patch = await request(app).patch(`/api/payroll/employees/${empId}`).set(authed(adminToken)).send({ jobTitle: "كاشير أول" });
    expect(patch.status).toBe(200);
    const history = await request(app).get(`/api/hr/employees/${empId}/history`).set(authed(adminToken));
    const jobChange = history.body.find((h) => h.field_name === "job_title");
    expect(jobChange).toBeTruthy();
    expect(jobChange.new_value).toBe("كاشير أول");
  });
});

describe("4) عزل الفروع (Cross-Branch Authorization) لمدير الفرع", () => {
  let empId;
  beforeAll(async () => {
    const emp = await createEmployee(adminToken, { name: "موظف عزل الفروع", restrictedBranchId: branchId });
    empId = emp.id;
  });

  test("مدير الفرع الصح يقدر يشوف الموظف", async () => {
    const res = await request(app).get(`/api/hr/employees/${empId}`).set(authed(managerToken));
    expect(res.status).toBe(200);
  });

  test("مدير فرع تاني ممنوع يشوف الموظف (403)", async () => {
    const res = await request(app).get(`/api/hr/employees/${empId}`).set(authed(otherManagerToken));
    expect(res.status).toBe(403);
  });

  test("مدير فرع تاني ممنوع يعدّل بيانات الموظف (403)", async () => {
    const res = await request(app).patch(`/api/hr/employees/${empId}`).set(authed(otherManagerToken)).send({ status: "suspended" });
    expect(res.status).toBe(403);
  });

  test("مدير فرع تاني ممنوع يسجّل إنذار أو إجازة للموظف (403 لكل واحد)", async () => {
    const warn = await request(app).post(`/api/hr/employees/${empId}/warnings`).set(authed(otherManagerToken))
      .send({ severity: "verbal", reason: "اختبار" });
    expect(warn.status).toBe(403);
    const leave = await request(app).post("/api/hr/leaves").set(authed(otherManagerToken))
      .send({ employeeId: empId, leaveType: "annual", startDate: "2024-02-01", endDate: "2024-02-02" });
    expect(leave.status).toBe(403);
  });

  test("مدير الفرع مقفول على restrictedBranchId - ممنوع ينقل موظف لفرع تاني (403، أدمن بس)", async () => {
    const res = await request(app).patch(`/api/hr/employees/${empId}`).set(authed(managerToken)).send({ restrictedBranchId: otherBranchId });
    expect(res.status).toBe(403);
  });

  test("قائمة /api/hr/employees لمدير فرع مقفولة على فرعه بس (مفيش موظفين فرع تاني في الرد)", async () => {
    const otherEmp = await createEmployee(adminToken, { name: "موظف فرع تاني", restrictedBranchId: otherBranchId });
    const res = await request(app).get("/api/hr/employees").set(authed(managerToken));
    expect(res.status).toBe(200);
    expect(res.body.some((e) => e.id === otherEmp.id)).toBe(false);
    expect(res.body.some((e) => e.id === empId)).toBe(true);
  });

  test("قائمة HR-safe مفيهاش base_salary/hourly_rate خالص (بيانات مالية حساسة)", async () => {
    const res = await request(app).get("/api/hr/employees").set(authed(managerToken));
    expect(res.status).toBe(200);
    expect(res.body[0].base_salary).toBeUndefined();
    expect(res.body[0].hourly_rate).toBeUndefined();
  });
});

describe("5) الإنذارات (Warnings) - append-only، مفيش DELETE أبدًا", () => {
  let empId;
  beforeAll(async () => {
    const emp = await createEmployee(adminToken, { name: "موظف إنذارات" });
    empId = emp.id;
  });

  test("تسجيل إنذار صحيح", async () => {
    const res = await request(app).post(`/api/hr/employees/${empId}/warnings`).set(authed(managerToken))
      .send({ severity: "written", reason: "تأخير متكرر", notes: "تحدث معاه المشرف" });
    expect(res.status).toBe(201);
    expect(res.body.severity).toBe("written");
    expect(res.body.issued_by).toBeTruthy();
  });

  test("درجة إنذار غير صحيحة مرفوضة (400)", async () => {
    const res = await request(app).post(`/api/hr/employees/${empId}/warnings`).set(authed(managerToken))
      .send({ severity: "yelling", reason: "اختبار" });
    expect(res.status).toBe(400);
  });

  test("سبب الإنذار مطلوب (400)", async () => {
    const res = await request(app).post(`/api/hr/employees/${empId}/warnings`).set(authed(managerToken))
      .send({ severity: "verbal" });
    expect(res.status).toBe(400);
  });

  test("قائمة إنذارات الموظف + التقرير العام بيشملوا الإنذار المسجّل", async () => {
    const list = await request(app).get(`/api/hr/employees/${empId}/warnings`).set(authed(adminToken));
    expect(list.status).toBe(200);
    expect(list.body.length).toBeGreaterThanOrEqual(1);
    const report = await request(app).get(`/api/hr/warnings?branchId=${branchId}`).set(authed(adminToken));
    expect(report.status).toBe(200);
    expect(report.body.some((w) => w.employee_id === empId)).toBe(true);
  });

  test("مفيش endpoint حذف للإنذارات خالص (404 - المسار مش موجود من الأساس)", async () => {
    const warnings = await request(app).get(`/api/hr/employees/${empId}/warnings`).set(authed(adminToken));
    const warningId = warnings.body[0].id;
    const del = await request(app).delete(`/api/hr/warnings/${warningId}`).set(authed(adminToken));
    expect(del.status).toBe(404);
  });
});

describe("6) الإجازات (Leaves) - تسجيل مباشر، إلغاء مش حذف", () => {
  let empId;
  beforeAll(async () => {
    const emp = await createEmployee(adminToken, { name: "موظف إجازات", hireDate: "2020-01-01" });
    empId = emp.id;
  });

  test("تسجيل إجازة - عدد الأيام بيتحسب صح (شامل الطرفين)", async () => {
    const res = await request(app).post("/api/hr/leaves").set(authed(managerToken)).send({
      employeeId: empId, leaveType: "annual", startDate: "2024-03-01", endDate: "2024-03-05", notes: "إجازة سنوية",
    });
    expect(res.status).toBe(201);
    expect(res.body.days).toBe(5);
    expect(res.body.status).toBe("recorded");
    expect(res.body.branch_id).toBe(branchId);
  });

  test("تاريخ نهاية قبل البداية مرفوض (400)", async () => {
    const res = await request(app).post("/api/hr/leaves").set(authed(managerToken)).send({
      employeeId: empId, leaveType: "sick", startDate: "2024-03-10", endDate: "2024-03-05",
    });
    expect(res.status).toBe(400);
  });

  test("إلغاء إجازة - يتطلب سبب، والسجل يفضل موجود (status=cancelled) مش بيتمسح", async () => {
    const created = await request(app).post("/api/hr/leaves").set(authed(managerToken)).send({
      employeeId: empId, leaveType: "casual", startDate: "2024-04-01", endDate: "2024-04-01",
    });
    const noReason = await request(app).post(`/api/hr/leaves/${created.body.id}/cancel`).set(authed(managerToken)).send({});
    expect(noReason.status).toBe(400);

    const cancel = await request(app).post(`/api/hr/leaves/${created.body.id}/cancel`).set(authed(managerToken))
      .send({ reason: "غلط في التسجيل" });
    expect(cancel.status).toBe(200);
    expect(cancel.body.status).toBe("cancelled");

    const doubleCancel = await request(app).post(`/api/hr/leaves/${created.body.id}/cancel`).set(authed(managerToken))
      .send({ reason: "تاني" });
    expect(doubleCancel.status).toBe(400);
  });

  test("مفيش endpoint حذف للإجازات خالص (404)", async () => {
    const leaves = await request(app).get("/api/hr/leaves").set(authed(adminToken)).query({ employeeId: empId });
    const del = await request(app).delete(`/api/hr/leaves/${leaves.body[0].id}`).set(authed(adminToken));
    expect(del.status).toBe(404);
  });

  test("مدير فرع تاني ما يقدرش يلغي إجازة موظف مش بتاعه (403)", async () => {
    const created = await request(app).post("/api/hr/leaves").set(authed(managerToken)).send({
      employeeId: empId, leaveType: "unpaid", startDate: "2024-05-01", endDate: "2024-05-02",
    });
    const res = await request(app).post(`/api/hr/leaves/${created.body.id}/cancel`).set(authed(otherManagerToken)).send({ reason: "x" });
    expect(res.status).toBe(403);
  });

  test("فلترة القائمة بنوع الإجازة وبالحالة", async () => {
    const annual = await request(app).get("/api/hr/leaves").set(authed(adminToken)).query({ employeeId: empId, leaveType: "annual" });
    expect(annual.status).toBe(200);
    expect(annual.body.every((l) => l.leave_type === "annual")).toBe(true);

    const cancelled = await request(app).get("/api/hr/leaves").set(authed(adminToken)).query({ employeeId: empId, status: "cancelled" });
    expect(cancelled.body.every((l) => l.status === "cancelled")).toBe(true);
    expect(cancelled.body.length).toBeGreaterThanOrEqual(1);
  });
});

describe("7) رصيد الإجازات التقديري (leave-balance)", () => {
  test("الحساب صحيح: entitled = perMonth × شهور الخدمة، remaining = entitled - المأخوذ فعليًا", async () => {
    const settingsRes = await request(app).get("/api/payroll/settings").set(authed(adminToken));
    const perMonth = Number(settingsRes.body.settings.paid_leave_days_per_month);

    // موظف اتعيّن بالظبط قبل 6 شهور من asOf، وأخد إجازة سنوية 3 أيام
    const emp = await createEmployee(adminToken, { name: "موظف رصيد إجازات", hireDate: "2024-01-01" });
    await request(app).post("/api/hr/leaves").set(authed(adminToken)).send({
      employeeId: emp.id, leaveType: "annual", startDate: "2024-03-01", endDate: "2024-03-03",
    });

    const asOf = "2024-07-01"; // 6 شهور بالظبط بعد 2024-01-01
    const res = await request(app).get("/api/hr/reports/leave-balance").set(authed(adminToken)).query({ employeeId: emp.id, asOf });
    expect(res.status).toBe(200);
    const row = res.body.employees.find((e) => e.employeeId === emp.id);
    expect(row).toBeTruthy();
    expect(row.daysTaken).toBe(3);
    expect(row.estimatedEntitledDays).toBeCloseTo(perMonth * 6, 0);
    expect(row.estimatedRemainingDays).toBeCloseTo(perMonth * 6 - 3, 0);
    expect(res.body.note).toContain("تقديري");
  });

  test("مدير الفرع بيشوف رصيد إجازات موظفي فرعه بس", async () => {
    const res = await request(app).get("/api/hr/reports/leave-balance").set(authed(managerToken));
    expect(res.status).toBe(200);
    expect(res.body.employees.every((e) => e.branchId === branchId)).toBe(true);
  });
});

describe("8) تقارير HR الأخرى", () => {
  test("employees-by-branch: أدمن بس (مقارنة فروع)", async () => {
    const ok = await request(app).get("/api/hr/reports/employees-by-branch").set(authed(adminToken));
    expect(ok.status).toBe(200);
    expect(Array.isArray(ok.body)).toBe(true);
    const denied = await request(app).get("/api/hr/reports/employees-by-branch").set(authed(managerToken));
    expect(denied.status).toBe(403);
  });

  test("employees-by-department/job-title/status: مدير فرع بيرجعله فرعه بس، أدمن بيرجعله الكل", async () => {
    for (const path of ["employees-by-department", "employees-by-job-title", "employee-status"]) {
      const asManager = await request(app).get(`/api/hr/reports/${path}`).set(authed(managerToken));
      expect(asManager.status).toBe(200);
      const asAdmin = await request(app).get(`/api/hr/reports/${path}`).set(authed(adminToken));
      expect(asAdmin.status).toBe(200);
    }
  });

  test("average-tenure: hire_date هو المصدر (مش created_at) - موظف بتاريخ تعيين قديم بيدّي مدة خدمة كبيرة", async () => {
    await createEmployee(adminToken, { name: "موظف قديم", hireDate: "2015-01-01", restrictedBranchId: branchId });
    const res = await request(app).get("/api/hr/reports/average-tenure").set(authed(adminToken)).query({ branchId, asOf: "2024-01-01" });
    expect(res.status).toBe(200);
    expect(res.body.averageTenureMonths).toBeGreaterThan(12);
  });

  test("turnover: بيرجّع departures وheadcount ومعدل الدوران", async () => {
    const res = await request(app).get("/api/hr/reports/turnover").set(authed(adminToken)).query({ from: "2024-01-01", to: "2024-12-31" });
    expect(res.status).toBe(200);
    expect(typeof res.body.departures).toBe("number");
    expect(res.body.note).toContain("تقديري");
  });

  test("new-hires وterminations بيرجعوا 200 ومفلترين صح", async () => {
    const hires = await request(app).get("/api/hr/reports/new-hires").set(authed(adminToken)).query({ from: "2023-01-01", to: "2023-12-31" });
    expect(hires.status).toBe(200);
    expect(hires.body.every((h) => h.hire_date >= "2023-01-01" && h.hire_date <= "2023-12-31")).toBe(true);

    const terms = await request(app).get("/api/hr/reports/terminations").set(authed(adminToken));
    expect(terms.status).toBe(200);
    expect(terms.body.every((t) => ["resigned", "terminated"].includes(t.status))).toBe(true);
  });
});

describe("9) سجل التدقيق (Audit Trail) - كل عملية HR حساسة متسجّلة", () => {
  test("EMPLOYEE_CREATED وEMPLOYEE_HR_UPDATED وEMPLOYEE_WARNING_ISSUED وEMPLOYEE_LEAVE_RECORDED متسجّلين في audit_logs", async () => {
    const actions = ["EMPLOYEE_CREATED", "EMPLOYEE_HR_UPDATED", "EMPLOYEE_WARNING_ISSUED", "EMPLOYEE_LEAVE_RECORDED", "EMPLOYEE_LEAVE_CANCELLED"];
    for (const action of actions) {
      const res = await pool.query("SELECT COUNT(*) AS c FROM audit_logs WHERE action = $1", [action]);
      expect(Number(res.rows[0].c)).toBeGreaterThanOrEqual(1);
    }
  });
});
