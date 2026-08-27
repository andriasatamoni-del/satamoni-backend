// المرحلة 7E: شيفتات الكاشير - فتح/معاينة/قفل شيفت الكاشير الواحد + مراجعة المدير لفروق الكاش.
// كل عملية كتابة هنا بتتلف جوه transaction وبتقفل صف الشيفت (SELECT ... FOR UPDATE) قبل أي تغيير -
// ده اللي فعليًا بيمنع أي سباق (قفل مزدوج، مراجعة مزدوجة، قفل شيفت اتقفل بالفعل من طلب متوازي) بدل ما
// نعتمد على فحص مبدئي في الكود وحده. المنطق الحسابي نفسه كله في db/shift-engine.js - الملف ده بس
// طبقة HTTP/صلاحيات/قفل فوقه.
const express = require("express");
const router = express.Router();
const pool = require("../db/pool");
const { requireAuth, requireRole, assertOwnBranch } = require("../middleware/auth");
const { requirePermission, hasPermission } = require("../middleware/permissions");
const {
  openShift, previewExpectedCash, closeShift, reviewShiftVariance, forceCloseShift,
  sanitizeShiftForCashier,
} = require("../db/shift-engine");

// المرحلة 8.6: تصفية استجابة الشيفت حسب دور اللي طالبها - كاشير مايشوفش أي رقم مالي حساس عن شيفته
// (كاش متوقع/فعلي/فرق) حتى لو كان صاحب الشيفت نفسه. القرار ده على مستوى الـresponse نفسه، مش إخفاء
// واجهة (لو حد فتح devtools وشاف الـnetwork response خام كان لسه هيلاقي الأرقام قبل الإصلاح ده)
function shapeShiftResponse(shift, user) {
  if (user.role === "cashier") return sanitizeShiftForCashier(shift);
  return shift;
}

async function getThresholds(executor) {
  const r = await executor.query(
    "SELECT shift_variance_ack_threshold_egp, shift_variance_review_threshold_egp FROM pos_settings WHERE id = 1"
  );
  return {
    ackThreshold: Number(r.rows[0]?.shift_variance_ack_threshold_egp ?? 20),
    reviewThreshold: Number(r.rows[0]?.shift_variance_review_threshold_egp ?? 100),
  };
}

