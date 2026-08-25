// المرحلة 7F: تحكم السائق والتوصيل - ضد Postgres حقيقي. بيغطي: إدارة بيانات السائق، دورة حياة
// التوصيل الكاملة (تعيين -> خروج -> تسليم/فشل)، تحصيل الكاش عند التسليم وفروقه، تسوية كاش السائق
// وفروقها، الاسترجاع الموسّع لطلب فشل تسليمه، الصلاحيات وعزل الفروع، والتزامن الحقيقي.
const { app, request, pool, seedUser, login, authed } = require("./helpers");

let branchA, branchB;
let managerAToken, managerBToken, adminToken, cashierAToken;
let managerAId;
let driverA1Id, driverA1Token, driverA1UserId;
let driverA2Id, driverA2Token;
let driverBId, driverBToken;
let cashPmId, cardPmId;
let itemId, variantId; // سعر 500 - رقم سهل للحساب

beforeAll(async () => {
  const bA = await pool.query("INSERT INTO branches (name) VALUES ('فرع توصيل-A-جست') RETURNING id");
  branchA = bA.rows[0].id;
  const bB = await pool.query("INSERT INTO branches (name) VALUES ('فرع توصيل-B-جست') RETURNING id");
  branchB = bB.rows[0].id;

  managerAId = await seedUser({ branchId: branchA, name: "مدير-توصيل-A", email: "managerA-delivery@jest.test", role: "branch_manager" });
  await seedUser({ branchId: branchA, name: "كاشير-توصيل-A", email: "cashierA-delivery@jest.test", role: "cashier" });
  await seedUser({ branchId: branchB, name: "مدير-توصيل-B", email: "managerB-delivery@jest.test", role: "branch_manager" });
  await seedUser({ name: "أدمن-توصيل", email: "admin-delivery@jest.test", role: "admin" });

  managerAToken = await login("managerA-delivery@jest.test");
  cashierAToken = await login("cashierA-delivery@jest.test");
  managerBToken = await login("managerB-delivery@jest.test");
  adminToken = await login("admin-delivery@jest.test");

  // سائقين فرع A (له login فعلي role='driver') + سائق فرع B لاختبارات عزل الفروع
  driverA1UserId = await seedUser({ branchId: branchA, name: "سائق-A1-جست", email: "driverA1-delivery@jest.test", role: "driver" });
  const dA1 = await pool.query("INSERT INTO drivers (user_id, branch_id, driver_code, name, phone) VALUES ($1,$2,'DRV-JEST-A1',$3,$4) RETURNING id", [driverA1UserId, branchA, "سائق-A1-جست", "01000000001"]);
  driverA1Id = dA1.rows[0].id;
  driverA1Token = await login("driverA1-delivery@jest.test");

  const driverA2UserId = await seedUser({ branchId: branchA, name: "سائق-A2-جست", email: "driverA2-delivery@jest.test", role: "driver" });
  const dA2 = await pool.query("INSERT INTO drivers (user_id, branch_id, driver_code, name) VALUES ($1,$2,'DRV-JEST-A2',$3) RETURNING id", [driverA2UserId, branchA, "سائق-A2-جست"]);
  driverA2Id = dA2.rows[0].id;
  driverA2Token = await login("driverA2-delivery@jest.test");

  const driverBUserId = await seedUser({ branchId: branchB, name: "سائق-B-جست", email: "driverB-delivery@jest.test", role: "driver" });
  const dB = await pool.query("INSERT INTO drivers (user_id, branch_id, driver_code, name) VALUES ($1,$2,'DRV-JEST-B',$3) RETURNING id", [driverBUserId, branchB, "سائق-B-جست"]);
  driverBId = dB.rows[0].id;
  driverBToken = await login("driverB-delivery@jest.test");

  const pmCash = await pool.query("INSERT INTO payment_methods (name, kind) VALUES ('كاش-توصيل-جست', 'cash') RETURNING id");
  cashPmId = pmCash.rows[0].id;
  const pmCard = await pool.query("INSERT INTO payment_methods (name, kind) VALUES ('كارت-توصيل-جست', 'card_or_wallet') RETURNING id");
  cardPmId = pmCard.rows[0].id;

  const cat = await pool.query("INSERT INTO menu_categories (name) VALUES ('توصيل-جست-قسم') RETURNING id");
  const mi = await pool.query("INSERT INTO menu_items (category_id, name) VALUES ($1,'صنف-توصيل-جست') RETURNING id", [cat.rows[0].id]);
  itemId = mi.rows[0].id;
  const v = await pool.query("INSERT INTO menu_item_variants (item_id, label, price) VALUES ($1,'عادي',500) RETURNING id", [itemId]);
  variantId = v.rows[0].id;
});

