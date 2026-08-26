// المرحلة 7K: تسجيل مصروفات/مشتريات نقدي من شاشة الكاشير - كل الـDDL هنا idempotent زي أي ترحيل سابق.
module.exports = {
  async up(client) {
    // expenses.created_at كان ناقص خالص - كان فيه posted_at بس (NULL لحد ما يترحّل). ضروري عشان
    // مصروفات الكاشير (status='SUBMITTED' لسه مش مرحّلة) تتحسب صح في نافذة كاش الشيفت
    await client.query(`
      DO $$ BEGIN
        ALTER TABLE expenses ADD COLUMN created_at TIMESTAMPTZ NOT NULL DEFAULT now();
      EXCEPTION WHEN duplicate_column THEN NULL;
      END $$;
    `);

    await client.query(`
      DO $$ BEGIN
        ALTER TABLE purchases ADD COLUMN status TEXT NOT NULL DEFAULT 'CONFIRMED'
          CHECK (status IN ('PENDING', 'CONFIRMED', 'REJECTED'));
      EXCEPTION WHEN duplicate_column THEN NULL;
      END $$;
    `);
    await client.query(`
      DO $$ BEGIN
        ALTER TABLE purchases ADD COLUMN created_by INTEGER REFERENCES users(id);
      EXCEPTION WHEN duplicate_column THEN NULL;
      END $$;
    `);
    await client.query(`
      DO $$ BEGIN
        ALTER TABLE purchases ADD COLUMN created_at TIMESTAMPTZ NOT NULL DEFAULT now();
      EXCEPTION WHEN duplicate_column THEN NULL;
      END $$;
    `);
    await client.query(`
      DO $$ BEGIN
        ALTER TABLE purchases ADD COLUMN reviewed_by INTEGER REFERENCES users(id);
      EXCEPTION WHEN duplicate_column THEN NULL;
      END $$;
    `);
    await client.query(`
      DO $$ BEGIN
        ALTER TABLE purchases ADD COLUMN reviewed_at TIMESTAMPTZ;
      EXCEPTION WHEN duplicate_column THEN NULL;
      END $$;
    `);
    await client.query(`
      DO $$ BEGIN
        ALTER TABLE purchases ADD COLUMN rejection_reason TEXT;
      EXCEPTION WHEN duplicate_column THEN NULL;
      END $$;
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_purchases_status ON purchases(status)`);

    await client.query(`
      DO $$ BEGIN
        ALTER TABLE pos_shifts ADD COLUMN cash_purchases_total NUMERIC NOT NULL DEFAULT 0;
      EXCEPTION WHEN duplicate_column THEN NULL;
      END $$;
    `);
  },
};
