// HR-4: تقرير التأخيرات المتكررة (GET /api/hr/reports/repeated-lateness) - مين بيتأخر كتير بشكل
// متكرر (موظفي البصمة التلقائي بس) عبر مدى تاريخ مرن، للمتابعة الإدارية مش لحساب خصم راتب.
const { app, request, pool, seedUser, login, authed } = require("./helpers");

let branchA, branchB;
let adminToken, managerAToken;
let frequentEmpId, rareEmpId, otherBranchEmpId;

async function punch(branchId, deviceCode, date, clockIn, exempted = false) {
  await pool.query(
    `INSERT INTO attendance_punches (branch_id, device_code, punch_date, clock_in, clock_out, exempted)
     VALUES ($1,$2,$3,$4,'20:00',$5)`,
    [branchId, deviceCode, date, clockIn, exempted]
  );
}

beforeAll(async () => {
  const bA = await pool.query("INSERT INTO branches (name) VALUES ('فرع-تأخير-A-جست') RETURNING id");
  branchA = bA.rows[0].id;
  const bB = await pool.query("INSERT INTO branches (name) VALUES ('فرع-تأخير-B-جست') RETURNING id");
  branchB = bB.rows[0].id;

  await seedUser({ name: "أدمن-تأخير", email: "admin-lateness@jest.test", role: "admin" });
  await seedUser({ branchId: branchA, name: "مدير فرع-تأخير-A", email: "managerA-lateness@jest.test", role: "branch_manager" });
  adminToken = await login("admin-lateness@jest.test");
  managerAToken = await login("managerA-lateness@jest.test");

  // موظف متأخر كتير - 4 أيام تأخير حقيقي (10:30 صباحًا - الشيفت الصباحي يبدأ 10:00 افتراضيًا) + يوم بإذن
  // تأخير (exempted) لازم يتستبعد من العد + يوم في الميعاد بالظبط
  const freq = await pool.query(
    `INSERT INTO employees (name, department, attendance_system, base_salary, shift, restricted_branch_id, is_active)
     VALUES ('موظف-متأخر-كتير-جست', 'تشغيل الفرع', 'fingerprint_auto', 4000, 'morning', $1, TRUE) RETURNING id`,
    [branchA]
  );
  frequentEmpId = freq.rows[0].id;
  await pool.query(
    "INSERT INTO employee_fingerprint_codes (employee_id, branch_id, device_code) VALUES ($1,$2,'DEV-FREQ-LATE')",
    [frequentEmpId, branchA]
  );
  await punch(branchA, "DEV-FREQ-LATE", "2096-05-02", "10:30");
  await punch(branchA, "DEV-FREQ-LATE", "2096-05-05", "10:45");
  await punch(branchA, "DEV-FREQ-LATE", "2096-05-10", "10:20");
  await punch(branchA, "DEV-FREQ-LATE", "2096-05-15", "10:40", true); // exempted - مايتحسبش
  await punch(branchA, "DEV-FREQ-LATE", "2096-05-20", "10:15");
  await punch(branchA, "DEV-FREQ-LATE", "2096-05-25", "09:55"); // في الميعاد

  // موظف اتأخر مرة واحدة بس - لازم يتفلتر بره النتيجة تحت minLateDays الافتراضي (3)
  const rare = await pool.query(
    `INSERT INTO employees (name, department, attendance_system, base_salary, shift, restricted_branch_id, is_active)
     VALUES ('موظف-متأخر-نادر-جست', 'تشغيل الفرع', 'fingerprint_auto', 4000, 'morning', $1, TRUE) RETURNING id`,
    [branchA]
  );
  rareEmpId = rare.rows[0].id;
  await pool.query(
    "INSERT INTO employee_fingerprint_codes (employee_id, branch_id, device_code) VALUES ($1,$2,'DEV-RARE-LATE')",
    [rareEmpId, branchA]
  );
  await punch(branchA, "DEV-RARE-LATE", "2096-05-03", "10:30");

  // موظف في فرع تاني - لازم مدير فرع A مايشوفوش
  const other = await pool.query(
    `INSERT INTO employees (name, department, attendance_system, base_salary, shift, restricted_branch_id, is_active)
     VALUES ('موظف-فرع-تاني-تأخير-جست', 'تشغيل الفرع', 'fingerprint_auto', 4000, 'morning', $1, TRUE) RETURNING id`,
    [branchB]
  );
  otherBranchEmpId = other.rows[0].id;
  await pool.query(
    "INSERT INTO employee_fingerprint_codes (employee_id, branch_id, device_code) VALUES ($1,$2,'DEV-OTHER-LATE')",
    [otherBranchEmpId, branchB]
  );
  await punch(branchB, "DEV-OTHER-LATE", "2096-05-02", "10:30");
  await punch(branchB, "DEV-OTHER-LATE", "2096-05-05", "10:30");
  await punch(branchB, "DEV-OTHER-LATE", "2096-05-08", "10:30");

  // بصمة برة مدى الشهر المطلوب في الاختبارات (يونيو) - لازم تتستبعد من التقرير لما نحدد from/to لمايو بس
  await punch(branchA, "DEV-FREQ-LATE", "2096-06-01", "10:30");
});

