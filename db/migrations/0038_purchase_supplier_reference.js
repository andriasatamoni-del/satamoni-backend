// المرحلة 9A-3: ربط اختياري بين مشترى الكاشير الطارئ (purchases) ومورد رسمي + رقم مستنده - راجع
// db/schema.sql وdb/purchase-duplicate-check.js للشرح الكامل
module.exports = {
  async up(client) {
    await client.query(`ALTER TABLE purchases ADD COLUMN IF NOT EXISTS supplier_id INTEGER REFERENCES suppliers(id)`);
    await client.query(`ALTER TABLE purchases ADD COLUMN IF NOT EXISTS supplier_document_number TEXT`);
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_purchases_supplier_doc ON purchases(supplier_id, supplier_document_number) WHERE supplier_id IS NOT NULL`
    );
  },
};
