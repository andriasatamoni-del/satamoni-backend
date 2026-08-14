const express = require("express");
const router = express.Router();
const pool = require("../db/pool");
const { requireAuth, requireRole } = require("../middleware/auth");
const {
  computeFingerprintPayroll,
  computeManualPayroll,
  computeNoTrackingPayroll,
} = require("../services/payroll-engine");

const canSeeReports = requireRole("admin", "accountant", "branch_manager");

function toCents(n) {
  return Math.round(n * 100);
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

module.exports = router;
