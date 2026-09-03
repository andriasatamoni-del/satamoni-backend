// المرحلة 8.38: حساب عميل حقيقي (تسجيل/دخول) على موقع الطلب أونلاين - نفس صف customers الموجود
// أصلًا (مفتاحه phone) بيتوسّع بعمود password_hash بس. لو NULL يبقى العميل ده لسه "ضيف" (وصلنا
// بياناته من طلب سابق من غير حساب) - أول تسجيل حساب بيملأه. رقم التليفون فاضل هو نفسه مفتاح الهوية
// (زي ما هو مستخدم في كل النظام: POS/كول سنتر/رواتب الولاء) - مفيش جدول منفصل عشان منكررش نفس
// العميل تحت هويتين مختلفتين.
module.exports = {
  async up(client) {
    await client.query(`
      DO $$ BEGIN
        ALTER TABLE customers ADD COLUMN password_hash TEXT;
      EXCEPTION WHEN duplicate_column THEN NULL;
      END $$;
    `);
  },
};
