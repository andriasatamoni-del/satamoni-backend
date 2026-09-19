// HR Foundation Hardening (HRF-6): Department/Position بقوا entities حقيقية - راجع db/schema.sql
// للتعليق الكامل. الجزء المختلف هنا عن schema.sql (قاعدة فاضية): بيانات حقيقية موجودة بالفعل على
// employees.department/job_title (نص حر) لازم تتربط بالكيانات الجديدة من غير ما نخمّن أو نفقد أي بيانات:
//
//   1. الأقسام السبعة الكانونية (نفس قايمة الفرونت إند الثابتة) بتتزرع لو مش موجودة.
//   2. أي قيمة department موجودة فعليًا في employees ومطابقتش (بعد trim) أي قسم كانوني - بيتعمل لها قسم
//      جديد تلقائيًا (status='active') بدل ما تتجاهل أو تتحذف - "لا تحذف أي بيانات موظف موجودة".
//   3. department_id بيتربط لكل موظف بمطابقة نصية (trim) - مضمون 100% لأن department NOT NULL أصلًا.
//   4. المسميات الوظيفية (job_title، عمود اختياري وحر تمامًا) بتتجمّع بـtrim + توحيد المسافات الداخلية
//      بس (مش lowercase ولا أي تخمين تاني) - قيمتين مختلفتين شكليًا (زي "المدير" و"مدير الفرع") بيفضلوا
//      Position منفصلة عمدًا، مش دمج تلقائي؛ الدمج اليدوي (لو مطلوب) بيتم بعد كده من شاشة الإدارة.
//   5. مفيش أي مسمى وظيفي بيتفقد أو يترفض - كل قيمة موجودة فعليًا (حتى لو غريبة) بتاخد Position جديدة.
//      النتيجة المتوقعة عمليًا: صفر حالات "UNKNOWN - REQUIRES MANUAL REVIEW" لأن الخوارزمية مصمّمة عمدًا
//      عشان تربط كل حاجة موجودة من غير ما تخمّن تطابق بين قيم مختلفة شكليًا - أي تنقية/دمج إضافي قرار
//      بشري لاحق، مش جزء من الـmigration.
//
// النتيجة (عدد الأقسام/المسميات الجديدة، عدد الموظفين اللي اترحّلوا) بتتطبع في الـconsole وقت التشغيل -
// دي مش أرقام معروفة مقدّمًا، بتتحدد فعليًا من بيانات القاعدة الحقيقية وقت تشغيل الـmigration.
module.exports = {
  async up(client) {
    await client.query(`
      DO $$ BEGIN
        CREATE TABLE departments (
          id          SERIAL PRIMARY KEY,
          code        TEXT NOT NULL,
          name        TEXT NOT NULL,
          description TEXT,
          status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
          created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
        );
      EXCEPTION WHEN duplicate_table THEN NULL;
      END $$;
    `);
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_departments_code ON departments(code)`);
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_departments_name ON departments(name)`);

    await client.query(`
      DO $$ BEGIN
        CREATE TABLE positions (
          id            SERIAL PRIMARY KEY,
          code          TEXT NOT NULL,
          name          TEXT NOT NULL,
          department_id INTEGER REFERENCES departments(id),
          description   TEXT,
          status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
          created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
        );
      EXCEPTION WHEN duplicate_table THEN NULL;
      END $$;
    `);
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_positions_code ON positions(code)`);
    await client.query(`CREATE SEQUENCE IF NOT EXISTS position_code_seq START 1`);

    await client.query(`
      DO $$ BEGIN
        ALTER TABLE employees ADD COLUMN department_id INTEGER REFERENCES departments(id);
      EXCEPTION WHEN duplicate_column THEN NULL;
      END $$;
    `);
    await client.query(`
      DO $$ BEGIN
        ALTER TABLE employees ADD COLUMN position_id INTEGER REFERENCES positions(id);
      EXCEPTION WHEN duplicate_column THEN NULL;
      END $$;
    `);

    await client.query(`
      CREATE OR REPLACE FUNCTION sync_employee_department_position() RETURNS TRIGGER AS $$
      BEGIN
        IF NEW.department_id IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.department_id IS DISTINCT FROM OLD.department_id) THEN
          SELECT name INTO NEW.department FROM departments WHERE id = NEW.department_id;
        END IF;
        IF NEW.position_id IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.position_id IS DISTINCT FROM OLD.position_id) THEN
          SELECT name INTO NEW.job_title FROM positions WHERE id = NEW.position_id;
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);
    await client.query(`
      DO $$ BEGIN
        CREATE TRIGGER trg_sync_employee_department_position
          BEFORE INSERT OR UPDATE ON employees
          FOR EACH ROW EXECUTE FUNCTION sync_employee_department_position();
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$;
    `);

    // 1) الأقسام الكانونية
    const canonicalDepartments = [
      ["PIZZA", "بيتزا"], ["PASTRY", "فطير"], ["BRANCH_OPS", "تشغيل الفرع"], ["ADMIN", "الإدارة"],
      ["ACCOUNTS", "حسابات"], ["CALL_CENTER", "كول سنتر"], ["CENTRAL_KITCHEN", "المطبخ المركزي"],
    ];
    for (const [code, name] of canonicalDepartments) {
      await client.query(
        `INSERT INTO departments (code, name) VALUES ($1, $2) ON CONFLICT (name) DO NOTHING`,
        [code, name]
      );
    }

    // 2) أي قيمة department موجودة فعليًا في employees ومطابقتش قسم كانوني - قسم جديد تلقائيًا
    const distinctDepartments = await client.query(
      `SELECT DISTINCT TRIM(department) AS name FROM employees WHERE department IS NOT NULL AND TRIM(department) <> ''`
    );
    let newDepartmentsCreated = 0;
    for (const row of distinctDepartments.rows) {
      const existing = await client.query(`SELECT id FROM departments WHERE name = $1`, [row.name]);
      if (existing.rows.length > 0) continue;
      const codeSeq = await client.query(`SELECT nextval('position_code_seq') AS n`); // مشترك، أي sequence كفاية هنا فعليًا
      await client.query(
        `INSERT INTO departments (code, name) VALUES ($1, $2) ON CONFLICT (name) DO NOTHING`,
        [`DEPT-${String(codeSeq.rows[0].n).padStart(6, "0")}`, row.name]
      );
      newDepartmentsCreated++;
    }

    // 3) ربط department_id بمطابقة نصية (trim) - department NOT NULL فمفروض تغطية 100%
    const departmentBackfill = await client.query(`
      UPDATE employees e SET department_id = d.id
      FROM departments d WHERE TRIM(e.department) = d.name AND e.department_id IS NULL
      RETURNING e.id
    `);

    // 4-5) المسميات الوظيفية: trim + توحيد المسافات الداخلية بس - مفيش أي تخمين لدمج قيم مختلفة شكليًا
    const distinctJobTitles = await client.query(
      `SELECT DISTINCT job_title FROM employees WHERE job_title IS NOT NULL AND TRIM(job_title) <> ''`
    );
    const normalizedGroups = new Map(); // normalized -> canonical display name (أول قيمة شوفناها)
    for (const row of distinctJobTitles.rows) {
      const normalized = row.job_title.trim().replace(/\s+/g, " ");
      if (!normalizedGroups.has(normalized)) normalizedGroups.set(normalized, normalized);
    }
    let newPositionsCreated = 0;
    for (const displayName of normalizedGroups.values()) {
      const existing = await client.query(`SELECT id FROM positions WHERE name = $1`, [displayName]);
      if (existing.rows.length > 0) continue;
      const codeSeq = await client.query(`SELECT nextval('position_code_seq') AS n`);
      await client.query(
        `INSERT INTO positions (code, name) VALUES ($1, $2) ON CONFLICT (code) DO NOTHING`,
        [`POS-${String(codeSeq.rows[0].n).padStart(6, "0")}`, displayName]
      );
      newPositionsCreated++;
    }

    // ربط position_id - بمطابقة النص بعد نفس التطبيع (trim + توحيد مسافات) اللي اتعمل وقت الإنشاء فوق
    const positionBackfill = await client.query(`
      UPDATE employees e SET position_id = p.id
      FROM positions p
      WHERE e.job_title IS NOT NULL AND TRIM(REGEXP_REPLACE(e.job_title, '\\s+', ' ', 'g')) = p.name
        AND e.position_id IS NULL
      RETURNING e.id
    `);

    console.log(
      `[migration 0053] departments: +${newDepartmentsCreated} new (beyond the 7 canonical), ` +
      `positions: +${newPositionsCreated} new from ${distinctJobTitles.rows.length} distinct job titles, ` +
      `employees backfilled: department_id=${departmentBackfill.rows.length}, position_id=${positionBackfill.rows.length}`
    );

    // موظفين معندهمش department_id بعد كل ده = حالة "UNKNOWN - REQUIRES MANUAL REVIEW" حقيقية (مش
    // متوقع تحصل أصلًا لأن department NOT NULL، بس بنبلّغ عنها صراحة لو حصلت بدل ما نتجاهلها)
    const unresolved = await client.query(`SELECT id, name, department FROM employees WHERE department_id IS NULL`);
    if (unresolved.rows.length > 0) {
      console.warn(
        `[migration 0053] UNKNOWN - REQUIRES MANUAL REVIEW: ${unresolved.rows.length} employee(s) could not be ` +
        `linked to a department automatically: ${JSON.stringify(unresolved.rows)}`
      );
    }
  },
};
