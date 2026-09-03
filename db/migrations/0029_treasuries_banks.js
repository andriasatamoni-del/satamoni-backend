// المرحلة 8.42: الخزائن (رئيسية/كاشير/بنك) + البنوك وحسابات البنوك - راجع db/schema.sql للتوثيق الكامل
module.exports = {
  async up(client) {
    await client.query(`
      DO $$ BEGIN
        INSERT INTO accounts (code, name, account_type, is_system_account)
        VALUES ('6950', 'فروق كاش', 'EXPENSE', TRUE);
      EXCEPTION WHEN unique_violation THEN NULL;
      END $$;
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS treasuries (
        id                SERIAL PRIMARY KEY,
        account_id        INTEGER NOT NULL UNIQUE REFERENCES accounts(id),
        branch_id         INTEGER REFERENCES branches(id),
        kind              TEXT NOT NULL CHECK (kind IN ('MAIN', 'CASHIER', 'BANK')),
        name              TEXT NOT NULL,
        cashier_user_id   INTEGER REFERENCES users(id),
        is_active         BOOLEAN NOT NULL DEFAULT TRUE,
        created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_treasuries_main_per_branch ON treasuries(branch_id) WHERE kind = 'MAIN'`);
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_treasuries_cashier_per_branch_user ON treasuries(branch_id, cashier_user_id) WHERE kind = 'CASHIER'`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_treasuries_branch ON treasuries(branch_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_treasuries_kind ON treasuries(kind)`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS banks (
        id          SERIAL PRIMARY KEY,
        name        TEXT NOT NULL,
        is_active   BOOLEAN NOT NULL DEFAULT TRUE,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS bank_accounts (
        id                SERIAL PRIMARY KEY,
        bank_id           INTEGER NOT NULL REFERENCES banks(id),
        treasury_id       INTEGER NOT NULL UNIQUE REFERENCES treasuries(id),
        account_number    TEXT,
        iban              TEXT,
        bank_branch_name  TEXT,
        notes             TEXT,
        is_active         BOOLEAN NOT NULL DEFAULT TRUE,
        created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_bank_accounts_bank ON bank_accounts(bank_id)`);

    // باكفيل: أي حساب كاش فرع/درج كاشير اتنشأ قبل المرحلة دي (getOrCreateBranchCashAccount/
    // getOrCreateCashierTreasuryAccount اتنشأوا وقتها من غير تسجيل في treasuries) لازم يتسجّل هنا فورًا
    // بدل ما يستنى أول عملية كاش تلمسه بعد الترقية (نفس المنطق دلوقتي مكرر ذاتيًا جوه الدالتين نفسهم
    // كمان - الباكفيل ده بس عشان شاشة الخزائن تبان صح فورًا بعد الترقية من غير استنى)
    await client.query(`
      INSERT INTO treasuries (account_id, branch_id, kind, name)
      SELECT a.id, a.branch_id, 'MAIN', a.name
      FROM accounts a
      WHERE a.code ~ '^1100-[0-9]+$'
      ON CONFLICT (account_id) DO NOTHING
    `);
    await client.query(`
      INSERT INTO treasuries (account_id, branch_id, kind, name, cashier_user_id)
      SELECT a.id, a.branch_id, 'CASHIER', a.name, split_part(a.code, '-', 3)::int
      FROM accounts a
      WHERE a.code ~ '^1100-[0-9]+-[0-9]+$'
      ON CONFLICT (account_id) DO NOTHING
    `);
  },
};