// POST /api/shifts/open - فتح شيفت جديد (كاشير/مدير فرع لنفسه، أدمن لأي فرع لو حدده)
router.post("/open", requireAuth, requirePermission("shifts.open_own"), async (req, res) => {
  const { openingCash, openingNotes } = req.body;
  const branchId = req.user.role === "admin" ? (req.body.branchId || req.user.branchId) : req.user.branchId;
  if (!branchId) return res.status(400).json({ error: "لازم تحدد الفرع" });
  if (openingCash === undefined || openingCash === null || Number(openingCash) < 0 || Number.isNaN(Number(openingCash))) {
    return res.status(400).json({ error: "قيمة كاش الافتتاح غير صالحة" });
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const shift = await openShift(client, {
      branchId, userId: req.user.id, openingCash: Number(openingCash), openingNotes,
    });
    await client.query("COMMIT");
    res.status(201).json(shift);
  } catch (err) {
    await client.query("ROLLBACK");
    if (err.code === "SHIFT_ALREADY_ACTIVE") return res.status(409).json({ error: err.message });
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// GET /api/shifts/current - الشيفت النشط الحالي بتاع اللي عامل login (أو null) - ده اللي بيبني عليه
// بانر حالة الشيفت في شاشة الكاشير
router.get("/current", requireAuth, requirePermission("shifts.view_own"), async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM pos_shifts WHERE user_id = $1 AND status = 'ACTIVE'",
      [req.user.id]
    );
    res.json(result.rows[0] ? shapeShiftResponse(result.rows[0], req.user) : null);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/shifts/mine - سجل شيفتات الكاشير نفسه (تاريخي)
router.get("/mine", requireAuth, requirePermission("shifts.view_own"), async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM pos_shifts WHERE user_id = $1 ORDER BY opened_at DESC LIMIT 100",
      [req.user.id]
    );
    res.json(result.rows.map((s) => shapeShiftResponse(s, req.user)));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/shifts?branchId=&status=&userId=&from=&to= - قايمة شيفتات الفرع (مدير فرع/محاسب لفرعه بس،
// أدمن لأي فرع)
router.get("/", requireAuth, requirePermission("shifts.view_branch"), async (req, res) => {
  const branchId = req.query.branchId || req.user.branchId;
  if (!branchId) return res.status(400).json({ error: "لازم تحدد الفرع" });
  if (!assertOwnBranch(req.user, branchId)) {
    return res.status(403).json({ error: "معندكش صلاحية تشوف شيفتات فرع تاني" });
  }
  const conditions = ["ps.branch_id = $1"];
  const values = [branchId];
  let i = 2;
  if (req.query.status) { conditions.push(`ps.status = $${i++}`); values.push(req.query.status); }
  if (req.query.userId) { conditions.push(`ps.user_id = $${i++}`); values.push(req.query.userId); }
  if (req.query.from) { conditions.push(`ps.opened_at >= $${i++}`); values.push(req.query.from); }
  if (req.query.to) { conditions.push(`ps.opened_at <= $${i++}`); values.push(req.query.to); }
  try {
    // المرحلة 8.6: reviewer_name + linked_debt للمدير/المحاسب - تتبّع كامل موظف->شيفت->سلفة من غير
    // ما تختفي أي حاجة (payroll_adjustments بيتربط بـshift_id، اتضاف في المرحلة دي)
    const result = await pool.query(
      `SELECT ps.*, u.name AS cashier_name, reviewer.name AS reviewer_name,
              pa.id AS debt_id, pa.amount AS debt_amount, pa.employee_id AS debt_employee_id
       FROM pos_shifts ps
       JOIN users u ON u.id = ps.user_id
       LEFT JOIN users reviewer ON reviewer.id = ps.variance_reviewed_by
       LEFT JOIN payroll_adjustments pa ON pa.shift_id = ps.id AND pa.adjustment_type = 'advance'
       WHERE ${conditions.join(" AND ")}
       ORDER BY ps.opened_at DESC
       LIMIT 200`,
      values
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/shifts/:id - تفاصيل شيفت (صاحبه، أو مدير فرع/محاسب/أدمن بصلاحية shifts.view_branch لنفس الفرع)
router.get("/:id", requireAuth, async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM pos_shifts WHERE id = $1", [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: "الشيفت مش موجود" });
    const shift = result.rows[0];
    const isOwner = shift.user_id === req.user.id;
    const canViewBranch = hasPermission(req.user.role, "shifts.view_branch") && assertOwnBranch(req.user, shift.branch_id);
    if (!isOwner && !canViewBranch) {
      return res.status(403).json({ error: "معندكش صلاحية تشوف الشيفت ده" });
    }
    res.json(shapeShiftResponse(shift, req.user));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/shifts/:id/preview - معاينة الكاش المتوقع لحظيًا (قبل القفل الفعلي) - مدير فرع/محاسب/أدمن بس.
// المرحلة 8.6: كان الكاشير نفسه بيقدر يعاين الكاش المتوقع قبل القفل - ده بالظبط ثغرة التلاعب اللي
// طُلب سدّها (كاشير عارف الرقم المتوقع مقدّمًا يقدر يدخل رقم "فعلي" يطابقه بالظبط، سواء كان فيه عجز
// أو زيادة حقيقية). الشاشة الجديدة بتاعة الكاشير (عدّ فئات) مبقتش محتاجة الـendpoint ده خالص
router.get("/:id/preview", requireAuth, requirePermission("shifts.review"), async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM pos_shifts WHERE id = $1", [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: "الشيفت مش موجود" });
    const shift = result.rows[0];
    if (!assertOwnBranch(req.user, shift.branch_id)) {
      return res.status(403).json({ error: "معندكش صلاحية تعاين شيفت فرع تاني" });
    }
    if (shift.status !== "ACTIVE") {
      return res.status(400).json({ error: "الشيفت ده مش شغال - مفيش حاجة تتعاين" });
    }
    const preview = await previewExpectedCash(pool, shift);
    res.json(preview);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/shifts/:id/close - قفل الشيفت (صاحبه بس، أو أدمن) - {actualCash, closingNotes}
router.post("/:id/close", requireAuth, requirePermission("shifts.close_own"), async (req, res) => {
  const { actualCash, closingNotes } = req.body;
  if (actualCash === undefined || actualCash === null || Number(actualCash) < 0 || Number.isNaN(Number(actualCash))) {
    return res.status(400).json({ error: "قيمة الكاش الفعلي غير صالحة" });
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const shiftRes = await client.query("SELECT * FROM pos_shifts WHERE id = $1 FOR UPDATE", [req.params.id]);
    if (shiftRes.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "الشيفت مش موجود" });
    }
    const shift = shiftRes.rows[0];
    if (shift.user_id !== req.user.id && req.user.role !== "admin") {
      await client.query("ROLLBACK");
      return res.status(403).json({ error: "معندكش صلاحية تقفل شيفت زميلك" });
    }
    if (!assertOwnBranch(req.user, shift.branch_id)) {
      await client.query("ROLLBACK");
      return res.status(403).json({ error: "معندكش صلاحية على فرع تاني" });
    }
    if (shift.status !== "ACTIVE") {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "الشيفت ده مقفول بالفعل" });
    }
    const thresholds = await getThresholds(client);
    const closed = await closeShift(client, {
      shift, actualCash: Number(actualCash), closingNotes, closedBy: req.user.id, thresholds,
    });
    await client.query("COMMIT");
    res.json(shapeShiftResponse(closed, req.user));
  } catch (err) {
    await client.query("ROLLBACK");
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// POST /api/shifts/:id/review - مراجعة مدير/محاسب لشيفت في حالة PENDING_REVIEW - {decision: "approve"|"acknowledge", notes}
router.post("/:id/review", requireAuth, requirePermission("shifts.review"), async (req, res) => {
  const { decision, notes } = req.body;
  if (!["approve", "acknowledge"].includes(decision)) {
    return res.status(400).json({ error: "القرار لازم يكون approve أو acknowledge" });
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const shiftRes = await client.query("SELECT * FROM pos_shifts WHERE id = $1 FOR UPDATE", [req.params.id]);
    if (shiftRes.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "الشيفت مش موجود" });
    }
    const shift = shiftRes.rows[0];
    if (!assertOwnBranch(req.user, shift.branch_id)) {
      await client.query("ROLLBACK");
      return res.status(403).json({ error: "معندكش صلاحية على فرع تاني" });
    }
    const reviewed = await reviewShiftVariance(client, { shift, reviewerId: req.user.id, decision, notes });
    await client.query("COMMIT");
    res.json(reviewed);
  } catch (err) {
    await client.query("ROLLBACK");
    if (err.code === "SHIFT_NOT_PENDING_REVIEW") return res.status(400).json({ error: err.message });
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// POST /api/shifts/:id/force-close - قفل قسري (أدمن بس) - {actualCash?, closingNotes, reason}
router.post("/:id/force-close", requireAuth, requireRole("admin"), async (req, res) => {
  const { actualCash, closingNotes, reason } = req.body;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const shiftRes = await client.query("SELECT * FROM pos_shifts WHERE id = $1 FOR UPDATE", [req.params.id]);
    if (shiftRes.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "الشيفت مش موجود" });
    }
    const shift = shiftRes.rows[0];
    if (!["ACTIVE", "PENDING_REVIEW"].includes(shift.status)) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "الشيفت ده مقفول بالفعل" });
    }
    const thresholds = await getThresholds(client);
    const closed = await forceCloseShift(client, {
      shift, actualCash: actualCash ?? null, closingNotes, closedBy: req.user.id, thresholds, reason,
    });
    await client.query("COMMIT");
    res.json(closed);
  } catch (err) {
    await client.query("ROLLBACK");
    if (err.code === "FORCE_CLOSE_REASON_REQUIRED") return res.status(400).json({ error: err.message });
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

module.exports = router;
