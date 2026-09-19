// HR Foundation Hardening (HRF-2): القاعدة الصحيحة "أكتر تشغيلة رواتب نشطة واحدة لكل شهر" (نشطة =
// DRAFT أو APPROVED) بدل "تشغيلة واحدة للأبد بغض النظر عن حالتها" - partial unique index
// (idx_payroll_runs_active_period) بيستثني CANCELLED فتفضل الفرصة مفتوحة لإعادة إنشاء تشغيلة تانية لنفس
// الشهر بعد الإلغاء، وبيمنع تشغيلتين نشطتين متزامنتين (حتى تحت race condition حقيقي) لأنه فهرس ذرّي على
// مستوى القاعدة نفسها، مش تحقق تطبيقي بس.
//
// ملحوظة مهمة: مسار الإلغاء الحقيقي في النظام هو APPROVED -> CANCELLED بس (مفيش مسار لإلغاء/حذف تشغيلة
// DRAFT مباشرة - ده قرار عمل سابق مش جزء من الإصلاح ده، فالاختبارات هنا بتمر بمسار الاعتماد الحقيقي
// (approve) قبل الإلغاء (cancel) في كل مرة، بالظبط زي ما يحصل فعليًا في الإنتاج
const { app, request, pool, seedUser, login, authed } = require("./helpers");

let accountantToken, adminToken;

beforeAll(async () => {
  await seedUser({ name: "محاسب-تشغيلات-جست", email: "accountant-runperiod@jest.test", role: "accountant" });
  accountantToken = await login("accountant-runperiod@jest.test");
  await seedUser({ name: "أدمن-تشغيلات-جست", email: "admin-runperiod@jest.test", role: "admin" });
  adminToken = await login("admin-runperiod@jest.test");

  // موظف إداري بدون تتبع حضور (overhead) - راتبه ثابت = base_salary، يكفي عشان computePayrollSummary
  // يرجع صف واحد على الأقل لأي شهر (شرط أساسي عشان POST /runs مايرفضش بـ"مفيش موظفين نشطين")
  await pool.query(
    `INSERT INTO employees (name, department, attendance_system, base_salary, is_active)
     VALUES ('موظف إداري-تشغيلات-جست', 'الإدارة', 'none', 3000, TRUE)`
  );
});

afterAll(async () => {
  await pool.end();
});

async function createRun(year, month) {
  return request(app).post("/api/payroll/runs").set(authed(accountantToken)).send({ year, month });
}
async function approveRun(id) {
  return request(app).post(`/api/payroll/runs/${id}/approve`).set(authed(accountantToken));
}
async function cancelRun(id, reason = "اختبار إلغاء") {
  return request(app).post(`/api/payroll/runs/${id}/cancel`).set(authed(adminToken)).send({ reason });
}
async function activeRunFor(year, month) {
  const list = await request(app).get(`/api/payroll/runs?year=${year}&month=${month}`).set(authed(accountantToken));
  return list.body.find((r) => r.status === "DRAFT" || r.status === "APPROVED");
}

describe("قاعدة 'أكتر تشغيلة نشطة واحدة لكل شهر' - الاختبارات التسعة المطلوبة", () => {
  test("1) إنشاء أول تشغيلة رواتب لشهر جديد - ينجح", async () => {
    const res = await createRun(2027, 1);
    expect(res.status).toBe(201);
    expect(res.body.status).toBe("DRAFT");
  });

  test("2) إنشاء تشغيلة نشطة تانية لنفس الشهر (لسه DRAFT) - يترفض 409", async () => {
    const res = await createRun(2027, 1);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("ACTIVE_PAYROLL_RUN_EXISTS");
    expect(res.body.activeRun.status).toBe("DRAFT");
  });

  test("3) اعتماد ثم إلغاء التشغيلة الأولى - ينجح (المسار الحقيقي الوحيد للإلغاء)", async () => {
    const run = await activeRunFor(2027, 1);
    const approveRes = await approveRun(run.id);
    expect(approveRes.status).toBe(200);
    const cancelRes = await cancelRun(run.id);
    expect(cancelRes.status).toBe(200);
    expect(cancelRes.body.status).toBe("CANCELLED");
  });

  test("4) إنشاء تشغيلة بديلة بعد الإلغاء لنفس الشهر - ينجح (ده تحديدًا الباج اللي اتصلح)", async () => {
    const res = await createRun(2027, 1);
    expect(res.status).toBe(201);
    expect(res.body.status).toBe("DRAFT");
  });

  test("5) اعتماد ثم إلغاء التشغيلة البديلة - ينجح", async () => {
    const run = await activeRunFor(2027, 1);
    await approveRun(run.id);
    const cancelRes = await cancelRun(run.id, "اختبار إلغاء تاني");
    expect(cancelRes.status).toBe(200);
    expect(cancelRes.body.status).toBe("CANCELLED");
  });

  test("6) إنشاء تشغيلة بديلة تالتة لنفس الشهر - ينجح (مفيش سقف لعدد مرات الإلغاء/الإعادة)", async () => {
    const res = await createRun(2027, 1);
    expect(res.status).toBe(201);
  });

  test("7) تشغيلة APPROVED بتمنع تشغيلة نشطة تانية لنفس الشهر برضو (مش بس DRAFT)", async () => {
    const run = await activeRunFor(2027, 1);
    const approveRes = await approveRun(run.id);
    expect(approveRes.status).toBe(200);

    const blockedRes = await createRun(2027, 1);
    expect(blockedRes.status).toBe(409);
    expect(blockedRes.body.code).toBe("ACTIVE_PAYROLL_RUN_EXISTS");
    expect(blockedRes.body.activeRun.status).toBe("APPROVED");
  });

  test("8) كل التشغيلات التاريخية لنفس الشهر لسه محفوظة بالكامل (مفيش حذف/دمج)", async () => {
    const list = await request(app).get("/api/payroll/runs?year=2027&month=1").set(authed(accountantToken));
    const statuses = list.body.map((r) => r.status).sort();
    // 2 اتلغوا (تست 3 و5) + 1 APPROVED (تست 7) = 3 تشغيلات محفوظة بالكامل لنفس الشهر، ولا واحدة اتمسحت
    expect(statuses).toEqual(["APPROVED", "CANCELLED", "CANCELLED"]);
  });

  test("9) إنشاء متزامن (race condition) على شهر جديد تمامًا - تشغيلتين بالتوازي، واحدة بس تنجح", async () => {
    const [r1, r2] = await Promise.all([createRun(2027, 2), createRun(2027, 2)]);
    const statuses = [r1.status, r2.status].sort();
    expect(statuses).toEqual([201, 409]);
  });
});
