// تعطيل قسم كامل من المنيو (بدل ما تتعطّل كل أصنافه واحد واحد) - نفس فلسفة menu_items.is_active بالظبط.
// راجع db/schema.sql لشرح إزاي بيتفلتر في GET /api/menu وGET /api/config/full.
module.exports = {
  async up(client) {
    await client.query(`ALTER TABLE menu_categories ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE`);
  },
};
