// المرحلة 7G: شاشة المطبخ (KDS) - ضد Postgres حقيقي. بيغطي: kitchen_status الافتراضي وقت الإنشاء،
// التتابع الصارم (مفيش تخطي أو رجوع)، الصلاحيات وعزل الفروع، التزامن الحقيقي على نفس الطلب، سجل
// order_status_log، واستعلام اللوحة (أصناف+مرفقات، استبعاد الملغي، نافذة الـ30 دقيقة لـREADY).
const { app, request, pool, seedUser, login, authed } = require("./helpers");

let branchA, branchB;
let managerAToken, managerBToken, adminToken, cashierAToken, cashierBToken, callcenterToken, driverToken;
let itemId, variantId, modifierId;

beforeAll(async () => {
  const bA = await pool.query("INSERT INTO branches (name) VALUES ('فرع كدس-A-جست') RETURNING id");
  branchA = bA.rows[0].id;
  const bB = await pool.query("INSERT INTO branches (name) VALUES ('فرع كدس-B-جست') RETURNING id");
  branchB = bB.rows[0].id;

  await seedUser({ branchId: branchA, name: "مدير-كدس-A", email: "managerA-kds@jest.test", role: "branch_manager" });
  await seedUser({ branchId: branchA, name: "كاشير-كدس-A", email: "cashierA-kds@jest.test", role: "cashier" });
  await seedUser({ branchId: branchB, name: "كاشير-كدس-B", email: "cashierB-kds@jest.test", role: "cashier" });
  await seedUser({ branchId: branchB, name: "مدير-كدس-B", email: "managerB-kds@jest.test", role: "branch_manager" });
  await seedUser({ name: "أدمن-كدس", email: "admin-kds@jest.test", role: "admin" });
  await seedUser({ branchId: branchA, name: "كول سنتر-كدس", email: "callcenter-kds@jest.test", role: "callcenter" });
  const driverUserId = await seedUser({ branchId: branchA, name: "سائق-كدس", email: "driver-kds@jest.test", role: "driver" });
  await pool.query("INSERT INTO drivers (user_id, branch_id, driver_code, name) VALUES ($1,$2,'DRV-KDS-JEST',$3)", [driverUserId, branchA, "سائق-كدس"]);

  managerAToken = await login("managerA-kds@jest.test");
  cashierAToken = await login("cashierA-kds@jest.test");
  cashierBToken = await login("cashierB-kds@jest.test");
  managerBToken = await login("managerB-kds@jest.test");
  adminToken = await login("admin-kds@jest.test");
  callcenterToken = await login("callcenter-kds@jest.test");
  driverToken = await login("driver-kds@jest.test");

  const cat = await pool.query("INSERT INTO menu_categories (name) VALUES ('كدس-جست-قسم') RETURNING id");
  const mi = await pool.query("INSERT INTO menu_items (category_id, name) VALUES ($1,'صنف-كدس-جست') RETURNING id", [cat.rows[0].id]);
  itemId = mi.rows[0].id;
  const v = await pool.query("INSERT INTO menu_item_variants (item_id, label, price) VALUES ($1,'عادي',100) RETURNING id", [itemId]);
  variantId = v.rows[0].id;
  const mod = await pool.query("INSERT INTO menu_item_modifiers (item_id, name, price_delta) VALUES ($1,'إضافة جبنة-جست',10) RETURNING id", [itemId]);
  modifierId = mod.rows[0].id;
});

afterAll(async () => {
  await pool.end();
});

async function makeOrder(token, branchId, orderType = "takeaway", withModifier = false) {
  const items = [{ itemId, variantId, quantity: 1, modifiers: withModifier ? [{ id: modifierId }] : [] }];
  const res = await request(app).post("/api/orders").set(authed(token)).send({
    branchId, source: "pos", orderType,
    tableNumber: orderType === "dinein" ? "T-جست-1" : undefined,
    customerPhone: `019${Date.now()}`.slice(0, 11),
    items,
  });
  expect(res.status).toBe(201);
  return res.body.orderId;
}

async function getOrder(token, orderId) {
  const res = await request(app).get(`/api/orders/${orderId}`).set(authed(token));
  return res;
}