afterAll(async () => {
  await pool.end();
});

async function makeDeliveryOrder(token, branchId, paymentMethodId, phone) {
  return request(app).post("/api/orders").set(authed(token)).send({
    // بادئة "017" مخصوصة لملف الاختبار ده - عشان منتصدمش مع بادئة "010" (order-edit.test.js) أو "011"
    // (loyalty-redemption.test.js): آخر 8 خانات من Date.now() بس بتتغيّر فعليًا (كل ~100 ثانية)، فلو
    // ملفين استخدموا نفس البادئة في نفس التشغيلة ممكن يطلع نفس الرقم بالظبط ويتصادموا على نفس العميل
    branchId, source: "pos", orderType: "delivery", customerPhone: phone || `017${Date.now()}`.slice(0, 11),
    addressDetails: "شارع الاختبار", paymentMethodId,
    items: [{ itemId, variantId, quantity: 1 }],
  });
}

describe("إدارة بيانات السائق", () => {
  let createdDriverId;

  test("مدير فرع يقدر ينشئ سائق جديد بدون تسجيل دخول", async () => {
    const res = await request(app).post("/api/drivers").set(authed(managerAToken)).send({ name: "سائق تجربة", phone: "01099999999" });
    expect(res.status).toBe(201);
    expect(res.body.driver_code).toMatch(/^DRV-/);
    expect(res.body.status).toBe("AVAILABLE");
    expect(res.body.user_id).toBeNull();
    createdDriverId = res.body.id;
  });

  test("مدير فرع يقدر ينشئ سائق مع تسجيل دخول فعلي", async () => {
    const res = await request(app).post("/api/drivers").set(authed(managerAToken)).send({
      name: "سائق بلوجن", createLogin: { email: `driverlogin-${Date.now()}@jest.test`, password: "test12345" },
    });
    expect(res.status).toBe(201);
    expect(res.body.user_id).not.toBeNull();
  });

  test("مينفعش تنشئ سائق بإيميل مستخدم بالفعل", async () => {
    const res = await request(app).post("/api/drivers").set(authed(managerAToken)).send({
      name: "سائق مكرر", createLogin: { email: "driverA1-delivery@jest.test", password: "test12345" },
    });
    expect(res.status).toBe(409);
  });

  test("مدير فرع B مينفعش يشوف/يعدّل سائقين فرع A", async () => {
    const list = await request(app).get(`/api/drivers?branchId=${branchA}`).set(authed(managerBToken));
    expect(list.status).toBe(403);
    const patch = await request(app).patch(`/api/drivers/${createdDriverId}`).set(authed(managerBToken)).send({ status: "SUSPENDED" });
    expect(patch.status).toBe(403);
  });

  test("مدير الفرع يقدر يعدّل حالة سائق فرعه", async () => {
    const res = await request(app).patch(`/api/drivers/${createdDriverId}`).set(authed(managerAToken)).send({ status: "OFF_DUTY" });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("OFF_DUTY");
  });

  test("كاشير مينفعش يدير بيانات السائقين", async () => {
    const res = await request(app).post("/api/drivers").set(authed(cashierAToken)).send({ name: "سائق ممنوع" });
    expect(res.status).toBe(403);
  });
});

