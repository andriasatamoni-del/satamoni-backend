// طلب المستخدم: 7 كشوف حسابات جديدة (تيك أواي/دليفري/خدمة توصيل/فيزا/انستاباي/محفظة/تقسيم كاش-آجل-خصومات)
// في routes/reports.js: takeaway-statement, delivery-statement, delivery-service-statement,
// payment-method-statement (عام لأي طريقة دفع - فيزا/انستاباي/محفظة كلهم بيستخدموه بس بـpaymentMethodId
// مختلف)، orders-payment-split-statement. كلهم بيقروا من orders/payment_methods/delivery_areas/drivers
// مباشرة (نفس مصدر sales-detail/areas-performance الأصلي) - ضد Postgres حقيقي.
const { app, request, pool, seedUser, login, authed } = require("./helpers");

let branchA, branchB;
let adminToken, accountantToken, managerAToken, managerBToken, cashierAToken;
let driverA1Id, driverA1Token;
let cashPmId, visaPmId, instapayPmId, creditPmId;
let areaAId, areaBId;
let itemId, variantId; // سعر 200 - رقم سهل للحساب
const today = new Date().toISOString().slice(0, 10);

beforeAll(async () => {
  const bA = await pool.query("INSERT INTO branches (name) VALUES ('فرع كشوف-A-جست') RETURNING id");
  branchA = bA.rows[0].id;
  const bB = await pool.query("INSERT INTO branches (name) VALUES ('فرع كشوف-B-جست') RETURNING id");
  branchB = bB.rows[0].id;

  await seedUser({ name: "أدمن-كشوف-جست", email: "admin-statements@jest.test", role: "admin" });
  await seedUser({ name: "محاسب-كشوف-جست", email: "accountant-statements@jest.test", role: "accountant" });
  await seedUser({ branchId: branchA, name: "مدير-كشوف-A-جست", email: "managerA-statements@jest.test", role: "branch_manager" });
  await seedUser({ branchId: branchB, name: "مدير-كشوف-B-جست", email: "managerB-statements@jest.test", role: "branch_manager" });
  await seedUser({ branchId: branchA, name: "كاشير-كشوف-A-جست", email: "cashierA-statements@jest.test", role: "cashier" });

  adminToken = await login("admin-statements@jest.test");
  accountantToken = await login("accountant-statements@jest.test");
  managerAToken = await login("managerA-statements@jest.test");
  managerBToken = await login("managerB-statements@jest.test");
  cashierAToken = await login("cashierA-statements@jest.test");

  const driverUserId = await seedUser({ branchId: branchA, name: "سائق-كشوف-A1-جست", email: "driverA1-statements@jest.test", role: "driver" });
  const drv = await pool.query(
    "INSERT INTO drivers (user_id, branch_id, driver_code, name) VALUES ($1,$2,'DRV-ST-JEST-A1',$3) RETURNING id",
    [driverUserId, branchA, "سائق-كشوف-A1-جست"]
  );
  driverA1Id = drv.rows[0].id;
  driverA1Token = await login("driverA1-statements@jest.test");

  const cash = await pool.query("INSERT INTO payment_methods (name, kind) VALUES ('كاش-كشوف-جست', 'cash') RETURNING id");
  cashPmId = cash.rows[0].id;
  const visa = await pool.query("INSERT INTO payment_methods (name, kind) VALUES ('فيزا-كشوف-جست', 'card_or_wallet') RETURNING id");
  visaPmId = visa.rows[0].id;
  const instapay = await pool.query("INSERT INTO payment_methods (name, kind) VALUES ('انستاباي-كشوف-جست', 'card_or_wallet') RETURNING id");
  instapayPmId = instapay.rows[0].id;
  const credit = await pool.query("INSERT INTO payment_methods (name, kind) VALUES ('آجل-كشوف-جست', 'credit') RETURNING id");
  creditPmId = credit.rows[0].id;

  const areaA = await pool.query("INSERT INTO delivery_areas (name, branch_id, fee) VALUES ('منطقة-كشوف-A-جست', $1, 15) RETURNING id", [branchA]);
  areaAId = areaA.rows[0].id;
  const areaB = await pool.query("INSERT INTO delivery_areas (name, branch_id, fee) VALUES ('منطقة-كشوف-B-جست', $1, 10) RETURNING id", [branchA]);
  areaBId = areaB.rows[0].id;

  const cat = await pool.query("INSERT INTO menu_categories (name) VALUES ('كشوف-جست-قسم') RETURNING id");
  const mi = await pool.query("INSERT INTO menu_items (category_id, name) VALUES ($1,'صنف-كشوف-جست') RETURNING id", [cat.rows[0].id]);
  itemId = mi.rows[0].id;
  const v = await pool.query("INSERT INTO menu_item_variants (item_id, label, price) VALUES ($1,'عادي',200) RETURNING id", [itemId]);
  variantId = v.rows[0].id;
});

