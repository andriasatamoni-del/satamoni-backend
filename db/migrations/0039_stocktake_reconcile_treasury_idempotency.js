// المرحلة 9A-6: idempotency_key اختياري لجلسة الجرد الفعلي وتصحيح سطر الجرد - راجع db/schema.sql
// وroutes/stocktake.js للشرح الكامل. reconcile (routes/inventory.js) وtreasuries transfer بيستخدموا
// أعمدة idempotency_key الموجودة بالفعل في inventory_movements وjournal_entries - مفيش عمود جديد لهم
module.exports = {
  async up(client) {
    await client.query(`ALTER TABLE stocktakes ADD COLUMN IF NOT EXISTS idempotency_key TEXT`);
    await client.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_stocktakes_idempotency ON stocktakes(idempotency_key) WHERE idempotency_key IS NOT NULL`
    );
    await client.query(`ALTER TABLE stocktake_line_corrections ADD COLUMN IF NOT EXISTS idempotency_key TEXT`);
    await client.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_stocktake_line_corrections_idempotency ON stocktake_line_corrections(idempotency_key) WHERE idempotency_key IS NOT NULL`
    );
  },
};
