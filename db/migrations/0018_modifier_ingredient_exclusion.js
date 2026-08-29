// "بدون" modifiers (بدون طماطم/بدون خضار/بدون سدق..) كانت بتتسجل زي أي مرفق تاني، مفيش أي ربط بينها
// وبين المكوّن الفعلي في وصفة الصنف - يعني اختيار "بدون سدق" على الفاتورة كان مبيغيّرش خصم المخزون ولا
// تكلفة البيع خالص (السدق كان لسه بينخصم/بيتحسب زي لو العميل طلبه عادي). الإضافة دي بتربط أي مرفق
// بمكوّن واحد اختياري من `menu_item_variant_ingredients` بتاع نفس الصنف - لما المرفق ده يتختار في طلب،
// المكوّن ده بيتشال من حساب الاستهلاك والتكلفة لسطر الطلب ده بالظبط (مش من الوصفة الأصلية نفسها -
// الوصفة فضلت زي ما هي، الاستثناء بيحصل وقت البيع بس). عمودين بس، إضافة بحتة:
// - menu_item_modifiers.excluded_ingredient_item_id: أي مرفق ممكن (اختياريًا) يشاور على مكوّن يتستبعد
// - order_item_modifiers.excluded_ingredient_item_id: نسخة (snapshot) وقت البيع - لو المرفق اتغيّر ربطه
//   بمكوّن تاني بعدين، الطلبات القديمة تفضل دقيقة زي ما كانت وقت البيع بالظبط (نفس نمط name_at_sale/price_at_sale)
module.exports = {
  async up(client) {
    await client.query(`
      ALTER TABLE menu_item_modifiers
      ADD COLUMN IF NOT EXISTS excluded_ingredient_item_id INTEGER REFERENCES inventory_items(id)
    `);
    await client.query(`
      ALTER TABLE order_item_modifiers
      ADD COLUMN IF NOT EXISTS excluded_ingredient_item_id INTEGER REFERENCES inventory_items(id)
    `);
  },
};
