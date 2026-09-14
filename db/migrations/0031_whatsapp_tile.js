// المرحلة 8.43: بطاقة الصفحة الرئيسية لشاشة مراجعة طلبات/شكاوى واتساب المعلّقة (satamoni-whatsapp.html) -
// نفس نمط 0024_add_drivers_dispatch_tiles.js بالظبط
module.exports = {
  async up(client) {
    await client.query(
      `INSERT INTO home_tiles (tile_key, href, icon, title, description, display_order)
       VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (tile_key) DO NOTHING`,
      ["whatsapp", "satamoni-whatsapp.html", "💬", "طلبات وشكاوى واتساب", "مراجعة الطلبات اللي جمّعها بوت واتساب من العملاء وتسجيلها فعليًا، ومتابعة الشكاوى الواردة", 36]
    );
  },
};
