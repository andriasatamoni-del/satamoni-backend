// المرحلة 8.43: تكامل واتساب بزنس (Meta Cloud API) - إرسال رسالة نصية، والتحقق من صحة webhook (سواء
// التحقق الأولي وقت ربط الرقم في لوحة Meta، أو توقيع كل إشعار وارد بعد كده). نفس فلسفة db/sms-provider.js
// (بوابة HTTP بسيطة، من غير SDK رسمي) - هنا المزوّد ثابت (Meta) لأنه القرار المتفق عليه (Cloud API
// مباشرة، مش عن طريق BSP وسيط)، فالتكامل بيتكلم مع Graph API بتاعتها مباشرة بشكل الطلب المحدد بتاعها.
//
// متغيرات البيئة المطلوبة:
//   WHATSAPP_ACCESS_TOKEN     - توكن الوصول الدائم (System User token) من Meta Business Manager
//   WHATSAPP_PHONE_NUMBER_ID  - معرّف رقم الهاتف (مش الرقم نفسه) من WhatsApp Manager
//   WHATSAPP_VERIFY_TOKEN     - نص عشوائي إنت اخترته، بيتسجل في لوحة Meta وقت ربط الـwebhook للتحقق
//                               إن طلب GET التحقق فعلًا جاي من ميتا
//   WHATSAPP_APP_SECRET       - App Secret بتاع تطبيق Meta - بيتستخدم للتحقق من توقيع كل إشعار وارد
//                               (X-Hub-Signature-256) عشان نتأكد إنه فعلًا جاي من ميتا مش من أي حد
//                               عارف رابط الـwebhook بالصدفة
const crypto = require("crypto");

const GRAPH_API_VERSION = process.env.WHATSAPP_GRAPH_API_VERSION || "v21.0";

function isConfigured() {
  return Boolean(process.env.WHATSAPP_ACCESS_TOKEN && process.env.WHATSAPP_PHONE_NUMBER_ID);
}

// بيبعت رسالة نص عادية لرقم عميل - لو مفيش بيانات اعتماد مظبوطة بيرجع not_configured من غير أي محاولة
// اتصال (نفس فلسفة db/sms-provider.js بالظبط) عشان النظام يفضل شغال طبيعي قبل ما حد يجهّز البوابة فعليًا
async function sendMessage({ to, text }) {
  if (!isConfigured()) {
    return { sent: false, status: "not_configured" };
  }
  const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to,
        type: "text",
        text: { body: text, preview_url: false },
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return { sent: false, status: "failed", error: data?.error?.message || `HTTP ${res.status}` };
    }
    return { sent: true, status: "sent", waMessageId: data?.messages?.[0]?.id || null };
  } catch (err) {
    return { sent: false, status: "failed", error: err.message };
  }
}

// خطوة التحقق الأولى وقت ربط رابط الـwebhook في لوحة Meta (GET بـhub.mode/hub.verify_token/hub.challenge) -
// بيرجّع نص الـchallenge لو الـtoken مطابق للي محفوظ في WHATSAPP_VERIFY_TOKEN، أو null لو مش مطابق
function verifyHandshake({ mode, token, challenge }) {
  if (mode === "subscribe" && token && process.env.WHATSAPP_VERIFY_TOKEN && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    return challenge;
  }
  return null;
}

// كل إشعار وارد فعلي (رسالة عميل جديدة، تحديث حالة تسليم...) بيوصل بتوقيع HMAC-SHA256 في هيدر
// X-Hub-Signature-256 محسوب على جسم الطلب الخام بمفتاح App Secret - من غير التحقق ده أي حد عارف رابط
// الـwebhook (مش سري بطبيعته، بيتسجل في لوحة عامة) يقدر يبعت رسايل واتساب مزيّفة للنظام. لازم rawBody
// (Buffer الخام قبل أي parsing - راجع server.js) عشان أي إعادة تسلسل JSON ممكن تغيّر بايت واحد وتخلي
// التوقيع يفشل حتى لو المحتوى "نفس الحاجة" منطقيًا
function verifySignature(rawBody, signatureHeader) {
  if (!process.env.WHATSAPP_APP_SECRET || !signatureHeader || !rawBody) return false;
  const expected = "sha256=" + crypto.createHmac("sha256", process.env.WHATSAPP_APP_SECRET).update(rawBody).digest("hex");
  const expectedBuf = Buffer.from(expected);
  const gotBuf = Buffer.from(signatureHeader);
  if (expectedBuf.length !== gotBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, gotBuf);
}

module.exports = { isConfigured, sendMessage, verifyHandshake, verifySignature };
