// Payment Control & Reconciliation: إرسال تلقائي للتقرير اليومي للمالك - نفس بوابة db/sms-provider.js
// المستخدمة أصلًا لتأكيد الطلبات (db/order-notifications.js)، بدون بوابة إضافية. بيشتغل كـsetInterval
// جوه نفس الـprocess (نفس فلسفة db/sync-worker.js بس أبسط بكتير - تحقق دوري كل شوية، مش اتصال خارجي).
// معطّل تمامًا افتراضيًا (pos_settings.payment_daily_report_enabled = FALSE ورقم مالك فاضي) - لا بيبعت
// ولا بيحاول أي حاجة لحد ما حد يفعّله صراحة من الإعدادات.
const pool = require("./pool");
const { sendMessage } = require("./sms-provider");
const { computeExceptions, formatOwnerReportMessage } = require("./payment-control-engine");
const { getCairoBusinessDate, getCairoHour } = require("./business-date");

const CHECK_INTERVAL_MS = 10 * 60 * 1000; // تقرير يومي - مش محتاجين دقة الثانية، كل 10 دقايق كفاية

async function maybeSendDailyReport() {
  try {
    const settings = await pool.query(
      "SELECT payment_daily_report_enabled, owner_report_phone, payment_daily_report_hour FROM pos_settings WHERE id = 1"
    );
    const s = settings.rows[0];
    if (!s?.payment_daily_report_enabled || !s.owner_report_phone) return;

    const now = new Date();
    if (getCairoHour(now) < s.payment_daily_report_hour) return;

    const businessDate = getCairoBusinessDate(now);
    // idempotency - نفس فلسفة كل idempotency_key تانية في المشروع: لو اتبعت النهاردة بالفعل، مايتبعتش تاني
    const already = await pool.query("SELECT 1 FROM payment_daily_report_log WHERE report_date = $1", [businessDate]);
    if (already.rows.length > 0) return;

    const { exceptions, totalPoints, tier } = await computeExceptions(pool, { branchId: null, from: businessDate, to: businessDate });
    const message = formatOwnerReportMessage({ businessDate, exceptions, totalPoints, tier });
    const result = await sendMessage({ phone: s.owner_report_phone, message });

    await pool.query(
      `INSERT INTO payment_daily_report_log (report_date, phone, status, error)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (report_date) DO NOTHING`,
      [businessDate, s.owner_report_phone, result.status, result.error || null]
    );
  } catch (err) {
    console.error("[payment-report-scheduler] فشل التحقق/الإرسال:", err.message);
  }
}

function startPaymentReportScheduler() {
  maybeSendDailyReport();
  const interval = setInterval(maybeSendDailyReport, CHECK_INTERVAL_MS);
  interval.unref(); // ميمنعش الإغلاق النظيف للسيرفر (6I) من الخروج بسبب تايمر شغال
  return interval;
}

module.exports = { startPaymentReportScheduler, maybeSendDailyReport };
