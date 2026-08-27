// المرحلة 8B: أي راوت بياخد :id عددي في المسار (زي /api/orders/:id) وبيسيبه يوصل لاستعلام SQL من غير
// تحقق، بيرمي خطأ Postgres خام (invalid input syntax for type integer) كـ500 بدل 400 واضح - اتكشف ده
// فعليًا وقت هجوم أمني حي على /api/orders/not-a-number. الرسالة نفسها متسربتش فعليًا للإنتاج (middleware/
// error-sanitizer.js بيعترضها فعلًا)، لكن الحالة (500) غلط - بتوهم لوحة المراقبة إن في خطأ سيرفر حقيقي
// بدل مجرد مدخل غلط من العميل. الحل هنا عام وقابل لإعادة الاستخدام على أي router.param("id", ...).
function validateIdParam(req, res, next, id) {
  if (!/^\d+$/.test(id)) {
    return res.status(400).json({ error: "معرّف غير صالح" });
  }
  next();
}

module.exports = { validateIdParam };
