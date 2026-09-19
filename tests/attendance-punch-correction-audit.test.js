// HR Foundation Hardening (HRF-5): تصحيح بصمة يدوي كان overwrite صامت بالكامل (بدون Audit Log، بدون
// سبب) - أخطر عملية HR من ناحية التلاعب لأنها بتأثر مباشرة على حساب الراتب. دلوقتي لازم سبب صريح،
// والقيمة الأصلية والجديدة بيتسجلوا كاملين في audit_logs قبل أي overwrite.
const { app, request, pool, seedUser, login, authed } = require("./helpers");

let branchId, accountantToken, employeeId;

beforeAll(async () => {
  const b = await pool.query("INSERT INTO branches (name) VALUES ('فرع-تصحيح-بصمة-جست') RETURNING id");
  branchId = b.rows[0].id;
  await seedUser({ name: "محاسب-تصحيح-بصمة-جست", email: "accountant-punchaudit@jest.test", role: "accountant" });
  accountantToken = await login("accountant-punchaudit@jest.test");

  const emp = await pool.query(
    `INSERT INTO employees (name, department, attendance_system, base_salary, shift, is_active)
     VALUES ('موظف-تصحيح-بصمة-جست', 'تشغيل الفرع', 'fingerprint_auto', 3000, 'morning', TRUE) RETURNING id`
  );
  employeeId = emp.rows[0].id;
  await pool.query(
    "INSERT INTO employee_fingerprint_codes (employee_id, branch_id, device_code) VALUES ($1,$2,'DEV-PUNCHAUDIT-JEST')",
    [employeeId, branchId]
  );
});

afterAll(async () => {
  await pool.end();
});

async function seedPunch(date, clockIn = "10:15", clockOut = "20:00") {
  const res = await pool.query(
    `INSERT INTO attendance_punches (branch_id, device_code, punch_date, clock_in, clock_out)
     VALUES ($1, 'DEV-PUNCHAUDIT-JEST', $2, $3, $4) RETURNING *`,
    [branchId, date, clockIn, clockOut]
  );
  return res.rows[0];
}

describe("PATCH /api/payroll/attendance-punches/:id - لازم سبب صريح", () => {
  test("من غير reason - يترفض 400، والصف مايتعدلش", async () => {
    const punch = await seedPunch("2027-05-01");
    const res = await request(app)
      .patch(`/api/payroll/attendance-punches/${punch.id}`)
      .set(authed(accountantToken))
      .send({ clockIn: "10:00" });
    expect(res.status).toBe(400);

    const row = await pool.query("SELECT clock_in FROM attendance_punches WHERE id = $1", [punch.id]);
    expect(row.rows[0].clock_in.slice(0, 5)).toBe("10:15");
  });

  test("بسبب صريح - ينجح ويعدّل الصف فعليًا", async () => {
    const punch = await seedPunch("2027-05-02");
    const res = await request(app)
      .patch(`/api/payroll/attendance-punches/${punch.id}`)
      .set(authed(accountantToken))
      .send({ clockIn: "10:00", reason: "عطل جهاز البصمة" });
    expect(res.status).toBe(200);
    expect(res.body.clock_in.slice(0, 5)).toBe("10:00");
  });
});

describe("الأثر الكامل (before/after/reason/employeeId) بيتسجل في audit_logs", () => {
  test("ATTENDANCE_PUNCH_CORRECTED فيه القيمة القديمة والجديدة والسبب والموظف والفرع", async () => {
    const punch = await seedPunch("2027-05-03", "10:20", "20:00");
    await request(app)
      .patch(`/api/payroll/attendance-punches/${punch.id}`)
      .set(authed(accountantToken))
      .send({ clockIn: "10:00", exempted: true, reason: "نسي يبصم دخول" });

    const log = await pool.query(
      "SELECT * FROM audit_logs WHERE action = 'ATTENDANCE_PUNCH_CORRECTED' AND entity_id = $1",
      [punch.id]
    );
    expect(log.rows.length).toBe(1);
    const entry = log.rows[0];
    expect(entry.branch_id).toBe(branchId);
    expect(entry.old_values.clock_in.slice(0, 5)).toBe("10:20");
    expect(entry.old_values.exempted).toBe(false);
    expect(entry.new_values.clock_in.slice(0, 5)).toBe("10:00");
    expect(entry.new_values.exempted).toBe(true);
    expect(entry.metadata.reason).toBe("نسي يبصم دخول");
    expect(entry.metadata.source).toBe("MANUAL");
    expect(entry.metadata.employeeId).toBe(employeeId);
  });

  test("تصحيح تاني على نفس السجل بيسجل صف Audit جديد منفصل (مش بيستبدل القديم)", async () => {
    const punch = await seedPunch("2027-05-04");
    await request(app).patch(`/api/payroll/attendance-punches/${punch.id}`).set(authed(accountantToken))
      .send({ clockIn: "10:05", reason: "تصحيح أول" });
    await request(app).patch(`/api/payroll/attendance-punches/${punch.id}`).set(authed(accountantToken))
      .send({ clockIn: "10:10", reason: "تصحيح تاني" });

    const logs = await pool.query(
      "SELECT metadata FROM audit_logs WHERE action = 'ATTENDANCE_PUNCH_CORRECTED' AND entity_id = $1 ORDER BY id",
      [punch.id]
    );
    expect(logs.rows.length).toBe(2);
    expect(logs.rows[0].metadata.reason).toBe("تصحيح أول");
    expect(logs.rows[1].metadata.reason).toBe("تصحيح تاني");
  });
});
