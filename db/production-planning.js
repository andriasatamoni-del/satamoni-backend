// MASTER MISSION — PART 1: تخطيط تصنيع السنتر كيتشن (Production Planning) - محرك قراءة (read-model) بحت،
// مفيش أي كتابة على المخزون أو المحاسبة هنا خالص. المصدر الوحيد لكل رقم هو الجداول/المحركات الموجودة
// فعليًا - مفيش خوارزمية طلب تانية:
//   - الطلب الفعلي المعتمد (approvedDemand): مجموع kitchen_order_items عبر كل الفروع لطلبيات بحالة
//     APPROVED/PREPARING/READY (التزام حقيقي من الفرع، مش تقدير) - نفس جدول db/requisition-suggestion.js
//     الأساسي (kitchen_orders/kitchen_order_items)، بس هنا بنجمع "المعتمد فعليًا من كل الفروع" بدل
//     "الاقتراح لفرع واحد". الاتنين مبنيين على نفس البيانات، لأغراض مختلفة تمامًا.
//   - الطلب المتوقع (forecastDemand): نفس db/requisition-suggestion.js.generateSuggestedRequisition بالظبط
//     (نفس الاستدعاء، من غير أي إعادة تنفيذ) - استرشادي بس، مش داخل في معادلة "المطلوب تصنيعه" لتفادي
//     التخطيط لطلب لسه معتمدش
//   - المتاح فعليًا في السنتر كيتشن (availableStock): branch_inventory_stock.quantity - ده أصلًا شامل أي
//     تصنيع/تعبئة اكتملت فعلًا (بيتحدّث تلقائي عن طريق db/inventory-ledger.js وقت الإكمال) - عمدًا مفيش
//     مصطلح منفصل لـ"الإنتاج المتاح فعلًا"، لأنه نفس الرقم ده بالظبط ولو اتحسب لوحده هيتخصم مرتين
//   - تحت التنفيذ/مخطط (plannedOrInProgress): مجموع production_orders.planned_quantity (الحالات
//     DRAFT/APPROVED/IN_PROGRESS) + packaging_orders.planned_output_quantity (نفس الحالات) لنفس الصنف -
//     ده اللي بيمنع اقتراح تصنيع مكرر لأمر أصلًا موجود ومخطط أو شغال
//   - المطلوب تصنيعه = max(0, المعتمد - المتاح - تحت التنفيذ) - نفس فلسفة target-availableCoverage
//     الموجودة في computeSuggestedQuantity، بس على مستوى تجميع كل الفروع بدل فرع واحد
const { generateSuggestedRequisition } = require("./requisition-suggestion");
const { explodeRecipeConsumption } = require("./recipe-engine");

const COMMITTED_DEMAND_STATUSES = ["APPROVED", "PREPARING", "READY"];
const ACTIVE_PRODUCTION_STATUSES = ["DRAFT", "APPROVED", "IN_PROGRESS"];

// كل الأصناف المصنّعة/المعبأة (item_type='manufactured') - دي بس اللي منطقي نخطط تصنيعها
async function manufacturedItems(client) {
  const res = await client.query(
    "SELECT id, name, unit FROM inventory_items WHERE item_type = 'manufactured' ORDER BY name"
  );
  return res.rows;
}

// الطلب المعتمد فعليًا (من كل الفروع، ما عدا السنتر كيتشن نفسه) في نافذة التغطية [fromDate, toDate] -
// COALESCE(required_date, business_date) هو تاريخ "لازم يوصل الفرع بيه" - required_date لو محدد، وإلا
// تاريخ إنشاء الطلبية نفسه (نفس الاصطلاح المستخدم في db/kitchen-order-sync.js وواجهة UI-1)
async function approvedDemandByItem(client, { ckBranchId, fromDate, toDate }) {
  const res = await client.query(
    `SELECT koi.inventory_item_id, ko.branch_id, b.name AS branch_name,
            COALESCE(ko.required_date, ko.business_date) AS needed_date,
            koi.quantity_requested, koi.quantity_to_prepare, koi.quantity_dispatched, koi.fulfillment_status,
            ko.id AS kitchen_order_id, ko.status,
            COALESCE(kt.in_transit_quantity, 0) AS in_transit_quantity
     FROM kitchen_order_items koi
     JOIN kitchen_orders ko ON ko.id = koi.kitchen_order_id
     JOIN branches b ON b.id = ko.branch_id
     LEFT JOIN LATERAL (
       SELECT SUM(COALESCE(kti.quantity_sent, kti.quantity)) AS in_transit_quantity
       FROM kitchen_transfer_items kti JOIN kitchen_transfers t ON t.id = kti.kitchen_transfer_id
       WHERE t.kitchen_order_id = ko.id AND kti.inventory_item_id = koi.inventory_item_id AND t.status IN ('issued','in_transit')
     ) kt ON TRUE
     WHERE ko.branch_id <> $1 AND ko.status = ANY($2::text[])
       AND COALESCE(ko.required_date, ko.business_date) BETWEEN $3 AND $4`,
    [ckBranchId, COMMITTED_DEMAND_STATUSES, fromDate, toDate]
  );
  return res.rows;
}

