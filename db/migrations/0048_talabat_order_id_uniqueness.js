// كنترول حقيقي مش مجرد تنبيه (مهمة تحسينات الإنتاج - PHASE 4: External Channel Reconciliation):
// orders.talabat_order_id بيتكتب يدوي من الكاشير زي ما هو ظاهر في تطبيق طلبات (مش FK ولا مقيّد بصيغة -
// راجع تعليق العمود في db/schema.sql) وكان مفيش أي حماية تمنع تسجيل نفس أوردر طلبات الحقيقي مرتين
// بالغلط (نفس فئة مشكلة duplicate invoice number اللي supplier_invoices اتحلّت بـUNIQUE(supplier_id,
// supplier_invoice_number) بالظبط). فهرس فريد جزئي هنا: يمنع نفس الرقم بين طلبات لسه حيّة (مش ملغاة)
// بس - طلب اتلغى (voided) وأعيد تسجيله بنفس الرقم (تصحيح غلطة إدخال) لسه مسموح عمدًا، ده سلوك مقصود
// مش استثناء غير مكتمل.
//
// دفاعي مع بيانات إنتاج قديمة محتمل فيها تكرار من قبل أي حماية: لو فيه تكرار فعلي موجود بالفعل،
// CREATE UNIQUE INDEX هترمي 23505، وnظام الترحيل (db/migrate.js) بيتعامل مع الكود ده بالفعل كحالة
// "لسه مطبّق" ويعيد المحاولة تلقائيًا في كل تشغيل سيرفر جديد من غير ما يعطّل الإقلاع - يعني الفهرس هيتفعّل
// لوحده أول ما حد ينضّف التكرار القديم (لو موجود)، من غير أي تدخل يدوي إضافي على نظام الترحيل نفسه.
module.exports = {
  async up(client) {
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_talabat_order_id_live
      ON orders(talabat_order_id)
      WHERE source = 'talabat' AND talabat_order_id IS NOT NULL AND talabat_order_id <> '' AND voided = FALSE
    `);
  },
};
