// المرحلة 8.10: توضيح من صاحب المشروع بعد المرحلة 8.9 - الميزة المقصودة مكوّنة من جزئين:
// (1) ملاحظة حرة على سطر الطلب (عجينة رفيعة، مستوى تحمير زيادة...) - نص عرض بس للمطبخ/الإيصال.
// (2) "بدون <مكوّن>" بيتولّد تلقائيًا من مكوّنات وصفة الصنف نفسها وقت الطلب (مش مرفق مسمّى الأدمن
// لازم يجهّزه مقدّمًا زي المرحلة 8.9) - الكاشير بيختار أي مكوّن من الريسبي مباشرة يستبعده لسطر الطلب ده.
module.exports = {
  async up(client) {
    await client.query(`ALTER TABLE order_items ADD COLUMN IF NOT EXISTS notes TEXT`);
    await client.query(`
      CREATE TABLE IF NOT EXISTS order_item_excluded_ingredients (
        id                 SERIAL PRIMARY KEY,
        order_item_id      INTEGER REFERENCES order_items(id) ON DELETE CASCADE,
        inventory_item_id  INTEGER REFERENCES inventory_items(id),
        UNIQUE(order_item_id, inventory_item_id)
      )
    `);
  },
};