// نفس الطلب لسه مش معتمد (SUBMITTED) - استرشادي بس للعرض ("طلبات لسه في انتظار اعتماد السنتر كيتشن")،
// مش داخل في حساب "المطلوب تصنيعه"
async function pendingSubmittedDemandByItem(client, { ckBranchId, fromDate, toDate }) {
  const res = await client.query(
    `SELECT koi.inventory_item_id, ko.branch_id, b.name AS branch_name,
            COALESCE(ko.required_date, ko.business_date) AS needed_date, koi.quantity_requested, ko.id AS kitchen_order_id
     FROM kitchen_order_items koi
     JOIN kitchen_orders ko ON ko.id = koi.kitchen_order_id
     JOIN branches b ON b.id = ko.branch_id
     WHERE ko.branch_id <> $1 AND ko.status = 'SUBMITTED'
       AND COALESCE(ko.required_date, ko.business_date) BETWEEN $2 AND $3`,
    [ckBranchId, fromDate, toDate]
  );
  return res.rows;
}

async function ckAvailableStock(client, { ckBranchId, inventoryItemIds }) {
  if (inventoryItemIds.length === 0) return new Map();
  const res = await client.query(
    "SELECT inventory_item_id, quantity FROM branch_inventory_stock WHERE branch_id = $1 AND inventory_item_id = ANY($2::int[])",
    [ckBranchId, inventoryItemIds]
  );
  return new Map(res.rows.map((r) => [r.inventory_item_id, Number(r.quantity)]));
}

// تحت التنفيذ/مخطط - من مصدرين ممكنين لنفس الصنف: أمر تصنيع مباشر (وصفة output) أو أمر تعبئة (output_item_id)
async function plannedOrInProgressByItem(client, { ckBranchId, inventoryItemIds }) {
  if (inventoryItemIds.length === 0) return new Map();
  const productionRes = await client.query(
    `SELECT r.inventory_item_id, COALESCE(SUM(po.planned_quantity), 0) AS qty
     FROM production_orders po JOIN recipes r ON r.id = po.recipe_id
     WHERE po.branch_id = $1 AND r.inventory_item_id = ANY($2::int[]) AND po.status = ANY($3::text[])
     GROUP BY r.inventory_item_id`,
    [ckBranchId, inventoryItemIds, ACTIVE_PRODUCTION_STATUSES]
  );
  const packagingRes = await client.query(
    `SELECT output_item_id AS inventory_item_id, COALESCE(SUM(planned_output_quantity), 0) AS qty
     FROM packaging_orders
     WHERE branch_id = $1 AND output_item_id = ANY($2::int[]) AND status = ANY($3::text[])
     GROUP BY output_item_id`,
    [ckBranchId, inventoryItemIds, ACTIVE_PRODUCTION_STATUSES]
  );
  const map = new Map();
  for (const r of productionRes.rows) map.set(r.inventory_item_id, (map.get(r.inventory_item_id) || 0) + Number(r.qty));
  for (const r of packagingRes.rows) map.set(r.inventory_item_id, (map.get(r.inventory_item_id) || 0) + Number(r.qty));
  return map;
}

// أحدث نسخة وصفة نشطة لكل صنف من الأصناف المطلوبة - استعلام واحد بدل واحد لكل صنف
async function activeRecipesByItem(client, inventoryItemIds) {
  if (inventoryItemIds.length === 0) return new Map();
  const res = await client.query(
    `SELECT r.inventory_item_id, r.id AS recipe_id, rv.id AS recipe_version_id, rv.version_number
     FROM recipes r JOIN recipe_versions rv ON rv.recipe_id = r.id
     WHERE r.recipe_type = 'manufactured_item' AND r.inventory_item_id = ANY($1::int[]) AND rv.status = 'ACTIVE'`,
    [inventoryItemIds]
  );
  return new Map(res.rows.map((r) => [r.inventory_item_id, r]));
}

// آخر أمر تعبئة مكتمل أنتج الصنف ده - بس عشان نعرض "بيتعبّى عادةً من كذا" استرشاديًا لصنف مالوش وصفة
// تصنيع مباشرة (يعني بيجي من تعبئة مش من وصفة) - مش "وصفة تعبئة" حقيقية (مفيش جدول بيعرّفها في السكيمة
// أصلًا)، فبنوضح ده صراحة في الاستجابة (isEstimate: true) بدل ما نتظاهر إنه رقم مضمون
async function lastPackagingSource(client, { ckBranchId, outputItemId }) {
  const res = await client.query(
    `SELECT po.input_item_id, ii.name AS input_item_name, po.planned_input_quantity, po.planned_output_quantity
     FROM packaging_orders po JOIN inventory_items ii ON ii.id = po.input_item_id
     WHERE po.branch_id = $1 AND po.output_item_id = $2 AND po.status = 'COMPLETED'
     ORDER BY po.completed_at DESC LIMIT 1`,
    [ckBranchId, outputItemId]
  );
  return res.rows[0] || null;
}

