// Payment Control & Reconciliation - 12 سيناريو مؤكدة مع المستخدم: قفل الدفع، سقف اعتماد التعديل
// المزدوج (مشرف فرع لأي مبلغ / محاسب-أدمن للسقف العالي)، منع إعادة استخدام توكن الاعتماد، الفحوصات
// الثلاثة (Talabat/POS mismatch، فرق كاش طلبات، إنستاباي غير مطابق، تسوية فيزا)، وعزل الفروع.
const { app, request, pool, seedUser, login, authed } = require("./helpers");

let branchId, branch2Id;
let managerToken, accountantToken, cashierToken;
let manager2Token, accountant2Token;
let menuItemId, variantId;
let cashMethodId, visaMethodId, instapayMethodId;

beforeAll(async () => {
  const b1 = await pool.query("INSERT INTO branches (name) VALUES ('فرع-PC-1') RETURNING id");
  branchId = b1.rows[0].id;
  const b2 = await pool.query("INSERT INTO branches (name) VALUES ('فرع-PC-2') RETURNING id");
  branch2Id = b2.rows[0].id;

  await seedUser({ branchId, name: "مشرف-PC", email: "manager-pc@jest.test", role: "branch_manager", pin: "1111" });
  managerToken = await login("manager-pc@jest.test");
  await seedUser({ branchId, name: "محاسب-PC", email: "accountant-pc@jest.test", role: "accountant", pin: "2222" });
  accountantToken = await login("accountant-pc@jest.test");
  await seedUser({ branchId, name: "كاشير-PC", email: "cashier-pc@jest.test", role: "cashier" });
  cashierToken = await login("cashier-pc@jest.test");

  await seedUser({ branchId: branch2Id, name: "مشرف-PC-2", email: "manager2-pc@jest.test", role: "branch_manager", pin: "3333" });
  manager2Token = await login("manager2-pc@jest.test");
  await seedUser({ branchId: branch2Id, name: "محاسب-PC-2", email: "accountant2-pc@jest.test", role: "accountant", pin: "4444" });
  accountant2Token = await login("accountant2-pc@jest.test");

  const cat = await pool.query("INSERT INTO menu_categories (name) VALUES ('PC-قسم') RETURNING id");
  const mi = await pool.query("INSERT INTO menu_items (category_id, name) VALUES ($1,'PC-صنف') RETURNING id", [cat.rows[0].id]);
  menuItemId = mi.rows[0].id;
  const v = await pool.query(
    "INSERT INTO menu_item_variants (item_id, label, price, talabat_price) VALUES ($1,'عادي',600,600) RETURNING id",
    [mi.rows[0].id]
  );
  variantId = v.rows[0].id;

  const cash = await pool.query("INSERT INTO payment_methods (name, kind) VALUES ('كاش-PC', 'cash') RETURNING id");
  cashMethodId = cash.rows[0].id;
  const visa = await pool.query(
    "INSERT INTO payment_methods (name, kind, settlement_channel) VALUES ('فيزا-PC', 'card_or_wallet', 'visa_pos') RETURNING id"
  );
  visaMethodId = visa.rows[0].id;
  const insta = await pool.query(
    "INSERT INTO payment_methods (name, kind, settlement_channel) VALUES ('إنستاباي-PC', 'card_or_wallet', 'instapay') RETURNING id"
  );
  instapayMethodId = insta.rows[0].id;
});

afterAll(async () => {
  await pool.end();
});

async function makeOrder({ token = cashierToken, paymentMethodId, source = "pos", orderType = "takeaway", talabatCashCollected } = {}) {
  const body = {
    branchId, source, orderType, paymentMethodId,
    items: [{ itemId: menuItemId, variantId, quantity: 1 }],
  };
  if (source === "talabat") {
    body.talabatOrderId = "TLB-" + Math.random().toString(36).slice(2, 8);
    if (talabatCashCollected !== undefined) body.talabatCashCollected = talabatCashCollected;
  }
  const res = await request(app).post("/api/orders").set(authed(token)).send(body);
  expect(res.status).toBe(201);
  return res.body.orderId;
}

