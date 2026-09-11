// المرحلة 9A-1: موافقة PIN المدير مربوطة بإجراء/كيان محدد (approval grant) بدل هوية مدير قابلة لإعادة
// الاستخدام. راجع db/schema.sql للشرح الكامل.
module.exports = {
  async up(client) {
    await client.query(`
      CREATE TABLE IF NOT EXISTS approval_grants (
        id            SERIAL PRIMARY KEY,
        token         TEXT NOT NULL UNIQUE,
        action_type   TEXT NOT NULL,
        target_type   TEXT NOT NULL,
        target_id     TEXT NOT NULL,
        branch_id     INTEGER REFERENCES branches(id),
        approved_by   INTEGER NOT NULL REFERENCES users(id),
        requested_by  INTEGER REFERENCES users(id),
        status        TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'USED', 'EXPIRED', 'REVOKED')),
        used_by       INTEGER REFERENCES users(id),
        used_at       TIMESTAMPTZ,
        expires_at    TIMESTAMPTZ NOT NULL,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_approval_grants_token ON approval_grants(token)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_approval_grants_lookup ON approval_grants(action_type, target_type, target_id, status)`);
  },
};
