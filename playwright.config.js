// المرحلة 8F: تكوين Playwright لاختبارات المتصفح الحقيقية - سيرفر مستقل + قاعدة بيانات مؤقتة منفصلة
// عن Jest (اللي بيستخدم schema.sql فاضي جوه tests/global-setup.js) وعن قاعدة التطوير المشتركة
module.exports = {
  testDir: "./tests-e2e",
  timeout: 30000,
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: process.env.PW_BASE_URL || "http://localhost:4003",
    headless: true,
    launchOptions: {
      executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
    },
  },
};
