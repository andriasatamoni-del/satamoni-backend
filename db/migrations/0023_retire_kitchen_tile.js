// المرحلة 8.19: satamoni-kitchen.html اتلغت نهائيًا - كل تاباتها الخمسة بقى ليها بديل في مكان تاني:
// "اطلب من السنتر كيتشن"/"تنفيذ الطلبيات"/"التصنيع" أغنى وأحدث في satamoni-procurement-hub.html
// (المرحلة 8.18)، و"جرد المخزون"/"تسجيل هالك" اتنقلوا بالظبط لـsatamoni-requisitions.html (تاب
// "طلبيات الفرع" جوة نفس الشاشة المدمجة) بدل ما يفضلوا في شاشة مستقلة. البطاقة بتاعتها اتشالت من
// الصفحة الرئيسية.
module.exports = {
  async up(client) {
    await client.query("DELETE FROM home_tiles WHERE tile_key = 'kitchen'");
  },
};
