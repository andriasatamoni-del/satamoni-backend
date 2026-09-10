// المرحلة 8.55: علامة مميزة الطلب (بجوار كذا، لون العمارة...) كانت بتتسجل في ملف العميل (customers)
// بس - مش على الطلب نفسه، فالإيصال/تذكرة المطبخ مقدروش يعرضوها لأي طلب أبدًا. راجع db/schema.sql
module.exports = {
  async up(client) {
    await client.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS distinguishing_mark TEXT`);
  },
};
