// HR Foundation Hardening (HRF-2): يستبدل UNIQUE(year, month) العادي (اللي كان بيمنع أي تشغيلة رواتب
// جديدة لنفس الشهر للأبد حتى بعد إلغاء القديمة) بـpartial unique index بيستثني CANCELLED - راجع
// db/schema.sql لنفس الفهرس بالتفصيل. آمن على بيانات موجودة: لو فيه أكتر من تشغيلة نشطة (DRAFT/APPROVED)
// بالفعل لنفس الشهر (ما كانش المفروض يحصل أصلًا تحت القيد القديم)، إنشاء الفهرس هيفشل بوضوح بدل ما يمسح
// أو يغيّر أي بيانات - في الحالة النادرة دي، لازم مراجعة يدوية للتشغيلتين قبل إعادة تشغيل الـmigration.
module.exports = {
  async up(client) {
    await client.query(`
      DO $$ BEGIN
        ALTER TABLE payroll_runs DROP CONSTRAINT payroll_runs_year_month_key;
      EXCEPTION WHEN undefined_object THEN NULL;
      END $$;
    `);
    await client.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_payroll_runs_active_period ON payroll_runs(year, month) WHERE status IN ('DRAFT', 'APPROVED')`
    );
  },
};
