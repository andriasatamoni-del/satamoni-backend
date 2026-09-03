// المرحلة 8.40: رسالة واتساب تأكيد الطلب + طلب تقييم بعد التسليم/الاستلام - راجع db/order-notifications.js
// وpublic/rate.html. rating_token على كل طلب موجود بالفعل (مش عمود جديد يتضاف فاضي لطلبات قديمة بس -
// gen_random_uuid() بيتولّد لكل الصفوف الموجودة أول ما العمود يتضاف، فكل الطلبات القديمة كمان بتاخد
// توكن صالح فورًا).
module.exports = {
  async up(client) {
    await client.query(`
      DO $$ BEGIN
        ALTER TABLE orders ADD COLUMN rating_token UUID NOT NULL DEFAULT gen_random_uuid();
      EXCEPTION WHEN duplicate_column THEN NULL;
      END $$;
    `);
    await client.query(`
      DO $$ BEGIN
        ALTER TABLE pos_settings ADD COLUMN sms_rating_requests_enabled BOOLEAN NOT NULL DEFAULT FALSE;
      EXCEPTION WHEN duplicate_column THEN NULL;
      END $$;
    `);
    await client.query(`
      DO $$ BEGIN
        ALTER TABLE order_notifications ADD COLUMN kind TEXT NOT NULL DEFAULT 'confirmation';
      EXCEPTION WHEN duplicate_column THEN NULL;
      END $$;
    `);
    await client.query(`
      DO $$ BEGIN
        ALTER TABLE order_notifications ADD CONSTRAINT order_notifications_kind_check
          CHECK (kind IN ('confirmation', 'rating_request'));
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$;
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS order_ratings (
        id         SERIAL PRIMARY KEY,
        order_id   INTEGER NOT NULL UNIQUE REFERENCES orders(id) ON DELETE CASCADE,
        branch_id  INTEGER REFERENCES branches(id),
        stars      INTEGER NOT NULL CHECK (stars BETWEEN 1 AND 5),
        comment    TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_order_ratings_branch ON order_ratings(branch_id)`);
  },
};
