// تكامل طلبات (TAL-7): إلغاء أوردر طلبات - بيتحول لأوردر POS لـ'cancelled' عن طريق نفس مسار الاسترجاع
// الوحيد في النظام (voidOrderHandler المُصدَّر من routes/orders.js - عكس مخزون/ولاء/قيد محاسبي كامل)
// أبدًا DELETE على orders. talabat_orders.cancellation_source='TALABAT' و canceled_at بيتسجلوا هنا -
// دليل واضح إن ده إلغاء جاي من طلبات نفسها، مش استرجاع (Void) بادر بيه الكاشير من عنده.
const pool = require("../../db/pool");
const { voidOrderHandler } = require("../../routes/orders");
const { recordIntegrationError, getSystemActor, createCaptureResponse } = require("./talabat-shared");

// النتيجة دايمًا واحدة من: { status: 'CANCELED' | 'ALREADY_CANCELED' | 'FAILED', ... }
async function cancelTalabatOrder(normalizedOrder, rawPayload) {
  const client = await pool.connect();
  try {
    const existing = await client.query(
      "SELECT id, branch_id, pos_order_id, order_status FROM talabat_orders WHERE talabat_order_id = $1",
      [normalizedOrder.talabatOrderId]
    );

    if (existing.rows.length === 0) {
      // إلغاء وصل لأوردر مش متتبّع عندنا خالص (لسه محصلش على أي RECEIVED قبل كده) - مفيش أوردر POS
      // نلغيه، بس ده حالة غريبة تستاهل ظهور واضح مش تجاهل صامت
      await recordIntegrationError(client, {
        talabatOrderId: normalizedOrder.talabatOrderId,
        errorType: "ORPHAN_CANCELLATION",
        errorMessage: `Cancellation received for a Talabat order never tracked locally (talabat_order_id=${normalizedOrder.talabatOrderId})`,
        rawPayload,
      });
      return { status: "FAILED", reason: "ORPHAN_CANCELLATION" };
    }

    const row = existing.rows[0];
    if (row.order_status === "CANCELED") {
      return { status: "ALREADY_CANCELED", posOrderId: row.pos_order_id };
    }

    if (!row.pos_order_id) {
      // لسه ملوش أوردر POS خالص (كان MAPPING_ERROR/FAILED/RECEIVED) - مفيش أوردر نلغيه، بس نسجل الإلغاء
      // على صف التتبّع نفسه عشان أي إعادة محاولة (retry) لاحقة تعرف توقف بدل ما تنشئ أوردر لطلب اتلغى فعلًا
      await client.query(
        `UPDATE talabat_orders SET order_status = 'CANCELED', canceled_at = now(), cancellation_source = 'TALABAT', updated_at = now()
         WHERE id = $1`,
        [row.id]
      );
      return { status: "CANCELED", posOrderId: null };
    }

    const posOrderRow = await client.query("SELECT status FROM orders WHERE id = $1", [row.pos_order_id]);
    if (posOrderRow.rows.length === 0) {
      await recordIntegrationError(client, {
        talabatOrderId: normalizedOrder.talabatOrderId,
        branchId: row.branch_id,
        errorType: "ORPHAN_CANCELLATION",
        errorMessage: `talabat_orders.pos_order_id=${row.pos_order_id} references a non-existent order`,
        rawPayload,
      });
      return { status: "FAILED", reason: "POS_ORDER_MISSING" };
    }

    if (posOrderRow.rows[0].status !== "cancelled") {
      const systemActor = await getSystemActor(client);
      const { res, getStatusCode, getBody } = createCaptureResponse();
      await voidOrderHandler(
        { user: systemActor, params: { id: row.pos_order_id }, body: { reason: "إلغاء من Talabat" } },
        res
      );
      const statusCode = getStatusCode();
      if (statusCode < 200 || statusCode >= 300) {
        await recordIntegrationError(client, {
          talabatOrderId: normalizedOrder.talabatOrderId,
          branchId: row.branch_id,
          errorType: "TALABAT_CANCELLATION_FAILED",
          errorMessage: `voidOrderHandler failed (status ${statusCode}): ${getBody()?.error || "unknown error"}`,
          rawPayload,
        });
        return { status: "FAILED", reason: "TALABAT_CANCELLATION_FAILED", details: getBody()?.error };
      }
    }

    await client.query(
      `UPDATE talabat_orders SET order_status = 'CANCELED', canceled_at = now(), cancellation_source = 'TALABAT', updated_at = now()
       WHERE id = $1`,
      [row.id]
    );
    return { status: "CANCELED", posOrderId: row.pos_order_id };
  } finally {
    client.release();
  }
}

module.exports = { cancelTalabatOrder };
