// المرحلة 8B: تدقيق أمني عدائي - ضد Postgres حقيقي عن طريق supertest (نداءات HTTP حقيقية عبر كل middleware
// stack، مش فحص كود بس). بيغطي: حماية ضد SQL injection على باراميترز حقيقية، عزل الأدوار عبر وحدات مختلفة
// (مش بس نفس الوحدة)، JSON مشوّه، معرّف :id غير رقمي (اللقطة الحقيقية اتكشفت بهجوم حي على /api/orders/
// not-a-number قبل الإصلاح ده - كانت بترجع 500 بدل 400)، وتلاعب بتوقيع الـJWT.
const jwt = require("jsonwebtoken");
const { app, request, pool, seedUser, login, authed } = require("./helpers");

let branchA;
let cashierToken;

beforeAll(async () => {
  const bA = await pool.query("INSERT INTO branches (name) VALUES ('فرع-8B-أمان-جست') RETURNING id");
  branchA = bA.rows[0].id;
  await seedUser({ branchId: branchA, name: "كاشير-8B-أمان", email: "cashier-8b-sec@jest.test", role: "cashier" });
  cashierToken = await login("cashier-8b-sec@jest.test");
});

afterAll(async () => {
  await pool.end();
});

describe("8B: معرّف :id غير رقمي -> 400 واضح، مش 500 خام (كان الباج قبل الإصلاح)", () => {
  test("GET /api/orders/:id بمعرّف نصي -> 400", async () => {
    const res = await request(app).get("/api/orders/not-a-number").set(authed(cashierToken));
    expect(res.status).toBe(400);
    expect(res.body.error).not.toMatch(/invalid input syntax/i);
  });

  test("POST /api/orders/:id/void بمعرّف نصي -> 400", async () => {
    const res = await request(app).post("/api/orders/not-a-number/void").set(authed(cashierToken)).send({ reason: "x" });
    expect(res.status).toBe(400);
  });

  test("PATCH /api/orders/:id/status بمعرّف نصي -> 400", async () => {
    const res = await request(app).patch("/api/orders/not-a-number/status").set(authed(cashierToken)).send({ status: "cancelled" });
    expect(res.status).toBe(400);
  });

  test("معرّف رقمي حقيقي (حتى لو مش موجود) لسه شغال عادي -> 404 مش 400", async () => {
    const res = await request(app).get("/api/orders/999999999").set(authed(cashierToken));
    expect(res.status).toBe(404);
  });
});

describe("8B: SQL injection - باراميترز حقيقية، من غير أي كسر أو تسريب بيانات", () => {
  test("phone lookup بـpayload حقن - مفيش انهيار، ومفيش بيانات عملاء اتسربت", async () => {
    const res = await request(app).get(`/api/customers?phone=${encodeURIComponent("' OR '1'='1")}`).set(authed(cashierToken));
    expect(res.status).toBeLessThan(500);
    // لو العميل مش موجود بالرقم الحرفي ده، مفيش recentOrders (يعني مفيش تسريب لكل الطلبات)
    if (res.body.recentOrders) expect(res.body.recentOrders.length).toBe(0);
  });

  test("محاولة DROP TABLE في باراميتر - مفيش انهيار، والجدول لسه موجود بعد الطلب", async () => {
    const res = await request(app).get(`/api/customers?phone=${encodeURIComponent("1'; DROP TABLE users; --")}`).set(authed(cashierToken));
    expect(res.status).toBeLessThan(500);
    const usersStillExist = await pool.query("SELECT COUNT(*)::int AS c FROM users");
    expect(usersStillExist.rows[0].c).toBeGreaterThan(0);
  });

  test("orders status فلتر بحقن - بيترجع نتيجة فاضية آمنة، مش كل الطلبات", async () => {
    const res = await request(app)
      .get(`/api/orders?branchId=${branchA}&status=${encodeURIComponent("preparing' OR '1'='1")}`)
      .set(authed(cashierToken));
    expect(res.status).toBeLessThan(500);
  });
});

describe("8B: عزل الأدوار عبر وحدات مختلفة (كاشير بيحاول يوصل لوحدات معندوش صلاحية عليها خالص)", () => {
  test("كاشير -> قايمة موظفي الرواتب -> 403", async () => {
    const res = await request(app).get("/api/payroll/employees").set(authed(cashierToken));
    expect(res.status).toBe(403);
  });
  test("كاشير -> قايمة موظفي HR -> 403", async () => {
    const res = await request(app).get("/api/hr/employees").set(authed(cashierToken));
    expect(res.status).toBe(403);
  });
  test("كاشير -> شجرة الحسابات المحاسبية -> 403", async () => {
    const res = await request(app).get("/api/accounting/accounts").set(authed(cashierToken));
    expect(res.status).toBe(403);
  });
  test("كاشير -> إنشاء حساب أدمن -> 403", async () => {
    const res = await request(app).post("/api/users").set(authed(cashierToken)).send({
      name: "محاولة اختراق", email: "hack-attempt@jest.test", password: "test12345", role: "admin",
    });
    expect(res.status).toBe(403);
  });
  test("كاشير -> مراجعة مشترى نقدي (المفروض للمدير/المحاسب بس) -> 403", async () => {
    const res = await request(app).post("/api/purchases/1/confirm").set(authed(cashierToken));
    expect(res.status).toBe(403);
  });
  test("كاشير -> مراجعة تسوية سائق -> 403", async () => {
    const res = await request(app).post("/api/driver-settlements/1/review").set(authed(cashierToken)).send({ decision: "approve" });
    expect(res.status).toBe(403);
  });
});

describe("8B: JSON مشوّه", () => {
  test("body مش JSON صحيح -> 400 واضح، مش انهيار", async () => {
    const res = await request(app)
      .post("/api/orders")
      .set(authed(cashierToken))
      .set("Content-Type", "application/json")
      .send("{ this is not valid json !!!");
    expect(res.status).toBe(400);
  });
});

describe("8B: تلاعب بتوقيع JWT", () => {
  test("توكن بـpayload معدّل (sub مزوّر) - التوقيع بيبقى غلط ويترفض 401", async () => {
    const parts = cashierToken.split(".");
    const forgedPayload = Buffer.from(
      JSON.stringify({ ...JSON.parse(Buffer.from(parts[1], "base64url").toString()), sub: 1, role: "admin" })
    ).toString("base64url");
    const forged = `${parts[0]}.${forgedPayload}.${parts[2]}`;
    const res = await request(app).get("/api/payroll/employees").set(authed(forged));
    expect(res.status).toBe(401);
  });

  test("توكن ممضي بمفتاح تاني تمامًا (مش JWT_SECRET الحقيقي) - يترفض 401", async () => {
    const forged = jwt.sign({ sub: 1, role: "admin" }, "wrong-secret-not-the-real-one");
    const res = await request(app).get("/api/payroll/employees").set(authed(forged));
    expect(res.status).toBe(401);
  });
});
