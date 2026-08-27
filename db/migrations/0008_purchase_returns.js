// المرحلة 7N: مرتجع مشتريات (إرجاع بضاعة للمورد) - معاملة مستقلة عن /goods-receipts/:id/cancel
// الموجودة أصلًا (اللي بترجع سند استلام كامل ومفيش جزء منه اتصرف). المرتجع ده بيسمح بإرجاع كمية جزئية
// من صنف/دفعة معينة في أي وقت لاحق (بعد ما جزء من الدفعة ممكن يكون اتصرف بالفعل)، من غير ما يلمس
// باقي سند الاستلام أو الـPO خالص.
module.exports = {
  async up(client) {
    await client.query(`
      CREATE TABLE IF NOT EXISTS purchase_returns (
        id                SERIAL PRIMARY KEY,
        branch_id         INTEGER NOT NULL REFERENCES branches(id),
        supplier_id       INTEGER REFERENCES suppliers(id),
        goods_receipt_id  INTEGER REFERENCES goods_receipts(id),
        status            TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'POSTED', 'CANCELLED')),
        reason            TEXT NOT NULL,
        notes             TEXT,
        total_value       NUMERIC,
        created_by        INTEGER REFERENCES users(id),
        created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
        posted_by         INTEGER REFERENCES users(id),
        posted_at         TIMESTAMPTZ,
        cancelled_by      INTEGER REFERENCES users(id),
        cancelled_at      TIMESTAMPTZ
      )
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS purchase_return_items (
        id                  SERIAL PRIMARY KEY,
        purchase_return_id  INTEGER NOT NULL REFERENCES purchase_returns(id) ON DELETE CASCADE,
        inventory_item_id   INTEGER NOT NULL REFERENCES inventory_items(id),
        batch_id            INTEGER REFERENCES inventory_batches(id),
        quantity            NUMERIC NOT NULL CHECK (quantity > 0),
        unit                TEXT NOT NULL,
        unit_cost           NUMERIC,
        line_value          NUMERIC
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_purchase_returns_branch ON purchase_returns(branch_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_purchase_returns_supplier ON purchase_returns(supplier_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_purchase_returns_status ON purchase_returns(status)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_purchase_return_items_return ON purchase_return_items(purchase_return_id)`);
    // المرحلة 8C: كان ناقص هنا - موجود في db/schema.sql بس مش في الترحيل ده، اتكشف بمقارنة فعلية بين
    // قاعدة بيانات جديدة كليًا (schema.sql ثم db/migrate.js) وقاعدة التطوير الحالية أثناء تدقيق الترحيل
    await client.query(`CREATE INDEX IF NOT EXISTS idx_purchase_return_items_batch ON purchase_return_items(batch_id)`);
  },
};
