// المرحلة 7T: تسجيل دخول ذاتي للموظف - عرض قسائم الراتب وطلب إجازة. دور جديد 'employee' (نفس فلسفة
// 'driver' في المرحلة 7F بالظبط: أضيق دور، بياناته الخاصة بس). employees.user_id بيربط ملف HR بحساب
// الدخول (زي drivers.user_id بالظبط) - اختياري، مش كل موظف لازم يبقى له حساب. employee_leave_requests
// جدول منفصل عن employee_leaves عمدًا: ده طلب لسه معلّق مراجعة (مش سجل رسمي)، وبيتحول لصف حقيقي في
// employee_leaves بس لما مدير الفرع/الأدمن يوافق عليه - نفس فكرة "الطلب لوحده مش السجل الرسمي".
module.exports = {
  async up(client) {
    await client.query(`ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check`);
    await client.query(`
      ALTER TABLE users ADD CONSTRAINT users_role_check
      CHECK (role IN ('admin', 'branch_manager', 'accountant', 'cashier', 'callcenter', 'driver', 'employee'))
    `);

    await client.query(`
      DO $$ BEGIN
        ALTER TABLE employees ADD COLUMN user_id INTEGER REFERENCES users(id);
      EXCEPTION WHEN duplicate_column THEN NULL;
      END $$;
    `);
    // المرحلة 7U: Postgres بيرجّع duplicate_table (مش duplicate_object) لما تحاول تضيف UNIQUE constraint
    // اسمه موجود بالفعل - لأن الفهرس اللي القيد بيتبني عليه ضمنيًا relation منفصل. اتكشف الفرق ده فعليًا
    // بتدقيق 7U: schema.sql فيه العمود ده أصلًا (من نفس المرحلة 7T)، فتشغيل db/migrate.js بعد تثبيت أول
    // مرة (npm run migrate = schema.sql) كان بيفشل هنا بالظبط - أي نشر إنتاج جديد كان هيقع وقت الإقلاع
    await client.query(`
      DO $$ BEGIN
        ALTER TABLE employees ADD CONSTRAINT employees_user_id_key UNIQUE (user_id);
      EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL;
      END $$;
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS employee_leave_requests (
        id                 SERIAL PRIMARY KEY,
        employee_id        INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
        leave_type         TEXT NOT NULL CHECK (leave_type IN ('annual', 'sick', 'unpaid', 'casual')),
        start_date         DATE NOT NULL,
        end_date           DATE NOT NULL CHECK (end_date >= start_date),
        days               INTEGER NOT NULL CHECK (days > 0),
        reason             TEXT,
        status             TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
        reviewed_by        INTEGER REFERENCES users(id),
        reviewed_at        TIMESTAMPTZ,
        review_notes       TEXT,
        resulting_leave_id INTEGER REFERENCES employee_leaves(id),
        created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_employee_leave_requests_employee ON employee_leave_requests(employee_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_employee_leave_requests_status ON employee_leave_requests(status)`);
  },
};
