const { Pool } = require("pg");

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// المرحلة 6 (6F): pg.Pool بيطلق event اسمه 'error' على مستوى الـpool نفسه (مش كل query عادي - ده
// أصلًا بيترفض بالـpromise) لما اتصال idle في الـpool يواجه مشكلة على مستوى السيرفر (انقطاع شبكة،
// إعادة تشغيل قاعدة البيانات، حد قفل الاتصال يدويًا). من غير listener هنا، Node بيعامل الـevent ده
// كـuncaught exception على EventEmitter وبيطيح الـprocess كله فورًا - كل الطلبات التانية الشغالة
// وقتها بتتقطع مش بس اللي كانت مستخدمة الاتصال ده، وده أخطر بكتير من مجرد فشل query واحد. بنسجّل
// الخطأ فقط، الـpool نفسه بيستبدل الاتصال المكسور تلقائيًا (سلوك pg الافتراضي) من غير أي تدخل زيادة.
pool.on("error", (err) => {
  console.error(JSON.stringify({ timestamp: new Date().toISOString(), event: "db_pool_error", message: err.message }));
});

module.exports = pool;
