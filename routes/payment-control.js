// Payment Control & Reconciliation - طبقة HTTP/صلاحيات فوق db/payment-control-engine.js بس (نفس نمط
// routes/driver-shifts.js/routes/shifts.js). المنطق الفعلي (قفل/تعديل/مطابقة/نقاط مخاطر) كله في الـengine.
const express = require("express");
const router = express.Router();
const crypto = require("crypto");
const multer = require("multer");
const pool = require("../db/pool");
const { requireAuth, assertOwnBranch } = require("../middleware/auth");
const { requirePermission, hasPermission } = require("../middleware/permissions");
const { validateIdParam } = require("../middleware/validate-id-param");
const { consumeApprovalGrant } = require("../db/approval-engine");
const {
  createAdjustmentRequest, applyAdjustmentApproval, rejectAdjustmentRequest, computeExceptions,
  formatOwnerReportMessage, autoMatchChannelRecords,
} = require("../db/payment-control-engine");
const { previewStatementFile, readStatementGrid, extractStatementRows } = require("../db/payment-reconciliation-import");
const { getCairoBusinessDate } = require("../db/business-date");

const statementUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
const VALID_SOURCES = ["talabat_statement", "visa_settlement", "instapay", "orange_cash"];
const SETTLEMENT_CHANNEL_BY_SOURCE = { instapay: "instapay", orange_cash: "orange_cash" };

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

