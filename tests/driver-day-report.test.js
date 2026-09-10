// المرحلة 8.47: GET /api/driver-settlements/driver-orders - تقرير كل أوردرات السائق في يوم معيّن (كل
// طريقة دفع، متحصّلة أو معلّقة) - لمراجعة شيفت السائق كامل آخر اليوم، مش بس الأوردرات المعلّقة للتحصيل
// زي /preview و/pending-drivers. بيغطي: خلط أوردرات كاش متحصّلة/معلّقة + أوردر كارت، فلترة التاريخ
// (delivered_at مش created_at)، عزل الفروع، صلاحيات الكاشير/السائق.
const { app, request, pool, seedUser, login, authed } = require("./helpers");

let branchA, branchB;
let managerAToken, cashierAToken, managerBToken, driverToken;
let driverId;
let cashPmId, cardPmId, itemId, variantId;

beforeAll(async () => {
  const bA = await pool.query("INSERT INTO branches (name) VALUES ('فرع تقرير-طيار-جست') RETURNING id");
  branchA = bA.rows[0].id;
  const bB = await pool.query("INSERT INTO branches (name) VALUES ('فرع تقرير-طيار-جست-B') RETURNING id");
  branchB = bB.rows[0].id;

  await seedUser({ branchId: branchA, name: "مدير-تقرير-طيار", email: "managerA-dayreport@jest.test", role: "branch_manager" });
  await seedUser({ branchId: branchA, name: "كاشير-تقرير-طيار", email: "cashierA-dayreport@jest.test", role: "cashier" });
  await seedUser({ branchId: branchB, name: "مدير-تقرير-طيار-B", email: "managerB-dayreport@jest.test", role: "branch_manager" });
  managerAToken = await login("managerA-dayreport@jest.test");
  cashierAToken = await login("cashierA-dayreport@jest.test");
  managerBToken = await login("managerB-dayreport@jest.test");

  const driverUserId = await seedUser({ branchId: branchA, name: "سائق-تقرير-طيار", email: "driver-dayreport@jest.test", role: "driver" });
  driverToken = await login("driver-dayreport@jest.test");
  const d = await pool.query(
    "INSERT INTO drivers (user_id, branch_id, driver_code, name) VALUES ($1,$2,'DRV-DAYREPORT',$3) RETURNING id",
    [driverUserId, branchA, "سائق-تقرير-طيار"]
  );
  driverId = d.rows[0].id;

  const pmCash = await pool.query("INSERT INTO payment_methods (name, kind) VALUES ('كاش-تقرير-طيار-جست', 'cash') RETURNING id");
  cashPmId = pmCash.rows[0].id;
  const pmCard = await pool.query("INSERT INTO payment_methods (name, kind) VALUES ('كارت-تقرير-طيار-جست', 'card_or_wallet') RETURNING id");
  cardPmId = pmCard.rows[0].id;

  const cat = await pool.query("INSERT INTO menu_categories (name) VALUES ('تقرير-طيار-جست-قسم') RETURNING id");
  const mi = await pool.query("INSERT INTO menu_items (category_id, name) VALUES ($1,'صنف-تقرير-طيار-جست') RETURNING id", [cat.rows[0].id]);
  itemId = mi.rows[0].id;
  const v = await pool.query("INSERT INTO menu_item_variants (item_id, label, price) VALUES ($1,'عادي',150) RETURNING id", [itemId]);
  variantId = v.rows[0].id;
});

afterAll(async () => {
  await pool.end();
});

async function makeDeliveredOrder({ pmId, deliveryFee, deliveredAt, settled }) {
  const order = await request(app).post("/api/orders").set(authed(managerAToken)).send({
    branchId: branchA, source: "pos", orderType: "delivery",
    customerPhone: `018${Date.now()}${Math.floor(Math.random() * 1000)}`.slice(0, 11),
    addressDetails: "شارع تقرير الطيار", paymentMethodId: pmId,
    items: [{ itemId, variantId, quantity: 1 }],
  });
  const orderId = order.body.orderId;
  const total = Number(order.body.total);
  await pool.query("UPDATE orders SET delivery_fee = $1, driver_id = $2, dispatch_status = 'ASSIGNED' WHERE id = $3", [deliveryFee, driverId, orderId]);
  await pool.query(
    `UPDATE orders SET status='completed', dispatch_status='DELIVERED', delivered_at=$1,
       payment_status = CASE WHEN $2 = 'cash' THEN 'collected' ELSE payment_status END,
       collected_amount = CASE WHEN $2 = 'cash' THEN $3 ELSE collected_amount END, collection_variance = 0
     WHERE id = $4`,
    [deliveredAt, pmId === cashPmId ? "cash" : "card", total, orderId]
  );
  if (settled) {
    const settlement = await pool.query(
      "INSERT INTO driver_settlements (driver_id, branch_id, order_count, cod_expected, cod_collected, expected_handover, actual_handover) VALUES ($1,$2,1,$3,$3,$3,$3) RETURNING id",
      [driverId, branchA, total]
    );
    await pool.query("UPDATE orders SET driver_settlement_id = $1 WHERE id = $2", [settlement.rows[0].id, orderId]);
  }
  return { orderId, total };
}

