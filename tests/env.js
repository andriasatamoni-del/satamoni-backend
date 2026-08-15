// بيتشغل قبل أي require لكود التطبيق في كل ملف اختبار - بيضمن إن db/pool.js وroutes/auth.js هيقرأوا
// إعدادات الاختبار (قاعدة بيانات منفصلة، JWT_SECRET تجريبي) مش أي .env حقيقي موجود على الجهاز
const { TEST_DATABASE_URL } = require("./db-config");
process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.JWT_SECRET = process.env.JWT_SECRET || "jest_test_secret_do_not_use_in_production";
process.env.PORT = "0";
