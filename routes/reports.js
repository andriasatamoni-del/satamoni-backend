const express = require("express");
const router = express.Router();
const pool = require("../db/pool");
const { requireAuth, requireRole } = require("../middleware/auth");
const { requirePermission } = require("../middleware/permissions");
const { computeConsumptionBreakdown, aggregateBreakdown } = require("../db/food-cost-engine");
const {
  computeFingerprintPayroll,
  computeManualPayroll,
  computeNoTrackingPayroll,
} = require("../services/payroll-engine");

const canSeeReports = requireRole("admin", "accountant", "branch_manager");

function toCents(n) {
  return Math.round(n * 100);
}

// كل تقارير مركز التقارير الجديدة بتقبل مدى تاريخ مرن (from/to) بدل ما تتقفل على شهر كامل بس -
// وبتقبل كمان year/month كاختصار (بديل عن from/to) عشان تفضل متوافقة مع باقي الشاشات اللي بتبعت year/month
function resolveDateRange(query) {
  if (query.from && query.to) return { from: query.from, to: query.to };
  if (query.year && query.month) {
    const year = Number(query.year);
    const month = Number(query.month);
    const from = `${year}-${String(month).padStart(2, "0")}-01`;
    const lastDay = new Date(year, month, 0).getDate();
    const to = `${year}-${String(month).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
    return { from, to };
  }
  return null;
}

// إجمالي تكلفة الرواتب (الصافي المستحق للصرف بعد السلف/الجزاءات/المكافآت) مقسّمة على الفروع.
// موظفي البصمة بيتحسبوا على فرعهم الأساسي الفعلي؛ موظفي المطبخ المركزي والإدارة (بدون فرع بيع محدد)
// بيتحسبوا كـ "تكاليف عامة" منفصلة عن أي فرع بيع بعينه - عشان قائمة الدخل متبقاش مضلِّلة بتحميل
// تكلفة موظف إداري على فرع معين وهو أصلًا بيخدم كل الفروع.
async function computePayrollCostByBranch(year, month) {
  const [fingerprintRows, manualRows, noTrackingRows, adjustments] = await Promise.all([
    computeFingerprintPayroll(pool, year, month),
    computeManualPayroll(pool, year, month),
    computeNoTrackingPayroll(pool),
    pool.query(
      `SELECT employee_id,
              SUM(amount) FILTER (WHERE adjustment_type = 'advance') AS advances,
              SUM(amount) FILTER (WHERE adjustment_type = 'penalty') AS penalties,
              SUM(amount) FILTER (WHERE adjustment_type = 'bonus') AS bonuses
       FROM payroll_adjustments
       WHERE EXTRACT(YEAR FROM entry_date) = $1 AND EXTRACT(MONTH FROM entry_date) = $2
       GROUP BY employee_id`,
      [year, month]
    ),
  ]);

  const adjByEmployee = {};
  adjustments.rows.forEach((r) => {
    adjByEmployee[r.employee_id] = {
      advances: Number(r.advances || 0),
      penalties: Number(r.penalties || 0),
      bonuses: Number(r.bonuses || 0),
    };
  });

  const byBranchCents = {};
  let overheadCents = 0;
  let totalCents = 0;

  [...fingerprintRows, ...manualRows, ...noTrackingRows].forEach((r) => {
    const adj = adjByEmployee[r.employeeId] || { advances: 0, penalties: 0, bonuses: 0 };
    const netPayCents = toCents(r.payAfterAttendance) - toCents(adj.advances) - toCents(adj.penalties) + toCents(adj.bonuses);
    totalCents += netPayCents;
    if (r.attendanceSystem === "fingerprint_auto" && r.primaryBranchId) {
      byBranchCents[r.primaryBranchId] = (byBranchCents[r.primaryBranchId] || 0) + netPayCents;
    } else {
      overheadCents += netPayCents;
    }
  });

  const byBranch = {};
  Object.entries(byBranchCents).forEach(([branchId, cents]) => { byBranch[branchId] = cents / 100; });
  return { byBranch, overhead: overheadCents / 100, total: totalCents / 100 };
}

// GET /api/reports/daily?year=2026&month=7 - بديل شيت "لوحة التحكم"
router.get("/daily", requireAuth, canSeeReports, async (req, res) => {
  const { year, month } = req.query;
  try {
    const result = await pool.query(
      `SELECT * FROM v_daily_branch_summary
       WHERE EXTRACT(YEAR FROM business_date) = $1
         AND EXTRACT(MONTH FROM business_date) = $2
         AND ($3::int IS NULL OR branch_id = $3)
       ORDER BY business_date, branch_id`,
      [year, month, req.user.role === "branch_manager" ? req.user.branchId : null]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/reports/branch-debt - مديونية كل فرع للمخزن الرئيسي لحظيًا
router.get("/branch-debt", requireAuth, canSeeReports, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT b.id AS branch_id, b.name,
              b.opening_debt_to_kitchen
              + COALESCE(SUM(sle.invoice_amount), 0)
              - COALESCE(SUM(sle.payment_amount), 0) AS current_debt
       FROM branches b
       LEFT JOIN supplier_ledger_entries sle ON sle.branch_id = b.id
       WHERE b.is_central_kitchen = FALSE
         AND ($1::int IS NULL OR b.id = $1)
       GROUP BY b.id, b.name, b.opening_debt_to_kitchen`,
      [req.user.role === "branch_manager" ? req.user.branchId : null]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/reports/menu-cost-analysis?targetFoodCostPercent=0.375
// تكلفة الريسبي الفعلية لكل صنف مقابل سعر بيعه، ونسبة تكلفة الطعام، وهامش الربح
// (بديل شيت "تحليل التكلفة والسعر")
router.get("/menu-cost-analysis", requireAuth, canSeeReports, async (req, res) => {
  const targetPercent = Number(req.query.targetFoodCostPercent) || 0.375;
  try {
    const result = await pool.query(`
      SELECT mc.name AS category, mi.name AS item_name, mv.id AS variant_id, mv.label,
             mv.price, mv.talabat_price,
             COALESCE(SUM(mvi.quantity_per_unit * ii.unit_cost), 0) AS recipe_cost,
             COUNT(mvi.id) AS ingredient_count,
             COUNT(mvi.id) FILTER (WHERE ii.unit_cost IS NULL) AS missing_cost_count
      FROM menu_item_variants mv
      JOIN menu_items mi ON mi.id = mv.item_id
      JOIN menu_categories mc ON mc.id = mi.category_id
      LEFT JOIN menu_item_variant_ingredients mvi ON mvi.variant_id = mv.id
      LEFT JOIN inventory_items ii ON ii.id = mvi.inventory_item_id
      WHERE mi.is_active = TRUE
      GROUP BY mc.name, mi.name, mv.id, mv.label, mv.price, mv.talabat_price
      ORDER BY mc.name, mi.name, mv.id
    `);

    const rows = result.rows.map((r) => {
      const price = Number(r.price);
      const recipeCost = Number(r.recipe_cost);
      const hasRecipe = Number(r.ingredient_count) > 0;
      const foodCostPct = price > 0 ? recipeCost / price : null;
      return {
        category: r.category,
        itemName: r.item_name,
        variantId: r.variant_id,
        label: r.label,
        price,
        talabatPrice: r.talabat_price !== null ? Number(r.talabat_price) : null,
        recipeCost,
        hasRecipe,
        missingCostCount: Number(r.missing_cost_count),
        foodCostPercent: foodCostPct,
        profit: hasRecipe ? price - recipeCost : null,
        marginPercent: hasRecipe && price > 0 ? (price - recipeCost) / price : null,
        fairPrice: hasRecipe ? recipeCost / targetPercent : null,
      };
    });
    res.json({ targetFoodCostPercent: targetPercent, items: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// حساب الإيرادات وتكلفة البضاعة المباعة لكل فرع في شهر معين، من بيانات الطلبات الفعلية
// (مش من قيود يدوية) - العروض/الكومبو بتتفكّ لأصنافها الأصلية لحساب تكلفتها الحقيقية
async function computeRevenueAndCogsByBranch(year, month) {
  // تكلفة البضاعة المباعة بتتاخد من cost_at_sale المسجّلة على كل سطر طلب وقت البيع نفسه (مش لحظيًا وقت التقرير)
  // عشان لو الريسبي أو تركيبة عرض اتغيرت بعد كدة، الطلبات القديمة تفضل بتكلفتها الحقيقية وقتها
  const result = await pool.query(
    `WITH qualifying_orders AS (
       SELECT o.id, o.branch_id, o.total
       FROM orders o
       WHERE o.status <> 'cancelled'
         AND EXTRACT(YEAR FROM o.created_at) = $1
         AND EXTRACT(MONTH FROM o.created_at) = $2
     ),
     order_cost_totals AS (
       SELECT oi.order_id,
              SUM(COALESCE(oi.cost_at_sale, 0)) AS cost,
              BOOL_OR(oi.cost_at_sale IS NULL OR oi.cost_at_sale_incomplete) AS missing_cost
       FROM order_items oi
       JOIN qualifying_orders qo ON qo.id = oi.order_id
       GROUP BY oi.order_id
     )
     SELECT qo.branch_id,
            COALESCE(b.name, 'غير مرتبط بفرع') AS branch_name,
            COUNT(*) AS orders_count,
            SUM(qo.total) AS revenue,
            COALESCE(SUM(oct.cost), 0) AS cogs,
            COUNT(*) FILTER (WHERE oct.missing_cost) AS orders_missing_cost_data
     FROM qualifying_orders qo
     LEFT JOIN branches b ON b.id = qo.branch_id
     LEFT JOIN order_cost_totals oct ON oct.order_id = qo.id
     GROUP BY qo.branch_id, b.name
     ORDER BY b.name`,
    [year, month]
  );
  return result.rows.map((r) => ({
    branchId: r.branch_id,
    branchName: r.branch_name,
    ordersCount: Number(r.orders_count),
    revenue: Number(r.revenue),
    cogs: Number(r.cogs),
    ordersMissingCostData: Number(r.orders_missing_cost_data),
  }));
}

// GET /api/reports/income-statement?year=&month=&branchId= - قائمة الدخل (إيرادات - تكلفة البضاعة - مصروفات)
// لفرع واحد لو اتحدد branchId، أو مجمّع لكل الفروع لو مفيش
router.get("/income-statement", requireAuth, canSeeReports, async (req, res) => {
  const year = Number(req.query.year);
  const month = Number(req.query.month);
  let branchId = req.query.branchId ? Number(req.query.branchId) : null;
  if (req.user.role === "branch_manager") branchId = req.user.branchId;
  if (!year || !month) return res.status(400).json({ error: "لازم تحدد السنة والشهر" });

  try {
    const byBranch = await computeRevenueAndCogsByBranch(year, month);
    const scoped = branchId ? byBranch.filter((r) => r.branchId === branchId) : byBranch;

    const revenue = scoped.reduce((s, r) => s + r.revenue, 0);
    const cogs = scoped.reduce((s, r) => s + r.cogs, 0);
    const ordersMissingCostData = scoped.reduce((s, r) => s + r.ordersMissingCostData, 0);
    const grossProfit = revenue - cogs;

    const expensesResult = await pool.query(
      `SELECT ec.name AS category, SUM(e.amount) AS total
       FROM expenses e
       JOIN expense_categories ec ON ec.id = e.category_id
       WHERE EXTRACT(YEAR FROM e.business_date) = $1
         AND EXTRACT(MONTH FROM e.business_date) = $2
         AND ($3::int IS NULL OR e.branch_id = $3)
       GROUP BY ec.name
       ORDER BY total DESC`,
      [year, month, branchId]
    );
    const expenseLines = expensesResult.rows.map((r) => ({
      category: r.category,
      amount: Number(r.total),
    }));
    const totalOpex = expenseLines.reduce((s, r) => s + r.amount, 0);
    const netProfitBeforePayroll = grossProfit - totalOpex;

    // تكلفة الرواتب هنا إجمالي بس (صافي مستحق الصرف) - مش تفصيل رواتب الموظفين، فمأمون إن مدير الفرع يشوفه لفرعه
    const payroll = await computePayrollCostByBranch(year, month);
    const payrollCost = branchId ? (payroll.byBranch[branchId] || 0) : payroll.total;
    const netProfitAfterPayroll = netProfitBeforePayroll - payrollCost;

    res.json({
      year,
      month,
      branchId,
      revenue,
      cogs,
      grossProfit,
      grossMarginPercent: revenue > 0 ? grossProfit / revenue : null,
      ordersMissingCostData,
      expenseLines,
      totalOpex,
      netProfitBeforePayroll,
      payrollCost,
      netProfitAfterPayroll,
      note: branchId
        ? "تكلفة الرواتب هنا لفريق الفرع ده بس (موظفي البصمة اللي فرعهم الأساسي ده) - تكاليف الإدارة والمطبخ المركزي مش متحمّلة على فرع بعينه"
        : "تكلفة الرواتب هنا شاملة كل الموظفين (فروع + مطبخ مركزي + إدارة)",
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/reports/income-statement/by-branch?year=&month= - مقارنة أداء الفروع (أدمن/محاسب بس)
router.get(
  "/income-statement/by-branch",
  requireAuth,
  requireRole("admin", "accountant"),
  async (req, res) => {
    const year = Number(req.query.year);
    const month = Number(req.query.month);
    if (!year || !month) return res.status(400).json({ error: "لازم تحدد السنة والشهر" });

    try {
      const byBranch = await computeRevenueAndCogsByBranch(year, month);
      const expensesResult = await pool.query(
        `SELECT branch_id, SUM(amount) AS total
         FROM expenses
         WHERE EXTRACT(YEAR FROM business_date) = $1 AND EXTRACT(MONTH FROM business_date) = $2
         GROUP BY branch_id`,
        [year, month]
      );
      const opexByBranch = {};
      expensesResult.rows.forEach((r) => { opexByBranch[r.branch_id] = Number(r.total); });

      const payroll = await computePayrollCostByBranch(year, month);

      const rows = byBranch.map((r) => {
        const opex = opexByBranch[r.branchId] || 0;
        const grossProfit = r.revenue - r.cogs;
        const payrollCost = r.branchId ? (payroll.byBranch[r.branchId] || 0) : 0;
        const netProfitBeforePayroll = grossProfit - opex;
        return {
          ...r,
          grossProfit,
          grossMarginPercent: r.revenue > 0 ? grossProfit / r.revenue : null,
          opex,
          netProfitBeforePayroll,
          payrollCost,
          netProfitAfterPayroll: netProfitBeforePayroll - payrollCost,
        };
      });

      const consolidated = rows.reduce(
        (acc, r) => ({
          revenue: acc.revenue + r.revenue,
          cogs: acc.cogs + r.cogs,
          opex: acc.opex + r.opex,
          ordersCount: acc.ordersCount + r.ordersCount,
        }),
        { revenue: 0, cogs: 0, opex: 0, ordersCount: 0 }
      );
      const consolidatedGrossProfit = consolidated.revenue - consolidated.cogs;
      const consolidatedNetBeforePayroll = consolidatedGrossProfit - consolidated.opex;

      res.json({
        year,
        month,
        branches: rows,
        payrollOverhead: payroll.overhead, // تكلفة رواتب الإدارة والمطبخ المركزي - مش متحمّلة على فرع بعينه
        consolidated: {
          ...consolidated,
          grossProfit: consolidatedGrossProfit,
          grossMarginPercent: consolidated.revenue > 0 ? consolidatedGrossProfit / consolidated.revenue : null,
          netProfitBeforePayroll: consolidatedNetBeforePayroll,
          payrollCost: payroll.total,
          netProfitAfterPayroll: consolidatedNetBeforePayroll - payroll.total,
        },
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

// GET /api/reports/dashboard?year=&month=&branchId= - داش بورد المالك: كل تفاصيل الشغل في نداء واحد
// (المبيعات اليومية، الأصناف/الفروع/المناطق الأكثر مبيعًا، التكلفة والمصروفات، حالة التحصيل، حالة الطلبات)
router.get("/dashboard", requireAuth, canSeeReports, async (req, res) => {
  const year = Number(req.query.year);
  const month = Number(req.query.month);
  if (!year || !month) return res.status(400).json({ error: "لازم تحدد السنة والشهر" });
  let branchId = req.query.branchId ? Number(req.query.branchId) : null;
  if (req.user.role === "branch_manager") branchId = req.user.branchId;

  try {
    const [
      byBranch, dailySales, topItems, topAreas,
      paymentStatusBreakdown, orderStatusBreakdown, expensesResult, payroll,
    ] = await Promise.all([
      computeRevenueAndCogsByBranch(year, month),
      pool.query(
        `SELECT o.created_at::date AS date, COUNT(*) AS orders_count, SUM(o.total) AS revenue
         FROM orders o
         WHERE o.status <> 'cancelled'
           AND EXTRACT(YEAR FROM o.created_at) = $1 AND EXTRACT(MONTH FROM o.created_at) = $2
           AND ($3::int IS NULL OR o.branch_id = $3)
         GROUP BY o.created_at::date ORDER BY date`,
        [year, month, branchId]
      ),
      pool.query(
        `SELECT COALESCE(mi.name || ' - ' || mv.label, c.name) AS name,
                SUM(oi.quantity) AS quantity, SUM(oi.line_total) AS revenue
         FROM order_items oi
         JOIN orders o ON o.id = oi.order_id
         LEFT JOIN menu_item_variants mv ON mv.id = oi.variant_id
         LEFT JOIN menu_items mi ON mi.id = mv.item_id
         LEFT JOIN combos c ON c.id = oi.combo_id
         WHERE o.status <> 'cancelled'
           AND EXTRACT(YEAR FROM o.created_at) = $1 AND EXTRACT(MONTH FROM o.created_at) = $2
           AND ($3::int IS NULL OR o.branch_id = $3)
         GROUP BY COALESCE(mi.name || ' - ' || mv.label, c.name)
         ORDER BY revenue DESC LIMIT 10`,
        [year, month, branchId]
      ),
      pool.query(
        `SELECT da.id AS area_id, da.name AS area_name, COUNT(*) AS orders_count, SUM(o.total) AS revenue
         FROM orders o
         JOIN delivery_areas da ON da.id = o.delivery_area_id
         WHERE o.status <> 'cancelled' AND o.order_type = 'delivery'
           AND EXTRACT(YEAR FROM o.created_at) = $1 AND EXTRACT(MONTH FROM o.created_at) = $2
           AND ($3::int IS NULL OR o.branch_id = $3)
         GROUP BY da.id, da.name ORDER BY revenue DESC LIMIT 10`,
        [year, month, branchId]
      ),
      pool.query(
        `SELECT payment_status, COUNT(*) AS count, SUM(total) AS amount
         FROM orders o
         WHERE o.status <> 'cancelled'
           AND EXTRACT(YEAR FROM o.created_at) = $1 AND EXTRACT(MONTH FROM o.created_at) = $2
           AND ($3::int IS NULL OR o.branch_id = $3)
         GROUP BY payment_status`,
        [year, month, branchId]
      ),
      pool.query(
        `SELECT status, COUNT(*) AS count
         FROM orders o
         WHERE EXTRACT(YEAR FROM o.created_at) = $1 AND EXTRACT(MONTH FROM o.created_at) = $2
           AND ($3::int IS NULL OR o.branch_id = $3)
         GROUP BY status`,
        [year, month, branchId]
      ),
      pool.query(
        `SELECT ec.name AS category, SUM(e.amount) AS total
         FROM expenses e
         JOIN expense_categories ec ON ec.id = e.category_id
         WHERE EXTRACT(YEAR FROM e.business_date) = $1 AND EXTRACT(MONTH FROM e.business_date) = $2
           AND ($3::int IS NULL OR e.branch_id = $3)
         GROUP BY ec.name ORDER BY total DESC`,
        [year, month, branchId]
      ),
      computePayrollCostByBranch(year, month),
    ]);

    const scopedBranches = branchId ? byBranch.filter((r) => r.branchId === branchId) : byBranch;
    const revenue = scopedBranches.reduce((s, r) => s + r.revenue, 0);
    const cogs = scopedBranches.reduce((s, r) => s + r.cogs, 0);
    const ordersCount = scopedBranches.reduce((s, r) => s + r.ordersCount, 0);
    const grossProfit = revenue - cogs;
    const totalOpex = expensesResult.rows.reduce((s, r) => s + Number(r.total), 0);
    const payrollCost = branchId ? (payroll.byBranch[branchId] || 0) : payroll.total;
    const netProfitBeforePayroll = grossProfit - totalOpex;
    const netProfitAfterPayroll = netProfitBeforePayroll - payrollCost;

    res.json({
      year, month, branchId,
      summary: {
        revenue, cogs, grossProfit,
        grossMarginPercent: revenue > 0 ? grossProfit / revenue : null,
        ordersCount,
        avgOrderValue: ordersCount > 0 ? revenue / ordersCount : 0,
        totalOpex, payrollCost, netProfitBeforePayroll, netProfitAfterPayroll,
      },
      dailySales: dailySales.rows.map((r) => ({
        date: r.date, ordersCount: Number(r.orders_count), revenue: Number(r.revenue),
      })),
      topItems: topItems.rows.map((r) => ({
        name: r.name, quantity: Number(r.quantity), revenue: Number(r.revenue),
      })),
      topBranches: [...scopedBranches].sort((a, b) => b.revenue - a.revenue),
      topAreas: topAreas.rows.map((r) => ({
        areaId: r.area_id, areaName: r.area_name,
        ordersCount: Number(r.orders_count), revenue: Number(r.revenue),
      })),
      paymentStatusBreakdown: paymentStatusBreakdown.rows.map((r) => ({
        status: r.payment_status, count: Number(r.count), amount: Number(r.amount),
      })),
      orderStatusBreakdown: orderStatusBreakdown.rows.map((r) => ({
        status: r.status, count: Number(r.count),
      })),
      expenseLines: expensesResult.rows.map((r) => ({
        category: r.category, amount: Number(r.total),
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/reports/sales-detail?from=&to=&branchId= - تفصيل المبيعات: طرق الدفع، مصدر الطلب،
// نوع الطلب، والاتجاه اليومي - في نداء واحد
router.get("/sales-detail", requireAuth, canSeeReports, async (req, res) => {
  const range = resolveDateRange(req.query);
  if (!range) return res.status(400).json({ error: "لازم تحدد from/to أو year/month" });
  let branchId = req.query.branchId ? Number(req.query.branchId) : null;
  if (req.user.role === "branch_manager") branchId = req.user.branchId;

  try {
    const [summary, byPaymentMethod, bySource, byOrderType, dailyTrend] = await Promise.all([
      pool.query(
        `SELECT COUNT(*) AS orders_count, COALESCE(SUM(total), 0) AS revenue
         FROM orders o
         WHERE o.status <> 'cancelled' AND o.created_at::date BETWEEN $1 AND $2
           AND ($3::int IS NULL OR o.branch_id = $3)`,
        [range.from, range.to, branchId]
      ),
      pool.query(
        `SELECT COALESCE(pm.name, 'بدون طريقة دفع') AS name, pm.kind, SUM(o.total) AS amount, COUNT(*) AS count
         FROM orders o LEFT JOIN payment_methods pm ON pm.id = o.payment_method_id
         WHERE o.status <> 'cancelled' AND o.created_at::date BETWEEN $1 AND $2
           AND ($3::int IS NULL OR o.branch_id = $3)
         GROUP BY pm.name, pm.kind ORDER BY amount DESC`,
        [range.from, range.to, branchId]
      ),
      pool.query(
        `SELECT o.source, SUM(o.total) AS amount, COUNT(*) AS count
         FROM orders o
         WHERE o.status <> 'cancelled' AND o.created_at::date BETWEEN $1 AND $2
           AND ($3::int IS NULL OR o.branch_id = $3)
         GROUP BY o.source ORDER BY amount DESC`,
        [range.from, range.to, branchId]
      ),
      pool.query(
        `SELECT o.order_type, SUM(o.total) AS amount, COUNT(*) AS count
         FROM orders o
         WHERE o.status <> 'cancelled' AND o.created_at::date BETWEEN $1 AND $2
           AND ($3::int IS NULL OR o.branch_id = $3)
         GROUP BY o.order_type ORDER BY amount DESC`,
        [range.from, range.to, branchId]
      ),
      pool.query(
        `SELECT o.created_at::date AS date, SUM(o.total) AS revenue, COUNT(*) AS orders_count
         FROM orders o
         WHERE o.status <> 'cancelled' AND o.created_at::date BETWEEN $1 AND $2
           AND ($3::int IS NULL OR o.branch_id = $3)
         GROUP BY o.created_at::date ORDER BY date`,
        [range.from, range.to, branchId]
      ),
    ]);

    const ordersCount = Number(summary.rows[0].orders_count);
    const revenue = Number(summary.rows[0].revenue);
    res.json({
      from: range.from, to: range.to, branchId,
      summary: { revenue, ordersCount, avgOrderValue: ordersCount > 0 ? revenue / ordersCount : 0 },
      byPaymentMethod: byPaymentMethod.rows.map((r) => ({ name: r.name, kind: r.kind, amount: Number(r.amount), count: Number(r.count) })),
      bySource: bySource.rows.map((r) => ({ source: r.source, amount: Number(r.amount), count: Number(r.count) })),
      byOrderType: byOrderType.rows.map((r) => ({ orderType: r.order_type, amount: Number(r.amount), count: Number(r.count) })),
      dailyTrend: dailyTrend.rows.map((r) => ({ date: r.date, revenue: Number(r.revenue), ordersCount: Number(r.orders_count) })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/reports/cancelled-orders?from=&to=&branchId= - الطلبات الملغاة (قبل التنفيذ) والمسترجعة
// (Void بعد الاكتمال) منفصلين، مع أسباب الاسترجاع
router.get("/cancelled-orders", requireAuth, canSeeReports, async (req, res) => {
  const range = resolveDateRange(req.query);
  if (!range) return res.status(400).json({ error: "لازم تحدد from/to أو year/month" });
  let branchId = req.query.branchId ? Number(req.query.branchId) : null;
  if (req.user.role === "branch_manager") branchId = req.user.branchId;

  try {
    const rows = await pool.query(
      `SELECT o.id, o.branch_id, b.name AS branch_name, o.order_type, o.total, o.voided,
              o.void_reason, o.customer_name, o.customer_phone, o.created_at, o.voided_at
       FROM orders o LEFT JOIN branches b ON b.id = o.branch_id
       WHERE o.status = 'cancelled' AND o.created_at::date BETWEEN $1 AND $2
         AND ($3::int IS NULL OR o.branch_id = $3)
       ORDER BY o.created_at DESC`,
      [range.from, range.to, branchId]
    );
    const preFulfillment = rows.rows.filter((r) => !r.voided);
    const voided = rows.rows.filter((r) => r.voided);
    const reasonCounts = {};
    voided.forEach((r) => {
      const reason = r.void_reason || "(بدون سبب)";
      reasonCounts[reason] = (reasonCounts[reason] || 0) + 1;
    });

    res.json({
      from: range.from, to: range.to, branchId,
      summary: {
        totalCount: rows.rows.length,
        totalValue: rows.rows.reduce((s, r) => s + Number(r.total), 0),
        preFulfillmentCount: preFulfillment.length,
        preFulfillmentValue: preFulfillment.reduce((s, r) => s + Number(r.total), 0),
        voidedCount: voided.length,
        voidedValue: voided.reduce((s, r) => s + Number(r.total), 0),
        topVoidReasons: Object.entries(reasonCounts).map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count),
      },
      orders: rows.rows,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/reports/delays?from=&to=&branchId=&thresholdMinutes=45 - أي أوردر فضل "تحت التحضير" أكتر
// من الحد المسموح (افتراضيًا 45 دقيقة) قبل ما يتحول لأي حالة تانية (في الطريق/مكتمل/ملغي)
router.get("/delays", requireAuth, canSeeReports, async (req, res) => {
  const range = resolveDateRange(req.query);
  if (!range) return res.status(400).json({ error: "لازم تحدد from/to أو year/month" });
  let branchId = req.query.branchId ? Number(req.query.branchId) : null;
  if (req.user.role === "branch_manager") branchId = req.user.branchId;
  const thresholdMinutes = Number(req.query.thresholdMinutes) || 45;

  try {
    const result = await pool.query(
      `WITH transitions AS (
         SELECT DISTINCT ON (l.order_id) l.order_id, l.changed_at, l.status
         FROM order_status_log l
         WHERE l.status <> 'preparing'
         ORDER BY l.order_id, l.changed_at ASC
       )
       SELECT o.id, o.branch_id, b.name AS branch_name, o.order_type, o.status, o.customer_name,
              o.created_at, t.changed_at AS resolved_at, t.status AS resolved_to_status,
              EXTRACT(EPOCH FROM (COALESCE(t.changed_at, now()) - o.created_at)) / 60 AS prep_minutes
       FROM orders o
       LEFT JOIN branches b ON b.id = o.branch_id
       LEFT JOIN transitions t ON t.order_id = o.id
       WHERE o.created_at::date BETWEEN $1 AND $2
         AND ($3::int IS NULL OR o.branch_id = $3)
       ORDER BY prep_minutes DESC`,
      [range.from, range.to, branchId]
    );
    const rows = result.rows.map((r) => ({ ...r, prep_minutes: Number(r.prep_minutes) }));
    const delayed = rows.filter((r) => r.prep_minutes > thresholdMinutes);

    res.json({
      from: range.from, to: range.to, branchId, thresholdMinutes,
      summary: {
        totalOrders: rows.length,
        delayedCount: delayed.length,
        delayedPercent: rows.length > 0 ? delayed.length / rows.length : 0,
        avgPrepMinutes: rows.length > 0 ? rows.reduce((s, r) => s + r.prep_minutes, 0) / rows.length : 0,
      },
      delayedOrders: delayed,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/reports/item-performance?from=&to=&branchId=&limit=15 - الأصناف الأكثر/الأقل مبيعًا،
// والأقل ربحًا (بمساهمة الربح الفعلية، مش نسبة هامش نظرية) - في نداء واحد
router.get("/item-performance", requireAuth, canSeeReports, async (req, res) => {
  const range = resolveDateRange(req.query);
  if (!range) return res.status(400).json({ error: "لازم تحدد from/to أو year/month" });
  let branchId = req.query.branchId ? Number(req.query.branchId) : null;
  if (req.user.role === "branch_manager") branchId = req.user.branchId;
  const limit = Number(req.query.limit) || 15;

  try {
    const result = await pool.query(
      `SELECT COALESCE(mi.name || ' - ' || mv.label, c.name) AS name,
              SUM(oi.quantity) AS quantity, SUM(oi.line_total) AS revenue,
              SUM(COALESCE(oi.cost_at_sale, 0)) AS cost,
              BOOL_OR(oi.cost_at_sale IS NULL OR oi.cost_at_sale_incomplete) AS cost_incomplete
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
       LEFT JOIN menu_item_variants mv ON mv.id = oi.variant_id
       LEFT JOIN menu_items mi ON mi.id = mv.item_id
       LEFT JOIN combos c ON c.id = oi.combo_id
       WHERE o.status <> 'cancelled' AND o.created_at::date BETWEEN $1 AND $2
         AND ($3::int IS NULL OR o.branch_id = $3)
       GROUP BY COALESCE(mi.name || ' - ' || mv.label, c.name)`,
      [range.from, range.to, branchId]
    );

    const items = result.rows.map((r) => {
      const revenue = Number(r.revenue);
      const cost = Number(r.cost);
      return {
        name: r.name, quantity: Number(r.quantity), revenue, cost,
        profit: revenue - cost, costIncomplete: r.cost_incomplete,
      };
    });

    const sortedBy = (fn, dir) => [...items].sort((a, b) => dir * (fn(a) - fn(b))).slice(0, limit);

    res.json({
      from: range.from, to: range.to, branchId,
      topByRevenue: sortedBy((i) => i.revenue, -1),
      topByQuantity: sortedBy((i) => i.quantity, -1),
      leastByQuantity: sortedBy((i) => i.quantity, 1),
      leastProfitable: sortedBy((i) => i.profit, 1),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/reports/catalog?from=&to=&branchId= - كل الأصناف والأحجام (حتى اللي مبيعتش خالص في
// الفترة دي)، مع إجمالي المبيعات لكل واحد - عشان تعرف مين محتاج يتشال من المنيو
router.get("/catalog", requireAuth, canSeeReports, async (req, res) => {
  const range = resolveDateRange(req.query) || { from: "1900-01-01", to: "2999-12-31" };
  let branchId = req.query.branchId ? Number(req.query.branchId) : null;
  if (req.user.role === "branch_manager") branchId = req.user.branchId;

  try {
    const result = await pool.query(
      `SELECT mi.id AS item_id, mi.name AS item_name, mc.name AS category, mi.is_active,
              mv.id AS variant_id, mv.label, mv.price, mv.talabat_price,
              COALESCE(sales.quantity, 0) AS quantity_sold, COALESCE(sales.revenue, 0) AS revenue
       FROM menu_items mi
       JOIN menu_categories mc ON mc.id = mi.category_id
       JOIN menu_item_variants mv ON mv.item_id = mi.id
       LEFT JOIN (
         SELECT oi.variant_id, SUM(oi.quantity) AS quantity, SUM(oi.line_total) AS revenue
         FROM order_items oi JOIN orders o ON o.id = oi.order_id
         WHERE o.status <> 'cancelled' AND o.created_at::date BETWEEN $1 AND $2
           AND ($3::int IS NULL OR o.branch_id = $3)
         GROUP BY oi.variant_id
       ) sales ON sales.variant_id = mv.id
       ORDER BY mc.name, mi.name, mv.id`,
      [range.from, range.to, branchId]
    );
    res.json({
      from: range.from, to: range.to, branchId,
      items: result.rows.map((r) => ({
        itemId: r.item_id, itemName: r.item_name, category: r.category, isActive: r.is_active,
        variantId: r.variant_id, label: r.label, price: Number(r.price),
        talabatPrice: r.talabat_price != null ? Number(r.talabat_price) : null,
        quantitySold: Number(r.quantity_sold), revenue: Number(r.revenue),
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/reports/recipes - كل الريسبيهات (المكونات وكمياتها وتكلفتها لكل حجم) - بيوضح كمان أي حجم
// مفيهوش ريسبي خالص أو فيه مكوّن من غير تكلفة وحدة، عشان مراجعة جودة البيانات
router.get("/recipes", requireAuth, canSeeReports, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT mi.name AS item_name, mv.id AS variant_id, mv.label, mv.price,
              COALESCE(
                json_agg(jsonb_build_object('ingredient', ii.name, 'unit', ii.unit,
                  'quantityPerUnit', mvi.quantity_per_unit, 'unitCost', ii.unit_cost) ORDER BY ii.name)
                FILTER (WHERE mvi.id IS NOT NULL), '[]'
              ) AS ingredients,
              COUNT(mvi.id) AS ingredient_count,
              COALESCE(SUM(mvi.quantity_per_unit * ii.unit_cost), 0) AS recipe_cost,
              (COUNT(mvi.id) = 0) AS has_no_recipe,
              BOOL_OR(ii.unit_cost IS NULL) AS has_missing_cost
       FROM menu_item_variants mv
       JOIN menu_items mi ON mi.id = mv.item_id
       LEFT JOIN menu_item_variant_ingredients mvi ON mvi.variant_id = mv.id
       LEFT JOIN inventory_items ii ON ii.id = mvi.inventory_item_id
       GROUP BY mi.name, mv.id, mv.label, mv.price
       ORDER BY mi.name, mv.label`
    );
    res.json(result.rows.map((r) => ({
      itemName: r.item_name, variantId: r.variant_id, label: r.label, price: Number(r.price),
      ingredients: r.ingredients, ingredientCount: Number(r.ingredient_count),
      recipeCost: Number(r.recipe_cost), hasNoRecipe: r.has_no_recipe, hasMissingCost: r.has_missing_cost,
    })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/reports/expenses-report?from=&to=&branchId=&groupBy=day|month - المصروفات مجمّعة حسب
// البند والفترة، مع تنبيه على أي مصروف تجاوز حد التنبيه بتاع بنده (expense_categories.alert_threshold)
router.get("/expenses-report", requireAuth, canSeeReports, async (req, res) => {
  const range = resolveDateRange(req.query);
  if (!range) return res.status(400).json({ error: "لازم تحدد from/to أو year/month" });
  let branchId = req.query.branchId ? Number(req.query.branchId) : null;
  if (req.user.role === "branch_manager") branchId = req.user.branchId;
  const groupBy = req.query.groupBy === "month" ? "month" : "day";
  const truncExpr = groupBy === "month" ? "date_trunc('month', e.business_date)" : "e.business_date";

  try {
    const [byCategory, trend, anomalies] = await Promise.all([
      pool.query(
        `SELECT ec.name AS category, SUM(e.amount) AS total, COUNT(*) AS count
         FROM expenses e JOIN expense_categories ec ON ec.id = e.category_id
         WHERE e.business_date BETWEEN $1 AND $2 AND ($3::int IS NULL OR e.branch_id = $3)
         GROUP BY ec.name ORDER BY total DESC`,
        [range.from, range.to, branchId]
      ),
      pool.query(
        `SELECT ${truncExpr} AS period, SUM(e.amount) AS total
         FROM expenses e
         WHERE e.business_date BETWEEN $1 AND $2 AND ($3::int IS NULL OR e.branch_id = $3)
         GROUP BY period ORDER BY period`,
        [range.from, range.to, branchId]
      ),
      pool.query(
        `SELECT e.id, e.business_date, e.branch_id, b.name AS branch_name, ec.name AS category,
                e.amount, ec.alert_threshold, e.notes
         FROM expenses e
         JOIN expense_categories ec ON ec.id = e.category_id
         LEFT JOIN branches b ON b.id = e.branch_id
         WHERE e.business_date BETWEEN $1 AND $2 AND ($3::int IS NULL OR e.branch_id = $3)
           AND ec.alert_threshold IS NOT NULL AND e.amount > ec.alert_threshold
         ORDER BY e.amount DESC`,
        [range.from, range.to, branchId]
      ),
    ]);

    res.json({
      from: range.from, to: range.to, branchId, groupBy,
      total: byCategory.rows.reduce((s, r) => s + Number(r.total), 0),
      byCategory: byCategory.rows.map((r) => ({ category: r.category, total: Number(r.total), count: Number(r.count) })),
      trend: trend.rows.map((r) => ({ period: r.period, total: Number(r.total) })),
      anomalies: anomalies.rows.map((r) => ({
        id: r.id, businessDate: r.business_date, branchId: r.branch_id, branchName: r.branch_name,
        category: r.category, amount: Number(r.amount), alertThreshold: Number(r.alert_threshold), notes: r.notes,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/reports/purchases-report?from=&to=&branchId=&groupBy=day|month - المشتريات مجمّعة حسب
// النوع والفترة، وموضّح فيها اللي من السنتر كيتشن (بالتكلفة) واللي من مورد خارجي
router.get("/purchases-report", requireAuth, canSeeReports, async (req, res) => {
  const range = resolveDateRange(req.query);
  if (!range) return res.status(400).json({ error: "لازم تحدد from/to أو year/month" });
  let branchId = req.query.branchId ? Number(req.query.branchId) : null;
  if (req.user.role === "branch_manager") branchId = req.user.branchId;
  const groupBy = req.query.groupBy === "month" ? "month" : "day";
  const truncExpr = groupBy === "month" ? "date_trunc('month', business_date)" : "business_date";

  try {
    const [byCategory, trend, byKitchen] = await Promise.all([
      pool.query(
        `SELECT COALESCE(category, 'غير محدد') AS category, SUM(amount) AS total, COUNT(*) AS count
         FROM purchases
         WHERE business_date BETWEEN $1 AND $2 AND ($3::int IS NULL OR branch_id = $3)
         GROUP BY category ORDER BY total DESC`,
        [range.from, range.to, branchId]
      ),
      pool.query(
        `SELECT ${truncExpr} AS period, SUM(amount) AS total
         FROM purchases
         WHERE business_date BETWEEN $1 AND $2 AND ($3::int IS NULL OR branch_id = $3)
         GROUP BY period ORDER BY period`,
        [range.from, range.to, branchId]
      ),
      pool.query(
        `SELECT from_kitchen, SUM(amount) AS total, COUNT(*) AS count
         FROM purchases
         WHERE business_date BETWEEN $1 AND $2 AND ($3::int IS NULL OR branch_id = $3)
         GROUP BY from_kitchen`,
        [range.from, range.to, branchId]
      ),
    ]);

    res.json({
      from: range.from, to: range.to, branchId, groupBy,
      total: byCategory.rows.reduce((s, r) => s + Number(r.total), 0),
      byCategory: byCategory.rows.map((r) => ({ category: r.category, total: Number(r.total), count: Number(r.count) })),
      trend: trend.rows.map((r) => ({ period: r.period, total: Number(r.total) })),
      byKitchen: byKitchen.rows.map((r) => ({ fromKitchen: r.from_kitchen, total: Number(r.total), count: Number(r.count) })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/reports/areas-performance?from=&to=&branchId= - مناطق التوصيل الأكثر مبيعًا، لكل فرع
// على حدة وكمان مجمّعة على مستوى كل الفروع
router.get("/areas-performance", requireAuth, canSeeReports, async (req, res) => {
  const range = resolveDateRange(req.query);
  if (!range) return res.status(400).json({ error: "لازم تحدد from/to أو year/month" });
  let branchId = req.query.branchId ? Number(req.query.branchId) : null;
  if (req.user.role === "branch_manager") branchId = req.user.branchId;

  try {
    const [byBranchAndArea, combinedByArea] = await Promise.all([
      pool.query(
        `SELECT o.branch_id, b.name AS branch_name, da.id AS area_id, da.name AS area_name,
                COUNT(*) AS orders_count, SUM(o.total) AS revenue
         FROM orders o
         JOIN delivery_areas da ON da.id = o.delivery_area_id
         LEFT JOIN branches b ON b.id = o.branch_id
         WHERE o.status <> 'cancelled' AND o.order_type = 'delivery'
           AND o.created_at::date BETWEEN $1 AND $2 AND ($3::int IS NULL OR o.branch_id = $3)
         GROUP BY o.branch_id, b.name, da.id, da.name
         ORDER BY revenue DESC`,
        [range.from, range.to, branchId]
      ),
      pool.query(
        `SELECT da.id AS area_id, da.name AS area_name, COUNT(*) AS orders_count, SUM(o.total) AS revenue
         FROM orders o
         JOIN delivery_areas da ON da.id = o.delivery_area_id
         WHERE o.status <> 'cancelled' AND o.order_type = 'delivery'
           AND o.created_at::date BETWEEN $1 AND $2 AND ($3::int IS NULL OR o.branch_id = $3)
         GROUP BY da.id, da.name
         ORDER BY revenue DESC`,
        [range.from, range.to, branchId]
      ),
    ]);

    res.json({
      from: range.from, to: range.to, branchId,
      byBranchAndArea: byBranchAndArea.rows.map((r) => ({
        branchId: r.branch_id, branchName: r.branch_name, areaId: r.area_id, areaName: r.area_name,
        ordersCount: Number(r.orders_count), revenue: Number(r.revenue),
      })),
      combinedByArea: combinedByArea.rows.map((r) => ({
        areaId: r.area_id, areaName: r.area_name, ordersCount: Number(r.orders_count), revenue: Number(r.revenue),
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/reports/drivers?from=&to=&branchId= - أداء كل طيار: عدد الأوردرات، الإيرادات اللي وصّلها،
// متوسط وقت التوصيل الفعلي (من "خرج مع الطيار" لحد "اتسلم")، وعدد الإلغاءات
router.get("/drivers", requireAuth, canSeeReports, async (req, res) => {
  const range = resolveDateRange(req.query);
  if (!range) return res.status(400).json({ error: "لازم تحدد from/to أو year/month" });
  let branchId = req.query.branchId ? Number(req.query.branchId) : null;
  if (req.user.role === "branch_manager") branchId = req.user.branchId;

  try {
    const result = await pool.query(
      `WITH dispatch_times AS (
         SELECT DISTINCT ON (order_id) order_id, changed_at AS dispatched_at
         FROM order_status_log WHERE status = 'out_for_delivery' ORDER BY order_id, changed_at ASC
       ), complete_times AS (
         SELECT DISTINCT ON (order_id) order_id, changed_at AS completed_at
         FROM order_status_log WHERE status = 'completed' ORDER BY order_id, changed_at ASC
       )
       SELECT o.driver_name,
              COUNT(*) FILTER (WHERE o.status <> 'cancelled') AS orders_count,
              COALESCE(SUM(o.total) FILTER (WHERE o.status <> 'cancelled'), 0) AS revenue,
              COUNT(*) FILTER (WHERE o.status = 'cancelled') AS cancelled_count,
              AVG(EXTRACT(EPOCH FROM (ct.completed_at - dt.dispatched_at)) / 60)
                FILTER (WHERE o.status <> 'cancelled') AS avg_delivery_minutes
       FROM orders o
       LEFT JOIN dispatch_times dt ON dt.order_id = o.id
       LEFT JOIN complete_times ct ON ct.order_id = o.id
       WHERE o.driver_name IS NOT NULL AND o.created_at::date BETWEEN $1 AND $2
         AND ($3::int IS NULL OR o.branch_id = $3)
       GROUP BY o.driver_name
       ORDER BY orders_count DESC`,
      [range.from, range.to, branchId]
    );
    res.json({
      from: range.from, to: range.to, branchId,
      drivers: result.rows.map((r) => ({
        driverName: r.driver_name, ordersCount: Number(r.orders_count), revenue: Number(r.revenue),
        cancelledCount: Number(r.cancelled_count),
        avgDeliveryMinutes: r.avg_delivery_minutes != null ? Number(r.avg_delivery_minutes) : null,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/reports/delivery-service?from=&to=&branchId=&thresholdMinutes=45 - مؤشرات خدمة الدليفري
// الإجمالية: متوسط وقت التحضير، متوسط وقت التوصيل الفعلي، نسبة الالتزام بالوقت، ونسبة الإلغاء
router.get("/delivery-service", requireAuth, canSeeReports, async (req, res) => {
  const range = resolveDateRange(req.query);
  if (!range) return res.status(400).json({ error: "لازم تحدد from/to أو year/month" });
  let branchId = req.query.branchId ? Number(req.query.branchId) : null;
  if (req.user.role === "branch_manager") branchId = req.user.branchId;
  const thresholdMinutes = Number(req.query.thresholdMinutes) || 45;

  try {
    const result = await pool.query(
      `WITH dispatch_times AS (
         SELECT DISTINCT ON (order_id) order_id, changed_at AS dispatched_at
         FROM order_status_log WHERE status = 'out_for_delivery' ORDER BY order_id, changed_at ASC
       ), complete_times AS (
         SELECT DISTINCT ON (order_id) order_id, changed_at AS completed_at
         FROM order_status_log WHERE status = 'completed' ORDER BY order_id, changed_at ASC
       )
       SELECT
         COUNT(*) AS total_orders,
         COUNT(*) FILTER (WHERE o.status = 'cancelled') AS cancelled_count,
         AVG(EXTRACT(EPOCH FROM (dt.dispatched_at - o.created_at)) / 60) AS avg_prep_minutes,
         AVG(EXTRACT(EPOCH FROM (ct.completed_at - dt.dispatched_at)) / 60) AS avg_delivery_minutes,
         AVG(EXTRACT(EPOCH FROM (ct.completed_at - o.created_at)) / 60) AS avg_total_minutes,
         COUNT(*) FILTER (WHERE dt.dispatched_at IS NOT NULL
           AND EXTRACT(EPOCH FROM (dt.dispatched_at - o.created_at)) / 60 <= $4) AS on_time_count,
         COUNT(*) FILTER (WHERE dt.dispatched_at IS NOT NULL) AS dispatched_count
       FROM orders o
       LEFT JOIN dispatch_times dt ON dt.order_id = o.id
       LEFT JOIN complete_times ct ON ct.order_id = o.id
       WHERE o.order_type = 'delivery' AND o.created_at::date BETWEEN $1 AND $2
         AND ($3::int IS NULL OR o.branch_id = $3)`,
      [range.from, range.to, branchId, thresholdMinutes]
    );
    const r = result.rows[0];
    const totalOrders = Number(r.total_orders);
    const dispatchedCount = Number(r.dispatched_count);
    res.json({
      from: range.from, to: range.to, branchId, thresholdMinutes,
      totalOrders,
      cancelledCount: Number(r.cancelled_count),
      cancellationRate: totalOrders > 0 ? Number(r.cancelled_count) / totalOrders : 0,
      avgPrepMinutes: r.avg_prep_minutes != null ? Number(r.avg_prep_minutes) : null,
      avgDeliveryMinutes: r.avg_delivery_minutes != null ? Number(r.avg_delivery_minutes) : null,
      avgTotalMinutes: r.avg_total_minutes != null ? Number(r.avg_total_minutes) : null,
      onTimeRate: dispatchedCount > 0 ? Number(r.on_time_count) / dispatchedCount : null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/reports/waste?from=&to=&branchId= - الهالك (تلف/انتهاء صلاحية/كسر): الكمية والقيمة
// المفقودة لكل مكوّن، من inventory_movements (movement_type='waste')
router.get("/waste", requireAuth, canSeeReports, async (req, res) => {
  const range = resolveDateRange(req.query);
  if (!range) return res.status(400).json({ error: "لازم تحدد from/to أو year/month" });
  let branchId = req.query.branchId ? Number(req.query.branchId) : null;
  if (req.user.role === "branch_manager") branchId = req.user.branchId;

  try {
    const [byItem, entries] = await Promise.all([
      pool.query(
        `SELECT ii.id AS inventory_item_id, ii.name, ii.unit,
                SUM(-im.quantity) AS quantity_wasted,
                SUM(-im.quantity * COALESCE(ii.unit_cost, 0)) AS value_wasted,
                BOOL_OR(ii.unit_cost IS NULL) AS cost_incomplete
         FROM inventory_movements im
         JOIN inventory_items ii ON ii.id = im.inventory_item_id
         WHERE im.movement_type IN ('waste', 'WASTE') AND im.business_date BETWEEN $1 AND $2
           AND ($3::int IS NULL OR im.branch_id = $3)
         GROUP BY ii.id, ii.name, ii.unit
         ORDER BY value_wasted DESC`,
        [range.from, range.to, branchId]
      ),
      pool.query(
        `SELECT im.id, im.branch_id, b.name AS branch_name, ii.name AS item_name, ii.unit,
                -im.quantity AS quantity, im.business_date, im.notes, u.name AS recorded_by
         FROM inventory_movements im
         JOIN inventory_items ii ON ii.id = im.inventory_item_id
         LEFT JOIN branches b ON b.id = im.branch_id
         LEFT JOIN users u ON u.id = im.created_by
         WHERE im.movement_type IN ('waste', 'WASTE') AND im.business_date BETWEEN $1 AND $2
           AND ($3::int IS NULL OR im.branch_id = $3)
         ORDER BY im.business_date DESC, im.id DESC`,
        [range.from, range.to, branchId]
      ),
    ]);

    res.json({
      from: range.from, to: range.to, branchId,
      totalValueWasted: byItem.rows.reduce((s, r) => s + Number(r.value_wasted), 0),
      byItem: byItem.rows.map((r) => ({
        inventoryItemId: r.inventory_item_id, name: r.name, unit: r.unit,
        quantityWasted: Number(r.quantity_wasted), valueWasted: Number(r.value_wasted), costIncomplete: r.cost_incomplete,
      })),
      entries: entries.rows.map((r) => ({
        id: r.id, branchId: r.branch_id, branchName: r.branch_name, itemName: r.item_name, unit: r.unit,
        quantity: Number(r.quantity), businessDate: r.business_date, notes: r.notes, recordedBy: r.recorded_by,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/reports/peak-hours?from=&to=&branchId= - ساعات الذروة (عدد الطلبات والإيراد حسب ساعة
// اليوم ويوم الأسبوع) - يفيد في جدولة الشيفتات على الأوقات المزدحمة فعليًا
router.get("/peak-hours", requireAuth, canSeeReports, async (req, res) => {
  const range = resolveDateRange(req.query);
  if (!range) return res.status(400).json({ error: "لازم تحدد from/to أو year/month" });
  let branchId = req.query.branchId ? Number(req.query.branchId) : null;
  if (req.user.role === "branch_manager") branchId = req.user.branchId;

  try {
    const [byHour, byDow] = await Promise.all([
      pool.query(
        `SELECT EXTRACT(HOUR FROM o.created_at)::int AS hour, COUNT(*) AS orders_count, SUM(o.total) AS revenue
         FROM orders o
         WHERE o.status <> 'cancelled' AND o.created_at::date BETWEEN $1 AND $2
           AND ($3::int IS NULL OR o.branch_id = $3)
         GROUP BY hour ORDER BY hour`,
        [range.from, range.to, branchId]
      ),
      pool.query(
        `SELECT EXTRACT(DOW FROM o.created_at)::int AS dow, COUNT(*) AS orders_count, SUM(o.total) AS revenue
         FROM orders o
         WHERE o.status <> 'cancelled' AND o.created_at::date BETWEEN $1 AND $2
           AND ($3::int IS NULL OR o.branch_id = $3)
         GROUP BY dow ORDER BY dow`,
        [range.from, range.to, branchId]
      ),
    ]);
    const dayNames = ["الأحد", "الاثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"];
    res.json({
      from: range.from, to: range.to, branchId,
      byHour: byHour.rows.map((r) => ({ hour: r.hour, ordersCount: Number(r.orders_count), revenue: Number(r.revenue) })),
      byDayOfWeek: byDow.rows.map((r) => ({ dow: r.dow, dayName: dayNames[r.dow], ordersCount: Number(r.orders_count), revenue: Number(r.revenue) })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/reports/customer-spend?from=&to=&branchId=&limit=20 - أعلى العملاء إنفاقًا وتكرار طلب
// في الفترة، وعدد العملاء الجدد (أول طلب ليهم على الإطلاق وقع في الفترة دي)
router.get("/customer-spend", requireAuth, canSeeReports, async (req, res) => {
  const range = resolveDateRange(req.query);
  if (!range) return res.status(400).json({ error: "لازم تحدد from/to أو year/month" });
  let branchId = req.query.branchId ? Number(req.query.branchId) : null;
  if (req.user.role === "branch_manager") branchId = req.user.branchId;
  const limit = Number(req.query.limit) || 20;

  try {
    const [topCustomers, newCustomers] = await Promise.all([
      pool.query(
        `SELECT o.customer_phone AS phone, COALESCE(c.name, o.customer_name) AS name,
                COUNT(*) AS orders_count, SUM(o.total) AS total_spent, MAX(o.created_at) AS last_order_at
         FROM orders o
         LEFT JOIN customers c ON c.phone = o.customer_phone
         WHERE o.status <> 'cancelled' AND o.customer_phone IS NOT NULL
           AND o.created_at::date BETWEEN $1 AND $2
           AND ($3::int IS NULL OR o.branch_id = $3)
         GROUP BY o.customer_phone, COALESCE(c.name, o.customer_name)
         ORDER BY total_spent DESC LIMIT $4`,
        [range.from, range.to, branchId, limit]
      ),
      pool.query(
        `WITH first_orders AS (
           SELECT customer_phone, MIN(created_at) AS first_order_at
           FROM orders WHERE customer_phone IS NOT NULL GROUP BY customer_phone
         )
         SELECT COUNT(*) AS new_customers_count
         FROM first_orders
         WHERE first_order_at::date BETWEEN $1 AND $2`,
        [range.from, range.to]
      ),
    ]);

    res.json({
      from: range.from, to: range.to, branchId,
      newCustomersCount: Number(newCustomers.rows[0].new_customers_count),
      topCustomers: topCustomers.rows.map((r) => ({
        phone: r.phone, name: r.name, ordersCount: Number(r.orders_count),
        totalSpent: Number(r.total_spent),
        avgOrderValue: Number(r.total_spent) / Number(r.orders_count),
        lastOrderAt: r.last_order_at,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/reports/inventory-valuation?branchId= - قيمة المخزون الحالي (رصيد كل مكوّن × تكلفة
// الوحدة) في لحظة معينة - مش بمدى تاريخ زي باقي التقارير، ده رصيد لحظي فعلي
router.get("/inventory-valuation", requireAuth, canSeeReports, async (req, res) => {
  let branchId = req.query.branchId ? Number(req.query.branchId) : null;
  if (req.user.role === "branch_manager") branchId = req.user.branchId;

  try {
    const result = await pool.query(
      `SELECT b.id AS branch_id, b.name AS branch_name, ii.id AS inventory_item_id, ii.name AS item_name,
              ii.unit, bis.quantity, ii.unit_cost,
              (bis.quantity * COALESCE(ii.unit_cost, 0)) AS value
       FROM branch_inventory_stock bis
       JOIN branches b ON b.id = bis.branch_id
       JOIN inventory_items ii ON ii.id = bis.inventory_item_id
       WHERE bis.quantity <> 0 AND ($1::int IS NULL OR b.id = $1)
       ORDER BY b.name, value DESC`,
      [branchId]
    );

    const items = result.rows.map((r) => ({
      branchId: r.branch_id, branchName: r.branch_name,
      inventoryItemId: r.inventory_item_id, itemName: r.item_name, unit: r.unit,
      quantity: Number(r.quantity), unitCost: r.unit_cost != null ? Number(r.unit_cost) : null,
      value: Number(r.value), costIncomplete: r.unit_cost === null,
    }));

    const byBranchMap = {};
    items.forEach((i) => {
      if (!byBranchMap[i.branchId]) byBranchMap[i.branchId] = { branchId: i.branchId, branchName: i.branchName, totalValue: 0 };
      byBranchMap[i.branchId].totalValue += i.value;
    });

    res.json({
      branchId,
      totalValue: items.reduce((s, i) => s + i.value, 0),
      byBranch: Object.values(byBranchMap).sort((a, b) => b.totalValue - a.totalValue),
      items,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/reports/stock-card?branchId=&itemId=&from=&to= - "كارت الصنف": كل حركة اتسجلت عليه
// بالترتيب الزمني مع الرصيد قبل وبعد كل حركة (من الليدجر مباشرة - مش حساب متجدد)
router.get("/stock-card", requireAuth, canSeeReports, async (req, res) => {
  const { itemId } = req.query;
  const range = resolveDateRange(req.query);
  if (!itemId) return res.status(400).json({ error: "لازم تحدد itemId" });
  let branchId = req.query.branchId ? Number(req.query.branchId) : null;
  if (req.user.role === "branch_manager") branchId = req.user.branchId;
  if (!branchId) return res.status(400).json({ error: "لازم تحدد branchId" });

  try {
    const result = await pool.query(
      `SELECT im.id, im.movement_type, im.quantity, im.unit, im.unit_cost, im.total_cost,
              im.quantity_before, im.quantity_after, im.reference_type, im.reference_id,
              im.reason, im.notes, im.business_date, im.created_at, u.name AS created_by_name
       FROM inventory_movements im
       LEFT JOIN users u ON u.id = im.created_by
       WHERE im.branch_id = $1 AND im.inventory_item_id = $2
         AND ($3::date IS NULL OR im.business_date >= $3) AND ($4::date IS NULL OR im.business_date <= $4)
       ORDER BY im.created_at ASC, im.id ASC`,
      [branchId, itemId, range?.from || null, range?.to || null]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/reports/transfers?branchId=&from=&to= - تقرير التحويلات (فوري أو مرحلي) مع الفرق بين
// المُرسل والمُستلم (variance) لو موجود
router.get("/transfers", requireAuth, canSeeReports, async (req, res) => {
  const range = resolveDateRange(req.query);
  if (!range) return res.status(400).json({ error: "لازم تحدد from/to أو year/month" });
  let branchId = req.query.branchId ? Number(req.query.branchId) : null;
  if (req.user.role === "branch_manager") branchId = req.user.branchId;

  try {
    const transfers = await pool.query(
      `SELECT kt.*, fb.name AS from_branch_name, tb.name AS to_branch_name
       FROM kitchen_transfers kt
       LEFT JOIN branches fb ON fb.id = kt.from_branch_id
       JOIN branches tb ON tb.id = kt.to_branch_id
       WHERE kt.business_date BETWEEN $1 AND $2
         AND ($3::int IS NULL OR kt.to_branch_id = $3 OR kt.from_branch_id = $3)
       ORDER BY kt.business_date DESC, kt.id DESC`,
      [range.from, range.to, branchId]
    );
    const ids = transfers.rows.map((t) => t.id);
    const items = ids.length
      ? (await pool.query(
          `SELECT kti.*, ii.name AS item_name, ii.unit FROM kitchen_transfer_items kti
           JOIN inventory_items ii ON ii.id = kti.inventory_item_id WHERE kti.kitchen_transfer_id = ANY($1)`,
          [ids]
        )).rows
      : [];
    res.json(transfers.rows.map((t) => ({
      ...t,
      items: items.filter((it) => it.kitchen_transfer_id === t.id).map((it) => ({
        ...it,
        variance: it.quantity_sent != null && it.quantity_received != null
          ? Number(it.quantity_sent) - Number(it.quantity_received) : null,
      })),
    })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/reports/expiring-batches?days=7&branchId= - دفعات هتنتهي صلاحيتها قريب
router.get("/expiring-batches", requireAuth, canSeeReports, async (req, res) => {
  const days = Number(req.query.days) || 7;
  let branchId = req.query.branchId ? Number(req.query.branchId) : null;
  if (req.user.role === "branch_manager") branchId = req.user.branchId;
  try {
    const result = await pool.query(
      `SELECT b.*, ii.name AS item_name, ii.unit, br.name AS branch_name
       FROM inventory_batches b
       JOIN inventory_items ii ON ii.id = b.inventory_item_id
       JOIN branches br ON br.id = b.branch_id
       WHERE b.status = 'active' AND b.remaining_quantity > 0
         AND b.expiry_date IS NOT NULL AND b.expiry_date <= (CURRENT_DATE + ($1 || ' days')::interval)
         AND ($2::int IS NULL OR b.branch_id = $2)
       ORDER BY b.expiry_date ASC`,
      [days, branchId]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/reports/negative-stock?branchId= - أي صنف رصيده سالب دلوقتي (تنبيه - يحتاج مراجعة)
router.get("/negative-stock", requireAuth, canSeeReports, async (req, res) => {
  let branchId = req.query.branchId ? Number(req.query.branchId) : null;
  if (req.user.role === "branch_manager") branchId = req.user.branchId;
  try {
    const result = await pool.query(
      `SELECT bis.branch_id, b.name AS branch_name, bis.inventory_item_id, ii.name AS item_name,
              ii.unit, bis.quantity, ii.allow_negative_stock
       FROM branch_inventory_stock bis
       JOIN branches b ON b.id = bis.branch_id
       JOIN inventory_items ii ON ii.id = bis.inventory_item_id
       WHERE bis.quantity < 0 AND ($1::int IS NULL OR bis.branch_id = $1)
       ORDER BY bis.quantity ASC`,
      [branchId]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/reports/inventory-comparison?itemId= - رصيد صنف معيّن في كل الفروع جنب بعض (أدمن بس -
// مقارنة بين فروع محتاجة رؤية على كل الفروع مش فرع واحد)
router.get("/inventory-comparison", requireAuth, requireRole("admin", "accountant"), async (req, res) => {
  const { itemId } = req.query;
  try {
    const result = await pool.query(
      `SELECT b.id AS branch_id, b.name AS branch_name, ii.id AS inventory_item_id, ii.name AS item_name,
              ii.unit, COALESCE(bis.quantity, 0) AS quantity
       FROM branches b
       CROSS JOIN inventory_items ii
       LEFT JOIN branch_inventory_stock bis ON bis.branch_id = b.id AND bis.inventory_item_id = ii.id
       WHERE b.is_central_kitchen = FALSE AND ($1::int IS NULL OR ii.id = $1)
       ORDER BY ii.name, b.name`,
      [itemId || null]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== المرحلة 3: تقارير محرك الوصفات/التصنيع/التكلفة ====================

// GET /api/reports/production-variance?branchId=&from=&to= - فرق الإنتاج (الفعلي مقابل المخطط) لكل
// أوامر التصنيع المكتملة في المدى - بيعرض السبب المسجّل لو الفرق تجاوز الحد المسموح
router.get("/production-variance", requireAuth, canSeeReports, requirePermission("production.view"), async (req, res) => {
  const range = resolveDateRange(req.query);
  if (!range) return res.status(400).json({ error: "لازم تحدد from/to أو year/month" });
  let branchId = req.query.branchId ? Number(req.query.branchId) : null;
  if (req.user.role === "branch_manager") branchId = req.user.branchId;
  try {
    const result = await pool.query(
      `SELECT po.id, po.branch_id, b.name AS branch_name, po.recipe_id, rv.version_number,
              COALESCE(mi.name || ' - ' || v.label, ii.name) AS product_name,
              po.planned_quantity, po.actual_quantity,
              (po.actual_quantity - po.planned_quantity) AS variance,
              CASE WHEN po.planned_quantity > 0
                   THEN ROUND((po.actual_quantity - po.planned_quantity) / po.planned_quantity * 100, 2)
                   ELSE NULL END AS variance_percent,
              po.variance_reason, po.completed_at
       FROM production_orders po
       JOIN branches b ON b.id = po.branch_id
       JOIN recipes r ON r.id = po.recipe_id
       JOIN recipe_versions rv ON rv.id = po.recipe_version_id
       LEFT JOIN menu_item_variants v ON v.id = r.variant_id
       LEFT JOIN menu_items mi ON mi.id = v.item_id
       LEFT JOIN inventory_items ii ON ii.id = r.inventory_item_id
       WHERE po.status = 'COMPLETED' AND po.completed_at::date BETWEEN $1 AND $2
         AND ($3::int IS NULL OR po.branch_id = $3)
       ORDER BY po.completed_at DESC`,
      [range.from, range.to, branchId]
    );
    res.json(result.rows.map((r) => ({
      ...r,
      planned_quantity: Number(r.planned_quantity), actual_quantity: Number(r.actual_quantity),
      variance: Number(r.variance), variance_percent: r.variance_percent != null ? Number(r.variance_percent) : null,
    })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// المرحلة 3.1: كل شكل من أشكال "استهلاك/تكلفة الطعام" بيتحسب دلوقتي من db/food-cost-engine.js -
// مصدر واحد للتصنيف والتسعير التاريخي، مش منطق منفصل مكرر في كل endpoint (كان كده قبل كده، وكان فيه
// باج حقيقي: التكلفة النظرية كانت بتتحسب بسعر النهارده الحالي مش بالسعر التاريخي وقت الحدث - اتصلح).
async function itemNamesById(itemIds) {
  if (itemIds.length === 0) return new Map();
  const result = await pool.query("SELECT id, name, unit FROM inventory_items WHERE id = ANY($1)", [itemIds]);
  return new Map(result.rows.map((r) => [r.id, r]));
}

// GET /api/reports/theoretical-vs-actual-consumption?branchId=&from=&to= - كميات كل فئة استهلاك لكل صنف
// خام على حدة (نظري/بيع/تصنيع/هالك/تسوية/تحويل صادر/تحويل وارد/مرتجعات/إجمالي استهلاك/فرق تشغيلي) -
// من غير خلط الهالك أو التسوية جوه رقم "المبيعات" (كان كده قبل كده)
router.get("/theoretical-vs-actual-consumption", requireAuth, canSeeReports, requirePermission("food_cost.view"), async (req, res) => {
  const range = resolveDateRange(req.query);
  if (!range) return res.status(400).json({ error: "لازم تحدد from/to أو year/month" });
  let branchId = req.query.branchId ? Number(req.query.branchId) : null;
  if (req.user.role === "branch_manager") branchId = req.user.branchId;
  try {
    const byItem = await computeConsumptionBreakdown(pool, { branchId, from: range.from, to: range.to });
    const names = await itemNamesById([...byItem.keys()]);
    const rows = [...byItem.entries()].map(([itemId, b]) => ({
      inventoryItemId: itemId, itemName: names.get(itemId)?.name || null, unit: names.get(itemId)?.unit || null,
      theoreticalQty: b.theoretical.qty, theoreticalIncomplete: b.theoretical.incomplete,
      salesQty: b.sales.qty, productionQty: b.production.qty, wasteQty: b.waste.qty, adjustmentQty: b.adjustment.qty,
      transferOutQty: b.transferOut.qty, transferInQty: b.transferIn.qty, returnsQty: b.returns.qty,
      totalUsageQty: b.totalUsage.qty,
      operationalVarianceQty: b.operationalVarianceQty, operationalVarianceQtyPercent: b.operationalVarianceQtyPercent,
    })).sort((a, b) => Math.abs(b.operationalVarianceQty) - Math.abs(a.operationalVarianceQty));
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/reports/food-cost-variance?branchId=&from=&to= - نفس التصنيف بس بالتكلفة، حسب التعريفات:
// A) Theoretical Food Cost - تكلفة الوصفة مسعّرة بسعر لحظة الحدث (مجمّدة، مش سعر النهارده)
// B) Sales Food Cost - القيمة الفعلية اللي طلعت من المخزون بسبب البيع (من حركات SALE الحقيقية)
// C) Waste Cost, D) Adjustment Cost - من حركات WASTE/ADJUSTMENT الحقيقية
// E) Total Inventory Usage Cost = B + Production + C + D (من غير تحويلات/مرتجعات)
// F) Food Cost Variance = E − A, G) Food Cost Variance % = F ÷ A × 100
router.get("/food-cost-variance", requireAuth, canSeeReports, requirePermission("food_cost.view"), async (req, res) => {
  const range = resolveDateRange(req.query);
  if (!range) return res.status(400).json({ error: "لازم تحدد from/to أو year/month" });
  let branchId = req.query.branchId ? Number(req.query.branchId) : null;
  if (req.user.role === "branch_manager") branchId = req.user.branchId;
  try {
    const byItem = await computeConsumptionBreakdown(pool, { branchId, from: range.from, to: range.to });
    const names = await itemNamesById([...byItem.keys()]);
    const rows = [...byItem.entries()].map(([itemId, b]) => ({
      inventoryItemId: itemId, itemName: names.get(itemId)?.name || null, unit: names.get(itemId)?.unit || null,
      theoreticalFoodCost: b.theoretical.cost, theoreticalIncomplete: b.theoretical.incomplete,
      salesFoodCost: b.sales.cost, productionCost: b.production.cost, wasteCost: b.waste.cost, adjustmentCost: b.adjustment.cost,
      transferOutCost: b.transferOut.cost, transferInCost: b.transferIn.cost, returnsCost: b.returns.cost,
      totalInventoryUsageCost: b.totalUsage.cost,
      foodCostVariance: b.foodCostVariance, foodCostVariancePercent: b.foodCostVariancePercent,
    })).sort((a, b) => Math.abs(b.foodCostVariance) - Math.abs(a.foodCostVariance));
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/reports/branch-food-cost?branchId=&from=&to= - نفس التعريفات A-G بس مجمّعة على مستوى
// الفرع/الفترة كامل + الإيراد ونسبة تكلفة الطعام - بدون branchId بيرجّع مقارنة كل الفروع جنب بعض
router.get("/branch-food-cost", requireAuth, canSeeReports, requirePermission("food_cost.view"), async (req, res) => {
  const range = resolveDateRange(req.query);
  if (!range) return res.status(400).json({ error: "لازم تحدد from/to أو year/month" });
  let branchId = req.query.branchId ? Number(req.query.branchId) : null;
  if (req.user.role === "branch_manager") branchId = req.user.branchId;
  try {
    const branchesRes = await pool.query(
      `SELECT DISTINCT o.branch_id, b.name AS branch_name
       FROM orders o JOIN branches b ON b.id = o.branch_id
       WHERE o.status <> 'cancelled' AND o.created_at::date BETWEEN $1 AND $2 AND ($3::int IS NULL OR o.branch_id = $3)`,
      [range.from, range.to, branchId]
    );
    const versionCache = new Map(); // مشترك بين كل الفروع في نفس التقرير - وصفة واحدة بتتفكّ مرة واحدة بس
    const rows = [];
    for (const branchRow of branchesRes.rows) {
      const revenueRes = await pool.query(
        `SELECT COALESCE(SUM(total), 0) AS revenue FROM orders
         WHERE status <> 'cancelled' AND created_at::date BETWEEN $1 AND $2 AND branch_id = $3`,
        [range.from, range.to, branchRow.branch_id]
      );
      const byItem = await computeConsumptionBreakdown(pool, { branchId: branchRow.branch_id, from: range.from, to: range.to }, versionCache);
      const totals = aggregateBreakdown(byItem);
      const revenue = Number(revenueRes.rows[0].revenue);
      rows.push({
        branchId: branchRow.branch_id, branchName: branchRow.branch_name, revenue,
        theoreticalFoodCost: totals.theoretical.cost, theoreticalIncomplete: totals.theoretical.incomplete,
        salesFoodCost: totals.sales.cost, productionCost: totals.production.cost,
        wasteCost: totals.waste.cost, adjustmentCost: totals.adjustment.cost,
        totalInventoryUsageCost: totals.totalUsage.cost,
        foodCostVariance: totals.foodCostVariance, foodCostVariancePercent: totals.foodCostVariancePercent,
        foodCostPercent: revenue > 0 ? (totals.totalUsage.cost / revenue) * 100 : null,
        theoreticalFoodCostPercent: revenue > 0 ? (totals.theoretical.cost / revenue) * 100 : null,
      });
    }
    rows.sort((a, b) => b.revenue - a.revenue);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/reports/cost-traceability/:orderId - سلسلة التتبّع الكاملة: الطلب → سطر الطلب → نسخة الوصفة
// اللي كانت نشطة وقت البيع بالظبط → مكوناتها → حركة المخزون الفعلية اللي خصمت (بتكلفتها ودفعتها الحقيقية)
router.get("/cost-traceability/:orderId", requireAuth, canSeeReports, requirePermission("food_cost.view"), async (req, res) => {
  try {
    const orderRes = await pool.query(
      `SELECT o.*, b.name AS branch_name FROM orders o JOIN branches b ON b.id = o.branch_id WHERE o.id = $1`,
      [req.params.orderId]
    );
    if (orderRes.rows.length === 0) return res.status(404).json({ error: "الطلب مش موجود" });
    if (req.user.role === "branch_manager" && orderRes.rows[0].branch_id !== req.user.branchId) {
      return res.status(403).json({ error: "معندكش صلاحية تشوف طلب فرع تاني" });
    }

    const itemsRes = await pool.query(
      `SELECT oi.*, mi.name AS item_name, v.label AS variant_label, rv.version_number
       FROM order_items oi
       LEFT JOIN menu_items mi ON mi.id = oi.item_id
       LEFT JOIN menu_item_variants v ON v.id = oi.variant_id
       LEFT JOIN recipe_versions rv ON rv.id = oi.recipe_version_id
       WHERE oi.order_id = $1`,
      [req.params.orderId]
    );

    const movementsRes = await pool.query(
      `SELECT im.*, ii.name AS item_name, ib.batch_number, ib.expiry_date
       FROM inventory_movements im
       JOIN inventory_items ii ON ii.id = im.inventory_item_id
       LEFT JOIN inventory_batches ib ON ib.id = im.batch_id
       WHERE im.reference_type = 'order' AND im.reference_id = $1 AND im.movement_type IN ('SALE', 'SALE_REVERSAL')
       ORDER BY im.id`,
      [req.params.orderId]
    );

    const items = [];
    for (const item of itemsRes.rows) {
      let ingredients = [];
      if (item.recipe_version_id) {
        const ingRes = await pool.query(
          `SELECT ri.*, ii.name AS ingredient_name, ii.unit AS ingredient_unit
           FROM recipe_ingredients ri JOIN inventory_items ii ON ii.id = ri.ingredient_item_id
           WHERE ri.recipe_version_id = $1`,
          [item.recipe_version_id]
        );
        ingredients = ingRes.rows;
      }
      items.push({ ...item, ingredients });
    }

    res.json({ order: orderRes.rows[0], items, inventoryMovements: movementsRes.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== المرحلة 4A: تقارير المشتريات (Procurement) ====================
const canSeePurchasing = requirePermission("purchasing.view");

// GET /api/reports/purchase-orders?branchId=&from=&to=&status=&supplierId= - كل أوامر الشراء في المدى
router.get("/purchase-orders", requireAuth, canSeePurchasing, async (req, res) => {
  const range = resolveDateRange(req.query);
  if (!range) return res.status(400).json({ error: "لازم تحدد from/to أو year/month" });
  let branchId = req.query.branchId ? Number(req.query.branchId) : null;
  if (req.user.role === "branch_manager") branchId = req.user.branchId;
  const { status, supplierId } = req.query;
  try {
    const result = await pool.query(
      `SELECT po.*, s.name AS supplier_name, b.name AS branch_name,
              COALESCE(SUM(poi.ordered_quantity), 0) AS total_ordered_quantity,
              COALESCE(SUM(poi.received_quantity), 0) AS total_received_quantity
       FROM purchase_orders po
       JOIN suppliers s ON s.id = po.supplier_id
       JOIN branches b ON b.id = po.branch_id
       LEFT JOIN purchase_order_items poi ON poi.purchase_order_id = po.id
       WHERE po.order_date BETWEEN $1 AND $2
         AND ($3::int IS NULL OR po.branch_id = $3)
         AND ($4::text IS NULL OR po.status = $4)
         AND ($5::int IS NULL OR po.supplier_id = $5)
       GROUP BY po.id, s.name, b.name
       ORDER BY po.order_date DESC, po.id DESC`,
      [range.from, range.to, branchId, status || null, supplierId || null]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/reports/purchase-receipts?branchId=&from=&to=&supplierId= - سندات الاستلام المرحّلة (POSTED)
router.get("/purchase-receipts", requireAuth, canSeePurchasing, async (req, res) => {
  const range = resolveDateRange(req.query);
  if (!range) return res.status(400).json({ error: "لازم تحدد from/to أو year/month" });
  let branchId = req.query.branchId ? Number(req.query.branchId) : null;
  if (req.user.role === "branch_manager") branchId = req.user.branchId;
  const { supplierId } = req.query;
  try {
    const result = await pool.query(
      `SELECT gr.id, gr.received_at, gr.supplier_document_number, gr.status,
              s.name AS supplier_name, b.name AS branch_name, po.id AS purchase_order_id,
              COALESCE(SUM(gri.accepted_quantity), 0) AS total_accepted_quantity,
              COALESCE(SUM(gri.rejected_quantity), 0) AS total_rejected_quantity,
              COALESCE(SUM(gri.accepted_quantity * gri.unit_price), 0) AS total_value
       FROM goods_receipts gr
       JOIN suppliers s ON s.id = gr.supplier_id
       JOIN branches b ON b.id = gr.branch_id
       JOIN purchase_orders po ON po.id = gr.purchase_order_id
       LEFT JOIN goods_receipt_items gri ON gri.goods_receipt_id = gr.id
       WHERE gr.status = 'POSTED' AND gr.received_at::date BETWEEN $1 AND $2
         AND ($3::int IS NULL OR gr.branch_id = $3)
         AND ($4::int IS NULL OR gr.supplier_id = $4)
       GROUP BY gr.id, s.name, b.name, po.id
       ORDER BY gr.received_at DESC`,
      [range.from, range.to, branchId, supplierId || null]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/reports/supplier-purchase-history?supplierId=&from=&to= - كل أوامر الشراء والاستلامات لمورد معيّن
router.get("/supplier-purchase-history", requireAuth, canSeePurchasing, async (req, res) => {
  const { supplierId } = req.query;
  if (!supplierId) return res.status(400).json({ error: "لازم تحدد المورد" });
  const range = resolveDateRange(req.query);
  if (!range) return res.status(400).json({ error: "لازم تحدد from/to أو year/month" });
  try {
    const orders = await pool.query(
      `SELECT po.id, po.order_date, po.status, po.total, b.name AS branch_name
       FROM purchase_orders po JOIN branches b ON b.id = po.branch_id
       WHERE po.supplier_id = $1 AND po.order_date BETWEEN $2 AND $3
       ORDER BY po.order_date DESC`,
      [supplierId, range.from, range.to]
    );
    const receipts = await pool.query(
      `SELECT gr.id, gr.received_at, gr.status,
              COALESCE(SUM(gri.accepted_quantity * gri.unit_price), 0) AS total_value
       FROM goods_receipts gr LEFT JOIN goods_receipt_items gri ON gri.goods_receipt_id = gr.id
       WHERE gr.supplier_id = $1 AND gr.status = 'POSTED' AND gr.received_at::date BETWEEN $2 AND $3
       GROUP BY gr.id ORDER BY gr.received_at DESC`,
      [supplierId, range.from, range.to]
    );
    const totals = await pool.query(
      `SELECT COALESCE(SUM(total), 0) AS total_ordered_value, COUNT(*) AS orders_count
       FROM purchase_orders WHERE supplier_id = $1 AND order_date BETWEEN $2 AND $3 AND status <> 'CANCELLED'`,
      [supplierId, range.from, range.to]
    );
    res.json({
      supplierId: Number(supplierId), from: range.from, to: range.to,
      totals: { totalOrderedValue: Number(totals.rows[0].total_ordered_value), ordersCount: Number(totals.rows[0].orders_count) },
      purchaseOrders: orders.rows, goodsReceipts: receipts.rows,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/reports/purchase-price-history?itemId=&supplierId= - تاريخ سعر صنف (عند مورد معيّن أو كل الموردين)
router.get("/purchase-price-history", requireAuth, canSeePurchasing, async (req, res) => {
  const { itemId, supplierId } = req.query;
  if (!itemId) return res.status(400).json({ error: "لازم تحدد الصنف" });
  try {
    const result = await pool.query(
      `SELECT si.*, s.name AS supplier_name, ii.name AS item_name
       FROM supplier_items si
       JOIN suppliers s ON s.id = si.supplier_id
       JOIN inventory_items ii ON ii.id = si.inventory_item_id
       WHERE si.inventory_item_id = $1 AND ($2::int IS NULL OR si.supplier_id = $2)
       ORDER BY si.effective_from DESC`,
      [itemId, supplierId || null]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/reports/purchase-price-variance?from=&to=&branchId= - كل سطور الـPO في المدى مع انحراف سعرها
// عن آخر سعر مسجّل للمورد وقت الطلب (نفس منطق GET /api/purchase-orders/:id/price-variance، بس مجمّع
// على كل الأوامر في المدى - تقرير إداري بند 11)
router.get("/purchase-price-variance", requireAuth, canSeePurchasing, async (req, res) => {
  const range = resolveDateRange(req.query);
  if (!range) return res.status(400).json({ error: "لازم تحدد from/to أو year/month" });
  let branchId = req.query.branchId ? Number(req.query.branchId) : null;
  if (req.user.role === "branch_manager") branchId = req.user.branchId;
  try {
    // آخر سعر "سابق" لكل (مورد، صنف) قبل تاريخ كل PO - بنستخدم أقرب صف supplier_items بدأ سريانه قبل
    // order_date (مش effective_to IS NULL الحالي، عشان الانحراف يتقارن بالسعر اللي كان معروف وقتها فعليًا)
    const result = await pool.query(
      `SELECT po.id AS purchase_order_id, po.order_date, po.supplier_id, s.name AS supplier_name,
              poi.inventory_item_id, ii.name AS item_name, poi.unit_price AS new_price,
              prev.unit_price AS previous_price
       FROM purchase_order_items poi
       JOIN purchase_orders po ON po.id = poi.purchase_order_id
       JOIN suppliers s ON s.id = po.supplier_id
       JOIN inventory_items ii ON ii.id = poi.inventory_item_id
       LEFT JOIN LATERAL (
         SELECT unit_price FROM supplier_items si
         WHERE si.supplier_id = po.supplier_id AND si.inventory_item_id = poi.inventory_item_id
           AND si.effective_from < po.created_at
         ORDER BY si.effective_from DESC LIMIT 1
       ) prev ON TRUE
       WHERE po.status <> 'CANCELLED' AND po.order_date BETWEEN $1 AND $2
         AND ($3::int IS NULL OR po.branch_id = $3)
       ORDER BY po.order_date DESC`,
      [range.from, range.to, branchId]
    );
    res.json(result.rows.map((r) => {
      const newPrice = Number(r.new_price);
      const previousPrice = r.previous_price != null ? Number(r.previous_price) : null;
      const difference = previousPrice != null ? newPrice - previousPrice : null;
      return {
        purchaseOrderId: r.purchase_order_id, orderDate: r.order_date, supplierId: r.supplier_id, supplierName: r.supplier_name,
        inventoryItemId: r.inventory_item_id, itemName: r.item_name, previousPrice, newPrice, difference,
        differencePercent: previousPrice ? (difference / previousPrice) * 100 : null,
      };
    }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/reports/supplier-performance?supplierId=&from=&to= - أسس تقرير أداء المورد (بند 12 - Backend بس، مفيش dashboard)
router.get("/supplier-performance", requireAuth, canSeePurchasing, async (req, res) => {
  const { supplierId } = req.query;
  if (!supplierId) return res.status(400).json({ error: "لازم تحدد المورد" });
  const range = resolveDateRange(req.query);
  if (!range) return res.status(400).json({ error: "لازم تحدد from/to أو year/month" });
  try {
    const quantities = await pool.query(
      `SELECT COALESCE(SUM(poi.ordered_quantity), 0) AS ordered_quantity,
              COALESCE(SUM(poi.received_quantity), 0) AS received_quantity
       FROM purchase_order_items poi JOIN purchase_orders po ON po.id = poi.purchase_order_id
       WHERE po.supplier_id = $1 AND po.order_date BETWEEN $2 AND $3 AND po.status <> 'CANCELLED'`,
      [supplierId, range.from, range.to]
    );
    const rejected = await pool.query(
      `SELECT COALESCE(SUM(gri.rejected_quantity), 0) AS rejected_quantity, COALESCE(SUM(gri.received_quantity), 0) AS received_quantity
       FROM goods_receipt_items gri JOIN goods_receipts gr ON gr.id = gri.goods_receipt_id
       WHERE gr.supplier_id = $1 AND gr.status = 'POSTED' AND gr.received_at::date BETWEEN $2 AND $3`,
      [supplierId, range.from, range.to]
    );
    // في الوقت (on-time) = أول استلام POSTED لكل PO حصل في/قبل expected_delivery_date بتاعه
    const delivery = await pool.query(
      `SELECT po.id, po.expected_delivery_date, MIN(gr.received_at)::date AS first_received_date
       FROM purchase_orders po
       JOIN goods_receipts gr ON gr.purchase_order_id = po.id AND gr.status = 'POSTED'
       WHERE po.supplier_id = $1 AND po.order_date BETWEEN $2 AND $3
       GROUP BY po.id, po.expected_delivery_date`,
      [supplierId, range.from, range.to]
    );
    const priceChanges = await pool.query(
      `SELECT COUNT(*) AS count FROM supplier_items WHERE supplier_id = $1 AND effective_from BETWEEN $2 AND $3`,
      [supplierId, range.from, range.to]
    );

    const withExpectedDate = delivery.rows.filter((r) => r.expected_delivery_date);
    const onTime = withExpectedDate.filter((r) => new Date(r.first_received_date) <= new Date(r.expected_delivery_date)).length;
    const orderedQty = Number(quantities.rows[0].ordered_quantity);
    const receivedQty = Number(quantities.rows[0].received_quantity);

    res.json({
      supplierId: Number(supplierId), from: range.from, to: range.to,
      orderedQuantity: orderedQty, receivedQuantity: receivedQty,
      fulfillmentRate: orderedQty > 0 ? (receivedQty / orderedQty) * 100 : null,
      rejectedQuantity: Number(rejected.rows[0].rejected_quantity),
      rejectionRate: Number(rejected.rows[0].received_quantity) > 0
        ? (Number(rejected.rows[0].rejected_quantity) / Number(rejected.rows[0].received_quantity)) * 100 : null,
      deliveries: { total: withExpectedDate.length, onTime, late: withExpectedDate.length - onTime },
      priceChangesCount: Number(priceChanges.rows[0].count),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/reports/outstanding-purchase-orders?branchId= - أوامر شراء لسه مستنية استلام (كامل أو جزء)
router.get("/outstanding-purchase-orders", requireAuth, canSeePurchasing, async (req, res) => {
  let branchId = req.query.branchId ? Number(req.query.branchId) : null;
  if (req.user.role === "branch_manager") branchId = req.user.branchId;
  try {
    const result = await pool.query(
      `SELECT po.id, po.order_date, po.expected_delivery_date, po.status, s.name AS supplier_name, b.name AS branch_name,
              COALESCE(SUM(poi.ordered_quantity - poi.received_quantity), 0) AS remaining_quantity,
              COALESCE(SUM((poi.ordered_quantity - poi.received_quantity) * poi.unit_price), 0) AS remaining_value
       FROM purchase_orders po
       JOIN suppliers s ON s.id = po.supplier_id
       JOIN branches b ON b.id = po.branch_id
       JOIN purchase_order_items poi ON poi.purchase_order_id = po.id
       WHERE po.status IN ('APPROVED', 'PARTIALLY_RECEIVED') AND ($1::int IS NULL OR po.branch_id = $1)
       GROUP BY po.id, s.name, b.name
       HAVING COALESCE(SUM(poi.ordered_quantity - poi.received_quantity), 0) > 0
       ORDER BY po.expected_delivery_date NULLS LAST, po.id`,
      [branchId]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/reports/rejected-goods?branchId=&from=&to= - كل الكميات المرفوضة وأسبابها
router.get("/rejected-goods", requireAuth, canSeePurchasing, async (req, res) => {
  const range = resolveDateRange(req.query);
  if (!range) return res.status(400).json({ error: "لازم تحدد from/to أو year/month" });
  let branchId = req.query.branchId ? Number(req.query.branchId) : null;
  if (req.user.role === "branch_manager") branchId = req.user.branchId;
  try {
    const result = await pool.query(
      `SELECT gr.id AS goods_receipt_id, gr.received_at, s.name AS supplier_name, b.name AS branch_name,
              ii.name AS item_name, gri.rejected_quantity, gri.unit, gri.unit_price,
              gri.rejected_quantity * gri.unit_price AS rejected_value, gri.rejection_reason
       FROM goods_receipt_items gri
       JOIN goods_receipts gr ON gr.id = gri.goods_receipt_id
       JOIN suppliers s ON s.id = gr.supplier_id
       JOIN branches b ON b.id = gr.branch_id
       JOIN inventory_items ii ON ii.id = gri.inventory_item_id
       WHERE gr.status = 'POSTED' AND gri.rejected_quantity > 0 AND gr.received_at::date BETWEEN $1 AND $2
         AND ($3::int IS NULL OR gr.branch_id = $3)
       ORDER BY gr.received_at DESC`,
      [range.from, range.to, branchId]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/reports/purchases-by-branch?from=&to= - إجمالي قيمة المشتريات (المستلمة فعليًا) لكل فرع
router.get("/purchases-by-branch", requireAuth, canSeePurchasing, async (req, res) => {
  const range = resolveDateRange(req.query);
  if (!range) return res.status(400).json({ error: "لازم تحدد from/to أو year/month" });
  try {
    const result = await pool.query(
      `SELECT gr.branch_id, b.name AS branch_name,
              COALESCE(SUM(gri.accepted_quantity * gri.unit_price), 0) AS total_value,
              COUNT(DISTINCT gr.id) AS receipts_count
       FROM goods_receipts gr
       JOIN branches b ON b.id = gr.branch_id
       LEFT JOIN goods_receipt_items gri ON gri.goods_receipt_id = gr.id
       WHERE gr.status = 'POSTED' AND gr.received_at::date BETWEEN $1 AND $2
       GROUP BY gr.branch_id, b.name ORDER BY total_value DESC`,
      [range.from, range.to]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/reports/purchases-by-item?from=&to=&branchId= - إجمالي كمية/قيمة المشتريات لكل صنف
router.get("/purchases-by-item", requireAuth, canSeePurchasing, async (req, res) => {
  const range = resolveDateRange(req.query);
  if (!range) return res.status(400).json({ error: "لازم تحدد from/to أو year/month" });
  let branchId = req.query.branchId ? Number(req.query.branchId) : null;
  if (req.user.role === "branch_manager") branchId = req.user.branchId;
  try {
    const result = await pool.query(
      `SELECT gri.inventory_item_id, ii.name AS item_name, ii.unit,
              COALESCE(SUM(gri.accepted_quantity), 0) AS total_quantity,
              COALESCE(SUM(gri.accepted_quantity * gri.unit_price), 0) AS total_value
       FROM goods_receipt_items gri
       JOIN goods_receipts gr ON gr.id = gri.goods_receipt_id
       JOIN inventory_items ii ON ii.id = gri.inventory_item_id
       WHERE gr.status = 'POSTED' AND gr.received_at::date BETWEEN $1 AND $2
         AND ($3::int IS NULL OR gr.branch_id = $3)
       GROUP BY gri.inventory_item_id, ii.name, ii.unit
       ORDER BY total_value DESC`,
      [range.from, range.to, branchId]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
