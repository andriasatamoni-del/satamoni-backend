// المرحلة 8.44: مينفعش الكاشير يقفل شيفته وسايب طلبات مفتوحة (تحت التحضير/في الطريق) مرتبطة بيه - لازم
// يقفلها أو يسلّمها لشيفت تاني شغال (PATCH /api/orders/:id/shift) الأول. بيغطي: رفض القفل مع وجود طلب
// مفتوح، نجاح القفل بعد التسليم لشيفت تاني، GET /api/shifts/active-others (بدون أرقام مالية حساسة)،
// وضوابط PATCH /api/orders/:id/shift (فرع مختلف، شيفت مش ACTIVE، صلاحيات).
const { app, request, pool, seedUser, login, authed } = require("./helpers");

let branchA;
let cashierAToken, cashierA2Token, managerAToken;
let cashierAId, cashierA2Id;
let cashPmId, itemId, deliveryVariantId;

beforeAll(async () => {
  const b = await pool.query("INSERT INTO branches (name) VALUES ('فرع تسليم-طلبات-جست') RETURNING id");
  branchA = b.rows[0].id;

  cashierAId = await seedUser({ branchId: branchA, name: "كاشير-تسليم-A", email: "cashierA-handoff@jest.test", role: "cashier" });
  cashierA2Id = await seedUser({ branchId: branchA, name: "كاشير-تسليم-A2", email: "cashierA2-handoff@jest.test", role: "cashier" });
  await seedUser({ branchId: branchA, name: "مدير-تسليم-A", email: "managerA-handoff@jest.test", role: "branch_manager" });

  cashierAToken = await login("cashierA-handoff@jest.test");
  cashierA2Token = await login("cashierA2-handoff@jest.test");
  managerAToken = await login("managerA-handoff@jest.test");

  const pm = await pool.query("INSERT INTO payment_methods (name, kind) VALUES ('كاش-تسليم-جست', 'cash') RETURNING id");
  cashPmId = pm.rows[0].id;

  const cat = await pool.query("INSERT INTO menu_categories (name) VALUES ('تسليم-جست-قسم') RETURNING id");
  const mi = await pool.query("INSERT INTO menu_items (category_id, name) VALUES ($1,'صنف-تسليم-جست') RETURNING id", [cat.rows[0].id]);
  itemId = mi.rows[0].id;
  const v = await pool.query("INSERT INTO menu_item_variants (item_id, label, price) VALUES ($1,'عادي',100) RETURNING id", [itemId]);
  deliveryVariantId = v.rows[0].id;
});

afterAll(async () => {
  await pool.end();
});

async function makeDeliveryOrder(token) {
  return request(app).post("/api/orders").set(authed(token)).send({
    branchId: branchA, source: "pos", orderType: "delivery", paymentMethodId: cashPmId,
    customerPhone: "01000000000", addressDetails: "عنوان جست",
    items: [{ itemId, variantId: deliveryVariantId, quantity: 1 }],
  });
}

