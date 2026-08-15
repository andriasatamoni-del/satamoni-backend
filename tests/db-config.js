// قاعدة بيانات منفصلة تمامًا مخصّصة للاختبارات - بتتصفّر (DROP+CREATE) قبل كل تشغيل لـnpm test، فمينفعش
// تكون نفس قاعدة التطوير أو الإنتاج أبدًا. قابلة للتغيير عن طريق TEST_DATABASE_URL (مفيدة في CI).
const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL || "postgresql://postgres:test123@localhost:5432/satamoni_jest_test";

module.exports = { TEST_DATABASE_URL };
