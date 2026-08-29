// PHASE UI-1: تعديلات backend صغيرة اكتشفناها وإحنا بنبني الواجهة الأمامية (مش تغييرات في منطق المحاسبة/المخزون):
// 1) suggestedQuantity endpoint كان بيحسب target داخليًا بس ما كانش بيرجّعها - الواجهة محتاجاها تعرض "المخزون
//    المستهدف" من غير ما تعيد حساب خوارزمية الاقتراح في الـJS (زي ما مطلوب صراحة)
// 2) GET /api/kitchen-transfers كان بيفلتر بس على to_branch_id (الوارد) - مدير فرع السنتر كيتشن ماكانش
//    يقدر يشوف التحويلات اللي *هو بعتها* (الصادرة) خالص عن طريق الـendpoint ده. أضفنا fromBranchId فلتر
//    اختياري + from_branch_name في الاستجابة، من غير ما نلمس السلوك الافتراضي القديم (بدون fromBranchId)
// 3) أخطاء INSUFFICIENT_STOCK/DISCREPANCY_VALIDATION كانت بترجع نص عربي بس من غير code آلي - الواجهة
//    محتاجة تفرّق حسب code مش string matching على النص العربي
const { app, request, pool, seedUser, login, authed } = require("./helpers");

let branchId, ckBranchId, otherBranchId, itemId;
let adminToken, managerToken, ckManagerToken, otherManagerToken;

beforeAll(async () => {
  const b1 = await pool.query("INSERT INTO branches (name) VALUES ('فرع UI1-جست') RETURNING id");
  branchId = b1.rows[0].id;
  const ck = await pool.query("INSERT INTO branches (name, is_central_kitchen) VALUES ('سنتر كيتشن-UI1-جست', TRUE) RETURNING id");
  ckBranchId = ck.rows[0].id;
  const b2 = await pool.query("INSERT INTO branches (name) VALUES ('فرع تاني UI1-جست') RETURNING id");
  otherBranchId = b2.rows[0].id;

  await seedUser({ name: "أدمن-UI1", email: "admin-ui1@jest.test", role: "admin" });
  await seedUser({ branchId, name: "مدير فرع-UI1", email: "manager-ui1@jest.test", role: "branch_manager" });
  await seedUser({ branchId: ckBranchId, name: "مدير سنتر كيتشن-UI1", email: "ck-ui1@jest.test", role: "branch_manager" });
  await seedUser({ branchId: otherBranchId, name: "مدير فرع تاني-UI1", email: "othermanager-ui1@jest.test", role: "branch_manager" });

  adminToken = await login("admin-ui1@jest.test");
  managerToken = await login("manager-ui1@jest.test");
  ckManagerToken = await login("ck-ui1@jest.test");
  otherManagerToken = await login("othermanager-ui1@jest.test");

  const item = await pool.query("INSERT INTO inventory_items (name, unit, unit_cost) VALUES ('صنف UI1-جست', 'KG', 10) RETURNING id");
  itemId = item.rows[0].id;
  await pool.query(
    "INSERT INTO branch_inventory_stock (branch_id, inventory_item_id, quantity, min_stock, max_stock) VALUES ($1,$2,5,10,50)",
    [branchId, itemId]
  );
  await pool.query(
    "INSERT INTO branch_inventory_stock (branch_id, inventory_item_id, quantity) VALUES ($1,$2,500)",
    [ckBranchId, itemId]
  );
});

afterAll(async () => {
  await pool.end();
});

describe("GET /api/kitchen-orders/suggested - حقل target", () => {
  test("الاستجابة فيها target = min(expectedConsumption+minStock, maxStock)", async () => {
    const res = await request(app)
      .get(`/api/kitchen-orders/suggested?branchId=${branchId}&targetDate=2026-09-10`)
      .set(authed(managerToken));
    expect(res.status).toBe(200);
    const s = res.body.suggestions.find((x) => x.inventoryItemId === itemId);
    expect(s).toBeDefined();
    expect(s.target).toBeDefined();
    const expected = Math.min(s.expectedConsumption + s.minStock, s.maxStock);
    expect(Number(s.target)).toBeCloseTo(expected, 6);
  });
});