// POST /api/payment-control/backfill-settlement-channels - {branchId?}
// لو طريقة دفع (فيزا/محفظة/إنستاباي) اتضاف لها قناة تسوية *بعد* ما طلبات فعلية اتسجّلت عليها بالفعل
// (زي ما حصل فعليًا أول مرة اتفعّلت فيها الميزة دي - راجع migration 0043)، الدفعات القديمة دي بتفضل
// settlement_channel = NULL للأبد (نسخة مجمّدة وقت القفل، مش لينك حي) ومتظهرش في فحوص المطابقة خالص.
// النداء ده بينسخ القناة الحالية بتاعة طريقة الدفع لأي دفعة لسه NULL بس - مش بيلمس دفعة القناة بتاعتها
// اتحددت بالفعل (حتى لو اتغيّرت بعد كده)، عشان يفضل "تكملة فجوة" مش "إعادة كتابة تاريخ"
router.post("/backfill-settlement-channels", requirePermission("payment_control.reconciliation.enter"), async (req, res) => {
  const { branchId } = req.body;
  if (branchId && !assertOwnBranch(req.user, branchId)) return res.status(403).json({ error: "معندكش صلاحية على فرع تاني" });
  try {
    const result = await pool.query(
      `UPDATE payments p
       SET settlement_channel = pm.settlement_channel
       FROM payment_methods pm
       WHERE p.payment_method_id = pm.id
         AND p.method_kind = 'card_or_wallet'
         AND p.settlement_channel IS NULL
         AND pm.settlement_channel IS NOT NULL
         AND ($1::int IS NULL OR p.branch_id = $1)
       RETURNING p.id`,
      [branchId || null]
    );
    res.json({ updated: result.rows.length });
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
    const paymentRes = await client.query(
      `SELECT p.branch_id, o.source AS order_source
       FROM payments p LEFT JOIN orders o ON o.id = p.order_id WHERE p.id = $1`,
      [paymentId]
    );
    if (paymentRes.rows.length === 0) return res.status(404).json({ error: "سجل الدفع مش موجود" });
    if (!assertOwnBranch(req.user, paymentRes.rows[0].branch_id)) {
      return res.status(403).json({ error: "معندكش صلاحية على فرع تاني" });
    }
    // تكامل طلبات: طريقة الدفع القادمة من Talabat مصدر حقيقة مقفول - حتى مجرد طلب تعديلها (مش بس
    // اعتماده) لازم صلاحية talabat.payment_override منفصلة صراحة، مش payment_control.adjustment.request
    // العامة اللي الكاشير أصلًا معاه (PREVENT مش TRUST -> REVIEW)
    if (paymentRes.rows[0].order_source === "talabat" && !hasPermission(req.user, "talabat.payment_override")) {
      return res.status(403).json({ error: "تعديل طريقة دفع أوردر طلبات محتاج صلاحية منفصلة (talabat.payment_override)" });
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
      `SELECT par.id, p.branch_id, o.source AS order_source FROM payment_adjustment_requests par
       JOIN payments p ON p.id = par.payment_id LEFT JOIN orders o ON o.id = p.order_id WHERE par.id = $1`,
      [req.params.id]
    );
    if (reqRow.rows.length === 0) return res.status(404).json({ error: "طلب التعديل مش موجود" });
    const branchId = reqRow.rows[0].branch_id;
    if (!assertOwnBranch(req.user, branchId)) return res.status(403).json({ error: "معندكش صلاحية على فرع تاني" });
    if (reqRow.rows[0].order_source === "talabat" && !hasPermission(req.user, "talabat.payment_override")) {
      return res.status(403).json({ error: "اعتماد تعديل طريقة دفع أوردر طلبات محتاج صلاحية منفصلة (talabat.payment_override)" });
    }

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

// GET /api/payment-control/reconciliation-records?source= أو ?sources=instapay,orange_cash (تبويب
// إنستاباي/أورانج كاش محتاج المصدرين مع بعض، مش واحد بس)
router.get("/reconciliation-records", requirePermission("payment_control.view"), async (req, res) => {
  let branchId;
  try { branchId = resolveBranchScope(req); } catch (err) { return res.status(403).json({ error: err.message }); }
  const { source, sources, matchStatus } = req.query;
  const conditions = [];
  const values = [];
  let i = 1;
  if (branchId) { conditions.push(`branch_id = $${i++}`); values.push(branchId); }
  if (sources) { conditions.push(`source = ANY($${i++})`); values.push(sources.split(",").map((s) => s.trim()).filter(Boolean)); }
  else if (source) { conditions.push(`source = $${i++}`); values.push(source); }
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

// DELETE /api/payment-control/reconciliation-records/:id - حذف سطر واحد (إدخال يدوي بالغلط/مكرر) -
// نفس قيد إلغاء دفعة الاستيراد بالظبط: مسموح بس لو السطر لسه UNMATCHED (سطر اتطابق لازم يتراجع بوعي، مش يتمسح)
router.delete("/reconciliation-records/:id", requirePermission("payment_control.reconciliation.enter"), async (req, res) => {
  try {
    const record = await pool.query("SELECT * FROM payment_reconciliation_records WHERE id = $1", [req.params.id]);
    if (record.rows.length === 0) return res.status(404).json({ error: "السطر مش موجود" });
    if (record.rows[0].branch_id && !assertOwnBranch(req.user, record.rows[0].branch_id)) {
      return res.status(403).json({ error: "معندكش صلاحية على فرع تاني" });
    }
    if (record.rows[0].match_status !== "UNMATCHED") {
      return res.status(400).json({ error: "السطر ده اتطابق بالفعل - مينفعش يتمسح مباشرة" });
    }
    await pool.query("DELETE FROM payment_reconciliation_records WHERE id = $1", [req.params.id]);
    await pool.query(
      `INSERT INTO payment_audit_logs (branch_id, actor_id, actor_role, action_type, before_state)
       VALUES ($1,$2,$3,'RECONCILIATION_DELETED',$4)`,
      [record.rows[0].branch_id, req.user.id, req.user.role, JSON.stringify(record.rows[0])]
    );
    res.json({ deleted: true });
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
    await pool.query(
      `INSERT INTO payment_audit_logs (payment_id, branch_id, actor_id, actor_role, action_type, before_state, after_state)
       VALUES ($1,$2,$3,$4,'RECONCILIATION_MATCHED_MANUAL',$5,$6)`,
      [paymentId, record.rows[0].branch_id, req.user.id, req.user.role, JSON.stringify(record.rows[0]), JSON.stringify(result.rows[0])]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/payment-control/reconciliation-records/import/preview - {file, source}multipart -> عيّنة
// من الصفوف الخام + عدد الأعمدة عشان المحاسب يختار عمود التاريخ/المبلغ/المرجع بعينه (مفيش تخمين أعمى
// لأسماء أعمدة - راجع db/payment-reconciliation-import.js للسبب)
router.post("/reconciliation-records/import/preview", requirePermission("payment_control.reconciliation.enter"), (req, res, next) => {
  statementUpload.single("file")(req, res, (err) => {
    if (!err) return next();
    if (err.code === "LIMIT_FILE_SIZE") return res.status(400).json({ error: "الملف كبير جدًا (الحد الأقصى 10 ميجا)" });
    res.status(400).json({ error: err.message });
  });
}, async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "لازم ترفع ملف CSV أو Excel" });
  if (!VALID_SOURCES.includes(req.body.source)) return res.status(400).json({ error: "مصدر كشف غير معروف" });
  try {
    const preview = await previewStatementFile(req.file.buffer, req.file.originalname);
    res.json(preview);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /api/payment-control/reconciliation-records/import/commit - {file, source, branchId, dateColumn,
// amountColumn, referenceColumn?, hasHeaderRow} -> بيستورد كل صفوف الملف، ولو المصدر إنستاباي/أورانج
// كاش بيحاول مطابقة تلقائية فورًا بعدها (راجع autoMatchChannelRecords - طلبات/فيزا مقارنة إجمالي مش
// سطرية، فمفيش حاجة تُطابق هناك)
router.post("/reconciliation-records/import/commit", requirePermission("payment_control.reconciliation.enter"), (req, res, next) => {
  statementUpload.single("file")(req, res, (err) => {
    if (!err) return next();
    if (err.code === "LIMIT_FILE_SIZE") return res.status(400).json({ error: "الملف كبير جدًا (الحد الأقصى 10 ميجا)" });
    res.status(400).json({ error: err.message });
  });
}, async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "لازم ترفع ملف CSV أو Excel" });
  const { source, branchId, dateColumn, amountColumn, referenceColumn, hasHeaderRow } = req.body;
  if (!VALID_SOURCES.includes(source)) return res.status(400).json({ error: "مصدر كشف غير معروف" });
  if (dateColumn === undefined || amountColumn === undefined) {
    return res.status(400).json({ error: "لازم تحدد عمود التاريخ وعمود المبلغ على الأقل" });
  }
  if (branchId && !assertOwnBranch(req.user, branchId)) return res.status(403).json({ error: "معندكش صلاحية على فرع تاني" });

  try {
    const grid = await readStatementGrid(req.file.buffer, req.file.originalname);
    const { rows, errors } = extractStatementRows(grid, {
      dateColumn: Number(dateColumn), amountColumn: Number(amountColumn),
      referenceColumn: referenceColumn !== undefined && referenceColumn !== "" ? Number(referenceColumn) : null,
      hasHeaderRow: hasHeaderRow === true || hasHeaderRow === "true",
    });
    if (rows.length === 0) {
      return res.status(400).json({ error: "مفيش أي صف صالح للاستيراد في الملف ده", errors });
    }

    const batchId = crypto.randomUUID();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      for (const row of rows) {
        await client.query(
          `INSERT INTO payment_reconciliation_records
            (branch_id, source, external_reference, external_amount, external_date, entered_by, import_batch_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [branchId || null, source, row.externalReference, row.externalAmount, row.externalDate, req.user.id, batchId]
        );
      }
      await client.query(
        `INSERT INTO payment_audit_logs (branch_id, actor_id, actor_role, action_type, after_state)
         VALUES ($1,$2,$3,'RECONCILIATION_ENTERED',$4)`,
        [branchId || null, req.user.id, req.user.role, JSON.stringify({ source, imported: rows.length, batchId, fileName: req.file.originalname })]
      );
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }

    let matchResult = null;
    const settlementChannel = SETTLEMENT_CHANNEL_BY_SOURCE[source];
    if (settlementChannel) {
      matchResult = await autoMatchChannelRecords(pool, { source, branchId: branchId || null, settlementChannel });
    }

    res.status(201).json({ batchId, imported: rows.length, errors, autoMatch: matchResult });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /api/payment-control/reconciliation-records/match-auto - {source, branchId} - إعادة تشغيل
// المطابقة التلقائية يدويًا (مفيد لو دفعات جديدة اتقفلت بعد ما الملف اتستورد أصلًا)
router.post("/reconciliation-records/match-auto", requirePermission("payment_control.reconciliation.enter"), async (req, res) => {
  const { source, branchId } = req.body;
  const settlementChannel = SETTLEMENT_CHANNEL_BY_SOURCE[source];
  if (!settlementChannel) return res.status(400).json({ error: "المطابقة التلقائية متاحة لإنستاباي/أورانج كاش بس" });
  if (branchId && !assertOwnBranch(req.user, branchId)) return res.status(403).json({ error: "معندكش صلاحية على فرع تاني" });
  try {
    const result = await autoMatchChannelRecords(pool, { source, branchId: branchId || null, settlementChannel });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/payment-control/reconciliation-records/import-batches/:batchId - إلغاء استيراد كامل لو
// اتقرا غلط (عمود متبدّل مثلًا) - مسموح بس لو كل سطور الدفعة لسه UNMATCHED (لو أي سطر اتطابق بالفعل،
// لازم يتراجع يدويًا سطر سطر - مش هنفك مطابقة مؤكدة تلقائيًا من غير قرار بشري صريح)
router.delete("/reconciliation-records/import-batches/:batchId", requirePermission("payment_control.reconciliation.enter"), async (req, res) => {
  try {
    const rows = await pool.query(
      "SELECT id, branch_id, match_status FROM payment_reconciliation_records WHERE import_batch_id = $1",
      [req.params.batchId]
    );
    if (rows.rows.length === 0) return res.status(404).json({ error: "دفعة الاستيراد دي مش موجودة" });
    const branchIds = [...new Set(rows.rows.map((r) => r.branch_id).filter(Boolean))];
    for (const bId of branchIds) {
      if (!assertOwnBranch(req.user, bId)) return res.status(403).json({ error: "معندكش صلاحية على فرع تاني" });
    }
    if (rows.rows.some((r) => r.match_status !== "UNMATCHED")) {
      return res.status(400).json({ error: "الدفعة دي فيها سطور اتطابقت بالفعل - لازم تتراجع يدويًا سطر سطر" });
    }
    await pool.query("DELETE FROM payment_reconciliation_records WHERE import_batch_id = $1", [req.params.batchId]);
    await pool.query(
      `INSERT INTO payment_audit_logs (branch_id, actor_id, actor_role, action_type, before_state)
       VALUES ($1,$2,$3,'RECONCILIATION_IMPORT_BATCH_CANCELLED',$4)`,
      [branchIds.length === 1 ? branchIds[0] : null, req.user.id, req.user.role, JSON.stringify({ batchId: req.params.batchId, deleted: rows.rows.length, branchIds })]
    );
    res.json({ deleted: rows.rows.length });
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

// GET /api/payment-control/talabat-payment-overrides - تكامل طلبات (TAL-6): تقرير "Payment Overrides"
// - كل تعديل طريقة دفع أوردر طلبات اتعتمد فعليًا (مين طلب، مين اعتمد، السبب، القديم/الجديد، الأوردر)،
// مبني على payment_audit_logs (سجل غير قابل للتعديل/الحذف - مفيش أي DELETE على الجدول ده في كل الكود)
router.get("/talabat-payment-overrides", requirePermission("talabat.reconciliation"), async (req, res) => {
  let branchId;
  try { branchId = resolveBranchScope(req); } catch (err) { return res.status(403).json({ error: err.message }); }
  const conditions = ["o.source = 'talabat'", "par.status = 'APPROVED'"];
  const values = [];
  let i = 1;
  if (branchId) { conditions.push(`p.branch_id = $${i++}`); values.push(branchId); }
  const where = `WHERE ${conditions.join(" AND ")}`;
  try {
    const result = await pool.query(
      `SELECT
         par.id AS adjustment_request_id, o.talabat_order_id, p.order_id, p.branch_id,
         par.requested_by AS user_id, ru.name AS user_name,
         pal.actor_id AS manager_id, mu.name AS manager_name,
         par.reason,
         (pal.before_state->>'payment_method_id')::int AS old_payment_method_id, opm.name AS old_payment_method,
         (pal.after_state->>'payment_method_id')::int AS new_payment_method_id, npm.name AS new_payment_method,
         par.requested_at, pal.created_at AS approved_at
       FROM payment_adjustment_requests par
       JOIN payments p ON p.id = par.payment_id
       JOIN orders o ON o.id = p.order_id
       LEFT JOIN payment_audit_logs pal
         ON pal.payment_id = par.payment_id AND pal.action_type = 'ADJUSTMENT_APPROVED' AND pal.created_at = par.decided_at
       LEFT JOIN users ru ON ru.id = par.requested_by
       LEFT JOIN users mu ON mu.id = pal.actor_id
       LEFT JOIN payment_methods opm ON opm.id = (pal.before_state->>'payment_method_id')::int
       LEFT JOIN payment_methods npm ON npm.id = (pal.after_state->>'payment_method_id')::int
       ${where}
       ORDER BY par.decided_at DESC
       LIMIT 500`,
      values
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
