// المرحلة 8.43: branches.last_synced_at - آخر نبضة (heartbeat) وصلت من فرع شغال بالوضع المحلي (راجع
// db/schema.sql للتوثيق الكامل) - عشان شاشة الكول سنتر تقدر تحذّر لو الفرع ممكن يكون قاطع نت دلوقتي
module.exports = {
  async up(client) {
    await client.query(`ALTER TABLE branches ADD COLUMN IF NOT EXISTS last_synced_at TIMESTAMPTZ`);
  },
};
