// المرحلة 7E: تقفيل يوم الفرع - "اليوم" هنا مفهوم ضمني (مفيش فعل "فتح يوم" منفصل؛ اليوم مفتوح تلقائيًا
// طالما مفيش صف CLOSED ليه في branch_days) - القفل هو الفعل الوحيد المطلوب، وهو بيتطلب Checklist
// أحمر/أصفر/أخضر ميتخطاش لو فيه بنود حرجة (أحمر) لسه قايمة: شيفت شغال، شيفت محتاج مراجعة مدير، أو
// طلب لسه مفتوح (تحت التحضير/في الطريق). الفحص بيتعمل مرتين عمدًا: مرة في GET /status (للعرض)، ومرة
// تانية جوه transaction القفل نفسه (مع قفل صفوف الشيفتات FOR UPDATE) عشان الفحص يفضل صحيح لحظة القفل
// الفعلي مش بس لحظة ما المدير فتح شاشة القفل. UNIQUE(branch_id, business_date) في الجدول هي الحماية
// الحقيقية ضد قفل مزدوج لنفس اليوم بالتحديد لو طلبين اتبعتوا في نفس اللحظة بالظبط.
const express = require("express");
const router = express.Router();
const pool = require("../db/pool");
const { requireAuth, assertOwnBranch } = require("../middleware/auth");
const { requirePermission } = require("../middleware/permissions");
const { logAudit } = require("../db/audit");

function todayDate() {
  return new Date().toISOString().slice(0, 10);
}

async function buildChecklist(executor, branchId) {
  const activeShifts = await executor.query(
    `SELECT ps.id, ps.user_id, u.name AS cashier_name, ps.opened_at
     FROM pos_shifts ps JOIN users u ON u.id = ps.user_id
     WHERE ps.branch_id = $1 AND ps.status = 'ACTIVE'`,
    [branchId]
  );
  const pendingReviewShifts = await executor.query(
    `SELECT ps.id, ps.user_id, u.name AS cashier_name, ps.cash_variance
     FROM pos_shifts ps JOIN users u ON u.id = ps.user_id
     WHERE ps.branch_id = $1 AND ps.status = 'PENDING_REVIEW'`,
    [branchId]
  );
  const openOrders = await executor.query(
    `SELECT id, status, order_type FROM orders
     WHERE branch_id = $1 AND status IN ('preparing', 'out_for_delivery')`,
    [branchId]
  );
  const reviewedWithVariance = await executor.query(
    `SELECT id, user_id, cash_variance, variance_status FROM pos_shifts
     WHERE branch_id = $1 AND status = 'CLOSED' AND variance_status IN ('ACKNOWLEDGED', 'APPROVED')
       AND closed_at >= now() - interval '24 hours'`,
    [branchId]
  );

  const redItems = [];
  if (activeShifts.rows.length > 0) {
    redItems.push({ code: "ACTIVE_SHIFTS", message: `${activeShifts.rows.length} شيفت لسه شغال - لازم يتقفل الأول`, shifts: activeShifts.rows });
  }
  if (pendingReviewShifts.rows.length > 0) {
    redItems.push({ code: "PENDING_REVIEW_SHIFTS", message: `${pendingReviewShifts.rows.length} شيفت فيه فرق كاش لسه محتاج مراجعة مدير`, shifts: pendingReviewShifts.rows });
  }
  if (openOrders.rows.length > 0) {
    redItems.push({ code: "OPEN_ORDERS", message: `${openOrders.rows.length} طلب لسه مفتوح (تحت التحضير أو في الطريق)`, orders: openOrders.rows });
  }

  const yellowItems = [];
  if (reviewedWithVariance.rows.length > 0) {
    yellowItems.push({
      code: "REVIEWED_VARIANCE_TODAY",
      message: `${reviewedWithVariance.rows.length} شيفت اتقفل بفرق كاش (اتراجع بالفعل) - للعلم بس`,
      shifts: reviewedWithVariance.rows,
    });
  }

  const color = redItems.length > 0 ? "RED" : (yellowItems.length > 0 ? "YELLOW" : "GREEN");
  return { color, redItems, yellowItems, canClose: redItems.length === 0 };
}

