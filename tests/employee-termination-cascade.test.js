// المرحلة 9A-4: إنهاء خدمة موظف قبل كده كان مجرد تحديث عمود employees.status - حساب الدخول المرتبط
// (users.is_active) فاضل شغال (وتوكنه الحالي لسه صالح)، سجل السائق المرتبط (لو موجود) فاضل قابل
// للتعيين لطلبات جديدة، ومفيش أي تنبيه لمعلّقات حقيقية (شيفت شغال، كاش سائق، فرق تسوية، ذمم، راتب
// معتمد لسه ماتصرفش) قبل الإنهاء. بيغطي: تعطيل تسجيل الدخول (وإبطال التوكن الحالي فورًا)، تعطيل أهلية
// السائق، كل نوع معلّق على حدة (بيترفض 409 من غير acknowledgeBlockers، وينجح بيه)، وتطابق نفس السلوك
// عبر المسارين (routes/hr.js وroutes/payroll.js - توافق رجعي، راجع 4D).
const { app, request, pool, seedUser, login, authed } = require("./helpers");
const { postJournalEntry, getOrCreateBranchCashAccount, getOrCreateEmployeeReceivableAccount } = require("../db/accounting-engine");

let branchId, adminToken, managerToken;
let cashPmId, itemId, variantId;

beforeAll(async () => {
  const b = await pool.query("INSERT INTO branches (name) VALUES ('فرع-9A4-إنهاء') RETURNING id");
  branchId = b.rows[0].id;
  await seedUser({ name: "أدمن-9A4", email: "admin-9a4term@jest.test", role: "admin" });
  adminToken = await login("admin-9a4term@jest.test");
  await seedUser({ branchId, name: "مدير-9A4", email: "manager-9a4term@jest.test", role: "branch_manager" });
  managerToken = await login("manager-9a4term@jest.test");

  const pm = await pool.query("INSERT INTO payment_methods (name, kind) VALUES ('كاش-9A4', 'cash') RETURNING id");
  cashPmId = pm.rows[0].id;
  const cat = await pool.query("INSERT INTO menu_categories (name) VALUES ('9A4-قسم') RETURNING id");
  const mi = await pool.query("INSERT INTO menu_items (category_id, name) VALUES ($1,'9A4-صنف') RETURNING id", [cat.rows[0].id]);
  itemId = mi.rows[0].id;
  const v = await pool.query("INSERT INTO menu_item_variants (item_id, label, price) VALUES ($1,'عادي',300) RETURNING id", [itemId]);
  variantId = v.rows[0].id;
});

afterAll(async () => {
  await pool.end();
});

async function createEmployeeWithLogin(overrides = {}) {
  const passwordHash = require("bcryptjs").hashSync("test12345", 4);
  const userRes = await pool.query(
    "INSERT INTO users (branch_id, name, email, password_hash, role) VALUES ($1,$2,$3,$4,'cashier') RETURNING id",
    [branchId, "موظف-9A4", `emp-${Date.now()}-${Math.random().toString(36).slice(2)}@jest.test`, passwordHash]
  );
  const empRes = await pool.query(
    `INSERT INTO employees (user_id, name, department, attendance_system, hire_date, base_salary, restricted_branch_id)
     VALUES ($1,'موظف-9A4','تشغيل الفرع','none','2023-01-01',3000,$2) RETURNING *`,
    [userRes.rows[0].id, branchId]
  );
  return { employee: empRes.rows[0], userId: userRes.rows[0].id, userEmail: (await pool.query("SELECT email FROM users WHERE id=$1", [userRes.rows[0].id])).rows[0].email };
}

async function createEmployeeWithDriver(overrides = {}) {
  const empRes = await pool.query(
    `INSERT INTO employees (name, department, attendance_system, hire_date, base_salary, restricted_branch_id)
     VALUES ('سائق-موظف-9A4','تشغيل الفرع','none','2023-01-01',3000,$1) RETURNING *`,
    [branchId]
  );
  const driverRes = await pool.query(
    "INSERT INTO drivers (employee_id, branch_id, driver_code, name) VALUES ($1,$2,$3,'سائق-موظف-9A4') RETURNING *",
    [empRes.rows[0].id, branchId, `DRV-9A4-${Date.now()}-${Math.floor(Math.random() * 10000)}`]
  );
  return { employee: empRes.rows[0], driver: driverRes.rows[0] };
}