describe("دورة حياة التوصيل: تعيين -> خروج -> تسليم", () => {
  let orderId;

  test("طلب دليفري جديد بيتسجل بحالة توزيع UNASSIGNED", async () => {
    const order = await makeDeliveryOrder(managerAToken, branchA, cashPmId);
    expect(order.status).toBe(201);
    orderId = order.body.orderId;
    const row = await pool.query("SELECT dispatch_status, status, payment_status FROM orders WHERE id=$1", [orderId]);
    expect(row.rows[0].dispatch_status).toBe("UNASSIGNED");
    expect(row.rows[0].status).toBe("preparing");
    expect(row.rows[0].payment_status).toBe("pending_collection");
  });

  test("طلب تيك أواي (مش دليفري) dispatch_status بتاعه NULL", async () => {
    const order = await request(app).post("/api/orders").set(authed(managerAToken)).send({
      branchId: branchA, source: "pos", orderType: "takeaway", paymentMethodId: cashPmId,
      items: [{ itemId, variantId, quantity: 1 }],
    });
    const row = await pool.query("SELECT dispatch_status FROM orders WHERE id=$1", [order.body.orderId]);
    expect(row.rows[0].dispatch_status).toBeNull();
  });

  test("تعيين سائق من فرع تاني بيترفض", async () => {
    const res = await request(app).post(`/api/deliveries/${orderId}/assign`).set(authed(managerAToken)).send({ driverId: driverBId });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("مش تابع لفرع");
  });

  test("كاشير مينفعش يعيّن سائق", async () => {
    const res = await request(app).post(`/api/deliveries/${orderId}/assign`).set(authed(cashierAToken)).send({ driverId: driverA1Id });
    expect(res.status).toBe(403);
  });

  test("مدير الفرع يعيّن سائق - الطلب يبقى ASSIGNED", async () => {
    const res = await request(app).post(`/api/deliveries/${orderId}/assign`).set(authed(managerAToken)).send({ driverId: driverA1Id });
    expect(res.status).toBe(200);
    expect(res.body.dispatch_status).toBe("ASSIGNED");
    expect(res.body.driver_id).toBe(driverA1Id);
    expect(res.body.driver_name).toBe("سائق-A1-جست");
  });

  test("مينفعش تعيّن سائق تاني لطلب معيّن بالفعل", async () => {
    const res = await request(app).post(`/api/deliveries/${orderId}/assign`).set(authed(managerAToken)).send({ driverId: driverA2Id });
    expect(res.status).toBe(400);
  });

  test("سائق تاني مينفعش يخرج بطلب مش بتاعه", async () => {
    const res = await request(app).post(`/api/deliveries/${orderId}/out-for-delivery`).set(authed(driverA2Token));
    expect(res.status).toBe(403);
  });

  test("السائق صاحب الطلب يقدر يعلّم إنه خرج للتوصيل", async () => {
    const res = await request(app).post(`/api/deliveries/${orderId}/out-for-delivery`).set(authed(driverA1Token));
    expect(res.status).toBe(200);
    expect(res.body.dispatch_status).toBe("OUT_FOR_DELIVERY");
    expect(res.body.status).toBe("out_for_delivery");
  });

  test("مينفعش تلغي تعيين طلب بعد ما السائق خرج بيه", async () => {
    const res = await request(app).post(`/api/deliveries/${orderId}/unassign`).set(authed(managerAToken));
    expect(res.status).toBe(400);
  });

  test("تسليم كاش من غير تسجيل المبلغ المحصّل بيترفض", async () => {
    const res = await request(app).post(`/api/deliveries/${orderId}/delivered`).set(authed(driverA1Token)).send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("المبلغ");
  });

  test("تسليم ناجح بمبلغ مطابق تمامًا - الطلب يكتمل، الفرق صفر، قيد محاسبي متزن", async () => {
    const res = await request(app).post(`/api/deliveries/${orderId}/delivered`).set(authed(driverA1Token)).send({ collectedAmount: 500 });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("completed");
    expect(res.body.dispatch_status).toBe("DELIVERED");
    expect(res.body.payment_status).toBe("collected");
    expect(Number(res.body.collection_variance)).toBe(0);

    const entry = await pool.query("SELECT id FROM journal_entries WHERE source_type='delivery_collection' AND source_id=$1 AND status='POSTED'", [orderId]);
    expect(entry.rows.length).toBe(1);
    const lines = await pool.query("SELECT debit, credit FROM journal_entry_lines WHERE journal_entry_id=$1", [entry.rows[0].id]);
    const totalDebit = lines.rows.reduce((s, l) => s + Number(l.debit), 0);
    const totalCredit = lines.rows.reduce((s, l) => s + Number(l.credit), 0);
    expect(totalDebit).toBe(totalCredit);
    expect(totalDebit).toBe(500);
  });

  test("مينفعش تسجّل تسليم تاني لنفس الطلب", async () => {
    const res = await request(app).post(`/api/deliveries/${orderId}/delivered`).set(authed(driverA1Token)).send({ collectedAmount: 500 });
    expect(res.status).toBe(400);
  });
});

