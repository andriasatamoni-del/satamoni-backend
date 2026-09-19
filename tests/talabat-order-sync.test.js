// TAL-5: محرك المزامنة - أوردر مُطبَّع (يمثّل مخرجات adapter مستقبلي) لأوردر POS حقيقي عبر نفس محرك
// الكاشير بالظبط. بيغطي: النجاح الكامل (فرع/دفع/صنف كلهم متربطين)، القفل التلقائي لطريقة الدفع (بدون
// كود قفل جديد)، الـ1:1 (مزامنة نفس أوردر Talabat مرتين ما بتعملش أوردر POS تاني)، وكل حالات
// MAPPING_ERROR (فرع/دفع/صنف مش مربوطين) بتترصد كـIntegration Error مرئي من غير ما تنشئ أوردر جزئي.
const { pool } = require("./helpers");
const { syncNormalizedOrder } = require("../services/talabat/talabat-order-sync");

let branchId, unmappedBranchExternalId = "store-not-mapped";
let paymentMethodId;
let itemId, variantId;
let counter = 0;

function nextTalabatOrderId() {
  counter += 1;
  return `TAL-SYNC-JEST-${counter}`;
}

function baseNormalizedOrder(overrides = {}) {
  return {
    talabatOrderId: nextTalabatOrderId(),
    talabatExternalOrderId: null,
    talabatOrderCode: null,
    branchExternalId: "store-jest-1",
    orderStatus: "NEW",
    orderType: "delivery",
    paymentMethodCode: "TALABAT_CARD",
    subtotal: 100,
    deliveryFee: 10,
    discount: 0,
    total: 110,
    currency: "EGP",
    items: [{ talabatItemId: "item-jest-1", talabatSku: null, name: "صنف", quantity: 2, unitPrice: 50, totalPrice: 100 }],
    customer: { name: "عميل طلبات", phone: null },
    receivedAt: new Date().toISOString(),
    ...overrides,
  };
}

beforeAll(async () => {
  const b = await pool.query(
    "INSERT INTO branches (name, talabat_branch_id) VALUES ('فرع-طلبات-مزامنة-جست', 'store-jest-1') RETURNING id"
  );
  branchId = b.rows[0].id;

  const pm = await pool.query(
    "INSERT INTO payment_methods (name, kind, enabled, talabat_payment_code) VALUES ('طلبات-كارت-جست','card_or_wallet',TRUE,'TALABAT_CARD') RETURNING id"
  );
  paymentMethodId = pm.rows[0].id;

  const cat = await pool.query("INSERT INTO menu_categories (name) VALUES ('قسم-طلبات-مزامنة-جست') RETURNING id");
  const mi = await pool.query("INSERT INTO menu_items (category_id, name) VALUES ($1,'صنف-طلبات-مزامنة-جست') RETURNING id", [cat.rows[0].id]);
  itemId = mi.rows[0].id;
  const v = await pool.query(
    "INSERT INTO menu_item_variants (item_id, label, price, talabat_price) VALUES ($1,'عادي',55,50) RETURNING id",
    [itemId]
  );
  variantId = v.rows[0].id;

  await pool.query(
    `INSERT INTO talabat_product_mapping (branch_id, talabat_item_id, stamoni_menu_item_id, stamoni_variant_id, active, mapping_status)
     VALUES ($1, 'item-jest-1', $2, $3, TRUE, 'MAPPED')`,
    [branchId, itemId, variantId]
  );
});

afterAll(async () => {
  await pool.end();
});

