// Payment Control & Reconciliation - Phase 2: استيراد ملفات (CSV/Excel) - راجع db/schema.sql للشرح.
module.exports = {
  async up(client) {
    await client.query(`ALTER TABLE payment_reconciliation_records ADD COLUMN IF NOT EXISTS import_batch_id TEXT`);
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_payment_reconciliation_import_batch
         ON payment_reconciliation_records(import_batch_id) WHERE import_batch_id IS NOT NULL`
    );
  },
};
