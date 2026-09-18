// بطاقة صحة الفروع - نفس فلسفة action-center.test.js: بنتأكد إن التجميع نفسه شغال ومقفول صح على
// أدمن/محاسب بس (زي inventory-comparison بالظبط - مقارنة بين فروع مالهاش معنى لمدير فرع واحد)، مش
// إعادة اختبار كل مصدر بيانات فرعي لوحده (متغطّي أصلًا في اختباراته المستقلة).
const { app, request, pool, seedUser, login, authed } = require("./helpers");

let branchId, otherBranchId;
let adminToken, accountantToken, managerToken, cashierToken;

beforeAll(async () => {
  const b1 = await pool.query("INSERT INTO branches (name) VALUES ('فرع-صحة-جست') RETURNING id");
  branchId = b1.rows[0].id;
  const b2 = await pool.query("INSERT INTO branches (name) VALUES ('فرع تاني-صحة-جست') RETURNING id");
  otherBranchId = b2.rows[0].id;

  await seedUser({ name: "أدمن-صحة", email: "admin-branchhealth@jest.test", role: "admin" });
  await seedUser({ name: "محاسب-صحة", email: "accountant-branchhealth@jest.test", role: "accountant" });
  await seedUser({ branchId, name: "مدير فرع-صحة", email: "manager-branchhealth@jest.test", role: "branch_manager" });
  await seedUser({ branchId, name: "كاشير-صحة", email: "cashier-branchhealth@jest.test", role: "cashier" });

  adminToken = await login("admin-branchhealth@jest.test");
  accountantToken = await login("accountant-branchhealth@jest.test");
  managerToken = await login("manager-branchhealth@jest.test");
  cashierToken = await login("cashier-branchhealth@jest.test");
});

afterAll(async () => {
  await pool.end();
});

test("مدير فرع - 403 (مقارنة بين فروع مالهاش معنى لمدير فرع واحد، زي inventory-comparison بالظبط)", async () => {
  const res = await request(app).get("/api/reports/branch-health").set(authed(managerToken));
  expect(res.status).toBe(403);
});

test("كاشير - 403", async () => {
  const res = await request(app).get("/api/reports/branch-health").set(authed(cashierToken));
  expect(res.status).toBe(403);
});

test("محاسب - 200 ومدى افتراضي لو from/to مش مبعوتين", async () => {
  const res = await request(app).get("/api/reports/branch-health").set(authed(accountantToken));
  expect(res.status).toBe(200);
  expect(res.body.from).toBeTruthy();
  expect(Array.isArray(res.body.branches)).toBe(true);
  expect(res.body.branches.some((b) => b.branchId === branchId)).toBe(true);
});

test("مخزون سالب وشكوى مفتوحة وفرق كاش شيفت بيظهروا صح للفرع الصح بس", async () => {
  const item = await pool.query("INSERT INTO inventory_items (name, unit, unit_cost) VALUES ('صنف-سالب-صحة-جست', 'KG', 5) RETURNING id");
  await pool.query("INSERT INTO branch_inventory_stock (branch_id, inventory_item_id, quantity) VALUES ($1,$2,-4)", [branchId, item.rows[0].id]);

  const order = await pool.query(
    "INSERT INTO orders (branch_id, source, order_type, status, total) VALUES ($1,'pos','takeaway','completed',50) RETURNING id",
    [branchId]
  );
  await pool.query(
    "INSERT INTO customer_complaints (order_id, branch_id, customer_phone, category, status) VALUES ($1,$2,'01000000000','other','open')",
    [order.rows[0].id, branchId]
  );

  const cashierUser = await pool.query("SELECT id FROM users WHERE email = 'cashier-branchhealth@jest.test'");
  await pool.query(
    `INSERT INTO pos_shifts (branch_id, user_id, status, opened_at, closed_at, expected_cash, actual_cash, cash_variance, variance_status)
     VALUES ($1,$2,'CLOSED', now() - interval '2 hours', now(), 500, 350, -150, 'PENDING_REVIEW')`,
    [branchId, cashierUser.rows[0].id]
  );

  const today = new Date().toISOString().slice(0, 10);
  const res = await request(app)
    .get(`/api/reports/branch-health?from=${today}&to=${today}`)
    .set(authed(adminToken));
  expect(res.status).toBe(200);
  const branchRow = res.body.branches.find((b) => b.branchId === branchId);
  const otherBranchRow = res.body.branches.find((b) => b.branchId === otherBranchId);

  expect(branchRow.negativeStockItems).toBeGreaterThanOrEqual(1);
  expect(branchRow.openComplaints).toBeGreaterThanOrEqual(1);
  expect(branchRow.cashVariance).toBeLessThan(0);
  expect(branchRow.shiftsPendingReview).toBeGreaterThanOrEqual(1);

  expect(otherBranchRow.negativeStockItems).toBe(0);
  expect(otherBranchRow.openComplaints).toBe(0);
  expect(otherBranchRow.cashVariance).toBe(0);
});
