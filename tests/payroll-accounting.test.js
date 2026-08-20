// المرحلة 4C: محاسبة الرواتب - تشغيلة رسمية (DRAFT→APPROVED→CANCELLED) بـsnapshot ثابت من نفس محرك
// GET /api/payroll/summary، ترحيل تلقائي (مدين 6100 الرواتب مقسّم على الفروع / دائن 2400 رواتب
// مستحقة)، سداد فعلي لكل موظف (زي سداد المورد بالظبط)، إلغاء (عكس القيد، أدمن بس، مرفوض لو فيه
// مدفوعات فعلية بالفعل)، صلاحيات، وidempotency تحت التزامن.
const { app, request, pool, seedUser, login, authed } = require("./helpers");

let branchId;
let adminToken, accountantToken, managerToken;
let overheadEmployeeId, branchEmployeeId;
let sharedRunId;

beforeAll(async () => {
  const b = await pool.query("INSERT INTO branches (name) VALUES ('فرع رواتب-جست') RETURNING id");
  branchId = b.rows[0].id;

  await seedUser({ name: "أدمن-رواتب", email: "admin-payroll@jest.test", role: "admin" });
  await seedUser({ name: "محاسب-رواتب", email: "accountant-payroll@jest.test", role: "accountant" });
  await seedUser({ branchId, name: "مدير فرع-رواتب", email: "manager-payroll@jest.test", role: "branch_manager" });

  adminToken = await login("admin-payroll@jest.test");
  accountantToken = await login("accountant-payroll@jest.test");
  managerToken = await login("manager-payroll@jest.test");

  // موظف إداري بدون تتبع حضور - راتبه = base_salary بالظبط، مفيش فرع (تكلفة عامة/overhead)
  const overhead = await pool.query(
    `INSERT INTO employees (name, department, attendance_system, base_salary, is_active)
     VALUES ('موظف إداري-رواتب-جست', 'الإدارة', 'none', 5000, TRUE) RETURNING id`
  );
  overheadEmployeeId = overhead.rows[0].id;

  // موظف بصمة تلقائي مرتبط بالفرع - عشان نختبر توزيع تكلفة الرواتب على الفروع في القيد المحاسبي.
  // حضور كامل وفي الميعاد طول شهر يونيو 2026 (30 يوم) عشان صافي راتبه يطلع موجب بوضوح
  const branchEmp = await pool.query(
    `INSERT INTO employees (name, department, attendance_system, base_salary, shift, is_active)
     VALUES ('كاشير-رواتب-جست', 'تشغيل الفرع', 'fingerprint_auto', 4000, 'morning', TRUE) RETURNING id`
  );
  branchEmployeeId = branchEmp.rows[0].id;
  await pool.query(
    "INSERT INTO employee_fingerprint_codes (employee_id, branch_id, device_code) VALUES ($1,$2,'DEV-PAYROLL-JEST')",
    [branchEmployeeId, branchId]
  );
  await pool.query(
    `INSERT INTO attendance_punches (branch_id, device_code, punch_date, clock_in, clock_out)
     SELECT $1, 'DEV-PAYROLL-JEST', d::date, '10:00', '20:00'
     FROM generate_series('2026-06-01'::date, '2026-06-30'::date, '1 day') AS d`,
    [branchId]
  );
});

afterAll(async () => {
  await pool.end();
});

describe("1) صلاحيات نظام الرواتب (أدمن ومحاسب بس، زي ما كان قبل كده)", () => {
  test("مدير فرع ممنوع من أي endpoint في /api/payroll", async () => {
    const res = await request(app).get("/api/payroll/runs").set(authed(managerToken));
    expect(res.status).toBe(403);
  });
});

describe("2) إنشاء تشغيلة رواتب DRAFT - snapshot ثابت", () => {
  let runId;

  test("إنشاء تشغيلة يونيو 2026", async () => {
    const res = await request(app).post("/api/payroll/runs").set(authed(accountantToken)).send({ year: 2026, month: 6 });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe("DRAFT");
    expect(res.body.employeeCount).toBeGreaterThanOrEqual(2);
    runId = res.body.id;
    sharedRunId = runId;
  });

  test("تكرار نفس الشهر مرفوض (409)", async () => {
    const res = await request(app).post("/api/payroll/runs").set(authed(accountantToken)).send({ year: 2026, month: 6 });
    expect(res.status).toBe(409);
  });

  test("تفاصيل التشغيلة فيها سطر لكل موظف بالفرع الصح", async () => {
    const res = await request(app).get(`/api/payroll/runs/${runId}`).set(authed(adminToken));
    expect(res.status).toBe(200);
    const overheadLine = res.body.employees.find((e) => e.employee_id === overheadEmployeeId);
    expect(Number(overheadLine.net_pay)).toBe(5000);
    expect(overheadLine.branch_id).toBeNull();

    const branchLine = res.body.employees.find((e) => e.employee_id === branchEmployeeId);
    expect(branchLine.branch_id).toBe(branchId);
    expect(Number(branchLine.net_pay)).toBeGreaterThan(0);
  });
});