// GET /api/branch-days/:branchId/status?businessDate= - حالة الفرع دلوقتي (Checklist أحمر/أصفر/أخضر)
router.get("/:branchId/status", requireAuth, requirePermission("branch_day.view"), async (req, res) => {
  const { branchId } = req.params;
  const businessDate = req.query.businessDate || todayDate();
  if (!assertOwnBranch(req.user, branchId)) {
    return res.status(403).json({ error: "معندكش صلاحية تشوف فرع تاني" });
  }
  try {
    const checklist = await buildChecklist(pool, branchId);
    const existing = await pool.query(
      "SELECT * FROM branch_days WHERE branch_id = $1 AND business_date = $2",
      [branchId, businessDate]
    );
    const summary = await pool.query(
      `SELECT COALESCE(SUM(total), 0) AS total_sales, COUNT(*) AS order_count
       FROM orders WHERE branch_id = $1 AND status <> 'cancelled' AND DATE(created_at) = $2`,
      [branchId, businessDate]
    );
    res.json({
      businessDate,
      alreadyClosed: existing.rows.length > 0,
      dayRecord: existing.rows[0] || null,
      ...checklist,
      todaySummary: {
        totalSales: Number(summary.rows[0].total_sales),
        orderCount: Number(summary.rows[0].order_count),
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/branch-days/:branchId/close - قفل يوم الفرع فعليًا - {businessDate?, managerNotes?}
router.post("/:branchId/close", requireAuth, requirePermission("branch_day.close"), async (req, res) => {
  const { branchId } = req.params;
  const businessDate = req.body.businessDate || todayDate();
  const { managerNotes } = req.body;
  if (!assertOwnBranch(req.user, branchId)) {
    return res.status(403).json({ error: "معندكش صلاحية تقفل فرع تاني" });
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // قفل صفوف الشيفتات ذات الصلة قبل إعادة فحص القايمة عشان مايحصلش تغيير حالة شيفت (فتح/مراجعة) في
    // نفس اللحظة اللي بنتأكد فيها إن مفيش شيفت شغال/محتاج مراجعة
    await client.query(
      "SELECT id FROM pos_shifts WHERE branch_id = $1 AND status IN ('ACTIVE', 'PENDING_REVIEW') FOR UPDATE",
      [branchId]
    );
    const checklist = await buildChecklist(client, branchId);
    if (!checklist.canClose) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "فيه بنود حرجة لسه مفتوحة - مينفعش تقفل اليوم", ...checklist });
    }

    const summary = await client.query(
      `SELECT COALESCE(SUM(total), 0) AS total_sales, COUNT(*) AS order_count
       FROM orders WHERE branch_id = $1 AND status <> 'cancelled' AND DATE(created_at) = $2`,
      [branchId, businessDate]
    );
    const varianceSummary = await client.query(
      `SELECT COALESCE(SUM(cash_variance), 0) AS total_variance
       FROM pos_shifts WHERE branch_id = $1 AND status IN ('CLOSED', 'FORCE_CLOSED') AND DATE(opened_at) = $2`,
      [branchId, businessDate]
    );

    const result = await client.query(
      `INSERT INTO branch_days
        (branch_id, business_date, status, closed_by, closed_at, total_sales, order_count, cash_variance_total, manager_notes)
       VALUES ($1, $2, 'CLOSED', $3, now(), $4, $5, $6, $7)
       RETURNING *`,
      [
        branchId, businessDate, req.user.id,
        Number(summary.rows[0].total_sales), Number(summary.rows[0].order_count),
        Number(varianceSummary.rows[0].total_variance), managerNotes || null,
      ]
    );

    await logAudit(client, {
      branchId, userId: req.user.id, action: "BRANCH_DAY_CLOSED", entityType: "branch_day", entityId: result.rows[0].id,
      newValues: { businessDate, totalSales: Number(summary.rows[0].total_sales), orderCount: Number(summary.rows[0].order_count) },
    });

    await client.query("COMMIT");
    res.status(201).json(result.rows[0]);
  } catch (err) {
    await client.query("ROLLBACK");
    if (err.code === "23505") return res.status(409).json({ error: "اليوم ده مقفول بالفعل" });
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// GET /api/branch-days/:branchId/history - سجل تقفيلات الفرع (للتقرير المطبوع/المراجعة)
router.get("/:branchId/history", requireAuth, requirePermission("branch_day.view"), async (req, res) => {
  const { branchId } = req.params;
  if (!assertOwnBranch(req.user, branchId)) {
    return res.status(403).json({ error: "معندكش صلاحية تشوف فرع تاني" });
  }
  try {
    const result = await pool.query(
      `SELECT bd.*, u.name AS closed_by_name
       FROM branch_days bd LEFT JOIN users u ON u.id = bd.closed_by
       WHERE bd.branch_id = $1 ORDER BY bd.business_date DESC LIMIT 90`,
      [branchId]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