async function paymentForOrder(orderId) {
  const r = await pool.query("SELECT * FROM payments WHERE order_id = $1", [orderId]);
  expect(r.rows.length).toBe(1);
  return r.rows[0];
}

// 1) قفل الدفع فور اختيار الكاشير وقت إنشاء الطلب
test("1) سجل payments بيتقفل فورًا وقت إنشاء الطلب لو طريقة الدفع متحددة", async () => {
  const orderId = await makeOrder({ paymentMethodId: cashMethodId });
  const payment = await paymentForOrder(orderId);
  expect(payment.status).toBe("LOCKED");
  expect(payment.payment_method_id).toBe(cashMethodId);
  expect(Number(payment.amount)).toBe(600);
});

// 2) تعديل مباشر لطريقة الدفع بعد القفل مرفوض - لازم Payment Adjustment Request
test("2) تعديل payment_method_id مباشر عبر PUT /:id بعد القفل مرفوض", async () => {
  // التعديل عبر PUT متاح بس للطلبات "تحت التحضير" (preparing) - دليفري بس بيبدأ بالحالة دي
  const orderId = await makeOrder({ paymentMethodId: cashMethodId, orderType: "delivery" });
  const res = await request(app).put(`/api/orders/${orderId}`).set(authed(cashierToken)).send({
    paymentMethodId: visaMethodId, items: [{ itemId: menuItemId, variantId, quantity: 1 }],
  });
  expect(res.status).toBe(400);
  expect(res.body.error).toMatch(/Payment Adjustment Request|مقفولة/);
  const payment = await paymentForOrder(orderId);
  expect(payment.payment_method_id).toBe(cashMethodId); // من غير تغيير فعلي
});

// 3) تعديل صغير (< 500) يعتمده مشرف الفرع لوحده
test("3) طلب تعديل بفرق أقل من السقف - مشرف الفرع يعتمده لوحده وينجح", async () => {
  const orderId = await makeOrder({ paymentMethodId: cashMethodId });
  const payment = await paymentForOrder(orderId);

  // نغيّر المبلغ المقترح بفرق صغير بس (نفس طريقة الدفع - عشان الـdelta يبقى فرق المبلغ مش المبلغ كله)
  const reqRes = await request(app).post("/api/payment-control/adjustment-requests").set(authed(cashierToken)).send({
    paymentId: payment.id, reason: "تصحيح مبلغ بسيط", proposedAmount: 620,
  });
  expect(reqRes.status).toBe(201);
  expect(Number(reqRes.body.amount_delta)).toBe(20);

  const pinRes = await request(app).post("/api/auth/verify-override-pin").set(authed(managerToken)).send({
    pin: "1111", branchId, actionType: "PAYMENT_ADJUSTMENT", targetType: "payment_adjustment_request", targetId: reqRes.body.id,
  });
  expect(pinRes.status).toBe(200);

  const approveRes = await request(app).post(`/api/payment-control/adjustment-requests/${reqRes.body.id}/approve`)
    .set(authed(managerToken)).send({ approvalToken: pinRes.body.token });
  expect(approveRes.status).toBe(200);
  expect(approveRes.body.payment.status).toBe("ADJUSTED");
  expect(Number(approveRes.body.payment.amount)).toBe(620);
});

