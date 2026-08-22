// المرحلة 6 (6B): كل الراوتس في المشروع (30+ ملف) بترجّع أخطاء غير متوقعة بنمط واحد ثابت:
// catch (err) { res.status(500).json({ error: err.message }) } - وده بيسرّب تفاصيل داخلية في
// الإنتاج (رسائل Postgres اللي ممكن تفضح أسماء جداول/أعمدة/قيود، أو أي تفصيل تنفيذي تاني) لأي حد
// بيبعت طلب. الحل هنا مقصود يكون بدون لمس ولا route واحد من الـ30+ ملف (خطر تعديل حقيقي ومساحة تغيير
// ضخمة لغرض بسيط) - middleware واحد بيعترض res.json() بس لما الحالة 5xx، بيسجل الخطأ الحقيقي في
// السيرفر (console.error - نفس نمط التسجيل المستخدم بالفعل في db/audit.js)، وبيرجّع رسالة عامة
// للعميل بدلها. الرسائل التجارية الواضحة (نقص مخزون/حالة غير صالحة/غير مصرّح) كلها بترجع بحالات
// 400/401/403/404/409/429 صراحة في كل مكان في الكود - مش متأثرة خالص لأننا بنفلتر 5xx بس.
// شغّال بس لما NODE_ENV=production - في التطوير/الاختبار السلوك زي ما هو (رسالة الخطأ الحقيقية
// كاملة) عشان الـdebugging ميتأثرش، ومفيش أي تغيير على سلوك الاختبارات الحالية (246+ اختبار).
function errorSanitizer(req, res, next) {
  if (process.env.NODE_ENV !== "production") return next();

  const originalJson = res.json.bind(res);
  res.json = (body) => {
    if (res.statusCode >= 500 && body && typeof body === "object" && "error" in body) {
      console.error(`[5xx] ${req.method} ${req.originalUrl}:`, body.error);
      return originalJson({ error: "حصل خطأ غير متوقع في السيرفر - تم تسجيله. جرب تاني أو تواصل مع الدعم الفني" });
    }
    return originalJson(body);
  };
  next();
}

module.exports = { errorSanitizer };
