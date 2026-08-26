// المرحلة 7J: فلتر مدى التاريخ (from/to) على التقارير اللي كانت مقفولة على year/month بس - بيغطي:
// نفس النتيجة سواء اتبعت year/month أو from/to المكافئ ليه (نفس الشهر بالظبط)، رفض الطلب من غير أي
// مدى، وسلوك تكلفة الرواتب (متاحة لشهر كامل بس، null لمدى جزئي) في income-statement/dashboard.
const { app, request, pool, seedUser, login, authed } = require("./helpers");

let branchA;
let adminToken, cashierAToken;
let itemId, variantId;

function firstAndLastOfMonth(year, month) {
  const from = `${year}-${String(month).padStart(2, "0")}-01`;
  const lastDay = new Date(year, month, 0).getDate();
  const to = `${year}-${String(month).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
  return { from, to };
}

beforeAll(async () => {
  const bA = await pool.query("INSERT INTO branches (name) VALUES ('فرع-مدى-تاريخ-جست') RETURNING id");
  branchA = bA.rows[0].id;

  await seedUser({ branchId: branchA, name: "أدمن-مدى-تاريخ", email: "admin-daterange@jest.test", role: "admin" });
  await seedUser({ branchId: branchA, name: "كاشير-مدى-تاريخ", email: "cashier-daterange@jest.test", role: "cashier" });
  adminToken = await login("admin-daterange@jest.test");
  cashierAToken = await login("cashier-daterange@jest.test");

  const cat = await pool.query("INSERT INTO menu_categories (name) VALUES ('مدى-تاريخ-جست-قسم') RETURNING id");
  const mi = await pool.query("INSERT INTO menu_items (category_id, name) VALUES ($1,'صنف-مدى-تاريخ-جست') RETURNING id", [cat.rows[0].id]);
  itemId = mi.rows[0].id;
  const v = await pool.query("INSERT INTO menu_item_variants (item_id, label, price) VALUES ($1,'عادي',100) RETURNING id", [itemId]);
  variantId = v.rows[0].id;

  // طلب واحد على الأقل النهاردة عشان الشهر الحالي مايبقاش فاضي في كل التقارير تحت
  const res = await request(app).post("/api/orders").set(authed(cashierAToken)).send({
    branchId: branchA, source: "pos", orderType: "takeaway",
    items: [{ itemId, variantId, quantity: 1 }],
  });
  expect(res.status).toBe(201);
});

afterAll(async () => {
  await pool.end();
});

function thisMonthRange() {
  const now = new Date();
  return { year: now.getFullYear(), month: now.getMonth() + 1, ...firstAndLastOfMonth(now.getFullYear(), now.getMonth() + 1) };
}

describe("from/to بديل لـ year/month على التقارير المحوّلة", () => {
  test("GET /api/reports/daily - نفس النتيجة بالـ from/to والـ year/month", async () => {
    const { year, month, from, to } = thisMonthRange();
    const byMonth = await request(app).get(`/api/reports/daily?year=${year}&month=${month}&branchId=${branchA}`).set(authed(adminToken));
    const byRange = await request(app).get(`/api/reports/daily?from=${from}&to=${to}&branchId=${branchA}`).set(authed(adminToken));
    expect(byMonth.status).toBe(200);
    expect(byRange.status).toBe(200);
    expect(byRange.body).toEqual(byMonth.body);
  });

  test("GET /api/reports/income-statement - نفس النتيجة بالـ from/to والـ year/month لشهر كامل", async () => {
    const { year, month, from, to } = thisMonthRange();
    const byMonth = await request(app).get(`/api/reports/income-statement?year=${year}&month=${month}&branchId=${branchA}`).set(authed(adminToken));
    const byRange = await request(app).get(`/api/reports/income-statement?from=${from}&to=${to}&branchId=${branchA}`).set(authed(adminToken));
    expect(byMonth.status).toBe(200);
    expect(byRange.status).toBe(200);
    expect(byRange.body.revenue).toBeCloseTo(byMonth.body.revenue, 6);
    expect(byRange.body.cogs).toBeCloseTo(byMonth.body.cogs, 6);
    expect(byRange.body.payrollCost).toBeCloseTo(byMonth.body.payrollCost, 6);
    expect(byRange.body.netProfitAfterPayroll).toBeCloseTo(byMonth.body.netProfitAfterPayroll, 6);
    // شهر كامل - لازم تكلفة الرواتب متاحة (مش null)
    expect(byMonth.body.payrollCost).not.toBeNull();
  });

  test("GET /api/reports/income-statement - تكلفة الرواتب null لمدى جزئي (يوم واحد بس)", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const res = await request(app)
      .get(`/api/reports/income-statement?from=${today}&to=${today}&branchId=${branchA}`)
      .set(authed(adminToken));
    expect(res.status).toBe(200);
    expect(res.body.payrollCost).toBeNull();
    expect(res.body.netProfitAfterPayroll).toBeNull();
    expect(res.body.note).toContain("مدى تاريخ جزئي");
    // باقي الأرقام (الإيراد/التكلفة) لازم تفضل شغالة عادي حتى لو الرواتب مش متاحة
    expect(typeof res.body.revenue).toBe("number");
  });

  test("GET /api/reports/income-statement/by-branch - نفس النتيجة بالـ from/to والـ year/month", async () => {
    const { year, month, from, to } = thisMonthRange();
    const byMonth = await request(app).get(`/api/reports/income-statement/by-branch?year=${year}&month=${month}`).set(authed(adminToken));
    const byRange = await request(app).get(`/api/reports/income-statement/by-branch?from=${from}&to=${to}`).set(authed(adminToken));
    expect(byMonth.status).toBe(200);
    expect(byRange.status).toBe(200);
    expect(byRange.body.consolidated.revenue).toBeCloseTo(byMonth.body.consolidated.revenue, 6);
    expect(byRange.body.consolidated.payrollCost).toBeCloseTo(byMonth.body.consolidated.payrollCost, 6);
  });

  test("GET /api/reports/dashboard - نفس النتيجة بالـ from/to والـ year/month، وتكلفة رواتب null لمدى جزئي", async () => {
    const { year, month, from, to } = thisMonthRange();
    const byMonth = await request(app).get(`/api/reports/dashboard?year=${year}&month=${month}&branchId=${branchA}`).set(authed(adminToken));
    const byRange = await request(app).get(`/api/reports/dashboard?from=${from}&to=${to}&branchId=${branchA}`).set(authed(adminToken));
    expect(byMonth.status).toBe(200);
    expect(byRange.status).toBe(200);
    expect(byRange.body.summary.revenue).toBeCloseTo(byMonth.body.summary.revenue, 6);
    expect(byRange.body.summary.payrollCost).toBeCloseTo(byMonth.body.summary.payrollCost, 6);
    expect(byMonth.body.summary.payrollCost).not.toBeNull();

    const today = new Date().toISOString().slice(0, 10);
    const partial = await request(app).get(`/api/reports/dashboard?from=${today}&to=${today}&branchId=${branchA}`).set(authed(adminToken));
    expect(partial.status).toBe(200);
    expect(partial.body.summary.payrollCost).toBeNull();
    expect(partial.body.summary.netProfitAfterPayroll).toBeNull();
  });

  test("GET /api/reports/vat-summary - from/to بيرجّع نفس نتيجة year/month", async () => {
    const { year, month, from, to } = thisMonthRange();
    const byMonth = await request(app).get(`/api/reports/vat-summary?year=${year}&month=${month}&branchId=${branchA}`).set(authed(adminToken));
    const byRange = await request(app).get(`/api/reports/vat-summary?from=${from}&to=${to}&branchId=${branchA}`).set(authed(adminToken));
    expect(byMonth.status).toBe(200);
    expect(byRange.status).toBe(200);
    expect(byRange.body.grossSales).toBeCloseTo(byMonth.body.grossSales, 6);
    expect(byRange.body.vatCollected).toBeCloseTo(byMonth.body.vatCollected, 6);
  });

  test("GET /api/reports/accounting-reconciliation - from/to بيرجّع نفس نتيجة year/month", async () => {
    const { year, month, from, to } = thisMonthRange();
    const byMonth = await request(app).get(`/api/reports/accounting-reconciliation?year=${year}&month=${month}&branchId=${branchA}`).set(authed(adminToken));
    const byRange = await request(app).get(`/api/reports/accounting-reconciliation?from=${from}&to=${to}&branchId=${branchA}`).set(authed(adminToken));
    expect(byMonth.status).toBe(200);
    expect(byRange.status).toBe(200);
    expect(byRange.body.checks.length).toBe(byMonth.body.checks.length);
    byMonth.body.checks.forEach((c, i) => {
      expect(byRange.body.checks[i].operational).toBeCloseTo(c.operational, 6);
      expect(byRange.body.checks[i].ledger).toBeCloseTo(c.ledger, 6);
    });
  });

  test("من غير from/to ولا year/month - 400 على كل الـ endpoints المحوّلة", async () => {
    const paths = [
      "/api/reports/daily",
      "/api/reports/income-statement",
      "/api/reports/income-statement/by-branch",
      "/api/reports/dashboard",
      "/api/reports/vat-summary",
      "/api/reports/accounting-reconciliation",
    ];
    for (const p of paths) {
      const res = await request(app).get(p).set(authed(adminToken));
      expect(res.status).toBe(400);
    }
  });
});
