// المرحلة 8.48: حضور وأجر السائقين بالساعة - تسجيل دخول/خروج يدوي، الأجر = ساعات العمل × السعر
// بالساعة (مجمّد من pos_settings.driver_hourly_rate_egp وقت الدخول) + بونص كل الأوردرات اللي اتسلّمت
// أثناء نافذة الشيفت ده بالظبط - بيتسجل تلقائي كمصروف يومي (SUBMITTED، بند "أجور عمالة خارجية
// (سائقين)"، كاش) بدل ما الكاشير يحسبه يدوي. بيغطي: حساب الساعات/الأجر، البونص بيشمل بس أوردرات نافذة
// الشيفت (مش قبله ولا بعده)، إنشاء المصروف صح وربطه بدرج الكاشير نفسه (نفس إصلاح 8.45b)، شيفت واحد
// نشط بالسائق في المرة الواحدة، الصلاحيات، وعزل الفروع.
const { app, request, pool, seedUser, login, authed } = require("./helpers");

let branchA, branchB;
let managerAToken, cashierAToken, managerBToken;
let driverId;
let cashPmId, itemId, variantId;

beforeAll(async () => {
  const bA = await pool.query("INSERT INTO branches (name) VALUES ('فرع حضور-سائقين-جست') RETURNING id");
  branchA = bA.rows[0].id;
  const bB = await pool.query("INSERT INTO branches (name) VALUES ('فرع حضور-سائقين-جست-B') RETURNING id");
  branchB = bB.rows[0].id;

  await seedUser({ branchId: branchA, name: "مدير-حضور-سائقين", email: "managerA-drivershift@jest.test", role: "branch_manager" });
  await seedUser({ branchId: branchA, name: "كاشير-حضور-سائقين", email: "cashierA-drivershift@jest.test", role: "cashier" });
  await seedUser({ branchId: branchB, name: "مدير-حضور-سائقين-B", email: "managerB-drivershift@jest.test", role: "branch_manager" });
  managerAToken = await login("managerA-drivershift@jest.test");
  cashierAToken = await login("cashierA-drivershift@jest.test");
  managerBToken = await login("managerB-drivershift@jest.test");

  const driverUserId = await seedUser({ branchId: branchA, name: "سائق-حضور-سائقين", email: "driver-drivershift@jest.test", role: "driver" });
  const d = await pool.query(
    "INSERT INTO drivers (user_id, branch_id, driver_code, name) VALUES ($1,$2,'DRV-SHIFT-JEST',$3) RETURNING id",
    [driverUserId, branchA, "سائق-حضور-سائقين"]
  );
  driverId = d.rows[0].id;

  const pm = await pool.query("INSERT INTO payment_methods (name, kind) VALUES ('كاش-حضور-سائقين-جست', 'cash') RETURNING id");
  cashPmId = pm.rows[0].id;
  const cat = await pool.query("INSERT INTO menu_categories (name) VALUES ('حضور-سائقين-جست-قسم') RETURNING id");
  const mi = await pool.query("INSERT INTO menu_items (category_id, name) VALUES ($1,'صنف-حضور-سائقين-جست') RETURNING id", [cat.rows[0].id]);
  itemId = mi.rows[0].id;
  const v = await pool.query("INSERT INTO menu_item_variants (item_id, label, price) VALUES ($1,'عادي',150) RETURNING id", [itemId]);
  variantId = v.rows[0].id;
});

afterAll(async () => {
  await pool.end();
});

async function makeDeliveredOrder(deliveryFee, deliveredAt) {
  const order = await request(app).post("/api/orders").set(authed(managerAToken)).send({
    branchId: branchA, source: "pos", orderType: "delivery",
    customerPhone: `016${Date.now()}${Math.floor(Math.random() * 1000)}`.slice(0, 11),
    addressDetails: "شارع حضور سائقين", paymentMethodId: cashPmId,
    items: [{ itemId, variantId, quantity: 1 }],
  });
  const orderId = order.body.orderId;
  const total = Number(order.body.total);
  await pool.query("UPDATE orders SET delivery_fee = $1, driver_id = $2, dispatch_status = 'ASSIGNED' WHERE id = $3", [deliveryFee, driverId, orderId]);
  await pool.query(
    `UPDATE orders SET status='completed', dispatch_status='DELIVERED', delivered_at=$1,
       payment_status='collected', collected_amount=$2, collection_variance=0 WHERE id=$3`,
    [deliveredAt, total, orderId]
  );
  return orderId;
}

