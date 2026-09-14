// HR-6: ربط حساب دخول موجود بالفعل (اتعمل قبل ما يبقى عنده ملف HR، أو حساب كاشير/كول سنتر اتضافله
// صلاحية self-service بعد كده) بملف موظف HR موجود - PATCH /api/users/:id { employeeId }. قبل كده الربط
// كان بيحصل بس لحظة إنشاء حساب جديد (role='employee' + employeeId في POST /)، فمفيش طريقة لحساب موجود
// بالفعل إنه يتربط بملف موظف من غير ما يتعمل من الأول.
const { app, request, pool, seedUser, login, authed } = require("./helpers");

let adminToken;
let cashierUserId, cashierToken;
let employeeId, alreadyLinkedEmployeeId, otherUserId;

beforeAll(async () => {
  await seedUser({ name: "أدمن-ربط-موظف", email: "admin-emplink@jest.test", role: "admin" });
  adminToken = await login("admin-emplink@jest.test");

  cashierUserId = await seedUser({ name: "كاشير-ربط-موظف", email: "cashier-emplink@jest.test", role: "cashier" });
  cashierToken = await login("cashier-emplink@jest.test");
  otherUserId = await seedUser({ name: "كاشير-تاني-ربط-موظف", email: "cashier2-emplink@jest.test", role: "cashier" });

  const emp = await pool.query(
    `INSERT INTO employees (name, department, attendance_system, base_salary, is_active)
     VALUES ('موظف-ربط-جست', 'التشغيل', 'none', 4000, TRUE) RETURNING id`
  );
  employeeId = emp.rows[0].id;

  const linkedEmp = await pool.query(
    `INSERT INTO employees (name, department, attendance_system, base_salary, is_active, user_id)
     VALUES ('موظف-مربوط-بالفعل-جست', 'التشغيل', 'none', 4000, TRUE, $1) RETURNING id`,
    [otherUserId]
  );
  alreadyLinkedEmployeeId = linkedEmp.rows[0].id;
});

afterAll(async () => {
  await pool.end();
});

describe("PATCH /api/users/:id { employeeId } - ربط حساب موجود بملف موظف", () => {
  test("مش أدمن -> 403", async () => {
    const res = await request(app).patch(`/api/users/${cashierUserId}`).set(authed(cashierToken)).send({ employeeId });
    expect(res.status).toBe(403);
  });

  test("employeeId غير موجود -> 400", async () => {
    const res = await request(app).patch(`/api/users/${cashierUserId}`).set(authed(adminToken)).send({ employeeId: 999999 });
    expect(res.status).toBe(400);
  });

  test("ملف موظف مربوط بحساب تاني بالفعل -> 400", async () => {
    const res = await request(app).patch(`/api/users/${cashierUserId}`).set(authed(adminToken)).send({ employeeId: alreadyLinkedEmployeeId });
    expect(res.status).toBe(400);
  });

  test("ربط صحيح -> 200، employees.user_id بيتحدث، وGET /api/users بيرجع اسم الموظف المربوط", async () => {
    const res = await request(app).patch(`/api/users/${cashierUserId}`).set(authed(adminToken)).send({ employeeId });
    expect(res.status).toBe(200);

    const emp = await pool.query("SELECT user_id FROM employees WHERE id = $1", [employeeId]);
    expect(emp.rows[0].user_id).toBe(cashierUserId);

    const list = await request(app).get("/api/users").set(authed(adminToken));
    const row = list.body.find((u) => u.id === cashierUserId);
    expect(row.employee_id).toBe(employeeId);
    expect(row.employee_name).toBe("موظف-ربط-جست");
  });

  test("الحساب نفسه اتربط بملف تاني بعد كده -> 400 (unique على employees.user_id)", async () => {
    const anotherEmp = await pool.query(
      `INSERT INTO employees (name, department, attendance_system, base_salary, is_active)
       VALUES ('موظف-تاني-ربط-جست', 'التشغيل', 'none', 4000, TRUE) RETURNING id`
    );
    const res = await request(app).patch(`/api/users/${cashierUserId}`).set(authed(adminToken)).send({ employeeId: anotherEmp.rows[0].id });
    expect(res.status).toBe(400);
  });

  test("بعد الربط، الحساب يقدر يستخدم الدخول الذاتي (بعد ما يتضافله الصلاحية)", async () => {
    await request(app).patch(`/api/users/${cashierUserId}`).set(authed(adminToken)).send({ permissions: ["orders.create", "payslips.view_own"] });
    const res = await request(app).get("/api/employee-self/profile").set(authed(cashierToken));
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(employeeId);
  });

  test("employeeId لوحده من غير أي حقل تاني - مش بيترفض بـ'مفيش حاجة تتعدل'", async () => {
    const freshUserId = await seedUser({ name: "كاشير-ربط-لوحده-جست", email: "cashier3-emplink@jest.test", role: "cashier" });
    const freshEmp = await pool.query(
      `INSERT INTO employees (name, department, attendance_system, base_salary, is_active)
       VALUES ('موظف-ربط-لوحده-جست', 'التشغيل', 'none', 4000, TRUE) RETURNING id`
    );
    const res = await request(app).patch(`/api/users/${freshUserId}`).set(authed(adminToken)).send({ employeeId: freshEmp.rows[0].id });
    expect(res.status).toBe(200);
  });
});
