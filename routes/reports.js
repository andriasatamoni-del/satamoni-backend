const express = require("express");
const router = express.Router();
const pool = require("../db/pool");
const { requireAuth, requireRole } = require("../middleware/auth");
const { requirePermission } = require("../middleware/permissions");
const { computeConsumptionBreakdown, aggregateBreakdown } = require("../db/food-cost-engine");
const { convertQuantity } = require("../db/unit-conversion");
const { computeProductionPlan, computeRawMaterialRequirement } = require("../db/production-planning");
const {
  computeFingerprintPayroll,
  computeManualPayroll,
  computeNoTrackingPayroll,
  computePayrollCostByBranch: computePayrollCostByBranchRaw,
} = require("../services/payroll-engine");

const canSeeReports = requireRole("admin", "accountant", "branch_manager");

// نسخة مربوطة بـpool مباشرة - نفس منطق تقسيم تكلفة الرواتب على الفروع مستخدم هنا وفي routes/payroll.js
// (المرحلة 4C) من مصدر واحد بس (services/payroll-engine.js) عشان الاتنين ميختلفوش عن بعض
function computePayrollCostByBranch(year, month) {
  return computePayrollCostByBranchRaw(pool, year, month);
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

// تكلفة الرواتب (services/payroll-engine.js) بطبيعتها شهرية بالكامل - الموظف اللي مالوش نظام حضور
// بيتحسب له مرتب الشهر كامل بدون تناسب على الأيام، فمفيش معنى "تكلفة رواتب" صحيحة لمدى تاريخ جزئي أو
// عابر لأكتر من شهر. بنستخدم الدالة دي عشان نعرف هل المدى المختار شهر كامل بالظبط (فنقدر نجيب تكلفة
// الرواتب بأمان) - لو لأ، بنرجّع null ونوضح للمستخدم إن الرقم مش متاح للمدى الجزئي ده بدل ما نعرض رقم غلط
function monthIfFullMonthRange(from, to) {
  const f = new Date(`${from}T00:00:00`);
  const t = new Date(`${to}T00:00:00`);
  const year = f.getFullYear();
  const month = f.getMonth() + 1;
  const lastDay = new Date(year, month, 0).getDate();
  const isFullMonth =
    f.getDate() === 1 && t.getFullYear() === year && t.getMonth() + 1 === month && t.getDate() === lastDay;
  return isFullMonth ? { year, month } : null;
}

// GET /api/reports/daily?from=2026-07-01&to=2026-07-31 (أو year=2026&month=7 كاختصار) - بديل شيت "لوحة التحكم"
router.get("/daily", requireAuth, canSeeReports, async (req, res) => {
  const range = resolveDateRange(req.query);
  if (!range) return res.status(400).json({ error: "from/to أو year/month مطلوبين" });
  try {
    const result = await pool.query(
      `SELECT * FROM v_daily_branch_summary
       WHERE business_date BETWEEN $1 AND $2
         AND ($3::int IS NULL OR branch_id = $3)
       ORDER BY business_date, branch_id`,
      [range.from, range.to, req.user.role === "branch_manager" ? req.user.branchId : null]
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

// حساب الإيرادات وتكلفة البضاعة المباعة لكل فرع في مدى تاريخ معين (from/to)، من بيانات الطلبات الفعلية
// (مش من قيود يدوية) - العروض/الكومبو بتتفكّ لأصنافها الأصلية لحساب تكلفتها الحقيقية
async function computeRevenueAndCogsByBranch(from, to) {
  // تكلفة البضاعة المباعة بتتاخد من cost_at_sale المسجّلة على كل سطر طلب وقت البيع نفسه (مش لحظيًا وقت التقرير)
  // عشان لو الريسبي أو تركيبة عرض اتغيرت بعد كدة، الطلبات القديمة تفضل بتكلفتها الحقيقية وقتها
  // المرحلة 7H: الإيراد هنا صافي من ضريبة القيمة المضافة (total - vat_amount) - الضريبة تحصيل بالنيابة
  // عن مصلحة الضرائب مش إيراد حقيقي للمنشأة، ونفس المنطق مطبّق في دفتر الأستاذ (routes/orders.js بيقيّد
  // الضريبة على حساب 2300 المستحق مش على حسابات الإيراد 4100/4200). لازم الاتنين يفضلوا متطابقين عشان
  // تقرير accounting-reconciliation (اللي بيقارن الإيراد التشغيلي هنا بصافي المبيعات في دفتر الأستاذ)
  // يفضل صحيح - قبل الضريبة كان الرقمين متطابقين تلقائيًا لأن total نفسه كان هو الإيراد الكامل
  const result = await pool.query(
    `WITH qualifying_orders AS (
       SELECT o.id, o.branch_id, (o.total - COALESCE(o.vat_amount, 0)) AS net_total
       FROM orders o
       WHERE o.status <> 'cancelled'
         AND o.created_at::date BETWEEN $1 AND $2
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
            SUM(qo.net_total) AS revenue,
            COALESCE(SUM(oct.cost), 0) AS cogs,
            COUNT(*) FILTER (WHERE oct.missing_cost) AS orders_missing_cost_data
     FROM qualifying_orders qo
     LEFT JOIN branches b ON b.id = qo.branch_id
     LEFT JOIN order_cost_totals oct ON oct.order_id = qo.id
     GROUP BY qo.branch_id, b.name
     ORDER BY b.name`,
    [from, to]
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

// GET /api/reports/income-statement?from=&to=&branchId= (أو year=&month= كاختصار) - قائمة الدخل
// (إيرادات - تكلفة البضاعة - مصروفات) لفرع واحد لو اتحدد branchId، أو مجمّع لكل الفروع لو مفيش
router.get("/income-statement", requireAuth, canSeeReports, async (req, res) => {
  const range = resolveDateRange(req.query);
  let branchId = req.query.branchId ? Number(req.query.branchId) : null;
  if (req.user.role === "branch_manager") branchId = req.user.branchId;
  if (!range) return res.status(400).json({ error: "لازم تحدد الفترة (from/to أو year/month)" });
  const { from, to } = range;

  try {
    const byBranch = await computeRevenueAndCogsByBranch(from, to);
    const scoped = branchId ? byBranch.filter((r) => r.branchId === branchId) : byBranch;

    const revenue = scoped.reduce((s, r) => s + r.revenue, 0);
    const cogs = scoped.reduce((s, r) => s + r.cogs, 0);
    const ordersMissingCostData = scoped.reduce((s, r) => s + r.ordersMissingCostData, 0);
    const grossProfit = revenue - cogs;

    const expensesResult = await pool.query(
      `SELECT ec.name AS category, SUM(e.amount) AS total
       FROM expenses e
       JOIN expense_categories ec ON ec.id = e.category_id
       WHERE e.business_date BETWEEN $1 AND $2
         AND ($3::int IS NULL OR e.branch_id = $3)
       GROUP BY ec.name
       ORDER BY total DESC`,
      [from, to, branchId]
    );
    const expenseLines = expensesResult.rows.map((r) => ({
      category: r.category,
      amount: Number(r.total),
    }));
    const totalOpex = expenseLines.reduce((s, r) => s + r.amount, 0);
    const netProfitBeforePayroll = grossProfit - totalOpex;

    // تكلفة الرواتب شهرية بطبيعتها (راجع تعليق monthIfFullMonthRange فوق) - متاحة بس لما الفترة
    // المختارة شهر كامل بالظبط، وإلا بترجع null بدل رقم مضلّل
    const fullMonth = monthIfFullMonthRange(from, to);
    let payrollCost = null;
    if (fullMonth) {
      // تكلفة الرواتب هنا إجمالي بس (صافي مستحق الصرف) - مش تفصيل رواتب الموظفين، فمأمون إن مدير الفرع يشوفه لفرعه
      const payroll = await computePayrollCostByBranch(fullMonth.year, fullMonth.month);
      payrollCost = branchId ? (payroll.byBranch[branchId] || 0) : payroll.total;
    }
    const netProfitAfterPayroll = payrollCost != null ? netProfitBeforePayroll - payrollCost : null;

    res.json({
      from,
      to,
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
      note:
        (payrollCost == null
          ? "تكلفة الرواتب مش متاحة لمدى تاريخ جزئي أو عابر لأكتر من شهر - الرواتب شهرية بطبيعتها. اختر شهر كامل عشان تظهر. "
          : "") +
        (branchId
          ? "تكلفة الرواتب هنا لفريق الفرع ده بس (موظفي البصمة اللي فرعهم الأساسي ده) - تكاليف الإدارة والمطبخ المركزي مش متحمّلة على فرع بعينه"
          : "تكلفة الرواتب هنا شاملة كل الموظفين (فروع + مطبخ مركزي + إدارة)"),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/reports/income-statement/by-branch?from=&to= (أو year=&month= كاختصار) - مقارنة أداء
// الفروع (أدمن/محاسب بس)
router.get(
  "/income-statement/by-branch",
  requireAuth,
  requireRole("admin", "accountant"),
  async (req, res) => {
    const range = resolveDateRange(req.query);
    if (!range) return res.status(400).json({ error: "لازم تحدد الفترة (from/to أو year/month)" });
    const { from, to } = range;

    try {
      const byBranch = await computeRevenueAndCogsByBranch(from, to);
      const expensesResult = await pool.query(
        `SELECT branch_id, SUM(amount) AS total
         FROM expenses
         WHERE business_date BETWEEN $1 AND $2
         GROUP BY branch_id`,
        [from, to]
      );
      const opexByBranch = {};
      expensesResult.rows.forEach((r) => { opexByBranch[r.branch_id] = Number(r.total); });

      // تكلفة الرواتب شهرية بطبيعتها (راجع تعليق monthIfFullMonthRange فوق) - متاحة بس لما الفترة شهر كامل
      const fullMonth = monthIfFullMonthRange(from, to);
      const payroll = fullMonth
        ? await computePayrollCostByBranch(fullMonth.year, fullMonth.month)
        : { byBranch: {}, overhead: null, total: null };

      const rows = byBranch.map((r) => {
        const opex = opexByBranch[r.branchId] || 0;
        const grossProfit = r.revenue - r.cogs;
        const payrollCost = fullMonth ? (r.branchId ? (payroll.byBranch[r.branchId] || 0) : 0) : null;
        const netProfitBeforePayroll = grossProfit - opex;
        return {
          ...r,
          grossProfit,
          grossMarginPercent: r.revenue > 0 ? grossProfit / r.revenue : null,
          opex,
          netProfitBeforePayroll,
          payrollCost,
          netProfitAfterPayroll: payrollCost != null ? netProfitBeforePayroll - payrollCost : null,
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
        from,
        to,
        branches: rows,
        payrollOverhead: payroll.overhead, // تكلفة رواتب الإدارة والمطبخ المركزي - مش متحمّلة على فرع بعينه
        note: fullMonth
          ? null
          : "تكلفة الرواتب مش متاحة لمدى تاريخ جزئي أو عابر لأكتر من شهر - الرواتب شهرية بطبيعتها. اختر شهر كامل عشان تظهر.",
        consolidated: {
          ...consolidated,
          grossProfit: consolidatedGrossProfit,
          grossMarginPercent: consolidated.revenue > 0 ? consolidatedGrossProfit / consolidated.revenue : null,
          netProfitBeforePayroll: consolidatedNetBeforePayroll,
          payrollCost: payroll.total,
          netProfitAfterPayroll: payroll.total != null ? consolidatedNetBeforePayroll - payroll.total : null,
        },
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

// GET /api/reports/dashboard?from=&to=&branchId= (أو year=&month= كاختصار) - داش بورد المالك: كل
// تفاصيل الشغل في نداء واحد (المبيعات اليومية، الأصناف/الفروع/المناطق الأكثر مبيعًا، التكلفة
// والمصروفات، حالة التحصيل، حالة الطلبات)
router.get("/dashboard", requireAuth, canSeeReports, async (req, res) => {
  const range = resolveDateRange(req.query);
  if (!range) return res.status(400).json({ error: "لازم تحدد الفترة (from/to أو year/month)" });
  const { from, to } = range;
  let branchId = req.query.branchId ? Number(req.query.branchId) : null;
  if (req.user.role === "branch_manager") branchId = req.user.branchId;

  try {
    const fullMonth = monthIfFullMonthRange(from, to);
    const [
      byBranch, dailySales, topItems, topAreas,
      paymentStatusBreakdown, orderStatusBreakdown, expensesResult, payroll,
    ] = await Promise.all([
      computeRevenueAndCogsByBranch(from, to),
      pool.query(
        `SELECT o.created_at::date AS date, COUNT(*) AS orders_count, SUM(o.total) AS revenue
         FROM orders o
         WHERE o.status <> 'cancelled' AND o.created_at::date BETWEEN $1 AND $2
           AND ($3::int IS NULL OR o.branch_id = $3)
         GROUP BY o.created_at::date ORDER BY date`,
        [from, to, branchId]
      ),
      pool.query(
        `SELECT COALESCE(mi.name || ' - ' || mv.label, c.name) AS name,
                SUM(oi.quantity) AS quantity, SUM(oi.line_total) AS revenue
         FROM order_items oi
         JOIN orders o ON o.id = oi.order_id
         LEFT JOIN menu_item_variants mv ON mv.id = oi.variant_id
         LEFT JOIN menu_items mi ON mi.id = mv.item_id
         LEFT JOIN combos c ON c.id = oi.combo_id
         WHERE o.status <> 'cancelled' AND o.created_at::date BETWEEN $1 AND $2
           AND ($3::int IS NULL OR o.branch_id = $3)
         GROUP BY COALESCE(mi.name || ' - ' || mv.label, c.name)
         ORDER BY revenue DESC LIMIT 10`,
        [from, to, branchId]
      ),
      pool.query(
        `SELECT da.id AS area_id, da.name AS area_name, COUNT(*) AS orders_count, SUM(o.total) AS revenue
         FROM orders o
         JOIN delivery_areas da ON da.id = o.delivery_area_id
         WHERE o.status <> 'cancelled' AND o.order_type = 'delivery' AND o.created_at::date BETWEEN $1 AND $2
           AND ($3::int IS NULL OR o.branch_id = $3)
         GROUP BY da.id, da.name ORDER BY revenue DESC LIMIT 10`,
        [from, to, branchId]
      ),
      pool.query(
        `SELECT payment_status, COUNT(*) AS count, SUM(total) AS amount
         FROM orders o
         WHERE o.status <> 'cancelled' AND o.created_at::date BETWEEN $1 AND $2
           AND ($3::int IS NULL OR o.branch_id = $3)
         GROUP BY payment_status`,
        [from, to, branchId]
      ),
      pool.query(
        `SELECT status, COUNT(*) AS count
         FROM orders o
         WHERE o.created_at::date BETWEEN $1 AND $2
           AND ($3::int IS NULL OR o.branch_id = $3)
         GROUP BY status`,
        [from, to, branchId]
      ),
      pool.query(
        `SELECT ec.name AS category, SUM(e.amount) AS total
         FROM expenses e
         JOIN expense_categories ec ON ec.id = e.category_id
         WHERE e.business_date BETWEEN $1 AND $2
           AND ($3::int IS NULL OR e.branch_id = $3)
         GROUP BY ec.name ORDER BY total DESC`,
        [from, to, branchId]
      ),
      fullMonth ? computePayrollCostByBranch(fullMonth.year, fullMonth.month) : Promise.resolve({ byBranch: {}, overhead: null, total: null }),
    ]);

    const scopedBranches = branchId ? byBranch.filter((r) => r.branchId === branchId) : byBranch;
    const revenue = scopedBranches.reduce((s, r) => s + r.revenue, 0);
    const cogs = scopedBranches.reduce((s, r) => s + r.cogs, 0);
    const ordersCount = scopedBranches.reduce((s, r) => s + r.ordersCount, 0);
    const grossProfit = revenue - cogs;
    const totalOpex = expensesResult.rows.reduce((s, r) => s + Number(r.total), 0);
    const payrollCost = fullMonth ? (branchId ? (payroll.byBranch[branchId] || 0) : payroll.total) : null;
    const netProfitBeforePayroll = grossProfit - totalOpex;
    const netProfitAfterPayroll = payrollCost != null ? netProfitBeforePayroll - payrollCost : null;

    res.json({
      from, to, branchId,
      note: fullMonth
        ? null
        : "تكلفة الرواتب مش متاحة لمدى تاريخ جزئي أو عابر لأكتر من شهر - الرواتب شهرية بطبيعتها. اختر شهر كامل عشان تظهر.",
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
// المرحلة 6 (6G): من غير from/to كان بيدّي مدى "من أول الزمن" (1900-2999) كـdefault - يعني استعلام
// المبيعات الفرعي (subquery) بيمسح كل أوردر اتعمل في تاريخ المطعم كله في كل مرة، حتى لو الرد النهائي
// (عدد أصناف المنيو) صغير وثابت. تكلفة المسح بتكبر مع الوقت من غير أي فايدة - القائمة نفسها (كل
// الأصناف) لسه بترجع حتى من غير تحديد مدى، بس المبيعات المجمّعة بقت افتراضيًا آخر 90 يوم (قابلة
// للتغيير صراحة بـfrom/to لمراجعة أوسع)
router.get("/catalog", requireAuth, canSeeReports, async (req, res) => {
  const range = resolveDateRange(req.query) || {
    from: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
    to: new Date().toISOString().slice(0, 10),
  };
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

// ==================== المرحلة 4.1: مقارنة موردين + توصيات شراء ====================
// وحدة الشراء (purchase_unit) بتختلف عن وحدة تخزين الصنف أحيانًا بس - أغلب أصناف ستاموني وحدة الشراء
// عندهم = وحدة التخزين بالظبط (زي ما اتأكدنا من البيانات الفعلية)، فمفيش أي تحويل مطلوب في الحالة دي.
// بيستخدم نفس محرك التحويل الموجود (db/unit-conversion.js) - مفيش منطق تحويل جديد أو Unit Master جديد.
async function normalizedSupplierCost(client, supplierItem, stockUnit) {
  const purchaseUnit = supplierItem.purchase_unit || stockUnit;
  if (purchaseUnit === stockUnit) {
    return { normalizedCost: Number(supplierItem.unit_price), incomplete: false };
  }
  if (supplierItem.conversion_factor != null && Number(supplierItem.conversion_factor) > 0) {
    return { normalizedCost: Number(supplierItem.unit_price) / Number(supplierItem.conversion_factor), incomplete: false };
  }
  try {
    const factor = await convertQuantity(client, 1, purchaseUnit, stockUnit);
    return { normalizedCost: Number(supplierItem.unit_price) / factor, incomplete: false };
  } catch (err) {
    if (err.code === "NO_UNIT_CONVERSION") return { normalizedCost: null, incomplete: true };
    throw err;
  }
}

// GET /api/reports/supplier-comparison?itemId= - كل الموردين اللي بيبيعوا الصنف ده دلوقتي (سعر ساري حاليًا
// بس)، مسعّرين بوحدة تخزين الصنف نفسها (مش وحدة الشراء) عشان تتقارن صح - الأرخص أولًا
router.get("/supplier-comparison", requireAuth, canSeePurchasing, async (req, res) => {
  const { itemId } = req.query;
  if (!itemId) return res.status(400).json({ error: "لازم تحدد الصنف" });
  try {
    const item = await pool.query("SELECT id, name, unit FROM inventory_items WHERE id = $1", [itemId]);
    if (item.rows.length === 0) return res.status(404).json({ error: "الصنف مش موجود" });
    const stockUnit = item.rows[0].unit;

    const supplierItems = await pool.query(
      `SELECT si.*, s.name AS supplier_name, s.status AS supplier_status
       FROM supplier_items si JOIN suppliers s ON s.id = si.supplier_id
       WHERE si.inventory_item_id = $1 AND si.effective_to IS NULL`,
      [itemId]
    );

    const rows = [];
    for (const si of supplierItems.rows) {
      const { normalizedCost, incomplete } = await normalizedSupplierCost(pool, si, stockUnit);
      rows.push({
        supplierId: si.supplier_id, supplierName: si.supplier_name, supplierStatus: si.supplier_status,
        purchaseUnit: si.purchase_unit || stockUnit, unitPrice: Number(si.unit_price), currency: si.currency,
        normalizedCost, incomplete, stockUnit,
        minimumOrderQuantity: si.minimum_order_quantity != null ? Number(si.minimum_order_quantity) : null,
        leadTimeDays: si.lead_time_days, preferredSupplier: si.preferred_supplier,
      });
    }
    rows.sort((a, b) => {
      if (a.incomplete && !b.incomplete) return 1;
      if (!a.incomplete && b.incomplete) return -1;
      return (a.normalizedCost ?? Infinity) - (b.normalizedCost ?? Infinity);
    });
    res.json({ inventoryItemId: Number(itemId), itemName: item.rows[0].name, stockUnit, suppliers: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/reports/purchasing-recommendations?branchId= - أصناف الفرع اللي رصيدها وصل لحد إعادة الطلب
// (reorder_point) أو أقل - بيقترح كمية الطلب (لحد max_stock لو محدد) وأرخص/مفضّل مورد نشط متاح للصنف
router.get("/purchasing-recommendations", requireAuth, canSeePurchasing, async (req, res) => {
  let branchId = req.query.branchId ? Number(req.query.branchId) : null;
  if (req.user.role === "branch_manager") branchId = req.user.branchId;
  if (!branchId) return res.status(400).json({ error: "لازم تحدد الفرع" });
  try {
    const belowReorder = await pool.query(
      `SELECT bis.inventory_item_id, ii.name AS item_name, ii.unit AS stock_unit,
              bis.quantity, bis.reorder_point, bis.min_stock, bis.max_stock
       FROM branch_inventory_stock bis JOIN inventory_items ii ON ii.id = bis.inventory_item_id
       WHERE bis.branch_id = $1 AND bis.reorder_point IS NOT NULL AND bis.quantity <= bis.reorder_point
       ORDER BY (bis.quantity - bis.reorder_point) ASC`,
      [branchId]
    );

    // المرحلة 6 (6G): كان في الأول بيبعت query منفصل لـsupplier_items لكل صنف تحت نقطة إعادة الطلب لوحده
    // (N+1 حقيقي ومقاس فعليًا - 150 صنف تحت الحد = 151 رحلة قاعدة بيانات متتالية، ~170ms على localhost
    // ومتوقع أسوأ بكتير على شبكة حقيقية). دلوقتي استعلام واحد بس بـinventory_item_id = ANY(...) لكل
    // الأصناف مع بعض، والتجميع حسب الصنف بيحصل في الذاكرة
    const itemIds = belowReorder.rows.map((r) => r.inventory_item_id);
    const supplierItemsRes = itemIds.length
      ? await pool.query(
          `SELECT si.*, s.name AS supplier_name
           FROM supplier_items si JOIN suppliers s ON s.id = si.supplier_id
           WHERE si.inventory_item_id = ANY($1::int[]) AND si.effective_to IS NULL AND s.status = 'ACTIVE'`,
          [itemIds]
        )
      : { rows: [] };
    const supplierItemsByItem = new Map();
    for (const si of supplierItemsRes.rows) {
      if (!supplierItemsByItem.has(si.inventory_item_id)) supplierItemsByItem.set(si.inventory_item_id, []);
      supplierItemsByItem.get(si.inventory_item_id).push(si);
    }

    const recommendations = [];
    for (const row of belowReorder.rows) {
      const target = row.max_stock != null ? Number(row.max_stock) : Number(row.reorder_point) * 2;
      const suggestedQuantity = Math.max(0, target - Number(row.quantity));

      const supplierItems = supplierItemsByItem.get(row.inventory_item_id) || [];
      let recommendedSupplier = null;
      let bestCost = Infinity;
      for (const si of supplierItems) {
        const { normalizedCost, incomplete } = await normalizedSupplierCost(pool, si, row.stock_unit);
        if (si.preferred_supplier) { recommendedSupplier = { supplierId: si.supplier_id, supplierName: si.supplier_name, normalizedCost, reason: "preferred" }; break; }
        if (!incomplete && normalizedCost < bestCost) {
          bestCost = normalizedCost;
          recommendedSupplier = { supplierId: si.supplier_id, supplierName: si.supplier_name, normalizedCost, reason: "cheapest" };
        }
      }

      recommendations.push({
        inventoryItemId: row.inventory_item_id, itemName: row.item_name, stockUnit: row.stock_unit,
        currentQuantity: Number(row.quantity), reorderPoint: Number(row.reorder_point),
        minStock: row.min_stock != null ? Number(row.min_stock) : null, maxStock: row.max_stock != null ? Number(row.max_stock) : null,
        suggestedOrderQuantity: suggestedQuantity, recommendedSupplier,
      });
    }
    res.json(recommendations);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// المرحلة 4B: تقارير المحاسبة (Ledger-Based Accounting Reports)
// ============================================================
// كل التقارير دي مصدرها الوحيد journal_entries/journal_entry_lines (دفتر الأستاذ الرسمي) - مختلفة عن
// التقارير التشغيلية الأقدم فوق (زي income-statement) اللي مصدرها جداول العمليات مباشرة. مفيش دمج بين
// المصدرين هنا عمدًا - تقرير accounting-reconciliation في الآخر بيقارن الاتنين ويطلع أي فرق (drift)
// صراحة للمراجعة، بدل ما يتم تجاهله أو "تصحيحه" تلقائيًا.

const canSeeAccounting = requirePermission("accounting.view");
const canSeeSupplierAccounting = requirePermission("purchasing.view", "accounting.view");

// مدير الفرع (branch_manager) له رؤية فرعه بس في كل تقارير المحاسبة - زي ما اتحدد صراحة في المواصفات
function scopeBranchId(req, branchId) {
  return req.user.role === "branch_manager" ? req.user.branchId : branchId;
}

// كل سطور القيود اللي اترحّلت فعليًا في تاريخها (status <> 'DRAFT') في مدى تاريخ/فرع معيّن، مجمّعة على
// مستوى الحساب - أساس تقارير القوائم المالية تحت دي. القيد المعكوس (REVERSED) بيفضل متضمّن عمدًا (مش
// POSTED بس) لأن سطوره حصلت فعلًا وقت ترحيله؛ قيد العكس نفسه (POSTED منفصل) بيلغي أثره بالظبط - استبعاد
// الاتنين مع بعض هو الغلط (هيسيب أثر قيد العكس لوحده من غير ما ينلغي)، واستبعاد الأصلي بس (POSTED فقط)
// هيسيب الرصيد بعد أي عكس مش صفر زي ما المفروض
async function fetchPostedLines({ from, to, branchId }) {
  const result = await pool.query(
    `SELECT jel.branch_id, a.id AS account_id, a.code, a.name, a.account_type,
            COALESCE(SUM(jel.debit),0) AS total_debit, COALESCE(SUM(jel.credit),0) AS total_credit
     FROM journal_entry_lines jel
     JOIN journal_entries je ON je.id = jel.journal_entry_id
     JOIN accounts a ON a.id = jel.account_id
     WHERE je.status <> 'DRAFT'
       AND je.source_type <> 'year_end_closing'
       AND ($1::date IS NULL OR je.entry_date >= $1)
       AND ($2::date IS NULL OR je.entry_date <= $2)
       AND ($3::int IS NULL OR jel.branch_id = $3)
     GROUP BY jel.branch_id, a.id, a.code, a.name, a.account_type`,
    [from || null, to || null, branchId || null]
  );
  return result.rows;
}

// بيطوي سطور حسابات مجمّعة (من fetchPostedLines) لقائمة دخل واحدة: صافي مبيعات (الخصومات/المرتجعات
// بالفعل متضمنة جوه نوع REVENUE نفسه زي ما اتوضّح وقت ترحيل قيد البيع)، تكلفة بضاعة مباعة، مصروفات
// تشغيل بالتفصيل
function foldProfitAndLoss(rows) {
  let netSales = 0, cogs = 0, opex = 0;
  const opexLines = [];
  for (const r of rows) {
    const debit = Number(r.total_debit);
    const credit = Number(r.total_credit);
    if (r.account_type === "REVENUE") netSales += credit - debit;
    else if (r.account_type === "COGS") cogs += debit - credit;
    else if (r.account_type === "EXPENSE") {
      const amount = debit - credit;
      opex += amount;
      if (amount !== 0) opexLines.push({ code: r.code, name: r.name, amount });
    }
  }
  const grossProfit = netSales - cogs;
  const operatingProfit = grossProfit - opex;
  return {
    netSales, cogs, grossProfit,
    grossMarginPercent: netSales !== 0 ? grossProfit / netSales : null,
    opex, opexLines: opexLines.sort((a, b) => b.amount - a.amount),
    operatingProfit,
    operatingMarginPercent: netSales !== 0 ? operatingProfit / netSales : null,
  };
}

// FIFO aging: بياخد كل سطور حساب مورد معيّن (دائن = فاتورة/GRN زوّدت المديونية، مدين = سداد قلّلها) مرتبة
// بالتاريخ، وبيطفي كل سداد على أقدم فاتورة لسه فيها رصيد - زي ما بيحصل فعليًا مع أغلب الموردين (مفيش ربط
// فاتورة بسداد بعينه في النظام الحالي - المورد بياخد سداد إجمالي مش لسداد GRN معيّن)
function computeApAgingBuckets(rows, asOfDate) {
  const bySupplier = {};
  for (const r of rows) {
    if (!bySupplier[r.supplier_id]) bySupplier[r.supplier_id] = { supplierId: r.supplier_id, supplierName: r.supplier_name, queue: [] };
    const entry = bySupplier[r.supplier_id];
    const debit = Number(r.debit);
    const credit = Number(r.credit);
    if (credit > 0) entry.queue.push({ date: r.entry_date, remaining: credit });
    if (debit > 0) {
      let toConsume = debit;
      while (toConsume > 1e-7 && entry.queue.length > 0) {
        const front = entry.queue[0];
        const consumed = Math.min(front.remaining, toConsume);
        front.remaining -= consumed;
        toConsume -= consumed;
        if (front.remaining <= 1e-7) entry.queue.shift();
      }
    }
  }
  const asOf = new Date(asOfDate);
  const buckets = [];
  for (const supplierId in bySupplier) {
    const entry = bySupplier[supplierId];
    let current = 0, days31to60 = 0, days61to90 = 0, over90 = 0;
    for (const item of entry.queue) {
      if (item.remaining <= 1e-7) continue;
      const days = Math.floor((asOf - new Date(item.date)) / 86400000);
      if (days <= 30) current += item.remaining;
      else if (days <= 60) days31to60 += item.remaining;
      else if (days <= 90) days61to90 += item.remaining;
      else over90 += item.remaining;
    }
    const total = current + days31to60 + days61to90 + over90;
    if (total > 1e-7) {
      buckets.push({ supplierId: Number(supplierId), supplierName: entry.supplierName, current, days31to60, days61to90, over90, total });
    }
  }
  return buckets.sort((a, b) => b.total - a.total);
}

// المرحلة 7H: GET /api/reports/vat-summary?year=&month=&branchId= - ملخّص ضريبة القيمة المضافة المحصّلة
// في الفترة (لملء إقرار الضريبة الدوري) - إجمالي المبيعات، صافيها بعد استبعاد الضريبة، والضريبة نفسها،
// مقسّمة على الفروع. المصدر orders.vat_amount مباشرة (نفس أسلوب computeRevenueAndCogsByBranch التشغيلي
// فوق، مش دفتر الأستاذ) - القيمتين لازم يتطابقوا دايمًا (يتراجعوا في accounting-reconciliation تحت)
// ملحوظة (المرحلة 7J): الإقرار الضريبي في مصر شهري بطبيعته، فالافتراضي في الواجهة لسه سنة/شهر - لكن
// endpoint ده بيقبل from/to كمان (نفس resolveDateRange) لمرونة أكتر لمين عايز يراجع مدى مخصص
router.get("/vat-summary", requireAuth, canSeeAccounting, async (req, res) => {
  const range = resolveDateRange(req.query);
  if (!range) return res.status(400).json({ error: "لازم تحدد الفترة (from/to أو year/month)" });
  const { from, to } = range;
  const branchId = scopeBranchId(req, req.query.branchId ? Number(req.query.branchId) : null);

  try {
    const byBranchRes = await pool.query(
      `SELECT o.branch_id, COALESCE(b.name, 'غير مرتبط بفرع') AS branch_name,
              COUNT(*) AS orders_count,
              SUM(o.total) AS gross_sales,
              SUM(COALESCE(o.vat_amount, 0)) AS vat_collected
       FROM orders o
       LEFT JOIN branches b ON b.id = o.branch_id
       WHERE o.status <> 'cancelled' AND o.created_at::date BETWEEN $1 AND $2
         AND ($3::int IS NULL OR o.branch_id = $3)
       GROUP BY o.branch_id, b.name
       ORDER BY b.name`,
      [from, to, branchId]
    );
    const byBranch = byBranchRes.rows.map((r) => {
      const grossSales = Number(r.gross_sales);
      const vatCollected = Number(r.vat_collected);
      return {
        branchId: r.branch_id, branchName: r.branch_name, ordersCount: Number(r.orders_count),
        grossSales, vatCollected, netSales: grossSales - vatCollected,
      };
    });
    const totals = byBranch.reduce(
      (acc, r) => ({
        ordersCount: acc.ordersCount + r.ordersCount,
        grossSales: acc.grossSales + r.grossSales,
        vatCollected: acc.vatCollected + r.vatCollected,
        netSales: acc.netSales + r.netSales,
      }),
      { ordersCount: 0, grossSales: 0, vatCollected: 0, netSales: 0 }
    );
    const vatSettings = await pool.query("SELECT vat_rate FROM pos_settings WHERE id = 1");
    res.json({
      from, to, branchId,
      currentVatRate: Number(vatSettings.rows[0]?.vat_rate ?? 0),
      byBranch, ...totals,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/reports/trial-balance?asOf=&branchId= - ميزان المراجعة: كل حساب ورصيده حتى تاريخ معيّن
router.get("/trial-balance", requireAuth, canSeeAccounting, async (req, res) => {
  const asOf = req.query.asOf || new Date().toISOString().slice(0, 10);
  const branchId = scopeBranchId(req, req.query.branchId ? Number(req.query.branchId) : null);
  try {
    const result = await pool.query(
      `WITH filtered_lines AS (
         SELECT jel.account_id, jel.debit, jel.credit
         FROM journal_entry_lines jel
         JOIN journal_entries je ON je.id = jel.journal_entry_id
         WHERE je.status <> 'DRAFT' AND je.entry_date <= $1
           AND ($2::int IS NULL OR jel.branch_id = $2)
       )
       SELECT a.id, a.code, a.name, a.account_type,
              COALESCE(SUM(fl.debit),0) AS total_debit, COALESCE(SUM(fl.credit),0) AS total_credit
       FROM accounts a
       LEFT JOIN filtered_lines fl ON fl.account_id = a.id
       GROUP BY a.id, a.code, a.name, a.account_type
       HAVING COALESCE(SUM(fl.debit),0) <> 0 OR COALESCE(SUM(fl.credit),0) <> 0
       ORDER BY a.code`,
      [asOf, branchId]
    );
    const rows = result.rows.map((r) => {
      const debit = Number(r.total_debit);
      const credit = Number(r.total_credit);
      const normalDebit = ["ASSET", "COGS", "EXPENSE"].includes(r.account_type);
      const balance = normalDebit ? debit - credit : credit - debit;
      return { accountId: r.id, code: r.code, name: r.name, accountType: r.account_type, totalDebit: debit, totalCredit: credit, balance };
    });
    const totalDebit = rows.reduce((s, r) => s + r.totalDebit, 0);
    const totalCredit = rows.reduce((s, r) => s + r.totalCredit, 0);
    res.json({ asOf, branchId, accounts: rows, totalDebit, totalCredit, balanced: Math.abs(totalDebit - totalCredit) < 0.01 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/reports/balance-sheet?asOf=&branchId= - الميزانية العمومية: أرصدة أصول/خصوم/حقوق ملكية حتى
// تاريخ معيّن + سطر محسوب (مش مخزّن) لصافي ربح السنة الحالية غير المقفولة بعد (حساب 3300 المخصّص له في
// الشجرة فضل فاضي عمدًا - محدش بيترحّل عليه حاجة، القيمة بتتحسب لحظيًا من قائمة الدخل بدل ما تتخزّن،
// عشان توازن الأصول=الخصوم+حقوق الملكية يفضل صحيح أوتوماتيك في أي لحظة من غير قيد إقفال يومي). المدى
// بيبدأ من أول يوم بعد آخر سنة مالية مقفولة (أو من الأول لو مفيش سنة اتقفلت خالص) لغاية asOf.
// أدمن/محاسب بس (زي branch-profit-and-loss بالظبط) - مش مدير فرع: الميزانية العمومية مفهوم على مستوى
// الشركة كلها مش الفرع (حقوق الملكية 3100/3200/3300 دايمًا branch_id=NULL بطبيعتها، زي حساب الرواتب
// المستحقة 2400 اللي بيترحّل بقيد واحد مجمّع مش مقسّم على الفروع من المرحلة 4C) - فلترة الميزانية على
// فرع واحد هتوريه "غير متزنة" غلط لأسباب مالها علاقة بأي خطأ فعلي، ده هيلخبط مدير الفرع من غير داعي
router.get("/balance-sheet", requireAuth, requireRole("admin", "accountant"), async (req, res) => {
  const asOf = req.query.asOf || new Date().toISOString().slice(0, 10);
  const branchId = req.query.branchId ? Number(req.query.branchId) : null;
  try {
    const balancesRes = await pool.query(
      `WITH filtered_lines AS (
         SELECT jel.account_id, jel.debit, jel.credit
         FROM journal_entry_lines jel
         JOIN journal_entries je ON je.id = jel.journal_entry_id
         WHERE je.status <> 'DRAFT' AND je.entry_date <= $1
           AND ($2::int IS NULL OR jel.branch_id = $2)
       )
       SELECT a.id, a.code, a.name, a.account_type,
              COALESCE(SUM(fl.debit),0) AS total_debit, COALESCE(SUM(fl.credit),0) AS total_credit
       FROM accounts a
       LEFT JOIN filtered_lines fl ON fl.account_id = a.id
       WHERE a.account_type IN ('ASSET', 'LIABILITY', 'EQUITY')
       GROUP BY a.id, a.code, a.name, a.account_type
       HAVING COALESCE(SUM(fl.debit),0) <> 0 OR COALESCE(SUM(fl.credit),0) <> 0
       ORDER BY a.code`,
      [asOf, branchId]
    );
    const toLine = (r) => {
      const debit = Number(r.total_debit);
      const credit = Number(r.total_credit);
      const balance = r.account_type === "ASSET" ? debit - credit : credit - debit;
      return { accountId: r.id, code: r.code, name: r.name, balance };
    };
    const assets = balancesRes.rows.filter((r) => r.account_type === "ASSET").map(toLine);
    const liabilities = balancesRes.rows.filter((r) => r.account_type === "LIABILITY").map(toLine);
    const equity = balancesRes.rows.filter((r) => r.account_type === "EQUITY").map(toLine);

    const lastClosedRes = await pool.query("SELECT MAX(year) AS year FROM fiscal_year_closings");
    const lastClosedYear = lastClosedRes.rows[0].year;
    const pl = foldProfitAndLoss(await fetchPostedLines({
      from: lastClosedYear ? `${Number(lastClosedYear) + 1}-01-01` : null, to: asOf, branchId,
    }));
    equity.push({
      accountId: null, code: "3300", name: "صافي ربح السنة الحالية (غير مقفول)", balance: pl.operatingProfit, computed: true,
    });

    const totalAssets = assets.reduce((s, a) => s + a.balance, 0);
    const totalLiabilities = liabilities.reduce((s, a) => s + a.balance, 0);
    const totalEquity = equity.reduce((s, a) => s + a.balance, 0);

    res.json({
      asOf, branchId, assets, liabilities, equity,
      totalAssets, totalLiabilities, totalEquity,
      balanced: Math.abs(totalAssets - (totalLiabilities + totalEquity)) < 0.01,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/reports/general-ledger?accountId=&from=&to=&branchId= - كشف حساب واحد بالتفصيل مع رصيد جاري
// المرحلة 6 (6G): من غير from صريحة كان بيرجّع كل سطور الحساب من أول قيد في تاريخ الشركة كله - نمو
// غير محدود مع الوقت (كل عملية بيع/شراء بترحّل سطر جديد)، حساب زي "الصندوق" أو "الإيرادات" بعد سنة
// تشغيل ممكن يوصل لعشرات آلاف السطور في رد واحد. لو from مش محددة بنرجّع آخر سنة بس كـdefault معقول
// (قابل للتغيير صراحة لمراجعة تاريخية أبعد لو محتاج) + LIMIT كشبكة أمان أخيرة مع علم truncated صريح
const GENERAL_LEDGER_ROW_LIMIT = 20000;
router.get("/general-ledger", requireAuth, canSeeAccounting, async (req, res) => {
  const { accountId } = req.query;
  if (!accountId) return res.status(400).json({ error: "لازم تحدد accountId" });
  const branchId = scopeBranchId(req, req.query.branchId ? Number(req.query.branchId) : null);
  const to = req.query.to || null;
  let from = req.query.from || null;
  if (!from) {
    const defaultFrom = to ? new Date(to) : new Date();
    defaultFrom.setFullYear(defaultFrom.getFullYear() - 1);
    from = defaultFrom.toISOString().slice(0, 10);
  }
  try {
    const accountRes = await pool.query("SELECT * FROM accounts WHERE id = $1", [accountId]);
    if (accountRes.rows.length === 0) return res.status(404).json({ error: "الحساب مش موجود" });
    const account = accountRes.rows[0];
    const normalDebit = ["ASSET", "COGS", "EXPENSE"].includes(account.account_type);

    const result = await pool.query(
      `SELECT je.entry_number, je.entry_date, je.description AS entry_description, je.source_type, je.source_id,
              jel.debit, jel.credit, jel.description AS line_description, jel.branch_id
       FROM journal_entry_lines jel
       JOIN journal_entries je ON je.id = jel.journal_entry_id
       WHERE jel.account_id = $1 AND je.status <> 'DRAFT'
         AND je.entry_date >= $2
         AND ($3::date IS NULL OR je.entry_date <= $3)
         AND ($4::int IS NULL OR jel.branch_id = $4)
       ORDER BY je.entry_date, je.id, jel.id
       LIMIT $5`,
      [accountId, from, to, branchId, GENERAL_LEDGER_ROW_LIMIT]
    );

    let running = 0;
    const lines = result.rows.map((r) => {
      const debit = Number(r.debit);
      const credit = Number(r.credit);
      running += normalDebit ? debit - credit : credit - debit;
      return {
        entryNumber: r.entry_number, entryDate: r.entry_date, entryDescription: r.entry_description,
        sourceType: r.source_type, sourceId: r.source_id, lineDescription: r.line_description,
        branchId: r.branch_id, debit, credit, runningBalance: running,
      };
    });

    res.json({
      account: { id: account.id, code: account.code, name: account.name, accountType: account.account_type },
      from, to, branchId,
      lines, closingBalance: running,
      truncated: result.rows.length >= GENERAL_LEDGER_ROW_LIMIT,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/reports/journal-entries-report?from=&to=&branchId=&sourceType=&status= - قائمة القيود
// كتقرير (مع إجماليات حسب مصدر القيد) - بديل reporting-محور لـGET /api/accounting/journal-entries
router.get("/journal-entries-report", requireAuth, canSeeAccounting, async (req, res) => {
  const branchId = scopeBranchId(req, req.query.branchId ? Number(req.query.branchId) : null);
  const { sourceType, status } = req.query;
  try {
    const result = await pool.query(
      `SELECT je.id, je.entry_number, je.entry_date, je.description, je.source_type, je.source_id, je.status,
              je.branch_id, b.name AS branch_name,
              COALESCE((SELECT SUM(debit) FROM journal_entry_lines WHERE journal_entry_id = je.id), 0) AS total_amount
       FROM journal_entries je
       LEFT JOIN branches b ON b.id = je.branch_id
       WHERE ($1::date IS NULL OR je.entry_date >= $1)
         AND ($2::date IS NULL OR je.entry_date <= $2)
         AND ($3::int IS NULL OR je.branch_id = $3)
         AND ($4::text IS NULL OR je.source_type = $4)
         AND ($5::text IS NULL OR je.status = $5)
       ORDER BY je.entry_date DESC, je.id DESC LIMIT 1000`,
      [req.query.from || null, req.query.to || null, branchId, sourceType || null, status || null]
    );
    const bySourceType = {};
    for (const r of result.rows) {
      bySourceType[r.source_type] = bySourceType[r.source_type] || { count: 0, total: 0 };
      bySourceType[r.source_type].count += 1;
      bySourceType[r.source_type].total += Number(r.total_amount);
    }
    res.json({
      entries: result.rows.map((r) => ({
        id: r.id, entryNumber: r.entry_number, entryDate: r.entry_date, description: r.description,
        sourceType: r.source_type, sourceId: r.source_id, status: r.status,
        branchId: r.branch_id, branchName: r.branch_name, totalAmount: Number(r.total_amount),
      })),
      count: result.rows.length,
      bySourceType,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/reports/profit-and-loss?from=&to=&year=&month=&branchId= - قائمة دخل من دفتر الأستاذ
// (منفصلة عن /income-statement التشغيلي الأقدم فوق - قارن الاتنين عن طريق accounting-reconciliation)
router.get("/profit-and-loss", requireAuth, canSeeAccounting, async (req, res) => {
  const range = resolveDateRange(req.query);
  if (!range) return res.status(400).json({ error: "لازم تحدد from/to أو year/month" });
  const branchId = scopeBranchId(req, req.query.branchId ? Number(req.query.branchId) : null);
  try {
    const rows = await fetchPostedLines({ from: range.from, to: range.to, branchId });
    res.json({ from: range.from, to: range.to, branchId, ...foldProfitAndLoss(rows) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/reports/branch-profit-and-loss?from=&to=&year=&month= - مقارنة قائمة دخل كل الفروع (من دفتر
// الأستاذ) - أدمن/محاسب بس (زي income-statement/by-branch بالظبط لنفس السبب: مقارنة بين فروع تانية)
router.get("/branch-profit-and-loss", requireAuth, requireRole("admin", "accountant"), async (req, res) => {
  const range = resolveDateRange(req.query);
  if (!range) return res.status(400).json({ error: "لازم تحدد from/to أو year/month" });
  try {
    const rows = await fetchPostedLines({ from: range.from, to: range.to });
    const byBranch = {};
    rows.forEach((r) => { const k = r.branch_id || "unassigned"; (byBranch[k] = byBranch[k] || []).push(r); });
    const branchesRes = await pool.query("SELECT id, name FROM branches");
    const names = {};
    branchesRes.rows.forEach((b) => { names[b.id] = b.name; });

    const branches = Object.entries(byBranch).map(([key, branchRows]) => ({
      branchId: key === "unassigned" ? null : Number(key),
      branchName: key === "unassigned" ? "غير محدد" : (names[key] || `فرع ${key}`),
      ...foldProfitAndLoss(branchRows),
    })).sort((a, b) => b.netSales - a.netSales);

    res.json({ from: range.from, to: range.to, branches, consolidated: foldProfitAndLoss(rows) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// عامل مشترك لتقارير "مقياس واحد لكل الفروع" (إيراد/تكلفة بضاعة/مصروفات تشغيل) - نفس منطق
// branch-profit-and-loss بس مركّز على رقم واحد بس عشان الشاشة تكون أبسط
function makeByBranchMetricReport(metricKey) {
  return async (req, res) => {
    const range = resolveDateRange(req.query);
    if (!range) return res.status(400).json({ error: "لازم تحدد from/to أو year/month" });
    try {
      const rows = await fetchPostedLines({ from: range.from, to: range.to });
      const byBranch = {};
      rows.forEach((r) => { const k = r.branch_id || "unassigned"; (byBranch[k] = byBranch[k] || []).push(r); });
      const branchesRes = await pool.query("SELECT id, name FROM branches");
      const names = {};
      branchesRes.rows.forEach((b) => { names[b.id] = b.name; });

      const branches = Object.entries(byBranch).map(([key, branchRows]) => {
        const pl = foldProfitAndLoss(branchRows);
        return {
          branchId: key === "unassigned" ? null : Number(key),
          branchName: key === "unassigned" ? "غير محدد" : (names[key] || `فرع ${key}`),
          [metricKey]: pl[metricKey],
          ...(metricKey === "opex" ? { opexLines: pl.opexLines } : {}),
        };
      }).sort((a, b) => b[metricKey] - a[metricKey]);

      res.json({ from: range.from, to: range.to, branches, total: branches.reduce((s, b) => s + b[metricKey], 0) });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  };
}
// GET /api/reports/revenue-by-branch?from=&to=&year=&month=
router.get("/revenue-by-branch", requireAuth, requireRole("admin", "accountant"), makeByBranchMetricReport("netSales"));
// GET /api/reports/cogs-by-branch?from=&to=&year=&month=
router.get("/cogs-by-branch", requireAuth, requireRole("admin", "accountant"), makeByBranchMetricReport("cogs"));
// GET /api/reports/opex-by-branch?from=&to=&year=&month=
router.get("/opex-by-branch", requireAuth, requireRole("admin", "accountant"), makeByBranchMetricReport("opex"));

// GET /api/reports/cash-report?asOf=&branchId= - أرصدة حسابات الكاش (المركزي + كل فرع) حتى تاريخ معيّن
router.get("/cash-report", requireAuth, canSeeAccounting, async (req, res) => {
  const asOf = req.query.asOf || new Date().toISOString().slice(0, 10);
  const branchId = scopeBranchId(req, req.query.branchId ? Number(req.query.branchId) : null);
  try {
    const accountsRes = await pool.query(
      `WITH filtered_lines AS (
         SELECT jel.account_id, jel.debit, jel.credit
         FROM journal_entry_lines jel JOIN journal_entries je ON je.id = jel.journal_entry_id
         WHERE je.status <> 'DRAFT' AND je.entry_date <= $1
       )
       SELECT a.id, a.code, a.name, a.branch_id,
              COALESCE(SUM(fl.debit),0) - COALESCE(SUM(fl.credit),0) AS balance
       FROM accounts a
       LEFT JOIN filtered_lines fl ON fl.account_id = a.id
       WHERE (a.code = '1100' OR a.code LIKE '1100-%')
         AND ($2::int IS NULL OR a.branch_id = $2)
       GROUP BY a.id, a.code, a.name, a.branch_id
       ORDER BY a.code`,
      [asOf, branchId]
    );
    const accounts = accountsRes.rows.map((r) => ({
      accountId: r.id, code: r.code, name: r.name, branchId: r.branch_id, balance: Number(r.balance),
    }));
    res.json({ asOf, branchId, accounts, totalCash: accounts.reduce((s, a) => s + a.balance, 0) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/reports/supplier-balances?includeZero=true - رصيد كل مورد (مدين/دائن) من سطور حساب 2100
// المرتبطة بيه - بديل تجميعي لـGET /api/supplier-payments/balance/:id اللي بيجيب مورد واحد بس
router.get("/supplier-balances", requireAuth, canSeeSupplierAccounting, async (req, res) => {
  const includeZero = req.query.includeZero === "true";
  try {
    const result = await pool.query(
      `WITH ap_lines AS (
         SELECT jel.reference_id AS supplier_id, jel.debit, jel.credit
         FROM journal_entry_lines jel JOIN journal_entries je ON je.id = jel.journal_entry_id
         WHERE jel.reference_type = 'supplier' AND je.status <> 'DRAFT'
       )
       SELECT s.id, s.name, s.status,
              COALESCE(SUM(al.credit),0) - COALESCE(SUM(al.debit),0) AS balance
       FROM suppliers s
       LEFT JOIN ap_lines al ON al.supplier_id = s.id
       GROUP BY s.id, s.name, s.status
       ORDER BY balance DESC`
    );
    const rows = result.rows
      .map((r) => ({ supplierId: r.id, supplierName: r.name, status: r.status, balance: Number(r.balance) }))
      .filter((r) => includeZero || Math.abs(r.balance) > 0.0001);
    res.json({ suppliers: rows, totalOutstanding: rows.reduce((s, r) => s + r.balance, 0) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/reports/ap-aging?asOf= - أعمار ديون الموردين (Accounts Payable Aging) - FIFO بين
// الفواتير (GRN) والسدادات لكل مورد، مقسّمة على 0-30/31-60/61-90/90+ يوم
router.get("/ap-aging", requireAuth, canSeeSupplierAccounting, async (req, res) => {
  const asOf = req.query.asOf || new Date().toISOString().slice(0, 10);
  try {
    const result = await pool.query(
      `SELECT jel.reference_id AS supplier_id, s.name AS supplier_name, je.entry_date, jel.debit, jel.credit
       FROM journal_entry_lines jel
       JOIN journal_entries je ON je.id = jel.journal_entry_id
       JOIN suppliers s ON s.id = jel.reference_id
       WHERE jel.reference_type = 'supplier' AND je.status <> 'DRAFT' AND je.entry_date <= $1
       ORDER BY jel.reference_id, je.entry_date, jel.id`,
      [asOf]
    );
    const suppliers = computeApAgingBuckets(result.rows, asOf);
    const totals = suppliers.reduce((acc, b) => ({
      current: acc.current + b.current, days31to60: acc.days31to60 + b.days31to60,
      days61to90: acc.days61to90 + b.days61to90, over90: acc.over90 + b.over90, total: acc.total + b.total,
    }), { current: 0, days31to60: 0, days61to90: 0, over90: 0, total: 0 });
    res.json({ asOf, suppliers, totals });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PART 9 (Full System Audit): GET /api/reports/supplier-statement?supplierId=&from=&to= - كشف حساب
// مورد واحد: رصيد افتتاحي (كل ما قبل from) + كل حركة في المدى (GRN/فرق فاتورة/سداد - أي سطر
// reference_type='supplier' لنفس المورد) بترتيب التاريخ مع رصيد جاري بعد كل حركة + رصيد ختامي - كله
// من journal_entry_lines/journal_entries مباشرة (نفس مصدر supplier-balances/ap-aging فوق بالظبط)،
// مفيش حساب محاسبي مستقل أو مصدر بيانات موازٍ. jel.credit يزوّد المستحق للمورد (GRN/فرق سالب)،
// jel.debit ينقصه (سداد/فرق موجب) - نفس اتجاه الحساب 2100 (Accounts Payable) في كل مكان تاني بالنظام
router.get("/supplier-statement", requireAuth, canSeeSupplierAccounting, async (req, res) => {
  const supplierId = Number(req.query.supplierId);
  if (!supplierId) return res.status(400).json({ error: "لازم تحدد supplierId", code: "INVALID_PARAMETER" });
  const to = req.query.to || new Date().toISOString().slice(0, 10);
  const from = req.query.from || "1970-01-01";
  try {
    const supplierRes = await pool.query("SELECT id, name FROM suppliers WHERE id = $1", [supplierId]);
    if (supplierRes.rows.length === 0) return res.status(404).json({ error: "المورد مش موجود" });

    const openingRes = await pool.query(
      `SELECT COALESCE(SUM(jel.credit) - SUM(jel.debit), 0) AS balance
       FROM journal_entry_lines jel JOIN journal_entries je ON je.id = jel.journal_entry_id
       WHERE jel.reference_type = 'supplier' AND jel.reference_id = $1 AND je.status <> 'DRAFT' AND je.entry_date < $2`,
      [supplierId, from]
    );
    const openingBalance = Number(openingRes.rows[0].balance);

    const linesRes = await pool.query(
      `SELECT je.entry_date, je.entry_number, je.source_type, je.source_id,
              COALESCE(jel.description, je.description) AS description, jel.debit, jel.credit
       FROM journal_entry_lines jel JOIN journal_entries je ON je.id = jel.journal_entry_id
       WHERE jel.reference_type = 'supplier' AND jel.reference_id = $1 AND je.status <> 'DRAFT'
         AND je.entry_date BETWEEN $2 AND $3
       ORDER BY je.entry_date, je.id, jel.id`,
      [supplierId, from, to]
    );
    let running = openingBalance;
    const lines = linesRes.rows.map((r) => {
      running += Number(r.credit) - Number(r.debit);
      return {
        date: r.entry_date, entryNumber: r.entry_number, sourceType: r.source_type, sourceId: r.source_id,
        description: r.description, debit: Number(r.debit), credit: Number(r.credit), runningBalance: running,
      };
    });
    res.json({
      supplierId, supplierName: supplierRes.rows[0].name, from, to,
      openingBalance, lines, closingBalance: running,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/reports/accounting-expense-report?from=&to=&year=&month=&branchId= - المصروفات (EXPENSE)
// من دفتر الأستاذ مجمّعة حسب الحساب - نسخة محاسبية من /expenses-report التشغيلي فوق (ده مصدره جدول
// expenses مباشرة، ده مصدره القيود المرحّلة بس، وبيشمل أي قيد مصروف حتى لو معمول يدوي)
router.get("/accounting-expense-report", requireAuth, canSeeAccounting, async (req, res) => {
  const range = resolveDateRange(req.query);
  if (!range) return res.status(400).json({ error: "لازم تحدد from/to أو year/month" });
  const branchId = scopeBranchId(req, req.query.branchId ? Number(req.query.branchId) : null);
  try {
    const result = await pool.query(
      `SELECT a.code, a.name,
              COALESCE(SUM(jel.debit),0) - COALESCE(SUM(jel.credit),0) AS total
       FROM journal_entry_lines jel
       JOIN journal_entries je ON je.id = jel.journal_entry_id
       JOIN accounts a ON a.id = jel.account_id AND a.account_type = 'EXPENSE'
       WHERE je.status <> 'DRAFT' AND je.source_type <> 'year_end_closing' AND je.entry_date BETWEEN $1 AND $2
         AND ($3::int IS NULL OR jel.branch_id = $3)
       GROUP BY a.code, a.name
       ORDER BY total DESC`,
      [range.from, range.to, branchId]
    );
    const lines = result.rows.map((r) => ({ code: r.code, name: r.name, total: Number(r.total) }));
    res.json({ from: range.from, to: range.to, branchId, lines, total: lines.reduce((s, l) => s + l.total, 0) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/reports/sales-by-payment-method?from=&to=&year=&month=&branchId= - إجمالي المبيعات مقسّمة
// حسب حساب التحصيل (كاش/بنك/عملاء/تطبيقات توصيل) - مأخوذة من مدين قيد البيع نفسه، مش من عمود مستقل
router.get("/sales-by-payment-method", requireAuth, canSeeAccounting, async (req, res) => {
  const range = resolveDateRange(req.query);
  if (!range) return res.status(400).json({ error: "لازم تحدد from/to أو year/month" });
  const branchId = scopeBranchId(req, req.query.branchId ? Number(req.query.branchId) : null);
  try {
    const result = await pool.query(
      `SELECT a.code, a.name, COALESCE(SUM(jel.debit),0) AS total, COUNT(DISTINCT je.source_id) AS order_count
       FROM journal_entry_lines jel
       JOIN journal_entries je ON je.id = jel.journal_entry_id
       JOIN accounts a ON a.id = jel.account_id AND a.account_type = 'ASSET'
       WHERE je.status <> 'DRAFT' AND je.source_type = 'order_sale' AND jel.debit > 0
         AND je.entry_date BETWEEN $1 AND $2 AND ($3::int IS NULL OR jel.branch_id = $3)
       GROUP BY a.code, a.name
       ORDER BY total DESC`,
      [range.from, range.to, branchId]
    );
    const lines = result.rows.map((r) => ({ code: r.code, name: r.name, total: Number(r.total), orderCount: Number(r.order_count) }));
    res.json({ from: range.from, to: range.to, branchId, lines, total: lines.reduce((s, l) => s + l.total, 0) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/reports/delivery-app-settlement?from=&to=&year=&month=&branchId= - تسوية تطبيقات التوصيل:
// المبيعات الإجمالية زي ما هي (من غير خصم عمولة) + عمولة منفصلة (لو اتسجلت كمصروف على حساب 6600) +
// الرصيد المستحق حاليًا على التطبيقات (1350) - العمولة ماتخصمش من الإيراد أبدًا، بتظهر كمصروف مستقل
router.get("/delivery-app-settlement", requireAuth, canSeeAccounting, async (req, res) => {
  const range = resolveDateRange(req.query);
  if (!range) return res.status(400).json({ error: "لازم تحدد from/to أو year/month" });
  const branchId = scopeBranchId(req, req.query.branchId ? Number(req.query.branchId) : null);
  try {
    const grossRes = await pool.query(
      `SELECT o.source, COUNT(DISTINCT o.id) AS order_count, COALESCE(SUM(jel.debit),0) AS gross_amount
       FROM journal_entry_lines jel
       JOIN journal_entries je ON je.id = jel.journal_entry_id
       JOIN accounts a ON a.id = jel.account_id AND a.code = '1350'
       JOIN orders o ON o.id = je.source_id
       WHERE je.source_type = 'order_sale' AND je.status <> 'DRAFT'
         AND je.entry_date BETWEEN $1 AND $2 AND ($3::int IS NULL OR je.branch_id = $3)
       GROUP BY o.source
       ORDER BY gross_amount DESC`,
      [range.from, range.to, branchId]
    );
    const commissionRes = await pool.query(
      `SELECT COALESCE(SUM(jel.debit),0) - COALESCE(SUM(jel.credit),0) AS commission
       FROM journal_entry_lines jel JOIN journal_entries je ON je.id = jel.journal_entry_id
       JOIN accounts a ON a.id = jel.account_id AND a.code = '6600'
       WHERE je.status <> 'DRAFT' AND je.source_type <> 'year_end_closing'
         AND je.entry_date BETWEEN $1 AND $2 AND ($3::int IS NULL OR jel.branch_id = $3)`,
      [range.from, range.to, branchId]
    );
    const outstandingRes = await pool.query(
      `WITH filtered_lines AS (
         SELECT jel.debit, jel.credit FROM journal_entry_lines jel
         JOIN journal_entries je ON je.id = jel.journal_entry_id
         JOIN accounts a ON a.id = jel.account_id AND a.code = '1350'
         WHERE je.status <> 'DRAFT' AND je.entry_date <= $1 AND ($2::int IS NULL OR jel.branch_id = $2)
       )
       SELECT COALESCE(SUM(debit),0) - COALESCE(SUM(credit),0) AS balance FROM filtered_lines`,
      [range.to, branchId]
    );
    const bySource = grossRes.rows.map((r) => ({ source: r.source, orderCount: Number(r.order_count), grossAmount: Number(r.gross_amount) }));
    const grossTotal = bySource.reduce((s, r) => s + r.grossAmount, 0);
    const commissionExpense = Number(commissionRes.rows[0].commission);
    res.json({
      from: range.from, to: range.to, branchId,
      bySource, grossTotal, commissionExpense, netSettlement: grossTotal - commissionExpense,
      outstandingReceivable: Number(outstandingRes.rows[0].balance),
      note: "المبيعات هنا إجمالية زي ما هي من غير خصم عمولة التطبيق - العمولة ظاهرة كمصروف منفصل (حساب 6600) لو اتسجلت، مش متخصومة من الإيراد",
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// كشوف حسابات إضافية (طلب المستخدم) - كل واحدة بتقرأ من orders/payment_methods/delivery_areas/drivers
// مباشرة (نفس مصدر sales-detail/areas-performance/supplier-statement فوق) - مفيش حساب GL جديد ولا
// جدول جديد: فيزا/انستاباي/محفظة كلهم من قبل ليهم صف مستقل في payment_methods (بس بنفس kind
// 'card_or_wallet' - الحساب المحاسبي 1200 واحد للتلاتة، التمييز بينهم بالاسم بس) فمفيش داعي لأي تعديل
// في accounts/journal_entries عشان نميّزهم في التقرير - الاستعلام بيفلتر بـpayment_method_id مباشرة
// ============================================================

// GET /api/reports/takeaway-statement?from=&to=&year=&month=&branchId= - كشف حساب تيك أواي
router.get("/takeaway-statement", requireAuth, canSeeAccounting, async (req, res) => {
  const range = resolveDateRange(req.query);
  if (!range) return res.status(400).json({ error: "لازم تحدد from/to أو year/month" });
  const branchId = scopeBranchId(req, req.query.branchId ? Number(req.query.branchId) : null);
  try {
    const [ordersRes, byPaymentMethod] = await Promise.all([
      pool.query(
        `SELECT o.id, o.branch_id, b.name AS branch_name, o.created_at, o.customer_name, o.customer_phone,
                COALESCE(pm.name, 'بدون طريقة دفع') AS payment_method_name, pm.kind AS payment_method_kind,
                o.subtotal, o.discount, o.total, o.status
         FROM orders o LEFT JOIN branches b ON b.id = o.branch_id
         LEFT JOIN payment_methods pm ON pm.id = o.payment_method_id
         WHERE o.order_type = 'takeaway' AND o.status <> 'cancelled' AND o.created_at::date BETWEEN $1 AND $2
           AND ($3::int IS NULL OR o.branch_id = $3)
         ORDER BY o.created_at`,
        [range.from, range.to, branchId]
      ),
      pool.query(
        `SELECT COALESCE(pm.name, 'بدون طريقة دفع') AS name, pm.kind, SUM(o.total) AS amount, COUNT(*) AS count
         FROM orders o LEFT JOIN payment_methods pm ON pm.id = o.payment_method_id
         WHERE o.order_type = 'takeaway' AND o.status <> 'cancelled' AND o.created_at::date BETWEEN $1 AND $2
           AND ($3::int IS NULL OR o.branch_id = $3)
         GROUP BY pm.name, pm.kind ORDER BY amount DESC`,
        [range.from, range.to, branchId]
      ),
    ]);
    const orders = ordersRes.rows.map((r) => ({
      id: r.id, branchId: r.branch_id, branchName: r.branch_name, createdAt: r.created_at,
      customerName: r.customer_name, customerPhone: r.customer_phone,
      paymentMethodName: r.payment_method_name, paymentMethodKind: r.payment_method_kind,
      subtotal: Number(r.subtotal), discount: Number(r.discount), total: Number(r.total), status: r.status,
    }));
    const ordersCount = orders.length;
    const grossSubtotal = orders.reduce((s, o) => s + o.subtotal, 0);
    const totalDiscount = orders.reduce((s, o) => s + o.discount, 0);
    const netTotal = orders.reduce((s, o) => s + o.total, 0);
    res.json({
      from: range.from, to: range.to, branchId,
      summary: { ordersCount, grossSubtotal, totalDiscount, netTotal, avgOrderValue: ordersCount > 0 ? netTotal / ordersCount : 0 },
      byPaymentMethod: byPaymentMethod.rows.map((r) => ({ name: r.name, kind: r.kind, amount: Number(r.amount), count: Number(r.count) })),
      orders,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/reports/delivery-statement?from=&to=&year=&month=&branchId= - كشف حساب أوردرات الدليفري
router.get("/delivery-statement", requireAuth, canSeeAccounting, async (req, res) => {
  const range = resolveDateRange(req.query);
  if (!range) return res.status(400).json({ error: "لازم تحدد from/to أو year/month" });
  const branchId = scopeBranchId(req, req.query.branchId ? Number(req.query.branchId) : null);
  try {
    const [ordersRes, byPaymentMethod] = await Promise.all([
      pool.query(
        `SELECT o.id, o.branch_id, b.name AS branch_name, o.created_at, o.customer_name, o.customer_phone,
                da.name AS area_name, o.driver_name,
                COALESCE(pm.name, 'بدون طريقة دفع') AS payment_method_name, pm.kind AS payment_method_kind,
                o.subtotal, o.delivery_fee, o.discount, o.total, o.status
         FROM orders o LEFT JOIN branches b ON b.id = o.branch_id
         LEFT JOIN delivery_areas da ON da.id = o.delivery_area_id
         LEFT JOIN payment_methods pm ON pm.id = o.payment_method_id
         WHERE o.order_type = 'delivery' AND o.status <> 'cancelled' AND o.created_at::date BETWEEN $1 AND $2
           AND ($3::int IS NULL OR o.branch_id = $3)
         ORDER BY o.created_at`,
        [range.from, range.to, branchId]
      ),
      pool.query(
        `SELECT COALESCE(pm.name, 'بدون طريقة دفع') AS name, pm.kind, SUM(o.total) AS amount, COUNT(*) AS count
         FROM orders o LEFT JOIN payment_methods pm ON pm.id = o.payment_method_id
         WHERE o.order_type = 'delivery' AND o.status <> 'cancelled' AND o.created_at::date BETWEEN $1 AND $2
           AND ($3::int IS NULL OR o.branch_id = $3)
         GROUP BY pm.name, pm.kind ORDER BY amount DESC`,
        [range.from, range.to, branchId]
      ),
    ]);
    const orders = ordersRes.rows.map((r) => ({
      id: r.id, branchId: r.branch_id, branchName: r.branch_name, createdAt: r.created_at,
      customerName: r.customer_name, customerPhone: r.customer_phone,
      areaName: r.area_name, driverName: r.driver_name,
      paymentMethodName: r.payment_method_name, paymentMethodKind: r.payment_method_kind,
      subtotal: Number(r.subtotal), deliveryFee: Number(r.delivery_fee), discount: Number(r.discount),
      total: Number(r.total), status: r.status,
    }));
    const ordersCount = orders.length;
    const grossSubtotal = orders.reduce((s, o) => s + o.subtotal, 0);
    const totalDeliveryFees = orders.reduce((s, o) => s + o.deliveryFee, 0);
    const totalDiscount = orders.reduce((s, o) => s + o.discount, 0);
    const netTotal = orders.reduce((s, o) => s + o.total, 0);
    res.json({
      from: range.from, to: range.to, branchId,
      summary: { ordersCount, grossSubtotal, totalDeliveryFees, totalDiscount, netTotal, avgOrderValue: ordersCount > 0 ? netTotal / ordersCount : 0 },
      byPaymentMethod: byPaymentMethod.rows.map((r) => ({ name: r.name, kind: r.kind, amount: Number(r.amount), count: Number(r.count) })),
      orders,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/reports/delivery-service-statement?from=&to=&year=&month=&branchId= - كشف حساب خدمة التوصيل
// حسب المناطق (كل حركة الأوردرات في كل منطقة) وأداء كل طيار (من نظام التوزيع الحديث drivers/dispatch_status
// - المرحلة 7F - مش عمود driver_name القديم اللي بيستخدمه تقرير /drivers فوق، عشان يبقى مربوط فعليًا
// بجدول السائقين وتسويات الكاش بتاعتهم driver_settlements)
router.get("/delivery-service-statement", requireAuth, canSeeAccounting, async (req, res) => {
  const range = resolveDateRange(req.query);
  if (!range) return res.status(400).json({ error: "لازم تحدد from/to أو year/month" });
  const branchId = scopeBranchId(req, req.query.branchId ? Number(req.query.branchId) : null);
  try {
    const [byArea, byDriver] = await Promise.all([
      pool.query(
        `SELECT da.id AS area_id, da.name AS area_name,
                COUNT(*) AS orders_count, COALESCE(SUM(o.total), 0) AS revenue,
                COALESCE(SUM(o.delivery_fee), 0) AS delivery_fees
         FROM orders o JOIN delivery_areas da ON da.id = o.delivery_area_id
         WHERE o.order_type = 'delivery' AND o.status <> 'cancelled'
           AND o.created_at::date BETWEEN $1 AND $2 AND ($3::int IS NULL OR o.branch_id = $3)
         GROUP BY da.id, da.name ORDER BY revenue DESC`,
        [range.from, range.to, branchId]
      ),
      pool.query(
        `SELECT d.id AS driver_id, d.driver_code, d.name AS driver_name,
                COUNT(*) FILTER (WHERE o.dispatch_status = 'DELIVERED') AS delivered_count,
                COUNT(*) FILTER (WHERE o.dispatch_status = 'FAILED') AS failed_count,
                COALESCE(SUM(o.total) FILTER (WHERE o.dispatch_status = 'DELIVERED'), 0) AS revenue,
                COALESCE(SUM(o.delivery_fee) FILTER (WHERE o.dispatch_status = 'DELIVERED'), 0) AS delivery_fees,
                AVG(EXTRACT(EPOCH FROM (o.delivered_at - o.assigned_at)) / 60)
                  FILTER (WHERE o.dispatch_status = 'DELIVERED') AS avg_delivery_minutes
         FROM orders o JOIN drivers d ON d.id = o.driver_id
         WHERE o.order_type = 'delivery' AND o.assigned_at::date BETWEEN $1 AND $2
           AND ($3::int IS NULL OR o.branch_id = $3)
         GROUP BY d.id, d.driver_code, d.name ORDER BY delivered_count DESC`,
        [range.from, range.to, branchId]
      ),
    ]);
    res.json({
      from: range.from, to: range.to, branchId,
      byArea: byArea.rows.map((r) => ({
        areaId: r.area_id, areaName: r.area_name, ordersCount: Number(r.orders_count),
        revenue: Number(r.revenue), deliveryFees: Number(r.delivery_fees),
      })),
      byDriver: byDriver.rows.map((r) => ({
        driverId: r.driver_id, driverCode: r.driver_code, driverName: r.driver_name,
        deliveredCount: Number(r.delivered_count), failedCount: Number(r.failed_count),
        revenue: Number(r.revenue), deliveryFees: Number(r.delivery_fees),
        avgDeliveryMinutes: r.avg_delivery_minutes != null ? Number(r.avg_delivery_minutes) : null,
      })),
      note: "أداء السائقين هنا من نظام التوزيع الحديث (drivers/dispatch_status) - بيشمل بس الطلبات اللي اتوزّعت فعليًا لسائق مسجّل",
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/reports/payment-method-statement?paymentMethodId=&from=&to=&year=&month=&branchId= - كشف
// حساب طريقة دفع معيّنة (فيزا/انستاباي/محفظة/أي طريقة تانية مسجّلة في payment_methods) - قائمة الأوردرات
// اللي اتحصّلت بيها + إجمالي، مباشرة من orders.payment_method_id (زي ما هو مفلتَر أصلًا في POS/كول سنتر)
router.get("/payment-method-statement", requireAuth, canSeeAccounting, async (req, res) => {
  const range = resolveDateRange(req.query);
  if (!range) return res.status(400).json({ error: "لازم تحدد from/to أو year/month" });
  const paymentMethodId = Number(req.query.paymentMethodId);
  if (!paymentMethodId) return res.status(400).json({ error: "لازم تحدد paymentMethodId", code: "INVALID_PARAMETER" });
  const branchId = scopeBranchId(req, req.query.branchId ? Number(req.query.branchId) : null);
  try {
    const pmRes = await pool.query("SELECT id, name, kind FROM payment_methods WHERE id = $1", [paymentMethodId]);
    if (pmRes.rows.length === 0) return res.status(404).json({ error: "طريقة الدفع مش موجودة" });

    const ordersRes = await pool.query(
      `SELECT o.id, o.branch_id, b.name AS branch_name, o.order_type, o.created_at,
              o.customer_name, o.customer_phone, o.subtotal, o.delivery_fee, o.discount, o.total, o.status
       FROM orders o LEFT JOIN branches b ON b.id = o.branch_id
       WHERE o.payment_method_id = $1 AND o.status <> 'cancelled' AND o.created_at::date BETWEEN $2 AND $3
         AND ($4::int IS NULL OR o.branch_id = $4)
       ORDER BY o.created_at`,
      [paymentMethodId, range.from, range.to, branchId]
    );
    const orders = ordersRes.rows.map((r) => ({
      id: r.id, branchId: r.branch_id, branchName: r.branch_name, orderType: r.order_type, createdAt: r.created_at,
      customerName: r.customer_name, customerPhone: r.customer_phone,
      subtotal: Number(r.subtotal), deliveryFee: Number(r.delivery_fee), discount: Number(r.discount),
      total: Number(r.total), status: r.status,
    }));
    const ordersCount = orders.length;
    const netTotal = orders.reduce((s, o) => s + o.total, 0);
    res.json({
      from: range.from, to: range.to, branchId,
      paymentMethod: { id: pmRes.rows[0].id, name: pmRes.rows[0].name, kind: pmRes.rows[0].kind },
      summary: { ordersCount, netTotal, avgOrderValue: ordersCount > 0 ? netTotal / ordersCount : 0 },
      orders,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/reports/orders-payment-split-statement?from=&to=&year=&month=&branchId= - كشف حساب الطلبات
// مقسّم حسب نوع التحصيل (كاش/فيزا-محفظة-انستاباي/آجل - من payment_methods.kind) + قسم مستقل للخصومات
router.get("/orders-payment-split-statement", requireAuth, canSeeAccounting, async (req, res) => {
  const range = resolveDateRange(req.query);
  if (!range) return res.status(400).json({ error: "لازم تحدد from/to أو year/month" });
  const branchId = scopeBranchId(req, req.query.branchId ? Number(req.query.branchId) : null);
  try {
    const [byKindRes, discountedRes] = await Promise.all([
      pool.query(
        `SELECT COALESCE(pm.kind, 'unknown') AS kind, COUNT(*) AS orders_count, COALESCE(SUM(o.total), 0) AS total
         FROM orders o LEFT JOIN payment_methods pm ON pm.id = o.payment_method_id
         WHERE o.status <> 'cancelled' AND o.created_at::date BETWEEN $1 AND $2
           AND ($3::int IS NULL OR o.branch_id = $3)
         GROUP BY pm.kind`,
        [range.from, range.to, branchId]
      ),
      pool.query(
        `SELECT o.id, o.branch_id, b.name AS branch_name, o.order_type, o.created_at,
                o.customer_name, o.subtotal, o.discount, o.total, u.name AS approved_by_name
         FROM orders o LEFT JOIN branches b ON b.id = o.branch_id
         LEFT JOIN users u ON u.id = o.discount_approved_by
         WHERE o.discount > 0 AND o.status <> 'cancelled' AND o.created_at::date BETWEEN $1 AND $2
           AND ($3::int IS NULL OR o.branch_id = $3)
         ORDER BY o.discount DESC`,
        [range.from, range.to, branchId]
      ),
    ]);
    const kindLabels = { cash: "كاش", card_or_wallet: "فيزا / محفظة / انستاباي", credit: "آجل", unknown: "بدون طريقة دفع" };
    const byKind = byKindRes.rows.map((r) => ({
      kind: r.kind, label: kindLabels[r.kind] || r.kind, ordersCount: Number(r.orders_count), total: Number(r.total),
    }));
    const discountedOrders = discountedRes.rows.map((r) => ({
      id: r.id, branchId: r.branch_id, branchName: r.branch_name, orderType: r.order_type, createdAt: r.created_at,
      customerName: r.customer_name, subtotal: Number(r.subtotal), discount: Number(r.discount), total: Number(r.total),
      approvedByName: r.approved_by_name,
    }));
    res.json({
      from: range.from, to: range.to, branchId,
      byKind,
      discountsSummary: {
        ordersCount: discountedOrders.length,
        totalDiscount: discountedOrders.reduce((s, o) => s + o.discount, 0),
      },
      discountedOrders,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/reports/gross-profit?from=&to=&year=&month=&branchId=
router.get("/gross-profit", requireAuth, canSeeAccounting, async (req, res) => {
  const range = resolveDateRange(req.query);
  if (!range) return res.status(400).json({ error: "لازم تحدد from/to أو year/month" });
  const branchId = scopeBranchId(req, req.query.branchId ? Number(req.query.branchId) : null);
  try {
    const pl = foldProfitAndLoss(await fetchPostedLines({ from: range.from, to: range.to, branchId }));
    res.json({
      from: range.from, to: range.to, branchId,
      netSales: pl.netSales, cogs: pl.cogs, grossProfit: pl.grossProfit, grossMarginPercent: pl.grossMarginPercent,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/reports/net-operating-profit?from=&to=&year=&month=&branchId=
router.get("/net-operating-profit", requireAuth, canSeeAccounting, async (req, res) => {
  const range = resolveDateRange(req.query);
  if (!range) return res.status(400).json({ error: "لازم تحدد from/to أو year/month" });
  const branchId = scopeBranchId(req, req.query.branchId ? Number(req.query.branchId) : null);
  try {
    const pl = foldProfitAndLoss(await fetchPostedLines({ from: range.from, to: range.to, branchId }));
    res.json({
      from: range.from, to: range.to, branchId,
      grossProfit: pl.grossProfit, opex: pl.opex, operatingProfit: pl.operatingProfit,
      operatingMarginPercent: pl.operatingMarginPercent,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/reports/accounting-reconciliation?from=&to=&branchId= (أو year=&month= كاختصار) - مقارنة
// دفتر الأستاذ الرسمي بمصادر البيانات التشغيلية المستقلة (income-statement القديم، جلسات الكاش
// اليومية، قيمة المخزون الفعلية، استلام البضاعة، سداد الموردين) - أي فرق (drift) لازم يظهر هنا
// صراحة، مفيش دمج أو "تصحيح" تلقائي بين المصدرين. أدمن/محاسب بس (بيغطي كل الفروع مع بعض عادةً)
router.get("/accounting-reconciliation", requireAuth, requireRole("admin", "accountant"), async (req, res) => {
  const range = resolveDateRange(req.query);
  if (!range) return res.status(400).json({ error: "لازم تحدد الفترة (from/to أو year/month)" });
  const { from, to } = range;
  const branchId = req.query.branchId ? Number(req.query.branchId) : null;
  const round2 = (n) => Math.round(n * 100) / 100;

  try {
    const legacyByBranch = await computeRevenueAndCogsByBranch(from, to);
    const legacyScoped = branchId ? legacyByBranch.filter((r) => r.branchId === branchId) : legacyByBranch;
    const legacyRevenue = legacyScoped.reduce((s, r) => s + r.revenue, 0);
    const legacyCogs = legacyScoped.reduce((s, r) => s + r.cogs, 0);

    const pl = foldProfitAndLoss(await fetchPostedLines({ from, to, branchId }));

    const cashSessionsRes = await pool.query(
      `SELECT COALESCE(SUM(cash_sales),0) AS cash_sales
       FROM daily_cash_sessions
       WHERE business_date BETWEEN $1 AND $2 AND ($3::int IS NULL OR branch_id = $3)`,
      [from, to, branchId]
    );
    const ledgerCashFromSalesRes = await pool.query(
      `SELECT COALESCE(SUM(jel.debit),0) AS cash_from_sales
       FROM journal_entry_lines jel
       JOIN journal_entries je ON je.id = jel.journal_entry_id
       JOIN accounts a ON a.id = jel.account_id AND (a.code = '1100' OR a.code LIKE '1100-%')
       WHERE je.status <> 'DRAFT' AND je.source_type = 'order_sale'
         AND je.entry_date BETWEEN $1 AND $2 AND ($3::int IS NULL OR je.branch_id = $3)`,
      [from, to, branchId]
    );

    const physicalInventoryRes = await pool.query(
      `SELECT COALESCE(SUM(bis.quantity * COALESCE(ii.unit_cost,0)),0) AS value
       FROM branch_inventory_stock bis JOIN inventory_items ii ON ii.id = bis.inventory_item_id
       WHERE bis.quantity <> 0 AND ($1::int IS NULL OR bis.branch_id = $1)`,
      [branchId]
    );
    const ledgerInventoryRes = await pool.query(
      `WITH filtered_lines AS (
         SELECT jel.debit, jel.credit FROM journal_entry_lines jel
         JOIN journal_entries je ON je.id = jel.journal_entry_id
         JOIN accounts a ON a.id = jel.account_id AND a.code = '1400'
         WHERE je.status <> 'DRAFT' AND je.entry_date <= $1 AND ($2::int IS NULL OR jel.branch_id = $2)
       )
       SELECT COALESCE(SUM(debit),0) - COALESCE(SUM(credit),0) AS balance FROM filtered_lines`,
      [to, branchId]
    );

    const grnRes = await pool.query(
      `SELECT COALESCE(SUM(jel.debit),0) AS grn_inventory_value
       FROM journal_entry_lines jel JOIN journal_entries je ON je.id = jel.journal_entry_id
       JOIN accounts a ON a.id = jel.account_id AND a.code = '1400'
       WHERE je.status <> 'DRAFT' AND je.source_type = 'goods_receipt'
         AND je.entry_date BETWEEN $1 AND $2 AND ($3::int IS NULL OR je.branch_id = $3)`,
      [from, to, branchId]
    );
    const apCreditFromGrnRes = await pool.query(
      `SELECT COALESCE(SUM(jel.credit),0) AS ap_credit
       FROM journal_entry_lines jel JOIN journal_entries je ON je.id = jel.journal_entry_id
       WHERE jel.reference_type = 'supplier' AND je.status <> 'DRAFT' AND je.source_type = 'goods_receipt'
         AND je.entry_date BETWEEN $1 AND $2 AND ($3::int IS NULL OR je.branch_id = $3)`,
      [from, to, branchId]
    );

    const supplierPaymentsRes = await pool.query(
      `SELECT COALESCE(SUM(amount),0) AS total FROM supplier_payments
       WHERE payment_date BETWEEN $1 AND $2 AND ($3::int IS NULL OR branch_id = $3)`,
      [from, to, branchId]
    );
    const apDebitFromPaymentsRes = await pool.query(
      `SELECT COALESCE(SUM(jel.debit),0) AS ap_debit
       FROM journal_entry_lines jel JOIN journal_entries je ON je.id = jel.journal_entry_id
       WHERE jel.reference_type = 'supplier' AND je.status <> 'DRAFT' AND je.source_type = 'supplier_payment'
         AND je.entry_date BETWEEN $1 AND $2 AND ($3::int IS NULL OR je.branch_id = $3)`,
      [from, to, branchId]
    );

    // المرحلة 7H: الضريبة المحصّلة تشغيليًا (orders.vat_amount) مقابل صافي حساب 2300 من نفس قيود البيع -
    // نفس فلسفة فحص الكاش فوق بالظبط (مقارنة جدول تشغيلي بأثره في دفتر الأستاذ). لازم يشمل قيود العكس
    // (source_type='reversal') كمان مش order_sale بس - طلب اتلغى (voided) بيتستبعد من الجانب التشغيلي
    // (status<>'cancelled') فوق، فلازم قيد عكسه يتحسب في الجانب الدفتري برضه عشان الاتنين يفضلوا متطابقين
    // (لو اقتصرنا على order_sale بس، القيد الأصلي (لسه موجود بعلامة REVERSED) هيفضل محسوب من غير ما ينلغي)
    const operationalVatRes = await pool.query(
      `SELECT COALESCE(SUM(o.vat_amount),0) AS vat_collected
       FROM orders o
       WHERE o.status <> 'cancelled' AND o.created_at::date BETWEEN $1 AND $2
         AND ($3::int IS NULL OR o.branch_id = $3)`,
      [from, to, branchId]
    );
    const ledgerVatRes = await pool.query(
      `SELECT COALESCE(SUM(jel.credit) - SUM(jel.debit),0) AS vat_collected
       FROM journal_entry_lines jel
       JOIN journal_entries je ON je.id = jel.journal_entry_id
       JOIN accounts a ON a.id = jel.account_id AND a.code = '2300'
       WHERE je.status <> 'DRAFT' AND je.source_type IN ('order_sale', 'reversal')
         AND je.entry_date BETWEEN $1 AND $2 AND ($3::int IS NULL OR je.branch_id = $3)`,
      [from, to, branchId]
    );

    const checks = [
      {
        name: "المبيعات (الإيراد): التقرير التشغيلي income-statement مقابل صافي المبيعات في دفتر الأستاذ",
        operational: round2(legacyRevenue), ledger: round2(pl.netSales), diff: round2(legacyRevenue - pl.netSales),
      },
      {
        name: "تكلفة البضاعة المباعة: التقرير التشغيلي income-statement مقابل دفتر الأستاذ",
        operational: round2(legacyCogs), ledger: round2(pl.cogs), diff: round2(legacyCogs - pl.cogs),
      },
      {
        name: "ضريبة القيمة المضافة: إجمالي orders.vat_amount مقابل رصيد حساب 2300 (ضرائب مستحقة) الدائن من قيود البيع",
        operational: round2(Number(operationalVatRes.rows[0].vat_collected)),
        ledger: round2(Number(ledgerVatRes.rows[0].vat_collected)),
        diff: round2(Number(operationalVatRes.rows[0].vat_collected) - Number(ledgerVatRes.rows[0].vat_collected)),
      },
      {
        name: "الكاش: مبيعات الكاش في جلسات الكاش اليومية مقابل مدين حسابات الكاش من قيود البيع في دفتر الأستاذ",
        operational: round2(Number(cashSessionsRes.rows[0].cash_sales)),
        ledger: round2(Number(ledgerCashFromSalesRes.rows[0].cash_from_sales)),
        diff: round2(Number(cashSessionsRes.rows[0].cash_sales) - Number(ledgerCashFromSalesRes.rows[0].cash_from_sales)),
      },
      {
        name: "المخزون: القيمة الفعلية الحالية (الكمية × آخر تكلفة) مقابل رصيد حساب المخزون 1400 (فرق متوقع لو اتغيرت تكلفة صنف بعد حركات سابقة - للمراجعة فقط)",
        operational: round2(Number(physicalInventoryRes.rows[0].value)),
        ledger: round2(Number(ledgerInventoryRes.rows[0].balance)),
        diff: round2(Number(physicalInventoryRes.rows[0].value) - Number(ledgerInventoryRes.rows[0].balance)),
      },
      {
        name: "استلام البضاعة (GRN): قيمة المخزون الداخلة مقابل رصيد الموردين الدائن من نفس سندات الاستلام",
        operational: round2(Number(grnRes.rows[0].grn_inventory_value)),
        ledger: round2(Number(apCreditFromGrnRes.rows[0].ap_credit)),
        diff: round2(Number(grnRes.rows[0].grn_inventory_value) - Number(apCreditFromGrnRes.rows[0].ap_credit)),
      },
      {
        name: "سداد الموردين: جدول supplier_payments مقابل مدين حساب الموردين في دفتر الأستاذ",
        operational: round2(Number(supplierPaymentsRes.rows[0].total)),
        ledger: round2(Number(apDebitFromPaymentsRes.rows[0].ap_debit)),
        diff: round2(Number(supplierPaymentsRes.rows[0].total) - Number(apDebitFromPaymentsRes.rows[0].ap_debit)),
      },
    ].map((c) => ({ ...c, matched: Math.abs(c.diff) < 0.01 }));

    res.json({ from, to, branchId, checks, allMatched: checks.every((c) => c.matched) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// Procurement v2 STEP K: تقارير جديدة فوق الميزات المبنية في STEP D-J - نفس نمط resolveDateRange/
// canSeeReports/branch scoping المستخدم في كل تقرير سابق في الملف ده بالظبط
// ============================================================

// GET /api/reports/requisition-fulfillment?from=&to=&branchId= - أداء تنفيذ طلبيات الفروع (دورة الحياة
// الجديدة من STEP D/F بس - الطلبيات القديمة pending/fulfilled مالهاش fulfillment_status فمستبعدة هنا)
router.get("/requisition-fulfillment", requireAuth, canSeeReports, async (req, res) => {
  const range = resolveDateRange(req.query);
  if (!range) return res.status(400).json({ error: "لازم تحدد from/to أو year/month" });
  let branchId = req.query.branchId ? Number(req.query.branchId) : null;
  if (req.user.role === "branch_manager") branchId = req.user.branchId;

  try {
    const ordersRes = await pool.query(
      `SELECT ko.id, ko.branch_id, b.name AS branch_name, ko.status, ko.business_date, ko.required_date,
              ko.is_auto_suggested, ko.submitted_at, ko.approved_at, ko.received_at
       FROM kitchen_orders ko JOIN branches b ON b.id = ko.branch_id
       WHERE ko.status IN ('DRAFT','SUBMITTED','APPROVED','REJECTED','PREPARING','READY','DISPATCHED','IN_TRANSIT','RECEIVED')
         AND ko.business_date BETWEEN $1 AND $2
         AND ($3::int IS NULL OR ko.branch_id = $3)
       ORDER BY ko.business_date DESC, ko.id DESC`,
      [range.from, range.to, branchId]
    );
    const orderIds = ordersRes.rows.map((o) => o.id);
    const itemStatsRes = orderIds.length
      ? await pool.query(
          `SELECT kitchen_order_id, fulfillment_status, COUNT(*)::int AS n,
                  COALESCE(SUM(quantity_requested),0) AS requested, COALESCE(SUM(quantity_to_prepare),0) AS to_prepare
           FROM kitchen_order_items WHERE kitchen_order_id = ANY($1) GROUP BY kitchen_order_id, fulfillment_status`,
          [orderIds]
        )
      : { rows: [] };

    const statsByOrder = new Map();
    for (const row of itemStatsRes.rows) {
      if (!statsByOrder.has(row.kitchen_order_id)) statsByOrder.set(row.kitchen_order_id, {});
      statsByOrder.get(row.kitchen_order_id)[row.fulfillment_status] = {
        count: row.n, requested: Number(row.requested), toPrepare: Number(row.to_prepare),
      };
    }
    const orders = ordersRes.rows.map((o) => ({ ...o, itemFulfillment: statsByOrder.get(o.id) || {} }));

    const summary = { FULL: 0, PARTIAL: 0, UNFULFILLED: 0, PENDING: 0 };
    for (const stats of statsByOrder.values()) {
      for (const key of Object.keys(summary)) summary[key] += stats[key]?.count || 0;
    }

    res.json({ from: range.from, to: range.to, branchId, summary, orders });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/reports/transfer-discrepancies?from=&to=&branchId= - فروقات استلام التحويلات (STEP G) مجمّعة
// بنوعها وحالتها، مع إجمالي قيمة التصحيح المرحّلة فعليًا (5300) - مش تقدير، من القيود الحقيقية
router.get("/transfer-discrepancies", requireAuth, canSeeReports, async (req, res) => {
  const range = resolveDateRange(req.query);
  if (!range) return res.status(400).json({ error: "لازم تحدد from/to أو year/month" });
  let branchId = req.query.branchId ? Number(req.query.branchId) : null;
  if (req.user.role === "branch_manager") branchId = req.user.branchId;

  try {
    const byTypeRes = await pool.query(
      `SELECT td.discrepancy_type, td.status, COUNT(*)::int AS n, COALESCE(SUM(td.quantity),0) AS total_quantity
       FROM transfer_discrepancies td
       JOIN kitchen_transfers kt ON kt.id = td.kitchen_transfer_id
       WHERE td.reported_at::date BETWEEN $1 AND $2 AND ($3::int IS NULL OR kt.to_branch_id = $3)
       GROUP BY td.discrepancy_type, td.status ORDER BY td.discrepancy_type, td.status`,
      [range.from, range.to, branchId]
    );
    const valueRes = await pool.query(
      `SELECT COALESCE(SUM(jel.debit), 0) AS total_write_off_value
       FROM transfer_discrepancies td
       JOIN kitchen_transfers kt ON kt.id = td.kitchen_transfer_id
       JOIN journal_entries je ON je.id = td.adjustment_journal_entry_id AND je.status = 'POSTED'
       JOIN journal_entry_lines jel ON jel.journal_entry_id = je.id
       JOIN accounts a ON a.id = jel.account_id AND a.code = '5300'
       WHERE td.reported_at::date BETWEEN $1 AND $2 AND ($3::int IS NULL OR kt.to_branch_id = $3)`,
      [range.from, range.to, branchId]
    );
    res.json({
      from: range.from, to: range.to, branchId,
      byTypeAndStatus: byTypeRes.rows.map((r) => ({ ...r, total_quantity: Number(r.total_quantity) })),
      totalWriteOffValue: Number(valueRes.rows[0].total_write_off_value),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/reports/manufacturing-variance?from=&to=&branchId= - فرق الإنتاج (Yield Variance، ناتج مقابل
// مخطط) وفرق الاستهلاك الفعلي (STEP H) لكل أمر تصنيع مكتمل في المدى - ظاهر بالكامل، مفيش إخفاء تلقائي
router.get("/manufacturing-variance", requireAuth, canSeeReports, requirePermission("production.view"), async (req, res) => {
  const range = resolveDateRange(req.query);
  if (!range) return res.status(400).json({ error: "لازم تحدد from/to أو year/month" });
  let branchId = req.query.branchId ? Number(req.query.branchId) : null;
  if (req.user.role === "branch_manager") branchId = req.user.branchId;

  try {
    const ordersRes = await pool.query(
      `SELECT po.id, po.branch_id, b.name AS branch_name, po.production_date, po.planned_quantity, po.actual_quantity,
              po.variance_reason, po.parent_production_order_id,
              CASE WHEN po.planned_quantity > 0 THEN ((po.actual_quantity - po.planned_quantity) / po.planned_quantity) * 100 ELSE NULL END AS output_variance_percent
       FROM production_orders po JOIN branches b ON b.id = po.branch_id
       WHERE po.status = 'COMPLETED' AND po.production_date BETWEEN $1 AND $2
         AND ($3::int IS NULL OR po.branch_id = $3)
       ORDER BY po.production_date DESC, po.id DESC`,
      [range.from, range.to, branchId]
    );
    const orderIds = ordersRes.rows.map((o) => o.id);
    const inputVarianceRes = orderIds.length
      ? await pool.query(
          `SELECT production_order_id, COALESCE(SUM(planned_quantity),0) AS planned, COALESCE(SUM(quantity),0) AS actual,
                  COALESCE(SUM(variance_quantity),0) AS variance
           FROM production_order_batches WHERE production_order_id = ANY($1) AND role = 'input'
           GROUP BY production_order_id`,
          [orderIds]
        )
      : { rows: [] };
    const inputVarianceByOrder = new Map(inputVarianceRes.rows.map((r) => [r.production_order_id, {
      planned: Number(r.planned), actual: Number(r.actual), variance: Number(r.variance),
    }]));

    const orders = ordersRes.rows.map((o) => ({
      ...o,
      output_variance_percent: o.output_variance_percent != null ? Number(o.output_variance_percent) : null,
      inputVariance: inputVarianceByOrder.get(o.id) || { planned: 0, actual: 0, variance: 0 },
    }));

    res.json({ from: range.from, to: range.to, branchId, orders });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/reports/supplier-invoice-variance?from=&to=&supplierId= - فواتير الموردين وفروقها عن قيمة
// الاستلام المرحّلة (STEP B) - مين المورد اللي فروقه بيتكرر، إجمالي الفرق (موجب/سالب) في المدى
router.get("/supplier-invoice-variance", requireAuth, canSeeReports, requirePermission("purchasing.view"), async (req, res) => {
  const range = resolveDateRange(req.query);
  if (!range) return res.status(400).json({ error: "لازم تحدد from/to أو year/month" });
  const supplierId = req.query.supplierId ? Number(req.query.supplierId) : null;

  try {
    const invoicesRes = await pool.query(
      `SELECT si.id, si.supplier_id, s.name AS supplier_name, si.branch_id, b.name AS branch_name,
              si.supplier_invoice_number, si.invoice_date, si.subtotal, si.total, si.matched_total,
              si.variance_amount, si.status
       FROM supplier_invoices si
       JOIN suppliers s ON s.id = si.supplier_id
       JOIN branches b ON b.id = si.branch_id
       WHERE si.invoice_date BETWEEN $1 AND $2 AND si.status <> 'CANCELLED'
         AND ($3::int IS NULL OR si.supplier_id = $3)
       ORDER BY si.invoice_date DESC, si.id DESC`,
      [range.from, range.to, supplierId]
    );
    const bySupplierRes = await pool.query(
      `SELECT si.supplier_id, s.name AS supplier_name, COUNT(*)::int AS invoice_count,
              COALESCE(SUM(si.total),0) AS total_invoiced, COALESCE(SUM(si.variance_amount),0) AS total_variance
       FROM supplier_invoices si JOIN suppliers s ON s.id = si.supplier_id
       WHERE si.invoice_date BETWEEN $1 AND $2 AND si.status <> 'CANCELLED'
         AND ($3::int IS NULL OR si.supplier_id = $3)
       GROUP BY si.supplier_id, s.name ORDER BY total_variance DESC`,
      [range.from, range.to, supplierId]
    );
    res.json({
      from: range.from, to: range.to, supplierId,
      invoices: invoicesRes.rows.map((r) => ({
        ...r, subtotal: Number(r.subtotal), total: Number(r.total), matched_total: Number(r.matched_total), variance_amount: Number(r.variance_amount),
      })),
      bySupplier: bySupplierRes.rows.map((r) => ({
        ...r, total_invoiced: Number(r.total_invoiced), total_variance: Number(r.total_variance),
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// MASTER MISSION - PART 12: تقارير تخطيط التصنيع والعمليات - كل تقرير هنا بيعيد استخدام نفس المصادر
// الموجودة فعليًا (production_orders/kitchen_orders/inventory_movements/db/production-planning.js) -
// مفيش حساب أعمال جديد أو مصدر بيانات موازي لأي رقم موجود بالفعل
// ============================================================

// GET /api/reports/daily-production?from=&to=&branchId= - مخطط/منتج فعلي/فرق لكل يوم إنتاج - من
// production_orders المكتملة مباشرة (نفس الحقول المستخدمة في تقرير production-variance الموجود، مجمّعة
// يوميًا هنا بدل عرض كل أمر لوحده)
router.get("/daily-production", requireAuth, canSeeReports, requirePermission("production_planning.view", "production.view"), async (req, res) => {
  const range = resolveDateRange(req.query);
  if (!range) return res.status(400).json({ error: "لازم تحدد from/to أو year/month" });
  let branchId = req.query.branchId ? Number(req.query.branchId) : null;
  if (req.user.role === "branch_manager") branchId = req.user.branchId;
  try {
    const result = await pool.query(
      `SELECT po.production_date,
              COALESCE(SUM(po.planned_quantity), 0) AS planned,
              COALESCE(SUM(po.actual_quantity), 0) AS produced,
              COALESCE(SUM(po.actual_quantity - po.planned_quantity), 0) AS variance,
              COUNT(*)::int AS orders_count
       FROM production_orders po
       WHERE po.status = 'COMPLETED' AND po.production_date BETWEEN $1 AND $2
         AND ($3::int IS NULL OR po.branch_id = $3)
       GROUP BY po.production_date ORDER BY po.production_date`,
      [range.from, range.to, branchId]
    );
    res.json(result.rows.map((r) => ({
      productionDate: r.production_date, planned: Number(r.planned), produced: Number(r.produced),
      variance: Number(r.variance), ordersCount: r.orders_count,
    })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/reports/production-requirement?ckBranchId=&fromDate=&toDate= - نفس شكل خطة التصنيع
// (db/production-planning.js) لكن كتقرير قابل للطباعة/التصدير من مركز التقارير - مفيش حساب مستقل
router.get("/production-requirement", requireAuth, canSeeReports, requirePermission("production_planning.view", "production.view"), async (req, res) => {
  const ckBranchId = Number(req.query.ckBranchId);
  const fromDate = req.query.fromDate, toDate = req.query.toDate || fromDate;
  if (!ckBranchId || !fromDate) return res.status(400).json({ error: "لازم تحدد ckBranchId و fromDate", code: "INVALID_PARAMETER" });
  if (req.user.role === "branch_manager" && req.user.branchId !== ckBranchId) {
    return res.status(403).json({ error: "معندكش صلاحية تشوف خطة فرع تاني", code: "FORBIDDEN_BRANCH" });
  }
  try {
    const plan = await computeProductionPlan(pool, { ckBranchId, fromDate, toDate });
    res.json({ ckBranchId, fromDate, toDate, plan });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/reports/raw-material-requirement?ckBranchId=&fromDate=&toDate= - احتياج الخام المجمّع لكل
// الأصناف المطلوب تصنيعها في النافذة - بيستخدم محرك الوصفات عن طريق computeRawMaterialRequirement
// الموجودة فعليًا، مفيش تفجير وصفة مستقل هنا
router.get("/raw-material-requirement", requireAuth, canSeeReports, requirePermission("production_planning.view", "production.view"), async (req, res) => {
  const ckBranchId = Number(req.query.ckBranchId);
  const fromDate = req.query.fromDate, toDate = req.query.toDate || fromDate;
  if (!ckBranchId || !fromDate) return res.status(400).json({ error: "لازم تحدد ckBranchId و fromDate", code: "INVALID_PARAMETER" });
  if (req.user.role === "branch_manager" && req.user.branchId !== ckBranchId) {
    return res.status(403).json({ error: "معندكش صلاحية تشوف خطة فرع تاني", code: "FORBIDDEN_BRANCH" });
  }
  try {
    const plan = await computeProductionPlan(pool, { ckBranchId, fromDate, toDate });
    const needRaw = plan.filter((p) => p.requiredProduction > 0 && p.recipeVersionId);
    const perItemRaw = await Promise.all(needRaw.map((p) =>
      computeRawMaterialRequirement(pool, { ckBranchId, inventoryItemId: p.inventoryItemId, quantity: p.requiredProduction, recipeVersionId: p.recipeVersionId })
        .then((r) => ({ producedItem: p.itemName, ...r }))
    ));
    // تجميع كل الخامات المطلوبة (لو نفس الخامة داخلة في أكتر من منتج، بتتجمع في صف واحد - مفيد
    // لأمر شراء واحد يغطي أكتر من أمر تصنيع)
    const totalsByRawItem = new Map();
    for (const entry of perItemRaw) {
      for (const r of entry.raw) {
        const existing = totalsByRawItem.get(r.inventoryItemId) || { inventoryItemId: r.inventoryItemId, itemName: r.itemName, unit: r.unit, required: 0, available: r.available, shortage: 0 };
        existing.required += r.required;
        existing.shortage = Math.max(0, existing.required - existing.available);
        totalsByRawItem.set(r.inventoryItemId, existing);
      }
    }
    res.json({
      ckBranchId, fromDate, toDate,
      byProduct: perItemRaw,
      totals: [...totalsByRawItem.values()].sort((a, b) => b.shortage - a.shortage),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/reports/ck-stock-movement?branchId=&from=&to= - افتتاحي/مستلم/منتج/محوّل/هالك/ختامي لكل صنف -
// كله من inventory_movements مباشرة (quantity_before/quantity_after أول وآخر حركة في المدى = افتتاحي/
// ختامي حقيقيين من الليدجر نفسه، مش رقم مُقدَّر) - مفيش مصدر بيانات موازٍ
router.get("/ck-stock-movement", requireAuth, canSeeReports, async (req, res) => {
  const range = resolveDateRange(req.query);
  if (!range) return res.status(400).json({ error: "لازم تحدد from/to أو year/month" });
  let branchId = req.query.branchId ? Number(req.query.branchId) : null;
  if (req.user.role === "branch_manager") branchId = req.user.branchId;
  if (!branchId) return res.status(400).json({ error: "لازم تحدد branchId" });
  try {
    const result = await pool.query(
      `SELECT im.inventory_item_id, ii.name AS item_name, ii.unit,
              (ARRAY_AGG(im.quantity_before ORDER BY im.created_at ASC, im.id ASC))[1] AS opening,
              (ARRAY_AGG(im.quantity_after ORDER BY im.created_at DESC, im.id DESC))[1] AS closing,
              COALESCE(SUM(im.quantity) FILTER (WHERE im.movement_type IN ('PURCHASE_RECEIPT', 'TRANSFER_IN')), 0) AS received,
              COALESCE(SUM(im.quantity) FILTER (WHERE im.movement_type = 'PRODUCTION_IN'), 0) AS produced,
              COALESCE(-SUM(im.quantity) FILTER (WHERE im.movement_type IN ('TRANSFER_OUT', 'PRODUCTION_OUT')), 0) AS consumed_or_transferred_out,
              COALESCE(-SUM(im.quantity) FILTER (WHERE im.movement_type IN ('WASTE', 'EXPIRY')), 0) AS waste,
              COALESCE(SUM(im.quantity) FILTER (WHERE im.movement_type NOT IN ('PURCHASE_RECEIPT', 'TRANSFER_IN', 'PRODUCTION_IN', 'TRANSFER_OUT', 'PRODUCTION_OUT', 'WASTE', 'EXPIRY')), 0) AS other_adjustment
       FROM inventory_movements im JOIN inventory_items ii ON ii.id = im.inventory_item_id
       WHERE im.branch_id = $1 AND im.business_date BETWEEN $2 AND $3
       GROUP BY im.inventory_item_id, ii.name, ii.unit ORDER BY ii.name`,
      [branchId, range.from, range.to]
    );
    res.json(result.rows.map((r) => ({
      inventoryItemId: r.inventory_item_id, itemName: r.item_name, unit: r.unit,
      opening: Number(r.opening), closing: Number(r.closing), received: Number(r.received),
      produced: Number(r.produced), transferredOut: Number(r.consumed_or_transferred_out),
      waste: Number(r.waste), otherAdjustment: Number(r.other_adjustment),
    })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/reports/branch-demand?from=&to=&branchId= - طلب كل فرع يوم بيوم - من kitchen_orders/
// kitchen_order_items مباشرة (نفس مصدر UI-1 بالظبط)، الشورتدج = المطلوب - المُرسَل فعليًا (quantity_dispatched)
router.get("/branch-demand", requireAuth, canSeeReports, async (req, res) => {
  const range = resolveDateRange(req.query);
  if (!range) return res.status(400).json({ error: "لازم تحدد from/to أو year/month" });
  // مدير فرع عادي (مش سنتر كيتشن) بيشوف طلب فرعه هو بس (نفس منطق isCentralKitchenActor في
  // routes/kitchen-orders.js) - مدير السنتر كيتشن بطبيعة دوره لازم يشوف طلب كل الفروع المتجهة له
  let branchId = req.query.branchId ? Number(req.query.branchId) : null;
  if (req.user.role === "branch_manager" && !req.user.isCentralKitchen) branchId = req.user.branchId;
  try {
    const result = await pool.query(
      `SELECT ko.branch_id, b.name AS branch_name, COALESCE(ko.required_date, ko.business_date) AS demand_date,
              koi.inventory_item_id, ii.name AS item_name, ii.unit, ko.status,
              koi.quantity_requested, koi.quantity_to_prepare, koi.quantity_dispatched
       FROM kitchen_order_items koi
       JOIN kitchen_orders ko ON ko.id = koi.kitchen_order_id
       JOIN branches b ON b.id = ko.branch_id
       JOIN inventory_items ii ON ii.id = koi.inventory_item_id
       WHERE COALESCE(ko.required_date, ko.business_date) BETWEEN $1 AND $2
         AND ($3::int IS NULL OR ko.branch_id = $3)
       ORDER BY demand_date DESC, b.name, ii.name`,
      [range.from, range.to, branchId]
    );
    res.json(result.rows.map((r) => {
      const dispatched = r.quantity_dispatched != null ? Number(r.quantity_dispatched) : 0;
      return {
        branchId: r.branch_id, branchName: r.branch_name, demandDate: r.demand_date,
        inventoryItemId: r.inventory_item_id, itemName: r.item_name, unit: r.unit, status: r.status,
        requested: Number(r.quantity_requested),
        approved: ["APPROVED", "PREPARING", "READY", "DISPATCHED", "IN_TRANSIT", "RECEIVED"].includes(r.status) ? Number(r.quantity_requested) : 0,
        fulfilled: dispatched,
        shortage: Math.max(0, Number(r.quantity_requested) - dispatched),
      };
    }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/reports/transfer-fulfillment?from=&to=&branchId= - المطلوب→المجهّز→المُصدَّر→المُستلَم→الفرق -
// من kitchen_orders (الطلب/التجهيز) + kitchen_transfers/kitchen_transfer_items (الإصدار/الاستلام الفعلي) +
// transfer_discrepancies (أي فرق اتسجل بعدين) - كلهم جداول موجودة، مفيش تجميع مواز
router.get("/transfer-fulfillment", requireAuth, canSeeReports, async (req, res) => {
  const range = resolveDateRange(req.query);
  if (!range) return res.status(400).json({ error: "لازم تحدد from/to أو year/month" });
  // نفس منطق branch-demand فوق بالظبط - مدير السنتر كيتشن لازم يشوف تحقيق كل الفروع، مش فرعه بس
  let branchId = req.query.branchId ? Number(req.query.branchId) : null;
  if (req.user.role === "branch_manager" && !req.user.isCentralKitchen) branchId = req.user.branchId;
  try {
    const result = await pool.query(
      `SELECT ko.id AS kitchen_order_id, ko.branch_id, b.name AS branch_name,
              COALESCE(ko.required_date, ko.business_date) AS demand_date, ko.status,
              koi.inventory_item_id, ii.name AS item_name, ii.unit,
              koi.quantity_requested, koi.quantity_to_prepare, koi.quantity_dispatched,
              COALESCE(recv.received_quantity, 0) AS received_quantity,
              COALESCE(disc.discrepancy_quantity, 0) AS discrepancy_quantity
       FROM kitchen_order_items koi
       JOIN kitchen_orders ko ON ko.id = koi.kitchen_order_id
       JOIN branches b ON b.id = ko.branch_id
       JOIN inventory_items ii ON ii.id = koi.inventory_item_id
       LEFT JOIN LATERAL (
         SELECT SUM(kti.quantity_received) AS received_quantity
         FROM kitchen_transfer_items kti JOIN kitchen_transfers kt ON kt.id = kti.kitchen_transfer_id
         WHERE kt.kitchen_order_id = ko.id AND kti.inventory_item_id = koi.inventory_item_id
       ) recv ON TRUE
       LEFT JOIN LATERAL (
         SELECT SUM(td.quantity) AS discrepancy_quantity
         FROM transfer_discrepancies td JOIN kitchen_transfers kt ON kt.id = td.kitchen_transfer_id
         WHERE kt.kitchen_order_id = ko.id AND td.inventory_item_id = koi.inventory_item_id AND td.status <> 'REJECTED'
       ) disc ON TRUE
       WHERE COALESCE(ko.required_date, ko.business_date) BETWEEN $1 AND $2
         AND ($3::int IS NULL OR ko.branch_id = $3)
       ORDER BY demand_date DESC, b.name, ii.name`,
      [range.from, range.to, branchId]
    );
    res.json(result.rows.map((r) => ({
      kitchenOrderId: r.kitchen_order_id, branchId: r.branch_id, branchName: r.branch_name,
      demandDate: r.demand_date, status: r.status, inventoryItemId: r.inventory_item_id, itemName: r.item_name, unit: r.unit,
      requested: Number(r.quantity_requested),
      prepared: r.quantity_to_prepare != null ? Number(r.quantity_to_prepare) : null,
      dispatched: r.quantity_dispatched != null ? Number(r.quantity_dispatched) : null,
      received: Number(r.received_quantity),
      discrepancy: Number(r.discrepancy_quantity),
    })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