// 4) تعديل كبير (>= 500) اعتماد مشرف الفرع لوحده مرفوض
test("4) طلب تعديل بفرق >= السقف - اعتماد مشرف الفرع لوحده مرفوض (HIGH_TIER_REQUIRED)", async () => {
  const orderId = await makeOrder({ paymentMethodId: cashMethodId });
  const payment = await paymentForOrder(orderId);

  // تغيير طريقة الدفع بالكامل (مش المبلغ) - الـdelta بيبقى المبلغ كله (600) وهو >= 500
  const reqRes = await request(app).post("/api/payment-control/adjustment-requests").set(authed(cashierToken)).send({
    paymentId: payment.id, reason: "اتسجلت غلط فيزا بدل كاش", proposedPaymentMethodId: visaMethodId,
  });
  expect(reqRes.status).toBe(201);
  expect(Number(reqRes.body.amount_delta)).toBe(600);

  const pinRes = await request(app).post("/api/auth/verify-override-pin").set(authed(managerToken)).send({
    pin: "1111", branchId, actionType: "PAYMENT_ADJUSTMENT", targetType: "payment_adjustment_request", targetId: reqRes.body.id,
  });
  expect(pinRes.status).toBe(200); // الموافقة على مستوى الـPIN بتنجح (مشرف فرع مسموح له الـaction ده)

  const approveRes = await request(app).post(`/api/payment-control/adjustment-requests/${reqRes.body.id}/approve`)
    .set(authed(managerToken)).send({ approvalToken: pinRes.body.token });
  expect(approveRes.status).toBe(400);
  expect(approveRes.body.error).toMatch(/محاسب أو أدمن/);

  const stillPending = await pool.query("SELECT status FROM payment_adjustment_requests WHERE id = $1", [reqRes.body.id]);
  expect(stillPending.rows[0].status).toBe("PENDING");
});

// 5) نفس الحالة فوق - اعتماد المحاسب ينجح
test("5) نفس طلب التعديل الكبير - اعتماد المحاسب ينجح", async () => {
  const orderId = await makeOrder({ paymentMethodId: cashMethodId });
  const payment = await paymentForOrder(orderId);

  const reqRes = await request(app).post("/api/payment-control/adjustment-requests").set(authed(cashierToken)).send({
    paymentId: payment.id, reason: "اتسجلت غلط فيزا بدل كاش", proposedPaymentMethodId: visaMethodId,
  });
  expect(reqRes.status).toBe(201);

  const pinRes = await request(app).post("/api/auth/verify-override-pin").set(authed(accountantToken)).send({
    pin: "2222", branchId, actionType: "PAYMENT_ADJUSTMENT", targetType: "payment_adjustment_request", targetId: reqRes.body.id,
  });
  expect(pinRes.status).toBe(200);

  const approveRes = await request(app).post(`/api/payment-control/adjustment-requests/${reqRes.body.id}/approve`)
    .set(authed(accountantToken)).send({ approvalToken: pinRes.body.token });
  expect(approveRes.status).toBe(200);
  expect(approveRes.body.payment.status).toBe("ADJUSTED");
  expect(approveRes.body.payment.payment_method_id).toBe(visaMethodId);
});

// 6) منع إعادة استخدام (replay) توكن اعتماد مُستهلك على طلب تعديل تاني
test("6) توكن اعتماد مُستهلك مينفعش يُستخدم تاني على طلب تعديل مختلف", async () => {
  const orderId1 = await makeOrder({ paymentMethodId: cashMethodId });
  const orderId2 = await makeOrder({ paymentMethodId: cashMethodId });
  const payment1 = await paymentForOrder(orderId1);
  const payment2 = await paymentForOrder(orderId2);

  const req1 = await request(app).post("/api/payment-control/adjustment-requests").set(authed(cashierToken)).send({
    paymentId: payment1.id, reason: "سبب 1", proposedAmount: 610,
  });
  const req2 = await request(app).post("/api/payment-control/adjustment-requests").set(authed(cashierToken)).send({
    paymentId: payment2.id, reason: "سبب 2", proposedAmount: 610,
  });

  const pinRes = await request(app).post("/api/auth/verify-override-pin").set(authed(managerToken)).send({
    pin: "1111", branchId, actionType: "PAYMENT_ADJUSTMENT", targetType: "payment_adjustment_request", targetId: req1.body.id,
  });
  expect(pinRes.status).toBe(200);

  const approve1 = await request(app).post(`/api/payment-control/adjustment-requests/${req1.body.id}/approve`)
    .set(authed(managerToken)).send({ approvalToken: pinRes.body.token });
  expect(approve1.status).toBe(200);

  // نفس التوكن على طلب تعديل تاني - لازم يترفض
  const replay = await request(app).post(`/api/payment-control/adjustment-requests/${req2.body.id}/approve`)
    .set(authed(managerToken)).send({ approvalToken: pinRes.body.token });
  expect(replay.status).toBe(400);
  const req2Status = await pool.query("SELECT status FROM payment_adjustment_requests WHERE id = $1", [req2.body.id]);
  expect(req2Status.rows[0].status).toBe("PENDING");
});