afterAll(async () => {
  await pool.end();
});

describe("GET /api/hr/reports/repeated-lateness", () => {
  const range = { from: "2096-05-01", to: "2096-05-31" };

  test("أدمن - الموظف اللي اتأخر 4 مرات (minLateDays الافتراضي 3) بيظهر، والنادر (مرة واحدة) لأ", async () => {
    const res = await request(app).get("/api/hr/reports/repeated-lateness").set(authed(adminToken)).query(range);
    expect(res.status).toBe(200);
    const freqRow = res.body.employees.find((e) => e.employeeId === frequentEmpId);
    expect(freqRow).toBeTruthy();
    expect(freqRow.lateDaysCount).toBe(4);
    expect(freqRow.totalLateMinutes).toBe(30 + 45 + 20 + 15); // اليوم المعفى مستبعد من المجموع كمان

    const rareRow = res.body.employees.find((e) => e.employeeId === rareEmpId);
    expect(rareRow).toBeUndefined();
  });

  test("minLateDays=1 - الموظف النادر بيظهر", async () => {
    const res = await request(app).get("/api/hr/reports/repeated-lateness").set(authed(adminToken)).query({ ...range, minLateDays: 1 });
    const rareRow = res.body.employees.find((e) => e.employeeId === rareEmpId);
    expect(rareRow).toBeTruthy();
    expect(rareRow.lateDaysCount).toBe(1);
  });

  test("بصمة يونيو (برة المدى) متستبعدش من عدد مايو", async () => {
    const res = await request(app).get("/api/hr/reports/repeated-lateness").set(authed(adminToken)).query(range);
    const freqRow = res.body.employees.find((e) => e.employeeId === frequentEmpId);
    expect(freqRow.lateDaysCount).toBe(4); // مش 5
  });

  test("مدير فرع A يشوف موظف فرعه بس، مش موظف فرع B", async () => {
    const res = await request(app).get("/api/hr/reports/repeated-lateness").set(authed(managerAToken)).query(range);
    expect(res.body.employees.find((e) => e.employeeId === frequentEmpId)).toBeTruthy();
    expect(res.body.employees.find((e) => e.employeeId === otherBranchEmpId)).toBeUndefined();
  });

  test("أدمن من غير فلتر فرع يشوف موظف فرع B كمان", async () => {
    const res = await request(app).get("/api/hr/reports/repeated-lateness").set(authed(adminToken)).query(range);
    const otherRow = res.body.employees.find((e) => e.employeeId === otherBranchEmpId);
    expect(otherRow).toBeTruthy();
    expect(otherRow.lateDaysCount).toBe(3);
    expect(otherRow.branchName).toBe("فرع-تأخير-B-جست");
  });

  test("كاشير ممنوع تمامًا", async () => {
    await seedUser({ name: "كاشير-تأخير", email: "cashier-lateness@jest.test", role: "cashier" });
    const token = await login("cashier-lateness@jest.test");
    const res = await request(app).get("/api/hr/reports/repeated-lateness").set(authed(token)).query(range);
    expect(res.status).toBe(403);
  });
});
