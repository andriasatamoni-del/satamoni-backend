const { Pool } = require("pg");

// المرحلة 6 (6G): كان الـPool من غير أي إعدادات صريحة (max/idleTimeoutMillis/connectionTimeoutMillis) -
// بيشتغل بالقيم الافتراضية لمكتبة pg (max=10 عادةً) اللي مش موثّقة ومش متحكم فيها. الفروع بتستخدم نفس
// الـPool، فلو الحمل زاد (فرع جديد اتضاف، وقت ذروة) الـmax الافتراضي ممكن يبقى قليل من غير أي تحذير أو
// طريقة تتحكم فيها من غير تعديل كود. دلوقتي كل قيمة قابلة للتحكم عن طريق env var بقيمة افتراضية معقولة:
// DB_POOL_MAX (أقصى عدد اتصالات مفتوحة في نفس الوقت)، DB_POOL_IDLE_TIMEOUT_MS (بعد قد إيه اتصال idle
// بيتقفل تلقائيًا)، DB_POOL_CONNECTION_TIMEOUT_MS (أقصى وقت انتظار للحصول على اتصال قبل ما يرمي خطأ -
// بديل أفضل من انتظار معلّق للأبد لو الـpool اتخنق بالكامل).
// المرحلة 7A: كان الـPool من غير أي إعداد SSL خالص - قواعد بيانات مُدارة سحابية (Render، RDS، إلخ)
// بترفض أي اتصال من غير SSL افتراضيًا، فمن غير الإعداد ده أول محاولة اتصال بأي بيئة staging/إنتاج
// سحابية كانت هتفشل فورًا. الشهادة نفسها عادةً من CA وسيط مش موجود في trust store الافتراضي لـNode،
// فـ`rejectUnauthorized: false` هو اللي غالبية مزوّدي الاستضافة المُدارة (Render/Heroku) بيوثّقوه رسميًا
// كإعداد قياسي - بس ده لسه محتاج تأكيد من توثيق المزوّد الفعلي وقت النشر الحقيقي (مش مفترض هنا كأمر
// واقع، `DB_SSL` اختياري صراحة زي بقية إعدادات الـPool وdefault-هـ false عشان ميأثرش على أي بيئة محلية
// حالية بتشتغل عادي من غيره)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: Number(process.env.DB_POOL_MAX || 20),
  idleTimeoutMillis: Number(process.env.DB_POOL_IDLE_TIMEOUT_MS || 30000),
  connectionTimeoutMillis: Number(process.env.DB_POOL_CONNECTION_TIMEOUT_MS || 5000),
  ssl: process.env.DB_SSL === "true" ? { rejectUnauthorized: false } : false,
});

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
