// Payment Control & Reconciliation (المرحلة الأولى) - راجع db/schema.sql للشرح الكامل.
module.exports = {
  async up(client) {
    await client.query(`
      ALTER TABLE payment_methods
        ADD COLUMN IF NOT EXISTS settlement_channel TEXT
          CHECK (settlement_channel IN ('visa_pos', 'instapay', 'orange_cash', 'vodafone_cash', 'other'))
    `);

    await client.query(`
      ALTER TABLE pos_settings
        ADD COLUMN IF NOT EXISTS payment_adjustment_high_threshold_egp NUMERIC NOT NULL DEFAULT 500,
        ADD COLUMN IF NOT EXISTS payment_daily_report_enabled BOOLEAN NOT NULL DEFAULT FALSE,
        ADD COLUMN IF NOT EXISTS owner_report_phone TEXT,
        ADD COLUMN IF NOT EXISTS payment_daily_report_hour SMALLINT NOT NULL DEFAULT 21
          CHECK (payment_daily_report_hour BETWEEN 0 AND 23)
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS payments (
        id                      SERIAL PRIMARY KEY,
        order_id                INTEGER NOT NULL UNIQUE REFERENCES orders(id),
        branch_id               INTEGER REFERENCES branches(id),
        payment_method_id       INTEGER NOT NULL REFERENCES payment_methods(id),
        method_kind             TEXT NOT NULL,
        settlement_channel      TEXT,
        channel                 TEXT NOT NULL,
        amount                  NUMERIC NOT NULL,
        talabat_cash_collected  NUMERIC NOT NULL DEFAULT 0,
        status                  TEXT NOT NULL DEFAULT 'LOCKED' CHECK (status IN ('LOCKED', 'ADJUSTED')),
        locked_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
        locked_by               INTEGER REFERENCES users(id),
        created_at              TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_payments_branch_created ON payments(branch_id, created_at)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_payments_channel ON payments(channel)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_payments_settlement_channel ON payments(settlement_channel) WHERE settlement_channel IS NOT NULL`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS payment_adjustment_requests (
        id                        SERIAL PRIMARY KEY,
        payment_id                INTEGER NOT NULL REFERENCES payments(id),
        requested_by              INTEGER REFERENCES users(id),
        requested_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
        reason                    TEXT NOT NULL,
        proposed_payment_method_id INTEGER REFERENCES payment_methods(id),
        proposed_amount           NUMERIC,
        amount_delta              NUMERIC NOT NULL DEFAULT 0,
        status                    TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED')),
        approval_grant_token      TEXT,
        decided_by                INTEGER REFERENCES users(id),
        decided_at                TIMESTAMPTZ
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_payment_adjustment_requests_payment ON payment_adjustment_requests(payment_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_payment_adjustment_requests_status ON payment_adjustment_requests(status)`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS payment_reconciliation_records (
        id                  SERIAL PRIMARY KEY,
        branch_id           INTEGER REFERENCES branches(id),
        source              TEXT NOT NULL CHECK (source IN ('talabat_statement', 'visa_settlement', 'instapay', 'orange_cash')),
        external_reference  TEXT,
        external_amount     NUMERIC NOT NULL,
        external_date       DATE NOT NULL,
        matched_payment_id  INTEGER REFERENCES payments(id),
        match_status        TEXT NOT NULL DEFAULT 'UNMATCHED' CHECK (match_status IN ('UNMATCHED', 'MATCHED', 'DISPUTED')),
        notes               TEXT,
        entered_by          INTEGER REFERENCES users(id),
        entered_at          TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_payment_reconciliation_branch_date ON payment_reconciliation_records(branch_id, source, external_date)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_payment_reconciliation_match_status ON payment_reconciliation_records(match_status)`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS payment_audit_logs (
        id            SERIAL PRIMARY KEY,
        payment_id    INTEGER REFERENCES payments(id),
        order_id      INTEGER REFERENCES orders(id),
        branch_id     INTEGER REFERENCES branches(id),
        actor_id      INTEGER REFERENCES users(id),
        actor_role    TEXT,
        action_type   TEXT NOT NULL,
        before_state  JSONB,
        after_state   JSONB,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_payment_audit_logs_payment ON payment_audit_logs(payment_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_payment_audit_logs_branch_created ON payment_audit_logs(branch_id, created_at)`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS payment_daily_report_log (
        id          SERIAL PRIMARY KEY,
        report_date DATE NOT NULL UNIQUE,
        phone       TEXT,
        status      TEXT NOT NULL,
        error       TEXT,
        sent_at     TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
  },
};
