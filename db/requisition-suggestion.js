// Procurement v2 STEP E: محرك اقتراح الطلبية اليومية - واعي بيوم الأسبوع (خميس/جمعة بيختلفوا استهلاكهم
// عن باقي أيام الأسبوع في مطعم عادي) ومبني على استهلاك فعلي تاريخي، **مش** "max_stock - الرصيد الحالي"
// (الصيغة البسيطة دي بتتجاهل إن يوم بعينه ممكن يستهلك أكتر أو أقل بكتير من باقي الأيام، وبتخلي كل يوم
// يتطلب نفس الكمية بالظبط لحد الحد الأقصى حتى لو مفيش داعي فعلي).
//
// STEP L-audit (مراجعة الجاهزية للإنتاج قبل الـUI): الصيغة الأصلية كانت بتحسب يوم واحد بس (يوم الهدف)
// وماكانتش واعية لا بالطلبيات المعتمدة اللي لسه في الطريق (pending pipeline) ولا بالكمية اللي في الطريق
// فعليًا (in-transit) - يعني ممكن تقترح كمية زيادة لأصناف أصلًا في طريقها للفرع (ازدواج طلب). كمان
// مكانش فيه أي مفهوم "الاستهلاك المتوقع لحد فرصة التزويد الجاية" (multi-day coverage window) - يوم زي
// الخميس ممكن يحتاج يغطي استهلاك يوم/يومين إضافيين (جمعة/سبت) لو التزويد الجاي مش هيوصل غير يوم السبت.
// الإصلاح: (1) pendingPipelineQuantity/inTransitQuantity بتتخصم من الكمية المتاحة قبل حساب الاقتراح -
// نفس مبدأ target - (current + pending + in_transit)، (2) nextReplenishmentDate اختياري - لو اتبعت،
// الاستهلاك المتوقع بيتحسب كمجموع كل الأيام من targetDate (شامل) لحد nextReplenishmentDate (مش شامل)،
// مش يوم واحد بس. لو ماتبعتش، النافذة يوم واحد بالظبط (targetDate نفسه) - **نفس السلوك القديم تمامًا،
// رياضيًا متطابق** (نافذة يوم واحد = نفس averageWeekdayConsumption القديمة) - عشان التوافق الخلفي الكامل
// مع أي استدعاء قديم مايبعتش الباراميتر الجديد ده.
const CONSUMPTION_MOVEMENT_TYPES = [
  "SALE", "sale_deduction", // مبيعات
  "PRODUCTION_OUT", "production_out", // تصنيع استهلك الصنف كمكوّن
  "WASTE", "waste", "DAMAGE", "EXPIRY", // هالك
];

// طلبيات فرع لسه في خط الأنابيب (اتطلبت لكن لسه ماتحوّلتش لتحويل فعلي/ماوصلتش) - status جديدة (السير
// الجديد) أو 'pending' القديمة. عمدًا مستبعدين DISPATCHED/IN_TRANSIT (الطلبية بقت تحويل فعلي بالفعل -
// بتتحسب في inTransitQuantity تحت بدل منها، عشان مانعدّش نفس الشحنة الفعلية مرتين) وأي حالة نهائية
// (RECEIVED/REJECTED/CANCELLED/fulfilled)
const PENDING_PIPELINE_ORDER_STATUSES = ["pending", "DRAFT", "SUBMITTED", "APPROVED", "PREPARING", "READY"];

// تحويلات اتصدرت فعليًا من المصدر لكن لسه ماوصلتش الفرع المستلم بعد (في الطريق) - الكمية اللي بتتحسب هنا
// هي كمية الإرسال الفعلية (quantity_sent) لو موجودة (بعد /issue)، وإلا الكمية المخططة كاحتياط
const IN_TRANSIT_TRANSFER_STATUSES = ["issued", "in_transit"];

// آخر weeksBack تاريخ بنفس يوم الأسبوع بتاع targetDate بالظبط (طرح مضاعفات 7 أيام - نفس يوم الأسبوع
// أوتوماتيكيًا من غير أي حساب EXTRACT(DOW) منفصل)
function pastOccurrencesOfWeekday(targetDate, weeksBack) {
  const target = new Date(`${targetDate}T00:00:00Z`);
  const dates = [];
  for (let i = 1; i <= weeksBack; i++) {
    const d = new Date(target);
    d.setUTCDate(d.getUTCDate() - i * 7);
    dates.push(d.toISOString().slice(0, 10));
  }
  return dates;
}

