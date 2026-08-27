// المرحلة 7T: تسجيل دخول ذاتي للموظف - ضد Postgres حقيقي. بيغطي: ربط حساب دخول (role='employee')
// بملف موظف HR موجود عن طريق POST /api/users، عرض قسائم الراتب (تشغيلات معتمدة بس)، وطلب/إلغاء/مراجعة
// إجازة (الطلب الذاتي بيتحول لسجل رسمي في employee_leaves بس بعد موافقة مدير الفرع/الأدمن).
const { app, request, pool, seedUser, login, authed } = require("./helpers");

let branchA, branchB;
let adminToken, managerAToken, managerBToken;
let employeeId, employeeUserToken, employeeEmail;

beforeAll(async () => {
  const bA = await pool.query("INSERT INTO branches (name) VALUES ('فرع-موظف-ذاتي-A-جست') RETURNING id");
  branchA = bA.rows[0].id;
  const bB = await pool.query("INSERT INTO branches (name) VALUES ('فرع-موظف-ذاتي-B-جست') RETURNING id");
  branchB = bB.rows[0].id;

  await seedUser({ name: "أدمن-موظف-ذاتي", email: "admin-empself@jest.test", role: "admin" });
  await seedUser({ branchId: branchA, name: "مدير-موظف-ذاتي-A", email: "managerA-empself@jest.test", role: "branch_manager" });
  await seedUser({ branchId: branchB, name: "مدير-موظف-ذاتي-B", email: "managerB-empself@jest.test", role: "branch_manager" });

  adminToken = await login("admin-empself@jest.test");
  managerAToken = await login("managerA-empself@jest.test");
  managerBToken = await login("managerB-empself@jest.test");

  const emp = await request(app).post("/api/payroll/employees").set(authed(adminToken)).send({
    name: "موظف-جست-ذاتي", department: "التشغيل", attendanceSystem: "manual",
    restrictedBranchId: branchA, baseSalary: 5000,
  });
  employeeId = emp.body.id;
  employeeEmail = "employee-selfservice@jest.test";
});

afterAll(async () => {
  await pool.end();
});

describe("إنشاء حساب دخول ذاتي وربطه بملف الموظف", () => {
  test("role=employee من غير employeeId -> 400", async () => {
    const res = await request(app).post("/api/users").set(authed(adminToken)).send({
      name: "موظف بلا ملف", email: "no-employeeid@jest.test", password: "test12345", role: "employee",
    });
    expect(res.status).toBe(400);
  });

  test("role=employee بملف موظف غير موجود -> 400", async () => {
    const res = await request(app).post("/api/users").set(authed(adminToken)).send({
      name: "موظف ملف غلط", email: "bad-employeeid@jest.test", password: "test12345", role: "employee", employeeId: 999999,
    });
    expect(res.status).toBe(400);
  });

  test("إنشاء حساب دخول ذاتي صحيح -> 201 وربط employees.user_id", async () => {
    const res = await request(app).post("/api/users").set(authed(adminToken)).send({
      name: "موظف-جست-ذاتي", email: employeeEmail, password: "test12345", role: "employee", employeeId,
    });
    expect(res.status).toBe(201);
    expect(res.body.role).toBe("employee");
    employeeUserToken = await login(employeeEmail);

    const linked = await pool.query("SELECT user_id FROM employees WHERE id = $1", [employeeId]);
    expect(linked.rows[0].user_id).toBe(res.body.id);
  });

  test("محاولة تانية تربط نفس ملف الموظف بحساب تاني -> 400 (متربوطش قبل كده)", async () => {
    const res = await request(app).post("/api/users").set(authed(adminToken)).send({
      name: "محاولة ربط تانية", email: "second-link-attempt@jest.test", password: "test12345",
      role: "employee", employeeId,
    });
    expect(res.status).toBe(400);
  });
});

describe("GET /api/employee-self/profile", () => {
  test("موظف مربوط -> بيانات ملفه بس", async () => {
    const res = await request(app).get("/api/employee-self/profile").set(authed(employeeUserToken));
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(employeeId);
    expect(res.body.department).toBe("التشغيل");
  });

  test("دور تاني (كول سنتر مثلًا) معندوش صلاحية يوصل للسطح ده خالص", async () => {
    await seedUser({ name: "كول سنتر-موظف-ذاتي", email: "callcenter-empself@jest.test", role: "callcenter" });
    const ccToken = await login("callcenter-empself@jest.test");
    const res = await request(app).get("/api/employee-self/profile").set(authed(ccToken));
    expect(res.status).toBe(403);
  });
});

