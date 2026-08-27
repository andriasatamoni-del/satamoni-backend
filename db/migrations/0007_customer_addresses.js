// المرحلة 7M: عناوين متعددة محفوظة للعميل الواحد (بدل عنوان افتراضي واحد بس في customers).
// customers.address_details/delivery_area_id/distinguishing_mark فضلوا زي ما هما (أول/آخر عنوان معروف
// للعميل، بيتحدّثوا زي الأول) - customer_addresses جدول إضافي بيراكم كل عنوان اتسجل بيه العميل فعليًا.
module.exports = {
  async up(client) {
    await client.query(`
      CREATE TABLE IF NOT EXISTS customer_addresses (
        id                   SERIAL PRIMARY KEY,
        customer_phone       TEXT NOT NULL REFERENCES customers(phone) ON DELETE CASCADE,
        label                TEXT,
        address_details      TEXT NOT NULL,
        delivery_area_id     INTEGER REFERENCES delivery_areas(id),
        distinguishing_mark  TEXT,
        is_default           BOOLEAN NOT NULL DEFAULT FALSE,
        created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_customer_addresses_phone ON customer_addresses(customer_phone)`);

    // تعبئة أولية: أي عميل عنده عنوان افتراضي محفوظ من قبل (address_details) ياخد سطر واحد هنا كنقطة
    // بداية لدفتر عناوينه - عناوين تانية هتتضاف تلقائي كل ما يطلب دليفري على عنوان مختلف (routes/orders.js)
    await client.query(`
      INSERT INTO customer_addresses (customer_phone, label, address_details, delivery_area_id, distinguishing_mark, is_default)
      SELECT c.phone, 'الأساسي', c.address_details, c.delivery_area_id, c.distinguishing_mark, TRUE
      FROM customers c
      WHERE c.address_details IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM customer_addresses ca WHERE ca.customer_phone = c.phone)
    `);
  },
};
