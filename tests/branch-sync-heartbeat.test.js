// المرحلة 8.43: نبضة المزامنة (POST /api/sync/heartbeat) - بتحدّث branches.last_synced_at بغض النظر
// عن وجود بيانات جديدة تترفع، عشان GET /api/config/full يقدر يعرض تحذير واقعي ("الفرع ده ممكن يكون
// قاطع نت دلوقتي") في شاشة الكول سنتر - مش تحذير غلط لفرع متصل بس مفيش عنده أوردرات جديدة في آخر دورة.
const { app, request, pool } = require("./helpers");

process.env.SYNC_API_KEY = process.env.SYNC_API_KEY || "heartbeat-test-key";
const AUTH = { Authorization: `Bearer ${process.env.SYNC_API_KEY}` };

afterAll(async () => {
  await pool.end();
});

async function seedBranch(name) {
  const result = await pool.query(`INSERT INTO branches (name) VALUES ($1) RETURNING id`, [name]);
  return result.rows[0].id;
}

describe("POST /api/sync/heartbeat", () => {
  test("بتحدّث last_synced_at للفرع ده بس", async () => {
    const branchId = await seedBranch("فرع نبضة-جست-1");
    const otherBranchId = await seedBranch("فرع نبضة-جست-2");

    const res = await request(app).post("/api/sync/heartbeat").set(AUTH).send({ branchId });
    expect(res.status).toBe(200);

    const row = await pool.query("SELECT last_synced_at FROM branches WHERE id = $1", [branchId]);
    expect(row.rows[0].last_synced_at).not.toBeNull();

    const otherRow = await pool.query("SELECT last_synced_at FROM branches WHERE id = $1", [otherBranchId]);
    expect(otherRow.rows[0].last_synced_at).toBeNull();
  });

  test("بترفض بدون branchId", async () => {
    const res = await request(app).post("/api/sync/heartbeat").set(AUTH).send({});
    expect(res.status).toBe(400);
  });

  test("بترفض رقم فرع مش موجود", async () => {
    const res = await request(app).post("/api/sync/heartbeat").set(AUTH).send({ branchId: 999999 });
    expect(res.status).toBe(400);
  });

  test("بترفض من غير مفتاح مزامنة صحيح", async () => {
    const branchId = await seedBranch("فرع نبضة-جست-3");
    const res = await request(app).post("/api/sync/heartbeat").set({ Authorization: "Bearer wrong-key" }).send({ branchId });
    expect(res.status).toBe(401);
  });
});

describe("GET /api/config/full - lastSyncedAt للفروع", () => {
  test("فرع لسه ما بعتش نبضة خالص - lastSyncedAt = null", async () => {
    const branchId = await seedBranch("فرع كونفيج-جست-1");
    const res = await request(app).get("/api/config/full");
    expect(res.status).toBe(200);
    const branch = res.body.branches.find((b) => b.id === branchId);
    expect(branch).toBeDefined();
    expect(branch.lastSyncedAt).toBeNull();
  });

  test("بعد نبضة ناجحة، lastSyncedAt بيبان في /api/config/full", async () => {
    const branchId = await seedBranch("فرع كونفيج-جست-2");
    await request(app).post("/api/sync/heartbeat").set(AUTH).send({ branchId });

    const res = await request(app).get("/api/config/full");
    const branch = res.body.branches.find((b) => b.id === branchId);
    expect(branch.lastSyncedAt).not.toBeNull();
    // لازم يكون توقيت حديث فعلًا (الثواني اللي فاتت من النبضة لحد الطلب ده)، مش مجرد string موجود
    expect(Date.now() - new Date(branch.lastSyncedAt).getTime()).toBeLessThan(10000);
  });
});