describe("تسجيل دخول/خروج سائق - الأجر والبونص", () => {
  test("تسجيل الدخول بيجمّد hourly_rate من pos_settings وبيرفض تسجيل دخول تاني لنفس السائق", async () => {
    const settings = await pool.query("SELECT driver_hourly_rate_egp FROM pos_settings WHERE id = 1");
    const rate = Number(settings.rows[0].driver_hourly_rate_egp);

    const checkIn = await request(app).post("/api/driver-shifts/check-in").set(authed(cashierAToken)).send({ driverId });
    expect(checkIn.status).toBe(201);
    expect(checkIn.body.status).toBe("ACTIVE");
    expect(Number(checkIn.body.hourly_rate)).toBe(rate);

    const dup = await request(app).post("/api/driver-shifts/check-in").set(authed(cashierAToken)).send({ driverId });
    expect(dup.status).toBe(409);
    expect(dup.body.error).toContain("شغالة بالفعل");

    const active = await request(app).get(`/api/driver-shifts/active?branchId=${branchA}`).set(authed(managerAToken));
    expect(active.status).toBe(200);
    expect(active.body.find((s) => s.id === checkIn.body.id)).toBeTruthy();

    // تنظيف - تسجيل خروج عشان الاختبارات التانية تقدر تفتح شيفت جديد لنفس السائق
    await request(app).post(`/api/driver-shifts/${checkIn.body.id}/check-out`).set(authed(cashierAToken)).send({});
  });

  test("الأجر = ساعات العمل × السعر بالساعة + بونص أوردرات نافذة الشيفت بس (مش قبله ولا بعده)", async () => {
    const checkIn = await request(app).post("/api/driver-shifts/check-in").set(authed(cashierAToken)).send({ driverId });
    const shiftId = checkIn.body.id;
    const rate = Number(checkIn.body.hourly_rate);

    // نرجّع وقت الدخول 5 ساعات عشان نضمن ساعات عمل ثابتة للاختبار (بدل ما نستنى فعليًا)
    const checkedInAt = new Date(Date.now() - 5 * 3600000);
    await pool.query("UPDATE driver_shifts SET checked_in_at = $1 WHERE id = $2", [checkedInAt, shiftId]);

    // أوردر قبل تسجيل الدخول (اتسلّم قبل بداية نافذة الشيفت بساعة) - مايتحسبش في بونص الشيفت ده
    await makeDeliveredOrder(20, new Date(checkedInAt.getTime() - 3600000)); // بونص 5 - برّه النافذة

    // أوردرين جوه نافذة الشيفت - بونص 5 + 10 = 15
    await makeDeliveredOrder(30, new Date(Date.now() - 3 * 3600000)); // بونص 5
    await makeDeliveredOrder(60, new Date(Date.now() - 1 * 3600000)); // بونص 10

    const checkOut = await request(app).post(`/api/driver-shifts/${shiftId}/check-out`).set(authed(cashierAToken)).send({});
    expect(checkOut.status).toBe(200);
    expect(checkOut.body.status).toBe("CLOSED");
    expect(Number(checkOut.body.hours_worked)).toBeCloseTo(5, 1);
    expect(Number(checkOut.body.wage_amount)).toBeCloseTo(5 * rate, 1);
    expect(Number(checkOut.body.bonus_total)).toBe(15);
    expect(Number(checkOut.body.total_pay)).toBeCloseTo(5 * rate + 15, 1);
    expect(checkOut.body.expense_id).toBeTruthy();
    expect(checkOut.body.driver_name).toBe("سائق-حضور-سائقين");

    // المصروف اتسجل صح - SUBMITTED، البند الصحيح، المبلغ الصحيح، كاش
    const expense = await pool.query(
      `SELECT e.*, ec.name AS category_name, pm.kind AS payment_kind FROM expenses e
       JOIN expense_categories ec ON ec.id = e.category_id
       JOIN payment_methods pm ON pm.id = e.payment_method_id
       WHERE e.id = $1`,
      [checkOut.body.expense_id]
    );
    expect(expense.rows.length).toBe(1);
    expect(expense.rows[0].status).toBe("SUBMITTED");
    expect(expense.rows[0].category_name).toBe("أجور عمالة خارجية (سائقين)");
    expect(expense.rows[0].payment_kind).toBe("cash");
    expect(Number(expense.rows[0].amount)).toBeCloseTo(5 * rate + 15, 1);
  });

  test("مراجعة المصروف بعد كده بيروح لدرج الكاشير نفسه مش خزينة الفرع الرئيسية (نفس إصلاح 8.45b)", async () => {
    const checkIn = await request(app).post("/api/driver-shifts/check-in").set(authed(cashierAToken)).send({ driverId });
    const shiftId = checkIn.body.id;
    await pool.query("UPDATE driver_shifts SET checked_in_at = $1 WHERE id = $2", [new Date(Date.now() - 3600000), shiftId]);
    const checkOut = await request(app).post(`/api/driver-shifts/${shiftId}/check-out`).set(authed(cashierAToken)).send({});
    expect(checkOut.status).toBe(200);

    const reviewed = await request(app).post(`/api/expenses/${checkOut.body.expense_id}/review`).set(authed(managerAToken));
    expect(reviewed.status).toBe(200);
    expect(reviewed.body.status).toBe("POSTED");

    const je = await pool.query("SELECT * FROM journal_entries WHERE source_type = 'expense' AND source_id = $1", [checkOut.body.expense_id]);
    expect(je.rows.length).toBe(1);
    const lines = await pool.query("SELECT * FROM journal_entry_lines WHERE journal_entry_id = $1", [je.rows[0].id]);
    const creditLine = lines.rows.find((l) => Number(l.credit) > 0);
    const cashierUserId = (await pool.query("SELECT id FROM users WHERE email = 'cashierA-drivershift@jest.test'")).rows[0].id;
    const cashierAccount = await pool.query("SELECT id FROM accounts WHERE code = $1", [`1100-${branchA}-${cashierUserId}`]);
    expect(creditLine.account_id).toBe(cashierAccount.rows[0].id);
  });

  test("مينفعش تسجّل خروج لشيفت مقفول بالفعل", async () => {
    const checkIn = await request(app).post("/api/driver-shifts/check-in").set(authed(cashierAToken)).send({ driverId });
    const shiftId = checkIn.body.id;
    const first = await request(app).post(`/api/driver-shifts/${shiftId}/check-out`).set(authed(cashierAToken)).send({});
    expect(first.status).toBe(200);
    const second = await request(app).post(`/api/driver-shifts/${shiftId}/check-out`).set(authed(cashierAToken)).send({});
    expect(second.status).toBe(400);
    expect(second.body.code).toBe("DRIVER_SHIFT_NOT_ACTIVE");
  });
});

