// مركز التنبيهات (Action Center) - نقطة واحدة تجمّع كل "استثناء يستاهل انتباه فوري" اللي النظام أصلًا
// بيحسبه في أماكن مختلفة (مخزون سالب، استثناءات المدفوعات، فرق تصنيع من غير سبب موثّق، مصروف متجاوز
// حد التنبيه بتاعه، فرق تكلفة طعام كبير) - من غير ما يعيد حساب أي منطق تجاري تاني: كل فحص هنا بينادي
// نفس المصدر اللي التقرير المستقل بتاعه بيستخدمه بالظبط (computeExceptions/computeConsumptionBreakdown)
// أو بيكرر نفس شرط WHERE المستخدم في التقرير المناظر تمامًا (زي negative-stock/expenses-report).
// الهدف: مدير الفرع/الأدمن يشوف "إيه اللي محتاج تدخّل فورًا" في مكان واحد، بدل ما يعرف إنه يفتح
// عشرات شاشات التقارير المستقلة كل يوم عشان يلاقي نفس المعلومة دي.
const { computeExceptions } = require("./payment-control-engine");
const { computeConsumptionBreakdown } = require("./food-cost-engine");
const { getCairoBusinessDate } = require("./business-date");

// مفيش عمود إعدادات مخصص لحد الآن لفرق تكلفة الطعام (عكس production_variance_alert_percent
// الموجود فعليًا في pos_settings) - رقم مقترح افتراضي زي فلسفة RISK_WEIGHTS في payment-control-engine.js
// بالظبط: "اقتراح جديد، قابل للمراجعة لاحقًا بناءً على بيانات فرع حقيقية"، مش قيمة مُسترجعة من مكان تاني
const FOOD_COST_VARIANCE_ALERT_PERCENT = 15;
const FOOD_COST_MIN_COST_EGP = 50; // تجاهل فروق صغيرة القيمة حتى لو نسبتها عالية (صنف رخيص باستهلاك ضئيل)

async function findNegativeStockAlerts(pool, { branchId }) {
  const result = await pool.query(
    `SELECT bis.branch_id, b.name AS branch_name, COUNT(*) AS item_count,
            array_agg(ii.name ORDER BY bis.quantity ASC) FILTER (WHERE true) AS sample_items
     FROM branch_inventory_stock bis
     JOIN branches b ON b.id = bis.branch_id
     JOIN inventory_items ii ON ii.id = bis.inventory_item_id
     WHERE bis.quantity < 0 AND ($1::int IS NULL OR bis.branch_id = $1)
     GROUP BY bis.branch_id, b.name`,
    [branchId || null]
  );
  return result.rows.map((r) => ({
    type: "NEGATIVE_STOCK", severity: "HIGH", branchId: r.branch_id, branchName: r.branch_name,
    description: `${r.item_count} صنف برصيد سالب في ${r.branch_name}`,
    detail: r.sample_items.slice(0, 5).join("، "),
    link: "/satamoni-inventory.html",
  }));
}