// 7) أوردر طلبات اتسجّل بفيزا POS - يتفلج فورًا
test("7) أوردر طلبات (source=talabat) بطريقة دفع card_or_wallet يتفلج TALABAT_POS_MISMATCH", async () => {
  const orderId = await makeOrder({ token: cashierToken, paymentMethodId: visaMethodId, source: "talabat" });
  const from = "2000-01-01", to = new Date().toISOString().slice(0, 10);
  const res = await request(app).get(`/api/payment-control/exceptions?branchId=${branchId}&from=${from}&to=${to}`).set(authed(managerToken));
  expect(res.status).toBe(200);
  const match = res.body.exceptions.find((e) => e.type === "TALABAT_POS_MISMATCH" && e.orderId === orderId);
  expect(match).toBeTruthy();
  expect(match.points).toBe(40);
});

// 8) فرق كاش طلبات - داخلي (talabat_cash_collected) مقابل كشف طلبات المُدخل يدويًا
test("8) فرق بين كاش طلبات الداخلي وكشف طلبات المُدخل يدويًا يتحسب صح", async () => {
  const orderId = await makeOrder({ token: cashierToken, paymentMethodId: cashMethodId, source: "talabat", talabatCashCollected: 200 });
  const payment = await paymentForOrder(orderId);
  const day = payment.locked_at.toISOString().slice(0, 10);

  await request(app).post("/api/payment-control/reconciliation-records").set(authed(accountantToken)).send({
    branchId, source: "talabat_statement", externalAmount: 150, externalDate: day, externalReference: "TLB-STMT-1",
  });

  const res = await request(app).get(`/api/payment-control/exceptions?branchId=${branchId}&from=2000-01-01&to=${day}`).set(authed(managerToken));
  const match = res.body.exceptions.find((e) => e.type === "TALABAT_CASH_DIFF" && e.day === day);
  expect(match).toBeTruthy();
  expect(match.internalAmount).toBeGreaterThanOrEqual(200);
  expect(match.diff).toBeGreaterThanOrEqual(50);
});

// 9) دفعة إنستاباي من غير كشف مطابق بعد فترة السماح - استثناء داخلي
test("9) دفعة إنستاباي قديمة من غير كشف مطابق تتفلج UNMATCHED_INTERNAL", async () => {
  const orderId = await makeOrder({ token: cashierToken, paymentMethodId: instapayMethodId });
  const payment = await paymentForOrder(orderId);
  await pool.query("UPDATE payments SET locked_at = now() - interval '10 days' WHERE id = $1", [payment.id]);

  const from = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  const to = new Date().toISOString().slice(0, 10);
  const res = await request(app).get(`/api/payment-control/exceptions?branchId=${branchId}&from=${from}&to=${to}`).set(authed(managerToken));
  const match = res.body.exceptions.find((e) => e.type === "INSTAPAY_UNMATCHED_INTERNAL" && e.paymentId === payment.id);
  expect(match).toBeTruthy();
});

