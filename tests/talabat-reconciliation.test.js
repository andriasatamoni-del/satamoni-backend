// TAL-8: المطابقة اليومية - compareTalabatRecords نقية (pure) ومختبرة ضد الحالات الستة المطلوبة صراحة.
// runDailyReconciliation بترجع TALABAT_API_NOT_CONFIGURED (مش COMPLETED كاذبة) لحد ما getOrderHistory
// الحقيقي يتنفّذ - وده مختبر ضد Postgres حقيقي عشان نتأكد إن سجلات Stamoni المحلية بترجع صح برضو.
const { compareTalabatRecords, runDailyReconciliation } = require("../services/talabat/talabat-reconciliation");
const { app, request, pool, seedUser, login, authed } = require("./helpers");

afterAll(async () => {
  await pool.end();
});

describe("compareTalabatRecords - الفروقات الستة", () => {
  test("MISSING_IN_STAMONI: موجود عند Talabat مش موجود عندنا", () => {
    const discrepancies = compareTalabatRecords(
      [{ talabatOrderId: "T1", total: 100, paymentMethodCode: "CASH", orderStatus: "ACCEPTED" }],
      []
    );
    expect(discrepancies).toContainEqual(expect.objectContaining({ type: "MISSING_IN_STAMONI", talabatOrderId: "T1" }));
  });

  test("MISSING_IN_TALABAT: موجود عندنا مش موجود عند Talabat", () => {
    const discrepancies = compareTalabatRecords(
      [],
      [{ talabatOrderId: "T2", total: 100, paymentMethodCode: "CASH", orderStatus: "IMPORTED" }]
    );
    expect(discrepancies).toContainEqual(expect.objectContaining({ type: "MISSING_IN_TALABAT", talabatOrderId: "T2" }));
  });

  test("TOTAL_MISMATCH: نفس الأوردر بإجمالي مختلف", () => {
    const discrepancies = compareTalabatRecords(
      [{ talabatOrderId: "T3", total: 150, paymentMethodCode: "CASH", orderStatus: "ACCEPTED" }],
      [{ talabatOrderId: "T3", total: 100, paymentMethodCode: "CASH", orderStatus: "IMPORTED" }]
    );
    expect(discrepancies).toContainEqual(
      expect.objectContaining({ type: "TOTAL_MISMATCH", talabatOrderId: "T3", talabatTotal: 150, stamoniTotal: 100 })
    );
  });

  test("مفيش TOTAL_MISMATCH لو الفرق أقل من الـepsilon (فروق تقريب عادية)", () => {
    const discrepancies = compareTalabatRecords(
      [{ talabatOrderId: "T3b", total: 100.001, paymentMethodCode: "CASH", orderStatus: "ACCEPTED" }],
      [{ talabatOrderId: "T3b", total: 100, paymentMethodCode: "CASH", orderStatus: "IMPORTED" }]
    );
    expect(discrepancies.find((d) => d.type === "TOTAL_MISMATCH")).toBeUndefined();
  });

  test("PAYMENT_MISMATCH: نفس الأوردر بطريقة دفع مختلفة", () => {
    const discrepancies = compareTalabatRecords(
      [{ talabatOrderId: "T4", total: 100, paymentMethodCode: "VISA", orderStatus: "ACCEPTED" }],
      [{ talabatOrderId: "T4", total: 100, paymentMethodCode: "CASH", orderStatus: "IMPORTED" }]
    );
    expect(discrepancies).toContainEqual(
      expect.objectContaining({ type: "PAYMENT_MISMATCH", talabatOrderId: "T4", talabatPaymentMethod: "VISA", stamoniPaymentMethod: "CASH" })
    );
  });

  test("DUPLICATE_ORDER: نفس رقم الأوردر ظاهر مرتين في سجلات Talabat", () => {
    const discrepancies = compareTalabatRecords(
      [
        { talabatOrderId: "T5", total: 100, paymentMethodCode: "CASH", orderStatus: "ACCEPTED" },
        { talabatOrderId: "T5", total: 100, paymentMethodCode: "CASH", orderStatus: "ACCEPTED" },
      ],
      [{ talabatOrderId: "T5", total: 100, paymentMethodCode: "CASH", orderStatus: "IMPORTED" }]
    );
    expect(discrepancies).toContainEqual(expect.objectContaining({ type: "DUPLICATE_ORDER", talabatOrderId: "T5" }));
  });

  test("CANCELLATION_MISMATCH: Talabat يقول ملغي وإحنا لأ (والعكس)", () => {
    const discrepancies1 = compareTalabatRecords(
      [{ talabatOrderId: "T6", total: 100, paymentMethodCode: "CASH", orderStatus: "CANCELED" }],
      [{ talabatOrderId: "T6", total: 100, paymentMethodCode: "CASH", orderStatus: "IMPORTED" }]
    );
    expect(discrepancies1).toContainEqual(expect.objectContaining({ type: "CANCELLATION_MISMATCH", talabatOrderId: "T6" }));

    const discrepancies2 = compareTalabatRecords(
      [{ talabatOrderId: "T7", total: 100, paymentMethodCode: "CASH", orderStatus: "ACCEPTED" }],
      [{ talabatOrderId: "T7", total: 100, paymentMethodCode: "CASH", orderStatus: "CANCELED" }]
    );
    expect(discrepancies2).toContainEqual(expect.objectContaining({ type: "CANCELLATION_MISMATCH", talabatOrderId: "T7" }));
  });

  test("مطابقة تمامًا - مفيش أي فروقات", () => {
    const discrepancies = compareTalabatRecords(
      [{ talabatOrderId: "T8", total: 100, paymentMethodCode: "CASH", orderStatus: "ACCEPTED" }],
      [{ talabatOrderId: "T8", total: 100, paymentMethodCode: "CASH", orderStatus: "IMPORTED" }]
    );
    expect(discrepancies).toEqual([]);
  });
});

