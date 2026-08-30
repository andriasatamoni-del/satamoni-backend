// المرحلة 8.17: بطاقات الصفحة الرئيسية بقت مخزّنة في الداتابيز بدل ما تكون ثابتة في كود index.html -
// المالك يقدر يغيّر اسم/ترتيب أي بطاقة من لوحة الأدمن. نفس بيانات البطاقات العشرين الحالية بالظبط.
module.exports = {
  async up(client) {
    await client.query(`
      CREATE TABLE IF NOT EXISTS home_tiles (
        id             SERIAL PRIMARY KEY,
        tile_key       TEXT NOT NULL UNIQUE,
        href           TEXT NOT NULL,
        icon           TEXT NOT NULL,
        title          TEXT NOT NULL,
        description    TEXT NOT NULL,
        display_order  INTEGER NOT NULL DEFAULT 0
      )
    `);
    const existing = await client.query("SELECT COUNT(*)::int AS c FROM home_tiles");
    if (existing.rows[0].c > 0) return; // مطبّقة قبل كده (أو الجدول اتعمل من schema.sql مع بياناته)

    const tiles = [
      ["pos", "satamoni-pos.html", "🧾", "نقطة البيع (كاشير)", "تسجيل طلبات الفرع مباشرة", 10],
      ["callcenter", "satamoni-callcenter.html", "📞", "الكول سنتر", "بحث عن عميل وتسجيل طلب تليفوني", 20],
      ["delivery", "satamoni-delivery.html", "🛵", "دورة حياة الدليفري", "تحت التحضير، في الطريق، تحصيل الفلوس، وسجل كل الطلبات", 30],
      ["dashboard", "satamoni-dashboard.html", "📊", "داش بورد المالك", "كل تفاصيل الشغل في شاشة واحدة: مبيعات، أصناف وفروع ومناطق الأكثر مبيعًا، تكلفة، ربحية", 40],
      ["accounting", "satamoni-accounting.html", "💰", "الحسابات", "مصروفات، مشتريات، تقفيل كاش، كشف حساب المخزن", 50],
      ["reports", "satamoni-reports.html", "📈", "مركز التقارير", "مبيعات، هالك، ملغي، تأخيرات، أداء الأصناف، مصروفات ومشتريات، مناطق وطيارين، خدمة الدليفري", 60],
      ["customers", "satamoni-customers.html", "👥", "بيانات العملاء", "دليل العملاء وبحث برقم التليفون، نقاط الولاء، والعملاء اللي مطلبوش بقالهم فترة", 70],
      ["audit", "satamoni-audit.html", "🛡️", "سجل التدقيق والموافقات", "كل عملية حساسة اتسجلت مين وامتى، وطلبات موافقة على تسوية المخزون", 80],
      ["attendance", "satamoni-attendance.html", "🕒", "الحضور والانصراف", "تسجيل حضورك، أو متابعة شيفتات الفرع", 90],
      ["admin", "satamoni-admin.html", "🔐", "إدارة المستخدمين (أدمن)", "إضافة موظفين وتحديد صلاحياتهم", 100],
      ["menu", "satamoni-menu.html", "📋", "المنيو والإعدادات (أدمن)", "إضافة الأصناف والأسعار، مناطق التوصيل، طرق الدفع", 110],
      ["kitchen", "satamoni-kitchen.html", "🏭", "السنتر كيتشن", "طلبيات الفروع، التحويلات، والتصنيع من خام لمواد مصنّعة", 120],
      ["requisitions", "satamoni-requisitions.html", "📦", "طلبيات الفرع", "لوحة الفرع، اقتراح طلبية، تقديم، استلام تحويلات، والإبلاغ عن فروقات", 130],
      ["ck-requisitions", "satamoni-ck-requisitions.html", "🏭", "طلبيات السنتر كيتشن", "اعتماد طلبيات الفروع، التجهيز، والتحويل للفروع", 140],
      ["purchasing", "satamoni-purchasing.html", "🧾", "المشتريات", "طلبات شراء، أوامر شراء، استلام مشتريات، فواتير وسداد الموردين", 150],
      ["manufacturing", "satamoni-manufacturing.html", "🏭", "التصنيع والتعبئة", "وصفات (BOM)، أوامر تصنيع، تعبئة، وتتبّع الدفعات من الخام لحد الفرع", 160],
      ["production-planning", "satamoni-production-planning.html", "📋", "تخطيط التصنيع", "طلب الفروع، المتاح، المطلوب تصنيعه، احتياج الخامات، وإنشاء أوامر التصنيع من الخطة", 170],
      ["kds", "satamoni-kds.html", "👨‍🍳", "شاشة المطبخ (KDS)", "لوحة تتبّع تحضير الطلبات لحظيًا: جديد، مقبول، بيتحضّر، جاهز", 180],
      ["payroll", "satamoni-payroll.html", "🧑‍🍳", "الرواتب (أدمن/محاسب)", "حساب أوتوماتيكي من البصمة، سلف وجزاءات ومكافآت، ملخص شهري", 190],
      ["printing", "satamoni-printing.html", "🖨️", "إعدادات الطباعة (أدمن/مدير فرع)", "الطابعات، محطات المطبخ، وربط كل محطة بطابعتها لكل فرع", 200],
    ];
    for (const [tileKey, href, icon, title, description, displayOrder] of tiles) {
      await client.query(
        `INSERT INTO home_tiles (tile_key, href, icon, title, description, display_order)
         VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (tile_key) DO NOTHING`,
        [tileKey, href, icon, title, description, displayOrder]
      );
    }
  },
};
