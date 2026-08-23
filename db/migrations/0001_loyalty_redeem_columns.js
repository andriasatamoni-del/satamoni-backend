// خصم نقاط الولاء (استخدام رصيد العميل كخصم على الطلب) - أول ترحيل في النظام الجديد. الأعمدة دي
// كانت لازم تتضاف يدويًا على قاعدة الإنتاج قبل ما نظام الترحيل التلقائي ده يتبنى - أي تثبيت جديد من
// الصفر ياخدها أصلًا من db/schema.sql مباشرة، فتشغيل الترحيل ده هيبقى no-op آمن في الحالة دي
module.exports = {
  async up(client) {
    await client.query(`ALTER TABLE pos_settings ADD COLUMN IF NOT EXISTS loyalty_redeem_value_egp NUMERIC NOT NULL DEFAULT 0.1`);
    await client.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS loyalty_points_redeemed INTEGER NOT NULL DEFAULT 0`);
    await client.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS loyalty_redeem_value NUMERIC NOT NULL DEFAULT 0`);
  },
};
