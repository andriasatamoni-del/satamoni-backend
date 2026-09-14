// Payment Control & Reconciliation: بطاقة الصفحة الرئيسية لـsatamoni-payment-control.html - نفس نمط
// migration 0024 (بطاقات السائقين/التوزيع) بالظبط.
module.exports = {
  async up(client) {
    await client.query(
      `INSERT INTO home_tiles (tile_key, href, icon, title, description, display_order)
       VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (tile_key) DO NOTHING`,
      [
        "payment-control", "satamoni-payment-control.html", "💳", "التحكم في المدفوعات والمطابقة",
        "كشف فروق طرق الدفع، مطابقة طلبات/فيزا/إنستاباي/أورانج كاش، طلبات تعديل الدفع", 55,
      ]
    );
  },
};
