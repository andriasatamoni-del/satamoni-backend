// المرحلة 8.58: جرد فعلي (Spot Check) - شاشة الأصناف. راجع db/schema.sql للتفاصيل الكاملة.
module.exports = {
  async up(client) {
    await client.query(`
      CREATE TABLE IF NOT EXISTS stocktakes (
        id                    SERIAL PRIMARY KEY,
        branch_id             INTEGER NOT NULL REFERENCES branches(id),
        created_by            INTEGER REFERENCES users(id),
        notes                 TEXT,
        total_variance_value  NUMERIC NOT NULL DEFAULT 0,
        created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_stocktakes_branch ON stocktakes(branch_id, created_at DESC)`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS stocktake_lines (
        id                     SERIAL PRIMARY KEY,
        stocktake_id           INTEGER NOT NULL REFERENCES stocktakes(id) ON DELETE CASCADE,
        inventory_item_id      INTEGER NOT NULL REFERENCES inventory_items(id),
        system_quantity        NUMERIC NOT NULL,
        actual_quantity        NUMERIC NOT NULL,
        variance_quantity      NUMERIC NOT NULL,
        unit_cost              NUMERIC,
        variance_value         NUMERIC,
        reason                 TEXT,
        charge_type            TEXT CHECK (charge_type IN ('account', 'employee')),
        charge_account_code    TEXT,
        charge_employee_id     INTEGER REFERENCES employees(id),
        inventory_movement_id  INTEGER REFERENCES inventory_movements(id),
        created_at             TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_stocktake_lines_stocktake ON stocktake_lines(stocktake_id)`);

    await client.query(`ALTER TABLE payroll_adjustments ADD COLUMN IF NOT EXISTS stocktake_id INTEGER REFERENCES stocktakes(id)`);
  },
};
