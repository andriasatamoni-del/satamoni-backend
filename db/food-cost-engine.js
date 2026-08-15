// المرحلة 3.1: محرك تصنيف الاستهلاك وتكلفة الطعام - مصدر واحد لكل تقارير food-cost/consumption
// (routes/reports.js) عشان "النظري" و"الفعلي" وكل فئات الاستهلاك تتحسب بنفس المنطق بالظبط في كل مكان،
// مش كل endpoint بيعيد اختراعها لوحده.
//
// ============================================================
// تعريفات صريحة (كل الحسابات هنا بتلتزم بيها بالظبط):
// ============================================================
// A) Theoretical Food Cost  - التكلفة اللي "المفروض" تتصرف عشان تنتج المبيعات/التصنيع اللي حصل، محسوبة
//    بصيغة الوصفة (recipe formula) مسعّرة بسعر المكوّن **لحظة الحدث نفسه بالظبط** (مش سعر النهارده) -
//    مصدرها order_item_ingredient_costs للمبيعات (مجمّد وقت البيع، المرحلة 3.1) وPRODUCTION_OUT
//    للتصنيع (مجمّد وقت الاستهلاك، المرحلة 3) - أبدًا مش بتتحسب من جديد بسعر حالي.
// B) Sales Food Cost - القيمة الفعلية اللي طلعت من المخزون فعليًا بسبب البيع، من حركات SALE الحقيقية في
//    الليدجر (واعية بالدفعة - ممكن تختلف عن A لو الصنف اتصرف من دفعة سعرها مختلف عن unit_cost المرجعي).
// C) Waste Cost - من حركات WASTE/DAMAGE/EXPIRY الحقيقية.
// D) Adjustment Cost - من حركات ADJUSTMENT/STOCK_COUNT الحقيقية (تسويات الجرد).
// E) Total Inventory Usage Cost - B + Production Cost + C + D: كل قيمة مخزون طلعت فعليًا لأسباب تشغيلية
//    حقيقية (بيع/تصنيع/هالك/تسوية) - **مش شامل التحويلات ولا المرتجعات** لأنها نقل قيمة مش استهلاكها.
// F) Food Cost Variance - E − A: الفرق بين اللي طلع فعليًا واللي المفروض كان يطلع نظريًا.
// G) Food Cost Variance % - F ÷ A × 100.
//
// الفرق الجوهري اللي التقرير لازم يوضحه: A هي "قد إيه المفروض نتيجة الوصفة"، وE هي "قد إيه فعليًا
// اتفقد/اتصرف من قيمة المخزون" - الاتنين مختلفين مفاهيميًا حتى لو اتفقوا رقميًا في حالة مفيش هالك/تسوية.
const { explodeRecipeConsumption } = require("./recipe-engine");

// تصنيف كل نوع حركة معروف (القيم القياسية الجديدة + القديمة تاريخيًا للتوافق) لواحدة من فئات الاستهلاك
// الثمانية. أنواع مش موجودة هنا (PURCHASE_RECEIPT/purchase، OPENING_BALANCE، PRODUCTION_IN/production_in)
// مقصود إنها متستبعدش - دي زيادة في المخزون مش استهلاك منه.
const MOVEMENT_CATEGORY = {
  SALE: "sales", sale_deduction: "sales",
  PRODUCTION_OUT: "production", production_out: "production",
  WASTE: "waste", waste: "waste", DAMAGE: "waste", EXPIRY: "waste",
  ADJUSTMENT: "adjustment", adjustment: "adjustment", STOCK_COUNT: "adjustment",
  TRANSFER_OUT: "transferOut", transfer_out: "transferOut",
  TRANSFER_IN: "transferIn", transfer_in: "transferIn",
  SALE_REVERSAL: "returns", RETURN_TO_SUPPLIER: "returns", RETURN_FROM_BRANCH: "returns", PRODUCTION_REVERSAL: "returns",
};

// الفئات اللي بتدخل في "إجمالي الاستهلاك التشغيلي" (E) - التحويلات والمرتجعات مستبعدة عمدًا
const USAGE_CATEGORIES = ["sales", "production", "waste", "adjustment"];

