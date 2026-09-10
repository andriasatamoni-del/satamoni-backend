// المرحلة 8.58: صلاحيات كل موظف قابلة للتخصيص فرديًا فوق دوره الأساسي - إضافة صلاحية زيادة عن دوره،
// أو إلغاء صلاحية من صلاحيات دوره الافتراضية. راجع db/schema.sql + middleware/permissions.js
module.exports = {
  async up(client) {
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS permission_grants JSONB NOT NULL DEFAULT '[]'::jsonb`);
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS permission_revokes JSONB NOT NULL DEFAULT '[]'::jsonb`);
  },
};