// الخطة الكاملة لكل الأصناف المصنّعة/المعبأة في نافذة تغطية معينة - القراءة الأساسية لشاشة التخطيط
async function computeProductionPlan(client, { ckBranchId, fromDate, toDate }) {
  const items = await manufacturedItems(client);
  const itemIds = items.map((i) => i.id);
  if (itemIds.length === 0) return [];

  const [approvedRows, pendingRows, stockMap, plannedMap, recipeMap] = await Promise.all([
    approvedDemandByItem(client, { ckBranchId, fromDate, toDate }),
    pendingSubmittedDemandByItem(client, { ckBranchId, fromDate, toDate }),
    ckAvailableStock(client, { ckBranchId, inventoryItemIds: itemIds }),
    plannedOrInProgressByItem(client, { ckBranchId, inventoryItemIds: itemIds }),
    activeRecipesByItem(client, itemIds),
  ]);

  const approvedByItem = new Map();
  for (const r of approvedRows) {
    const list = approvedByItem.get(r.inventory_item_id) || [];
    list.push(r);
    approvedByItem.set(r.inventory_item_id, list);
  }
  const pendingByItem = new Map();
  for (const r of pendingRows) {
    const list = pendingByItem.get(r.inventory_item_id) || [];
    list.push(r);
    pendingByItem.set(r.inventory_item_id, list);
  }

  return items.map((item) => {
    const approvedList = approvedByItem.get(item.id) || [];
    const pendingList = pendingByItem.get(item.id) || [];
    const approvedDemand = approvedList.reduce((s, r) => s + Number(r.quantity_requested), 0);
    const pendingDemand = pendingList.reduce((s, r) => s + Number(r.quantity_requested), 0);
    const availableStock = stockMap.get(item.id) || 0;
    const plannedOrInProgress = plannedMap.get(item.id) || 0;
    const requiredProduction = Math.max(0, approvedDemand - availableStock - plannedOrInProgress);
    const recipe = recipeMap.get(item.id) || null;

    let rawMaterialStatus = "N_A"; // مفيش وصفة مباشرة (على الأغلب بيجي من تعبئة، مش تصنيع مباشر)
    if (requiredProduction <= 0) rawMaterialStatus = "READY";
    else if (recipe) rawMaterialStatus = "UNKNOWN"; // بيتحدد فعليًا بس لما تتفتح تفاصيل الخامات (استعلام تاني)

    return {
      inventoryItemId: item.id, itemName: item.name, unit: item.unit,
      approvedDemand, pendingDemand, availableStock, plannedOrInProgress, requiredProduction,
      demandBranches: [...new Set(approvedList.map((r) => r.branch_name))],
      hasActiveRecipe: !!recipe, recipeId: recipe?.recipe_id || null, recipeVersionId: recipe?.recipe_version_id || null,
      rawMaterialStatus,
    };
  });
}

// احتياج الخامات لكمية مطلوب تصنيعها من صنف معيّن - بيستخدم محرك الوصفات الموجود فعليًا حرفيًا
// (explodeRecipeConsumption)، مفيش أي تفجير وصفة بديل هنا خالص. لو الصنف معندوش وصفة مباشرة (بيجي من
// تعبئة)، بيرجع تلميح استرشادي بس (آخر أمر تعبئة، isEstimate:true) مش احتياج خام حقيقي
async function computeRawMaterialRequirement(client, { ckBranchId, inventoryItemId, quantity, recipeVersionId }) {
  if (!recipeVersionId) {
    const source = await lastPackagingSource(client, { ckBranchId, outputItemId: inventoryItemId });
    return { hasRecipe: false, isEstimate: true, packagingSource: source, raw: [] };
  }
  const { raw, incomplete } = await explodeRecipeConsumption(client, recipeVersionId, quantity, new Set());
  const itemIds = [...raw.keys()];
  const [namesRes, stockMap] = await Promise.all([
    client.query("SELECT id, name, unit FROM inventory_items WHERE id = ANY($1::int[])", [itemIds]),
    ckAvailableStock(client, { ckBranchId, inventoryItemIds: itemIds }),
  ]);
  const namesById = new Map(namesRes.rows.map((r) => [r.id, r]));
  const rows = [...raw.entries()].map(([itemId, data]) => {
    const available = stockMap.get(itemId) || 0;
    const required = Number(data.quantity);
    return {
      inventoryItemId: itemId, itemName: namesById.get(itemId)?.name || null, unit: namesById.get(itemId)?.unit || data.unit,
      required, available, shortage: Math.max(0, required - available),
    };
  }).sort((a, b) => b.shortage - a.shortage);
  return { hasRecipe: true, isEstimate: false, incomplete, raw: rows };
}

module.exports = {
  COMMITTED_DEMAND_STATUSES, ACTIVE_PRODUCTION_STATUSES,
  manufacturedItems, approvedDemandByItem, pendingSubmittedDemandByItem,
  ckAvailableStock, plannedOrInProgressByItem, activeRecipesByItem,
  computeProductionPlan, computeRawMaterialRequirement,
  generateSuggestedRequisition, // إعادة تصدير - نفس محرك الاقتراح الموجود، من غير تكرار
};
