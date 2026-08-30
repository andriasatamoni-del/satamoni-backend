// المرحلة 8.15: "اظهار أوردرات الشيفت الحالي فقط + بحث عن أوردر قديم" - فلاتر shiftId/orderId/phone
// الجديدة على GET /api/orders. ضد Postgres حقيقي. بيغطي: shiftId بيرجع بس طلبات الشيفت ده، orderId
// بيرجع طلب واحد بالظبط، phone بيدور بجزء من الرقم، وعزل الفروع فاضل شغال حتى في وضع البحث.
const { app, request, pool, seedUser, login, authed } = require("./helpers");

let branchA, branchB;
let cashierAToken, cashierBToken, managerAToken;
let itemId, variantId, cashPmId;

beforeAll(async () => {
  const bA = await pool.query("INSERT INTO branches (name) VALUES ('فرع-بحث-أوردرات-A-جست') RETURNING id");
  branchA = bA.rows[0].id;
  const bB = await pool.query("INSERT INTO branches (name) VALUES ('فرع-بحث-أوردرات-B-جست') RETURNING id");
  branchB = bB.rows[0].id;

  await seedUser({ branchId: branchA, name: "كاشير-بحث-A", email: "cashierA-ordersearch@jest.test", role: "cashier" });
  await seedUser({ branchId: branchB, name: "كاشير-بحث-B", email: "cashierB-ordersearch@jest.test", role: "cashier" });
  await seedUser({ branchId: branchA, name: "مدير-بحث-A", email: "managerA-ordersearch@jest.test", role: "branch_manager" });

  cashierAToken = await login("cashierA-ordersearch@jest.test");
  cashierBToken = await login("cashierB-ordersearch@jest.test");
  managerAToken = await login("managerA-ordersearch@jest.test");

  const pm = await pool.query("INSERT INTO payment_methods (name, kind) VALUES ('كاش-بحث-أوردرات-جست', 'cash') RETURNING id");
  cashPmId = pm.rows[0].id;
  const cat = await pool.query("INSERT INTO menu_categories (name) VALUES ('بحث-أوردرات-قسم-جست') RETURNING id");
  const mi = await pool.query("INSERT INTO menu_items (category_id, name) VALUES ($1,'صنف-بحث-أوردرات-جست') RETURNING id", [cat.rows[0].id]);
  itemId = mi.rows[0].id;
  const v = await pool.query("INSERT INTO menu_item_variants (item_id, label, price) VALUES ($1,'عادي',50) RETURNING id", [itemId]);
  variantId = v.rows[0].id;
});

afterAll(async () => {
  await pool.end();
});

function makeOrder(token, branchId, extra = {}) {
  return request(app).post("/api/orders").set(authed(token)).send({
    branchId, source: "pos", orderType: "takeaway", paymentMethodId: cashPmId,
    items: [{ itemId, variantId, quantity: 1 }], ...extra,
  });
}

describe("GET /api/orders - فلتر shiftId (طلبات الشيفت الحالي بس)", () => {
  let shift1Id, shift1OrderId, shift2OrderId;

  test("طلب اتسجل وقت شيفت مفتوح بياخد shift_id بتاعه", async () => {
    const open1 = await request(app).post("/api/shifts/open").set(authed(cashierAToken)).send({ openingCash: 100 });
    shift1Id = open1.body.id;
    const o1 = await makeOrder(cashierAToken, branchA);
    expect(o1.status).toBe(201);
    shift1OrderId = o1.body.orderId;
    await request(app).post(`/api/shifts/${shift1Id}/close`).set(authed(cashierAToken)).send({ actualCash: 150 });

    const open2 = await request(app).post("/api/shifts/open").set(authed(cashierAToken)).send({ openingCash: 100 });
    const o2 = await makeOrder(cashierAToken, branchA);
    shift2OrderId = o2.body.orderId;

    const res = await request(app).get(`/api/orders?shiftId=${shift1Id}`).set(authed(cashierAToken));
    expect(res.status).toBe(200);
    const ids = res.body.map((o) => o.id);
    expect(ids).toContain(shift1OrderId);
    expect(ids).not.toContain(shift2OrderId);
  });

  test("orderId بيرجع الطلب المطلوب بالظبط", async () => {
    const res = await request(app).get(`/api/orders?orderId=${shift1OrderId}`).set(authed(managerAToken));
    expect(res.status).toBe(200);
    expect(res.body.length).toBe(1);
    expect(res.body[0].id).toBe(shift1OrderId);
  });

  test("phone بيدور بجزء من رقم تليفون العميل", async () => {
    // ملحوظة: "010" + آخر 8 أرقام من Date.now() (مش أول 8) - أول 8 أرقام بتفضل ثابتة لحوالي 100 ثانية
    // (بتتغير كل ~10^5 مللي ثانية)، يعني أي تست تاني في نفس الـsuite بيستخدم نفس النمط ممكن يصطدم في
    // نفس رقم التليفون فعليًا ويتسبب في تلوث بيانات نقاط ولاء عميل تاني (زي tests/order-edit.test.js)
    const uniquePhone = "010" + String(Date.now()).slice(-8);
    const created = await makeOrder(cashierAToken, branchA, { customerName: "عميل بحث", customerPhone: uniquePhone });
    const partial = uniquePhone.slice(-6);
    const res = await request(app).get(`/api/orders?phone=${partial}`).set(authed(managerAToken));
    expect(res.status).toBe(200);
    expect(res.body.map((o) => o.id)).toContain(created.body.orderId);
  });

  test("كاشير فرع تاني (B) مش يقدر يشوف طلب فرع A حتى لو استخدم orderId بالظبط - عزل الفروع فاضل شغال في وضع البحث", async () => {
    const res = await request(app).get(`/api/orders?orderId=${shift1OrderId}`).set(authed(cashierBToken));
    expect(res.status).toBe(200);
    expect(res.body.length).toBe(0); // اتفلتر تلقائي على branch_id بتاع فرع B (مفيش طلب بالرقم ده هناك)
  });
});