describe("kitchen_status الافتراضي وقت الإنشاء", () => {
  test("طلب تيك أواي بيتسجل بحالة مطبخ NEW", async () => {
    const orderId = await makeOrder(cashierAToken, branchA, "takeaway");
    const res = await getOrder(cashierAToken, orderId);
    expect(res.body.kitchen_status).toBe("NEW");
    expect(res.body.kitchen_accepted_at).toBeNull();
    expect(res.body.kitchen_ready_at).toBeNull();
  });

  test("طلب صالة بيتسجل بحالة مطبخ NEW برضه", async () => {
    const orderId = await makeOrder(cashierAToken, branchA, "dinein");
    const res = await getOrder(cashierAToken, orderId);
    expect(res.body.kitchen_status).toBe("NEW");
  });

  test("طلب دليفري بيتسجل بحالة مطبخ NEW برضه (مستقلة عن dispatch_status)", async () => {
    const orderId = await makeOrder(cashierAToken, branchA, "delivery");
    const res = await getOrder(cashierAToken, orderId);
    expect(res.body.kitchen_status).toBe("NEW");
    expect(res.body.dispatch_status).toBe("UNASSIGNED");
  });
});

describe("تتابع حالة المطبخ - صارم بس (مفيش تخطي أو رجوع)", () => {
  test("NEW -> ACCEPTED -> PREPARING -> READY بالترتيب تمام", async () => {
    const orderId = await makeOrder(cashierAToken, branchA);
    let res = await request(app).patch(`/api/orders/${orderId}/kitchen-status`).set(authed(cashierAToken)).send({ status: "ACCEPTED" });
    expect(res.status).toBe(200);
    expect(res.body.kitchen_status).toBe("ACCEPTED");
    expect(res.body.kitchen_accepted_at).not.toBeNull();

    res = await request(app).patch(`/api/orders/${orderId}/kitchen-status`).set(authed(cashierAToken)).send({ status: "PREPARING" });
    expect(res.status).toBe(200);
    expect(res.body.kitchen_status).toBe("PREPARING");

    res = await request(app).patch(`/api/orders/${orderId}/kitchen-status`).set(authed(cashierAToken)).send({ status: "READY" });
    expect(res.status).toBe(200);
    expect(res.body.kitchen_status).toBe("READY");
    expect(res.body.kitchen_ready_at).not.toBeNull();
  });

  test("تخطي مرحلة (NEW -> PREPARING مباشرة) مرفوض", async () => {
    const orderId = await makeOrder(cashierAToken, branchA);
    const res = await request(app).patch(`/api/orders/${orderId}/kitchen-status`).set(authed(cashierAToken)).send({ status: "PREPARING" });
    expect(res.status).toBe(400);
  });

  test("الرجوع لحالة سابقة (ACCEPTED -> NEW) مرفوض ومرفوض الإرسال كقيمة أصلًا", async () => {
    const orderId = await makeOrder(cashierAToken, branchA);
    await request(app).patch(`/api/orders/${orderId}/kitchen-status`).set(authed(cashierAToken)).send({ status: "ACCEPTED" });
    const res = await request(app).patch(`/api/orders/${orderId}/kitchen-status`).set(authed(cashierAToken)).send({ status: "NEW" });
    expect(res.status).toBe(400);
  });

  test("إعادة إرسال نفس الحالة الحالية (ACCEPTED -> ACCEPTED) مرفوضة", async () => {
    const orderId = await makeOrder(cashierAToken, branchA);
    await request(app).patch(`/api/orders/${orderId}/kitchen-status`).set(authed(cashierAToken)).send({ status: "ACCEPTED" });
    const res = await request(app).patch(`/api/orders/${orderId}/kitchen-status`).set(authed(cashierAToken)).send({ status: "ACCEPTED" });
    expect(res.status).toBe(400);
  });

  test("حالة مطبخ غير معروفة مرفوضة", async () => {
    const orderId = await makeOrder(cashierAToken, branchA);
    const res = await request(app).patch(`/api/orders/${orderId}/kitchen-status`).set(authed(cashierAToken)).send({ status: "DONE" });
    expect(res.status).toBe(400);
  });

  test("طلب ملغي مينفعش تتغير حالة تحضيره", async () => {
    // طلبات التيك أواي/الصالة بتتسجل status='completed' من لحظة الإنشاء (مدفوعة على طول في الكاشير) -
    // ده terminal بالفعل فمينفعش تتحول لـ'cancelled' عن طريق /status العادي. طلب الدليفري بس بيتسجل
    // 'preparing' الأول (لسه معلّق لحد ما يتسلّم)، فده اللي يقدر يتلغي مباشرة ونختبر بيه الحماية دي
    const orderId = await makeOrder(cashierAToken, branchA, "delivery");
    const cancelRes = await request(app).patch(`/api/orders/${orderId}/status`).set(authed(cashierAToken)).send({ status: "cancelled" });
    expect(cancelRes.status).toBe(200);
    const res = await request(app).patch(`/api/orders/${orderId}/kitchen-status`).set(authed(cashierAToken)).send({ status: "ACCEPTED" });
    expect(res.status).toBe(400);
  });
});