// 10) سطر كشف إنستاباي من غير دفعة داخلية مطابقة بعد فترة السماح - استثناء خارجي
test("10) سطر كشف إنستاباي قديم من غير دفعة مطابقة يتفلج UNMATCHED_EXTERNAL", async () => {
  const oldDate = new Date(Date.now() - 10 * 86400000).toISOString().slice(0, 10);
  const entered = await request(app).post("/api/payment-control/reconciliation-records").set(authed(accountantToken)).send({
    branchId, source: "instapay", externalAmount: 333, externalDate: oldDate, externalReference: "INSTA-STMT-X",
  });
  expect(entered.status).toBe(201);

  const from = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  const to = new Date().toISOString().slice(0, 10);
  const res = await request(app).get(`/api/payment-control/exceptions?branchId=${branchId}&from=${from}&to=${to}`).set(authed(managerToken));
  const match = res.body.exceptions.find((e) => e.type === "INSTAPAY_UNMATCHED_EXTERNAL" && e.recordId === entered.body.id);
  expect(match).toBeTruthy();
});

// 11) فرق تسوية فيزا - إجمالي المدفوعات الداخلية مقابل كشف التسوية المُدخل يدويًا
test("11) فرق تسوية فيزا بين المدفوعات الداخلية وكشف التسوية يتحسب صح", async () => {
  const orderId = await makeOrder({ paymentMethodId: visaMethodId });
  const payment = await paymentForOrder(orderId);
  const day = payment.locked_at.toISOString().slice(0, 10);

  await request(app).post("/api/payment-control/reconciliation-records").set(authed(accountantToken)).send({
    branchId, source: "visa_settlement", externalAmount: 550, externalDate: day, externalReference: "VISA-BATCH-1",
  });

  const res = await request(app).get(`/api/payment-control/exceptions?branchId=${branchId}&from=${day}&to=${day}`).set(authed(managerToken));
  const match = res.body.exceptions.find((e) => e.type === "VISA_SETTLEMENT_DIFF");
  expect(match).toBeTruthy();
  expect(Math.abs(match.diff)).toBeGreaterThan(0);
});

// 12) عزل الفروع - مشرف/محاسب فرع تاني مايقدرش يشوف/يتصرف في مدفوعات/طلبات تعديل فرع مختلف
test("12) عزل الفروع: مشرف فرع تاني مايقدرش يعتمد طلب تعديل دفع فرع مختلف", async () => {
  const orderId = await makeOrder({ paymentMethodId: cashMethodId });
  const payment = await paymentForOrder(orderId);

  const reqRes = await request(app).post("/api/payment-control/adjustment-requests").set(authed(cashierToken)).send({
    paymentId: payment.id, reason: "سبب عزل فروع", proposedAmount: 610,
  });
  expect(reqRes.status).toBe(201);

  // مشرف الفرع التاني مايقدرش حتى يصدر توكن PIN بفرع مش بتاعه - نفس نمط branch_manager العادي بالظبط:
  // مرشحي الموافقة بيتفلتروا بالفرع من أصل الاستعلام، فمفيش مرشح يطابق PIN "3333" لفرع 1 أصلًا -> PIN_INVALID (401)
  const pinRes = await request(app).post("/api/auth/verify-override-pin").set(authed(manager2Token)).send({
    pin: "3333", branchId, actionType: "PAYMENT_ADJUSTMENT", targetType: "payment_adjustment_request", targetId: reqRes.body.id,
  });
  expect(pinRes.status).toBe(401);

  // ولو افترضنا معاه توكن (مش هيحصل عمليًا) - الـassertOwnBranch في الراوت نفسه بيرفض قبل حتى استهلاكه
  const approveRes = await request(app).post(`/api/payment-control/adjustment-requests/${reqRes.body.id}/approve`)
    .set(authed(manager2Token)).send({ approvalToken: "irrelevant-forged-token" });
  expect(approveRes.status).toBe(403);

  // نفس الشيء لقايمة المدفوعات - فرع تاني مايشوفش مدفوعات الفرع ده
  const listRes = await request(app).get(`/api/payment-control/payments?branchId=${branchId}`).set(authed(manager2Token));
  expect(listRes.status).toBe(403);
});
