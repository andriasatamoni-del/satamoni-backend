// STEP L-audit (جاهزية الواجهة - TASK 1/2/3/4): GET /api/kitchen-orders - فلاتر إضافية (تاريخ/صانع الطلب/
// حالات متعددة) + ترقيم اختياري (page/limit) + id ثابتة في رد الإنشاء + أخطاء بكود واضح لباراميترات
// الترقيم/الفلترة. كل ده إضافي بالكامل فوق السلوك القديم (مغطى فعليًا في tests/kitchen-orders-workflow.test.js
// اللي لازم يفضل يعدّي زي ما هو من غير أي تغيير).
const { app, request, pool, seedUser, login, authed } = require("./helpers");

let branchId, otherBranchId, ckBranchId;
let adminToken, managerToken, otherManagerToken, ckManagerToken, cashierToken, driverToken;
let itemId;

async function createOrder(token, targetBranchId, { status = "DRAFT", businessDate } = {}) {
  const res = await request(app).post("/api/kitchen-orders").set(authed(token)).send({
    branchId: targetBranchId, status, items: [{ inventoryItemId: itemId, quantityRequested: 5 }],
  });
  expect(res.status).toBe(201);
  if (businessDate) {
    await pool.query("UPDATE kitchen_orders SET business_date = $1 WHERE id = $2", [businessDate, res.body.id]);
  }
  return res.body;
}

beforeAll(async () => {
  const b1 = await pool.query("INSERT INTO branches (name) VALUES ('فرع قايمة-جست') RETURNING id");
  branchId = b1.rows[0].id;
  const b2 = await pool.query("INSERT INTO branches (name) VALUES ('فرع تاني قايمة-جست') RETURNING id");
  otherBranchId = b2.rows[0].id;
  const ck = await pool.query("INSERT INTO branches (name, is_central_kitchen) VALUES ('سنتر كيتشن-قايمة-جست', TRUE) RETURNING id");
  ckBranchId = ck.rows[0].id;

  await seedUser({ name: "أدمن-قايمة", email: "admin-korderslist@jest.test", role: "admin" });
  await seedUser({ branchId, name: "مدير فرع-قايمة", email: "manager-korderslist@jest.test", role: "branch_manager" });
  await seedUser({ branchId: otherBranchId, name: "مدير فرع تاني-قايمة", email: "othermanager-korderslist@jest.test", role: "branch_manager" });
  await seedUser({ branchId: ckBranchId, name: "مدير سنتر كيتشن-قايمة", email: "ck-korderslist@jest.test", role: "branch_manager" });
  await seedUser({ branchId, name: "كاشير-قايمة", email: "cashier-korderslist@jest.test", role: "cashier" });
  await seedUser({ name: "سائق-قايمة", email: "driver-korderslist@jest.test", role: "driver" });

  adminToken = await login("admin-korderslist@jest.test");
  managerToken = await login("manager-korderslist@jest.test");
  otherManagerToken = await login("othermanager-korderslist@jest.test");
  ckManagerToken = await login("ck-korderslist@jest.test");
  cashierToken = await login("cashier-korderslist@jest.test");
  driverToken = await login("driver-korderslist@jest.test");

  const item = await pool.query("INSERT INTO inventory_items (name, unit, unit_cost) VALUES ('صنف قايمة-جست', 'KG', 5) RETURNING id");
  itemId = item.rows[0].id;
});

afterAll(async () => {
  await pool.end();
});

describe("Task 3: id ثابتة في رد الإنشاء مع الحفاظ على orderId القديمة", () => {
  test("POST / بيرجّع id وorderId بنفس القيمة", async () => {
    const res = await request(app).post("/api/kitchen-orders").set(authed(managerToken)).send({
      branchId, status: "DRAFT", items: [{ inventoryItemId: itemId, quantityRequested: 3 }],
    });
    expect(res.status).toBe(201);
    expect(res.body.id).toBeDefined();
    expect(res.body.orderId).toBeDefined();
    expect(res.body.id).toBe(res.body.orderId);
  });
});

describe("Authorization", () => {
  test("1) مدير فرع بيشوف طلبيات فرعه هو من غير branchId خالص", async () => {
    await createOrder(managerToken, branchId);
    const res = await request(app).get("/api/kitchen-orders").set(authed(managerToken));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.every((o) => o.branch_id === branchId)).toBe(true);
    expect(res.body.length).toBeGreaterThan(0);
  });

  test("2) مدير فرع ممنوع يستعلم بـbranchId فرع تاني", async () => {
    const res = await request(app).get(`/api/kitchen-orders?branchId=${otherBranchId}`).set(authed(managerToken));
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("FORBIDDEN_BRANCH");
  });

  test("3) السنتر كيتشن يقدر يشوف طلبيات أي فرع (مايتقيدش بفرعه هو)", async () => {
    const created = await createOrder(managerToken, branchId);
    await request(app).post(`/api/kitchen-orders/${created.id}/submit`).set(authed(managerToken)).expect(200);
    const res = await request(app).get(`/api/kitchen-orders?branchId=${branchId}`).set(authed(ckManagerToken));
    expect(res.status).toBe(200);
    expect(res.body.some((o) => o.branch_id === branchId)).toBe(true);
  });

  test("4) دور غير مصرّح له (سائق) - مرفوض", async () => {
    const res = await request(app).get("/api/kitchen-orders").set(authed(driverToken));
    expect(res.status).toBe(403);
  });
});