describe("فروق تحصيل الكاش عند التسليم (عجز/زيادة)", () => {
  test("عجز في التحصيل بيتسجل بدقة مع سطر مصروف موازن", async () => {
    const order = await makeDeliveryOrder(managerAToken, branchA, cashPmId);
    const orderId = order.body.orderId;
    await request(app).post(`/api/deliveries/${orderId}/assign`).set(authed(managerAToken)).send({ driverId: driverA1Id });
    await request(app).post(`/api/deliveries/${orderId}/out-for-delivery`).set(authed(driverA1Token));
    const res = await request(app).post(`/api/deliveries/${orderId}/delivered`).set(authed(driverA1Token)).send({ collectedAmount: 470 });
    expect(res.status).toBe(200);
    expect(Number(res.body.collection_variance)).toBe(-30);

    const entry = await pool.query("SELECT id FROM journal_entries WHERE source_type='delivery_collection' AND source_id=$1", [orderId]);
    const lines = await pool.query(
      "SELECT jel.debit, jel.credit, a.code FROM journal_entry_lines jel JOIN accounts a ON a.id=jel.account_id WHERE journal_entry_id=$1",
      [entry.rows[0].id]
    );
    const shortageLine = lines.rows.find((l) => l.code === "6900");
    expect(shortageLine).toBeTruthy();
    expect(Number(shortageLine.debit)).toBe(30);
    const totalDebit = lines.rows.reduce((s, l) => s + Number(l.debit), 0);
    const totalCredit = lines.rows.reduce((s, l) => s + Number(l.credit), 0);
    expect(totalDebit).toBe(totalCredit);
  });

  test("زيادة في التحصيل بيتسجل مع سطر إيراد موازن", async () => {
    const order = await makeDeliveryOrder(managerAToken, branchA, cashPmId);
    const orderId = order.body.orderId;
    await request(app).post(`/api/deliveries/${orderId}/assign`).set(authed(managerAToken)).send({ driverId: driverA1Id });
    await request(app).post(`/api/deliveries/${orderId}/out-for-delivery`).set(authed(driverA1Token));
    const res = await request(app).post(`/api/deliveries/${orderId}/delivered`).set(authed(driverA1Token)).send({ collectedAmount: 520 });
    expect(Number(res.body.collection_variance)).toBe(20);

    const entry = await pool.query("SELECT id FROM journal_entries WHERE source_type='delivery_collection' AND source_id=$1", [orderId]);
    const lines = await pool.query(
      "SELECT jel.credit, a.code FROM journal_entry_lines jel JOIN accounts a ON a.id=jel.account_id WHERE journal_entry_id=$1 AND a.code='4300'",
      [entry.rows[0].id]
    );
    expect(Number(lines.rows[0].credit)).toBe(20);
  });

  test("طلب دليفري بكارت - التسليم مبيطلبش مبلغ محصّل ومفيش قيد عهدة سائق", async () => {
    const order = await makeDeliveryOrder(managerAToken, branchA, cardPmId);
    const orderId = order.body.orderId;
    await request(app).post(`/api/deliveries/${orderId}/assign`).set(authed(managerAToken)).send({ driverId: driverA1Id });
    await request(app).post(`/api/deliveries/${orderId}/out-for-delivery`).set(authed(driverA1Token));
    const res = await request(app).post(`/api/deliveries/${orderId}/delivered`).set(authed(driverA1Token)).send({});
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("completed");
    const entry = await pool.query("SELECT id FROM journal_entries WHERE source_type='delivery_collection' AND source_id=$1", [orderId]);
    expect(entry.rows.length).toBe(0);
  });
});

