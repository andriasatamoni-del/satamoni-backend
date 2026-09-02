// المرحلة 8.29: شاشة "الأصناف" الجديدة (Item Master) - كتالوج موحّد للبحث السريع عن أي صنف (مادة خام،
// مادة مصنّعة، أو صنف منيو) وعرض كل تفاصيله في مكان واحد.
module.exports = {
  async up(client) {
    await client.query(
      `INSERT INTO home_tiles (tile_key, href, icon, title, description, display_order)
       VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (tile_key) DO NOTHING`,
      ["items", "satamoni-items.html", "🗂️", "الأصناف", "كتالوج شامل للمواد الخام والمصنّعة وأصناف المنيو - بحث سريع وتفاصيل كل صنف في مكان واحد", 45]
    );
  },
};
