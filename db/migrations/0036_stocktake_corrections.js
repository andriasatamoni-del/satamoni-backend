// المرحلة 8.59: تصحيح سطر جرد اتسجّل برقم غلط. راجع db/schema.sql للتفاصيل الكاملة.
module.exports = {
  async up(client) {
    await client.query(`
      CREATE TABLE IF NOT EXISTS stocktake_line_corrections (
        id                        SERIAL PRIMARY KEY,
        stocktake_line_id         INTEGER NOT NULL REFERENCES stocktake_lines(id) ON DELETE CASCADE,
        previous_actual_quantity  NUMERIC NOT NULL,
        corrected_actual_quantity NUMERIC NOT NULL,
        delta_quantity            NUMERIC NOT NULL,
        unit_cost                 NUMERIC,
        delta_value               NUMERIC,
        reason                    TEXT,
        charge_type               TEXT CHECK (charge_type IN ('account', 'employee')),
        charge_account_code       TEXT,
        charge_employee_id        INTEGER REFERENCES employees(id),
        inventory_movement_id     INTEGER REFERENCES inventory_movements(id),
        created_by                INTEGER REFERENCES users(id),
        created_at                TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_stocktake_line_corrections_line ON stocktake_line_corrections(stocktake_line_id)`);
  },
};
