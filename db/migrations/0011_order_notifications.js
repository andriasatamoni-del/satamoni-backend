// المرحلة 7S: تأكيد الطلب بـSMS/واتساب للعميل - إعداد تفعيل/تعطيل (افتراضيًا معطّل، لحد ما بوابة حقيقية
// تتظبط - راجع db/sms-provider.js) + سجل محاولات الإرسال (append-only، للمراجعة/التتبع).
module.exports = {
  async up(client) {
    await client.query(`
      DO $$ BEGIN
        ALTER TABLE pos_settings ADD COLUMN sms_confirmations_enabled BOOLEAN NOT NULL DEFAULT FALSE;
      EXCEPTION WHEN duplicate_column THEN NULL;
      END $$;
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS order_notifications (
        id         SERIAL PRIMARY KEY,
        order_id   INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
        channel    TEXT NOT NULL CHECK (channel IN ('sms', 'whatsapp')),
        phone      TEXT NOT NULL,
        message    TEXT NOT NULL,
        status     TEXT NOT NULL CHECK (status IN ('sent', 'failed', 'not_configured')),
        error      TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_order_notifications_order ON order_notifications(order_id)`);
  },
};
