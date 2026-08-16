require("dotenv").config();
const path = require("path");
const express = require("express");
const cors = require("cors");

const app = express();
app.use(cors());
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

app.get("/health", (req, res) => res.json({ status: "ok" }));

const PORT = process.env.PORT || 4000;
// بيشتغل السيرفر فعليًا بس لو الملف ده اتشغل مباشرة (node server.js / npm start / npm run dev) - لو
// ملف تاني عمله require (زي tests/) بيستخدم الـapp من غير ما يفتح بورت حقيقي، عشان supertest يقدر
// يبعت طلبات للـapp في نفس الـprocess من غير سيرفر شغال فعليًا
if (require.main === module) {
  app.listen(PORT, () => console.log(`Satamoni backend running on port ${PORT}`));
}
module.exports = app;