describe("إنهاء خدمة موظف - تعطيل حساب الدخول فورًا (9A-4)", () => {
  test("موظف عنده حساب دخول - إنهاء الخدمة بيعطّل الحساب، وتوكنه الحالي (المُصدَر قبل الإنهاء) يترفض في الطلب اللي بعده مباشرة", async () => {
    const { employee, userEmail } = await createEmployeeWithLogin();
    const empToken = await login(userEmail);

    const before = await request(app).get("/api/hr/employees").set(authed(managerToken));
    expect(before.status).toBe(200);

    const preCheck = await request(app).get("/api/payroll/settings").set(authed(empToken));
    expect(preCheck.status).not.toBe(401);

    const term = await request(app).patch(`/api/hr/employees/${employee.id}`).set(authed(managerToken)).send({ status: "terminated" });
    expect(term.status).toBe(200);
    expect(term.body.status).toBe("terminated");
    expect(term.body.terminationCascade.userDisabled).toBe(true);

    const postCheck = await request(app).get("/api/payroll/settings").set(authed(empToken));
    expect(postCheck.status).toBe(401);

    const userRow = await pool.query("SELECT is_active FROM users WHERE email = $1", [userEmail]);
    expect(userRow.rows[0].is_active).toBe(false);
  });
});

describe("إنهاء خدمة موظف - تعطيل أهلية السائق المرتبط (9A-4)", () => {
  test("موظف عنده سجل سائق مرتبط - إنهاء الخدمة بيعطّل السائق (is_active=false، status='INACTIVE')", async () => {
    const { employee, driver } = await createEmployeeWithDriver();
    const term = await request(app).patch(`/api/hr/employees/${employee.id}`).set(authed(managerToken)).send({ status: "terminated" });
    expect(term.status).toBe(200);
    expect(term.body.terminationCascade.driverDisabled).toBe(true);

    const driverRow = await pool.query("SELECT is_active, status FROM drivers WHERE id = $1", [driver.id]);
    expect(driverRow.rows[0].is_active).toBe(false);
    expect(driverRow.rows[0].status).toBe("INACTIVE");
  });
});

