// المرحلة 8.18: طلبيات الفرع/طلبيات السنتر كيتشن/المشتريات/التصنيع/تخطيط التصنيع بقوا تابات جوة
// شاشة واحدة (satamoni-procurement-hub.html) بدل 5 بطاقات منفصلة في الصفحة الرئيسية - كل شاشة
// أصلية لسه شغالة بكودها الأصلي بالظبط (اتعرضت جوة iframe في الشاشة الجديدة، مفيش أي تعديل في
// كودها) عشان نتجنب تعارض متغيرات/فانكشنز مشتركة الاسم بين الخمس شاشات لو اتدمجوا في سكريبت واحد.
// بطاقة "purchasing" اتحوّلت لـ"procurement-hub" (نفس مكانها في الترتيب تقريبًا)، والأربع بطاقات
// التانية (requisitions/ck-requisitions/manufacturing/production-planning) اتشالوا لأنهم بقوا
// تابات جوة البطاقة دي مش شاشات منفصلة.
module.exports = {
  async up(client) {
    const existing = await client.query("SELECT tile_key FROM home_tiles WHERE tile_key = 'procurement-hub'");
    if (existing.rows.length === 0) {
      await client.query(
        `UPDATE home_tiles
         SET tile_key = 'procurement-hub', href = 'satamoni-procurement-hub.html', icon = '📦',
             title = 'المشتريات والتصنيع',
             description = 'طلبيات الفرع، طلبيات السنتر كيتشن، المشتريات، التصنيع والتعبئة، وتخطيط التصنيع - كل واحدة في تاب منفصل جوة شاشة واحدة'
         WHERE tile_key = 'purchasing'`
      );
    }
    await client.query(
      "DELETE FROM home_tiles WHERE tile_key IN ('requisitions', 'ck-requisitions', 'manufacturing', 'production-planning')"
    );
  },
};
