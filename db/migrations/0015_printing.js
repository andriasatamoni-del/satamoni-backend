// نظام الطباعة الإنتاجي: طابعات الفرع + محطات تحضير (المطبخ) + توجيه المنيو للمحطات + طابور طباعة غير
// متزامن (print_jobs). فلسفة أساسية واحدة يجب الحفاظ عليها في كل كود لاحق يلمس الجدول ده: فشل الطباعة
// (طابعة مقطوعة، محطة من غير طابعة مربوطة، ...) ميرجعش يلغي أو يوقف الطلب/الدفع أبدًا - print_jobs بتتسجل
// جوه نفس transaction إنشاء الطلب (عشان الاتساق)، لكن الطباعة الفعلية بتحصل بعدين خارج الـtransaction دي
// (Agent منفصل بيسحب PENDING ويطبع). لو التوجيه (Menu Item/Category -> Station -> Printer) مش متظبط،
// السطر بيتسجل FAILED فورًا مع سبب واضح (بدل ما يختفي بصمت) عشان المدير يشوفه ويظبطه، لكن برضه من غير
// ما يوقف إنشاء الطلب نفسه.
module.exports = {
  async up(client) {
    // محطات التحضير (بيتزا / حلواني / مشويات ...) - مربوطة بفرع معيّن، وممكن تتربط بطابعة (التوجيه نفسه)
    await client.query(`
      CREATE TABLE IF NOT EXISTS kitchen_stations (
        id          SERIAL PRIMARY KEY,
        branch_id   INTEGER NOT NULL REFERENCES branches(id),
        name        TEXT NOT NULL,
        printer_id  INTEGER, -- FK متضاف تحت بعد ما جدول printers يتعرّف (ترتيب الإنشاء)
        is_active   BOOLEAN NOT NULL DEFAULT TRUE,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE(branch_id, name)
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS printers (
        id                   SERIAL PRIMARY KEY,
        branch_id            INTEGER NOT NULL REFERENCES branches(id),
        name                 TEXT NOT NULL, -- اسم وصفي يظهر للمستخدم "طابعة الكاشير الأمامية"
        printer_type         TEXT NOT NULL CHECK (printer_type IN ('CASHIER', 'KITCHEN', 'DELIVERY', 'REPORT')),
        -- USB دلوقتي (os_printer_name = اسم الطابعة بالظبط زي ما ظاهر في Windows، ده اللي الـAgent بيستهدفه) -
        -- LAN جاهزة معماريًا (ip_address/port) لحد ما تتفعّل فعليًا لاحقًا من غير تغيير في الشكل
        connection_type      TEXT NOT NULL DEFAULT 'USB' CHECK (connection_type IN ('USB', 'LAN')),
        os_printer_name      TEXT, -- إلزامي فعليًا لـUSB (بيتحقق منه في route مش في CHECK عشان رسالة خطأ أوضح)
        ip_address           TEXT,
        port                 INTEGER,
        paper_width_mm       INTEGER NOT NULL DEFAULT 80,
        is_enabled           BOOLEAN NOT NULL DEFAULT TRUE,
        -- لو محطة/نوع طباعة مالوش توجيه صريح، تقدر تستخدم الطابعة دي كافتراضي لنوعها في الفرع (زر يدوي
        -- في الإعدادات - مش تلقائي بمجرد إنشاء طابعة جديدة، عشان متبقاش أكتر من طابعة "افتراضية" لنفس
        -- النوع في نفس الفرع من غير قصد)
        is_default_for_type  BOOLEAN NOT NULL DEFAULT FALSE,
        created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);

    await client.query(`
      DO $$ BEGIN
        ALTER TABLE kitchen_stations ADD CONSTRAINT fk_kitchen_stations_printer
          FOREIGN KEY (printer_id) REFERENCES printers(id) ON DELETE SET NULL;
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$;
    `);

    // توجيه المنيو للمحطة: مستوى الصنف (menu_items.station_id) بيغلب مستوى القسم (menu_categories.station_id)
    // لو الاتنين متسجلين - لو الاتنين NULL يبقى مفيش توجيه معروف للصنف ده (بيتسجل FAILED واضح، مش هيختفي)
    await client.query(`
      DO $$ BEGIN
        ALTER TABLE menu_categories ADD COLUMN station_id INTEGER REFERENCES kitchen_stations(id) ON DELETE SET NULL;
      EXCEPTION WHEN duplicate_column THEN NULL;
      END $$;
    `);
    await client.query(`
      DO $$ BEGIN
        ALTER TABLE menu_items ADD COLUMN station_id INTEGER REFERENCES kitchen_stations(id) ON DELETE SET NULL;
      EXCEPTION WHEN duplicate_column THEN NULL;
      END $$;
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS print_jobs (
        id                  SERIAL PRIMARY KEY,
        -- NULL مسموح بس لـTEST_PRINT (مش مرتبطة بطلب حقيقي - زرار "اختبار الطباعة" من شاشة إدارة الطابعات)
        order_id            INTEGER REFERENCES orders(id),
        branch_id           INTEGER NOT NULL REFERENCES branches(id), -- منسوخ من الطلب - الـAgent بيسحب بفرعه بس من غير join
        print_type          TEXT NOT NULL CHECK (print_type IN (
          'CUSTOMER_RECEIPT', 'KITCHEN_TICKET', 'KITCHEN_SUMMARY',
          'DELIVERY_SUMMARY', 'DELIVERY_FINAL_RECEIPT', 'DINE_IN_BILL', 'TEST_PRINT'
        )),
        CONSTRAINT chk_print_jobs_order_id CHECK (order_id IS NOT NULL OR print_type = 'TEST_PRINT'),
        printer_id          INTEGER REFERENCES printers(id) ON DELETE SET NULL, -- NULL لو التوجيه مش متظبط (السطر بيبقى FAILED فورًا)
        station_id          INTEGER REFERENCES kitchen_stations(id), -- تذكرة مطبخ لمحطة معيّنة بس - NULL لغير ذلك
        status              TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'PRINTING', 'PRINTED', 'FAILED', 'CANCELLED')),
        -- المحتوى الجاهز للطباعة (HTML كامل) بيتسجل هنا وقت إنشاء السطر - الـAgent مش محتاج يعرف أي منطق
        -- عمل/منيو/طلب خالص، مجرد يطبع اللي جواه. وده كمان بيحافظ على المحتوى التاريخي ثابت حتى لو
        -- الطلب/المنيو اتعدّل بعد كده
        content_html        TEXT NOT NULL,
        -- منع التكرار عند retry/دبل كليك: مفتاح فريد لكل (طلب، نوع طباعة، محطة، سبب التوليد) - المنطق
        -- الفعلي لتركيبه في db/print-queue.js، نفس فلسفة idempotency_key في accounting-engine/inventory-ledger بالظبط
        idempotency_key     TEXT NOT NULL UNIQUE,
        attempts            INTEGER NOT NULL DEFAULT 0,
        last_error          TEXT,
        created_by          INTEGER REFERENCES users(id),
        created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
        printing_started_at TIMESTAMPTZ,
        printed_at          TIMESTAMPTZ,
        failed_at           TIMESTAMPTZ
      );
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_print_jobs_branch_status ON print_jobs(branch_id, status)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_print_jobs_order ON print_jobs(order_id)`);
  },
};
