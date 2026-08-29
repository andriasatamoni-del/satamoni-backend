// المرحلة 8.12: توضيح من صاحب المشروع - تبويب "تقفيل الكاش" في satamoni-accounting.html كان فورم إدخال
// يدوي بحت (مش متوصّل بأي بيانات حقيقية)، فكل تقفيلاته كانت طالعة أصفار لحد ما حد يكتب الأرقام بنفسه.
// GET /api/cash-sessions/expected بيحسب نفس الأرقام دي أوتوماتيك من orders/purchases/expenses الحقيقية
// (نفس معادلة الكاش المتوقع بتاعة الشيفتات - db/shift-engine.js - بس مجمّعة على مستوى اليوم كله للفرع)
// عشان الفورم يتعبّي لوحده والمحاسب يراجع بس. ضد Postgres حقيقي.
const { app, request, pool, seedUser, login, authed } = require("./helpers");

let branchA, branchB;
let adminToken, managerAToken, managerBToken;
let cashPmId, cardPmId, creditPmId;
let itemId, variantId;

beforeAll(async () => {
  const bA = await pool.query("INSERT INTO branches (name) VALUES ('فرع-تقفيل-كاش-أ-جست') RETURNING id");
  branchA = bA.rows[0].id;
  const bB = await pool.query("INSERT INTO branches (name) VALUES ('فرع-تقفيل-كاش-ب-جست') RETURNING id");
  branchB = bB.rows[0].id;

  await seedUser({ name: "أدمن-تقفيل-كاش", email: "admin-cashexp@jest.test", role: "admin" });
  await seedUser({ branchId: branchA, name: "مدير-تقفيل-كاش-أ", email: "manager-cashexp-a@jest.test", role: "branch_manager" });
  await seedUser({ branchId: branchB, name: "مدير-تقفيل-كاش-ب", email: "manager-cashexp-b@jest.test", role: "branch_manager" });
  adminToken = await login("admin-cashexp@jest.test");
  managerAToken = await login("manager-cashexp-a@jest.test");
  managerBToken = await login("manager-cashexp-b@jest.test");

  const cash = await pool.query("INSERT INTO payment_methods (name, kind, enabled) VALUES ('كاش-تقفيل-جست','cash',TRUE) RETURNING id");
  cashPmId = cash.rows[0].id;
  const card = await pool.query("INSERT INTO payment_methods (name, kind, enabled) VALUES ('فيزا-تقفيل-جست','card_or_wallet',TRUE) RETURNING id");
  cardPmId = card.rows[0].id;
  const credit = await pool.query("INSERT INTO payment_methods (name, kind, enabled) VALUES ('آجل-تقفيل-جست','credit',TRUE) RETURNING id");
  creditPmId = credit.rows[0].id;

  const cat = await pool.query("INSERT INTO menu_categories (name) VALUES ('قسم-تقفيل-كاش-جست') RETURNING id");
  const mi = await pool.query("INSERT INTO menu_items (category_id, name) VALUES ($1,'صنف-تقفيل-كاش-جست') RETURNING id", [cat.rows[0].id]);
  itemId = mi.rows[0].id;
  const v = await pool.query("INSERT INTO menu_item_variants (item_id, label, price, talabat_price) VALUES ($1,'عادي',100,120) RETURNING id", [itemId]);
  variantId = v.rows[0].id;
});

afterAll(async () => {
  await pool.end();
});

async function createOrder(token, { branchId, paymentMethodId, source = "pos", orderType = "takeaway" }) {
  const res = await request(app).post("/api/orders").set(authed(token)).send({
    branchId, source, orderType, paymentMethodId,
    items: [{ itemId, variantId, quantity: 1 }],
  });
  expect(res.status).toBe(201);
  return res.body.orderId;
}

async function setOrderDate(orderId, date) {
  await pool.query("UPDATE orders SET created_at = $1::date + time '12:00' WHERE id = $2", [date, orderId]);
}

async function markCollected(token, orderId) {
  const res = await request(app).patch(`/api/orders/${orderId}/payment-status`).set(authed(token)).send({ paymentStatus: "collected" });
  expect(res.status).toBe(200);
}

