// المرحلة 8.20: إعدادات الطباعة بقت تاب جوة "المنيو والإعدادات" (satamoni-menu.html) بدل بطاقة
// منفصلة - نفس شاشة satamoni-printing.html الأصلية بالظبط جوة iframe، من غير أي تعديل في كودها.
// ملحوظة: الشاشة الأصلية بيستخدمها أدمن ومدير الفرع، لكن شاشة المنيو مقفولة على الأدمن بس - مدير
// الفرع لسه يقدر يوصل لإعدادات الطباعة من رابط satamoni-printing.html المباشر (شغال بكامل صلاحياته
// زي ما هو)، بس مش هيلاقي بطاقة منفصلة ليها في الصفحة الرئيسية بعد النهاردة.
module.exports = {
  async up(client) {
    await client.query("DELETE FROM home_tiles WHERE tile_key = 'printing'");
    await client.query(
      `UPDATE home_tiles
       SET description = 'إضافة الأصناف والأسعار، مناطق التوصيل، طرق الدفع، وإعدادات الطباعة'
       WHERE tile_key = 'menu'`
    );
  },
};
