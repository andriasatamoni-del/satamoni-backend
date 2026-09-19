// تكامل طلبات (TAL-5): معرّف فرع/متجر Talabat لكل فرع - راجع db/schema.sql للتعليق الكامل.
module.exports = {
  async up(client) {
    await client.query(`
      DO $$ BEGIN
        ALTER TABLE branches ADD COLUMN talabat_branch_id TEXT;
      EXCEPTION WHEN duplicate_column THEN NULL;
      END $$;
    `);
    await client.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_branches_talabat_branch_id ON branches(talabat_branch_id) WHERE talabat_branch_id IS NOT NULL`
    );
  },
};