function emptyBucket() {
  return {
    theoretical: { qty: 0, cost: 0, incomplete: false },
    sales: { qty: 0, cost: 0 },
    production: { qty: 0, cost: 0 },
    waste: { qty: 0, cost: 0 },
    adjustment: { qty: 0, cost: 0 },
    transferOut: { qty: 0, cost: 0 },
    transferIn: { qty: 0, cost: 0 },
    returns: { qty: 0, cost: 0 },
  };
}

function finalizeBucket(b) {
  const totalUsageQty = USAGE_CATEGORIES.reduce((s, c) => s + b[c].qty, 0);
  const totalUsageCost = USAGE_CATEGORIES.reduce((s, c) => s + b[c].cost, 0);
  b.totalUsage = { qty: totalUsageQty, cost: totalUsageCost };
  b.foodCostVariance = totalUsageCost - b.theoretical.cost;
  b.foodCostVariancePercent = b.theoretical.cost ? (b.foodCostVariance / b.theoretical.cost) * 100 : null;
  b.operationalVarianceQty = totalUsageQty - b.theoretical.qty;
  b.operationalVarianceQtyPercent = b.theoretical.qty ? (b.operationalVarianceQty / b.theoretical.qty) * 100 : null;
  return b;
}

// المصدر الأساسي: order_item_ingredient_costs (مجمّد وقت البيع بالظبط، المرحلة 3.1) - القراءة دي
// استعلام واحد بس (GROUP BY)، من غير أي استدعاء لمحرك الوصفات (zero N+1 للمسار الشائع)
async function accumulateFrozenSalesTheoretical(client, byItem, bucketOf, { branchId, from, to }) {
  const result = await client.query(
    `SELECT oic.ingredient_item_id, SUM(oic.quantity) AS qty, SUM(oic.total_cost) AS cost,
            BOOL_OR(oic.unit_cost IS NULL) AS incomplete
     FROM order_item_ingredient_costs oic
     JOIN order_items oi ON oi.id = oic.order_item_id
     JOIN orders o ON o.id = oi.order_id
     WHERE o.status <> 'cancelled' AND o.created_at::date BETWEEN $1 AND $2
       AND ($3::int IS NULL OR o.branch_id = $3)
     GROUP BY oic.ingredient_item_id`,
    [from, to, branchId]
  );
  for (const row of result.rows) {
    const b = bucketOf(row.ingredient_item_id);
    b.theoretical.qty += Number(row.qty);
    b.theoretical.cost += row.cost != null ? Number(row.cost) : 0;
    if (row.incomplete) b.theoretical.incomplete = true;
  }
}

// مسار احتياطي: سطور طلب عندها recipe_version_id بس مفيش لها صف مجمّد (بيانات اترحّلت بسكريبت التوافق
// db/backfill-phase3-recipes.js قبل ما آلية التجميد في المرحلة 3.1 تتعمل). الكمية النظرية آمن نعيد
// حسابها (نسخة الوصفة ثابتة للأبد، مفيش خطر تغيّر) - لكن **التكلفة ميتحسبش خالص بسعر النهارده الحالي**،
// بتفضل incomplete=true صراحة بدل ما نخمّن تكلفة تاريخية مش موجودة فعليًا. versionCache بيتشارك بين كل
// نداءات التقرير الواحد - نسخة وصفة واحدة بتتفكّ مرة واحدة بس مهما تكرر استخدامها في طلبات كتير (المرحلة
// 3.1، بند الأداء - كان قبل كده نداء لمحرك الوصفات لكل سطر طلب لوحده)
async function accumulateOrphanSalesTheoretical(client, byItem, bucketOf, { branchId, from, to }, versionCache) {
  const result = await client.query(
    `SELECT oi.id, oi.recipe_version_id, oi.quantity
     FROM order_items oi
     JOIN orders o ON o.id = oi.order_id
     WHERE o.status <> 'cancelled' AND o.created_at::date BETWEEN $1 AND $2
       AND ($3::int IS NULL OR o.branch_id = $3)
       AND oi.recipe_version_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM order_item_ingredient_costs oic WHERE oic.order_item_id = oi.id)`,
    [from, to, branchId]
  );
  for (const row of result.rows) {
    const { raw } = await explodeRecipeConsumption(client, row.recipe_version_id, Number(row.quantity), new Set(), versionCache);
    for (const [itemId, data] of raw) {
      const b = bucketOf(itemId);
      b.theoretical.qty += data.quantity;
      b.theoretical.incomplete = true; // تكلفة تاريخية مش متاحة للسطر ده - عمدًا من غير تقدير
    }
  }
}

