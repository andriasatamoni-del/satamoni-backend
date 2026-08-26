// المرحلة 7G: حالة المطبخ (KDS) - كل الـDDL هنا idempotent زي أي migration سابق في الملف ده.
module.exports = {
  async up(client) {
    await client.query(`
      DO $$ BEGIN
        ALTER TABLE orders ADD COLUMN kitchen_status TEXT NOT NULL DEFAULT 'NEW';
      EXCEPTION WHEN duplicate_column THEN NULL;
      END $$;
    `);
    const kitchenCheckExists = await client.query(
      `SELECT 1 FROM pg_constraint WHERE conname = 'orders_kitchen_status_check'`
    );
    if (kitchenCheckExists.rows.length === 0) {
      await client.query(`
        ALTER TABLE orders ADD CONSTRAINT orders_kitchen_status_check
          CHECK (kitchen_status IN ('NEW', 'ACCEPTED', 'PREPARING', 'READY'))
      `);
    }
    await client.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS kitchen_accepted_at TIMESTAMPTZ`);
    await client.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS kitchen_ready_at TIMESTAMPTZ`);
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_orders_kitchen_status ON orders(branch_id, kitchen_status) WHERE kitchen_status <> 'READY'`
    );
  },
};
