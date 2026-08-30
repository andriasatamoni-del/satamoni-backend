// المرحلة 6 (6B): هيدرز أمان أساسية على كل رد - بدون ما تكسر أي صفحة من صفحات public/ الحالية.
// عمدًا مفيش Content-Security-Policy هنا: كل الصفحات (public/*.html) عندها <script> inline
// (اتأكدنا فعليًا - 13 من 14 صفحة)، وCSP افتراضي بيمنع inline scripts إلا لو 'unsafe-inline'
// (بتلغي فايدة الحماية الأساسية) أو nonce/hash لكل سطر سكريبت (إعادة كتابة كل الفرونت إند - مش
// مطلوب في المرحلة دي وخطر يكسر حاجة). باقي الهيدرز تحت آمنة 100% ومالهاش أي تأثير سلبي على أي
// سلوك حالي.
// المرحلة 8.18: X-Frame-Options اتغيّرت من DENY لـSAMEORIGIN - satamoni-procurement-hub.html بتعرض
// 5 شاشات تانية (طلبيات الفرع/السنتر كيتشن/المشتريات/التصنيع/تخطيط التصنيع) جوة iframe عشان تبقى
// شاشة واحدة بتابات من غير ما نلمس كود الشاشات الخمسة نفسها (تجنّب تعارض متغيرات/فانكشنز مشتركة
// الاسم بينهم - كانت مكتوبة كتطبيقات مستقلة). SAMEORIGIN لسه بيمنع تمامًا أي موقع خارجي يعمل frame
// لأي صفحة من صفحاتنا (نفس حماية clickjacking الأصلية) - بس بيسمح بس لصفحاتنا هي نفسها تعمل frame
// لبعض، وده مطلوب هنا فعلًا.
function securityHeaders(req, res, next) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  // HSTS بس في الإنتاج - لو اتبعتت في بيئة من غير HTTPS فعلي (تجربة محلية/شبكة داخلية من غير شهادة)،
  // المتصفح ممكن يحفظها ويجبر HTTPS على زيارات لاحقة حتى لو السيرفر مش بيقدّمها فعلًا، فبتكسر
  // الوصول. الشرط ده متسق مع نفس منطق CORS_ORIGINS/production في middleware/cors.js بالظبط.
  if (process.env.NODE_ENV === "production") {
    res.setHeader("Strict-Transport-Security", "max-age=15552000; includeSubDomains");
  }
  next();
}

module.exports = { securityHeaders };
