// تحكم مالي حقيقي: تقارير الربحية (profit-and-loss/branch-profit-and-loss/gross-profit/
// net-operating-profit/cogs-by-branch) كلها مبنية على قيود البيع المرحّلة، وتكلفة البيع (COGS) بتيجي من
// order_items.cost_at_sale اللي ممكن يبقى incomplete (صنف من غير unit_cost - نفس حالة ITEMS_MISSING_COST
// في db/action-center.js). من غير علم صريح، الأدمن/المحاسب هيشوف رقم ربح "دقيق" وهو فعليًا أقل من
// الحقيقي (مش خطأ محاسبي - القيد لسه متزن - بس بيانات ناقصة بتتحول لأرقام تبان مؤكدة). ده اختبار
// business rule جديد (cogsIncomplete) مش تكرار لاختبارات صلاحيات موجودة.
const { app, request, pool, seedUser, login, authed } = require("./helpers");

let branchId, otherBranchId;
let adminToken, managerToken, otherManagerToken;
let menuItemId1, variantId1, menuItemId2, variantId2;

beforeAll(async () => {
  const b1 = await pool.query("INSERT INTO branches (name) VALUES ('فرع-تكلفة-ناقصة-جست') RETURNING id");
  branchId = b1.rows[0].id;
  const b2 = await pool.query("INSERT INTO branches (name) VALUES ('فرع-تكلفة-كاملة-جست') RETURNING id");
  otherBranchId = b2.rows[0].id;

  await seedUser({ name: "أدمن-تكلفة-ناقصة", email: "admin-plci@jest.test", role: "admin" });
  await seedUser({ branchId, name: "مدير-تكلفة-ناقصة", email: "manager-plci@jest.test", role: "branch_manager" });
  await seedUser({ branchId: otherBranchId, name: "مدير-تكلفة-كاملة", email: "othermanager-plci@jest.test", role: "branch_manager" });
  adminToken = await login("admin-plci@jest.test");
  managerToken = await login("manager-plci@jest.test");
  otherManagerToken = await login("othermanager-plci@jest.test");

  // صنف من غير تكلفة وحدة - مستخدم في وصفة صنف مباع في branchId
  const noCostItem = await pool.query(
    "INSERT INTO inventory_items (name, unit, unit_cost) VALUES ('صنف-من-غير-تكلفة-قدج', 'KG', NULL) RETURNING id"
  );
  await pool.query(
    "INSERT INTO branch_inventory_stock (branch_id, inventory_item_id, quantity) VALUES ($1,$2,1000)",
    [branchId, noCostItem.rows[0].id]
  );
  const cat1 = await pool.query("INSERT INTO menu_categories (name) VALUES ('قسم-تكلفة-ناقصة-جست') RETURNING id");
  const mi1 = await pool.query("INSERT INTO menu_items (category_id, name) VALUES ($1,'صنف مبيع-تكلفة-ناقصة-جست') RETURNING id", [cat1.rows[0].id]);
  const variant1 = await pool.query("INSERT INTO menu_item_variants (item_id, label, price) VALUES ($1,'عادي',100) RETURNING id", [mi1.rows[0].id]);
  await pool.query(
    "INSERT INTO menu_item_variant_ingredients (variant_id, inventory_item_id, quantity_per_unit) VALUES ($1,$2,1)",
    [variant1.rows[0].id, noCostItem.rows[0].id]
  );
  menuItemId1 = mi1.rows[0].id;
  variantId1 = variant1.rows[0].id;

  // صنف بتكلفة كاملة - مستخدم في وصفة صنف مباع في otherBranchId
  const costedItem = await pool.query(
    "INSERT INTO inventory_items (name, unit, unit_cost) VALUES ('صنف-بتكلفة-كاملة-قدج', 'KG', 10) RETURNING id"
  );
  await pool.query(
    "INSERT INTO branch_inventory_stock (branch_id, inventory_item_id, quantity) VALUES ($1,$2,1000)",
    [otherBranchId, costedItem.rows[0].id]
  );
  const cat2 = await pool.query("INSERT INTO menu_categories (name) VALUES ('قسم-تكلفة-كاملة-جست') RETURNING id");
  const mi2 = await pool.query("INSERT INTO menu_items (category_id, name) VALUES ($1,'صنف مبيع-تكلفة-كاملة-جست') RETURNING id", [cat2.rows[0].id]);
  const variant2 = await pool.query("INSERT INTO menu_item_variants (item_id, label, price) VALUES ($1,'عادي',100) RETURNING id", [mi2.rows[0].id]);
  await pool.query(
    "INSERT INTO menu_item_variant_ingredients (variant_id, inventory_item_id, quantity_per_unit) VALUES ($1,$2,1)",
    [variant2.rows[0].id, costedItem.rows[0].id]
  );
  menuItemId2 = mi2.rows[0].id;
  variantId2 = variant2.rows[0].id;
});

afterAll(async () => {
  await pool.end();
});

test("قائمة الدخل ومشتقاتها بتتعلّم cogsIncomplete=true للفرع اللي باع صنف من غير تكلفة، false للفرع التاني", async () => {
  const order1 = await request(app).post("/api/orders").set(authed(managerToken)).send({
    branchId, source: "pos", orderType: "takeaway",
    items: [{ itemId: menuItemId1, variantId: variantId1, quantity: 1 }],
  });
  expect(order1.status).toBe(201);

  const order2 = await request(app).post("/api/orders").set(authed(otherManagerToken)).send({
    branchId: otherBranchId, source: "pos", orderType: "takeaway",
    items: [{ itemId: menuItemId2, variantId: variantId2, quantity: 1 }],
  });
  expect(order2.status).toBe(201);

  const today = new Date().toISOString().slice(0, 10);

  const pl1 = await request(app).get(`/api/reports/profit-and-loss?branchId=${branchId}&from=${today}&to=${today}`).set(authed(adminToken));
  expect(pl1.status).toBe(200);
  expect(pl1.body.cogsIncomplete).toBe(true);

  const pl2 = await request(app).get(`/api/reports/profit-and-loss?branchId=${otherBranchId}&from=${today}&to=${today}`).set(authed(adminToken));
  expect(pl2.body.cogsIncomplete).toBe(false);

  const gp = await request(app).get(`/api/reports/gross-profit?branchId=${branchId}&from=${today}&to=${today}`).set(authed(adminToken));
  expect(gp.body.cogsIncomplete).toBe(true);

  const nop = await request(app).get(`/api/reports/net-operating-profit?branchId=${branchId}&from=${today}&to=${today}`).set(authed(adminToken));
  expect(nop.body.cogsIncomplete).toBe(true);

  const cmp = await request(app).get(`/api/reports/branch-profit-and-loss?from=${today}&to=${today}`).set(authed(adminToken));
  expect(cmp.status).toBe(200);
  const row1 = cmp.body.branches.find((b) => b.branchId === branchId);
  const row2 = cmp.body.branches.find((b) => b.branchId === otherBranchId);
  expect(row1.cogsIncomplete).toBe(true);
  expect(row2.cogsIncomplete).toBe(false);
  expect(cmp.body.consolidated.cogsIncomplete).toBe(true);

  const cogsByBranch = await request(app).get(`/api/reports/cogs-by-branch?from=${today}&to=${today}`).set(authed(adminToken));
  const cb1 = cogsByBranch.body.branches.find((b) => b.branchId === branchId);
  const cb2 = cogsByBranch.body.branches.find((b) => b.branchId === otherBranchId);
  expect(cb1.cogsIncomplete).toBe(true);
  expect(cb2.cogsIncomplete).toBe(false);
});