afterAll(async () => {
  await pool.end();
});

let phoneCounter = 0;
function nextPhone() {
  phoneCounter += 1;
  // بادئة "019" مخصوصة لملف الاختبار ده عشان منتصدمش مع ملفات تانية (زي "017" بتاعة driver-delivery.test.js)
  return `019${Date.now()}${phoneCounter}`.slice(0, 11);
}

async function makeOrder(token, body) {
  const res = await request(app).post("/api/orders").set(authed(token)).send({
    source: "pos", customerPhone: nextPhone(), items: [{ itemId, variantId, quantity: 1 }], ...body,
  });
  if (res.status !== 201) throw new Error(`makeOrder failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.orderId;
}

async function fullyDeliver(orderId, driverId, managerToken, driverToken, collectedAmount) {
  await request(app).post(`/api/deliveries/${orderId}/assign`).set(authed(managerToken)).send({ driverId });
  await request(app).post(`/api/deliveries/${orderId}/out-for-delivery`).set(authed(driverToken));
  await request(app).post(`/api/deliveries/${orderId}/delivered`).set(authed(driverToken)).send({ collectedAmount });
}

describe("كشف حساب تيك أواي (/api/reports/takeaway-statement)", () => {
  let plainOrderId, discountedOrderId, cancelledOrderId, deliveryOrderId;

  beforeAll(async () => {
    plainOrderId = await makeOrder(managerAToken, { branchId: branchA, orderType: "takeaway", paymentMethodId: cashPmId });
    // خصم 10% بالظبط (20 من 200) - عند الحد الافتراضي max_unapproved_discount_percent (0.1) فمش محتاج موافقة
    discountedOrderId = await makeOrder(managerAToken, { branchId: branchA, orderType: "takeaway", paymentMethodId: cashPmId, discount: 20 });
    cancelledOrderId = await makeOrder(managerAToken, { branchId: branchA, orderType: "takeaway", paymentMethodId: cashPmId });
    await request(app).post(`/api/orders/${cancelledOrderId}/void`).set(authed(managerAToken)).send({ reason: "اختبار استرجاع" });
    // أوردر دليفري بنفس الفرع/المدى - لازم يتفلتر بره كشف التيك أواي (order_type مختلف)
    deliveryOrderId = await makeOrder(managerAToken, { branchId: branchA, orderType: "delivery", paymentMethodId: cashPmId, deliveryAreaId: areaAId });
    expect(deliveryOrderId).toBeTruthy();
  });

  test("الإجماليات صح ومفيش أوردر ملغي أو دليفري متسرّب", async () => {
    const res = await request(app)
      .get(`/api/reports/takeaway-statement?from=${today}&to=${today}&branchId=${branchA}`)
      .set(authed(managerAToken));
    expect(res.status).toBe(200);
    const ids = res.body.orders.map((o) => o.id);
    expect(ids).toContain(plainOrderId);
    expect(ids).toContain(discountedOrderId);
    expect(ids).not.toContain(cancelledOrderId);
    expect(ids).not.toContain(deliveryOrderId);
    expect(res.body.summary.ordersCount).toBe(2);
    expect(res.body.summary.grossSubtotal).toBe(400);
    expect(res.body.summary.totalDiscount).toBe(20);
    expect(res.body.summary.netTotal).toBe(380);
    const cashLine = res.body.byPaymentMethod.find((p) => p.name === "كاش-كشوف-جست");
    expect(cashLine.count).toBe(2);
    expect(cashLine.amount).toBe(380);
  });

  test("مينفعش من غير from/to", async () => {
    const res = await request(app).get("/api/reports/takeaway-statement").set(authed(managerAToken));
    expect(res.status).toBe(400);
  });

  test("كاشير مالوش صلاحية accounting.view", async () => {
    const res = await request(app).get(`/api/reports/takeaway-statement?from=${today}&to=${today}`).set(authed(cashierAToken));
    expect(res.status).toBe(403);
  });

  test("محاسب/أدمن يقدروا يشوفوا كل الفروع", async () => {
    const res = await request(app).get(`/api/reports/takeaway-statement?from=${today}&to=${today}`).set(authed(accountantToken));
    expect(res.status).toBe(200);
    const ids = res.body.orders.map((o) => o.id);
    expect(ids).toContain(plainOrderId);
  });

  test("مدير فرع B معزول - مايشوفش أوردرات فرع A حتى لو حدد branchId فرع A", async () => {
    const res = await request(app)
      .get(`/api/reports/takeaway-statement?from=${today}&to=${today}&branchId=${branchA}`)
      .set(authed(managerBToken));
    expect(res.status).toBe(200);
    expect(res.body.branchId).toBe(branchB);
    expect(res.body.orders.map((o) => o.id)).not.toContain(plainOrderId);
  });
});

describe("كشف حساب أوردرات الدليفري (/api/reports/delivery-statement)", () => {
  let deliveryOrderId, takeawayOrderId;

  beforeAll(async () => {
    deliveryOrderId = await makeOrder(managerAToken, {
      branchId: branchA, orderType: "delivery", paymentMethodId: visaPmId, deliveryAreaId: areaAId, deliveryFee: 15,
    });
    takeawayOrderId = await makeOrder(managerAToken, { branchId: branchA, orderType: "takeaway", paymentMethodId: cashPmId });
  });

  test("بيشمل رسوم التوصيل والمنطقة، ومايشملش تيك أواي", async () => {
    const res = await request(app)
      .get(`/api/reports/delivery-statement?from=${today}&to=${today}&branchId=${branchA}`)
      .set(authed(managerAToken));
    expect(res.status).toBe(200);
    const ids = res.body.orders.map((o) => o.id);
    expect(ids).toContain(deliveryOrderId);
    expect(ids).not.toContain(takeawayOrderId);
    const line = res.body.orders.find((o) => o.id === deliveryOrderId);
    expect(line.deliveryFee).toBe(15);
    expect(line.areaName).toBe("منطقة-كشوف-A-جست");
    expect(line.total).toBe(215);
    expect(res.body.summary.totalDeliveryFees).toBeGreaterThanOrEqual(15);
  });
});

describe("كشف حساب خدمة التوصيل - مناطق وأداء سائقين (/api/reports/delivery-service-statement)", () => {
  let deliveredOrderId, unassignedOrderId;

  beforeAll(async () => {
    deliveredOrderId = await makeOrder(managerAToken, {
      branchId: branchA, orderType: "delivery", paymentMethodId: cashPmId, deliveryAreaId: areaAId, deliveryFee: 15,
    });
    await fullyDeliver(deliveredOrderId, driverA1Id, managerAToken, driverA1Token, 215);
    unassignedOrderId = await makeOrder(managerAToken, {
      branchId: branchA, orderType: "delivery", paymentMethodId: cashPmId, deliveryAreaId: areaBId, deliveryFee: 10,
    });
    expect(unassignedOrderId).toBeTruthy();
  });

  test("byArea بيجمع الطلبات لكل منطقة، byDriver بيجمع بس اللي اتوزّعت فعليًا", async () => {
    const res = await request(app)
      .get(`/api/reports/delivery-service-statement?from=${today}&to=${today}&branchId=${branchA}`)
      .set(authed(managerAToken));
    expect(res.status).toBe(200);
    const areaA = res.body.byArea.find((a) => a.areaId === areaAId);
    const areaB = res.body.byArea.find((a) => a.areaId === areaBId);
    // areaAId ممكن يتشارك فيه أوردر تاني من describe فوق ("كشف حساب أوردرات الدليفري") - بنتأكد إنه على
    // الأقل واحد موجود مش إن العدد مضبوط بالظبط، عشان الاختبار يفضل صحيح حتى لو اتشغّل مع ملفات تانية
    expect(areaA.ordersCount).toBeGreaterThanOrEqual(1);
    expect(areaB.ordersCount).toBeGreaterThanOrEqual(1);
    const driverLine = res.body.byDriver.find((d) => d.driverId === driverA1Id);
    expect(driverLine).toBeTruthy();
    expect(driverLine.deliveredCount).toBe(1);
    expect(driverLine.revenue).toBe(215);
    expect(driverLine.avgDeliveryMinutes).not.toBeNull();
  });
});

describe("كشف حساب طريقة دفع - عام لفيزا/انستاباي/محفظة (/api/reports/payment-method-statement)", () => {
  let visaOrderId, instapayOrderId;

  beforeAll(async () => {
    visaOrderId = await makeOrder(managerAToken, { branchId: branchA, orderType: "takeaway", paymentMethodId: visaPmId });
    instapayOrderId = await makeOrder(managerAToken, { branchId: branchA, orderType: "takeaway", paymentMethodId: instapayPmId });
  });

  test("بيرجّع بس أوردرات طريقة الدفع المطلوبة", async () => {
    const res = await request(app)
      .get(`/api/reports/payment-method-statement?paymentMethodId=${visaPmId}&from=${today}&to=${today}&branchId=${branchA}`)
      .set(authed(managerAToken));
    expect(res.status).toBe(200);
    expect(res.body.paymentMethod.name).toBe("فيزا-كشوف-جست");
    const ids = res.body.orders.map((o) => o.id);
    expect(ids).toContain(visaOrderId);
    expect(ids).not.toContain(instapayOrderId);
    // visaPmId ممكن يبقى عليه أوردر تاني من describe فوق ("كشف حساب أوردرات الدليفري") في نفس المدى -
    // بنتأكد إن أوردر الانستاباي مش متسرّب هنا، مش إن العدد مضبوط بالظبط بواحد
    expect(res.body.summary.ordersCount).toBeGreaterThanOrEqual(1);
    expect(res.body.summary.netTotal).toBeGreaterThanOrEqual(200);
  });

  test("لازم paymentMethodId", async () => {
    const res = await request(app).get(`/api/reports/payment-method-statement?from=${today}&to=${today}`).set(authed(managerAToken));
    expect(res.status).toBe(400);
  });

  test("طريقة دفع مش موجودة -> 404", async () => {
    const res = await request(app)
      .get(`/api/reports/payment-method-statement?paymentMethodId=999999&from=${today}&to=${today}`)
      .set(authed(managerAToken));
    expect(res.status).toBe(404);
  });
});

describe("كشف حساب الطلبات مقسّم كاش/آجل/خصومات (/api/reports/orders-payment-split-statement)", () => {
  let cashOrderId, creditOrderId, discountedOrderId;

  beforeAll(async () => {
    cashOrderId = await makeOrder(managerAToken, { branchId: branchA, orderType: "takeaway", paymentMethodId: cashPmId });
    creditOrderId = await makeOrder(managerAToken, { branchId: branchA, orderType: "takeaway", paymentMethodId: creditPmId });
    discountedOrderId = await makeOrder(managerAToken, { branchId: branchA, orderType: "takeaway", paymentMethodId: cashPmId, discount: 20 });
    expect(cashOrderId).toBeTruthy();
  });

  test("byKind بيقسّم على كاش/كارت أو محفظة/آجل، وقسم الخصومات مستقل", async () => {
    const res = await request(app)
      .get(`/api/reports/orders-payment-split-statement?from=${today}&to=${today}&branchId=${branchA}`)
      .set(authed(managerAToken));
    expect(res.status).toBe(200);
    const cashKind = res.body.byKind.find((k) => k.kind === "cash");
    const creditKind = res.body.byKind.find((k) => k.kind === "credit");
    expect(cashKind.ordersCount).toBeGreaterThanOrEqual(2); // cashOrderId + discountedOrderId
    expect(creditKind.ordersCount).toBe(1);
    expect(creditKind.total).toBe(200);
    const discountedIds = res.body.discountedOrders.map((o) => o.id);
    expect(discountedIds).toContain(discountedOrderId);
    expect(discountedIds).not.toContain(cashOrderId);
    expect(res.body.discountsSummary.totalDiscount).toBeGreaterThanOrEqual(20);
  });
});