describe("3) الاعتماد يرحّل قيد متزن مقسّم على الفروع", () => {
  let runId, overheadNetPay, branchNetPay, journalEntryId;

  test("اعتماد التشغيلة - مدين 6100 (سطر منفصل لكل فرع) / دائن 2400 بالإجمالي", async () => {
    runId = sharedRunId;
    const before = await request(app).get(`/api/payroll/runs/${runId}`).set(authed(adminToken));
    overheadNetPay = before.body.employees.filter((e) => e.branch_id === null).reduce((s, e) => s + Number(e.net_pay), 0);
    branchNetPay = before.body.employees.filter((e) => e.branch_id === branchId).reduce((s, e) => s + Number(e.net_pay), 0);
    const totalNetPay = overheadNetPay + branchNetPay;

    const res = await request(app).post(`/api/payroll/runs/${runId}/approve`).set(authed(accountantToken));
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("APPROVED");
    expect(res.body.journal_entry_id).toBeTruthy();
    journalEntryId = res.body.journal_entry_id;

    const lines = await pool.query(
      "SELECT jel.*, a.code FROM journal_entry_lines jel JOIN accounts a ON a.id = jel.account_id WHERE journal_entry_id = $1",
      [journalEntryId]
    );
    const totalDebit = lines.rows.reduce((s, l) => s + Number(l.debit), 0);
    const totalCredit = lines.rows.reduce((s, l) => s + Number(l.credit), 0);
    expect(totalDebit).toBeCloseTo(totalCredit, 5);
    expect(totalDebit).toBeCloseTo(totalNetPay, 5);

    const payableLine = lines.rows.find((l) => l.code === "2400");
    expect(Number(payableLine.credit)).toBeCloseTo(totalNetPay, 5);

    const expenseLines = lines.rows.filter((l) => l.code === "6100");
    const overheadExpenseLine = expenseLines.find((l) => l.branch_id === null);
    const branchExpenseLine = expenseLines.find((l) => l.branch_id === branchId);
    expect(Number(overheadExpenseLine.debit)).toBeCloseTo(overheadNetPay, 5);
    expect(Number(branchExpenseLine.debit)).toBeCloseTo(branchNetPay, 5);
  });

  test("مينفعش تعتمد تشغيلة معتمدة بالفعل", async () => {
    const res = await request(app).post(`/api/payroll/runs/${runId}/approve`).set(authed(accountantToken));
    expect(res.status).toBe(400);
  });
});