describe("قفل الشيفت مرفوض لو فيه طلب دليفري لسه تحت التحضير", () => {
  let shiftId, orderId;

  test("فتح شيفت + بيع دليفري = طلب preparing مرتبط بالشيفت", async () => {
    const open = await request(app).post("/api/shifts/open").set(authed(cashierAToken)).send({ openingCash: 0 });
    expect(open.status).toBe(201);
    shiftId = open.body.id;
    const order = await makeDeliveryOrder(cashierAToken);
    expect(order.status).toBe(201);
    orderId = order.body.orderId;

    const check = await pool.query("SELECT shift_id, status FROM orders WHERE id = $1", [orderId]);
    expect(check.rows[0].shift_id).toBe(shiftId);
    expect(check.rows[0].status).toBe("preparing");
  });

  test("قفل الشيفت بيترفض (409) وبيرجّع تفاصيل الطلب المفتوح", async () => {
    const res = await request(app).post(`/api/shifts/${shiftId}/close`).set(authed(cashierAToken)).send({ actualCash: 0 });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("OPEN_ORDERS_ON_SHIFT");
    expect(res.body.openOrders.map((o) => o.id)).toContain(orderId);

    const shiftCheck = await pool.query("SELECT status FROM pos_shifts WHERE id = $1", [shiftId]);
    expect(shiftCheck.rows[0].status).toBe("ACTIVE"); // لسه شغال فعليًا، القفل اترفض قبل أي تغيير
  });

  test("GET /api/shifts/active-others - بيرجّع باقي الشيفتات الشغالة من غير أرقام مالية", async () => {
    const open2 = await request(app).post("/api/shifts/open").set(authed(cashierA2Token)).send({ openingCash: 0 });
    expect(open2.status).toBe(201);

    const res = await request(app).get(`/api/shifts/active-others?branchId=${branchA}`).set(authed(cashierAToken));
    expect(res.status).toBe(200);
    expect(res.body.length).toBe(1);
    expect(res.body[0].id).toBe(open2.body.id);
    expect(res.body[0].cashier_name).toBe("كاشير-تسليم-A2");
    expect(res.body[0]).not.toHaveProperty("cash_variance");
    expect(res.body[0]).not.toHaveProperty("opening_cash");

    await request(app).post(`/api/shifts/${open2.body.id}/close`).set(authed(cashierA2Token)).send({ actualCash: 0 });
  });

  test("مينفعش تسلّم لشيفت مش شغال (CLOSED)", async () => {
    const open2 = await request(app).post("/api/shifts/open").set(authed(cashierA2Token)).send({ openingCash: 0 });
    await request(app).post(`/api/shifts/${open2.body.id}/close`).set(authed(cashierA2Token)).send({ actualCash: 0 });

    const res = await request(app).patch(`/api/orders/${orderId}/shift`).set(authed(cashierAToken)).send({ shiftId: open2.body.id });
    expect(res.status).toBe(400);
  });

  test("مينفعش تسلّم لشيفت فرع تاني", async () => {
    const branchB = (await pool.query("INSERT INTO branches (name) VALUES ('فرع تسليم-جست-B') RETURNING id")).rows[0].id;
    const cashierB = await seedUser({ branchId: branchB, name: "كاشير-فرع-ب-جست", email: "cashierB-handoff@jest.test", role: "cashier" });
    const cashierBToken = await login("cashierB-handoff@jest.test");
    const openB = await request(app).post("/api/shifts/open").set(authed(cashierBToken)).send({ openingCash: 0 });

    const res = await request(app).patch(`/api/orders/${orderId}/shift`).set(authed(cashierAToken)).send({ shiftId: openB.body.id });
    expect(res.status).toBe(400);

    await request(app).post(`/api/shifts/${openB.body.id}/close`).set(authed(cashierBToken)).send({ actualCash: 0 });
  });

  test("كاشير تاني معندوش صلاحية يسلّم طلب مش بتاعه", async () => {
    const open2 = await request(app).post("/api/shifts/open").set(authed(cashierA2Token)).send({ openingCash: 0 });
    const res = await request(app).patch(`/api/orders/${orderId}/shift`).set(authed(cashierA2Token)).send({ shiftId: open2.body.id });
    expect(res.status).toBe(403);
    await request(app).post(`/api/shifts/${open2.body.id}/close`).set(authed(cashierA2Token)).send({ actualCash: 0 });
  });

  test("تسليم الطلب لشيفت تاني شغال بينجح، وبعدين الشيفت الأصلي يقدر يقفل عادي", async () => {
    const open2 = await request(app).post("/api/shifts/open").set(authed(cashierA2Token)).send({ openingCash: 0 });
    const target = open2.body.id;

    const handoff = await request(app).patch(`/api/orders/${orderId}/shift`).set(authed(cashierAToken)).send({ shiftId: target });
    expect(handoff.status).toBe(200);
    expect(handoff.body.shift_id).toBe(target);

    const close = await request(app).post(`/api/shifts/${shiftId}/close`).set(authed(cashierAToken)).send({ actualCash: 0 });
    expect(close.status).toBe(200);
    expect(close.body.status).toBe("CLOSED");

    // الطلب دلوقتي مرتبط بالشيفت التاني - لو هو كمان حاول يقفل، هيترفض
    const closeTarget = await request(app).post(`/api/shifts/${target}/close`).set(authed(cashierA2Token)).send({ actualCash: 0 });
    expect(closeTarget.status).toBe(409);
    expect(closeTarget.body.code).toBe("OPEN_ORDERS_ON_SHIFT");

    // نقفل الطلب فعليًا (Void مش مطلوب هنا - نغيّر حالته مباشرة عشان ننضّف الاختبار) ونقفل شيفته
    await pool.query("UPDATE orders SET status = 'completed' WHERE id = $1", [orderId]);
    const closeTarget2 = await request(app).post(`/api/shifts/${target}/close`).set(authed(cashierA2Token)).send({ actualCash: 0 });
    expect(closeTarget2.status).toBe(200);
  });

  test("مدير الفرع (shifts.review) يقدر يسلّم طلب مش بتاع شيفته هو", async () => {
    const openC = await request(app).post("/api/shifts/open").set(authed(cashierAToken)).send({ openingCash: 0 });
    const order = await makeDeliveryOrder(cashierAToken);
    const openD = await request(app).post("/api/shifts/open").set(authed(cashierA2Token)).send({ openingCash: 0 });

    const res = await request(app).patch(`/api/orders/${order.body.orderId}/shift`).set(authed(managerAToken)).send({ shiftId: openD.body.id });
    expect(res.status).toBe(200);

    await pool.query("UPDATE orders SET status = 'completed' WHERE id = $1", [order.body.orderId]);
    await request(app).post(`/api/shifts/${openC.body.id}/close`).set(authed(cashierAToken)).send({ actualCash: 0 });
    await request(app).post(`/api/shifts/${openD.body.id}/close`).set(authed(cashierA2Token)).send({ actualCash: 0 });
  });
});