describe("GET /api/talabat/reconciliation - صلاحية talabat.reconciliation", () => {
  let branchId, cashierToken, accountantToken;

  beforeAll(async () => {
    const b = await pool.query("INSERT INTO branches (name) VALUES ('فرع-مطابقة-صلاحيات-جست') RETURNING id");
    branchId = b.rows[0].id;
    await seedUser({ branchId, name: "كاشير-مطابقة-جست", email: "cashier-talrecon@jest.test", role: "cashier" });
    cashierToken = await login("cashier-talrecon@jest.test");
    await seedUser({ branchId, name: "محاسب-مطابقة-جست", email: "accountant-talrecon@jest.test", role: "accountant" });
    accountantToken = await login("accountant-talrecon@jest.test");
  });

  test("الكاشير معندوش talabat.reconciliation - 403", async () => {
    const res = await request(app).get(`/api/talabat/reconciliation?branchId=${branchId}`).set(authed(cashierToken));
    expect(res.status).toBe(403);
  });

  test("المحاسب معاه talabat.reconciliation - 200 مع status صريح", async () => {
    const res = await request(app).get(`/api/talabat/reconciliation?branchId=${branchId}`).set(authed(accountantToken));
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("TALABAT_API_NOT_CONFIGURED");
  });
});

describe("runDailyReconciliation - ضد Postgres حقيقي (Talabat API لسه stub)", () => {
  test("بيرجع TALABAT_API_NOT_CONFIGURED (مش COMPLETED كاذبة) وسجلات Stamoni المحلية", async () => {
    const b = await pool.query("INSERT INTO branches (name) VALUES ('فرع-مطابقة-جست') RETURNING id");
    const branchId = b.rows[0].id;
    await pool.query(
      `INSERT INTO talabat_orders (branch_id, talabat_order_id, order_status, payment_method, total, raw_payload)
       VALUES ($1, 'TLB-RECON-1', 'IMPORTED', 'CASH', 123.45, '{}'::jsonb)`,
      [branchId]
    );

    const today = new Date().toISOString().slice(0, 10);
    const result = await runDailyReconciliation({ branchId, from: today, to: today });
    expect(result.status).toBe("TALABAT_API_NOT_CONFIGURED");
    expect(result.discrepancies).toEqual([]);
    expect(result.stamoniRecords).toContainEqual(
      expect.objectContaining({ talabatOrderId: "TLB-RECON-1", total: 123.45, paymentMethodCode: "CASH" })
    );
  });
});
