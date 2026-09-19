// HR Foundation Hardening (HRF-3): db/employee-service.js هو التنفيذ الكانوني الوحيد اللي
// routes/hr.js وroutes/payroll.js بينادوا عليه للتحديث - بيغطي التحقق إن (1) الثغرة الحقيقية اتقفلت
// (نقل فرع عن طريق /api/payroll/employees/:id بقى محتاج أدمن زي /api/hr/employees/:id بالظبط، مش من
// غير أي قيد زي ما كان)، (2) عزل فرع مدير الفرع في hr.js لسه شغال زي ما كان، (3) اسم عملية التدقيق
// بقى موحّد (EMPLOYEE_UPDATED) من المسارين، (4) مفيش ازدواجية سلوك - نفس المدخلات نفس النتيجة.
const { app, request, pool, seedUser, login, authed } = require("./helpers");

let branchA, branchB;
let adminToken, accountantToken, managerAToken, managerBToken;
let empInBranchA;

beforeAll(async () => {
  const a = await pool.query("INSERT INTO branches (name) VALUES ('فرع-توحيد-موظف-أ-جست') RETURNING id");
  branchA = a.rows[0].id;
  const b = await pool.query("INSERT INTO branches (name) VALUES ('فرع-توحيد-موظف-ب-جست') RETURNING id");
  branchB = b.rows[0].id;

  await seedUser({ name: "أدمن-توحيد-موظف", email: "admin-empconsol@jest.test", role: "admin" });
  adminToken = await login("admin-empconsol@jest.test");
  await seedUser({ name: "محاسب-توحيد-موظف", email: "accountant-empconsol@jest.test", role: "accountant" });
  accountantToken = await login("accountant-empconsol@jest.test");
  await seedUser({ branchId: branchA, name: "مدير-أ-توحيد-موظف", email: "managerA-empconsol@jest.test", role: "branch_manager" });
  managerAToken = await login("managerA-empconsol@jest.test");
  await seedUser({ branchId: branchB, name: "مدير-ب-توحيد-موظف", email: "managerB-empconsol@jest.test", role: "branch_manager" });
  managerBToken = await login("managerB-empconsol@jest.test");

  const emp = await pool.query(
    `INSERT INTO employees (name, department, attendance_system, base_salary, restricted_branch_id, is_active)
     VALUES ('موظف-توحيد-جست', 'تشغيل الفرع', 'none', 2000, $1, TRUE) RETURNING id`,
    [branchA]
  );
  empInBranchA = emp.rows[0].id;
});

afterAll(async () => {
  await pool.end();
});

describe("الثغرة اللي اتقفلت: نقل فرع عن طريق /api/payroll/employees/:id بقى أدمن بس", () => {
  test("محاسب (معاه صلاحية /api/payroll كاملة) يتمنع من تغيير restrictedBranchId هنا - 403", async () => {
    const res = await request(app)
      .patch(`/api/payroll/employees/${empInBranchA}`)
      .set(authed(accountantToken))
      .send({ restrictedBranchId: branchB });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/أدمن بس/);

    // القيمة الأصلية فضلت زي ما هي - مفيش تعديل جزئي حصل قبل الرفض
    const row = await pool.query("SELECT restricted_branch_id FROM employees WHERE id = $1", [empInBranchA]);
    expect(row.rows[0].restricted_branch_id).toBe(branchA);
  });

  test("أدمن يقدر يغيّر restrictedBranchId عن طريق نفس المسار - 200", async () => {
    const res = await request(app)
      .patch(`/api/payroll/employees/${empInBranchA}`)
      .set(authed(adminToken))
      .send({ restrictedBranchId: branchB });
    expect(res.status).toBe(200);
    expect(res.body.restricted_branch_id).toBe(branchB);

    // رجّعه لفرعه الأصلي عشان باقي الاختبارات
    await pool.query("UPDATE employees SET restricted_branch_id = $1 WHERE id = $2", [branchA, empInBranchA]);
  });

  test("نفس القيد لسه شغال زي ما كان على /api/hr/employees/:id (مدير فرع، مش أدمن)", async () => {
    const res = await request(app)
      .patch(`/api/hr/employees/${empInBranchA}`)
      .set(authed(managerAToken))
      .send({ restrictedBranchId: branchB });
    expect(res.status).toBe(403);
  });
});

describe("عزل فرع مدير الفرع في /api/hr/employees/:id لسه شغال", () => {
  test("مدير فرع ب مايقدرش يشوف/يعدّل موظف مربوط بفرع أ", async () => {
    const res = await request(app)
      .patch(`/api/hr/employees/${empInBranchA}`)
      .set(authed(managerBToken))
      .send({ jobTitle: "تجربة" });
    expect(res.status).toBe(403);
  });

  test("مدير فرع أ يقدر يعدّل موظف فرعه هو", async () => {
    const res = await request(app)
      .patch(`/api/hr/employees/${empInBranchA}`)
      .set(authed(managerAToken))
      .send({ jobTitle: "كاشير أول" });
    expect(res.status).toBe(200);
    expect(res.body.job_title).toBe("كاشير أول");
  });
});

describe("اسم عملية التدقيق بقى موحّد من المسارين", () => {
  test("EMPLOYEE_UPDATED متسجّل من /api/hr/employees و/api/payroll/employees الاتنين", async () => {
    await request(app).patch(`/api/hr/employees/${empInBranchA}`).set(authed(managerAToken)).send({ jobTitle: "كاشير" });
    await request(app).patch(`/api/payroll/employees/${empInBranchA}`).set(authed(accountantToken)).send({ notes: "ملاحظة" });

    const logs = await pool.query(
      "SELECT user_id FROM audit_logs WHERE action = 'EMPLOYEE_UPDATED' AND entity_type = 'employee' AND entity_id = $1",
      [empInBranchA]
    );
    expect(logs.rows.length).toBeGreaterThanOrEqual(2);

    // مفيش أي EMPLOYEE_HR_UPDATED جديد بقى بيتسجل خالص - الاسم القديم اتوحّد
    const oldActionLogs = await pool.query(
      "SELECT COUNT(*) AS c FROM audit_logs WHERE action = 'EMPLOYEE_HR_UPDATED' AND entity_id = $1 AND created_at > now() - interval '1 minute'",
      [empInBranchA]
    );
    expect(Number(oldActionLogs.rows[0].c)).toBe(0);
  });
});

describe("سجل تغييرات الموظف (employee_history) لسه بيتسجل من المسارين", () => {
  test("تغيير القسم من hr.js بيتسجل في employee_history", async () => {
    const before = await pool.query("SELECT COUNT(*) AS c FROM employee_history WHERE employee_id = $1", [empInBranchA]);
    await request(app).patch(`/api/hr/employees/${empInBranchA}`).set(authed(managerAToken)).send({ department: "الإدارة" });
    const after = await pool.query("SELECT COUNT(*) AS c FROM employee_history WHERE employee_id = $1", [empInBranchA]);
    expect(Number(after.rows[0].c)).toBeGreaterThan(Number(before.rows[0].c));
  });
});
