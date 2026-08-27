// المرحلة 7S: تأكيد الطلب بـSMS/واتساب للعميل - بيتنادى بعد ما الطلب يتسجل بنجاح (COMMIT خلص بالفعل)،
// من غير ما يأثّر على نجاح/فشل تسجيل الطلب نفسه أبدًا - فشل الإرسال (أو مفيش بوابة متظبطة أصلًا) بيتسجل
// في order_notifications للمراجعة بس، مش بيرجّع خطأ للطلب.
const pool = require("./pool");
const { sendMessage } = require("./sms-provider");

// الأنواع اللي محتاجة تأكيد فعليًا - العميل مش قدّام الكاشير يشوف الفاتورة المطبوعة (دليفري/تيك أواي
// هاتفي)، على عكس الصالة (بيشوف الفاتورة على الطاولة) أو طلبات (المنصة نفسها بتبعت تأكيدها للعميل)
const NOTIFIABLE_ORDER_TYPES = ["delivery", "takeaway"];

async function maybeSendOrderConfirmation({ orderId, orderType, customerPhone, total }) {
  if (!customerPhone || !NOTIFIABLE_ORDER_TYPES.includes(orderType)) return;
  try {
    const settings = await pool.query("SELECT sms_confirmations_enabled FROM pos_settings WHERE id = 1");
    if (!settings.rows[0]?.sms_confirmations_enabled) return;

    const message = `ساتاموني - اتسجل طلبك رقم #${orderId} بمبلغ ${Number(total).toFixed(2)} ج.م. شكرًا لثقتك!`;
    const result = await sendMessage({ phone: customerPhone, message });

    await pool.query(
      `INSERT INTO order_notifications (order_id, channel, phone, message, status, error)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [orderId, "sms", customerPhone, message, result.status, result.error || null]
    );
  } catch (err) {
    console.error("order confirmation notification failed:", err.message);
  }
}

module.exports = { maybeSendOrderConfirmation };
