// المرحلة 7S/8.40: رسائل واتساب للعميل (تأكيد الطلب وقت التسجيل + طلب تقييم بعد التسليم/الاستلام) -
// بتتنادى بعد ما التغيير المعني يتسجل بنجاح (COMMIT خلص بالفعل)، من غير ما يأثّر على نجاح/فشل العملية
// نفسها أبدًا - فشل الإرسال (أو مفيش بوابة متظبطة أصلًا) بيتسجل في order_notifications للمراجعة بس،
// مش بيرجّع خطأ للطلب.
const pool = require("./pool");
const { sendMessage } = require("./sms-provider");

// الأنواع اللي محتاجة رسائل فعليًا - العميل مش قدّام الكاشير يشوف الفاتورة المطبوعة (دليفري/تيك أواي
// هاتفي)، على عكس الصالة (بيشوف الفاتورة على الطاولة) أو طلبات (المنصة نفسها بتبعت تأكيدها للعميل)
const NOTIFIABLE_ORDER_TYPES = ["delivery", "takeaway"];

async function sendAndLog({ orderId, kind, phone, message }) {
  const result = await sendMessage({ phone, message });
  await pool.query(
    `INSERT INTO order_notifications (order_id, channel, kind, phone, message, status, error)
     VALUES ($1,'whatsapp',$2,$3,$4,$5,$6)`,
    [orderId, kind, phone, message, result.status, result.error || null]
  );
}

async function maybeSendOrderConfirmation({ orderId, orderType, customerPhone, total }) {
  if (!customerPhone || !NOTIFIABLE_ORDER_TYPES.includes(orderType)) return;
  try {
    const settings = await pool.query("SELECT sms_confirmations_enabled FROM pos_settings WHERE id = 1");
    if (!settings.rows[0]?.sms_confirmations_enabled) return;

    const message = `ستاموني - اتسجل طلبك رقم #${orderId} بمبلغ ${Number(total).toFixed(2)} ج.م. شكرًا لثقتك!`;
    await sendAndLog({ orderId, kind: "confirmation", phone: customerPhone, message });
  } catch (err) {
    console.error("order confirmation notification failed:", err.message);
  }
}

// بتتنادى لحظة ما الطلب يوصل فعليًا للعميل - "completed" لطلبات الدليفري (الطيار رجع/العميل استلم،
// PATCH /:id/status)، و"READY" لطلبات التيك أواي الهاتفي (المطبخ خلّص التحضير، PATCH /:id/kitchen-status -
// أقرب إشارة موجودة فعليًا لـ"الطلب بقى جاهز للعميل" لأن مفيش تتبّع منفصل لحظة الاستلام الفعلي في الفرع)
async function maybeSendRatingRequest({ orderId, orderType, customerPhone, baseUrl }) {
  if (!customerPhone || !NOTIFIABLE_ORDER_TYPES.includes(orderType)) return;
  try {
    const settings = await pool.query("SELECT sms_rating_requests_enabled FROM pos_settings WHERE id = 1");
    if (!settings.rows[0]?.sms_rating_requests_enabled) return;

    const orderRow = await pool.query("SELECT rating_token FROM orders WHERE id = $1", [orderId]);
    const token = orderRow.rows[0]?.rating_token;
    if (!token) return;

    const link = `${baseUrl}/rate.html?order=${orderId}&token=${token}`;
    const message = `ستاموني - نورتنا! ممكن تقيّم تجربتك مع طلب رقم #${orderId} من هنا: ${link}`;
    await sendAndLog({ orderId, kind: "rating_request", phone: customerPhone, message });
  } catch (err) {
    console.error("order rating request notification failed:", err.message);
  }
}

module.exports = { maybeSendOrderConfirmation, maybeSendRatingRequest };