describe("GET /api/cash-sessions/expected - تصنيف المبيعات حسب طريقة الدفع", () => {
  const date = "2025-01-10";

  test("مبيعات كاش بتتحسب في cashSales", async () => {
    const orderId = await createOrder(managerAToken, { branchId: branchA, paymentMethodId: cashPmId });
    await setOrderDate(orderId, date);
    const res = await request(app).get(`/api/cash-sessions/expected?branchId=${branchA}&date=${date}`).set(authed(managerAToken));
    expect(res.status).toBe(200);
    expect(res.body.cashSales).toBeCloseTo(100, 5);
    expect(res.body.cardSales).toBe(0);
    expect(res.body.creditSales).toBe(0);
  });

  test("مبيعات فيزا (card_or_wallet) لسه تحت التحصيل (pending_collection) بيفضلوا مستبعدين لحد ما يتأكدوا", async () => {
    const orderId = await createOrder(managerAToken, { branchId: branchA, paymentMethodId: cardPmId });
    await setOrderDate(orderId, date);
    const before = await request(app).get(`/api/cash-sessions/expected?branchId=${branchA}&date=${date}`).set(authed(managerAToken));
    expect(before.body.cardSales).toBe(0);

    await markCollected(managerAToken, orderId);
    const after = await request(app).get(`/api/cash-sessions/expected?branchId=${branchA}&date=${date}`).set(authed(managerAToken));
    expect(after.body.cardSales).toBeCloseTo(100, 5);
  });

  test("مبيعات آجل (credit) نفس المنطق - بعد التأكيد بس بتتحسب في creditSales", async () => {
    const orderId = await createOrder(managerAToken, { branchId: branchA, paymentMethodId: creditPmId });
    await setOrderDate(orderId, date);
    await markCollected(managerAToken, orderId);
    const res = await request(app).get(`/api/cash-sessions/expected?branchId=${branchA}&date=${date}`).set(authed(managerAToken));
    expect(res.body.creditSales).toBeCloseTo(100, 5);
  });

  test("مبيعات تطبيقات توصيل (source=talabat) بتتحسب في deliveryAppSales لوحدها", async () => {
    const orderId = await createOrder(managerAToken, { branchId: branchA, paymentMethodId: cashPmId, source: "talabat", orderType: "talabat" });
    await setOrderDate(orderId, date);
    await markCollected(managerAToken, orderId);
    const res = await request(app).get(`/api/cash-sessions/expected?branchId=${branchA}&date=${date}`).set(authed(managerAToken));
    expect(res.body.deliveryAppSales).toBeCloseTo(120, 5); // talabat_price
  });

  test("طلب ملغي مبيدخلش في أي رقم", async () => {
    const before = await request(app).get(`/api/cash-sessions/expected?branchId=${branchA}&date=${date}`).set(authed(managerAToken));
    const orderId = await createOrder(managerAToken, { branchId: branchA, paymentMethodId: cashPmId });
    await setOrderDate(orderId, date);
    await pool.query("UPDATE orders SET status = 'cancelled', voided = TRUE WHERE id = $1", [orderId]);
    const after = await request(app).get(`/api/cash-sessions/expected?branchId=${branchA}&date=${date}`).set(authed(managerAToken));
    expect(after.body.cashSales).toBeCloseTo(before.body.cashSales, 5);
  });
});