describe("فشل التسليم وحل الفشل (إعادة جدولة أو رجوع)", () => {
  test("سبب فشل غير معروف بيترفض", async () => {
    const order = await makeDeliveryOrder(managerAToken, branchA, cashPmId);
    const orderId = order.body.orderId;
    await request(app).post(`/api/deliveries/${orderId}/assign`).set(authed(managerAToken)).send({ driverId: driverA1Id });
    await request(app).post(`/api/deliveries/${orderId}/out-for-delivery`).set(authed(driverA1Token));
    const res = await request(app).post(`/api/deliveries/${orderId}/failed`).set(authed(driverA1Token)).send({ reason: "NOT_A_REAL_REASON" });
    expect(res.status).toBe(400);
  });

  test("تسجيل فشل تسليم صحيح - الطلب يفضل out_for_delivery لحد ما يتحل", async () => {
    const order = await makeDeliveryOrder(managerAToken, branchA, cashPmId);
    const orderId = order.body.orderId;
    await request(app).post(`/api/deliveries/${orderId}/assign`).set(authed(managerAToken)).send({ driverId: driverA1Id });
    await request(app).post(`/api/deliveries/${orderId}/out-for-delivery`).set(authed(driverA1Token));
    const res = await request(app).post(`/api/deliveries/${orderId}/failed`).set(authed(driverA1Token)).send({ reason: "CUSTOMER_UNREACHABLE" });
    expect(res.status).toBe(200);
    expect(res.body.dispatch_status).toBe("FAILED");
    expect(res.body.status).toBe("out_for_delivery");
    expect(res.body.delivery_failure_reason).toBe("CUSTOMER_UNREACHABLE");

    // إعادة جدولة - يرجع UNASSIGNED ويتاح لتعيين تاني
    const reschedule = await request(app).post(`/api/deliveries/${orderId}/reschedule`).set(authed(managerAToken));
    expect(reschedule.status).toBe(200);
    expect(reschedule.body.dispatch_status).toBe("UNASSIGNED");
    expect(reschedule.body.driver_id).toBeNull();

    const reassign = await request(app).post(`/api/deliveries/${orderId}/assign`).set(authed(managerAToken)).send({ driverId: driverA2Id });
    expect(reassign.status).toBe(200);
  });

  test("طلب فشل تسليمه وترجع للفرع - الاسترجاع الموسّع بيعكس المخزون والقيد المحاسبي", async () => {
    const order = await makeDeliveryOrder(managerAToken, branchA, cashPmId);
    const orderId = order.body.orderId;
    await request(app).post(`/api/deliveries/${orderId}/assign`).set(authed(managerAToken)).send({ driverId: driverA1Id });
    await request(app).post(`/api/deliveries/${orderId}/out-for-delivery`).set(authed(driverA1Token));
    await request(app).post(`/api/deliveries/${orderId}/failed`).set(authed(driverA1Token)).send({ reason: "WRONG_ADDRESS" });

    const voidRes = await request(app).post(`/api/orders/${orderId}/void`).set(authed(managerAToken)).send({ reason: "رجع الفرع - عنوان غلط" });
    expect(voidRes.status).toBe(200);
    expect(voidRes.body.status).toBe("cancelled");
    expect(voidRes.body.dispatch_status).toBe("RETURNED");
    expect(voidRes.body.voided).toBe(true);
  });

  test("مينفعش تسترجع طلب دليفري لسه في الطريق (مش FAILED)", async () => {
    const order = await makeDeliveryOrder(managerAToken, branchA, cashPmId);
    const orderId = order.body.orderId;
    await request(app).post(`/api/deliveries/${orderId}/assign`).set(authed(managerAToken)).send({ driverId: driverA1Id });
    await request(app).post(`/api/deliveries/${orderId}/out-for-delivery`).set(authed(driverA1Token));
    const res = await request(app).post(`/api/orders/${orderId}/void`).set(authed(managerAToken)).send({ reason: "تجربة" });
    expect(res.status).toBe(400);
  });
});