describe("Filtering", () => {
  let filterBranchId, filterOrderIds;

  beforeAll(async () => {
    const b = await pool.query("INSERT INTO branches (name) VALUES ('فرع فلترة-جست') RETURNING id");
    filterBranchId = b.rows[0].id;
    await seedUser({ branchId: filterBranchId, name: "مدير فلترة-جست", email: "manager-korfilter@jest.test", role: "branch_manager" });
    const filterManagerToken = await login("manager-korfilter@jest.test");

    const draft = await createOrder(filterManagerToken, filterBranchId, { status: "DRAFT", businessDate: "2026-01-05" });
    const submitted = await createOrder(filterManagerToken, filterBranchId, { status: "DRAFT", businessDate: "2026-01-15" });
    await request(app).post(`/api/kitchen-orders/${submitted.id}/submit`).set(authed(filterManagerToken)).expect(200);
    await pool.query("UPDATE kitchen_orders SET business_date = $1 WHERE id = $2", ["2026-01-15", submitted.id]);
    filterOrderIds = { draftId: draft.id, submittedId: submitted.id };
    global.__filterBranchId = filterBranchId;
    global.__filterManagerToken = filterManagerToken;
  });

  test("5) فلترة بالحالة - status=SUBMITTED بترجّع بس الطلبية المُقدَّمة", async () => {
    const res = await request(app).get(`/api/kitchen-orders?branchId=${filterBranchId}&status=SUBMITTED`).set(authed(adminToken));
    expect(res.status).toBe(200);
    const ids = res.body.map((o) => o.id);
    expect(ids).toContain(filterOrderIds.submittedId);
    expect(ids).not.toContain(filterOrderIds.draftId);
  });

  test("5b) طابور اعتماد السنتر كيتشن - status متعدد مفصول بفاصلة", async () => {
    const res = await request(app).get(`/api/kitchen-orders?branchId=${filterBranchId}&status=DRAFT,SUBMITTED`).set(authed(adminToken));
    expect(res.status).toBe(200);
    const ids = res.body.map((o) => o.id);
    expect(ids).toContain(filterOrderIds.draftId);
    expect(ids).toContain(filterOrderIds.submittedId);
  });

  test("6) فلترة بالفرع - branchId بيقيّد النتيجة على الفرع ده بس", async () => {
    const res = await request(app).get(`/api/kitchen-orders?branchId=${filterBranchId}`).set(authed(adminToken));
    expect(res.status).toBe(200);
    expect(res.body.every((o) => o.branch_id === filterBranchId)).toBe(true);
    expect(res.body.length).toBeGreaterThanOrEqual(2);
  });

  test("7) فلترة بمدى تاريخ (from/to على business_date)", async () => {
    const res = await request(app).get(`/api/kitchen-orders?branchId=${filterBranchId}&from=2026-01-10&to=2026-01-20`).set(authed(adminToken));
    expect(res.status).toBe(200);
    const ids = res.body.map((o) => o.id);
    expect(ids).toContain(filterOrderIds.submittedId);
    expect(ids).not.toContain(filterOrderIds.draftId);
  });

  test("from بصيغة غلط - مرفوض بكود واضح", async () => {
    const res = await request(app).get(`/api/kitchen-orders?branchId=${filterBranchId}&from=not-a-date`).set(authed(adminToken));
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("INVALID_PARAMETER");
  });
});