// كل الأيام من startDate (شامل) لحد endDateExclusive (مش شامل) - مستخدمة لبناء نافذة التغطية
function datesInRange(startDate, endDateExclusive) {
  const start = new Date(`${startDate}T00:00:00Z`);
  const end = new Date(`${endDateExclusive}T00:00:00Z`);
  const dates = [];
  for (let d = new Date(start); d < end; d.setUTCDate(d.getUTCDate() + 1)) {
    dates.push(d.toISOString().slice(0, 10));
  }
  return dates;
}

// متوسط الاستهلاك الفعلي لصنف معيّن في فرع معيّن في نفس يوم الأسبوع بتاع targetDate، عبر آخر lookbackWeeks
// أسبوع - بيرجع 0 لو مفيش تاريخ كفاية (صنف جديد لسه معندوش سجل استهلاك)
async function averageWeekdayConsumption(client, { branchId, inventoryItemId, targetDate, lookbackWeeks = 8 }) {
  const dates = pastOccurrencesOfWeekday(targetDate, lookbackWeeks);
  const result = await client.query(
    `SELECT COALESCE(SUM(-im.quantity), 0) AS consumed
     FROM unnest($1::date[]) AS d
     LEFT JOIN inventory_movements im
       ON im.business_date = d AND im.branch_id = $2 AND im.inventory_item_id = $3
          AND im.quantity < 0 AND im.movement_type = ANY($4::text[])
     GROUP BY d`,
    [dates, branchId, inventoryItemId, CONSUMPTION_MOVEMENT_TYPES]
  );
  if (result.rows.length === 0) return { average: 0, occurrencesUsed: 0 };
  const total = result.rows.reduce((s, r) => s + Number(r.consumed), 0);
  return { average: total / result.rows.length, occurrencesUsed: result.rows.length };
}

// الاستهلاك المتوقع الإجمالي عبر نافذة أيام متعددة (targetDate شامل لحد nextReplenishmentDate مش شامل) -
// كل يوم في النافذة بياخد متوسط استهلاك يوم أسبوعه هو (مش كلهم بمتوسط يوم واحد) - مبنية على استعلام واحد
// لكل النافذة (مش استعلام منفصل لكل يوم) عشان الأداء ثابت بغض النظر عن طول النافذة
async function expectedConsumptionWindow(client, { branchId, inventoryItemId, targetDate, nextReplenishmentDate, lookbackWeeks = 8 }) {
  const windowDays = datesInRange(targetDate, nextReplenishmentDate);
  if (windowDays.length === 0) return { expectedConsumption: 0, coverageDays: 0 };

  const result = await client.query(
    `WITH lookback_pairs AS (
       SELECT wd.target_day, (wd.target_day - (n * 7))::date AS lookback_day
       FROM unnest($1::date[]) AS wd(target_day)
       CROSS JOIN generate_series(1, $2) AS n
     )
     SELECT lp.target_day, COALESCE(SUM(-im.quantity), 0) AS total_consumed
     FROM lookback_pairs lp
     LEFT JOIN inventory_movements im
       ON im.business_date = lp.lookback_day AND im.branch_id = $3 AND im.inventory_item_id = $4
          AND im.quantity < 0 AND im.movement_type = ANY($5::text[])
     GROUP BY lp.target_day`,
    [windowDays, lookbackWeeks, branchId, inventoryItemId, CONSUMPTION_MOVEMENT_TYPES]
  );
  const expectedConsumption = result.rows.reduce((s, r) => s + Number(r.total_consumed) / lookbackWeeks, 0);
  return { expectedConsumption, coverageDays: windowDays.length };
}

// كمية نفس الصنف المطلوبة في طلبيات الفرع اللي لسه في خط الأنابيب (اتطلبت/اتعمدت لكن لسه ماتحوّلتش
// لتحويل فعلي) - لازم تتخصم من الاقتراح عشان ما نطلبش نفس الكمية مرتين
async function pendingPipelineQuantity(client, { branchId, inventoryItemId }) {
  const result = await client.query(
    `SELECT COALESCE(SUM(koi.quantity_requested), 0) AS quantity
     FROM kitchen_order_items koi
     JOIN kitchen_orders ko ON ko.id = koi.kitchen_order_id
     WHERE ko.branch_id = $1 AND koi.inventory_item_id = $2 AND ko.status = ANY($3::text[])`,
    [branchId, inventoryItemId, PENDING_PIPELINE_ORDER_STATUSES]
  );
  return Number(result.rows[0].quantity);
}

