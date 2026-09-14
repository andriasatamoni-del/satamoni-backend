// CRM-1: متابعة أوردرات الدليفري بعد التسليم (customer_followups) + شكاوى العملاء (customer_complaints)
// - نفس التعريف بالظبط اللي في db/schema.sql (راجعه لشرح كل عمود). home_tiles بيتحدّث كمان: بلاطة CRM
// جديدة بارزة (ترتيب 15)، وبلاطة "بيانات العملاء" القديمة بتتشال لأن شاشتها بقت تاب جوه شاشة الـCRM
// الجديدة (satamoni-customers.html نفسه فضل شغال زي ما هو - أي رابط مباشر ليه من مكان تاني هيفضل يشتغل)
module.exports = {
  async up(client) {
    await client.query(`
      CREATE TABLE IF NOT EXISTS customer_followups (
        id                   SERIAL PRIMARY KEY,
        order_id             INTEGER NOT NULL UNIQUE REFERENCES orders(id),
        branch_id            INTEGER REFERENCES branches(id),
        customer_phone       TEXT NOT NULL,
        call_result          TEXT NOT NULL CHECK (call_result IN ('answered', 'no_answer', 'no_answer_after_3_tries')),
        satisfaction_rating  TEXT CHECK (satisfaction_rating IN ('excellent', 'good', 'average', 'bad')),
        notes                TEXT,
        has_complaint        BOOLEAN NOT NULL DEFAULT FALSE,
        called_by            INTEGER REFERENCES users(id),
        called_at            TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_customer_followups_phone ON customer_followups(customer_phone)`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS customer_complaints (
        id                 SERIAL PRIMARY KEY,
        order_id           INTEGER NOT NULL REFERENCES orders(id),
        branch_id          INTEGER REFERENCES branches(id),
        customer_phone     TEXT NOT NULL,
        followup_id        INTEGER REFERENCES customer_followups(id),
        category           TEXT NOT NULL CHECK (category IN ('late_order', 'wrong_item', 'quality', 'other')),
        description        TEXT,
        status             TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'resolved')),
        resolution_notes   TEXT,
        created_by         INTEGER REFERENCES users(id),
        resolved_by        INTEGER REFERENCES users(id),
        resolved_at        TIMESTAMPTZ,
        created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_customer_complaints_phone ON customer_complaints(customer_phone)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_customer_complaints_open ON customer_complaints(status) WHERE status != 'resolved'`);

    await client.query(`
      INSERT INTO home_tiles (tile_key, href, icon, title, description, display_order)
      VALUES ('crm', 'satamoni-crm.html', '📇', 'متابعة العملاء (CRM)',
              'متابعة أوردرات الدليفري بعد التسليم، تسجيل الشكاوى، ودليل العملاء الكامل', 15)
      ON CONFLICT (tile_key) DO NOTHING
    `);
    await client.query(`DELETE FROM home_tiles WHERE tile_key = 'customers'`);
  },
};