// النقطة الأساسية: بيرجّع Map(inventoryItemId -> bucket) فيها كل فئات الاستهلاك (نظري/بيع/تصنيع/هالك/
// تسوية/تحويل صادر/تحويل وارد/مرتجعات) مع الكمية والتكلفة لكل واحدة، بالإضافة لـtotalUsage/foodCostVariance
// المحسوبين. استعلام واحد بس على inventory_movements (كل التصنيف بعد كده في الذاكرة) + استعلامين على
// order_item_ingredient_costs/order_items - مفيش استعلام متكرر لكل أوردر لوحده.
async function computeConsumptionBreakdown(client, { branchId, from, to }, versionCache = new Map()) {
  const byItem = new Map();
  const bucketOf = (itemId) => {
    if (!byItem.has(itemId)) byItem.set(itemId, emptyBucket());
    return byItem.get(itemId);
  };

  const movements = await client.query(
    `SELECT movement_type, inventory_item_id, quantity, total_cost
     FROM inventory_movements
     WHERE business_date BETWEEN $1 AND $2 AND ($3::int IS NULL OR branch_id = $3)`,
    [from, to, branchId]
  );
  for (const row of movements.rows) {
    const category = MOVEMENT_CATEGORY[row.movement_type];
    if (!category) continue;
    const b = bucketOf(row.inventory_item_id);
    const qty = Math.abs(Number(row.quantity));
    const cost = row.total_cost != null ? Number(row.total_cost) : 0;
    b[category].qty += qty;
    b[category].cost += cost;
    // التصنيع بياخد بالظبط الكمية النظرية من الوصفة (مفيش "أمين مخزن استخدم كمية مختلفة" في هذا النظام -
    // الاستهلاك بيحصل عند /start بنفس ناتج explodeRecipeConsumption(planned_quantity) بالظبط) - يعني
    // PRODUCTION_OUT الفعلية هي بالتعريف نفس التكلفة النظرية بتاعت التصنيع، مفيش داعي لإعادة حساب منفصلة
    if (category === "production") {
      b.theoretical.qty += qty;
      b.theoretical.cost += cost;
    }
  }

  await accumulateFrozenSalesTheoretical(client, byItem, bucketOf, { branchId, from, to });
  await accumulateOrphanSalesTheoretical(client, byItem, bucketOf, { branchId, from, to }, versionCache);

  for (const b of byItem.values()) finalizeBucket(b);
  return byItem;
}

// تجميع كل المكونات لرقم واحد إجمالي (للاستخدام في تقرير على مستوى الفرع/الفترة كامل، زي branch-food-cost)
function aggregateBreakdown(byItem) {
  const totals = emptyBucket();
  let incomplete = false;
  for (const b of byItem.values()) {
    for (const key of [...USAGE_CATEGORIES, "transferOut", "transferIn", "returns"]) {
      totals[key].qty += b[key].qty;
      totals[key].cost += b[key].cost;
    }
    totals.theoretical.qty += b.theoretical.qty;
    totals.theoretical.cost += b.theoretical.cost;
    if (b.theoretical.incomplete) incomplete = true;
  }
  totals.theoretical.incomplete = incomplete;
  finalizeBucket(totals);
  return totals;
}

module.exports = { computeConsumptionBreakdown, aggregateBreakdown, MOVEMENT_CATEGORY, USAGE_CATEGORIES };
