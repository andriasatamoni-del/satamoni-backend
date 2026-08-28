// المرحلة 8.6: تدقيق أمني/عزل فروع مخصص للراوترز اللي اتعدّلوا في المرحلة دي (routes/purchases.js،
// routes/shifts.js) - ضد Postgres حقيقي عن طريق supertest. بيغطي: معرّف :id غير رقمي -> 400 واضح
// (نفس نمط المرحلة 8B - validateIdParam اتضاف هنا على purchases.js/shifts.js للمرة الأولى)، الكاشير
// معندوش صلاحية يشوف بيانات العجز/الزيادة أو شيفتات فرعه (قايمة GET /api/shifts بالكامل)، الكاشير
// معندوش صلاحية يشوف شيفت زميل ليه في نفس الفرع (IDOR)، والكاشير مقدرش يفرض فرع مختلف عن فرعه وقت
// تسجيل فاتورة مشترى (branchId مفروض من السيرفر، مش من العميل)
const { app, request, pool, seedUser, login, authed } = require("./helpers");

let branchA, branchB;
let cashierA1Token, cashierA2Token, managerAToken, managerBToken;

beforeAll(async () => {
  const bA = await pool.query("INSERT INTO branches (name) VALUES ('فرع-8.6-أمان-A-جست') RETURNING id");
  branchA = bA.rows[0].id;
  const bB = await pool.query("INSERT INTO branches (name) VALUES ('فرع-8.6-أمان-B-جست') RETURNING id");
  branchB = bB.rows[0].id;

  await seedUser({ branchId: branchA, name: "كاشير1-8.6-أمان-A", email: "cashierA1-86sec@jest.test", role: "cashier" });
  await seedUser({ branchId: branchA, name: "كاشير2-8.6-أمان-A", email: "cashierA2-86sec@jest.test", role: "cashier" });
  await seedUser({ branchId: branchA, name: "مدير-8.6-أمان-A", email: "managerA-86sec@jest.test", role: "branch_manager" });
  await seedUser({ branchId: branchB, name: "مدير-8.6-أمان-B", email: "managerB-86sec@jest.test", role: "branch_manager" });

  cashierA1Token = await login("cashierA1-86sec@jest.test");
  cashierA2Token = await login("cashierA2-86sec@jest.test");
  managerAToken = await login("managerA-86sec@jest.test");
  managerBToken = await login("managerB-86sec@jest.test");
});

afterAll(async () => {
  await pool.end();
});

describe("المرحلة 8.6: معرّف :id غير رقمي -> 400 واضح على purchases.js وshifts.js (validateIdParam اتضاف هنا)", () => {
  test("GET /api/purchases/:id بمعرّف نصي -> 400", async () => {
    const res = await request(app).get("/api/purchases/not-a-number").set(authed(managerAToken));
    expect(res.status).toBe(400);
    expect(res.body.error).not.toMatch(/invalid input syntax/i);
  });

  test("POST /api/purchases/:id/confirm بمعرّف نصي -> 400", async () => {
    const res = await request(app).post("/api/purchases/not-a-number/confirm").set(authed(managerAToken));
    expect(res.status).toBe(400);
  });

  test("POST /api/purchases/:id/reject بمعرّف نصي -> 400", async () => {
    const res = await request(app).post("/api/purchases/not-a-number/reject").set(authed(managerAToken));
    expect(res.status).toBe(400);
  });

  test("GET /api/shifts/:id بمعرّف نصي -> 400", async () => {
    const res = await request(app).get("/api/shifts/not-a-number").set(authed(cashierA1Token));
    expect(res.status).toBe(400);
  });

  test("GET /api/shifts/:id/preview بمعرّف نصي -> 400", async () => {
    const res = await request(app).get("/api/shifts/not-a-number/preview").set(authed(managerAToken));
    expect(res.status).toBe(400);
  });

  test("POST /api/shifts/:id/close بمعرّف نصي -> 400", async () => {
    const res = await request(app).post("/api/shifts/not-a-number/close").set(authed(cashierA1Token)).send({ actualCash: 10 });
    expect(res.status).toBe(400);
  });

  test("POST /api/shifts/:id/review بمعرّف نصي -> 400", async () => {
    const res = await request(app).post("/api/shifts/not-a-number/review").set(authed(managerAToken)).send({ decision: "approve" });
    expect(res.status).toBe(400);
  });

  test("معرّف رقمي حقيقي (حتى لو مش موجود) لسه شغال عادي -> 404 مش 400", async () => {
    const res = await request(app).get("/api/purchases/999999999").set(authed(managerAToken));
    expect(res.status).toBe(404);
  });
});