describe("4) سداد فعلي لموظف - جزئي ثم كامل، تجاوز المتبقي مرفوض، وidempotency تحت التزامن", () => {
  let runId, overheadRunEmployeeId, branchRunEmployeeId;

  test("سداد جزئي (2000 من 5000) لموظف إداري", async () => {
    runId = sharedRunId;
    const detail = await request(app).get(`/api/payroll/runs/${runId}`).set(authed(adminToken));
    overheadRunEmployeeId = detail.body.employees.find((e) => e.employee_id === overheadEmployeeId).id;
    branchRunEmployeeId = detail.body.employees.find((e) => e.employee_id === branchEmployeeId).id;

    const res = await request(app).post(`/api/payroll/runs/${runId}/payments`).set(authed(accountantToken)).send({
      payrollRunEmployeeId: overheadRunEmployeeId, branchId, amount: 2000,
    });
    expect(res.status).toBe(201);
    expect(res.body.journal_entry_id).toBeTruthy();

    const lines = await pool.query(
      "SELECT jel.*, a.code FROM journal_entry_lines jel JOIN accounts a ON a.id = jel.account_id WHERE journal_entry_id = $1",
      [res.body.journal_entry_id]
    );
    const payableLine = lines.rows.find((l) => l.code === "2400");
    const cashLine = lines.rows.find((l) => l.code.startsWith("1100"));
    expect(Number(payableLine.debit)).toBe(2000);
    expect(Number(cashLine.credit)).toBe(2000);
    expect(payableLine.reference_type).toBe("employee");
    expect(payableLine.reference_id).toBe(overheadEmployeeId);
  });

  test("سداد أكبر من المتبقي (متبقي 3000 بس) مرفوض", async () => {
    const res = await request(app).post(`/api/payroll/runs/${runId}/payments`).set(authed(accountantToken)).send({
      payrollRunEmployeeId: overheadRunEmployeeId, branchId, amount: 4000,
    });
    expect(res.status).toBe(400);
  });

  test("سداد الباقي بالظبط (3000) - المتبقي يبقى صفر", async () => {
    const res = await request(app).post(`/api/payroll/runs/${runId}/payments`).set(authed(accountantToken)).send({
      payrollRunEmployeeId: overheadRunEmployeeId, branchId, amount: 3000,
    });
    expect(res.status).toBe(201);
    const detail = await request(app).get(`/api/payroll/runs/${runId}`).set(authed(adminToken));
    const line = detail.body.employees.find((e) => e.id === overheadRunEmployeeId);
    expect(Number(line.paid_amount)).toBe(5000);
  });

  test("3 طلبات سداد متزامنة بنفس idempotencyKey - سداد واحد بس بيترحّل فعليًا", async () => {
    const idempotencyKey = "concurrent-payroll-payment-jest-1";
    const payload = { payrollRunEmployeeId: branchRunEmployeeId, branchId, amount: 100, idempotencyKey };
    const results = await Promise.all(
      Array.from({ length: 3 }, () => request(app).post(`/api/payroll/runs/${runId}/payments`).set(authed(accountantToken)).send(payload))
    );
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([200, 200, 201]);
    const ids = new Set(results.map((r) => r.body.id));
    expect(ids.size).toBe(1);

    const payments = await pool.query("SELECT COUNT(*) FROM payroll_payments WHERE idempotency_key = $1", [idempotencyKey]);
    expect(Number(payments.rows[0].count)).toBe(1);
  });
});

describe("5) إلغاء تشغيلة: مرفوض لو فيه مدفوعات، أدمن بس، وبيعكس القيد", () => {
  test("مينفعش تلغي تشغيلة يونيو - فيها مدفوعات فعلية بالفعل", async () => {
    const res = await request(app).post(`/api/payroll/runs/${sharedRunId}/cancel`).set(authed(adminToken)).send({ reason: "test" });
    expect(res.status).toBe(400);
  });

  test("تشغيلة تانية (يوليو) بدون مدفوعات - محاسب ممنوع من الإلغاء، أدمن بيعكس القيد بنجاح", async () => {
    // نعطّل موظف الفرع مؤقتًا عشان تشغيلة يوليو تفضل نضيفة (مفيش بصمات ليه في يوليو، وده مش موضوع
    // الاختبار ده أصلًا - موضوعه دورة حياة الإلغاء بس)
    await pool.query("UPDATE employees SET is_active = FALSE WHERE id = $1", [branchEmployeeId]);

    const create = await request(app).post("/api/payroll/runs").set(authed(accountantToken)).send({ year: 2026, month: 7 });
    expect(create.status).toBe(201);
    const secondRunId = create.body.id;
    const approve = await request(app).post(`/api/payroll/runs/${secondRunId}/approve`).set(authed(accountantToken));
    expect(approve.status).toBe(200);

    const denied = await request(app).post(`/api/payroll/runs/${secondRunId}/cancel`).set(authed(accountantToken)).send({ reason: "test" });
    expect(denied.status).toBe(403);

    const cancel = await request(app).post(`/api/payroll/runs/${secondRunId}/cancel`).set(authed(adminToken)).send({ reason: "غلط في الحساب" });
    expect(cancel.status).toBe(200);
    expect(cancel.body.status).toBe("CANCELLED");

    const original = await pool.query("SELECT status FROM journal_entries WHERE id = $1", [approve.body.journal_entry_id]);
    expect(original.rows[0].status).toBe("REVERSED");

    await pool.query("UPDATE employees SET is_active = TRUE WHERE id = $1", [branchEmployeeId]);
  });
});

describe("6) التقرير التشغيلي القديم (income-statement) لسه شغال بعد نقل computePayrollCostByBranch", () => {
  test("GET /api/reports/income-statement بيرجع 200 وبيحسب تكلفة رواتب", async () => {
    const res = await request(app).get("/api/reports/income-statement?year=2026&month=6").set(authed(adminToken));
    expect(res.status).toBe(200);
    expect(typeof res.body.payrollCost).toBe("number");
  });
});
