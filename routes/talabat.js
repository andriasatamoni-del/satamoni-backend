// تكامل طلبات (Talabat Partner API) - شاشات الإدارة/التقارير (مش استقبال الـwebhook نفسه، ده في
// routes/talabat-webhook.js). محمي بتسجيل دخول موظف حقيقي + صلاحيات talabat.* (راجع middleware/permissions.js).
const express = require("express");
const router = express.Router();
const pool = require("../db/pool");
const { requireAuth } = require("../middleware/auth");
const { requirePermission } = require("../middleware/permissions");
const { validateIdParam } = require("../middleware/validate-id-param");
const payloadAdapter = require("../services/talabat/talabat-payload-adapter");
const { syncNormalizedOrder } = require("../services/talabat/talabat-order-sync");
const { cancelTalabatOrder } = require("../services/talabat/talabat-cancellation");
const { runDailyReconciliation } = require("../services/talabat/talabat-reconciliation");
const { getCairoBusinessDate } = require("../db/business-date");

router.use(requireAuth);
router.param("id", validateIdParam);

// GET /api/talabat/integration-errors - شاشة "Integration Errors" (رؤية بس)
router.get("/integration-errors", requirePermission("talabat.view"), async (req, res) => {
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
router.post("/integration-errors/:id/retry", requirePermission("talabat.retry"), async (req, res) => {
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

// GET /api/talabat/reconciliation?branchId=&from=&to= - المطابقة اليومية (TAL-8). status='COMPLETED'
// بس لو فعليًا قارنّا بسجلات Talabat الحقيقية (getOrderHistory) - غير كده status='TALABAT_API_NOT_CONFIGURED'
// (بيرجع برضو سجلات Stamoni المحلية للمراجعة اليدوية لحد ما التكامل الحقيقي يتفعّل)
router.get("/reconciliation", requirePermission("talabat.reconciliation"), async (req, res) => {
  const to = req.query.to || getCairoBusinessDate();
  const from = req.query.from || to;
  const branchId = req.query.branchId ? Number(req.query.branchId) : null;
  try {
    const result = await runDailyReconciliation({ branchId, from, to });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