describe("GET /api/kitchen-transfers - فلتر fromBranchId (تحويلات صادرة)", () => {
  test("مدير فرع السنتر كيتشن بيقدر يشوف تحويلاته الصادرة عن طريق fromBranchId", async () => {
    const reqRes = await request(app).post("/api/kitchen-transfers/request").set(authed(ckManagerToken)).send({
      fromBranchId: ckBranchId, toBranchId: branchId, businessDate: "2026-09-10",
      items: [{ inventoryItemId: itemId, quantity: 7 }],
    });
    expect(reqRes.status).toBe(201);

    const res = await request(app)
      .get(`/api/kitchen-transfers?fromBranchId=${ckBranchId}`)
      .set(authed(ckManagerToken));
    expect(res.status).toBe(200);
    expect(res.body.some((t) => t.id === reqRes.body.id)).toBe(true);
    const found = res.body.find((t) => t.id === reqRes.body.id);
    expect(found.from_branch_name).toBe("سنتر كيتشن-UI1-جست");
  });

  test("مدير فرع تاني ممنوع يستخدم fromBranchId لفرع مش بتاعه", async () => {
    const res = await request(app)
      .get(`/api/kitchen-transfers?fromBranchId=${ckBranchId}`)
      .set(authed(otherManagerToken));
    expect(res.status).toBe(403);
  });

  test("السلوك القديم (branchId بس، بدون fromBranchId) فضل زي ما هو تمامًا", async () => {
    const res = await request(app)
      .get(`/api/kitchen-transfers?branchId=${branchId}`)
      .set(authed(managerToken));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    res.body.forEach((t) => expect(t.to_branch_id).toBe(branchId));
  });

  test("أدمن بيقدر يستخدم fromBranchId وbranchId مع بعض", async () => {
    const res = await request(app)
      .get(`/api/kitchen-transfers?fromBranchId=${ckBranchId}&branchId=${branchId}`)
      .set(authed(adminToken));
    expect(res.status).toBe(200);
    res.body.forEach((t) => {
      expect(t.from_branch_id).toBe(ckBranchId);
      expect(t.to_branch_id).toBe(branchId);
    });
  });
});

describe("رموز الأخطاء الآلية (code) في استجابات kitchen-transfers", () => {
  test("DISCREPANCY_VALIDATION بيرجع code في جسم الاستجابة", async () => {
    const reqRes = await request(app).post("/api/kitchen-transfers/request").set(authed(ckManagerToken)).send({
      fromBranchId: ckBranchId, toBranchId: branchId, businessDate: "2026-09-11",
      items: [{ inventoryItemId: itemId, quantity: 10 }],
    });
    const transferId = reqRes.body.id;
    await request(app).post(`/api/kitchen-transfers/${transferId}/approve`).set(authed(adminToken)).expect(200);
    await request(app).post(`/api/kitchen-transfers/${transferId}/issue`).set(authed(ckManagerToken)).expect(200);
    // استلام جزئي (نقص استلام معروف) - بيتحاسب أوتوماتيك، فمينفعش SHORTAGE تاني عليه (قاعدة M-1)
    await request(app).post(`/api/kitchen-transfers/${transferId}/receive`).set(authed(managerToken)).send({
      items: [{ inventoryItemId: itemId, quantityReceived: 6 }],
    }).expect(200);
    const items = await pool.query("SELECT id FROM kitchen_transfer_items WHERE kitchen_transfer_id = $1", [transferId]);
    const res = await request(app).post(`/api/kitchen-transfers/${transferId}/discrepancies`).set(authed(managerToken)).send({
      items: [{ kitchenTransferItemId: items.rows[0].id, inventoryItemId: itemId, discrepancyType: "SHORTAGE", quantity: 1 }],
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("DISCREPANCY_VALIDATION");
  });
});

describe("اسم مقدّم الطلب (created_by_name) في GET /api/kitchen-orders و GET /:id", () => {
  test("مضاف في القائمة (paginated) وفي التفاصيل", async () => {
    const created = await request(app).post("/api/kitchen-orders").set(authed(managerToken)).send({
      branchId, status: "DRAFT", items: [{ inventoryItemId: itemId, quantityRequested: 3 }],
    });
    expect(created.status).toBe(201);

    const listRes = await request(app)
      .get(`/api/kitchen-orders?branchId=${branchId}&page=1&limit=5`)
      .set(authed(managerToken));
    expect(listRes.status).toBe(200);
    const row = listRes.body.data.find((o) => o.id === created.body.id);
    expect(row.created_by_name).toBe("مدير فرع-UI1");

    const detailRes = await request(app).get(`/api/kitchen-orders/${created.body.id}`).set(authed(managerToken));
    expect(detailRes.status).toBe(200);
    expect(detailRes.body.created_by_name).toBe("مدير فرع-UI1");
  });
});
