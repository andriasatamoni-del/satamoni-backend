// Payment Control & Reconciliation - طبقة HTTP/صلاحيات فوق db/payment-control-engine.js بس (نفس نمط
// routes/driver-shifts.js/routes/shifts.js). المنطق الفعلي (قفل/تعديل/مطابقة/نقاط مخاطر) كله في الـengine.
const express = require("express");
const router = express.Router();
const pool = require("../db/pool");
const { requireAuth, assertOwnBranch } = require("../middleware/auth");
const { requirePermission, hasPermission } = require("../middleware/permissions");
const { validateIdParam } = require("../middleware/validate-id-param");
const { consumeApprovalGrant } = require("../db/approval-engine");
const {
  createAdjustmentRequest, applyAdjustmentApproval, rejectAdjustmentRequest, computeExceptions,
  formatOwnerReportMessage,
} = require("../db/payment-control-engine");
const { getCairoBusinessDate } = require("../db/business-date");

router.use(requireAuth);
router.param("id", validateIdParam);

// أدمن (role='admin') من غير branchId في الطلب = كل الفروع (null). أي دور تاني (بما فيهم محاسب) لازم
// فرعه هو أو فرع صريح يمر بـassertOwnBranch - نفس فلسفة كل route تاني في المشروع بالظبط
function resolveBranchScope(req) {
  const requested = req.query.branchId || req.body.branchId;
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

function defaultDateRange(req) {
  const to = req.query.to || getCairoBusinessDate();
  const from = req.query.from || to;
  return { from, to };
}

// GET /api/payment-control/payments - سجل المدفوعات (تبويب 2)
router.get("/payments", requirePermission("payment_control.view"), async (req, res) => {
  let branchId;
  try { branchId = resolveBranchScope(req); } catch (err) { return res.status(403).json({ error: err.message }); }
  const { channel, status } = req.query;
  const { from, to } = defaultDateRange(req);
  const conditions = ["(p.locked_at AT TIME ZONE 'Africa/Cairo')::date BETWEEN $1 AND $2"];
  const values = [from, to];
  let i = 3;
  if (branchId) { conditions.push(`p.branch_id = $${i++}`); values.push(branchId); }
  if (channel) { conditions.push(`p.channel = $${i++}`); values.push(channel); }
  if (status) { conditions.push(`p.status = $${i++}`); values.push(status); }
  try {
    const result = await pool.query(
      `SELECT p.*, o.order_type, o.total AS order_total, u.name AS locked_by_name, pm.name AS payment_method_name
       FROM payments p
       JOIN orders o ON o.id = p.order_id
       LEFT JOIN users u ON u.id = p.locked_by
       LEFT JOIN payment_methods pm ON pm.id = p.payment_method_id
       WHERE ${conditions.join(" AND ")}
       ORDER BY p.locked_at DESC
       LIMIT 500`,
      values
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/payment-control/adjustment-requests - {paymentId, reason, proposedPaymentMethodId?, proposedAmount?}
router.post("/adjustment-requests", requirePermission("payment_control.adjustment.request"), async (req, res) => {
  const { paymentId, reason, proposedPaymentMethodId, proposedAmount } = req.body;
  if (!paymentId || !reason) return res.status(400).json({ error: "لازم تحدد الدفعة والسبب" });
  const client = await pool.connect();
  try {
    const paymentRes = await client.query("SELECT branch_id FROM payments WHERE id = $1", [paymentId]);
    if (paymentRes.rows.length === 0) return res.status(404).json({ error: "سجل الدفع مش موجود" });
    if (!assertOwnBranch(req.user, paymentRes.rows[0].branch_id)) {
      return res.status(403).json({ error: "معندكش صلاحية على فرع تاني" });
    }
    await client.query("BEGIN");
    const request = await createAdjustmentRequest(client, {
      paymentId, requestedByUserId: req.user.id, reason, proposedPaymentMethodId, proposedAmount,
    });
    await client.query("COMMIT");
    res.status(201).json(request);
  } catch (err) {
    await client.query("ROLLBACK");
    res.status(400).json({ error: err.message });
  } finally {
    client.release();
  }
});

// GET /api/payment-control/adjustment-requests - تبويب 3 (طلبات تعديل الدفع)
router.get("/adjustment-requests", requirePermission("payment_control.view"), async (req, res) => {
  let branchId;
  try { branchId = resolveBranchScope(req); } catch (err) { return res.status(403).json({ error: err.message }); }
  const { status } = req.query;
  const conditions = [];
  const values = [];
  let i = 1;
  if (branchId) { conditions.push(`p.branch_id = $${i++}`); values.push(branchId); }
  if (status) { conditions.push(`par.status = $${i++}`); values.push(status); }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  try {
    const result = await pool.query(
      `SELECT par.*, p.branch_id, p.order_id, p.amount AS current_amount, p.payment_method_id AS current_payment_method_id,
         ru.name AS requested_by_name, du.name AS decided_by_name
       FROM payment_adjustment_requests par
       JOIN payments p ON p.id = par.payment_id
       LEFT JOIN users ru ON ru.id = par.requested_by
       LEFT JOIN users du ON du.id = par.decided_by
       ${where}
       ORDER BY par.requested_at DESC
       LIMIT 500`,
      values
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/payment-control/adjustment-requests/:id/approve - {approvalToken}
router.post("/adjustment-requests/:id/approve", requirePermission("payment_control.adjustment.approve"), async (req, res) => {
  const { approvalToken } = req.body;
  const client = await pool.connect();
  try {
    const reqRow = await client.query(
      `SELECT par.id, p.branch_id FROM payment_adjustment_requests par
       JOIN payments p ON p.id = par.payment_id WHERE par.id = $1`,
      [req.params.id]
    );
    if (reqRow.rows.length === 0) return res.status(404).json({ error: "طلب التعديل مش موجود" });
    const branchId = reqRow.rows[0].branch_id;
    if (!assertOwnBranch(req.user, branchId)) return res.status(403).json({ error: "معندكش صلاحية على فرع تاني" });

    await client.query("BEGIN");
    const { approver } = await consumeApprovalGrant(client, {
      token: approvalToken, actionType: "PAYMENT_ADJUSTMENT", targetType: "payment_adjustment_request",
      targetId: req.params.id, branchId, usedByUserId: req.user.id,
    });
    const settings = await client.query("SELECT payment_adjustment_high_threshold_egp FROM pos_settings WHERE id = 1");
    const highThresholdEgp = Number(settings.rows[0]?.payment_adjustment_high_threshold_egp ?? 500);
    const result = await applyAdjustmentApproval(client, { requestId: req.params.id, approver, highThresholdEgp });
    await client.query("COMMIT");
    res.json(result);
  } catch (err) {
    await client.query("ROLLBACK");
    if (err.code === "APPROVAL_INVALID" || err.code === "APPROVAL_REQUIRED" || err.code === "HIGH_TIER_REQUIRED" || err.code === "ADJUSTMENT_ALREADY_DECIDED") {
      return res.status(400).json({ error: err.message });
    }
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// POST /api/payment-control/adjustment-requests/:id/reject - {} (مفيش PIN مطلوب - الرفض مش إجراء حساس زي الاعتماد)
router.post("/adjustment-requests/:id/reject", requirePermission("payment_control.adjustment.approve"), async (req, res) => {
  const client = await pool.connect();
  try {
    const reqRow = await client.query(
      `SELECT par.id, p.branch_id FROM payment_adjustment_requests par
       JOIN payments p ON p.id = par.payment_id WHERE par.id = $1`,
      [req.params.id]
    );
    if (reqRow.rows.length === 0) return res.status(404).json({ error: "طلب التعديل مش موجود" });
    if (!assertOwnBranch(req.user, reqRow.rows[0].branch_id)) return res.status(403).json({ error: "معندكش صلاحية على فرع تاني" });

    await client.query("BEGIN");
    const result = await rejectAdjustmentRequest(client, {
      requestId: req.params.id, decidedByUserId: req.user.id, decidedByRole: req.user.role,
    });
    await client.query("COMMIT");
    res.json(result);
  } catch (err) {
    await client.query("ROLLBACK");
    if (err.code === "ADJUSTMENT_ALREADY_DECIDED") return res.status(400).json({ error: err.message });
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// POST /api/payment-control/reconciliation-records - إدخال يدوي لسطر كشف خارجي (تبويبات 4-6)
router.post("/reconciliation-records", requirePermission("payment_control.reconciliation.enter"), async (req, res) => {
  const { branchId, source, externalReference, externalAmount, externalDate, notes } = req.body;
  if (!source || externalAmount === undefined || !externalDate) {
    return res.status(400).json({ error: "لازم تحدد المصدر والمبلغ والتاريخ" });
  }
  if (!["talabat_statement", "visa_settlement", "instapay", "orange_cash"].includes(source)) {
    return res.status(400).json({ error: "مصدر كشف غير معروف" });
  }
  if (branchId && !assertOwnBranch(req.user, branchId)) return res.status(403).json({ error: "معندكش صلاحية على فرع تاني" });
  try {
    const result = await pool.query(
      `INSERT INTO payment_reconciliation_records
        (branch_id, source, external_reference, external_amount, external_date, notes, entered_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [branchId || null, source, externalReference || null, externalAmount, externalDate, notes || null, req.user.id]
    );
    await pool.query(
      `INSERT INTO payment_audit_logs (branch_id, actor_id, actor_role, action_type, after_state)
       VALUES ($1,$2,$3,'RECONCILIATION_ENTERED',$4)`,
      [branchId || null, req.user.id, req.user.role, JSON.stringify(result.rows[0])]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/payment-control/reconciliation-records?source=
router.get("/reconciliation-records", requirePermission("payment_control.view"), async (req, res) => {
  let branchId;
  try { branchId = resolveBranchScope(req); } catch (err) { return res.status(403).json({ error: err.message }); }
  const { source, matchStatus } = req.query;
  const conditions = [];
  const values = [];
  let i = 1;
  if (branchId) { conditions.push(`branch_id = $${i++}`); values.push(branchId); }
  if (source) { conditions.push(`source = $${i++}`); values.push(source); }
  if (matchStatus) { conditions.push(`match_status = $${i++}`); values.push(matchStatus); }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  try {
    const result = await pool.query(
      `SELECT * FROM payment_reconciliation_records ${where} ORDER BY external_date DESC LIMIT 500`, values
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/payment-control/reconciliation-records/:id/match - {paymentId} مطابقة يدوية صريحة
router.patch("/reconciliation-records/:id/match", requirePermission("payment_control.reconciliation.enter"), async (req, res) => {
  const { paymentId } = req.body;
  if (!paymentId) return res.status(400).json({ error: "لازم تحدد الدفعة المطابقة" });
  try {
    const record = await pool.query("SELECT * FROM payment_reconciliation_records WHERE id = $1", [req.params.id]);
    if (record.rows.length === 0) return res.status(404).json({ error: "السطر مش موجود" });
    if (record.rows[0].branch_id && !assertOwnBranch(req.user, record.rows[0].branch_id)) {
      return res.status(403).json({ error: "معندكش صلاحية على فرع تاني" });
    }
    const result = await pool.query(
      `UPDATE payment_reconciliation_records SET matched_payment_id = $1, match_status = 'MATCHED' WHERE id = $2 RETURNING *`,
      [paymentId, req.params.id]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/payment-control/exceptions - تبويب 7 (الاستثناءات والمخاطر)
router.get("/exceptions", requirePermission("payment_control.view"), async (req, res) => {
  let branchId;
  try { branchId = resolveBranchScope(req); } catch (err) { return res.status(403).json({ error: err.message }); }
  const { from, to } = defaultDateRange(req);
  try {
    const result = await computeExceptions(pool, { branchId, from, to });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/payment-control/reports/daily-owner - التقرير اليومي (شاشة عند الطلب - نفس محتوى الإرسال التلقائي بالظبط)
router.get("/reports/daily-owner", requirePermission("payment_control.view"), async (req, res) => {
  let branchId;
  try { branchId = resolveBranchScope(req); } catch (err) { return res.status(403).json({ error: err.message }); }
  const businessDate = req.query.date || getCairoBusinessDate();
  try {
    const { exceptions, totalPoints, tier } = await computeExceptions(pool, { branchId, from: businessDate, to: businessDate });
    res.json({ businessDate, exceptions, totalPoints, tier, message: formatOwnerReportMessage({ businessDate, exceptions, totalPoints, tier }) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/payment-control/audit-logs - تبويب 8 (سجل التدقيق)
router.get("/audit-logs", requirePermission("payment_control.audit.view"), async (req, res) => {
  let branchId;
  try { branchId = resolveBranchScope(req); } catch (err) { return res.status(403).json({ error: err.message }); }
  const { paymentId } = req.query;
  const conditions = [];
  const values = [];
  let i = 1;
  if (branchId) { conditions.push(`branch_id = $${i++}`); values.push(branchId); }
  if (paymentId) { conditions.push(`payment_id = $${i++}`); values.push(paymentId); }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  try {
    const result = await pool.query(
      `SELECT pal.*, u.name AS actor_name FROM payment_audit_logs pal
       LEFT JOIN users u ON u.id = pal.actor_id
       ${where}
       ORDER BY pal.created_at DESC LIMIT 500`,
      values
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
