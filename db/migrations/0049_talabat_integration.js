// Talabat Partner API Integration - راجع db/schema.sql للتعليق الكامل على كل جدول. نفس الـDDL بالظبط
// هنا للتطبيق على قواعد بيانات موجودة بالفعل.
const bcrypt = require("bcryptjs");

module.exports = {
  async up(client) {
    await client.query(`
      CREATE TABLE IF NOT EXISTS talabat_orders (
        id                        SERIAL PRIMARY KEY,
        branch_id                 INTEGER NOT NULL REFERENCES branches(id),
        talabat_order_id          TEXT NOT NULL UNIQUE,
        talabat_external_order_id TEXT,
        talabat_order_code        TEXT,
        order_status              TEXT NOT NULL DEFAULT 'RECEIVED'
                                    CHECK (order_status IN ('RECEIVED', 'MAPPING_ERROR', 'IMPORTED', 'FAILED', 'CANCELED')),
        order_type                TEXT,
        payment_method             TEXT NOT NULL,
        subtotal                  NUMERIC,
        delivery_fee               NUMERIC,
        discount                  NUMERIC,
        total                      NUMERIC NOT NULL,
        currency                  TEXT DEFAULT 'EGP',
        pos_order_id               INTEGER UNIQUE REFERENCES orders(id),
        received_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
        accepted_at                 TIMESTAMPTZ,
        canceled_at                   TIMESTAMPTZ,
        cancellation_source             TEXT CHECK (cancellation_source IN ('TALABAT', 'STAMONI')),
        raw_payload                       JSONB NOT NULL,
        created_at                          TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at                             TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_talabat_orders_branch ON talabat_orders(branch_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_talabat_orders_status ON talabat_orders(order_status)`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS talabat_product_mapping (
        id                    SERIAL PRIMARY KEY,
        branch_id             INTEGER NOT NULL REFERENCES branches(id),
        talabat_item_id       TEXT NOT NULL,
        talabat_sku           TEXT,
        stamoni_menu_item_id  INTEGER REFERENCES menu_items(id),
        stamoni_variant_id    INTEGER REFERENCES menu_item_variants(id),
        active                BOOLEAN NOT NULL DEFAULT TRUE,
        mapping_status        TEXT NOT NULL DEFAULT 'MAPPED' CHECK (mapping_status IN ('MAPPED', 'UNMAPPED', 'NEEDS_REVIEW')),
        created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE(branch_id, talabat_item_id)
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS talabat_webhook_events (
        id                 SERIAL PRIMARY KEY,
        event_id           TEXT,
        talabat_order_id   TEXT,
        event_type         TEXT NOT NULL DEFAULT 'UNKNOWN',
        received_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
        source_ip          TEXT,
        processing_status  TEXT NOT NULL DEFAULT 'RECEIVED' CHECK (processing_status IN ('RECEIVED', 'PROCESSED', 'DUPLICATE', 'FAILED')),
        error_message      TEXT,
        raw_payload        JSONB NOT NULL,
        dedupe_key         TEXT NOT NULL,
        created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await client.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_talabat_webhook_events_dedupe ON talabat_webhook_events(dedupe_key)`
    );

    await client.query(`
      CREATE TABLE IF NOT EXISTS talabat_integration_errors (
        id                SERIAL PRIMARY KEY,
        talabat_order_id  TEXT,
        branch_id         INTEGER REFERENCES branches(id),
        error_type        TEXT NOT NULL,
        error_message     TEXT NOT NULL,
        raw_payload       JSONB,
        retry_count       INTEGER NOT NULL DEFAULT 0,
        last_retry_at     TIMESTAMPTZ,
        status            TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'RETRYING', 'RESOLVED', 'IGNORED')),
        resolved_by       INTEGER REFERENCES users(id),
        resolved_at       TIMESTAMPTZ,
        created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_talabat_integration_errors_status ON talabat_integration_errors(status)`
    );

    await client.query(`
      DO $$ BEGIN
        ALTER TABLE payment_methods ADD COLUMN talabat_payment_code TEXT;
      EXCEPTION WHEN duplicate_column THEN NULL;
      END $$;
    `);
    await client.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_methods_talabat_code ON payment_methods(talabat_payment_code) WHERE talabat_payment_code IS NOT NULL`
    );

    const randomPassword = require("crypto").randomBytes(32).toString("hex");
    const passwordHash = await bcrypt.hash(randomPassword, 10);
    await client.query(
      `INSERT INTO users (name, email, password_hash, role, branch_id, is_active)
       VALUES ('Talabat Integration (System)', 'talabat-integration@system.internal', $1, 'admin', NULL, TRUE)
       ON CONFLICT (email) DO NOTHING`,
      [passwordHash]
    );
  },
};
