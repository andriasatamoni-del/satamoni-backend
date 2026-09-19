// TAL-9: لوحة تحكم التكامل + تقرير "Talabat Payment Control" - بيغطي: حالة الاتصال الصادقة (مش CONNECTED
// كاذبة)، تجميع أوردرات اليوم حسب الحالة، ملخص طرق الدفع، الاستثناءات المفتوحة، وauto-flag لفروق الدفع.
const { app, request, pool, seedUser, login, authed } = require("./helpers");
const { syncNormalizedOrder } = require("../services/talabat/talabat-order-sync");

let branchId, branch2Id;
let cashierToken, accountantToken, manager2Token;
let paymentMethodId, otherPaymentMethodId;
let itemId, variantId;
let counter = 0;

function nextTalabatOrderId() {
  counter += 1;
  return `TAL-DASH-JEST-${counter}`;
}

beforeAll(async () => {
  const b = await pool.query("INSERT INTO branches (name, talabat_branch_id) VALUES ('فرع-طلبات-لوحة-جست', 'store-dash-jest-1') RETURNING id");
  branchId = b.rows[0].id;
  const b2 = await pool.query("INSERT INTO branches (name) VALUES ('فرع-طلبات-لوحة-جست-2') RETURNING id");
  branch2Id = b2.rows[0].id;

  await seedUser({ branchId, name: "كاشير-طلبات-لوحة", email: "cashier-taldash@jest.test", role: "cashier" });
  cashierToken = await login("cashier-taldash@jest.test");
  await seedUser({ branchId, name: "محاسب-طلبات-لوحة", email: "accountant-taldash@jest.test", role: "accountant" });
  accountantToken = await login("accountant-taldash@jest.test");
  await seedUser({ branchId: branch2Id, name: "مدير-فرع-تاني-لوحة", email: "manager2-taldash@jest.test", role: "branch_manager" });
  manager2Token = await login("manager2-taldash@jest.test");

  const pm = await pool.query(
    "INSERT INTO payment_methods (name, kind, enabled, talabat_payment_code) VALUES ('طلبات-لوحة-جست','credit',TRUE,'TALABAT_DASH_CREDIT') RETURNING id"
  );
  paymentMethodId = pm.rows[0].id;
  const pm2 = await pool.query(
    "INSERT INTO payment_methods (name, kind, enabled) VALUES ('فيزا-لوحة-جست','card_or_wallet',TRUE) RETURNING id"
  );
  otherPaymentMethodId = pm2.rows[0].id;

  const cat = await pool.query("INSERT INTO menu_categories (name) VALUES ('قسم-طلبات-لوحة-جست') RETURNING id");
  const mi = await pool.query("INSERT INTO menu_items (category_id, name) VALUES ($1,'صنف-طلبات-لوحة-جست') RETURNING id", [cat.rows[0].id]);
  itemId = mi.rows[0].id;
  const v = await pool.query(
    "INSERT INTO menu_item_variants (item_id, label, price, talabat_price) VALUES ($1,'عادي',60,60) RETURNING id",
    [itemId]
  );
  variantId = v.rows[0].id;

  await pool.query(
    `INSERT INTO talabat_product_mapping (branch_id, talabat_item_id, stamoni_menu_item_id, stamoni_variant_id, active, mapping_status)
     VALUES ($1, 'dash-item-1', $2, $3, TRUE, 'MAPPED')`,
    [branchId, itemId, variantId]
  );
});

afterAll(async () => {
  await pool.end();
});

