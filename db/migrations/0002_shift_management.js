// المرحلة 7E: شيفتات الكاشير + تقفيل يوم الفرع - كل الـDDL هنا idempotent (IF NOT EXISTS / حراسة صريحة
// قبل ADD CONSTRAINT، لأن Postgres مش بيدعم ADD CONSTRAINT IF NOT EXISTS) عشان يفضل آمن حتى لو اتشغل
// أكتر من مرة بالغلط - نفس القاعدة المتبعة في كل migration في db/migrations/
module.exports = {
  async up(client) {
    await client.query(`
      CREATE TABLE IF NOT EXISTS pos_shifts (
        id                    SERIAL PRIMARY KEY,
        branch_id             INTEGER NOT NULL REFERENCES branches(id),
        user_id               INTEGER NOT NULL REFERENCES users(id),
        status                TEXT NOT NULL DEFAULT 'ACTIVE'
                                CHECK (status IN ('ACTIVE', 'PENDING_REVIEW', 'CLOSED', 'FORCE_CLOSED')),
        opened_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
        opening_cash          NUMERIC NOT NULL DEFAULT 0 CHECK (opening_cash >= 0),
        opening_notes         TEXT,
        closed_at             TIMESTAMPTZ,
        closed_by             INTEGER REFERENCES users(id),
        expected_cash         NUMERIC,
        actual_cash           NUMERIC CHECK (actual_cash IS NULL OR actual_cash >= 0),
        cash_variance         NUMERIC,
        closing_notes         TEXT,
        cash_sales            NUMERIC NOT NULL DEFAULT 0,
        card_sales            NUMERIC NOT NULL DEFAULT 0,
        other_sales           NUMERIC NOT NULL DEFAULT 0,
        cash_refunds          NUMERIC NOT NULL DEFAULT 0,
        discounts_total       NUMERIC NOT NULL DEFAULT 0,
        cash_expenses_total   NUMERIC NOT NULL DEFAULT 0,
        order_count           INTEGER NOT NULL DEFAULT 0,
        void_count            INTEGER NOT NULL DEFAULT 0,
        variance_status         TEXT NOT NULL DEFAULT 'NONE'
                                  CHECK (variance_status IN ('NONE', 'PENDING_REVIEW', 'ACKNOWLEDGED', 'APPROVED')),
        variance_reviewed_by    INTEGER REFERENCES users(id),
        variance_reviewed_at    TIMESTAMPTZ,
        variance_review_notes   TEXT,
        created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_pos_shifts_one_active_per_user ON pos_shifts(user_id) WHERE status = 'ACTIVE'`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_pos_shifts_branch_date ON pos_shifts(branch_id, opened_at)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_pos_shifts_variance_status ON pos_shifts(branch_id, variance_status) WHERE variance_status = 'PENDING_REVIEW'`);

    await client.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS shift_id INTEGER`);
    const fkExists = await client.query(
      `SELECT 1 FROM pg_constraint WHERE conname = 'fk_orders_shift'`
    );
    if (fkExists.rows.length === 0) {
      await client.query(`ALTER TABLE orders ADD CONSTRAINT fk_orders_shift FOREIGN KEY (shift_id) REFERENCES pos_shifts(id)`);
    }
    await client.query(`CREATE INDEX IF NOT EXISTS idx_orders_shift_id ON orders(shift_id) WHERE shift_id IS NOT NULL`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS branch_days (
        id                    SERIAL PRIMARY KEY,
        branch_id             INTEGER NOT NULL REFERENCES branches(id),
        business_date         DATE NOT NULL,
        status                TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'CLOSED')),
        opened_by             INTEGER REFERENCES users(id),
        opened_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
        closed_by             INTEGER REFERENCES users(id),
        closed_at             TIMESTAMPTZ,
        total_sales           NUMERIC,
        order_count           INTEGER,
        cash_variance_total   NUMERIC,
        manager_notes         TEXT,
        created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (branch_id, business_date)
      )
    `);

    await client.query(`ALTER TABLE pos_settings ADD COLUMN IF NOT EXISTS shift_variance_ack_threshold_egp NUMERIC NOT NULL DEFAULT 20`);
    await client.query(`ALTER TABLE pos_settings ADD COLUMN IF NOT EXISTS shift_variance_review_threshold_egp NUMERIC NOT NULL DEFAULT 100`);
    await client.query(`ALTER TABLE pos_settings ADD COLUMN IF NOT EXISTS require_shift_for_pos_sales BOOLEAN NOT NULL DEFAULT FALSE`);
  },
};