describe("سجل order_status_log لتقدّم المطبخ", () => {
  test("كل انتقال بيتسجل بـstatus مميز وnotes صحيحة", async () => {
    const orderId = await makeOrder(cashierAToken, branchA);
    await request(app).patch(`/api/orders/${orderId}/kitchen-status`).set(authed(cashierAToken)).send({ status: "ACCEPTED" });
    await request(app).patch(`/api/orders/${orderId}/kitchen-status`).set(authed(cashierAToken)).send({ status: "PREPARING" });
    const res = await getOrder(cashierAToken, orderId);
    const kitchenLogs = res.body.statusLog.filter(l => l.status.startsWith("kitchen_"));
    expect(kitchenLogs.map(l => l.status)).toEqual(["kitchen_accepted", "kitchen_preparing"]);
    expect(kitchenLogs[0].notes).toBe("المطبخ قبل الطلب");
    expect(kitchenLogs[1].notes).toBe("بدأ التحضير");
  });
});

describe("الصلاحيات وعزل الفروع", () => {
  test("الكول سنتر معندهوش صلاحية kitchen.advance", async () => {
    const orderId = await makeOrder(cashierAToken, branchA);
    const res = await request(app).patch(`/api/orders/${orderId}/kitchen-status`).set(authed(callcenterToken)).send({ status: "ACCEPTED" });
    expect(res.status).toBe(403);
  });

  test("السائق معندهوش صلاحية kitchen.advance", async () => {
    const orderId = await makeOrder(cashierAToken, branchA);
    const res = await request(app).patch(`/api/orders/${orderId}/kitchen-status`).set(authed(driverToken)).send({ status: "ACCEPTED" });
    expect(res.status).toBe(403);
  });

  test("مدير فرع يقدر يقدّم حالة مطبخ طلب فرعه", async () => {
    const orderId = await makeOrder(cashierAToken, branchA);
    const res = await request(app).patch(`/api/orders/${orderId}/kitchen-status`).set(authed(managerAToken)).send({ status: "ACCEPTED" });
    expect(res.status).toBe(200);
  });

  test("كاشير فرع B مينفعش يقدّم حالة طلب فرع A", async () => {
    const orderId = await makeOrder(cashierAToken, branchA);
    const res = await request(app).patch(`/api/orders/${orderId}/kitchen-status`).set(authed(cashierBToken)).send({ status: "ACCEPTED" });
    expect(res.status).toBe(403);
  });

  test("الأدمن يقدر يقدّم حالة أي طلب في أي فرع", async () => {
    const orderId = await makeOrder(cashierAToken, branchA);
    const res = await request(app).patch(`/api/orders/${orderId}/kitchen-status`).set(authed(adminToken)).send({ status: "ACCEPTED" });
    expect(res.status).toBe(200);
  });

  test("كاشير فرع B مينفعش يشوف لوحة مطبخ فرع A", async () => {
    const res = await request(app).get(`/api/kds/orders?branchId=${branchA}`).set(authed(cashierBToken));
    expect(res.status).toBe(403);
  });

  test("لازم تحديد فرع للوحة المطبخ", async () => {
    const res = await request(app).get("/api/kds/orders").set(authed(adminToken));
    expect(res.status).toBe(400);
  });
});

