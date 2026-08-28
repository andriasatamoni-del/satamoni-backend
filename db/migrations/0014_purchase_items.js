// المرحلة 8.6: مشتريات الكاشير النقدية (purchases) كانت مبلغ واحد (amount) من غير تفاصيل أصناف -
// معندهاش أي أثر في المخزون خالص (منفصلة تمامًا عن خط GRN الرسمي). الإصلاح: جدول بنود اختياري
// (purchase_items) بيربط كل بند بمادة خام موجودة فعلاً في inventory_items (الكاشير میقدرش ينشئ صنف
// جديد - مجرد اختيار من الكتالوج الموجود)، وترحيل المخزون/المحاسبة بيحصل مرة واحدة بس عند التأكيد
// (/:id/confirm) - نفس نقطة الترحيل الوحيدة المستخدمة في GRN (postInventoryMovement + postJournalEntry)،
// مفيش آلية مخزون تانية بتتعمل من الصفر
module.exports = {
  async up(client) {
    await client.query(`
      CREATE TABLE IF NOT EXISTS purchase_items (
        id                 SERIAL PRIMARY KEY,
        purchase_id        INTEGER NOT NULL REFERENCES purchases(id) ON DELETE CASCADE,
        inventory_item_id  INTEGER NOT NULL REFERENCES inventory_items(id),
        quantity           NUMERIC NOT NULL CHECK (quantity > 0),
        unit               TEXT NOT NULL,
        unit_price         NUMERIC NOT NULL CHECK (unit_price >= 0),
        line_total         NUMERIC NOT NULL,
        created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_purchase_items_purchase ON purchase_items(purchase_id)`);
    await client.query(`
      DO $$ BEGIN
        ALTER TABLE purchases ADD COLUMN posted_to_inventory BOOLEAN NOT NULL DEFAULT FALSE;
      EXCEPTION WHEN duplicate_column THEN NULL;
      END $$;
    `);
  },
};