describe("لوحة التوزيع وعرض السائق لطلباته", () => {
  test("لوحة التوزيع مقفولة على الفرع", async () => {
    const res = await request(app).get(`/api/deliveries?branchId=${branchA}`).set(authed(managerBToken));
    expect(res.status).toBe(403);
  });

  test("مدير الفرع يشوف لوحة التوزيع بتاعة فرعه", async () => {
    const res = await request(app).get(`/api/deliveries?branchId=${branchA}`).set(authed(managerAToken));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThan(0);
  });

  test("السائق يشوف طلباته النشطة بس", async () => {
    const order = await makeDeliveryOrder(managerAToken, branchA, cashPmId);
    const orderId = order.body.orderId;
    await request(app).post(`/api/deliveries/${orderId}/assign`).set(authed(managerAToken)).send({ driverId: driverA1Id });

    const mine = await request(app).get("/api/deliveries/mine").set(authed(driverA1Token));
    expect(mine.status).toBe(200);
    expect(mine.body.some((o) => o.id === orderId)).toBe(true);

    const mineOther = await request(app).get("/api/deliveries/mine").set(authed(driverA2Token));
    expect(mineOther.body.some((o) => o.id === orderId)).toBe(false);
  });

  test("سائق مينفعش يشوف تفاصيل طلب مش بتاعه", async () => {
    const order = await makeDeliveryOrder(managerAToken, branchA, cashPmId);
    const orderId = order.body.orderId;
    await request(app).post(`/api/deliveries/${orderId}/assign`).set(authed(managerAToken)).send({ driverId: driverA1Id });
    const res = await request(app).get(`/api/deliveries/${orderId}`).set(authed(driverA2Token));
    expect(res.status).toBe(403);
  });
});

describe("أمان: السائق مقفول تمامًا على نطاقه", () => {
  test("سائق مينفعش يشوف فرع تاني", async () => {
    const res = await request(app).get(`/api/deliveries?branchId=${branchB}`).set(authed(driverA1Token));
    expect(res.status).toBe(403);
  });

  test("سائق مينفعش يوصل للمحاسبة", async () => {
    const res = await request(app).get("/api/accounting/accounts").set(authed(driverA1Token));
    expect(res.status).toBe(403);
  });

  test("سائق مينفعش يوصل للمخزون", async () => {
    const res = await request(app).get("/api/inventory/stock").set(authed(driverA1Token));
    expect(res.status).toBe(403);
  });

  test("سائق مينفعش يراجع تسوية (مش عنده الصلاحية دي)", async () => {
    const res = await request(app).post("/api/driver-settlements/1/review").set(authed(driverA1Token)).send({ decision: "approve" });
    expect(res.status).toBe(403);
  });
});

