// المرحلة 8.46: تكامل فيسبوك ماسنجر وإنستجرام (Meta Graph API) - نفس فلسفة db/whatsapp-client.js
// (بوابة HTTP بسيطة من غير SDK رسمي)، بس القناتين دول بيتبعتلهم عن طريق نفس Send API بتاع صفحة فيسبوك
// (POST /me/messages) - الفرق الوحيد هو التوكن المستخدم (Page Access Token لماسنجر، أو نفس التوكن لو
// مربوط بحساب إنستجرام بزنس مرتبط بنفس الصفحة - راجع docs/WHATSAPP-AUTOMATION.md قسم 7).
//
// توقيع الـwebhook (X-Hub-Signature-256) بيتحقق منه بنفس WHATSAPP_APP_SECRET الموجود أصلًا - ده مش
// غلط في التسمية: الـApp Secret بتاع تطبيق ميتا واحد لكل التطبيق، بيوقّع كل إشعارات كل المنتجات
// (واتساب/ماسنجر/إنستجرام) اللي التطبيق ده مشترك فيها، فمفيش داعي لمتغيّر منفصل لكل قناة.
//
// متغيرات البيئة:
//   FACEBOOK_PAGE_ACCESS_TOKEN - توكن وصول صفحة فيسبوك المطعم (بيُستخدم لماسنجر ولإنستجرام لو
//                                حساب الإنستجرام بزنس مربوط بنفس الصفحة دي)
const GRAPH_API_VERSION = process.env.WHATSAPP_GRAPH_API_VERSION || "v21.0";

function isConfigured() {
  return Boolean(process.env.FACEBOOK_PAGE_ACCESS_TOKEN);
}

// بيبعت رسالة نص عادية - channel هنا مش مؤثر فعليًا في شكل الطلب (نفس الـSend API لفيسبوك وإنستجرام)،
// بس موجود عشان يفضل الاستدعاء واضح المصدر من كود القناة اللي بيستخدمه (راجع conversation.js)
async function sendMessage({ to, text }) {
  if (!isConfigured()) {
    return { sent: false, status: "not_configured" };
  }
  const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/me/messages?access_token=${process.env.FACEBOOK_PAGE_ACCESS_TOKEN}`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ recipient: { id: to }, message: { text } }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return { sent: false, status: "failed", error: data?.error?.message || `HTTP ${res.status}` };
    }
    return { sent: true, status: "sent", messageId: data?.message_id || null };
  } catch (err) {
    return { sent: false, status: "failed", error: err.message };
  }
}

module.exports = { isConfigured, sendMessage };
