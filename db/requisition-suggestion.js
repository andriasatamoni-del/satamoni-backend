// Procurement v2 STEP E: محرك اقتراح الطلبية اليومية - واعي بيوم الأسبوع (خميس/جمعة بيختلفوا استهلاكهم
// عن باقي أيام الأسبوع في مطعم عادي) ومبني على استهلاك فعلي تاريخي، **مش** "max_stock - الرصيد الحالي"
// (الصيغة البسيطة دي بتتجاهل إن يوم بعينه ممكن يستهلك أكتر أو أقل بكتير من باقي الأيام، وبتخلي كل يوم
// يتطلب نفس الكمية بالظبط لحد الحد الأقصى حتى لو مفيش داعي فعلي).
//
// الفكرة: بنجيب متوسط الاستهلاك الفعلي في نفس يوم الأسبوع المستهدف على مدار آخر lookbackWeeks أسبوع
// (كل الأيام المطابقة، حتى اللي مفيهاش أي حركة استهلاك خالص - بتتحسب صفر مش بتتجاهل، عشان الأيام اللي
// كان فيها نقص مخزون فمفيش مبيعات أصلًا متضخّمش المتوسط بالغلط). الكمية المقترحة = (متوسط الاستهلاك +
// حد أدنى أماني min_stock) ناقص الرصيد الحالي، من غير ما تتخطى max_stock (سقف تخزين الفرع الفعلي).
const CONSUMPTION_MOVEMENT_TYPES = [
  "SALE", "sale_deduction", // مبيعات
  "PRODUCTION_OUT", "production_out", // تصنيع استهلك الصنف كمكوّن
  "WASTE", "waste", "DAMAGE", "EXPIRY", // هالك
];

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

// الكمية المقترحة لصنف واحد - target = متوسط الاستهلاك + حد أدنى أماني (min_stock لو موجود)، مسقوف بـ
// max_stock لو موجود (عشان الاقتراح مايتخطاش سعة تخزين الفرع الفعلية)
async function computeSuggestedQuantity(client, { branchId, inventoryItemId, targetDate, lookbackWeeks = 8 }) {
  const stockRes = await client.query(
    "SELECT quantity, min_stock, max_stock, reorder_point FROM branch_inventory_stock WHERE branch_id = $1 AND inventory_item_id = $2",
    [branchId, inventoryItemId]
  );
  const currentStock = stockRes.rows.length ? Number(stockRes.rows[0].quantity) : 0;
  const minStock = stockRes.rows[0]?.min_stock != null ? Number(stockRes.rows[0].min_stock) : 0;
  const maxStock = stockRes.rows[0]?.max_stock != null ? Number(stockRes.rows[0].max_stock) : null;

  const { average, occurrencesUsed } = await averageWeekdayConsumption(client, { branchId, inventoryItemId, targetDate, lookbackWeeks });

  let target = average + minStock;
  if (maxStock != null) target = Math.min(target, maxStock);
  const suggestedQuantity = Math.max(0, target - currentStock);

  return {
    inventoryItemId, currentStock, minStock, maxStock,
    avgWeekdayConsumption: average, occurrencesUsed, suggestedQuantity,
  };
}

// طلبية مقترحة كاملة لفرع - بس للأصناف اللي ليها حدود مخزون مضبوطة أصلًا (reorder_point/min_stock/
// max_stock) - صنف من غير أي حد مضبوط مفيش أساس منطقي نبني عليه اقتراح، هيتسجل صفر لو حصل واتضمّن
async function generateSuggestedRequisition(client, { branchId, targetDate, lookbackWeeks = 8 }) {
  const itemsRes = await client.query(
    `SELECT bis.inventory_item_id, ii.name, ii.unit
     FROM branch_inventory_stock bis JOIN inventory_items ii ON ii.id = bis.inventory_item_id
     WHERE bis.branch_id = $1 AND (bis.reorder_point IS NOT NULL OR bis.min_stock IS NOT NULL OR bis.max_stock IS NOT NULL)
     ORDER BY ii.name`,
    [branchId]
  );
  const suggestions = [];
  for (const row of itemsRes.rows) {
    const suggestion = await computeSuggestedQuantity(client, { branchId, inventoryItemId: row.inventory_item_id, targetDate, lookbackWeeks });
    suggestions.push({ ...suggestion, name: row.name, unit: row.unit });
  }
  return suggestions;
}

module.exports = { pastOccurrencesOfWeekday, averageWeekdayConsumption, computeSuggestedQuantity, generateSuggestedRequisition };
