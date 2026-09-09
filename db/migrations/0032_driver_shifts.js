// المرحلة 8.48: حضور وأجر السائقين بالساعة (تسجيل دخول/خروج + مصروف يومي تلقائي) - راجع db/schema.sql
// وdb/driver-shift-engine.js للتوثيق الكامل
module.exports = {
  async up(client) {
    await client.query(`ALTER TABLE pos_settings ADD COLUMN IF NOT EXISTS driver_hourly_rate_egp NUMERIC NOT NULL DEFAULT 33`);

    await client.query(
      `INSERT INTO expense_categories (name) VALUES ('أجور عمالة خارجية (سائقين)') ON CONFLICT (name) DO NOTHING`
    );

    await client.query(`
      CREATE TABLE IF NOT EXISTS driver_shifts (
        id             SERIAL PRIMARY KEY,
        driver_id      INTEGER NOT NULL REFERENCES drivers(id),
        branch_id      INTEGER NOT NULL REFERENCES branches(id),
        status         TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'CLOSED')),
        checked_in_by  INTEGER REFERENCES users(id),
        checked_in_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
        checked_out_by INTEGER REFERENCES users(id),
        checked_out_at TIMESTAMPTZ,
        hourly_rate    NUMERIC NOT NULL,
        hours_worked   NUMERIC,
        wage_amount    NUMERIC,
        bonus_total    NUMERIC,
        total_pay      NUMERIC,
        expense_id     INTEGER,
        notes          TEXT,
        created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await client.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_driver_shifts_one_active ON driver_shifts(driver_id) WHERE status = 'ACTIVE'`
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_driver_shifts_branch ON driver_shifts(branch_id, checked_in_at)`
    );

    const constraint = await client.query(
      `SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = 'fk_driver_shifts_expense'`
    );
    if (constraint.rows.length === 0) {
      await client.query(
        `ALTER TABLE driver_shifts ADD CONSTRAINT fk_driver_shifts_expense FOREIGN KEY (expense_id) REFERENCES expenses(id)`
      );
    }
  },
};