describe("GET /api/employee-self/payslips - تشغيلات معتمدة بس", () => {
  let draftRunId, approvedRunId;

  beforeAll(async () => {
    const draft = await pool.query(
      "INSERT INTO payroll_runs (year, month, status, total_net_pay) VALUES (2099, 1, 'DRAFT', 5000) RETURNING id"
    );
    draftRunId = draft.rows[0].id;
    await pool.query(
      `INSERT INTO payroll_run_employees (payroll_run_id, employee_id, employee_name, branch_id, gross_pay, net_pay)
       VALUES ($1,$2,'موظف-جست-ذاتي',$3,5000,5000)`,
      [draftRunId, employeeId, branchA]
    );

    const approved = await pool.query(
      "INSERT INTO payroll_runs (year, month, status, total_net_pay) VALUES (2099, 2, 'APPROVED', 4800) RETURNING id"
    );
    approvedRunId = approved.rows[0].id;
    await pool.query(
      `INSERT INTO payroll_run_employees (payroll_run_id, employee_id, employee_name, branch_id, gross_pay, advances, net_pay)
       VALUES ($1,$2,'موظف-جست-ذاتي',$3,5000,200,4800)`,
      [approvedRunId, employeeId, branchA]
    );
  });

  test("تشغيلة مسودة (DRAFT) مش ظاهرة، المعتمدة (APPROVED) بس اللي ظاهرة", async () => {
    const res = await request(app).get("/api/employee-self/payslips").set(authed(employeeUserToken));
    expect(res.status).toBe(200);
    expect(res.body.length).toBe(1);
    expect(res.body[0].month).toBe(2);
    expect(Number(res.body[0].net_pay)).toBe(4800);
    expect(Number(res.body[0].paid_amount)).toBe(0);
  });
});

describe("طلبات الإجازة الذاتية - تقديم/إلغاء/مراجعة", () => {
  let requestId;

  test("تقديم طلب إجازة -> 201 وحالته pending", async () => {
    const res = await request(app).post("/api/employee-self/leave-requests").set(authed(employeeUserToken)).send({
      leaveType: "annual", startDate: "2099-03-01", endDate: "2099-03-03", reason: "سفر",
    });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe("pending");
    expect(res.body.days).toBe(3);
    requestId = res.body.id;
  });

  test("مدير فرع تاني (مش فرع الموظف) مايشوفوش في القايمة لما يفلتر بفرعه، ومايقدرش يوافق عليه", async () => {
    const list = await request(app).get("/api/hr/leave-requests?status=pending").set(authed(managerBToken));
    expect(list.body.find((r) => r.id === requestId)).toBeUndefined();

    const approve = await request(app).post(`/api/hr/leave-requests/${requestId}/approve`).set(authed(managerBToken)).send({});
    expect(approve.status).toBe(403);
  });

  test("مدير فرع الموظف يشوفه في القايمة ويوافق عليه -> بيتسجل صف رسمي في employee_leaves", async () => {
    const list = await request(app).get("/api/hr/leave-requests?status=pending").set(authed(managerAToken));
    expect(list.body.find((r) => r.id === requestId)).toBeTruthy();

    const approve = await request(app).post(`/api/hr/leave-requests/${requestId}/approve`).set(authed(managerAToken)).send({
      reviewNotes: "تمام",
    });
    expect(approve.status).toBe(200);
    expect(approve.body.status).toBe("approved");
    expect(approve.body.resulting_leave_id).toBeTruthy();

    const leave = await pool.query("SELECT * FROM employee_leaves WHERE id = $1", [approve.body.resulting_leave_id]);
    expect(leave.rows.length).toBe(1);
    expect(leave.rows[0].employee_id).toBe(employeeId);
    expect(leave.rows[0].days).toBe(3);
  });

  test("مينفعش توافق/ترفض طلب اتراجع بالفعل", async () => {
    const res = await request(app).post(`/api/hr/leave-requests/${requestId}/reject`).set(authed(managerAToken)).send({
      reason: "متأخر",
    });
    expect(res.status).toBe(400);
  });

  test("طلب اتوافق عليه مينفعش الموظف يلغيه بنفسه", async () => {
    const res = await request(app).post(`/api/employee-self/leave-requests/${requestId}/cancel`).set(authed(employeeUserToken));
    expect(res.status).toBe(400);
  });

  test("طلب لسه pending - الموظف يقدر يلغيه بنفسه", async () => {
    const submit = await request(app).post("/api/employee-self/leave-requests").set(authed(employeeUserToken)).send({
      leaveType: "casual", startDate: "2099-04-01", endDate: "2099-04-01",
    });
    expect(submit.status).toBe(201);
    const cancel = await request(app).post(`/api/employee-self/leave-requests/${submit.body.id}/cancel`).set(authed(employeeUserToken));
    expect(cancel.status).toBe(200);
    expect(cancel.body.status).toBe("cancelled");
  });

  test("رفض طلب -> بيتسجل السبب من غير أي صف في employee_leaves", async () => {
    const submit = await request(app).post("/api/employee-self/leave-requests").set(authed(employeeUserToken)).send({
      leaveType: "sick", startDate: "2099-05-01", endDate: "2099-05-02",
    });
    const reject = await request(app).post(`/api/hr/leave-requests/${submit.body.id}/reject`).set(authed(managerAToken)).send({
      reason: "رصيد إجازات مرضية خلص",
    });
    expect(reject.status).toBe(200);
    expect(reject.body.status).toBe("rejected");
    expect(reject.body.review_notes).toBe("رصيد إجازات مرضية خلص");
    expect(reject.body.resulting_leave_id).toBeNull();
  });

  test("طلب من غير سبب الرفض -> 400", async () => {
    const submit = await request(app).post("/api/employee-self/leave-requests").set(authed(employeeUserToken)).send({
      leaveType: "unpaid", startDate: "2099-06-01", endDate: "2099-06-01",
    });
    const reject = await request(app).post(`/api/hr/leave-requests/${submit.body.id}/reject`).set(authed(managerAToken)).send({});
    expect(reject.status).toBe(400);
  });
});