// كمية نفس الصنف في تحويلات اتصدرت فعليًا للفرع ده ولسه في الطريق (مش وصلت بعد) - لازم تتخصم برضه عشان
// ما نطلبش كمية إضافية غير ضرورية وهي فعليًا جاية أصلًا
async function inTransitQuantity(client, { branchId, inventoryItemId }) {
  const result = await client.query(
    `SELECT COALESCE(SUM(COALESCE(kti.quantity_sent, kti.quantity)), 0) AS quantity
     FROM kitchen_transfer_items kti
     JOIN kitchen_transfers kt ON kt.id = kti.kitchen_transfer_id
     WHERE kt.to_branch_id = $1 AND kti.inventory_item_id = $2 AND kt.status = ANY($3::text[])`,
    [branchId, inventoryItemId, IN_TRANSIT_TRANSFER_STATUSES]
  );
  return Number(result.rows[0].quantity);
}

// الكمية المقترحة لصنف واحد - target = الاستهلاك المتوقع (يوم واحد افتراضيًا، أو نافذة تغطية متعددة
// الأيام لو nextReplenishmentDate اتبعتت) + حد أدنى أماني (min_stock لو موجود)، مسقوف بـmax_stock لو
// موجود. الكمية المتاحة فعليًا لتغطية الهدف = الرصيد الحالي + أي كمية لسه في خط الأنابيب (طلبيات معتمدة
// لسه ماتحوّلتش لتحويل) + أي كمية في الطريق فعليًا (تحويل اتصدر ولسه ماوصلش) - مش الرصيد الحالي بس
async function computeSuggestedQuantity(client, {
  branchId, inventoryItemId, targetDate, lookbackWeeks = 8, nextReplenishmentDate = null,
}) {
  const stockRes = await client.query(
    "SELECT quantity, min_stock, max_stock, reorder_point FROM branch_inventory_stock WHERE branch_id = $1 AND inventory_item_id = $2",
    [branchId, inventoryItemId]
  );
  const currentStock = stockRes.rows.length ? Number(stockRes.rows[0].quantity) : 0;
  const minStock = stockRes.rows[0]?.min_stock != null ? Number(stockRes.rows[0].min_stock) : 0;
  const maxStock = stockRes.rows[0]?.max_stock != null ? Number(stockRes.rows[0].max_stock) : null;

  const { average, occurrencesUsed } = await averageWeekdayConsumption(client, { branchId, inventoryItemId, targetDate, lookbackWeeks });

  let expectedConsumption = average;
  let coverageDays = 1;
  if (nextReplenishmentDate && nextReplenishmentDate > targetDate) {
    const window = await expectedConsumptionWindow(client, { branchId, inventoryItemId, targetDate, nextReplenishmentDate, lookbackWeeks });
    expectedConsumption = window.expectedConsumption;
    coverageDays = window.coverageDays;
  }

  const [pendingPipeline, inTransit] = await Promise.all([
    pendingPipelineQuantity(client, { branchId, inventoryItemId }),
    inTransitQuantity(client, { branchId, inventoryItemId }),
  ]);

  let target = expectedConsumption + minStock;
  if (maxStock != null) target = Math.min(target, maxStock);
  const availableCoverage = currentStock + pendingPipeline + inTransit;
  const suggestedQuantity = Math.max(0, target - availableCoverage);

  return {
    inventoryItemId, currentStock, minStock, maxStock,
    avgWeekdayConsumption: average, occurrencesUsed,
    expectedConsumption, coverageDays, target,
    pendingPipelineQuantity: pendingPipeline, inTransitQuantity: inTransit,
    suggestedQuantity,
  };
}

// طلبية مقترحة كاملة لفرع - بس للأصناف اللي ليها حدود مخزون مضبوطة أصلًا (reorder_point/min_stock/
// max_stock) - صنف من غير أي حد مضبوط مفيش أساس منطقي نبني عليه اقتراح، هيتسجل صفر لو حصل واتضمّن
async function generateSuggestedRequisition(client, { branchId, targetDate, lookbackWeeks = 8, nextReplenishmentDate = null }) {
  const itemsRes = await client.query(
    `SELECT bis.inventory_item_id, ii.name, ii.unit
     FROM branch_inventory_stock bis JOIN inventory_items ii ON ii.id = bis.inventory_item_id
     WHERE bis.branch_id = $1 AND (bis.reorder_point IS NOT NULL OR bis.min_stock IS NOT NULL OR bis.max_stock IS NOT NULL)
     ORDER BY ii.name`,
    [branchId]
  );
  const suggestions = [];
  for (const row of itemsRes.rows) {
    const suggestion = await computeSuggestedQuantity(client, {
      branchId, inventoryItemId: row.inventory_item_id, targetDate, lookbackWeeks, nextReplenishmentDate,
    });
    suggestions.push({ ...suggestion, name: row.name, unit: row.unit });
  }
  return suggestions;
}

module.exports = {
  pastOccurrencesOfWeekday, averageWeekdayConsumption, expectedConsumptionWindow,
  pendingPipelineQuantity, inTransitQuantity, computeSuggestedQuantity, generateSuggestedRequisition,
};
