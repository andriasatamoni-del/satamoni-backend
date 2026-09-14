// المرحلة 9A-8: "تاريخ اليوم التجاري" (Business Date) لازم يتحسب دايمًا بتوقيت القاهرة (Africa/Cairo)،
// مش UTC (توقيت السيرفر الافتراضي على استضافة سحابية زي Render). new Date().toISOString().slice(0,10)
// بيرجّع تاريخ UTC - أي حاجة بتحصل في أول 2-3 ساعات بعد نص الليل بتوقيت القاهرة (يعني لسه إمبارح بتوقيت
// UTC) كانت بتتسجل بتاريخ "إمبارح" غلط: صف branch_days مكرر لنفس اليوم الفعلي، قيد محاسبي بيترحّل
// ليوم غلط، مصروف/مشترى كاشير بيظهر في تقرير اليوم الغلط. الفرق مهم: "Event Timestamp" (created_at،
// closed_at) - وقت حدوث الفعل فعليًا - UTC مظبوط ليه ومفيش داعي نغيّره؛ "Business Date" - اليوم
// التجاري/المحاسبي اللي الفعل ده بينتمي له - لازم يتحسب بتوقيت القاهرة دايمًا، مش UTC.
// نفس المنطق بالظبط اللي كان متطبّق في routes/branch-days.js (8.41) بس هنا معمم لكل حاجة تانية.
function getCairoBusinessDate(date = new Date()) {
  return date.toLocaleDateString("en-CA", { timeZone: "Africa/Cairo" });
}

// Payment Control & Reconciliation: الساعة الحالية بتوقيت القاهرة (0-23) - مستخدمة في
// db/payment-report-scheduler.js عشان تقرر إمتى تبعت التقرير اليومي، بنفس منطق getCairoBusinessDate
// بالظبط (توقيت السيرفر مش موثوق فيه لوحده)
function getCairoHour(date = new Date()) {
  return Number(date.toLocaleString("en-US", { timeZone: "Africa/Cairo", hour: "2-digit", hour12: false }));
}

module.exports = { getCairoBusinessDate, getCairoHour };
