// بطاقة صحة الفروع (Branch Health Scorecard) - مقارنة كل الفروع في مكان واحد، بدل ما مدير Stamoni
// يفتح تقرير مستقل لكل مؤشر لكل فرع لوحده. نفس فلسفة db/action-center.js بالظبط: كل رقم هنا بييجي من
// نفس المصدر اللي التقرير/المحرك المستقل بتاعه بيستخدمه فعليًا (revenue-engine/payroll-engine/
// food-cost-engine) - صفر منطق تجاري جديد أو مكرر هنا.
const { computeRevenueAndCogsByBranch } = require("../services/revenue-engine");
const { computeLatenessReport } = require("../services/payroll-engine");
const { computeConsumptionBreakdown, aggregateBreakdown } = require("./food-cost-engine");

async function computeCashVarianceByBranch(pool, { from, to }) {
  const result = await pool.query(
    `SELECT branch_id, SUM(cash_variance) AS total_variance,
            COUNT(*) FILTER (WHERE variance_status = 'PENDING_REVIEW') AS pending_review_count
     FROM pos_shifts
     WHERE status IN ('CLOSED', 'FORCE_CLOSED') AND closed_at::date BETWEEN $1 AND $2
     GROUP BY branch_id`,
    [from, to]
  );
  return new Map(result.rows.map((r) => [r.branch_id, {
    cashVariance: Number(r.total_variance || 0), pendingReviewCount: Number(r.pending_review_count),
  }]));
}

async function computeNegativeStockCountByBranch(pool) {
  const result = await pool.query(
    `SELECT branch_id, COUNT(*) AS item_count FROM branch_inventory_stock WHERE quantity < 0 GROUP BY branch_id`
  );
  return new Map(result.rows.map((r) => [r.branch_id, Number(r.item_count)]));
}

async function computeOpenComplaintsByBranch(pool, { from, to }) {
  const result = await pool.query(
    `SELECT branch_id, COUNT(*) AS open_count
     FROM customer_complaints
     WHERE status IN ('open', 'in_progress') AND created_at::date BETWEEN $1 AND $2 AND branch_id IS NOT NULL
     GROUP BY branch_id`,
    [from, to]
  );
  return new Map(result.rows.map((r) => [r.branch_id, Number(r.open_count)]));
}

async function computeLatenessByBranch(pool, { from, to }) {
  const rows = await computeLatenessReport(pool, from, to);
  const byBranch = new Map();
  for (const r of rows) {
    if (!r.branchId) continue;
    const entry = byBranch.get(r.branchId) || { lateDaysCount: 0, totalLateMinutes: 0 };
    entry.lateDaysCount += r.lateDaysCount;
    entry.totalLateMinutes += r.totalLateMinutes;
    byBranch.set(r.branchId, entry);
  }
  return byBranch;
}

async function computeFoodCostPercentByBranch(pool, { from, to }, branchIds) {
  const byBranch = new Map();
  const versionCache = new Map(); // نفس نمط GET /api/reports/branch-food-cost - وصفة واحدة بتتفكّ مرة واحدة لكل الفروع
  for (const branchId of branchIds) {
    const byItem = await computeConsumptionBreakdown(pool, { branchId, from, to }, versionCache);
    const totals = aggregateBreakdown(byItem);
    byBranch.set(branchId, totals.totalUsage.cost);
  }
  return byBranch;
}

async function computeBranchHealth(pool, { from, to }) {
  const branchesRes = await pool.query(
    "SELECT id, name FROM branches WHERE is_central_kitchen = FALSE ORDER BY name"
  );
  const branchIds = branchesRes.rows.map((b) => b.id);

  const [revenueRows, cashVarianceByBranch, negativeStockByBranch, complaintsByBranch, latenessByBranch, foodCostByBranch] =
    await Promise.all([
      computeRevenueAndCogsByBranch(pool, from, to),
      computeCashVarianceByBranch(pool, { from, to }),
      computeNegativeStockCountByBranch(pool),
      computeOpenComplaintsByBranch(pool, { from, to }),
      computeLatenessByBranch(pool, { from, to }),
      computeFoodCostPercentByBranch(pool, { from, to }, branchIds),
    ]);
  const revenueByBranch = new Map(revenueRows.map((r) => [r.branchId, r]));

  return branchesRes.rows.map((b) => {
    const revenue = revenueByBranch.get(b.id) || { ordersCount: 0, revenue: 0, cogs: 0 };
    const cash = cashVarianceByBranch.get(b.id) || { cashVariance: 0, pendingReviewCount: 0 };
    const lateness = latenessByBranch.get(b.id) || { lateDaysCount: 0, totalLateMinutes: 0 };
    const foodCost = foodCostByBranch.get(b.id) || 0;
    return {
      branchId: b.id, branchName: b.name,
      ordersCount: revenue.ordersCount, revenue: revenue.revenue,
      avgOrderValue: revenue.ordersCount > 0 ? revenue.revenue / revenue.ordersCount : 0,
      foodCostPercent: revenue.revenue > 0 ? (foodCost / revenue.revenue) * 100 : null,
      cashVariance: cash.cashVariance, shiftsPendingReview: cash.pendingReviewCount,
      negativeStockItems: negativeStockByBranch.get(b.id) || 0,
      openComplaints: complaintsByBranch.get(b.id) || 0,
      lateDaysCount: lateness.lateDaysCount, totalLateMinutes: lateness.totalLateMinutes,
    };
  });
}

module.exports = { computeBranchHealth };
