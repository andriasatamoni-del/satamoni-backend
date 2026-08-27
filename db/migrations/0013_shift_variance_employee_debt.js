// المرحلة 8.6: عجز كاش الشيفت كان بيتسجل كـ variance_status بس من غير أي أثر محاسبي حقيقي - "بيختفي"
// عمليًا. الإصلاح: عجز مؤكَّد (قرار "اعتماد" من المدير/المحاسب) بيتسجل كسلفة (payroll_adjustments،
// adjustment_type='advance') على الكاشير صاحب الشيفت - وده أصلاً مربوط بحساب صافي الراتب الفعلي
// (services/payroll-engine.js بيخصمها تلقائي)، فمفيش داعي لآلية "تسوية" جديدة، الخصم من الراتب هو
// التسوية. shift_id بيدي تتبّع كامل موظف->شيفت من غير تكرار أرقام الكاش (موجودة أصلاً على pos_shifts).
module.exports = {
  async up(client) {
    await client.query(`
      DO $$ BEGIN
        ALTER TABLE payroll_adjustments ADD COLUMN shift_id INTEGER REFERENCES pos_shifts(id);
      EXCEPTION WHEN duplicate_column THEN NULL;
      END $$;
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_payroll_adjustments_shift ON payroll_adjustments(shift_id) WHERE shift_id IS NOT NULL`);
  },
};