describe("تسوية كاش السائق", () => {
  let settleDriverId, settleDriverToken;

  beforeAll(async () => {
    const userId = await seedUser({ branchId: branchA, name: "سائق-تسوية-جست", email: "driver-settle@jest.test", role: "driver" });
    const d = await pool.query("INSERT INTO drivers (user_id, branch_id, driver_code, name) VALUES ($1,$2,'DRV-JEST-SETTLE',$3) RETURNING id", [userId, branchA, "سائق-تسوية-جست"]);
    settleDriverId = d.rows[0].id;
    settleDriverToken = await login("driver-settle@jest.test");
  });

  async function deliverOne(collected) {
    const order = await makeDeliveryOrder(managerAToken, branchA, cashPmId);
    const orderId = order.body.orderId;
    await request(app).post(`/api/deliveries/${orderId}/assign`).set(authed(managerAToken)).send({ driverId: settleDriverId });
    await request(app).post(`/api/deliveries/${orderId}/out-for-delivery`).set(authed(settleDriverToken));
    await request(app).post(`/api/deliveries/${orderId}/delivered`).set(authed(settleDriverToken)).send({ collectedAmount: collected });
    return orderId;
  }

  test("معاينة قبل أي تسليم = صفر", async () => {
    const res = await request(app).get(`/api/driver-settlements/preview?driverId=${settleDriverId}`).set(authed(managerAToken));
    expect(res.status).toBe(200);
    expect(res.body.orderCount).toBe(0);
    expect(res.body.expectedHandover).toBe(0);
  });

  test("بعد تسليم طلبين كاش - المعاينة بتجمع الاتنين صح", async () => {
    await deliverOne(500);
    await deliverOne(490); // عجز 10
    const res = await request(app).get(`/api/driver-settlements/preview?driverId=${settleDriverId}`).set(authed(managerAToken));
    expect(res.body.orderCount).toBe(2);
    expect(res.body.codExpected).toBe(1000);
    expect(res.body.codCollected).toBe(990);
    expect(res.body.codVariance).toBe(-10);
    expect(res.body.expectedHandover).toBe(990);
  });

  test("تسوية بمبلغ مطابق تمامًا => فرق صفر، الطلبات بتتعلّم متسوّاة", async () => {
    const res = await request(app).post("/api/driver-settlements").set(authed(managerAToken)).send({ driverId: settleDriverId, actualHandover: 990 });
    expect(res.status).toBe(201);
    expect(res.body.order_count).toBe(2);
    expect(Number(res.body.handover_variance)).toBe(0);
    expect(res.body.variance_status).toBe("NONE");

    const entry = await pool.query("SELECT id FROM journal_entries WHERE source_type='driver_settlement' AND source_id=$1", [res.body.id]);
    const lines = await pool.query("SELECT debit, credit FROM journal_entry_lines WHERE journal_entry_id=$1", [entry.rows[0].id]);
    const totalDebit = lines.rows.reduce((s, l) => s + Number(l.debit), 0);
    const totalCredit = lines.rows.reduce((s, l) => s + Number(l.credit), 0);
    expect(totalDebit).toBe(totalCredit);
  });

  test("تسوية تانية فورًا من غير طلبات جديدة بترفض", async () => {
    const res = await request(app).post("/api/driver-settlements").set(authed(managerAToken)).send({ driverId: settleDriverId, actualHandover: 0 });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("مفيش طلبات معلّقة");
  });

  test("تسوية بعجز تسليم كبير => PENDING_REVIEW، وبعد المراجعة تتقفل", async () => {
    await deliverOne(500);
    const res = await request(app).post("/api/driver-settlements").set(authed(managerAToken)).send({ driverId: settleDriverId, actualHandover: 400 });
    expect(res.status).toBe(201);
    expect(Number(res.body.handover_variance)).toBe(-100);
    expect(res.body.variance_status).toBe("PENDING_REVIEW");

    const review = await request(app).post(`/api/driver-settlements/${res.body.id}/review`).set(authed(managerAToken)).send({ decision: "acknowledge", notes: "اتحقق منه" });
    expect(review.status).toBe(200);
    expect(review.body.variance_status).toBe("ACKNOWLEDGED");

    const reviewAgain = await request(app).post(`/api/driver-settlements/${res.body.id}/review`).set(authed(managerAToken)).send({ decision: "approve" });
    expect(reviewAgain.status).toBe(400);
  });

  test("السائق يشوف تسوياته هو بس، مش تسويات سائق تاني", async () => {
    const mine = await request(app).get("/api/driver-settlements").set(authed(settleDriverToken));
    expect(mine.status).toBe(200);
    expect(mine.body.length).toBeGreaterThanOrEqual(2);
    const other = await request(app).get("/api/driver-settlements").set(authed(driverA1Token));
    expect(other.body.every((s) => s.driver_id !== settleDriverId)).toBe(true);
  });

  test("السائق مينفعش يبدأ تسوية بنفسه", async () => {
    const res = await request(app).post("/api/driver-settlements").set(authed(settleDriverToken)).send({ driverId: settleDriverId, actualHandover: 0 });
    expect(res.status).toBe(403);
  });

  test("مدير فرع تاني مينفعش يسوّي أو يراجع سائق مش بتاعه", async () => {
    const preview = await request(app).get(`/api/driver-settlements/preview?driverId=${settleDriverId}`).set(authed(managerBToken));
    expect(preview.status).toBe(403);
  });
});

