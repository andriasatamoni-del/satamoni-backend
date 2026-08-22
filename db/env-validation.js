// المرحلة 6 (6I): قبل كده لو DATABASE_URL مش محددة، السيرفر كان بيقبل يشتغل عادي وبيبان شغال (health
// check هيرجع 503 لحد ما حد يلاحظ)، ولو JWT_SECRET مش محددة كان بيطيح بـexception خام جوه سلسلة
// require عميقة (middleware/auth.js) برسالة واحدة بس، مش تقرير واضح بكل المشاكل مع بعض. الدالة دي
// بتتفحص كل متغيرات البيئة المهمة مرة واحدة بدري (قبل أي require لكود التطبيق نفسه) وترجع تقرير كامل
// (errors تمنع التشغيل، warnings بس تنبيه) - عشان لو أكتر من حاجة ناقصة/غلط، الشخص اللي بينشر يشوفهم
// كلهم مرة واحدة مش واحد لكل محاولة تشغيل.
function validateEnv(env = process.env) {
  const errors = [];
  const warnings = [];

  if (!env.DATABASE_URL) {
    errors.push("DATABASE_URL غير محددة - لازم رابط اتصال Postgres صالح (postgresql://user:pass@host:port/db)");
  }

  if (!env.JWT_SECRET) {
    errors.push("JWT_SECRET غير محددة - لازم قيمة سرية عشوائية طويلة لتوقيع جلسات الدخول");
  } else if (env.JWT_SECRET.length < 16) {
    warnings.push("JWT_SECRET قصيرة جدًا (أقل من 16 حرف) - ممكن تتخمّن، يُفضّل قيمة عشوائية أطول وأقوى");
  }

  if (env.NODE_ENV && !["development", "production", "test"].includes(env.NODE_ENV)) {
    warnings.push(`NODE_ENV = "${env.NODE_ENV}" مش قيمة معروفة (المتوقع development/production/test) - السلوكيات المرتبطة بيها (CORS، رسائل الخطأ) ممكن تتصرف بشكل غير متوقع`);
  }

  if (env.NODE_ENV === "production") {
    if (!env.CORS_ORIGINS) {
      warnings.push("الإنتاج (NODE_ENV=production) من غير CORS_ORIGINS - افتراضيًا هيتم رفض أي طلب API من origin خارجي (آمن)، بس لو الواجهة الأمامية بتتقدّم من origin مختلف هتحتاج تحددها صراحة");
    }
    if (env.JWT_SECRET === "jest_test_secret_do_not_use_in_production") {
      errors.push("JWT_SECRET في الإنتاج لسه بقيمة الاختبار الافتراضية - لازم تتغيّر قبل أي نشر حقيقي");
    }
  }

  if (env.PORT && (Number.isNaN(Number(env.PORT)) || Number(env.PORT) <= 0)) {
    errors.push(`PORT = "${env.PORT}" مش رقم منفذ صالح`);
  }

  return { errors, warnings };
}

module.exports = { validateEnv };
