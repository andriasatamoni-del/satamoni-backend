// المرحلة 8.46: تحصيل مجمّع من الطيار للكاشير + بونص توصيل تلقائي (5 جنيه لخدمة توصيل أقل من 40 جنيه،
// 10 جنيه لو 40 جنيه أو أكتر). بيغطي: حد الـ40 بالظبط (39.99/40/40.01)، ترحيل البونص فعليًا كـ
// payroll_adjustments لو السائق له employee_id مرتبط، تخطّيه بأمان (بدون ما يمنع التحصيل) لو مفيش،
// GET /pending-drivers، وإن الكاشير يقدر يبدأ تسوية بس معندوش صلاحية يراجع فرق تسليم.
const { app, request, pool, seedUser, login, authed } = require("./helpers");

let branchA;
let managerAToken, cashierAToken;
let cashPmId, itemId, variantId;

beforeAll(async () => {
  const b = await pool.query("INSERT INTO branches (name) VALUES ('فرع بونص-توصيل-جست') RETURNING id");
  branchA = b.rows[0].id;

  await seedUser({ branchId: branchA, name: "مدير-بونص-توصيل", email: "managerA-bonus@jest.test", role: "branch_manager" });
  await seedUser({ branchId: branchA, name: "كاشير-بونص-توصيل", email: "cashierA-bonus@jest.test", role: "cashier" });
  managerAToken = await login("managerA-bonus@jest.test");
  cashierAToken = await login("cashierA-bonus@jest.test");

  const pm = await pool.query("INSERT INTO payment_methods (name, kind) VALUES ('كاش-بونص-توصيل-جست', 'cash') RETURNING id");
  cashPmId = pm.rows[0].id;
  const cat = await pool.query("INSERT INTO menu_categories (name) VALUES ('بونص-توصيل-جست-قسم') RETURNING id");
  const mi = await pool.query("INSERT INTO menu_items (category_id, name) VALUES ($1,'صنف-بونص-توصيل-جست') RETURNING id", [cat.rows[0].id]);
  itemId = mi.rows[0].id;
  const v = await pool.query("INSERT INTO menu_item_variants (item_id, label, price) VALUES ($1,'عادي',200) RETURNING id", [itemId]);
  variantId = v.rows[0].id;
});

afterAll(async () => {
  await pool.end();
});

async function makeDriver({ withEmployee }) {
  const userId = await seedUser({
    branchId: branchA, name: `سائق-بونص-${Date.now()}-${Math.random()}`, role: "driver",
    email: `driver-bonus-${Date.now()}-${Math.random()}@jest.test`,
  });
  let employeeId = null;
  if (withEmployee) {
    const emp = await pool.query(
      "INSERT INTO employees (name, department, attendance_system, base_salary, restricted_branch_id, user_id) VALUES ('سائق-بونص-موظف','توصيل','manual',2000,$1,$2) RETURNING id",
      [branchA, userId]
    );
    employeeId = emp.rows[0].id;
  }
  const d = await pool.query(
    "INSERT INTO drivers (user_id, branch_id, driver_code, name, employee_id) VALUES ($1,$2,$3,'سائق-بونص-جست',$4) RETURNING id",
    [userId, branchA, `DRV-BONUS-${Date.now()}-${Math.random()}`, employeeId]
  );
  return { driverId: d.rows[0].id, employeeId };
}

async function makeDeliveredCashOrder(driverId, deliveryFee) {
  const order = await request(app).post("/api/orders").set(authed(managerAToken)).send({
    branchId: branchA, source: "pos", orderType: "delivery", customerPhone: `019${Date.now()}${Math.floor(Math.random() * 1000)}`.slice(0, 11),
    addressDetails: "شارع بونص التوصيل", paymentMethodId: cashPmId,
    items: [{ itemId, variantId, quantity: 1 }],
  });
  const orderId = order.body.orderId;
  await pool.query("UPDATE orders SET delivery_fee = $1 WHERE id = $2", [deliveryFee, orderId]);
  await pool.query(
    `UPDATE orders SET driver_id = $1, dispatch_status = 'ASSIGNED', assigned_at = now() WHERE id = $2`,
    [driverId, orderId]
  );
  const total = Number(order.body.total);
  // تسليم مباشر عن طريق تحديث الصف - نفس أثر markDelivered بالظبط بس من غير المرور بكل حالات dispatch
  // الوسيطة (مش موضوع الاختبار ده، اللي مركّز على البونص/التسوية بعد التسليم)
  await pool.query(
    `UPDATE orders SET status = 'completed', dispatch_status = 'DELIVERED', delivered_at = now(),
       payment_status = 'collected', collected_amount = $1, collection_variance = 0 WHERE id = $2`,
    [total, orderId]
  );
  return { orderId, total, deliveryFee };
}

describe("بونص التوصيل التلقائي - حد الـ40 جنيه بالظبط", () => {
  test("39.99 -> 5 جنيه بونص، 40 بالظبط -> 10 جنيه، 40.01 -> 10 جنيه (عبر preview)", async () => {
    const { driverId } = await makeDriver({ withEmployee: false });
    const o1 = await makeDeliveredCashOrder(driverId, 39.99);
    const o2 = await makeDeliveredCashOrder(driverId, 40);
    const o3 = await makeDeliveredCashOrder(driverId, 40.01);

    const preview = await request(app).get(`/api/driver-settlements/preview?driverId=${driverId}`).set(authed(managerAToken));
    expect(preview.status).toBe(200);
    const byId = Object.fromEntries(preview.body.orders.map((o) => [o.id, o]));
    expect(byId[o1.orderId].bonus).toBe(5);
    expect(byId[o2.orderId].bonus).toBe(10);
    expect(byId[o3.orderId].bonus).toBe(10);
    expect(preview.body.bonusTotal).toBe(25);
  });
});

