// المرحلة 7O: سجل تاريخ تغيير أسعار المنيو - نفس نمط employee_history بالظبط (field_name عام،
// old/new، مين غيّر وامتى). بيغطي سعر الحجم الأساسي/سعر طلبات، سعر المرفق الافتراضي، والسعر المخصوص
// لمرفق على حجم معيّن.
module.exports = {
  async up(client) {
    await client.query(`
      CREATE TABLE IF NOT EXISTS menu_price_history (
        id           SERIAL PRIMARY KEY,
        entity_type  TEXT NOT NULL CHECK (entity_type IN ('variant', 'modifier', 'modifier_variant_price')),
        entity_id    INTEGER NOT NULL,
        variant_id   INTEGER REFERENCES menu_item_variants(id) ON DELETE CASCADE,
        field_name   TEXT NOT NULL,
        old_price    NUMERIC,
        new_price    NUMERIC,
        changed_by   INTEGER REFERENCES users(id),
        changed_at   TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_menu_price_history_entity ON menu_price_history(entity_type, entity_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_menu_price_history_variant ON menu_price_history(variant_id)`);
  },
};
