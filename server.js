require("dotenv").config();
const path = require("path");
const express = require("express");
const cors = require("cors");
const { getCorsOptions } = require("./middleware/cors");
const { securityHeaders } = require("./middleware/security-headers");
const { errorSanitizer } = require("./middleware/error-sanitizer");
const { requestLogger } = require("./middleware/request-logger");
const pool = require("./db/pool");

const app = express();
app.use(securityHeaders);
app.use(errorSanitizer);
app.use(requestLogger);

// المرحلة 6 (6B): كان cors() من غير أي إعدادات - بيسمح لأي origin يبعت طلب، وده خطر حقيقي أول ما
// السيرفر ده يتعرض على الإنترنت العام (حتى مع Bearer token مش cookies - أي origin برضه يقدر يقرا
// رد أي endpoint من غير موافقة صريحة). CORS_ORIGINS: قايمة origins مفصولة بفاصلة (بيئة الإنتاج لازم
// تحددها صراحة). لو مش محددة: في الإنتاج (NODE_ENV=production) منمنع أي cross-origin تمامًا (الصفحات
// الثابتة في public/ بتتقدّم من نفس الـorigin أصلًا فمش متأثرة - المنع بس لأي استدعاء API من origin
// خارجي)؛ في التطوير (مفيش NODE_ENV=production) بنسمح بالكل زي قبل كده عشان الراحة أثناء التطوير.
app.use(cors(getCorsOptions()));
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.use("/api/auth", require("./routes/auth"));
app.use("/api/users", require("./routes/users"));
app.use("/api/branches", require("./routes/branches"));
app.use("/api/menu", require("./routes/menu"));
app.use("/api/combos", require("./routes/combos"));
app.use("/api/orders", require("./routes/orders"));
app.use("/api/inventory", require("./routes/inventory"));
app.use("/api/expenses", require("./routes/expenses"));
app.use("/api/purchases", require("./routes/purchases"));
app.use("/api/kitchen-transfers", require("./routes/kitchen-transfers"));
app.use("/api/kitchen-orders", require("./routes/kitchen-orders"));
app.use("/api/suppliers", require("./routes/suppliers"));
app.use("/api/cash-sessions", require("./routes/cash-sessions"));
app.use("/api/customers", require("./routes/customers"));
app.use("/api/hr", require("./routes/hr"));
app.use("/api/sync", require("./routes/sync"));
app.use("/api/reports", require("./routes/reports"));
app.use("/api/payroll", require("./routes/payroll"));
app.use("/api/config", require("./routes/config"));
app.use("/api/pos-settings", require("./routes/pos-settings"));
app.use("/api/audit-logs", require("./routes/audit"));
app.use("/api/approvals", require("./routes/approvals"));
app.use("/api/recipes", require("./routes/recipes"));
app.use("/api/production", require("./routes/production"));
app.use("/api/purchase-requests", require("./routes/purchase-requests"));
app.use("/api/purchase-orders", require("./routes/purchase-orders"));
app.use("/api/goods-receipts", require("./routes/goods-receipts"));
app.use("/api/accounting", require("./routes/accounting"));
app.use("/api/supplier-payments", require("./routes/supplier-payments"));

// المرحلة 6 (6F): /health كان بيرجّع "ok" ثابتة دايمًا حتى لو قاعدة البيانات مش شغالة خالص - ده بيخلي
// أي مراقبة/health-check بتعتمد عليه (لوحة تحكم استضافة، uptime monitor) تعتقد السيرفر تمام رغم إن
// كل طلب حقيقي هيفشل. دلوقتي بيتحقق فعليًا من الاتصال بقاعدة البيانات (SELECT 1 بمهلة قصيرة)، وبيفرّق
// صراحة بين "السيرفر شغال بس القاعدة مش وصلة" (503) و"كله تمام" (200) - من غير تسريب أي تفصيل داخلي
// (رسالة خطأ Postgres الخام، اسم القاعدة، إلخ) في الرد نفسه.
app.get("/health", async (req, res) => {
  // ملحوظة: Promise.race لوحده بيسيب الـsetTimeout شغال (timer معلّق) حتى لو الـquery خلصت أول
  // منه - بيفضل يستهلك event loop لحد 3 ثواني بعد كل health check لوحده. بنمسحه صراحة بـclearTimeout
  // في الحالتين (نجاح أو فشل) عشان ما يفضلش تايمر معلّق، خصوصًا مهم وقت إيقاف السيرفر بأمان (graceful
  // shutdown في 6I) وعشان الاختبارات تقفل بنظافة.
  let timeoutId;
  try {
    await Promise.race([
      pool.query("SELECT 1"),
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error("timeout")), 3000);
      }),
    ]);
    clearTimeout(timeoutId);
    res.json({ status: "ok", db: "ok" });
  } catch (err) {
    clearTimeout(timeoutId);
    console.error(JSON.stringify({ timestamp: new Date().toISOString(), event: "health_check_db_failure", message: err.message }));
    res.status(503).json({ status: "degraded", db: "unreachable" });
  }
});

const PORT = process.env.PORT || 4000;
// بيشتغل السيرفر فعليًا بس لو الملف ده اتشغل مباشرة (node server.js / npm start / npm run dev) - لو
// ملف تاني عمله require (زي tests/) بيستخدم الـapp من غير ما يفتح بورت حقيقي، عشان supertest يقدر
// يبعت طلبات للـapp في نفس الـprocess من غير سيرفر شغال فعليًا
if (require.main === module) {
  app.listen(PORT, () => console.log(`Satamoni backend running on port ${PORT}`));
}
module.exports = app;
