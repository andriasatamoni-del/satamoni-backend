// HR-5: POST /api/attendance-sync/punches - نقطة الدخول اللي الـAgent المحلي (attendance-agent/) بيبعت
// بيها بصمات جهاز ZK المتصل بالشبكة للسيرفر (HTTP فقط، بحساب مدير فرع حقيقي عادي بصلاحية
// attendance.sync_device مخصصة - نفس فلسفة print_jobs.manage_queue بالظبط).
const { app, request, pool, seedUser, login, authed } = require("./helpers");

let branchA, branchB;
let adminToken, managerAToken, cashierToken;

beforeAll(async () => {
  const bA = await pool.query("INSERT INTO branches (name) VALUES ('فرع-مزامنة-بصمة-A-جست') RETURNING id");
  branchA = bA.rows[0].id;
  const bB = await pool.query("INSERT INTO branches (name) VALUES ('فرع-مزامنة-بصمة-B-جست') RETURNING id");
  branchB = bB.rows[0].id;

  await seedUser({ name: "أدمن-مزامنة-بصمة", email: "admin-attsync@jest.test", role: "admin" });
  await seedUser({ branchId: branchA, name: "مدير فرع-مزامنة-بصمة-A", email: "managerA-attsync@jest.test", role: "branch_manager" });
  await seedUser({ branchId: branchA, name: "كاشير-مزامنة-بصمة", email: "cashier-attsync@jest.test", role: "cashier" });

  adminToken = await login("admin-attsync@jest.test");
  managerAToken = await login("managerA-attsync@jest.test");
  cashierToken = await login("cashier-attsync@jest.test");
});

afterAll(async () => {
  await pool.end();
});

describe("POST /api/attendance-sync/punches", () => {
  test("كاشير ممنوع (مفيش صلاحية attendance.sync_device افتراضيًا)", async () => {
    const res = await request(app).post("/api/attendance-sync/punches").set(authed(cashierToken)).send({
      punches: [{ deviceCode: "ZK-001", date: "2098-01-05", clockIn: "10:00", clockOut: "18:00" }],
    });
    expect(res.status).toBe(403);
  });

  test("مدير فرع - بيتزامن على فرعه هو تلقائيًا حتى لو بعت branchId فرع تاني", async () => {
    const res = await request(app).post("/api/attendance-sync/punches").set(authed(managerAToken)).send({
      branchId: branchB,
      punches: [{ deviceCode: "ZK-MGR-001", date: "2098-01-05", clockIn: "10:05", clockOut: "18:10" }],
    });
    expect(res.status).toBe(201);
    expect(res.body.branchId).toBe(branchA);
    expect(res.body.imported).toBe(1);

    const row = await pool.query(
      "SELECT * FROM attendance_punches WHERE branch_id = $1 AND device_code = 'ZK-MGR-001' AND punch_date = '2098-01-05'",
      [branchA]
    );
    expect(row.rows.length).toBe(1);
    expect(row.rows[0].clock_in).toBe("10:05:00");
  });

  test("نفس الجهاز/اليوم مرة تانية بوقت مختلف - upsert بيحدّث مش يكرر (idempotent)", async () => {
    const res = await request(app).post("/api/attendance-sync/punches").set(authed(managerAToken)).send({
      punches: [{ deviceCode: "ZK-MGR-001", date: "2098-01-05", clockIn: "10:05", clockOut: "18:45" }],
    });
    expect(res.status).toBe(201);
    const rows = await pool.query(
      "SELECT * FROM attendance_punches WHERE branch_id = $1 AND device_code = 'ZK-MGR-001' AND punch_date = '2098-01-05'",
      [branchA]
    );
    expect(rows.rows.length).toBe(1);
    expect(rows.rows[0].clock_out).toBe("18:45:00");
  });

  test("صف من غير deviceCode أو date بيتستبعد (skipped) من غير ما يوقف باقي الدفعة", async () => {
    const res = await request(app).post("/api/attendance-sync/punches").set(authed(managerAToken)).send({
      punches: [
        { deviceCode: "ZK-MGR-002", date: "2098-01-06", clockIn: "10:00", clockOut: "18:00" },
        { deviceCode: "", date: "2098-01-06", clockIn: "10:00", clockOut: "18:00" },
        { deviceCode: "ZK-MGR-003", date: null, clockIn: "10:00", clockOut: "18:00" },
      ],
    });
    expect(res.status).toBe(201);
    expect(res.body.imported).toBe(1);
    expect(res.body.skipped).toBe(2);
  });

  test("أدمن من غير branchId -> 400", async () => {
    const res = await request(app).post("/api/attendance-sync/punches").set(authed(adminToken)).send({
      punches: [{ deviceCode: "ZK-ADM-001", date: "2098-01-05", clockIn: "10:00", clockOut: "18:00" }],
    });
    expect(res.status).toBe(400);
  });

  test("أدمن ببranchId صريح - بيتزامن على الفرع المحدد", async () => {
    const res = await request(app).post("/api/attendance-sync/punches").set(authed(adminToken)).send({
      branchId: branchB,
      punches: [{ deviceCode: "ZK-ADM-001", date: "2098-01-05", clockIn: "09:55", clockOut: "17:55" }],
    });
    expect(res.status).toBe(201);
    expect(res.body.branchId).toBe(branchB);
    const row = await pool.query(
      "SELECT * FROM attendance_punches WHERE branch_id = $1 AND device_code = 'ZK-ADM-001'",
      [branchB]
    );
    expect(row.rows.length).toBe(1);
  });

  test("من غير قائمة بصمات (أو فاضية) -> 400", async () => {
    const res = await request(app).post("/api/attendance-sync/punches").set(authed(managerAToken)).send({ punches: [] });
    expect(res.status).toBe(400);
  });
});
