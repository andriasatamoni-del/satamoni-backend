// تكامل طلبات (TAL-5): محرك المزامنة - أوردر مُطبَّع (NormalizedTalabatOrder، راجع
// talabat-payload-adapter.js) بيتحول لأوردر POS حقيقي عن طريق نفس المحرك اللي الكاشير بيستخدمه بالظبط
// (createOrderHandler المُصدَّر من routes/orders.js - خصم مخزون/وصفة، قفل دفع، كل حاجة) - مفيش نسخة
// تانية موازية من منطق الأوردر هنا خالص.
//
// طريقة الدفع من Talabat هي مصدر الحقيقة: بتتحل هنا لـpayment_methods.id حقيقي عبر
// payment_methods.talabat_payment_code وبتتبعت لـcreateOrderHandler زي أي paymentMethodId عادي - يعني
// الأوردر بياخد نفس قفل الدفع (lockPaymentForOrder) اللي أي أوردر كاشير بياخده تلقائيًا، من غير كود قفل
// جديد. الكاشير مش بيدخل طريقة الدفع دي من أي شاشة - القفل الموجود بالفعل هو اللي بيمنع تغييرها بعد كده.
const pool = require("../../db/pool");
const { createOrderHandler } = require("../../routes/orders");
const { validateNormalizedOrder } = require("./talabat-payload-adapter");

const SYSTEM_ACTOR_EMAIL = "talabat-integration@system.internal";

class TalabatSyncError extends Error {
  constructor(message, errorType) {
    super(message);
    this.name = "TalabatSyncError";
    this.errorType = errorType;
  }
}

async function recordIntegrationError(client, { talabatOrderId, branchId = null, errorType, errorMessage, rawPayload = null }) {
  await client.query(
    `INSERT INTO talabat_integration_errors (talabat_order_id, branch_id, error_type, error_message, raw_payload)
     VALUES ($1, $2, $3, $4, $5)`,
    [talabatOrderId, branchId, errorType, errorMessage, rawPayload ? JSON.stringify(rawPayload) : null]
  );
}

async function getSystemActor(client) {
  const result = await client.query(
    "SELECT id, role, branch_id FROM users WHERE email = $1 AND is_active = TRUE",
    [SYSTEM_ACTOR_EMAIL]
  );
  if (result.rows.length === 0) {
    throw new Error(
      "Talabat system actor user not found (talabat-integration@system.internal) - run db migrations"
    );
  }
  const row = result.rows[0];
  return { id: row.id, role: row.role, branchId: row.branch_id };
}

// Captures createOrderHandler's res.status(code).json(body) calls without a real HTTP response -
// createOrderHandler's calling convention (res.status().json()) is unchanged from before TAL-2's
// export, so this harness is the ONLY new surface, not a rewrite of the handler itself.
function createCaptureResponse() {
  let statusCode = 200;
  let body = null;
  const res = {
    status(code) {
      statusCode = code;
      return res;
    },
    json(payload) {
      body = payload;
      return res;
    },
  };
  return { res, getStatusCode: () => statusCode, getBody: () => body };
}

async function upsertTalabatOrderRow(client, { normalizedOrder, rawPayload, branchId, orderStatus }) {
  const existing = await client.query(
    "SELECT id, pos_order_id, order_status FROM talabat_orders WHERE talabat_order_id = $1",
    [normalizedOrder.talabatOrderId]
  );
  if (existing.rows.length > 0) {
    const row = existing.rows[0];
    if (row.pos_order_id) {
      return { id: row.id, posOrderId: row.pos_order_id, alreadyImported: true };
    }
    await client.query(
      `UPDATE talabat_orders SET order_status = $2, branch_id = $3, raw_payload = $4, updated_at = now()
       WHERE id = $1`,
      [row.id, orderStatus, branchId, JSON.stringify(rawPayload)]
    );
    return { id: row.id, posOrderId: null, alreadyImported: false };
  }
  const inserted = await client.query(
    `INSERT INTO talabat_orders
       (branch_id, talabat_order_id, talabat_external_order_id, talabat_order_code, order_status,
        order_type, payment_method, subtotal, delivery_fee, discount, total, currency, raw_payload)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     RETURNING id`,
    [
      branchId,
      normalizedOrder.talabatOrderId,
      normalizedOrder.talabatExternalOrderId || null,
      normalizedOrder.talabatOrderCode || null,
      orderStatus,
      normalizedOrder.orderType || null,
      normalizedOrder.paymentMethodCode,
      normalizedOrder.subtotal ?? null,
      normalizedOrder.deliveryFee ?? null,
      normalizedOrder.discount ?? null,
      normalizedOrder.total,
      normalizedOrder.currency || "EGP",
      JSON.stringify(rawPayload),
    ]
  );
  return { id: inserted.rows[0].id, posOrderId: null, alreadyImported: false };
}