describe("معلّقات الإنهاء - كل نوع بيترفض 409 من غير تأكيد، وينجح لما يتأكّد (9A-4)", () => {
  test("OPEN_SHIFT: شيفت شغال بيمنع الإنهاء من غير acknowledgeBlockers", async () => {
    const { employee, userEmail } = await createEmployeeWithLogin();
    const empToken = await login(userEmail);
    const openShift = await request(app).post("/api/shifts/open").set(authed(empToken)).send({ openingCash: 0 });
    expect(openShift.status).toBe(201);

    const term = await request(app).patch(`/api/hr/employees/${employee.id}`).set(authed(managerToken)).send({ status: "terminated" });
    expect(term.status).toBe(409);
    expect(term.body.blockers.some((b) => b.code === "OPEN_SHIFT")).toBe(true);

    const userRow = await pool.query("SELECT is_active FROM users WHERE id = $1", [(await pool.query("SELECT user_id FROM employees WHERE id=$1", [employee.id])).rows[0].user_id]);
    expect(userRow.rows[0].is_active).toBe(true); // لسه معطلش - المعلّق منع التنفيذ

    const termAck = await request(app).patch(`/api/hr/employees/${employee.id}`).set(authed(managerToken)).send({ status: "terminated", acknowledgeBlockers: true });
    expect(termAck.status).toBe(200);
  });

  test("EMPLOYEE_DEBT: موظف مديون للشركة بيمنع الإنهاء من غير تأكيد", async () => {
    const { employee, userEmail } = await createEmployeeWithLogin();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const cashAccount = await getOrCreateBranchCashAccount(client, branchId);
      const debtAccount = await getOrCreateEmployeeReceivableAccount(client, employee.id);
      await postJournalEntry(client, {
        entryDate: "2024-01-01", description: "دين اختباري 9A-4", sourceType: "shift_variance_debt", sourceId: employee.id,
        branchId, lines: [{ accountId: debtAccount.id, debit: 150 }, { accountId: cashAccount.id, credit: 150 }],
        idempotencyKey: `9a4-debt-${employee.id}`,
      });
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }

    const term = await request(app).patch(`/api/hr/employees/${employee.id}`).set(authed(managerToken)).send({ status: "terminated" });
    expect(term.status).toBe(409);
    const debtBlocker = term.body.blockers.find((b) => b.code === "EMPLOYEE_DEBT");
    expect(debtBlocker).toBeTruthy();
    expect(debtBlocker.amount).toBeCloseTo(150, 2);
    void userEmail;

    const termAck = await request(app).patch(`/api/hr/employees/${employee.id}`).set(authed(managerToken)).send({ status: "terminated", acknowledgeBlockers: true });
    expect(termAck.status).toBe(200);
  });

  test("UNPAID_PAYROLL: تشغيلة راتب معتمدة لسه ماتصرفتش بيمنع الإنهاء من غير تأكيد", async () => {
    const { employee } = await createEmployeeWithLogin();
    const run = await pool.query(
      "INSERT INTO payroll_runs (year, month, status, total_net_pay) VALUES (2024, 3, 'APPROVED', 3000) RETURNING id"
    );
    await pool.query(
      "INSERT INTO payroll_run_employees (payroll_run_id, employee_id, employee_name, branch_id, gross_pay, net_pay) VALUES ($1,$2,'موظف-9A4',$3,3000,3000)",
      [run.rows[0].id, employee.id, branchId]
    );

    const term = await request(app).patch(`/api/hr/employees/${employee.id}`).set(authed(managerToken)).send({ status: "terminated" });
    expect(term.status).toBe(409);
    const payrollBlocker = term.body.blockers.find((b) => b.code === "UNPAID_PAYROLL");
    expect(payrollBlocker).toBeTruthy();

    const termAck = await request(app).patch(`/api/hr/employees/${employee.id}`).set(authed(managerToken)).send({ status: "terminated", acknowledgeBlockers: true });
    expect(termAck.status).toBe(200);
  });

  test("ACTIVE_DRIVER_ASSIGNMENT: سائق مرتبط معاه طلب مُسند بيمنع الإنهاء من غير تأكيد", async () => {
    const { employee, driver } = await createEmployeeWithDriver();
    const order = await request(app).post("/api/orders").set(authed(managerToken)).send({
      branchId, source: "pos", orderType: "delivery", customerPhone: `015${Date.now()}`.slice(0, 11),
      addressDetails: "عنوان 9A-4", paymentMethodId: cashPmId, items: [{ itemId, variantId, quantity: 1 }],
    });
    expect(order.status).toBe(201);
    const assign = await request(app).post(`/api/deliveries/${order.body.orderId}/assign`).set(authed(managerToken)).send({ driverId: driver.id });
    expect(assign.status).toBe(200);

    const term = await request(app).patch(`/api/hr/employees/${employee.id}`).set(authed(managerToken)).send({ status: "terminated" });
    expect(term.status).toBe(409);
    expect(term.body.blockers.some((b) => b.code === "ACTIVE_DRIVER_ASSIGNMENT")).toBe(true);

    await request(app).post(`/api/deliveries/${order.body.orderId}/unassign`).set(authed(managerToken));
    const termAck = await request(app).patch(`/api/hr/employees/${employee.id}`).set(authed(managerToken)).send({ status: "terminated", acknowledgeBlockers: true });
    expect(termAck.status).toBe(200);
  });

  test("DRIVER_CASH_CUSTODY + PENDING_SETTLEMENT_REVIEW: سائق شايل كاش لسه متسواش، وبعد التسوية فرق لسه محتاج مراجعة", async () => {
    const { employee, driver } = await createEmployeeWithDriver();
    const order = await request(app).post("/api/orders").set(authed(managerToken)).send({
      branchId, source: "pos", orderType: "delivery", customerPhone: `014${Date.now()}`.slice(0, 11),
      addressDetails: "عنوان 9A-4-2", paymentMethodId: cashPmId, items: [{ itemId, variantId, quantity: 1 }],
    });
    const orderId = order.body.orderId;
    await request(app).post(`/api/deliveries/${orderId}/assign`).set(authed(managerToken)).send({ driverId: driver.id });
    await request(app).post(`/api/deliveries/${orderId}/out-for-delivery`).set(authed(managerToken));
    const delivered = await request(app).post(`/api/deliveries/${orderId}/delivered`).set(authed(managerToken)).send({ collectedAmount: 300 });
    expect(delivered.status).toBe(200);

    // لسه ماتسواش - لازم DRIVER_CASH_CUSTODY يظهر
    const term1 = await request(app).patch(`/api/hr/employees/${employee.id}`).set(authed(managerToken)).send({ status: "terminated" });
    expect(term1.status).toBe(409);
    expect(term1.body.blockers.some((b) => b.code === "DRIVER_CASH_CUSTODY")).toBe(true);

    // تسوية بفرق كبير (يتجاوز حد المراجعة التلقائي) - لازم PENDING_SETTLEMENT_REVIEW يظهر بدل الكاش
    const settle = await request(app).post("/api/driver-settlements").set(authed(managerToken)).send({ driverId: driver.id, actualHandover: 50 });
    expect(settle.status).toBe(201);

    const term2 = await request(app).patch(`/api/hr/employees/${employee.id}`).set(authed(managerToken)).send({ status: "terminated" });
    expect(term2.status).toBe(409);
    expect(term2.body.blockers.some((b) => b.code === "PENDING_SETTLEMENT_REVIEW")).toBe(true);
    expect(term2.body.blockers.some((b) => b.code === "DRIVER_CASH_CUSTODY")).toBe(false);

    const termAck = await request(app).patch(`/api/hr/employees/${employee.id}`).set(authed(managerToken)).send({ status: "terminated", acknowledgeBlockers: true });
    expect(termAck.status).toBe(200);
  });

  test("مفيش معلّقات خالص - الإنهاء بينجح من أول مرة من غير acknowledgeBlockers", async () => {
    const { employee } = await createEmployeeWithLogin();
    const term = await request(app).patch(`/api/hr/employees/${employee.id}`).set(authed(managerToken)).send({ status: "terminated" });
    expect(term.status).toBe(200);
  });
});

