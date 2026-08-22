// المرحلة 6 (6B): دالة صرفة (pure) بتحسب إعدادات CORS من متغيرات البيئة - مفصولة عن server.js عشان
// تتقدر تتاختبر مباشرة من غير ما تحتاج تعمل require لكل التطبيق (وده كان بيفتح Pool اتصال قاعدة بيانات
// جديد في كل مرة وقت الاختبار، اتسرّب وماكانش بيتقفل). بتاخد env بدل ما تقرا process.env مباشرة
// عشان تفضل قابلة للاختبار بأي قيم من غير ما تلمس متغيرات البيئة الحقيقية للـprocess كله.
function getCorsOptions(env = process.env) {
  const origins = (env.CORS_ORIGINS || "").split(",").map((o) => o.trim()).filter(Boolean);
  if (origins.length > 0) return { origin: origins };
  if (env.NODE_ENV === "production") return { origin: false };
  return {};
}

module.exports = { getCorsOptions };
