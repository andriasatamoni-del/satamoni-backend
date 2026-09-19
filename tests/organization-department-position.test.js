// HR Foundation Hardening (HRF-6): Department/Position كـentities حقيقية. بيغطي: الأقسام الكانونية
// السبعة موجودة من schema.sql (Jest بيبني من عليه فاضي)، CRUD الأقسام/المسميات (صلاحيات + Audit)،
// إنشاء/تعديل موظف بـdepartmentId/positionId (المسار الجديد) بيزامن تلقائيًا department/job_title
// النصيين (توافق رجعي كامل مع أي استهلاك حالي)، والمسار القديم (نص حر) لسه شغال زي ما كان.
const { app, request, pool, seedUser, login, authed } = require("./helpers");

let adminToken, branchManagerToken, cashierToken;
let pizzaDeptId;

beforeAll(async () => {
  await seedUser({ name: "أدمن-هيكل-جست", email: "admin-org@jest.test", role: "admin" });
  adminToken = await login("admin-org@jest.test");
  await seedUser({ name: "مدير فرع-هيكل-جست", email: "manager-org@jest.test", role: "branch_manager" });
  branchManagerToken = await login("manager-org@jest.test");
  await seedUser({ name: "كاشير-هيكل-جست", email: "cashier-org@jest.test", role: "cashier" });
  cashierToken = await login("cashier-org@jest.test");

  const pizza = await pool.query("SELECT id FROM departments WHERE name = 'بيتزا'");
  pizzaDeptId = pizza.rows[0].id;
});

afterAll(async () => {
  await pool.end();
});

describe("الأقسام الكانونية السبعة موجودة فعليًا من schema.sql", () => {
  test("GET /api/organization/departments يرجع الـ7 كلهم على الأقل", async () => {
    const res = await request(app).get("/api/organization/departments").set(authed(branchManagerToken));
    expect(res.status).toBe(200);
    const names = res.body.map((d) => d.name);
    expect(names).toEqual(expect.arrayContaining(["بيتزا", "فطير", "تشغيل الفرع", "الإدارة", "حسابات", "كول سنتر", "المطبخ المركزي"]));
  });
});

describe("صلاحيات إدارة الهيكل - organization.manage أدمن بس", () => {
  test("مدير فرع (معاه organization.view بس) يقدر يشوف القائمة", async () => {
    const res = await request(app).get("/api/organization/departments").set(authed(branchManagerToken));
    expect(res.status).toBe(200);
  });

  test("مدير فرع مايقدرش ينشئ قسم جديد - 403", async () => {
    const res = await request(app).post("/api/organization/departments").set(authed(branchManagerToken))
      .send({ code: "TEST_DEPT", name: "قسم تجريبي" });
    expect(res.status).toBe(403);
  });

  test("كاشير مايقدرش يشوف القائمة أصلًا - 403", async () => {
    const res = await request(app).get("/api/organization/departments").set(authed(cashierToken));
    expect(res.status).toBe(403);
  });

  test("أدمن يقدر ينشئ قسم جديد، ومسجّل في audit_logs", async () => {
    const res = await request(app).post("/api/organization/departments").set(authed(adminToken))
      .send({ code: "TEST_DEPT_JEST", name: "قسم تجريبي جست" });
    expect(res.status).toBe(201);
    const log = await pool.query("SELECT * FROM audit_logs WHERE action = 'DEPARTMENT_CREATED' AND entity_id = $1", [res.body.id]);
    expect(log.rows.length).toBe(1);
  });

  test("أدمن يقدر يعطّل قسم (status='inactive') - مفيش DELETE endpoint خالص", async () => {
    const created = await request(app).post("/api/organization/departments").set(authed(adminToken))
      .send({ code: "TO_DEACTIVATE_JEST", name: "هيتعطّل" });
    const patchRes = await request(app).patch(`/api/organization/departments/${created.body.id}`)
      .set(authed(adminToken)).send({ status: "inactive" });
    expect(patchRes.status).toBe(200);
    expect(patchRes.body.status).toBe("inactive");

    const deleteRes = await request(app).delete(`/api/organization/departments/${created.body.id}`).set(authed(adminToken));
    expect(deleteRes.status).toBe(404); // مفيش route DELETE خالص
  });
});

describe("إنشاء/تعديل موظف بـdepartmentId - بيزامن department النصي تلقائيًا", () => {
  test("POST /api/payroll/employees بـdepartmentId بس (من غير department نصي) - ينجح والنص بيتحدد تلقائيًا", async () => {
    const res = await request(app).post("/api/payroll/employees").set(authed(adminToken)).send({
      name: "موظف-هيكل-جست", departmentId: pizzaDeptId, attendanceSystem: "none", baseSalary: 2000,
    });
    expect(res.status).toBe(201);
    expect(res.body.department).toBe("بيتزا");
    expect(res.body.department_id).toBe(pizzaDeptId);
  });

  test("PATCH بـdepartmentId بس - بيحدّث النص القديم تلقائيًا وبيتسجل في employee_history", async () => {
    const emp = await pool.query(
      `INSERT INTO employees (name, department, attendance_system, base_salary) VALUES ('موظف-تحديث-هيكل-جست','فطير','none',2000) RETURNING id`
    );
    const empId = emp.rows[0].id;
    const accounts = await pool.query("SELECT id FROM departments WHERE name = 'حسابات'");

    const res = await request(app).patch(`/api/payroll/employees/${empId}`).set(authed(adminToken))
      .send({ departmentId: accounts.rows[0].id });
    expect(res.status).toBe(200);
    expect(res.body.department).toBe("حسابات");

    const history = await pool.query(
      "SELECT * FROM employee_history WHERE employee_id = $1 AND field_name = 'department' ORDER BY id DESC LIMIT 1",
      [empId]
    );
    expect(history.rows[0].old_value).toBe("فطير");
    expect(history.rows[0].new_value).toBe("حسابات");
  });

  test("المسار القديم (نص حر department) لسه شغال زي ما كان - توافق رجعي كامل", async () => {
    const res = await request(app).post("/api/payroll/employees").set(authed(adminToken)).send({
      name: "موظف-نص-حر-جست", department: "قسم قديم حر جست", attendanceSystem: "none", baseSalary: 1500,
    });
    expect(res.status).toBe(201);
    expect(res.body.department).toBe("قسم قديم حر جست");
    expect(res.body.department_id).toBeNull();
  });
});
