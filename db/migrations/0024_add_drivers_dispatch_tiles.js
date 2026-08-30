// المرحلة 8.21: satamoni-drivers.html (إدارة السائقين) وsatamoni-dispatch.html (لوحة التوزيع
// والتسوية) اتبنوا من زمان (المرحلة 7F) لكن معملهمش بطاقة في الصفحة الرئيسية أصلًا - يعني ماكانش
// فيه طريقة توصلهم غير برابط مباشر. المستخدم سأل "فين شاشة إدارة السائقين؟" فاتضح إنها مش ظاهرة
// خالص - البطاقتين دول بيسدوا الفجوة دي.
module.exports = {
  async up(client) {
    await client.query(
      `INSERT INTO home_tiles (tile_key, href, icon, title, description, display_order)
       VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (tile_key) DO NOTHING`,
      ["drivers", "satamoni-drivers.html", "🛵", "إدارة السائقين (أدمن/مدير فرع)", "إضافة سائق جديد، وتفعيل/تعطيل السائقين الحاليين", 32]
    );
    await client.query(
      `INSERT INTO home_tiles (tile_key, href, icon, title, description, display_order)
       VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (tile_key) DO NOTHING`,
      ["dispatch", "satamoni-dispatch.html", "🛵", "لوحة توزيع وتسوية السائقين", "لوحة توزيع الطلبات على السائقين، ومعاينة/تسوية دفعاتهم", 34]
    );
  },
};