describe("خصم المشتريات والمصروفات النقدية من الكاش المتوقع", () => {
  const date = "2025-01-11";

  test("مشترى نقدي (purchases) بيتخصم من expectedClosingCash عن طريق cashPaidToKitchen", async () => {
    // نفس منطق shift-engine.js بالظبط - الفلترة بتاريخ created_at الفعلي وقت التسجيل، مش business_date
    // (اللي ممكن تتحط بأثر رجعي) - عشان كده لازم نثبّت created_at صراحة هنا زي setOrderDate بالظبط
    await pool.query(
      "INSERT INTO purchases (branch_id, business_date, category, amount, status, created_at) VALUES ($1,$2,'مباشر',50,'CONFIRMED',$2::date + time '12:00')",
      [branchA, date]
    );
    const res = await request(app).get(`/api/cash-sessions/expected?branchId=${branchA}&date=${date}`).set(authed(managerAToken));
    expect(res.body.cashPaidToKitchen).toBeCloseTo(50, 5);
  });

  test("مشترى مرفوض (REJECTED) ملوش أي تأثير", async () => {
    const before = await request(app).get(`/api/cash-sessions/expected?branchId=${branchA}&date=${date}`).set(authed(managerAToken));
    await pool.query(
      "INSERT INTO purchases (branch_id, business_date, category, amount, status, created_at) VALUES ($1,$2,'مباشر',999,'REJECTED',$2::date + time '12:00')",
      [branchA, date]
    );
    const after = await request(app).get(`/api/cash-sessions/expected?branchId=${branchA}&date=${date}`).set(authed(managerAToken));
    expect(after.body.cashPaidToKitchen).toBeCloseTo(before.body.cashPaidToKitchen, 5);
  });

  test("مصروف نقدي (kind=cash) بيتخصم عن طريق otherCashPayments", async () => {
    const cat = await pool.query("INSERT INTO expense_categories (name) VALUES ('فئة-تقفيل-كاش-جست') RETURNING id");
    await pool.query(
      "INSERT INTO expenses (branch_id, business_date, category_id, amount, payment_method_id, status, created_at) VALUES ($1,$2,$3,30,$4,'POSTED',$2::date + time '12:00')",
      [branchA, date, cat.rows[0].id, cashPmId]
    );
    const res = await request(app).get(`/api/cash-sessions/expected?branchId=${branchA}&date=${date}`).set(authed(managerAToken));
    expect(res.body.otherCashPayments).toBeCloseTo(30, 5);
  });

  test("مصروف بفيزا (kind=card_or_wallet) ملوش أي تأثير على otherCashPayments", async () => {
    const before = await request(app).get(`/api/cash-sessions/expected?branchId=${branchA}&date=${date}`).set(authed(managerAToken));
    const cat = await pool.query("INSERT INTO expense_categories (name) VALUES ('فئة-فيزا-تقفيل-كاش-جست') RETURNING id");
    await pool.query(
      "INSERT INTO expenses (branch_id, business_date, category_id, amount, payment_method_id, status, created_at) VALUES ($1,$2,$3,999,$4,'POSTED',$2::date + time '12:00')",
      [branchA, date, cat.rows[0].id, cardPmId]
    );
    const after = await request(app).get(`/api/cash-sessions/expected?branchId=${branchA}&date=${date}`).set(authed(managerAToken));
    expect(after.body.otherCashPayments).toBeCloseTo(before.body.otherCashPayments, 5);
  });

  test("expectedClosingCash = كاش أول اليوم + مبيعات كاش - مشتريات نقدية - مصروفات نقدية", async () => {
    const res = await request(app).get(`/api/cash-sessions/expected?branchId=${branchA}&date=${date}`).set(authed(managerAToken));
    const expected = res.body.openingCash + res.body.cashSales - res.body.cashPaidToKitchen - res.body.otherCashPayments;
    expect(res.body.expectedClosingCash).toBeCloseTo(expected, 5);
  });
});

describe("كاش أول اليوم بيترحّل من الكاش الفعلي المسجّل آخر تقفيل قبل كده", () => {
  test("مفيش أي تقفيل قبل كده - كاش أول اليوم صفر", async () => {
    const res = await request(app).get(`/api/cash-sessions/expected?branchId=${branchB}&date=2025-02-01`).set(authed(managerBToken));
    expect(res.body.openingCash).toBe(0);
  });

  test("بعد تقفيل يوم بكاش فعلي معيّن - اليوم اللي بعده بيرث نفس القيمة كـكاش أول اليوم", async () => {
    const closeRes = await request(app).post("/api/cash-sessions").set(authed(managerBToken)).send({
      branchId: branchB, businessDate: "2025-02-01", openingCash: 0, cashSales: 0,
      actualCountedCash: 777,
    });
    expect(closeRes.status).toBe(201);
    const nextDay = await request(app).get(`/api/cash-sessions/expected?branchId=${branchB}&date=2025-02-02`).set(authed(managerBToken));
    expect(nextDay.body.openingCash).toBeCloseTo(777, 5);
  });
});

describe("عزل الفروع", () => {
  test("مدير فرع تاني معندوش صلاحية يشوف كاش فرع مختلف", async () => {
    const res = await request(app).get(`/api/cash-sessions/expected?branchId=${branchA}&date=2025-01-10`).set(authed(managerBToken));
    expect(res.status).toBe(403);
  });

  test("مدير الفرع من غير ما يحدد branchId بيترجّع بيانات فرعه هو بس تلقائيًا", async () => {
    const res = await request(app).get(`/api/cash-sessions/expected?date=2025-01-10`).set(authed(managerAToken));
    expect(res.status).toBe(200);
    expect(res.body.cashSales).toBeGreaterThan(0); // نفس بيانات branchA من الوصف الأول فوق
  });

  test("مفيش فرع ولا تاريخ - 400", async () => {
    const res = await request(app).get(`/api/cash-sessions/expected`).set(authed(adminToken));
    expect(res.status).toBe(400);
  });
});
