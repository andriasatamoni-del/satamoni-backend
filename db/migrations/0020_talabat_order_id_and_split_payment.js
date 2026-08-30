// المرحلة 8.16: رقم أوردر طلبات (لسهولة المراجعة) + جزء نقدي من أوردرات طلبات (باقيها آجل - حساب 1350)
module.exports = {
  async up(client) {
    await client.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS talabat_order_id TEXT`);
    await client.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS talabat_cash_collected NUMERIC NOT NULL DEFAULT 0`);
  },
};