describe("syncNormalizedOrder - المسار الناجح الكامل", () => {
  test("بينشئ أوردر POS حقيقي، يربط talabat_orders 1:1، ويقفل طريقة الدفع تلقائيًا", async () => {
    const normalizedOrder = baseNormalizedOrder();
    const result = await syncNormalizedOrder(normalizedOrder, { raw: "payload" });

    expect(result.status).toBe("IMPORTED");
    expect(result.posOrderId).toBeTruthy();

    const orderRow = await pool.query(
      "SELECT source, branch_id, payment_method_id, talabat_order_id, total FROM orders WHERE id = $1",
      [result.posOrderId]
    );
    expect(orderRow.rows[0].source).toBe("talabat");
    expect(orderRow.rows[0].branch_id).toBe(branchId);
    expect(orderRow.rows[0].payment_method_id).toBe(paymentMethodId);
    expect(orderRow.rows[0].talabat_order_id).toBe(normalizedOrder.talabatOrderId);

    const talabatOrderRow = await pool.query(
      "SELECT pos_order_id, order_status FROM talabat_orders WHERE talabat_order_id = $1",
      [normalizedOrder.talabatOrderId]
    );
    expect(talabatOrderRow.rows[0].pos_order_id).toBe(result.posOrderId);
    expect(talabatOrderRow.rows[0].order_status).toBe("IMPORTED");

    // القفل التلقائي - نفس آلية أي أوردر كاشير عادي، من غير أي كود قفل جديد خاص بطلبات
    const lockLog = await pool.query(
      "SELECT id FROM payment_audit_logs WHERE order_id = $1 AND action_type = 'LOCK'",
      [result.posOrderId]
    );
    expect(lockLog.rows.length).toBeGreaterThanOrEqual(1);
  });

  test("1:1: مزامنة نفس أوردر Talabat مرتين ما بتعملش أوردر POS تاني (ALREADY_IMPORTED)", async () => {
    const normalizedOrder = baseNormalizedOrder();
    const first = await syncNormalizedOrder(normalizedOrder, {});
    expect(first.status).toBe("IMPORTED");

    const second = await syncNormalizedOrder(normalizedOrder, {});
    expect(second.status).toBe("ALREADY_IMPORTED");
    expect(second.posOrderId).toBe(first.posOrderId);

    const count = await pool.query("SELECT COUNT(*) FROM orders WHERE talabat_order_id = $1", [normalizedOrder.talabatOrderId]);
    expect(Number(count.rows[0].count)).toBe(1);
  });
});

describe("syncNormalizedOrder - PREVENT -> DETECT -> AUDIT لكل حالة ربط ناقصة", () => {
  test("فرع Talabat مش مربوط بأي فرع Stamoni - MAPPING_ERROR/BRANCH_UNMAPPED، مفيش أوردر POS", async () => {
    const normalizedOrder = baseNormalizedOrder({ branchExternalId: unmappedBranchExternalId });
    const result = await syncNormalizedOrder(normalizedOrder, {});
    expect(result.status).toBe("MAPPING_ERROR");
    expect(result.reason).toBe("BRANCH_UNMAPPED");

    const orderCount = await pool.query("SELECT COUNT(*) FROM orders WHERE talabat_order_id = $1", [normalizedOrder.talabatOrderId]);
    expect(Number(orderCount.rows[0].count)).toBe(0);

    const errRow = await pool.query(
      "SELECT status FROM talabat_integration_errors WHERE talabat_order_id = $1 AND error_type = 'BRANCH_UNMAPPED'",
      [normalizedOrder.talabatOrderId]
    );
    expect(errRow.rows.length).toBe(1);
    expect(errRow.rows[0].status).toBe("OPEN");
  });

  test("طريقة دفع Talabat مش مربوطة بأي payment_methods.talabat_payment_code - MAPPING_ERROR/PAYMENT_METHOD_UNMAPPED", async () => {
    const normalizedOrder = baseNormalizedOrder({ paymentMethodCode: "UNKNOWN_CODE" });
    const result = await syncNormalizedOrder(normalizedOrder, {});
    expect(result.status).toBe("MAPPING_ERROR");
    expect(result.reason).toBe("PAYMENT_METHOD_UNMAPPED");
    const orderCount = await pool.query("SELECT COUNT(*) FROM orders WHERE talabat_order_id = $1", [normalizedOrder.talabatOrderId]);
    expect(Number(orderCount.rows[0].count)).toBe(0);
  });

  test("صنف Talabat مش مربوط بأي منتج Stamoni - MAPPING_ERROR مرئي، مفيش أوردر جزئي", async () => {
    const normalizedOrder = baseNormalizedOrder({
      items: [{ talabatItemId: "item-not-mapped", talabatSku: null, name: "صنف مش مربوط", quantity: 1, unitPrice: 50, totalPrice: 50 }],
    });
    const result = await syncNormalizedOrder(normalizedOrder, {});
    expect(result.status).toBe("MAPPING_ERROR");
    expect(result.reason).toBe("MAPPING_ERROR");
    expect(result.unmappedItems).toContain("item-not-mapped");

    const orderCount = await pool.query("SELECT COUNT(*) FROM orders WHERE talabat_order_id = $1", [normalizedOrder.talabatOrderId]);
    expect(Number(orderCount.rows[0].count)).toBe(0);

    const talabatOrderRow = await pool.query(
      "SELECT order_status FROM talabat_orders WHERE talabat_order_id = $1",
      [normalizedOrder.talabatOrderId]
    );
    expect(talabatOrderRow.rows[0].order_status).toBe("MAPPING_ERROR");
  });

  test("أوردر مُطبَّع ناقص حقول أساسية - FAILED/NORMALIZED_ORDER_INVALID", async () => {
    const result = await syncNormalizedOrder({ talabatOrderId: nextTalabatOrderId() }, {});
    expect(result.status).toBe("FAILED");
    expect(result.reason).toBe("NORMALIZED_ORDER_INVALID");
  });
});