describe("ترحيل البونص فعليًا في الرواتب - سائق له ملف موظف مرتبط", () => {
  test("تحصيل مجمّع من الكاشير: التسوية بتاخد bonus_total صح وبتترحّل payroll_adjustments نوع bonus", async () => {
    const { driverId, employeeId } = await makeDriver({ withEmployee: true });
    await makeDeliveredCashOrder(driverId, 25); // بونص 5
    await makeDeliveredCashOrder(driverId, 60); // بونص 10

    const preview = await request(app).get(`/api/driver-settlements/preview?driverId=${driverId}`).set(authed(cashierAToken));
    expect(preview.status).toBe(200);
    expect(preview.body.orderCount).toBe(2);
    expect(preview.body.bonusTotal).toBe(15);

    const settle = await request(app).post("/api/driver-settlements").set(authed(cashierAToken)).send({
      driverId, actualHandover: preview.body.expectedHandover,
    });
    expect(settle.status).toBe(201);
    expect(Number(settle.body.bonus_total)).toBe(15);
    expect(settle.body.bonus_payroll_adjustment_id).toBeTruthy();

    const adjustment = await pool.query("SELECT * FROM payroll_adjustments WHERE id = $1", [settle.body.bonus_payroll_adjustment_id]);
    expect(adjustment.rows.length).toBe(1);
    expect(adjustment.rows[0].employee_id).toBe(employeeId);
    expect(adjustment.rows[0].adjustment_type).toBe("bonus");
    expect(Number(adjustment.rows[0].amount)).toBe(15);

    // GET /:id بيرجّع بونص كل طلب على حدة برضو
    const detail = await request(app).get(`/api/driver-settlements/${settle.body.id}`).set(authed(managerAToken));
    expect(detail.status).toBe(200);
    const bonuses = detail.body.orders.map((o) => Number(o.bonus)).sort((a, b) => a - b);
    expect(bonuses).toEqual([5, 10]);
  });
});

describe("سائق من غير ملف موظف مرتبط - البونص بيتحسب بس مبيترحّلش في الرواتب", () => {
  test("bonus_total محسوب صح، bonus_payroll_adjustment_id فاضي، ومفيش صف payroll_adjustments اتسجل", async () => {
    const { driverId } = await makeDriver({ withEmployee: false });
    await makeDeliveredCashOrder(driverId, 60); // بونص 10

    const settle = await request(app).post("/api/driver-settlements").set(authed(cashierAToken)).send({
      driverId, actualHandover: 260,
    });
    expect(settle.status).toBe(201);
    expect(Number(settle.body.bonus_total)).toBe(10);
    expect(settle.body.bonus_payroll_adjustment_id).toBeNull();

    const adjustments = await pool.query(
      "SELECT * FROM payroll_adjustments WHERE notes LIKE $1", [`%تسوية سائق #${settle.body.id}%`]
    );
    expect(adjustments.rows.length).toBe(0);

    const audit = await pool.query(
      "SELECT * FROM audit_logs WHERE action = 'DRIVER_BONUS_SKIPPED_NO_EMPLOYEE' AND entity_id = $1", [settle.body.id]
    );
    expect(audit.rows.length).toBe(1);
  });
});

describe("GET /api/driver-settlements/pending-drivers", () => {
  test("بيرجّع بس السائقين اللي عندهم كاش معلّق فعليًا، وبيختفي السائق بعد التسوية", async () => {
    const { driverId } = await makeDriver({ withEmployee: false });
    await makeDeliveredCashOrder(driverId, 20);

    const before = await request(app).get(`/api/driver-settlements/pending-drivers?branchId=${branchA}`).set(authed(cashierAToken));
    expect(before.status).toBe(200);
    const found = before.body.find((d) => d.id === driverId);
    expect(found).toBeTruthy();
    expect(found.pending_order_count).toBe(1);

    await request(app).post("/api/driver-settlements").set(authed(cashierAToken)).send({ driverId, actualHandover: 220 });

    const after = await request(app).get(`/api/driver-settlements/pending-drivers?branchId=${branchA}`).set(authed(cashierAToken));
    expect(after.body.find((d) => d.id === driverId)).toBeUndefined();
  });
});

describe("صلاحيات الكاشير: يقدر يبدأ تحصيل مجمّع بس مش يراجع فرق تسليم", () => {
  test("الكاشير يقدر ينشئ تسوية (driver_settlements.create)", async () => {
    const { driverId } = await makeDriver({ withEmployee: false });
    await makeDeliveredCashOrder(driverId, 20);
    const res = await request(app).post("/api/driver-settlements").set(authed(cashierAToken)).send({ driverId, actualHandover: 220 });
    expect(res.status).toBe(201);
  });

  test("الكاشير معندوش صلاحية يراجع فرق تسليم (driver_settlements.review) - 403", async () => {
    const { driverId } = await makeDriver({ withEmployee: false });
    await makeDeliveredCashOrder(driverId, 20);
    const settle = await request(app).post("/api/driver-settlements").set(authed(cashierAToken)).send({ driverId, actualHandover: 0 });
    expect(settle.status).toBe(201);
    expect(settle.body.variance_status).toBe("PENDING_REVIEW");

    const review = await request(app).post(`/api/driver-settlements/${settle.body.id}/review`).set(authed(cashierAToken)).send({ decision: "acknowledge" });
    expect(review.status).toBe(403);
  });
});