// فرق تصنيع تجاوز production_variance_alert_percent - ملحوظة مهمة: routes/production.js POST
// /:id/complete أصلًا بيرفض (400 VARIANCE_REASON_REQUIRED) إكمال أي أمر بفرق فوق الحد ده من غير سبب،
// يعني variance_reason IS NULL مستحيل عمليًا هنا (الكتابة نفسها ممنوعة). الفحص هنا مش "فرق من غير
// سبب" (ده مش موجود أصلًا) - هو "فرق كبير موثّق بسبب" يستاهل نظرة سريعة من الإدارة برضو (السبب مكتوب
// بس المدير لسه محتاج يشوفه، مش يفترض إنه مقبول تلقائيًا لمجرد وجوده)
async function findProductionVarianceAlerts(pool, { branchId, from, to }) {
  const settings = await pool.query("SELECT production_variance_alert_percent FROM pos_settings WHERE id = 1");
  const threshold = Number(settings.rows[0]?.production_variance_alert_percent ?? 10);
  const result = await pool.query(
    `SELECT po.id, po.branch_id, b.name AS branch_name, po.variance_reason,
            COALESCE(mi.name || ' - ' || v.label, ii.name) AS product_name,
            po.planned_quantity, po.actual_quantity,
            ROUND((po.actual_quantity - po.planned_quantity) / NULLIF(po.planned_quantity, 0) * 100, 2) AS variance_percent
     FROM production_orders po
     JOIN branches b ON b.id = po.branch_id
     JOIN recipes r ON r.id = po.recipe_id
     LEFT JOIN menu_item_variants v ON v.id = r.variant_id
     LEFT JOIN menu_items mi ON mi.id = v.item_id
     LEFT JOIN inventory_items ii ON ii.id = r.inventory_item_id
     WHERE po.status = 'COMPLETED' AND po.completed_at::date BETWEEN $1 AND $2
       AND po.planned_quantity > 0
       AND ABS(po.actual_quantity - po.planned_quantity) / po.planned_quantity * 100 > $3
       AND ($4::int IS NULL OR po.branch_id = $4)
     ORDER BY po.completed_at DESC`,
    [from, to, threshold, branchId || null]
  );
  return result.rows.map((r) => ({
    type: "PRODUCTION_VARIANCE_DOCUMENTED", severity: "LOW", branchId: r.branch_id, branchName: r.branch_name,
    description: `فرق تصنيع ${r.variance_percent}% في "${r.product_name}" (${r.branch_name}) - السبب المسجّل: ${r.variance_reason || "—"}`,
    detail: `مخطط ${Number(r.planned_quantity)} / فعلي ${Number(r.actual_quantity)}`,
    link: "/satamoni-manufacturing.html",
  }));
}

// نفس شرط WHERE المستخدم فعليًا في GET /api/reports/expenses-report (anomalies) بالظبط - مصروف
// تجاوز alert_threshold بتاع بنده
async function findExpenseAnomalies(pool, { branchId, from, to }) {
  const result = await pool.query(
    `SELECT e.id, e.branch_id, b.name AS branch_name, ec.name AS category, e.amount, ec.alert_threshold
     FROM expenses e
     JOIN expense_categories ec ON ec.id = e.category_id
     LEFT JOIN branches b ON b.id = e.branch_id
     WHERE e.business_date BETWEEN $1 AND $2 AND ($3::int IS NULL OR e.branch_id = $3)
       AND ec.alert_threshold IS NOT NULL AND e.amount > ec.alert_threshold
     ORDER BY e.amount DESC`,
    [from, to, branchId || null]
  );
  return result.rows.map((r) => ({
    type: "EXPENSE_OVER_THRESHOLD", severity: "MEDIUM", branchId: r.branch_id, branchName: r.branch_name || "—",
    description: `مصروف "${r.category}" بمبلغ ${Number(r.amount).toFixed(2)} ج.م تجاوز حد التنبيه (${Number(r.alert_threshold).toFixed(2)} ج.م)`,
    link: "/satamoni-accounting.html",
  }));
}

// أعلى أصناف بفرق تكلفة طعام كبير (نظري مقابل استهلاك فعلي) - نفس مصدر GET /api/reports/food-cost-variance
async function findFoodCostVarianceAlerts(pool, { branchId, from, to }) {
  const byItem = await computeConsumptionBreakdown(pool, { branchId, from, to });
  const flagged = [...byItem.entries()].filter(([, b]) => {
    if (b.theoretical.cost <= 0) return false;
    const percent = Math.abs(b.foodCostVariancePercent ?? 0);
    return percent > FOOD_COST_VARIANCE_ALERT_PERCENT && Math.abs(b.foodCostVariance) >= FOOD_COST_MIN_COST_EGP;
  });
  if (flagged.length === 0) return [];
  const itemIds = flagged.map(([itemId]) => itemId);
  const names = await pool.query("SELECT id, name FROM inventory_items WHERE id = ANY($1)", [itemIds]);
  const nameById = new Map(names.rows.map((r) => [r.id, r.name]));
  return flagged
    .sort((a, b) => Math.abs(b[1].foodCostVariance) - Math.abs(a[1].foodCostVariance))
    .slice(0, 10)
    .map(([itemId, b]) => ({
      type: "FOOD_COST_VARIANCE", severity: "MEDIUM", branchId: branchId || null,
      branchName: branchId ? null : "كل الفروع",
      description: `فرق تكلفة "${nameById.get(itemId) || itemId}": ${b.foodCostVariance.toFixed(2)} ج.م (${b.foodCostVariancePercent.toFixed(1)}%)`,
      link: "/satamoni-reports.html",
    }));
}

