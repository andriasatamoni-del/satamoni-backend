// HR Foundation Hardening (HRF-4): كان مفيش أي Audit Log على إنشاء/حذف سلفة أو جزاء أو مكافأة، والحذف
// كان DELETE حقيقي بدون رجعة - ثغرتين حقيقيتين اتكشفوا في التدقيق. دلوقتي: (1) الإنشاء مسجّل بالكامل،
// (2) "الحذف" بقى soft-cancel بسبب إجباري ومسجّل بالكامل، (3) سجل ملغى بيتستبعد تلقائيًا من حساب
// الرواتب لكن بيفضل مرئي في القائمة (مش بيختفي).
const { app, request, pool, seedUser, login, authed } = require("./helpers");

let accountantToken;
let employeeId;

beforeAll(async () => {
  await seedUser({ name: "محاسب-جزاءات-جست", email: "accountant-adjaudit@jest.test", role: "accountant" });
  accountantToken = await login("accountant-adjaudit@jest.test");

  const emp = await pool.query(
    `INSERT INTO employees (name, department, attendance_system, base_salary, is_active)
     VALUES ('موظف-جزاءات-جست', 'الإدارة', 'none', 4000, TRUE) RETURNING id`
  );
  employeeId = emp.rows[0].id;
});

afterAll(async () => {
  await pool.end();
});

describe("إنشاء سلفة/جزاء/مكافأة - بقى مسجّل في audit_logs", () => {
  test("POST /adjustments يسجل PAYROLL_ADJUSTMENT_CREATED", async () => {
    const res = await request(app).post("/api/payroll/adjustments").set(authed(accountantToken)).send({
      employeeId, entryDate: "2027-03-01", adjustmentType: "penalty", amount: 100, notes: "تأخير متكرر",
    });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe("ACTIVE");

    const log = await pool.query(
      "SELECT * FROM audit_logs WHERE action = 'PAYROLL_ADJUSTMENT_CREATED' AND entity_id = $1",
      [res.body.id]
    );
    expect(log.rows.length).toBe(1);
    expect(log.rows[0].user_id).not.toBeNull();
  });
});

describe("إلغاء (soft-cancel) بدل حذف صامت", () => {
  let adjId;

  beforeEach(async () => {
    const res = await request(app).post("/api/payroll/adjustments").set(authed(accountantToken)).send({
      employeeId, entryDate: "2027-03-02", adjustmentType: "bonus", amount: 200, notes: "مكافأة اختبار",
    });
    adjId = res.body.id;
  });

  test("الإلغاء من غير سبب يترفض 400", async () => {
    const res = await request(app).post(`/api/payroll/adjustments/${adjId}/cancel`).set(authed(accountantToken)).send({});
    expect(res.status).toBe(400);
  });

  test("الإلغاء بسبب صريح ينجح، والسجل التاريخي بيفضل موجود (مش DELETE)", async () => {
    const res = await request(app).post(`/api/payroll/adjustments/${adjId}/cancel`)
      .set(authed(accountantToken)).send({ reason: "اتسجلت غلط" });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("CANCELLED");
    expect(res.body.cancellation_reason).toBe("اتسجلت غلط");

    // لسه موجود في القاعدة - مفيش أي DELETE حصل
    const row = await pool.query("SELECT * FROM payroll_adjustments WHERE id = $1", [adjId]);
    expect(row.rows.length).toBe(1);
    expect(row.rows[0].status).toBe("CANCELLED");

    // ولسه بيرجع من GET /adjustments (مش بيختفي من القائمة)
    const list = await request(app).get("/api/payroll/adjustments?employeeId=" + employeeId).set(authed(accountantToken));
    expect(list.body.some((r) => r.id === adjId)).toBe(true);
  });

  test("الإلغاء بيتسجل في audit_logs بالسبب وقبل/بعد الحالة", async () => {
    await request(app).post(`/api/payroll/adjustments/${adjId}/cancel`)
      .set(authed(accountantToken)).send({ reason: "سبب مسجّل" });
    const log = await pool.query(
      "SELECT * FROM audit_logs WHERE action = 'PAYROLL_ADJUSTMENT_CANCELLED' AND entity_id = $1",
      [adjId]
    );
    expect(log.rows.length).toBe(1);
    expect(log.rows[0].metadata.reason).toBe("سبب مسجّل");
    expect(log.rows[0].old_values.status).toBe("ACTIVE");
    expect(log.rows[0].new_values.status).toBe("CANCELLED");
  });

  test("إلغاء سجل ملغى بالفعل يترفض 400", async () => {
    await request(app).post(`/api/payroll/adjustments/${adjId}/cancel`).set(authed(accountantToken)).send({ reason: "أول مرة" });
    const second = await request(app).post(`/api/payroll/adjustments/${adjId}/cancel`).set(authed(accountantToken)).send({ reason: "تاني مرة" });
    expect(second.status).toBe(400);
  });

  test("مفيش endpoint DELETE خالص بقى (استُبدل بالكامل بـ/cancel)", async () => {
    const res = await request(app).delete(`/api/payroll/adjustments/${adjId}`).set(authed(accountantToken));
    expect(res.status).toBe(404);
  });
});

describe("سجل ملغى بيتستبعد من حساب الرواتب تلقائيًا", () => {
  test("جزاء ملغى مبيتخصمش من صافي الراتب في GET /summary", async () => {
    const created = await request(app).post("/api/payroll/adjustments").set(authed(accountantToken)).send({
      employeeId, entryDate: "2027-04-05", adjustmentType: "penalty", amount: 500, notes: "جزاء هيتلغي",
    });
    const beforeCancel = await request(app).get("/api/payroll/summary?year=2027&month=4").set(authed(accountantToken));
    const lineBefore = beforeCancel.body.employees.find((r) => r.employeeId === employeeId);
    expect(Number(lineBefore.penalties)).toBeGreaterThanOrEqual(500);

    await request(app).post(`/api/payroll/adjustments/${created.body.id}/cancel`)
      .set(authed(accountantToken)).send({ reason: "اتلغى" });

    const afterCancel = await request(app).get("/api/payroll/summary?year=2027&month=4").set(authed(accountantToken));
    const lineAfter = afterCancel.body.employees.find((r) => r.employeeId === employeeId);
    expect(Number(lineAfter.penalties)).toBe(0);
  });
});
