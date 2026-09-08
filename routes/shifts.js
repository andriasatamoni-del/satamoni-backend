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
  sanitizeShiftForCashier, computeShiftFinancials, calcExpectedCash, addMissedCashEntryAndRecalculate,
} = require("../db/shift-engine");
const { validateIdParam } = require("../middleware/validate-id-param");

// المرحلة 8.6: نفس التحقق من routes/orders.js (المرحلة 8B) - :id لازم يكون رقم صحيح، وإلا 400 واضح
// بدل ما استعلام SQL يرمي خطأ Postgres خام (invalid input syntax) كـ500
router.param("id", validateIdParam);

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

// GET /api/shifts/active-others - المرحلة 8.44: باقي الشيفتات الشغالة دلوقتي في نفس الفرع (غير شيفت
// اللي طالب هو) - اسم الكاشير بس، مفيش أرقام مالية خالص (متاحة لأي كاشير عادي - shifts.close_own -
// عكس GET / اللي مقصورة على shifts.view_branch عمدًا لأنها بترجّع فرق كاش وسلف حساسة). الهدف الوحيد:
// اختيار شيفت يستلّم طلب مفتوح قبل ما الكاشير الحالي يقفل شيفته (راجع PATCH /api/orders/:id/shift)
router.get("/active-others", requireAuth, requirePermission("shifts.close_own"), async (req, res) => {
  const branchId = req.query.branchId || req.user.branchId;
  if (!branchId) return res.status(400).json({ error: "لازم تحدد الفرع" });
  if (!assertOwnBranch(req.user, branchId)) {
    return res.status(403).json({ error: "معندكش صلاحية على فرع تاني" });
  }
  try {
    const result = await pool.query(
      `SELECT ps.id, u.name AS cashier_name FROM pos_shifts ps JOIN users u ON u.id = ps.user_id
       WHERE ps.branch_id = $1 AND ps.status = 'ACTIVE' AND ps.user_id <> $2
       ORDER BY ps.opened_at`,
      [branchId, req.user.id]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/shifts/open-all - كل الشيفتات المفتوحة (ACTIVE) دلوقتي عبر كل الفروع مع بعض - أدمن/المالك
// بس (requireRole مباشرة زي غيرها من نقاط النهاية القاصرة على الأدمن في المشروع، مش permission string
// جديد - شيفت مفتوح لموظف في أي فرع معلومة حساسة عبر كل الفروع، فمقصورة على الأدمن عمدًا وليست
// shifts.view_branch العادية اللي مقصورة على فرع واحد بس أصلًا). لشاشة "Live Operations" في الداش بورد
router.get("/open-all", requireAuth, requireRole("admin"), async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT ps.id, ps.branch_id, b.name AS branch_name, ps.user_id, u.name AS cashier_name,
              ps.status, ps.opened_at, ps.opening_cash
       FROM pos_shifts ps
       JOIN branches b ON b.id = ps.branch_id
       JOIN users u ON u.id = ps.user_id
       WHERE ps.status = 'ACTIVE'
       ORDER BY ps.opened_at ASC`
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

// المرحلة 8.45: GET /api/shifts/:id/review-detail - تفاصيل كاملة لمراجعة شيفت (مدير فرع/محاسب/أدمن -
// shifts.review) بدل الـprompt() الخام القديم: الشيفت المجمّد + تفصيل الطلبات المرتبطة به + المصروفات/
// المشتريات النقدية اللي وقعت جوه نافذة الشيفت [opened_at, closed_at] بالظبط (نفس نافذة
// computeShiftFinancials تمامًا) - عشان المدير يقدر يراجع كل حاجة ويكتشف لو الكاشير نسي يسجل بند
router.get("/:id/review-detail", requireAuth, requirePermission("shifts.review"), async (req, res) => {
  try {
    const shiftRes = await pool.query(
      `SELECT ps.*, u.name AS cashier_name FROM pos_shifts ps JOIN users u ON u.id = ps.user_id WHERE ps.id = $1`,
      [req.params.id]
    );
    if (shiftRes.rows.length === 0) return res.status(404).json({ error: "الشيفت مش موجود" });
    const shift = shiftRes.rows[0];
    if (!assertOwnBranch(req.user, shift.branch_id)) {
      return res.status(403).json({ error: "معندكش صلاحية على فرع تاني" });
    }
    const toTs = shift.closed_at || new Date();
    const [financials, ordersRes, expensesRes, purchasesRes] = await Promise.all([
      computeShiftFinancials(pool, { shiftId: shift.id, branchId: shift.branch_id, openedAt: shift.opened_at, toTs }),
      pool.query(
        `SELECT o.id, o.status, o.order_type, o.source, o.total, o.payment_status, o.voided, o.created_at,
                pm.name AS payment_method_name
         FROM orders o LEFT JOIN payment_methods pm ON pm.id = o.payment_method_id
         WHERE o.shift_id = $1 ORDER BY o.created_at`,
        [shift.id]
      ),
      pool.query(
        `SELECT e.*, ec.name AS category_name FROM expenses e
         JOIN expense_categories ec ON ec.id = e.category_id
         JOIN payment_methods pm ON pm.id = e.payment_method_id
         WHERE e.branch_id = $1 AND e.status IN ('SUBMITTED', 'APPROVED', 'POSTED') AND pm.kind = 'cash'
           AND COALESCE(e.posted_at, e.created_at) >= $2 AND COALESCE(e.posted_at, e.created_at) <= $3
         ORDER BY COALESCE(e.posted_at, e.created_at)`,
        [shift.branch_id, shift.opened_at, toTs]
      ),
      pool.query(
        `SELECT * FROM purchases WHERE branch_id = $1 AND status <> 'REJECTED'
           AND created_at >= $2 AND created_at <= $3 ORDER BY created_at`,
        [shift.branch_id, shift.opened_at, toTs]
      ),
    ]);
    const expectedCash = calcExpectedCash({
      openingCash: shift.opening_cash, cashSales: financials.cashSales,
      cashRefunds: financials.cashRefunds, cashExpensesTotal: financials.cashExpensesTotal,
      cashPurchasesTotal: financials.cashPurchasesTotal,
    });
    const liveCashVariance = shift.actual_cash === null ? null : Number(shift.actual_cash) - expectedCash;
    res.json({
      shift, financialsLive: { ...financials, expectedCash, cashVariance: liveCashVariance },
      orders: ordersRes.rows, expenses: expensesRes.rows, purchases: purchasesRes.rows,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// المرحلة 8.45: POST /api/shifts/:id/missed-entry - تسجيل مصروف/مشترى منسي بأثر رجعي أثناء مراجعة شيفت
// PENDING_REVIEW وإعادة حساب الفرق فورًا - {entryType: "expense"|"purchase", amount, categoryId?, notes?}
// (categoryId مطلوب للمصروف بس). لو الفرق الجديد بقى جوه حد الاعتماد، الشيفت بيتقفل تلقائيًا؛ غير كده
// بيفضل PENDING_REVIEW بالأرقام المحدّثة لحد ما المدير يستخدم /:id/review زي أي مراجعة عادية
router.post("/:id/missed-entry", requireAuth, requirePermission("shifts.review"), async (req, res) => {
  const { entryType, amount, categoryId, notes } = req.body;
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
    const thresholds = await getThresholds(client);
    const result = await addMissedCashEntryAndRecalculate(client, {
      shift, entryType, amount, categoryId, notes, actorId: req.user.id, thresholds,
    });
    await client.query("COMMIT");
    res.json(result);
  } catch (err) {
    await client.query("ROLLBACK");
    if (["SHIFT_NOT_PENDING_REVIEW", "INVALID_ENTRY_TYPE", "INVALID_AMOUNT", "CATEGORY_REQUIRED",
         "CATEGORY_NOT_FOUND", "NO_CASH_PAYMENT_METHOD"].includes(err.code)) {
      return res.status(400).json({ error: err.message, code: err.code });
    }
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
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
    // المرحلة 8.44: مينفعش الكاشير يقفل شيفته وسايب طلبات لسه مفتوحة (تحت التحضير/في الطريق) اترّبطت
    // بيه - نفس معيار "OPEN_ORDERS" اللي تقفيل يوم الفرع بيستخدمه بالظبط (routes/branch-days.js)، بس
    // هنا مقصور على طلبات الشيفت ده نفسه. الحل: يقفل الطلب فعليًا، أو يسلّمه لشيفت تاني شغال دلوقتي
    // (PATCH /api/orders/:id/shift) قبل ما يقدر يقفل - مش عدد الطلبات اللي بيحدد، دي اللي بتفضل قايمة
    const openOrders = await client.query(
      `SELECT id, status, order_type FROM orders WHERE shift_id = $1 AND status IN ('preparing', 'out_for_delivery')`,
      [shift.id]
    );
    if (openOrders.rows.length > 0) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        error: `فيه ${openOrders.rows.length} طلب لسه مفتوح مرتبط بالشيفت ده - لازم تقفله أو تسلّمه لشيفت تاني قبل ما تقدر تقفل شيفتك`,
        code: "OPEN_ORDERS_ON_SHIFT",
        openOrders: openOrders.rows,
      });
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