// أصناف من غير تكلفة وحدة (unit_cost) بس مستخدمة فعليًا في وصفة نشطة - أي حساب تكلفة تصنيع/طعام
// بيستخدم الصنف ده بيتعلّم عليه أصلًا بعلم "incomplete" (راجع db/food-cost-engine.js) بدل ما يفترض
// صفر، لكن محدش بيشوف إن في أصناف ناقصاها البيانات دي أصلًا من غير ما يفتح كل تقرير ويلاحظ الفجوة.
// بيانات الصنف الأساسي (تكلفة الوحدة) شركة-wide مش خاصة بفرع - نفس فلسفة inventory-comparison/
// branch-health بالظبط: مفيش معنى لعزل الفرع هنا، فالتنبيه ده بيظهر بس في عرض "كل الفروع" (أدمن/محاسب)
async function findItemsMissingCostAlerts(pool, { branchId }) {
  if (branchId) return [];
  const result = await pool.query(
    `SELECT DISTINCT ii.id, ii.name
     FROM inventory_items ii
     JOIN recipe_ingredients ri ON ri.ingredient_item_id = ii.id
     JOIN recipe_versions rv ON rv.id = ri.recipe_version_id AND rv.status = 'ACTIVE'
     WHERE ii.unit_cost IS NULL
     ORDER BY ii.name`
  );
  if (result.rows.length === 0) return [];
  return [{
    type: "ITEMS_MISSING_COST", severity: "HIGH", branchId: null, branchName: "كل الفروع",
    description: `${result.rows.length} صنف مستخدم في وصفات نشطة من غير تكلفة وحدة مسجّلة - بيأثر على دقة تكلفة الطعام لأي وصفة بتستخدمه`,
    detail: result.rows.slice(0, 8).map((r) => r.name).join("، "),
    link: "/satamoni-items.html",
  }];
}

const SEVERITY_ORDER = { HIGH: 0, MEDIUM: 1, LOW: 2 };

// المدى الافتراضي (لو مفيش from/to) آخر 7 أيام - المركز ده معمول يتفتح من غير إعدادات، مش تقرير
// تاريخي بيتطلب مدى محدد زي باقي reports.js (فلسفة مختلفة عمدًا: فحص يومي سريع، مش استعلام تحليلي)
function defaultRange() {
  const to = getCairoBusinessDate();
  const from = getCairoBusinessDate(new Date(Date.now() - 7 * 24 * 60 * 60 * 1000));
  return { from, to };
}

async function computeActionCenter(pool, { branchId = null, from, to } = {}) {
  const range = from && to ? { from, to } : defaultRange();
  const [negativeStock, paymentControl, productionVariance, expenseAnomalies, foodCostVariance, itemsMissingCost] = await Promise.all([
    findNegativeStockAlerts(pool, { branchId }),
    computeExceptions(pool, { branchId, from: range.from, to: range.to }),
    findProductionVarianceAlerts(pool, { branchId, from: range.from, to: range.to }),
    findExpenseAnomalies(pool, { branchId, from: range.from, to: range.to }),
    findFoodCostVarianceAlerts(pool, { branchId, from: range.from, to: range.to }),
    findItemsMissingCostAlerts(pool, { branchId }),
  ]);

  const paymentAlerts = paymentControl.exceptions.map((e) => ({
    type: `PAYMENT_${e.type}`, severity: e.points >= 40 ? "HIGH" : e.points >= 20 ? "MEDIUM" : "LOW",
    branchId: e.branchId ?? null, branchName: null, description: e.description,
    link: "/satamoni-payment-control.html",
  }));

  const alerts = [...negativeStock, ...paymentAlerts, ...productionVariance, ...expenseAnomalies, ...foodCostVariance, ...itemsMissingCost]
    .sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);

  return {
    from: range.from, to: range.to,
    alerts,
    countsBySeverity: {
      HIGH: alerts.filter((a) => a.severity === "HIGH").length,
      MEDIUM: alerts.filter((a) => a.severity === "MEDIUM").length,
      LOW: alerts.filter((a) => a.severity === "LOW").length,
    },
  };
}

module.exports = { computeActionCenter, FOOD_COST_VARIANCE_ALERT_PERCENT };
