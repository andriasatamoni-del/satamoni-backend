// Procurement v2 STEP H: ترقيم دفعات نظامي فريد إلزامي - رقم الدفعة = بادئة-تاريخ(YYYYMMDD)-تسلسل
// (مثال SAU-20260828-001). البادئة من inventory_items.batch_prefix لو محدد للصنف، وإلا بادئة عامة
// افتراضية "MFG". التسلسل بيتصفّر لكل بادئة كل يوم عن طريق batch_number_counters (المرحلة A) - upsert
// atomic واحد (INSERT ... ON CONFLICT DO UPDATE ... RETURNING) عشان يفضل صحيح تحت التزامن من غير قفل
// منفصل (نفس فلسفة nextval('journal_entry_number_seq') في accounting-engine.js، بس هنا محتاجين تصفير
// يومي لكل بادئة فمينفعش نستخدم sequence عادي)
const DEFAULT_PREFIX = "MFG";

async function generateBatchNumber(client, { inventoryItemId, date } = {}) {
  const itemRes = inventoryItemId
    ? await client.query("SELECT batch_prefix FROM inventory_items WHERE id = $1", [inventoryItemId])
    : { rows: [] };
  const prefix = itemRes.rows[0]?.batch_prefix || DEFAULT_PREFIX;
  const counterDate = date || new Date().toISOString().slice(0, 10);

  const counter = await client.query(
    `INSERT INTO batch_number_counters (prefix, counter_date, last_sequence)
     VALUES ($1, $2, 1)
     ON CONFLICT (prefix, counter_date) DO UPDATE SET last_sequence = batch_number_counters.last_sequence + 1
     RETURNING last_sequence`,
    [prefix, counterDate]
  );
  const seq = counter.rows[0].last_sequence;
  const compactDate = counterDate.replace(/-/g, "");
  return `${prefix}-${compactDate}-${String(seq).padStart(3, "0")}`;
}

module.exports = { generateBatchNumber };
