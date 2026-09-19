// TAL-6: طريقة دفع أوردر طلبات مقفولة - حتى مجرد طلب تعديلها محتاج صلاحية منفصلة (talabat.payment_override)
// مش payment_control.adjustment.request العامة اللي الكاشير أصلًا معاه، والاعتماد نفسه (مش بس الطلب)
// محتاج نفس الصلاحية الإضافية كمان (مدير الفرع معاه payment_control.adjustment.approve بس مش يكفي هنا).
// وتقرير "Payment Overrides" بيسرد كل تعديل اتعتمد فعليًا لأوردر طلبات.
const { app, request, pool, seedUser, login, authed } = require("./helpers");

let branchId;
let cashierToken, branchManagerToken, accountantToken;
let menuItemId, variantId;
let creditMethodId, visaMethodId;

beforeAll(async () => {
  const b = await pool.query("INSERT INTO branches (name) VALUES ('فرع-طلبات-اعتماد-جست') RETURNING id");
  branchId = b.rows[0].id;

  await seedUser({ branchId, name: "كاشير-طلبات-اعتماد", email: "cashier-talover@jest.test", role: "cashier" });
  cashierToken = await login("cashier-talover@jest.test");
  await seedUser({ branchId, name: "مدير-طلبات-اعتماد", email: "manager-talover@jest.test", role: "branch_manager", pin: "5551" });
  branchManagerToken = await login("manager-talover@jest.test");
  await seedUser({ branchId, name: "محاسب-طلبات-اعتماد", email: "accountant-talover@jest.test", role: "accountant", pin: "5552" });
  accountantToken = await login("accountant-talover@jest.test");

  const cat = await pool.query("INSERT INTO menu_categories (name) VALUES ('قسم-طلبات-اعتماد-جست') RETURNING id");
  const mi = await pool.query("INSERT INTO menu_items (category_id, name) VALUES ($1,'صنف-طلبات-اعتماد-جست') RETURNING id", [cat.rows[0].id]);
  menuItemId = mi.rows[0].id;
  const v = await pool.query(
    "INSERT INTO menu_item_variants (item_id, label, price, talabat_price) VALUES ($1,'عادي',200,200) RETURNING id",
    [mi.rows[0].id]
  );
  variantId = v.rows[0].id;

  const credit = await pool.query("INSERT INTO payment_methods (name, kind) VALUES ('آجل-طلبات-اعتماد-جست','credit') RETURNING id");
  creditMethodId = credit.rows[0].id;
  const visa = await pool.query(
    "INSERT INTO payment_methods (name, kind, settlement_channel) VALUES ('فيزا-طلبات-اعتماد-جست','card_or_wallet','visa_pos') RETURNING id"
  );
  visaMethodId = visa.rows[0].id;
});

afterAll(async () => {
  await pool.end();
});

async function makeTalabatOrder() {
  const res = await request(app).post("/api/orders").set(authed(cashierToken)).send({
    branchId, source: "talabat", orderType: "delivery", paymentMethodId: creditMethodId,
    talabatOrderId: "TLB-OVR-" + Math.random().toString(36).slice(2, 8),
    items: [{ itemId: menuItemId, variantId, quantity: 1 }],
  });
  expect(res.status).toBe(201);
  const payment = await pool.query("SELECT * FROM payments WHERE order_id = $1", [res.body.orderId]);
  return { orderId: res.body.orderId, payment: payment.rows[0] };
}