describe("Pagination", () => {
  let pageBranchId, pageManagerToken;

  beforeAll(async () => {
    const b = await pool.query("INSERT INTO branches (name) VALUES ('فرع ترقيم-جست') RETURNING id");
    pageBranchId = b.rows[0].id;
    await seedUser({ branchId: pageBranchId, name: "مدير ترقيم-جست", email: "manager-korpaging@jest.test", role: "branch_manager" });
    pageManagerToken = await login("manager-korpaging@jest.test");
    for (let i = 0; i < 5; i++) {
      await createOrder(pageManagerToken, pageBranchId, { businessDate: `2026-02-${String(10 + i).padStart(2, "0")}` });
    }
  });

  test("8) حجم صفحة صحيح - limit=2 بيرجّع صفين بالظبط", async () => {
    const res = await request(app).get(`/api/kitchen-orders?branchId=${pageBranchId}&page=1&limit=2`).set(authed(pageManagerToken));
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBe(2);
    expect(res.body.limit).toBe(2);
    expect(res.body.page).toBe(1);
  });

  test("9) إجمالي صحيح - total = 5", async () => {
    const res = await request(app).get(`/api/kitchen-orders?branchId=${pageBranchId}&page=1&limit=2`).set(authed(pageManagerToken));
    expect(res.body.total).toBe(5);
  });

  test("10) totalPages صحيح - 5 عناصر / limit=2 = 3 صفحات", async () => {
    const res = await request(app).get(`/api/kitchen-orders?branchId=${pageBranchId}&page=1&limit=2`).set(authed(pageManagerToken));
    expect(res.body.totalPages).toBe(3);
  });

  test("11) حدود الصفحات - آخر صفحة بترجّع الباقي بس (عنصر واحد)، وترتيب ثابت (الأحدث الأول) من غير تكرار/فقد عبر الصفحات", async () => {
    const page1 = await request(app).get(`/api/kitchen-orders?branchId=${pageBranchId}&page=1&limit=2`).set(authed(pageManagerToken));
    const page2 = await request(app).get(`/api/kitchen-orders?branchId=${pageBranchId}&page=2&limit=2`).set(authed(pageManagerToken));
    const page3 = await request(app).get(`/api/kitchen-orders?branchId=${pageBranchId}&page=3&limit=2`).set(authed(pageManagerToken));
    expect(page1.body.data.length).toBe(2);
    expect(page2.body.data.length).toBe(2);
    expect(page3.body.data.length).toBe(1);

    const allIds = [...page1.body.data, ...page2.body.data, ...page3.body.data].map((o) => o.id);
    expect(new Set(allIds).size).toBe(5); // مفيش تكرار ولا فقد عبر الصفحات

    // الأحدث (business_date الأكبر) الأول
    const businessDates = [...page1.body.data, ...page2.body.data, ...page3.body.data].map((o) => o.business_date);
    const sorted = [...businessDates].sort().reverse();
    expect(businessDates.map((d) => String(d).slice(0, 10))).toEqual(sorted.map((d) => String(d).slice(0, 10)));

    const pageBeyond = await request(app).get(`/api/kitchen-orders?branchId=${pageBranchId}&page=4&limit=2`).set(authed(pageManagerToken));
    expect(pageBeyond.status).toBe(200);
    expect(pageBeyond.body.data.length).toBe(0); // بعد آخر صفحة - مصفوفة فاضية، مش خطأ
  });

  test("12) limit مايتخطاش الحد الأقصى المسموح", async () => {
    const res = await request(app).get(`/api/kitchen-orders?branchId=${pageBranchId}&page=1&limit=1000`).set(authed(pageManagerToken));
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("INVALID_PARAMETER");
  });

  test("page/limit غير صحيحة (صفر أو سالبة) - مرفوضة بكود واضح", async () => {
    const zero = await request(app).get(`/api/kitchen-orders?branchId=${pageBranchId}&page=0&limit=2`).set(authed(pageManagerToken));
    expect(zero.status).toBe(400);
    expect(zero.body.code).toBe("INVALID_PARAMETER");

    const negative = await request(app).get(`/api/kitchen-orders?branchId=${pageBranchId}&page=1&limit=-5`).set(authed(pageManagerToken));
    expect(negative.status).toBe(400);
    expect(negative.body.code).toBe("INVALID_PARAMETER");
  });
});

describe("فلترة بصانع الطلب (createdBy) - مفيد لمدير فرع عايز يشوف بس طلباته هو", () => {
  test("createdBy بيقيّد النتيجة على صانع طلب واحد بس", async () => {
    const b = await pool.query("INSERT INTO branches (name) VALUES ('فرع صانع طلب-جست') RETURNING id");
    const localBranchId = b.rows[0].id;
    await seedUser({ branchId: localBranchId, name: "مدير أول-جست", email: "manager1-korcreator@jest.test", role: "branch_manager" });
    await seedUser({ branchId: localBranchId, name: "مدير تاني-جست", email: "manager2-korcreator@jest.test", role: "branch_manager" });
    const token1 = await login("manager1-korcreator@jest.test");
    const token2 = await login("manager2-korcreator@jest.test");

    const order1 = await createOrder(token1, localBranchId);
    await createOrder(token2, localBranchId);

    const userRow = await pool.query("SELECT id FROM users WHERE email = 'manager1-korcreator@jest.test'");
    const res = await request(app).get(`/api/kitchen-orders?branchId=${localBranchId}&createdBy=${userRow.rows[0].id}`).set(authed(adminToken));
    expect(res.status).toBe(200);
    expect(res.body.every((o) => o.created_by === userRow.rows[0].id)).toBe(true);
    expect(res.body.some((o) => o.id === order1.id)).toBe(true);
  });
});

describe("Backward compatibility - من غير page/limit، الرد لسه مصفوفة خام زي الأول بالظبط", () => {
  test("GET / من غير أي باراميتر ترقيم - Array.isArray(body) صح، مش object فيه data", async () => {
    const res = await request(app).get("/api/kitchen-orders").set(authed(managerToken));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.data).toBeUndefined();
  });
});