// النتيجة دايمًا واحدة من: { status: 'ALREADY_IMPORTED' | 'MAPPING_ERROR' | 'IMPORTED' | 'FAILED', ... }
// - أبدًا نجاح صامت. أي فشل بيتسجل كـtalabat_integration_errors مرئي (TAL-7 هيبني إعادة المحاولة عليه).
async function syncNormalizedOrder(normalizedOrder, rawPayload) {
  const validationErrors = validateNormalizedOrder(normalizedOrder);
  if (validationErrors.length > 0) {
    const client = await pool.connect();
    try {
      await recordIntegrationError(client, {
        talabatOrderId: normalizedOrder?.talabatOrderId || null,
        errorType: "NORMALIZED_ORDER_INVALID",
        errorMessage: `Normalized order failed validation: ${validationErrors.join("; ")}`,
        rawPayload,
      });
    } finally {
      client.release();
    }
    return { status: "FAILED", reason: "NORMALIZED_ORDER_INVALID", details: validationErrors };
  }

  const lookupClient = await pool.connect();
  let branchId;
  try {
    const branchRow = await lookupClient.query(
      "SELECT id FROM branches WHERE talabat_branch_id = $1",
      [normalizedOrder.branchExternalId]
    );
    if (branchRow.rows.length === 0) {
      // talabat_orders.branch_id NOT NULL - مفيش فرع معروف يعني مفيش صف tracking ممكن نعمله أصلًا هنا،
      // الـIntegration Error وحده هو اللي بيدي المرئية المطلوبة للحالة المبكرة دي
      await recordIntegrationError(lookupClient, {
        talabatOrderId: normalizedOrder.talabatOrderId,
        errorType: "BRANCH_UNMAPPED",
        errorMessage: `No branch mapped to Talabat store id "${normalizedOrder.branchExternalId}" - map it in branches.talabat_branch_id`,
        rawPayload,
      });
      return { status: "MAPPING_ERROR", reason: "BRANCH_UNMAPPED" };
    }
    branchId = branchRow.rows[0].id;

    // 1:1 و idempotency: لو الأوردر ده اتستورد بالفعل (pos_order_id موجود)، منعمل حاجة تانية خالص
    const existingRow = await lookupClient.query(
      "SELECT id, pos_order_id FROM talabat_orders WHERE talabat_order_id = $1",
      [normalizedOrder.talabatOrderId]
    );
    if (existingRow.rows.length > 0 && existingRow.rows[0].pos_order_id) {
      return { status: "ALREADY_IMPORTED", posOrderId: existingRow.rows[0].pos_order_id };
    }

    const paymentMethodRow = await lookupClient.query(
      "SELECT id FROM payment_methods WHERE talabat_payment_code = $1",
      [normalizedOrder.paymentMethodCode]
    );
    if (paymentMethodRow.rows.length === 0) {
      await recordIntegrationError(lookupClient, {
        talabatOrderId: normalizedOrder.talabatOrderId,
        branchId,
        errorType: "PAYMENT_METHOD_UNMAPPED",
        errorMessage: `No payment method mapped to Talabat payment code "${normalizedOrder.paymentMethodCode}" - map it in payment_methods.talabat_payment_code`,
        rawPayload,
      });
      await upsertTalabatOrderRow(lookupClient, { normalizedOrder, rawPayload, branchId, orderStatus: "MAPPING_ERROR" });
      return { status: "MAPPING_ERROR", reason: "PAYMENT_METHOD_UNMAPPED" };
    }
    const paymentMethodId = paymentMethodRow.rows[0].id;

    const unmappedItems = [];
    const mappedItems = [];
    for (const item of normalizedOrder.items) {
      const mapRow = await lookupClient.query(
        `SELECT stamoni_menu_item_id, stamoni_variant_id, mapping_status
         FROM talabat_product_mapping
         WHERE branch_id = $1 AND talabat_item_id = $2 AND active = TRUE`,
        [branchId, item.talabatItemId]
      );
      const mapping = mapRow.rows[0];
      if (!mapping || mapping.mapping_status !== "MAPPED" || !mapping.stamoni_menu_item_id || !mapping.stamoni_variant_id) {
        unmappedItems.push(item.talabatItemId);
        continue;
      }
      mappedItems.push({
        itemId: mapping.stamoni_menu_item_id,
        variantId: mapping.stamoni_variant_id,
        quantity: item.quantity,
        modifiers: [],
        excludedIngredientItemIds: [],
      });
    }
    if (unmappedItems.length > 0) {
      await recordIntegrationError(lookupClient, {
        talabatOrderId: normalizedOrder.talabatOrderId,
        branchId,
        errorType: "MAPPING_ERROR",
        errorMessage: `Unmapped Talabat item id(s): ${unmappedItems.join(", ")} - map them in talabat_product_mapping`,
        rawPayload,
      });
      await upsertTalabatOrderRow(lookupClient, { normalizedOrder, rawPayload, branchId, orderStatus: "MAPPING_ERROR" });
      return { status: "MAPPING_ERROR", reason: "MAPPING_ERROR", unmappedItems };
    }

    await upsertTalabatOrderRow(lookupClient, { normalizedOrder, rawPayload, branchId, orderStatus: "RECEIVED" });

    const systemActor = await getSystemActor(lookupClient);
    const orderType = String(normalizedOrder.orderType || "").toLowerCase().includes("pickup") ? "takeaway" : "delivery";

    const { res, getStatusCode, getBody } = createCaptureResponse();
    const syntheticReq = {
      user: systemActor,
      body: {
        source: "talabat",
        orderType,
        branchId,
        paymentMethodId,
        items: mappedItems,
        deliveryFee: normalizedOrder.deliveryFee || 0,
        discount: normalizedOrder.discount || 0,
        talabatOrderId: normalizedOrder.talabatOrderId,
        talabatCashCollected: 0,
        idempotencyKey: `talabat:${normalizedOrder.talabatOrderId}`,
      },
    };
    await createOrderHandler(syntheticReq, res);

    const statusCode = getStatusCode();
    const body = getBody();
    if (statusCode >= 200 && statusCode < 300 && body?.orderId) {
      await lookupClient.query(
        "UPDATE talabat_orders SET pos_order_id = $2, order_status = 'IMPORTED', accepted_at = now(), updated_at = now() WHERE talabat_order_id = $1",
        [normalizedOrder.talabatOrderId, body.orderId]
      );
      return { status: "IMPORTED", posOrderId: body.orderId };
    }

    await recordIntegrationError(lookupClient, {
      talabatOrderId: normalizedOrder.talabatOrderId,
      branchId,
      errorType: "TALABAT_ORDER_FAILED",
      errorMessage: `POS order creation failed (status ${statusCode}): ${body?.error || "unknown error"}`,
      rawPayload,
    });
    await lookupClient.query(
      "UPDATE talabat_orders SET order_status = 'FAILED', updated_at = now() WHERE talabat_order_id = $1",
      [normalizedOrder.talabatOrderId]
    );
    return { status: "FAILED", reason: "TALABAT_ORDER_FAILED", details: body?.error };
  } finally {
    lookupClient.release();
  }
}

module.exports = { syncNormalizedOrder, TalabatSyncError, SYSTEM_ACTOR_EMAIL };
