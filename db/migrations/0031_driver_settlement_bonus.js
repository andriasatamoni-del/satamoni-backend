// المرحلة 8.46: بونص التوصيل التلقائي للسائق على تسوية كاش السائق - راجع db/schema.sql للتوثيق الكامل
module.exports = {
  async up(client) {
    await client.query(`ALTER TABLE driver_settlements ADD COLUMN IF NOT EXISTS bonus_total NUMERIC NOT NULL DEFAULT 0`);
    await client.query(`ALTER TABLE driver_settlements ADD COLUMN IF NOT EXISTS bonus_payroll_adjustment_id INTEGER`);
    const constraint = await client.query(
      `SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = 'fk_driver_settlements_bonus_adjustment'`
    );
    if (constraint.rows.length === 0) {
      await client.query(
        `ALTER TABLE driver_settlements ADD CONSTRAINT fk_driver_settlements_bonus_adjustment
           FOREIGN KEY (bonus_payroll_adjustment_id) REFERENCES payroll_adjustments(id)`
      );
    }
  },
};