describe("طلب تعديل طريقة دفع أوردر طلبات - محتاج talabat.payment_override", () => {
  test("الكاشير (معاه payment_control.adjustment.request العامة بس) مرفوض 403", async () => {
    const { payment } = await makeTalabatOrder();
    const res = await request(app).post("/api/payment-control/adjustment-requests").set(authed(cashierToken)).send({
      paymentId: payment.id, reason: "غلطة تسجيل", proposedPaymentMethodId: visaMethodId,
    });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/talabat\.payment_override/);
  });

  test("المحاسب (معاه talabat.payment_override) مسموح يطلب التعديل", async () => {
    const { payment } = await makeTalabatOrder();
    const res = await request(app).post("/api/payment-control/adjustment-requests").set(authed(accountantToken)).send({
      paymentId: payment.id, reason: "تصحيح طريقة الدفع القادمة من طلبات", proposedPaymentMethodId: visaMethodId,
    });
    expect(res.status).toBe(201);
  });

  test("أوردر عادي (مش طلبات) - طلب التعديل بيمشي عادي بصلاحية payment_control.adjustment.request وحدها", async () => {
    const orderRes = await request(app).post("/api/orders").set(authed(cashierToken)).send({
      branchId, source: "pos", orderType: "takeaway", paymentMethodId: creditMethodId,
      items: [{ itemId: menuItemId, variantId, quantity: 1 }],
    });
    expect(orderRes.status).toBe(201);
    const payment = await pool.query("SELECT * FROM payments WHERE order_id = $1", [orderRes.body.orderId]);
    const res = await request(app).post("/api/payment-control/adjustment-requests").set(authed(cashierToken)).send({
      paymentId: payment.rows[0].id, reason: "تعديل عادي", proposedPaymentMethodId: visaMethodId,
    });
    expect(res.status).toBe(201);
  });
});

describe("اعتماد تعديل طريقة دفع أوردر طلبات - محتاج talabat.payment_override برضو مش بس adjustment.approve", () => {
  test("مدير الفرع (معاه payment_control.adjustment.approve بس مش talabat.payment_override) مرفوض 403", async () => {
    const { payment } = await makeTalabatOrder();
    const reqRes = await request(app).post("/api/payment-control/adjustment-requests").set(authed(accountantToken)).send({
      paymentId: payment.id, reason: "تصحيح", proposedPaymentMethodId: visaMethodId,
    });
    expect(reqRes.status).toBe(201);

    const pinRes = await request(app).post("/api/auth/verify-override-pin").set(authed(branchManagerToken)).send({
      pin: "5551", branchId, actionType: "PAYMENT_ADJUSTMENT", targetType: "payment_adjustment_request", targetId: reqRes.body.id,
    });
    expect(pinRes.status).toBe(200); // الـPIN نفسه بينجح - مدير الفرع مسموح له الـaction ده بشكل عام

    const approveRes = await request(app).post(`/api/payment-control/adjustment-requests/${reqRes.body.id}/approve`)
      .set(authed(branchManagerToken)).send({ approvalToken: pinRes.body.token });
    expect(approveRes.status).toBe(403);
    expect(approveRes.body.error).toMatch(/talabat\.payment_override/);

    const stillPending = await pool.query("SELECT status FROM payment_adjustment_requests WHERE id = $1", [reqRes.body.id]);
    expect(stillPending.rows[0].status).toBe("PENDING");
  });

  test("المحاسب (معاه talabat.payment_override) يعتمد بنجاح، والقفل الجديد بيتسجل في payment_audit_logs", async () => {
    const { orderId, payment } = await makeTalabatOrder();
    const reqRes = await request(app).post("/api/payment-control/adjustment-requests").set(authed(accountantToken)).send({
      paymentId: payment.id, reason: "طريقة الدفع القادمة من طلبات غلط", proposedPaymentMethodId: visaMethodId,
    });
    expect(reqRes.status).toBe(201);

    const pinRes = await request(app).post("/api/auth/verify-override-pin").set(authed(accountantToken)).send({
      pin: "5552", branchId, actionType: "PAYMENT_ADJUSTMENT", targetType: "payment_adjustment_request", targetId: reqRes.body.id,
    });
    expect(pinRes.status).toBe(200);

    const approveRes = await request(app).post(`/api/payment-control/adjustment-requests/${reqRes.body.id}/approve`)
      .set(authed(accountantToken)).send({ approvalToken: pinRes.body.token });
    expect(approveRes.status).toBe(200);
    expect(approveRes.body.payment.payment_method_id).toBe(visaMethodId);

    // تقرير Payment Overrides لازم يسرد التعديل ده
    const reportRes = await request(app)
      .get(`/api/payment-control/talabat-payment-overrides?branchId=${branchId}`)
      .set(authed(accountantToken));
    expect(reportRes.status).toBe(200);
    const row = reportRes.body.find((r) => r.order_id === orderId);
    expect(row).toBeTruthy();
    expect(row.old_payment_method_id).toBe(creditMethodId);
    expect(row.new_payment_method_id).toBe(visaMethodId);
    expect(row.reason).toMatch(/طريقة الدفع القادمة من طلبات غلط/);
  });
});
