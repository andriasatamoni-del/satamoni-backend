// HR Foundation Hardening (HRF-6) - TASK 8 (Migration Safety): يتحقق إن migration 0053 فعليًا بتربط
// بيانات موظفين حقيقية (مع فروق كتابة/مسافات) بالكيانات الجديدة من غير ما تفقد أو تدمج حاجة غلط:
// (1) نفس القيمة بفروق مسافات بس (trim) بتتربط لنفس القسم/المسمى الوظيفي،
// (2) قسم مش في القايمة الكانونية بيتعمله قسم جديد تلقائيًا (مش يتفقد)،
// (3) نفس المسمى الوظيفي في قسمين مختلفين مايتفرضش عليه قسم واحد (department_id فاضي على الـPosition)،
// (4) موظف من غير job_title خالص بيتسجل بهدوء (مش خطأ) - مفيش Position له.
const { pool } = require("./helpers");
const migration = require("../db/migrations/0053_department_position_entities");

afterAll(async () => {
  await pool.end();
});

async function seedEmployee(department, jobTitle) {
  const res = await pool.query(
    `INSERT INTO employees (name, department, job_title, attendance_system, base_salary)
     VALUES ('موظف-مايجريشن-جست-' || gen_random_uuid(), $1, $2, 'none', 1000) RETURNING id`,
    [department, jobTitle]
  );
  return res.rows[0].id;
}

test("migration 0053 بتربط بيانات حقيقية (فروق مسافات، أقسام غريبة، مسميات مشتركة) من غير ما تخمّن أو تفقد حاجة", async () => {
  const empExactMatch = await seedEmployee("بيتزا", "شيف بيتزا");
  const empWhitespaceVariant = await seedEmployee("بيتزا ", " شيف بيتزا");
  const empUnknownDept = await seedEmployee("قسم غريب جدًا مايجريشن جست", "مسمى غريب جست");
  const empSharedTitleDifferentDept = await seedEmployee("المطبخ المركزي", "شيف بيتزا");
  const empNoJobTitle = await seedEmployee("حسابات", null);

  await migration.up(pool);

  const rows = await pool.query(
    `SELECT e.id, e.department_id, e.position_id, d.name AS dept_name, p.name AS pos_name, p.department_id AS pos_dept_id
     FROM employees e LEFT JOIN departments d ON d.id = e.department_id LEFT JOIN positions p ON p.id = e.position_id
     WHERE e.id = ANY($1) ORDER BY e.id`,
    [[empExactMatch, empWhitespaceVariant, empUnknownDept, empSharedTitleDifferentDept, empNoJobTitle]]
  );
  const byId = Object.fromEntries(rows.rows.map((r) => [r.id, r]));

  // (1) فروق مسافات بس - نفس الكيان بالظبط
  expect(byId[empExactMatch].department_id).not.toBeNull();
  expect(byId[empWhitespaceVariant].department_id).toBe(byId[empExactMatch].department_id);
  expect(byId[empWhitespaceVariant].position_id).toBe(byId[empExactMatch].position_id);
  expect(byId[empExactMatch].dept_name).toBe("بيتزا");
  expect(byId[empExactMatch].pos_name).toBe("شيف بيتزا");

  // (2) قسم مش كانوني - اتعمله قسم جديد، مفيش فقد بيانات
  expect(byId[empUnknownDept].department_id).not.toBeNull();
  expect(byId[empUnknownDept].dept_name).toBe("قسم غريب جدًا مايجريشن جست");

  // (3) نفس المسمى الوظيفي في قسم مختلف - نفس الـPosition (اتعمل مرة واحدة بس)، بس مفيش تخمين لقسمه
  expect(byId[empSharedTitleDifferentDept].position_id).toBe(byId[empExactMatch].position_id);
  expect(byId[empSharedTitleDifferentDept].pos_dept_id).toBeNull();

  // (4) من غير مسمى وظيفي خالص - حالة صحيحة، مش خطأ، position_id فاضي بس
  expect(byId[empNoJobTitle].department_id).not.toBeNull();
  expect(byId[empNoJobTitle].position_id).toBeNull();

  // مفيش أي موظف اتفقد أو اتسيب من غير قسم (department NOT NULL أصلًا فمفروض تغطية كاملة دايمًا)
  const unresolved = await pool.query(
    `SELECT COUNT(*) AS c FROM employees WHERE id = ANY($1) AND department_id IS NULL`,
    [[empExactMatch, empWhitespaceVariant, empUnknownDept, empSharedTitleDifferentDept, empNoJobTitle]]
  );
  expect(Number(unresolved.rows[0].c)).toBe(0);
});