describe("GET /api/driver-settlements/driver-orders", () => {
  // المرحلة 8.51: collected بقى بيتحسب من driver_settlement_id مباشرة (مش مقصور على الكاش) - طلب
  // الكارت (o3) دلوقتي بيدخل في pendingBonusTotal زي أي طلب تاني لسه معندوش تسوية، مش مستبعد بـnull.
  // cashPendingCount/cashCollectedCount فضلوا مقصورين على الكاش عمدًا (دول أرقام تسوية الكاش تحديدًا)
  test("كل أوردرات السائق النهاردة - كاش متحصّل + كاش معلّق + كارت، مع بونص كل واحد صح", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const o1 = await makeDeliveredOrder({ pmId: cashPmId, deliveryFee: 25, deliveredAt: `${today} 10:00:00`, settled: true }); // بونص 5، متحصّل
    const o2 = await makeDeliveredOrder({ pmId: cashPmId, deliveryFee: 55, deliveredAt: `${today} 11:00:00`, settled: false }); // بونص 10، معلّق
    const o3 = await makeDeliveredOrder({ pmId: cardPmId, deliveryFee: 40, deliveredAt: `${today} 12:00:00`, settled: false }); // بونص 10، كارت لسه معلّق تسوية

    const res = await request(app).get(`/api/driver-settlements/driver-orders?driverId=${driverId}&date=${today}`).set(authed(cashierAToken));
    expect(res.status).toBe(200);
    expect(res.body.orderCount).toBe(3);
    const byId = Object.fromEntries(res.body.orders.map((o) => [o.id, o]));

    expect(byId[o1.orderId].bonus).toBe(5);
    expect(byId[o1.orderId].collected).toBe(true);
    expect(byId[o1.orderId].payment_kind).toBe("cash");

    expect(byId[o2.orderId].bonus).toBe(10);
    expect(byId[o2.orderId].collected).toBe(false);

    expect(byId[o3.orderId].bonus).toBe(10);
    expect(byId[o3.orderId].collected).toBe(false); // كارت لسه معلّق تسوية - بونصه محسوب معلّق زي أي طلب تاني

    expect(res.body.bonusTotal).toBe(25);
    expect(res.body.collectedBonusTotal).toBe(5);
    expect(res.body.pendingBonusTotal).toBe(20);
    expect(res.body.cashCollectedCount).toBe(1);
    expect(res.body.cashPendingCount).toBe(1);
    expect(res.body.deliveryFeesTotal).toBe(120);
  });

  test("فلترة التاريخ بتاعت delivered_at مش created_at - أوردر إمبارح ميظهرش في تقرير النهاردة", async () => {
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const today = new Date().toISOString().slice(0, 10);
    const old = await makeDeliveredOrder({ pmId: cashPmId, deliveryFee: 20, deliveredAt: `${yesterday} 09:00:00`, settled: false });

    const todayRes = await request(app).get(`/api/driver-settlements/driver-orders?driverId=${driverId}&date=${today}`).set(authed(managerAToken));
    expect(todayRes.body.orders.map((o) => o.id)).not.toContain(old.orderId);

    const yesterdayRes = await request(app).get(`/api/driver-settlements/driver-orders?driverId=${driverId}&date=${yesterday}`).set(authed(managerAToken));
    expect(yesterdayRes.body.orders.map((o) => o.id)).toContain(old.orderId);
  });

  test("مدير فرع تاني معندوش صلاحية يشوف تقرير سائق مش بتاع فرعه", async () => {
    const res = await request(app).get(`/api/driver-settlements/driver-orders?driverId=${driverId}`).set(authed(managerBToken));
    expect(res.status).toBe(403);
  });

  test("السائق يقدر يشوف تقرير نفسه بس مش سائق تاني", async () => {
    const own = await request(app).get(`/api/driver-settlements/driver-orders?driverId=${driverId}`).set(authed(driverToken));
    expect(own.status).toBe(200);

    const otherDriverUserId = await seedUser({ branchId: branchA, name: "سائق-تقرير-طيار-تاني", email: "driver2-dayreport@jest.test", role: "driver" });
    const otherDriverToken = await login("driver2-dayreport@jest.test");
    const otherReq = await request(app).get(`/api/driver-settlements/driver-orders?driverId=${driverId}`).set(authed(otherDriverToken));
    expect(otherReq.status).toBe(403);
  });

  test("مفيش driverId - 400", async () => {
    const res = await request(app).get("/api/driver-settlements/driver-orders").set(authed(managerAToken));
    expect(res.status).toBe(400);
  });
});

describe("GET /api/driver-settlements/branch-drivers", () => {
  test("بيرجّع كل سائقي الفرع النشطين - حتى لو مفيش عندهم كاش معلّق خالص", async () => {
    const res = await request(app).get(`/api/driver-settlements/branch-drivers?branchId=${branchA}`).set(authed(cashierAToken));
    expect(res.status).toBe(200);
    expect(res.body.find((d) => d.id === driverId)).toBeTruthy();
  });

  test("عزل الفروع - مدير فرع تاني معندوش صلاحية", async () => {
    const res = await request(app).get(`/api/driver-settlements/branch-drivers?branchId=${branchA}`).set(authed(managerBToken));
    expect(res.status).toBe(403);
  });
});
