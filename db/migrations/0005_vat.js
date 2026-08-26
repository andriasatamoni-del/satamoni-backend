// المرحلة 7H: ضريبة القيمة المضافة - كل الـDDL هنا idempotent زي أي migration سابق في الملف ده.
module.exports = {
  async up(client) {
    await client.query(`
      DO $$ BEGIN
        ALTER TABLE pos_settings ADD COLUMN vat_rate NUMERIC NOT NULL DEFAULT 0.14;
      EXCEPTION WHEN duplicate_column THEN NULL;
      END $$;
    `);
    await client.query(`
      DO $$ BEGIN
        ALTER TABLE orders ADD COLUMN vat_amount NUMERIC NOT NULL DEFAULT 0;
      EXCEPTION WHEN duplicate_column THEN NULL;
      END $$;
    `);
  },
};