describe("المرحلة 8.6: الكاشير معندوش صلاحية شيفتات الفرع (فيها بيانات السلفة/العجز الحساسة)", () => {
  test("الكاشير معندوش صلاحية GET /api/shifts (القايمة اللي فيها debt_amount/debt_employee_id)", async () => {
    const res = await request(app).get("/api/shifts").set(authed(cashierA1Token)).query({ branchId: branchA });
    expect(res.status).toBe(403);
  });

  test("الكاشير معندوش صلاحية GET /api/shifts/:id/preview (كان ده الثغرة قبل المرحلة 8.6)", async () => {
    const open = await request(app).post("/api/shifts/open").set(authed(cashierA1Token)).send({ openingCash: 500 });
    const res = await request(app).get(`/api/shifts/${open.body.id}/preview`).set(authed(cashierA1Token));
    expect(res.status).toBe(403);
    await request(app).post(`/api/shifts/${open.body.id}/close`).set(authed(cashierA1Token)).send({ actualCash: 500 });
  });

  test("الكاشير معندوش صلاحية POST /api/shifts/:id/review (مايقدرش يوافق على العجز بتاعه بنفسه)", async () => {
    const open = await request(app).post("/api/shifts/open").set(authed(cashierA1Token)).send({ openingCash: 200 });
    const res = await request(app).post(`/api/shifts/${open.body.id}/review`).set(authed(cashierA1Token)).send({ decision: "approve" });
    expect(res.status).toBe(403);
    await request(app).post(`/api/shifts/${open.body.id}/close`).set(authed(cashierA1Token)).send({ actualCash: 200 });
  });
});

describe("المرحلة 8.6: IDOR - كاشير مايقدرش يشوف/يقفل شيفت زميله في نفس الفرع", () => {
  test("كاشير A2 مايقدرش يشوف تفاصيل شيفت كاشير A1 (GET /:id) - IDOR", async () => {
    const open = await request(app).post("/api/shifts/open").set(authed(cashierA1Token)).send({ openingCash: 300 });
    const res = await request(app).get(`/api/shifts/${open.body.id}`).set(authed(cashierA2Token));
    expect(res.status).toBe(403);
    await request(app).post(`/api/shifts/${open.body.id}/close`).set(authed(cashierA1Token)).send({ actualCash: 300 });
  });

  test("كاشير A2 مايقدرش يقفل شيفت كاشير A1 - IDOR على /close (موجود من قبل، اتأكّد هنا)", async () => {
    const open = await request(app).post("/api/shifts/open").set(authed(cashierA1Token)).send({ openingCash: 300 });
    const res = await request(app).post(`/api/shifts/${open.body.id}/close`).set(authed(cashierA2Token)).send({ actualCash: 300 });
    expect(res.status).toBe(403);
    await request(app).post(`/api/shifts/${open.body.id}/close`).set(authed(cashierA1Token)).send({ actualCash: 300 });
  });
});

describe("المرحلة 8.6: مدير فرع تاني مايقدرش يشوف شيفت/فاتورة فرع مش بتاعه (عزل فروع)", () => {
  test("مدير B مايقدرش يشوف تفاصيل شيفت فرع A (GET /:id)", async () => {
    const open = await request(app).post("/api/shifts/open").set(authed(cashierA1Token)).send({ openingCash: 150 });
    const res = await request(app).get(`/api/shifts/${open.body.id}`).set(authed(managerBToken));
    expect(res.status).toBe(403);
    await request(app).post(`/api/shifts/${open.body.id}/close`).set(authed(cashierA1Token)).send({ actualCash: 150 });
  });

  test("مدير B مايقدرش يشوف قايمة شيفتات فرع A (GET /?branchId=)", async () => {
    const res = await request(app).get("/api/shifts").set(authed(managerBToken)).query({ branchId: branchA });
    expect(res.status).toBe(403);
  });
});

describe("المرحلة 8.6: الكاشير مايقدرش يفرض فرع تاني وقت تسجيل فاتورة مشترى - السيرفر بيفرض فرعه هو", () => {
  test("لو الكاشير بعت branchId لفرع تاني في POST /api/purchases، السيرفر بيتجاهله ويستخدم فرعه هو", async () => {
    const raw = await pool.query(
      "INSERT INTO inventory_items (name, unit, item_type) VALUES ('دقيق-8.6-أمان-جست', 'كيلو', 'raw') RETURNING id"
    );
    const res = await request(app).post("/api/purchases").set(authed(cashierA1Token)).send({
      branchId: branchB, // محاولة تلاعب - المفروض يتجاهلها السيرفر
      items: [{ inventoryItemId: raw.rows[0].id, quantity: 1, unitPrice: 10 }],
    });
    expect(res.status).toBe(201);
    expect(res.body.branch_id).toBe(branchA);
  });
});