describe("صلاحيات وعزل الفروع", () => {
  test("مدير فرع تاني معندوش صلاحية يسجّل دخول/خروج لسائق مش بتاع فرعه", async () => {
    const checkInOther = await request(app).post("/api/driver-shifts/check-in").set(authed(managerBToken)).send({ driverId });
    expect(checkInOther.status).toBe(403);

    const checkIn = await request(app).post("/api/driver-shifts/check-in").set(authed(cashierAToken)).send({ driverId });
    const checkOutOther = await request(app).post(`/api/driver-shifts/${checkIn.body.id}/check-out`).set(authed(managerBToken)).send({});
    expect(checkOutOther.status).toBe(403);
    await request(app).post(`/api/driver-shifts/${checkIn.body.id}/check-out`).set(authed(cashierAToken)).send({});
  });

  test("callcenter معندوش driver_shifts.manage خالص", async () => {
    const ccUserEmail = "cc-drivershift@jest.test";
    await seedUser({ branchId: branchA, name: "كول سنتر-حضور-سائقين", email: ccUserEmail, role: "callcenter" });
    const ccToken = await login(ccUserEmail);
    const res = await request(app).post("/api/driver-shifts/check-in").set(authed(ccToken)).send({ driverId });
    expect(res.status).toBe(403);
  });
});
