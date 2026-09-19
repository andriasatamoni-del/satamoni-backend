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
const { requireAuth } = require("../middleware/auth");
const { requirePermission } = require("../middleware/permissions");
const { validateIdParam } = require("../middleware/validate-id-param");
const webhookAuth = require("../services/talabat/talabat-webhook-auth");
const payloadAdapter = require("../services/talabat/talabat-payload-adapter");
const { syncNormalizedOrder } = require("../services/talabat/talabat-order-sync");
const { cancelTalabatOrder } = require("../services/talabat/talabat-cancellation");
const { recordIntegrationError } = require("../services/talabat/talabat-shared");

router.param("id", validateIdParam);

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

    // محركات المزامنة/الإلغاء (services/talabat/talabat-order-sync.js و talabat-cancellation.js) بتفتح
    // اتصالاتها الخاصة (بتستدعي createOrderHandler/voidOrderHandler اللي بيديروا transaction مستقل
    // بالكامل) - عمدًا برّه transaction الاستلام فوق. الإلغاء أبدًا مش DELETE - تحويل حالة بس (TAL-7)
    const isCancellation = String(normalizedOrder.orderStatus || "").toUpperCase() === "CANCELED";
    const syncResult = isCancellation
      ? await cancelTalabatOrder(normalizedOrder, rawPayload)
      : await syncNormalizedOrder(normalizedOrder, rawPayload);
    return res.status(200).json({ status: "received", processing: "PROCESSED", sync: syncResult });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("talabat webhook processing error:", err.message);
    return res.status(500).json({ error: "TALABAT_WEBHOOK_PROCESSING_FAILED" });
  } finally {
    client.release();
  }
});

// GET /api/talabat/integration-errors - شاشة "Integration Errors" (رؤية بس)
router.get("/integration-errors", requireAuth, requirePermission("talabat.view"), async (req, res) => {
  const { status, branchId } = req.query;
  const conditions = [];
  const values = [];
  let i = 1;
  if (status) { conditions.push(`status = $${i++}`); values.push(status); }
  if (branchId) { conditions.push(`branch_id = $${i++}`); values.push(branchId); }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  try {
    const result = await pool.query(
      `SELECT * FROM talabat_integration_errors ${where} ORDER BY created_at DESC LIMIT 500`,
      values
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/talabat/integration-errors/:id/retry - إعادة محاولة استيراد/إلغاء فشل (TAL-7). بيعيد تشغيل
// نفس البايبلاين اللي فشل بالظبط (adapter -> sync/cancel) على raw_payload المحفوظ - مش منطق منفصل.
// النتيجة هتفشل بنفس NOT_IMPLEMENTED لحد ما adapter الحقيقي يتنفّذ، وده متوقع ومقصود مش باج: الآلية هنا
// هي البنية (retry_count/last_retry_at/status) اللي هتشتغل فورًا بمجرد ما الـadapter يتوصّل.
router.post("/integration-errors/:id/retry", requireAuth, requirePermission("talabat.retry"), async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const errRow = await client.query(
      "SELECT * FROM talabat_integration_errors WHERE id = $1 FOR UPDATE",
      [req.params.id]
    );
    if (errRow.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "الخطأ غير موجود" });
    }
    const errorRow = errRow.rows[0];
    if (!["OPEN", "RETRYING"].includes(errorRow.status)) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: `الخطأ ده حالته "${errorRow.status}" - مش قابل لإعادة المحاولة` });
    }

    await client.query(
      `UPDATE talabat_integration_errors SET retry_count = retry_count + 1, last_retry_at = now(), status = 'RETRYING' WHERE id = $1`,
      [errorRow.id]
    );
    await client.query("COMMIT");

    let normalizedOrder;
    try {
      normalizedOrder = payloadAdapter.normalizeTalabatOrderPayload(errorRow.raw_payload);
    } catch (adapterErr) {
      await pool.query(
        `UPDATE talabat_integration_errors SET status = 'OPEN', error_message = $2 WHERE id = $1`,
        [errorRow.id, adapterErr.message]
      );
      return res.status(200).json({ status: "RETRY_FAILED", stage: "ADAPTER", error: adapterErr.code || adapterErr.message });
    }

    const isCancellation = String(normalizedOrder.orderStatus || "").toUpperCase() === "CANCELED";
    const retryResult = isCancellation
      ? await cancelTalabatOrder(normalizedOrder, errorRow.raw_payload)
      : await syncNormalizedOrder(normalizedOrder, errorRow.raw_payload);

    const resolvedStates = ["IMPORTED", "ALREADY_IMPORTED", "CANCELED", "ALREADY_CANCELED"];
    if (resolvedStates.includes(retryResult.status)) {
      await pool.query(
        `UPDATE talabat_integration_errors SET status = 'RESOLVED', resolved_by = $1, resolved_at = now() WHERE id = $2`,
        [req.user.id, errorRow.id]
      );
    } else {
      await pool.query(`UPDATE talabat_integration_errors SET status = 'OPEN' WHERE id = $1`, [errorRow.id]);
    }
    return res.status(200).json({ status: "RETRY_ATTEMPTED", result: retryResult });
  } catch (err) {
    await client.query("ROLLBACK");
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

module.exports = router;