describe("تزامن حقيقي - نفس الطلب من طلبين متوازيين", () => {
  test("طلبين PATCH متوازيين لنفس الانتقال - واحد بس ينجح", async () => {
    const orderId = await makeOrder(cashierAToken, branchA);
    const [r1, r2] = await Promise.all([
      request(app).patch(`/api/orders/${orderId}/kitchen-status`).set(authed(cashierAToken)).send({ status: "ACCEPTED" }),
      request(app).patch(`/api/orders/${orderId}/kitchen-status`).set(authed(managerAToken)).send({ status: "ACCEPTED" }),
    ]);
    const statuses = [r1.status, r2.status].sort();
    expect(statuses).toEqual([200, 400]);

    const res = await getOrder(cashierAToken, orderId);
    const kitchenLogs = res.body.statusLog.filter(l => l.status === "kitchen_accepted");
    expect(kitchenLogs.length).toBe(1);
  });
});

describe("استعلام لوحة المطبخ (GET /api/kds/orders)", () => {
  test("بترجّع الأصناف والمرفقات صح من غير N+1", async () => {
    const orderId = await makeOrder(cashierAToken, branchA, "takeaway", true);
    const res = await request(app).get(`/api/kds/orders?branchId=${branchA}`).set(authed(cashierAToken));
    expect(res.status).toBe(200);
    const card = res.body.find(o => o.id === orderId);
    expect(card).toBeTruthy();
    expect(card.items.length).toBe(1);
    expect(card.items[0].modifiers).toEqual(["إضافة جبنة-جست"]);
    expect(card.kitchen_status).toBe("NEW");
  });

  test("الطلب الملغي مش ظاهر في اللوحة", async () => {
    // طلب دليفري عشان يبدأ status='preparing' (قابل للإلغاء المباشر) - راجع تعليق الاختبار المماثل فوق
    const orderId = await makeOrder(cashierAToken, branchA, "delivery");
    const cancelRes = await request(app).patch(`/api/orders/${orderId}/status`).set(authed(cashierAToken)).send({ status: "cancelled" });
    expect(cancelRes.status).toBe(200);
    const res = await request(app).get(`/api/kds/orders?branchId=${branchA}`).set(authed(cashierAToken));
    expect(res.body.find(o => o.id === orderId)).toBeUndefined();
  });

  test("طلب جاهز (READY) لسه ظاهر في نافذة الـ30 دقيقة", async () => {
    const orderId = await makeOrder(cashierAToken, branchA);
    await request(app).patch(`/api/orders/${orderId}/kitchen-status`).set(authed(cashierAToken)).send({ status: "ACCEPTED" });
    await request(app).patch(`/api/orders/${orderId}/kitchen-status`).set(authed(cashierAToken)).send({ status: "PREPARING" });
    await request(app).patch(`/api/orders/${orderId}/kitchen-status`).set(authed(cashierAToken)).send({ status: "READY" });
    const res = await request(app).get(`/api/kds/orders?branchId=${branchA}`).set(authed(cashierAToken));
    expect(res.body.find(o => o.id === orderId)).toBeTruthy();
  });

  test("طلب جاهز من أكتر من 30 دقيقة مختفي من اللوحة", async () => {
    const orderId = await makeOrder(cashierAToken, branchA);
    await request(app).patch(`/api/orders/${orderId}/kitchen-status`).set(authed(cashierAToken)).send({ status: "ACCEPTED" });
    await request(app).patch(`/api/orders/${orderId}/kitchen-status`).set(authed(cashierAToken)).send({ status: "PREPARING" });
    await request(app).patch(`/api/orders/${orderId}/kitchen-status`).set(authed(cashierAToken)).send({ status: "READY" });
    await pool.query("UPDATE orders SET kitchen_ready_at = now() - interval '31 minutes' WHERE id = $1", [orderId]);
    const res = await request(app).get(`/api/kds/orders?branchId=${branchA}`).set(authed(cashierAToken));
    expect(res.body.find(o => o.id === orderId)).toBeUndefined();
  });

  test("طلبات NEW/ACCEPTED/PREPARING ظاهرة مهما قدم وقتها (مفيش نافذة زمنية غير READY)", async () => {
    const orderId = await makeOrder(cashierAToken, branchA);
    await pool.query("UPDATE orders SET created_at = now() - interval '3 hours' WHERE id = $1", [orderId]);
    const res = await request(app).get(`/api/kds/orders?branchId=${branchA}`).set(authed(cashierAToken));
    expect(res.body.find(o => o.id === orderId)).toBeTruthy();
  });
});
