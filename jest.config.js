module.exports = {
  testEnvironment: "node",
  globalSetup: "./tests/global-setup.js",
  setupFiles: ["./tests/env.js"],
  testMatch: ["**/tests/**/*.test.js"],
  testTimeout: 30000,
  // الاختبارات دي بتشتغل ضد قاعدة بيانات Postgres حقيقية مشتركة، مش mocks - لازم تتشغل بالترتيب
  // (مش متوازية) عشان تتجنب تعارض حالة بين ملفات الاختبار المختلفة على نفس القاعدة
  maxWorkers: 1,
};
