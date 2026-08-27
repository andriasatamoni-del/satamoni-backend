// المرحلة 8E: اختبار حماية GET /api/orders من غير أي فلتر أو مع فلتر فرع بيرجع 100 ألف صف بدون حد
// أقصى - اتكشف بقياس أداء حقيقي على قاعدة بيانات بحجم 100 ألف طلب (~2.3 ثانية استجابة، لأن الاستعلام
// كان من غير LIMIT خالص). الإصلاح: ORDERS_LIST_ROW_LIMIT = 500 في routes/orders.js
const { app, request, pool, seedUser, login, authed } = require("./helpers");

let branchId;
let adminToken;

beforeAll(async () => {
  const b = await pool.query("INSERT INTO branches (name) VALUES ('فرع-8E-أداء-جست') RETURNING id");
  branchId = b.rows[0].id;
  await seedUser({ branchId, name: "أدمن-8E-أداء", email: "admin-8e-perf@jest.test", role: "admin" });
  adminToken = await login("admin-8e-perf@jest.test");

  // 600 طلب دفعة واحدة (أكتر من الحد الأقصى 500) على نفس الفرع، عشان نتأكد الحد بيتفعّل فعليًا
  await pool.query(
    `INSERT INTO orders (branch_id, source, order_type, total, status, created_at)
     SELECT $1, 'pos', 'takeaway', 100, 'completed', now() - (g || ' seconds')::interval
     FROM generate_series(1, 600) g`,
    [branchId]
  );
});

afterAll(async () => {
  await pool.end();
});

describe("8E: GET /api/orders محدود بحد أقصى (كان من غير LIMIT خالص)", () => {
  test("فرع فيه 600 طلب - الاستجابة بترجع 500 كحد أقصى، مش الـ600 كلهم", async () => {
    const res = await request(app).get(`/api/orders?branchId=${branchId}`).set(authed(adminToken));
    expect(res.status).toBe(200);
    expect(res.body.length).toBeLessThanOrEqual(500);
  });

  test("الترتيب لسه الأحدث الأول (created_at DESC) حتى مع الحد الأقصى", async () => {
    const res = await request(app).get(`/api/orders?branchId=${branchId}`).set(authed(adminToken));
    const dates = res.body.map((o) => new Date(o.created_at).getTime());
    const sorted = [...dates].sort((a, b) => b - a);
    expect(dates).toEqual(sorted);
  });
});
