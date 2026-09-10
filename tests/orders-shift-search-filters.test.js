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

// المرحلة 8.52: created_at::date كان بيتقارن بتوقيت جلسة Postgres الافتراضي (UTC)، بينما "الطلبات
// الجارية" في الكاشير بتبعت تاريخ اليوم بتوقيت القاهرة (UTC+2) - أي طلب اتسجل في أول ساعتين بعد نص
// الليل بتوقيت القاهرة كان بيتحسب لسه "إمبارح" بتوقيت UTC، فيختفي تمامًا من فلتر date=اليوم رغم إنه
// اتسجل فعليًا النهاردة. بنحاكي الحالة دي بتحديث created_at مباشرة لوقت داخل النافذة الخطرة دي
describe("GET /api/orders - فلتر date بتوقيت القاهرة (8.52)", () => {
  test("طلب اتسجل بعد نص الليل بتوقيت القاهرة بس قبل نص الليل بتوقيت UTC - لازم يظهر في فلتر تاريخ اليوم بتوقيت القاهرة", async () => {
    const order = await makeOrder(managerAToken, branchA);
    expect(order.status).toBe(201);
    const orderId = order.body.orderId;

    // نبني توقيت UTC بيمثّل 00:30 بتوقيت القاهرة (UTC+2) يوم معيّن - يعني 22:30 بتوقيت UTC اليوم اللي قبله
    const cairoMidnightPlus30 = new Date(Date.UTC(2026, 2, 15, 22, 30, 0)); // = 2026-03-16 00:30 بتوقيت القاهرة
    await pool.query("UPDATE orders SET created_at = $1 WHERE id = $2", [cairoMidnightPlus30, orderId]);

    const cairoDate = "2026-03-16"; // اليوم بتوقيت القاهرة وقت التسجيل
    const utcDate = "2026-03-15"; // نفس اللحظة بتوقيت UTC - ده اللي كان بيتفلتر بيه غلط قبل الإصلاح

    const cairoRes = await request(app).get(`/api/orders?date=${cairoDate}&branchId=${branchA}`).set(authed(managerAToken));
    expect(cairoRes.status).toBe(200);
    expect(cairoRes.body.map((o) => o.id)).toContain(orderId);

    const utcRes = await request(app).get(`/api/orders?date=${utcDate}&branchId=${branchA}`).set(authed(managerAToken));
    expect(utcRes.body.map((o) => o.id)).not.toContain(orderId);
  });
});
