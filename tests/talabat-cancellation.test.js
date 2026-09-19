// TAL-7: إلغاء أوردر طلبات - بيحوّل الحالة بس (status='cancelled'، voided=TRUE) عبر نفس مسار الاسترجاع
// الوحيد في النظام (لازم يعكس المخزون فعليًا)، أبدًا مش DELETE. cancellation_source='TALABAT' بيتسجل
// على صف التتبّع (talabat_orders) - دليل واضح إن الإلغاء ده جاي من طلبات نفسها مش من قرار كاشير.
const { pool } = require("./helpers");
const { syncNormalizedOrder } = require("../services/talabat/talabat-order-sync");
const { cancelTalabatOrder } = require("../services/talabat/talabat-cancellation");

let branchId;
let paymentMethodId;
let itemId, variantId;
let counter = 0;

function nextTalabatOrderId() {
  counter += 1;
  return `TAL-CANCEL-JEST-${counter}`;
}

function baseNormalizedOrder(overrides = {}) {
  return {
    talabatOrderId: nextTalabatOrderId(),
    talabatExternalOrderId: null,
    talabatOrderCode: null,
    branchExternalId: "store-cancel-jest-1",
    orderStatus: "NEW",
    orderType: "delivery",
    paymentMethodCode: "TALABAT_CANCEL_CREDIT",
    subtotal: 80,
    deliveryFee: 0,
    discount: 0,
    total: 80,
    currency: "EGP",
    items: [{ talabatItemId: "cancel-item-1", talabatSku: null, name: "صنف", quantity: 1, unitPrice: 80, totalPrice: 80 }],
    customer: null,
    receivedAt: new Date().toISOString(),
    ...overrides,
  };
}

beforeAll(async () => {
  const b = await pool.query(
    "INSERT INTO branches (name, talabat_branch_id) VALUES ('فرع-طلبات-إلغاء-جست', 'store-cancel-jest-1') RETURNING id"
  );
  branchId = b.rows[0].id;

  const pm = await pool.query(
    "INSERT INTO payment_methods (name, kind, enabled, talabat_payment_code) VALUES ('طلبات-إلغاء-جست','credit',TRUE,'TALABAT_CANCEL_CREDIT') RETURNING id"
  );
  paymentMethodId = pm.rows[0].id;

  const cat = await pool.query("INSERT INTO menu_categories (name) VALUES ('قسم-طلبات-إلغاء-جست') RETURNING id");
  const mi = await pool.query("INSERT INTO menu_items (category_id, name) VALUES ($1,'صنف-طلبات-إلغاء-جست') RETURNING id", [cat.rows[0].id]);
  itemId = mi.rows[0].id;
  const v = await pool.query(
    "INSERT INTO menu_item_variants (item_id, label, price, talabat_price) VALUES ($1,'عادي',80,80) RETURNING id",
    [itemId]
  );
  variantId = v.rows[0].id;

  await pool.query(
    `INSERT INTO talabat_product_mapping (branch_id, talabat_item_id, stamoni_menu_item_id, stamoni_variant_id, active, mapping_status)
     VALUES ($1, 'cancel-item-1', $2, $3, TRUE, 'MAPPED')`,
    [branchId, itemId, variantId]
  );
});

afterAll(async () => {
  await pool.end();
});

describe("cancelTalabatOrder - أوردر مستورد فعليًا (pos_order_id موجود)", () => {
  test("بيحوّل الأوردر لـ'cancelled' من غير DELETE، ويسجل cancellation_source=TALABAT", async () => {
    const normalizedOrder = baseNormalizedOrder();
    const importResult = await syncNormalizedOrder(normalizedOrder, {});
    expect(importResult.status).toBe("IMPORTED");

    const cancelResult = await cancelTalabatOrder({ ...normalizedOrder, orderStatus: "CANCELED" }, {});
    expect(cancelResult.status).toBe("CANCELED");
    expect(cancelResult.posOrderId).toBe(importResult.posOrderId);

    // أبدًا مش DELETE - الصف لسه موجود، بس status اتغيّر
    const orderRow = await pool.query("SELECT status, voided, total FROM orders WHERE id = $1", [importResult.posOrderId]);
    expect(orderRow.rows.length).toBe(1);
    expect(orderRow.rows[0].status).toBe("cancelled");
    expect(orderRow.rows[0].voided).toBe(true);
    expect(Number(orderRow.rows[0].total)).toBeCloseTo(80, 5); // المبلغ الأصلي محفوظ زي ما هو

    const talabatOrderRow = await pool.query(
      "SELECT order_status, cancellation_source, canceled_at FROM talabat_orders WHERE talabat_order_id = $1",
      [normalizedOrder.talabatOrderId]
    );
    expect(talabatOrderRow.rows[0].order_status).toBe("CANCELED");
    expect(talabatOrderRow.rows[0].cancellation_source).toBe("TALABAT");
    expect(talabatOrderRow.rows[0].canceled_at).toBeTruthy();
  });

  test("idempotent - إلغاء نفس الأوردر مرتين بيرجع ALREADY_CANCELED في المرة التانية", async () => {
    const normalizedOrder = baseNormalizedOrder();
    await syncNormalizedOrder(normalizedOrder, {});
    const first = await cancelTalabatOrder({ ...normalizedOrder, orderStatus: "CANCELED" }, {});
    expect(first.status).toBe("CANCELED");
    const second = await cancelTalabatOrder({ ...normalizedOrder, orderStatus: "CANCELED" }, {});
    expect(second.status).toBe("ALREADY_CANCELED");
  });
});

describe("cancelTalabatOrder - حالات لسه محصلتش على أوردر POS", () => {
  test("أوردر MAPPING_ERROR (pos_order_id فاضي) - بيتسجل CANCELED على صف التتبّع بس، مفيش أوردر يتلغي", async () => {
    const normalizedOrder = baseNormalizedOrder({
      items: [{ talabatItemId: "cancel-item-not-mapped", talabatSku: null, name: "صنف", quantity: 1, unitPrice: 80, totalPrice: 80 }],
    });
    const importResult = await syncNormalizedOrder(normalizedOrder, {});
    expect(importResult.status).toBe("MAPPING_ERROR");

    const cancelResult = await cancelTalabatOrder({ ...normalizedOrder, orderStatus: "CANCELED" }, {});
    expect(cancelResult.status).toBe("CANCELED");
    expect(cancelResult.posOrderId).toBeNull();

    const talabatOrderRow = await pool.query(
      "SELECT order_status FROM talabat_orders WHERE talabat_order_id = $1",
      [normalizedOrder.talabatOrderId]
    );
    expect(talabatOrderRow.rows[0].order_status).toBe("CANCELED");
  });

  test("إلغاء لأوردر Talabat مش متتبّع خالص - FAILED/ORPHAN_CANCELLATION، بيتسجل Integration Error مرئي", async () => {
    const normalizedOrder = baseNormalizedOrder();
    const result = await cancelTalabatOrder({ ...normalizedOrder, orderStatus: "CANCELED" }, {});
    expect(result.status).toBe("FAILED");
    expect(result.reason).toBe("ORPHAN_CANCELLATION");

    const errRow = await pool.query(
      "SELECT status FROM talabat_integration_errors WHERE talabat_order_id = $1 AND error_type = 'ORPHAN_CANCELLATION'",
      [normalizedOrder.talabatOrderId]
    );
    expect(errRow.rows.length).toBe(1);
    expect(errRow.rows[0].status).toBe("OPEN");
  });
});
