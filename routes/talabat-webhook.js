// تكامل طلبات (Talabat Partner API) - نقطة استقبال الـwebhook. محمي بتوقيع HMAC (زي واتساب،
// راجع services/talabat/talabat-webhook-auth.js) مش بتسجيل دخول موظف - مفيش قبول مجهول الهوية.
//
// الأمان (idempotency) هنا طبقتين: (1) dedupe_key = sha256(الجسم الخام) بيمسك أي إعادة إرسال حرفية
// لنفس الحدث فورًا من غير ما نحتاج نعرف شكل حقول Talabat الحقيقية، (2) لما يتفعّل adapter الحقيقي
// (services/talabat/talabat-payload-adapter.js)، القيد UNIQUE على talabat_orders.talabat_order_id
// (من TAL-1) هيمنع structurally إنشاء أوردر POS تاني لنفس أوردر Talabat حتى لو الطبقة الأولى فاتت حالة
// إعادة إرسال مش متطابقة بايت لبايت. الاتنين مع بعض = مفيش أوردر POS مكرر من حدث واحد حقيقي.
const express = require("express");
const router = express.Router();
const crypto = require("crypto");
const pool = require("../db/pool");
const webhookAuth = require("../services/talabat/talabat-webhook-auth");
const payloadAdapter = require("../services/talabat/talabat-payload-adapter");
const { syncNormalizedOrder } = require("../services/talabat/talabat-order-sync");

async function recordIntegrationError(client, { talabatOrderId = null, branchId = null, errorType, errorMessage, rawPayload = null }) {
  await client.query(
    `INSERT INTO talabat_integration_errors (talabat_order_id, branch_id, error_type, error_message, raw_payload)
     VALUES ($1, $2, $3, $4, $5)`,
    [talabatOrderId, branchId, errorType, errorMessage, rawPayload ? JSON.stringify(rawPayload) : null]
  );
}

// POST /api/talabat/webhook/orders - إشعارات أوردرات جديدة/متعدّلة من Talabat
router.post("/webhook/orders", async (req, res) => {
  if (!webhookAuth.isConfigured()) {
    // ما فيش secret متسجل = التكامل لسه مش مُفعّل - رفض واضح، مش قبول صامت مجهول الهوية
    return res.status(503).json({ error: "TALABAT_NOT_CONFIGURED" });
  }

  const signature = req.headers[webhookAuth.signatureHeaderName()];
  if (!webhookAuth.verifySignature(req.rawBody, signature)) {
    return res.sendStatus(401);
  }

  const rawPayload = req.body;
  const dedupeKey = crypto.createHash("sha256").update(req.rawBody || Buffer.from(JSON.stringify(rawPayload))).digest("hex");

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const inserted = await client.query(
      `INSERT INTO talabat_webhook_events (dedupe_key, raw_payload, source_ip, processing_status)
       VALUES ($1, $2, $3, 'RECEIVED')
       ON CONFLICT (dedupe_key) DO NOTHING
       RETURNING id`,
      [dedupeKey, JSON.stringify(rawPayload), req.ip]
    );

    if (inserted.rows.length === 0) {
      // نفس الحدث اتبعت قبل كده حرفيًا - إقرار بدون إعادة معالجة (idempotent)
      await client.query("COMMIT");
      return res.status(200).json({ status: "duplicate" });
    }

    const webhookEventId = inserted.rows[0].id;

    let normalizedOrder;
    try {
      normalizedOrder = payloadAdapter.normalizeTalabatOrderPayload(rawPayload);
    } catch (adapterErr) {
      await client.query(
        `UPDATE talabat_webhook_events SET processing_status = 'FAILED', error_message = $2 WHERE id = $1`,
        [webhookEventId, adapterErr.message]
      );
      await recordIntegrationError(client, {
        errorType: adapterErr.code || "PAYLOAD_ADAPTER_ERROR",
        errorMessage: adapterErr.message,
        rawPayload,
      });
      await client.query("COMMIT");
      // بنرد 200 (استلمنا فعليًا وسجّلنا الفشل بشكل دائم في talabat_integration_errors - مش هنعتمد على
      // إعادة إرسال Talabat لحل المشكلة، آلية retry بتاعتنا هي اللي هتعالج ده - TAL-7)
      return res.status(200).json({ status: "received", processing: "FAILED", error: adapterErr.code || "PAYLOAD_ADAPTER_ERROR" });
    }

    await client.query(
      `UPDATE talabat_webhook_events SET processing_status = 'PROCESSED', talabat_order_id = $2, event_type = $3 WHERE id = $1`,
      [webhookEventId, normalizedOrder.talabatOrderId, normalizedOrder.orderStatus || "UNKNOWN"]
    );
    await client.query("COMMIT");

    // محرك المزامنة (services/talabat/talabat-order-sync.js) بيفتح اتصالاته الخاصة (بيستدعي
    // createOrderHandler اللي بيدير transaction مستقل بالكامل) - عمدًا برّه transaction الاستلام فوق،
    // نتيجته دايمًا واحدة من IMPORTED/ALREADY_IMPORTED/MAPPING_ERROR/FAILED، أبدًا نجاح صامت
    const syncResult = await syncNormalizedOrder(normalizedOrder, rawPayload);
    return res.status(200).json({ status: "received", processing: "PROCESSED", sync: syncResult });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("talabat webhook processing error:", err.message);
    return res.status(500).json({ error: "TALABAT_WEBHOOK_PROCESSING_FAILED" });
  } finally {
    client.release();
  }
});

module.exports = router;
