// المرحلة 7S: إرسال رسالة SMS/واتساب - بيبعت لأي بوابة (Gateway) بتقبل نداء HTTP بسيط، بدل ما نربط
// مكتبة مزوّد بعينه (Twilio مثلًا) مش عندنا بيانات اعتماد حقيقية ليها نختبرها بيها فعليًا. أي بوابة محلية
// أو دولية بتدعم webhook بسيط (POST/GET بـ{to, message}) تقدر تتوصل من غير أي تعديل كود - بس متغيرات بيئة.
// من غير SMS_WEBHOOK_URL مضبوطة، الدالة بترجع not_configured من غير أي محاولة اتصال - عمدًا، عشان
// النظام يفضل شغال طبيعي قبل ما حد يجهّز بوابة حقيقية (زي بالظبط SYNC_API_KEY في db/sync-worker.js).
async function sendMessage({ phone, message }) {
  const url = process.env.SMS_WEBHOOK_URL;
  if (!url) {
    return { sent: false, status: "not_configured" };
  }
  const method = (process.env.SMS_WEBHOOK_METHOD || "POST").toUpperCase();
  const authHeader = process.env.SMS_WEBHOOK_AUTH_HEADER;
  try {
    let fetchUrl = url;
    const opts = { method, headers: {} };
    if (authHeader) opts.headers.Authorization = authHeader;
    if (method === "GET") {
      const qs = new URLSearchParams({ to: phone, message }).toString();
      fetchUrl = `${url}${url.includes("?") ? "&" : "?"}${qs}`;
    } else {
      opts.headers["Content-Type"] = "application/json";
      opts.body = JSON.stringify({ to: phone, message });
    }
    const res = await fetch(fetchUrl, opts);
    if (!res.ok) {
      return { sent: false, status: "failed", error: `HTTP ${res.status}` };
    }
    return { sent: true, status: "sent" };
  } catch (err) {
    return { sent: false, status: "failed", error: err.message };
  }
}

module.exports = { sendMessage };