function baseNormalizedOrder(overrides = {}) {
  return {
    talabatOrderId: nextTalabatOrderId(),
    branchExternalId: "store-dash-jest-1",
    orderStatus: "NEW",
    orderType: "delivery",
    paymentMethodCode: "TALABAT_DASH_CREDIT",
    total: 60,
    currency: "EGP",
    items: [{ talabatItemId: "dash-item-1", quantity: 1, unitPrice: 60, totalPrice: 60 }],
    receivedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("GET /api/talabat/dashboard-summary", () => {
  test("حالة الاتصال NOT_CONFIGURED افتراضيًا - مفيش أي ادّعاء CONNECTED كاذب", async () => {
    delete process.env.TALABAT_CLIENT_ID;
    delete process.env.TALABAT_TOKEN_URL;
    const res = await request(app).get(`/api/talabat/dashboard-summary?branchId=${branchId}`).set(authed(cashierToken));
    expect(res.status).toBe(200);
    expect(res.body.connectionStatus).toBe("NOT_CONFIGURED");
  });

  test("لما credentials تتسجل - CONFIGURED_UNVERIFIED (مش CONNECTED خالص لحد ما نداء حقيقي ينجح)", async () => {
    process.env.TALABAT_CLIENT_ID = "id";
    process.env.TALABAT_CLIENT_SECRET = "secret";
    process.env.TALABAT_API_BASE_URL = "https://sandbox.example";
    process.env.TALABAT_TOKEN_URL = "https://sandbox.example/oauth/token";
    const res = await request(app).get(`/api/talabat/dashboard-summary?branchId=${branchId}`).set(authed(cashierToken));
    expect(res.body.connectionStatus).toBe("CONFIGURED_UNVERIFIED");
    delete process.env.TALABAT_CLIENT_ID;
    delete process.env.TALABAT_CLIENT_SECRET;
    delete process.env.TALABAT_API_BASE_URL;
    delete process.env.TALABAT_TOKEN_URL;
  });

  test("تجميع أوردرات اليوم حسب الحالة + ملخص طرق الدفع + الاستثناءات المفتوحة", async () => {
    const imported = await syncNormalizedOrder(baseNormalizedOrder(), {});
    expect(imported.status).toBe("IMPORTED");
    const mappingError = await syncNormalizedOrder(
      baseNormalizedOrder({ items: [{ talabatItemId: "dash-item-not-mapped", quantity: 1, unitPrice: 60, totalPrice: 60 }] }),
      {}
    );
    expect(mappingError.status).toBe("MAPPING_ERROR");

    const res = await request(app).get(`/api/talabat/dashboard-summary?branchId=${branchId}`).set(authed(cashierToken));
    expect(res.status).toBe(200);
    expect(res.body.ordersToday.IMPORTED).toBeGreaterThanOrEqual(1);
    expect(res.body.ordersToday.MAPPING_ERROR).toBeGreaterThanOrEqual(1);
    expect(res.body.paymentSummary.find((p) => p.paymentMethod === "TALABAT_DASH_CREDIT")).toBeTruthy();
    expect(res.body.openExceptions.some((e) => e.error_type === "MAPPING_ERROR")).toBe(true);
  });

  test("مدير فرع تاني مايشوفش فرع مش بتاعه - 403", async () => {
    const res = await request(app).get(`/api/talabat/dashboard-summary?branchId=${branchId}`).set(authed(manager2Token));
    expect(res.status).toBe(403);
  });
});

describe("GET /api/talabat/payment-control-report", () => {
  test("مفيش mismatch لما POS payment == Talabat payment (المسار العادي)", async () => {
    const normalizedOrder = baseNormalizedOrder();
    const result = await syncNormalizedOrder(normalizedOrder, {});
    expect(result.status).toBe("IMPORTED");

    const res = await request(app)
      .get(`/api/talabat/payment-control-report?branchId=${branchId}&from=2000-01-01&to=2100-01-01`)
      .set(authed(accountantToken));
    expect(res.status).toBe(200);
    const row = res.body.find((r) => r.talabat_order_id === normalizedOrder.talabatOrderId);
    expect(row).toBeTruthy();
    expect(row.mismatch).toBe(false);
    expect(row.has_approved_override).toBe(false);
  });

  test("auto-flag mismatch لما طريقة الدفع الفعلية اتغيّرت عن اللي جاية من طلبات", async () => {
    const normalizedOrder = baseNormalizedOrder();
    const result = await syncNormalizedOrder(normalizedOrder, {});
    await pool.query("UPDATE orders SET payment_method_id = $1 WHERE id = $2", [otherPaymentMethodId, result.posOrderId]);

    const res = await request(app)
      .get(`/api/talabat/payment-control-report?branchId=${branchId}&from=2000-01-01&to=2100-01-01`)
      .set(authed(accountantToken));
    const row = res.body.find((r) => r.talabat_order_id === normalizedOrder.talabatOrderId);
    expect(row.mismatch).toBe(true);
    expect(row.actual_payment_method_id).toBe(otherPaymentMethodId);
  });

  test("has_approved_override=true لو فيه ADJUSTMENT_APPROVED مسجّل على نفس الدفعة", async () => {
    const normalizedOrder = baseNormalizedOrder();
    const result = await syncNormalizedOrder(normalizedOrder, {});
    const payment = await pool.query("SELECT id, branch_id FROM payments WHERE order_id = $1", [result.posOrderId]);
    await pool.query(
      `INSERT INTO payment_audit_logs (payment_id, order_id, branch_id, action_type) VALUES ($1, $2, $3, 'ADJUSTMENT_APPROVED')`,
      [payment.rows[0].id, result.posOrderId, payment.rows[0].branch_id]
    );

    const res = await request(app)
      .get(`/api/talabat/payment-control-report?branchId=${branchId}&from=2000-01-01&to=2100-01-01`)
      .set(authed(accountantToken));
    const row = res.body.find((r) => r.talabat_order_id === normalizedOrder.talabatOrderId);
    expect(row.has_approved_override).toBe(true);
  });
});
