// المرحلة 8.46: توسيع أتمتة المحادثات لتشمل فيسبوك ماسنجر وإنستجرام مش واتساب بس - بنعيد استخدام نفس
// whatsapp_conversations (ومعاها المنطق كله: persona/tools/conversation engine) بدل تكرارها لكل قناة.
// راجع db/schema.sql للتعليق الكامل على معنى عمود channel وphone حسب القناة.
module.exports = {
  async up(client) {
    await client.query(`
      DO $$ BEGIN
        ALTER TABLE whatsapp_conversations ADD COLUMN channel TEXT NOT NULL DEFAULT 'whatsapp'
          CHECK (channel IN ('whatsapp', 'messenger', 'instagram'));
      EXCEPTION WHEN duplicate_column THEN NULL;
      END $$;
    `);

    // كان فيه UNIQUE على phone لوحدها - دلوقتي التفرّد لازم يكون لكل قناة (نظريًا مينفعش PSID يتشابه
    // مع رقم هاتف واتساب، بس بنحدد النطاق صراحة عشان يكون صحيح منطقيًا مش بس عمليًا)
    await client.query(`
      DO $$ BEGIN
        ALTER TABLE whatsapp_conversations DROP CONSTRAINT whatsapp_conversations_phone_key;
      EXCEPTION WHEN undefined_object THEN NULL;
      END $$;
    `);
    // راجع تدقيق 7U (tests/migration-safety-fresh-install.test.js) و0012_employee_self_service.js -
    // Postgres بيرجّع duplicate_table (مش duplicate_object) لما تحاول تضيف UNIQUE constraint اسمه
    // موجود بالفعل، لأن الفهرس اللي القيد بيتبني عليه ضمنيًا relation منفصل - بيحصل هنا بالظبط لو
    // schema.sql (تثبيت أول مرة) فيه نفس القيد أصلاً بنفس الاسم التلقائي
    await client.query(`
      DO $$ BEGIN
        ALTER TABLE whatsapp_conversations ADD CONSTRAINT whatsapp_conversations_channel_phone_key UNIQUE (channel, phone);
      EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL;
      END $$;
    `);

    await client.query(
      `UPDATE home_tiles SET title = $2, description = $3 WHERE tile_key = $1`,
      ["whatsapp", "طلبات وشكاوى المحادثات", "مراجعة الطلبات اللي جمّعها البوت من واتساب/ماسنجر/إنستجرام وتسجيلها فعليًا، ومتابعة الشكاوى الواردة"]
    );
  },
};