describe("تطابق نفس الكاسكيد عبر المسار التاني (routes/payroll.js - توافق رجعي isActive) (9A-4)", () => {
  test("PATCH /api/payroll/employees/:id {isActive:false} بيتحقق من نفس المعلّقات وبينفّذ نفس الكاسكيد", async () => {
    const { employee, userEmail } = await createEmployeeWithLogin();
    const empToken = await login(userEmail);
    const openShift = await request(app).post("/api/shifts/open").set(authed(empToken)).send({ openingCash: 0 });
    expect(openShift.status).toBe(201);

    const term = await request(app).patch(`/api/payroll/employees/${employee.id}`).set(authed(adminToken)).send({ isActive: false });
    expect(term.status).toBe(409);
    expect(term.body.blockers.some((b) => b.code === "OPEN_SHIFT")).toBe(true);

    const termAck = await request(app).patch(`/api/payroll/employees/${employee.id}`).set(authed(adminToken)).send({ isActive: false, acknowledgeBlockers: true });
    expect(termAck.status).toBe(200);
    expect(termAck.body.terminationCascade.userDisabled).toBe(true);

    const userRow = await pool.query("SELECT is_active FROM users WHERE email = $1", [userEmail]);
    expect(userRow.rows[0].is_active).toBe(false);
  });
});
