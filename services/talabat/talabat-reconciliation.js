// تكامل طلبات (TAL-8): المطابقة اليومية Stamoni <-> Talabat.
//
// compareTalabatRecords نقية (pure) بالكامل ومختبرة بالكامل الآن - بتاخد قايمتين (سجلات Talabat وسجلات
// Stamoni) وترجّع الفروقات الستة المطلوبة صراحة. الجزء اللي محتاج توثيق خارجي (فعليًا جلب سجلات Talabat
// نفسها عبر GET Orders API) هو الوحيد المؤجل - services/talabat/talabat-client.js:getOrderHistory لسه
// NOT_IMPLEMENTED، فـrunDailyReconciliation بترجع حالة واضحة (TALABAT_API_NOT_CONFIGURED) بدل ما تدّعي
// مطابقة مالحصلتش فعليًا. أي حد يقدر ينادي compareTalabatRecords مباشرة بسجلات Talabat جاهزة (من ملف
// تصدير يدوي مثلًا) لحد ما التكامل الحقيقي يشتغل.
const pool = require("../../db/pool");
const talabatClient = require("./talabat-client");

const AMOUNT_EPSILON = 0.01;

function isCanceled(orderStatus) {
  return String(orderStatus || "").toUpperCase() === "CANCELED";
}

// talabatRecords: [{ talabatOrderId, total, paymentMethodCode, orderStatus }] - شكل Talabat (لسه مش
// مؤكد ضد الـspec الحقيقي، راجع docs/TALABAT-INTEGRATION.md)
// stamoniRecords: [{ talabatOrderId, total, paymentMethodCode, orderStatus }] - من talabat_orders عندنا
function compareTalabatRecords(talabatRecords, stamoniRecords) {
  const discrepancies = [];

  const talabatById = new Map();
  const talabatCounts = new Map();
  for (const rec of talabatRecords) {
    talabatCounts.set(rec.talabatOrderId, (talabatCounts.get(rec.talabatOrderId) || 0) + 1);
    if (!talabatById.has(rec.talabatOrderId)) talabatById.set(rec.talabatOrderId, rec);
  }
  for (const [talabatOrderId, count] of talabatCounts.entries()) {
    if (count > 1) {
      discrepancies.push({ type: "DUPLICATE_ORDER", talabatOrderId, details: `ظهر ${count} مرة في سجلات Talabat` });
    }
  }

  const stamoniById = new Map(stamoniRecords.map((rec) => [rec.talabatOrderId, rec]));

  for (const [talabatOrderId, talabatRecord] of talabatById.entries()) {
    const stamoniRecord = stamoniById.get(talabatOrderId);
    if (!stamoniRecord) {
      discrepancies.push({ type: "MISSING_IN_STAMONI", talabatOrderId, talabatRecord });
      continue;
    }
    if (Math.abs(Number(talabatRecord.total) - Number(stamoniRecord.total)) > AMOUNT_EPSILON) {
      discrepancies.push({
        type: "TOTAL_MISMATCH", talabatOrderId,
        talabatTotal: Number(talabatRecord.total), stamoniTotal: Number(stamoniRecord.total),
      });
    }
    if (String(talabatRecord.paymentMethodCode) !== String(stamoniRecord.paymentMethodCode)) {
      discrepancies.push({
        type: "PAYMENT_MISMATCH", talabatOrderId,
        talabatPaymentMethod: talabatRecord.paymentMethodCode, stamoniPaymentMethod: stamoniRecord.paymentMethodCode,
      });
    }
    if (isCanceled(talabatRecord.orderStatus) !== isCanceled(stamoniRecord.orderStatus)) {
      discrepancies.push({
        type: "CANCELLATION_MISMATCH", talabatOrderId,
        talabatStatus: talabatRecord.orderStatus, stamoniStatus: stamoniRecord.orderStatus,
      });
    }
  }

  for (const talabatOrderId of stamoniById.keys()) {
    if (!talabatById.has(talabatOrderId)) {
      discrepancies.push({ type: "MISSING_IN_TALABAT", talabatOrderId, stamoniRecord: stamoniById.get(talabatOrderId) });
    }
  }

  return discrepancies;
}

async function fetchStamoniRecords({ branchId, from, to }) {
  const conditions = ["(received_at AT TIME ZONE 'Africa/Cairo')::date BETWEEN $1 AND $2"];
  const values = [from, to];
  if (branchId) {
    conditions.push(`branch_id = $${values.length + 1}`);
    values.push(branchId);
  }
  const result = await pool.query(
    `SELECT talabat_order_id, total, payment_method, order_status
     FROM talabat_orders WHERE ${conditions.join(" AND ")}`,
    values
  );
  return result.rows.map((r) => ({
    talabatOrderId: r.talabat_order_id,
    total: Number(r.total),
    paymentMethodCode: r.payment_method,
    orderStatus: r.order_status,
  }));
}

// النتيجة: { status: 'COMPLETED' | 'TALABAT_API_NOT_CONFIGURED', stamoniRecords, discrepancies }
// - أبدًا مش بتدّعي 'COMPLETED' من غير ما تجيب سجلات Talabat الحقيقية فعليًا
async function runDailyReconciliation({ branchId = null, from, to }) {
  const stamoniRecords = await fetchStamoniRecords({ branchId, from, to });
  try {
    const talabatRecords = await talabatClient.getOrderHistory({ branchId, fromDate: from, toDate: to });
    const discrepancies = compareTalabatRecords(talabatRecords, stamoniRecords);
    return { status: "COMPLETED", stamoniRecords, discrepancies };
  } catch (err) {
    if (err instanceof talabatClient.TalabatNotImplementedError) {
      return { status: "TALABAT_API_NOT_CONFIGURED", stamoniRecords, discrepancies: [], reason: err.message };
    }
    throw err;
  }
}

module.exports = { compareTalabatRecords, runDailyReconciliation };
