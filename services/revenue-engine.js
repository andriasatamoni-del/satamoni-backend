// حساب الإيرادات وتكلفة البضاعة المباعة لكل فرع في مدى تاريخ معين (from/to)، من بيانات الطلبات الفعلية
// (مش من قيود يدوية) - العروض/الكومبو بتتفكّ لأصنافها الأصلية لحساب تكلفتها الحقيقية.
// اتنقلت من routes/reports.js لملف مشترك (نفس نمط computePayrollCostByBranch في services/payroll-engine.js)
// عشان أي حاجة تانية محتاجة "الإيراد الفعلي" (زي مقارنة تكلفة الرواتب بالمبيعات في routes/payroll.js)
// تستخدم نفس المصدر بالظبط بدل ما تعيد نفس المنطق وتختلف عنه بعد كده.
async function computeRevenueAndCogsByBranch(pool, from, to) {
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

module.exports = { computeRevenueAndCogsByBranch };
