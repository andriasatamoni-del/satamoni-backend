// تكامل طلبات (Talabat Partner API) - شاشات الإدارة/التقارير (مش استقبال الـwebhook نفسه، ده في
// routes/talabat-webhook.js). محمي بتسجيل دخول موظف حقيقي + صلاحيات talabat.* (راجع middleware/permissions.js).
const express = require("express");
const router = express.Router();
const pool = require("../db/pool");
const { requireAuth, assertOwnBranch } = require("../middleware/auth");
const { requirePermission } = require("../middleware/permissions");
const { validateIdParam } = require("../middleware/validate-id-param");
const payloadAdapter = require("../services/talabat/talabat-payload-adapter");
const { syncNormalizedOrder } = require("../services/talabat/talabat-order-sync");
const { cancelTalabatOrder } = require("../services/talabat/talabat-cancellation");
const { runDailyReconciliation } = require("../services/talabat/talabat-reconciliation");
const talabatClient = require("../services/talabat/talabat-client");
const { getCairoBusinessDate } = require("../db/business-date");

router.use(requireAuth);
router.param("id", validateIdParam);

// أدمن من غير branchId = كل الفروع (null). أي دور تاني لازم فرعه هو أو فرع صريح يمر بـassertOwnBranch -
// نفس فلسفة routes/payment-control.js resolveBranchScope بالظبط
function resolveBranchScope(req) {
  const requested = req.query.branchId;
  if (requested !== undefined && requested !== null && requested !== "") {
    if (!assertOwnBranch(req.user, requested)) {
      const err = new Error("معندكش صلاحية على فرع تاني");
      err.code = "FORBIDDEN_BRANCH";
      throw err;
    }
    return Number(requested);
  }
  return req.user.role === "admin" ? null : req.user.branchId || null;
}

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

// GET /api/talabat/dashboard-summary?branchId=&date= - لوحة تحكم التكامل (TAL-9): حالة الاتصال الصادقة
// (مش "CONNECTED" كاذبة من غير أي نداء حقيقي ناجح فعلًا)، أوردرات اليوم حسب الحالة، ملخص طرق الدفع،
// وآخر الاستثناءات المفتوحة.
router.get("/dashboard-summary", requirePermission("talabat.view"), async (req, res) => {
  let branchId;
  try { branchId = resolveBranchScope(req); } catch (err) { return res.status(403).json({ error: err.message }); }
  const date = req.query.date || getCairoBusinessDate();

  // isConfigured()=true لسه معناه "الإعدادات متسجلة"، مش "اتأكدنا من نداء حقيقي ناجح" - غير كده معندناش
  // client حقيقي يشتغل (getAccessToken لسه NOT_IMPLEMENTED) فمينفعش CONNECTED تتقال أبدًا دلوقتي
  const connectionStatus = talabatClient.isConfigured() ? "CONFIGURED_UNVERIFIED" : "NOT_CONFIGURED";

  try {
    const branchCondition = branchId ? "AND branch_id = $2" : "";
    const dateValues = branchId ? [date, branchId] : [date];

    const ordersByStatus = await pool.query(
      `SELECT order_status, COUNT(*)::int AS count
       FROM talabat_orders
       WHERE (received_at AT TIME ZONE 'Africa/Cairo')::date = $1 ${branchCondition}
       GROUP BY order_status`,
      dateValues
    );

    const paymentSummary = await pool.query(
      `SELECT payment_method, COUNT(*)::int AS count, COALESCE(SUM(total), 0) AS total_amount
       FROM talabat_orders
       WHERE (received_at AT TIME ZONE 'Africa/Cairo')::date = $1 ${branchCondition}
       GROUP BY payment_method`,
      dateValues
    );

    const exceptionsConditions = ["status = 'OPEN'"];
    const exceptionsValues = [];
    if (branchId) { exceptionsConditions.push(`branch_id = $${exceptionsValues.length + 1}`); exceptionsValues.push(branchId); }
    const exceptions = await pool.query(
      `SELECT * FROM talabat_integration_errors WHERE ${exceptionsConditions.join(" AND ")} ORDER BY created_at DESC LIMIT 100`,
      exceptionsValues
    );

    const counts = { RECEIVED: 0, MAPPING_ERROR: 0, IMPORTED: 0, FAILED: 0, CANCELED: 0 };
    for (const row of ordersByStatus.rows) counts[row.order_status] = row.count;

    res.json({
      connectionStatus,
      date,
      ordersToday: counts,
      paymentSummary: paymentSummary.rows.map((r) => ({
        paymentMethod: r.payment_method, count: r.count, totalAmount: Number(r.total_amount),
      })),
      openExceptions: exceptions.rows,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/talabat/payment-control-report?branchId=&from=&to= - "Talabat Payment Control": Talabat
// Payment مقابل POS Payment الفعلي لكل أوردر، auto-flag لأي فرق - مبني بالكامل من بيانات موجودة فعلًا
// (talabat_orders + orders + payment_methods)، صفر اعتماد على إدخال بشري.
router.get("/payment-control-report", requirePermission("talabat.reconciliation"), async (req, res) => {
  let branchId;
  try { branchId = resolveBranchScope(req); } catch (err) { return res.status(403).json({ error: err.message }); }
  const to = req.query.to || getCairoBusinessDate();
  const from = req.query.from || to;
  const conditions = [
    "t.pos_order_id IS NOT NULL",
    "(t.received_at AT TIME ZONE 'Africa/Cairo')::date BETWEEN $1 AND $2",
  ];
  const values = [from, to];
  if (branchId) { conditions.push(`t.branch_id = $${values.length + 1}`); values.push(branchId); }
  try {
    const result = await pool.query(
      `SELECT
         t.talabat_order_id, t.pos_order_id, t.branch_id, t.received_at,
         t.payment_method AS talabat_payment_code, expected_pm.name AS expected_payment_method,
         o.payment_method_id AS actual_payment_method_id, actual_pm.name AS actual_payment_method,
         (expected_pm.id IS DISTINCT FROM o.payment_method_id) AS mismatch,
         EXISTS (
           SELECT 1 FROM payment_audit_logs pal
           WHERE pal.order_id = t.pos_order_id AND pal.action_type = 'ADJUSTMENT_APPROVED'
         ) AS has_approved_override
       FROM talabat_orders t
       JOIN orders o ON o.id = t.pos_order_id
       LEFT JOIN payment_methods expected_pm ON expected_pm.talabat_payment_code = t.payment_method
       LEFT JOIN payment_methods actual_pm ON actual_pm.id = o.payment_method_id
       WHERE ${conditions.join(" AND ")}
       ORDER BY t.received_at DESC
       LIMIT 500`,
      values
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
