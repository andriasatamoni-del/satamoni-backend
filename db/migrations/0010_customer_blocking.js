// المرحلة 7P: حظر عميل - منع تسجيل طلبات دليفري جديدة له. دمج عملاء مكررين معاملة (مفيش عمود جديد
// ليها - بتحرك عناوين/طلبات العميل المصدر لحساب الهدف وتحذف صف العميل المصدر، متسجلة في audit_logs).
module.exports = {
  async up(client) {
    await client.query(`
      DO $$ BEGIN
        ALTER TABLE customers ADD COLUMN is_blocked BOOLEAN NOT NULL DEFAULT FALSE;
      EXCEPTION WHEN duplicate_column THEN NULL;
      END $$;
    `);
    await client.query(`
      DO $$ BEGIN
        ALTER TABLE customers ADD COLUMN block_reason TEXT;
      EXCEPTION WHEN duplicate_column THEN NULL;
      END $$;
    `);
    await client.query(`
      DO $$ BEGIN
        ALTER TABLE customers ADD COLUMN blocked_by INTEGER REFERENCES users(id);
      EXCEPTION WHEN duplicate_column THEN NULL;
      END $$;
    `);
    await client.query(`
      DO $$ BEGIN
        ALTER TABLE customers ADD COLUMN blocked_at TIMESTAMPTZ;
      EXCEPTION WHEN duplicate_column THEN NULL;
      END $$;
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_customers_is_blocked ON customers(is_blocked) WHERE is_blocked = TRUE`);
  },
};
