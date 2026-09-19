// HR Foundation Hardening (HRF-4): بدّل DELETE الصامت (بدون Audit Log) بـsoft-cancel - راجع
// db/schema.sql لتعليق كامل. كل صفوف موجودة بالفعل بتبقى status='ACTIVE' افتراضيًا (توافق رجعي كامل -
// صفر تأثير على حساب رواتب موجود بالفعل).
module.exports = {
  async up(client) {
    await client.query(`
      DO $$ BEGIN
        ALTER TABLE payroll_adjustments ADD COLUMN status TEXT NOT NULL DEFAULT 'ACTIVE'
          CHECK (status IN ('ACTIVE', 'CANCELLED'));
      EXCEPTION WHEN duplicate_column THEN NULL;
      END $$;
    `);
    await client.query(`
      DO $$ BEGIN
        ALTER TABLE payroll_adjustments ADD COLUMN cancelled_by INTEGER REFERENCES users(id);
      EXCEPTION WHEN duplicate_column THEN NULL;
      END $$;
    `);
    await client.query(`
      DO $$ BEGIN
        ALTER TABLE payroll_adjustments ADD COLUMN cancelled_at TIMESTAMPTZ;
      EXCEPTION WHEN duplicate_column THEN NULL;
      END $$;
    `);
    await client.query(`
      DO $$ BEGIN
        ALTER TABLE payroll_adjustments ADD COLUMN cancellation_reason TEXT;
      EXCEPTION WHEN duplicate_column THEN NULL;
      END $$;
    `);
  },
};
