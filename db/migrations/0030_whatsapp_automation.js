// المرحلة 8.43: أتمتة واتساب - رد آلي بذكاء اصطناعي على استفسارات العملاء (منيو/أسعار/عروض/عنوان)،
// تجميع طلبات جديدة كـ"مسودة" لحد ما كاشير/كول سنتر يراجعها ويسجلها فعليًا، وتسجيل شكاوى فورًا لفريق
// حقيقي يتابعها. راجع db/schema.sql لتفاصيل كل عمود.
module.exports = {
  async up(client) {
    await client.query(`
      DO $$ BEGIN
        ALTER TABLE pos_settings ADD COLUMN whatsapp_bot_enabled BOOLEAN NOT NULL DEFAULT FALSE;
      EXCEPTION WHEN duplicate_column THEN NULL;
      END $$;
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS whatsapp_conversations (
        id               SERIAL PRIMARY KEY,
        phone            TEXT NOT NULL UNIQUE,
        customer_name    TEXT,
        last_message_at  TIMESTAMPTZ,
        created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS whatsapp_messages (
        id             SERIAL PRIMARY KEY,
        conversation_id INTEGER NOT NULL REFERENCES whatsapp_conversations(id) ON DELETE CASCADE,
        direction      TEXT NOT NULL CHECK (direction IN ('in', 'out')),
        body           TEXT NOT NULL,
        wa_message_id  TEXT,
        created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_whatsapp_messages_conversation ON whatsapp_messages(conversation_id, created_at)`);
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_whatsapp_messages_wa_id ON whatsapp_messages(wa_message_id) WHERE wa_message_id IS NOT NULL`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS whatsapp_pending_orders (
        id                  SERIAL PRIMARY KEY,
        conversation_id     INTEGER NOT NULL REFERENCES whatsapp_conversations(id) ON DELETE CASCADE,
        customer_phone      TEXT NOT NULL,
        customer_name       TEXT,
        order_type          TEXT NOT NULL DEFAULT 'delivery' CHECK (order_type IN ('delivery', 'takeaway')),
        branch_id           INTEGER REFERENCES branches(id),
        delivery_area_id    INTEGER REFERENCES delivery_areas(id),
        address_details     TEXT,
        distinguishing_mark TEXT,
        items               JSONB NOT NULL DEFAULT '[]',
        subtotal            NUMERIC NOT NULL DEFAULT 0,
        delivery_fee        NUMERIC NOT NULL DEFAULT 0,
        total                NUMERIC NOT NULL DEFAULT 0,
        status              TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'pending', 'confirmed', 'rejected')),
        rejection_reason    TEXT,
        reviewed_by         INTEGER REFERENCES users(id),
        reviewed_at         TIMESTAMPTZ,
        confirmed_order_id  INTEGER REFERENCES orders(id),
        created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_whatsapp_pending_orders_open_draft ON whatsapp_pending_orders(conversation_id) WHERE status = 'draft'`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_whatsapp_pending_orders_status ON whatsapp_pending_orders(status)`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS whatsapp_complaints (
        id                SERIAL PRIMARY KEY,
        conversation_id   INTEGER NOT NULL REFERENCES whatsapp_conversations(id) ON DELETE CASCADE,
        customer_phone    TEXT NOT NULL,
        order_id          INTEGER REFERENCES orders(id),
        category          TEXT NOT NULL DEFAULT 'other' CHECK (category IN ('late_order', 'wrong_item', 'quality', 'other')),
        description       TEXT NOT NULL,
        status            TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'resolved')),
        resolution_notes  TEXT,
        assigned_to       INTEGER REFERENCES users(id),
        resolved_by       INTEGER REFERENCES users(id),
        resolved_at       TIMESTAMPTZ,
        created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_whatsapp_complaints_status ON whatsapp_complaints(status)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_whatsapp_complaints_order ON whatsapp_complaints(order_id)`);
  },
};