describe("تزامن (Concurrency)", () => {
  test("تعيين نفس الطلب بالتوازي لسائقين مختلفين - واحد بس ينجح", async () => {
    const order = await makeDeliveryOrder(managerAToken, branchA, cashPmId);
    const orderId = order.body.orderId;
    const results = await Promise.all([
      request(app).post(`/api/deliveries/${orderId}/assign`).set(authed(managerAToken)).send({ driverId: driverA1Id }),
      request(app).post(`/api/deliveries/${orderId}/assign`).set(authed(managerAToken)).send({ driverId: driverA2Id }),
      request(app).post(`/api/deliveries/${orderId}/assign`).set(authed(managerAToken)).send({ driverId: driverA1Id }),
    ]);
    const successes = results.filter((r) => r.status === 200);
    expect(successes.length).toBe(1);
  });

  test("تسجيل تسليم نفس الطلب بالتوازي مرتين - واحد بس ينجح", async () => {
    const order = await makeDeliveryOrder(managerAToken, branchA, cashPmId);
    const orderId = order.body.orderId;
    await request(app).post(`/api/deliveries/${orderId}/assign`).set(authed(managerAToken)).send({ driverId: driverA1Id });
    await request(app).post(`/api/deliveries/${orderId}/out-for-delivery`).set(authed(driverA1Token));
    const results = await Promise.all(
      Array.from({ length: 4 }, () => request(app).post(`/api/deliveries/${orderId}/delivered`).set(authed(driverA1Token)).send({ collectedAmount: 500 }))
    );
    const successes = results.filter((r) => r.status === 200);
    expect(successes.length).toBe(1);

    const entryCount = await pool.query("SELECT COUNT(*) AS c FROM journal_entries WHERE source_type='delivery_collection' AND source_id=$1", [orderId]);
    expect(Number(entryCount.rows[0].c)).toBe(1);
  });

  test("تسوية نفس السائق بالتوازي - واحد بس ينجح والباقي NOTHING_TO_SETTLE", async () => {
    const userId = await seedUser({ branchId: branchA, name: "سائق-تزامن-جست", email: "driver-concurrency@jest.test", role: "driver" });
    const d = await pool.query("INSERT INTO drivers (user_id, branch_id, driver_code, name) VALUES ($1,$2,'DRV-JEST-CONC',$3) RETURNING id", [userId, branchA, "سائق-تزامن-جست"]);
    const concDriverId = d.rows[0].id;
    const concDriverToken = await login("driver-concurrency@jest.test");

    const order = await makeDeliveryOrder(managerAToken, branchA, cashPmId);
    const orderId = order.body.orderId;
    await request(app).post(`/api/deliveries/${orderId}/assign`).set(authed(managerAToken)).send({ driverId: concDriverId });
    await request(app).post(`/api/deliveries/${orderId}/out-for-delivery`).set(authed(concDriverToken));
    await request(app).post(`/api/deliveries/${orderId}/delivered`).set(authed(concDriverToken)).send({ collectedAmount: 500 });

    const results = await Promise.all(
      Array.from({ length: 4 }, () => request(app).post("/api/driver-settlements").set(authed(managerAToken)).send({ driverId: concDriverId, actualHandover: 500 }))
    );
    const successes = results.filter((r) => r.status === 201);
    const nothingToSettle = results.filter((r) => r.status === 400);
    expect(successes.length).toBe(1);
    expect(nothingToSettle.length).toBe(3);
  });
});

describe("سجل التدقيق (Audit Trail)", () => {
  test("كل عملية حرجة في دورة حياة التوصيل بتتسجل في audit_logs", async () => {
    const order = await makeDeliveryOrder(managerAToken, branchA, cashPmId);
    const orderId = order.body.orderId;
    await request(app).post(`/api/deliveries/${orderId}/assign`).set(authed(managerAToken)).send({ driverId: driverA1Id });
    await request(app).post(`/api/deliveries/${orderId}/out-for-delivery`).set(authed(driverA1Token));
    await request(app).post(`/api/deliveries/${orderId}/delivered`).set(authed(driverA1Token)).send({ collectedAmount: 500 });

    const actions = await pool.query(
      "SELECT action FROM audit_logs WHERE entity_type='order' AND entity_id=$1 ORDER BY id",
      [orderId]
    );
    const actionNames = actions.rows.map((r) => r.action);
    expect(actionNames).toContain("DRIVER_ASSIGNED");
    expect(actionNames).toContain("DELIVERY_COLLECTED");
  });
});
