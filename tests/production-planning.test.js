// MASTER MISSION - PART 1: اختبارات محرك/راوت تخطيط تصنيع السنتر كيتشن (db/production-planning.js +
// routes/production-planning.js). التركيز: عدم الاحتساب المزدوج للطلب/المتاح/التنفيذ، تجميع أكتر من فرع،
// نقص الخامات عبر محرك الوصفات الموجود، الأصناف اللي مفيهاش وصفة مباشرة، عزل الصلاحيات/الفروع.
const { app, request, pool, seedUser, login, authed } = require("./helpers");

let branchAId, branchBId, ckBranchId, otherCkBranchId;
let adminToken, branchAManagerToken, ckManagerToken;
let rawItemId, manufacturedItemId, noRecipeItemId;
let recipeVersionId, recipeId;

async function createApprovedOrder(token, branchId, itemId, quantity, requiredDate) {
  const created = await request(app).post("/api/kitchen-orders").set(authed(token)).send({
    branchId, status: "DRAFT", requiredDate, items: [{ inventoryItemId: itemId, quantityRequested: quantity }],
  });
  const orderId = created.body.orderId;
  await request(app).post(`/api/kitchen-orders/${orderId}/submit`).set(authed(token)).expect(200);
  await request(app).post(`/api/kitchen-orders/${orderId}/approve`).set(authed(ckManagerToken)).expect(200);
  return orderId;
}

beforeAll(async () => {
  const bA = await pool.query("INSERT INTO branches (name) VALUES ('فرع أ-تخطيط-جست') RETURNING id");
  branchAId = bA.rows[0].id;
  const bB = await pool.query("INSERT INTO branches (name) VALUES ('فرع ب-تخطيط-جست') RETURNING id");
  branchBId = bB.rows[0].id;
  const ck = await pool.query("INSERT INTO branches (name, is_central_kitchen) VALUES ('سنتر كيتشن-تخطيط-جست', TRUE) RETURNING id");
  ckBranchId = ck.rows[0].id;
  const otherCk = await pool.query("INSERT INTO branches (name, is_central_kitchen) VALUES ('سنتر كيتشن تاني-تخطيط-جست', TRUE) RETURNING id");
  otherCkBranchId = otherCk.rows[0].id;

  await seedUser({ name: "أدمن-تخطيط", email: "admin-planning@jest.test", role: "admin" });
  await seedUser({ branchId: branchAId, name: "مدير فرع أ-تخطيط", email: "branchA-planning@jest.test", role: "branch_manager" });
  await seedUser({ branchId: branchBId, name: "مدير فرع ب-تخطيط", email: "branchB-planning@jest.test", role: "branch_manager" });
  await seedUser({ branchId: ckBranchId, name: "مدير سنتر كيتشن-تخطيط", email: "ck-planning@jest.test", role: "branch_manager" });
  adminToken = await login("admin-planning@jest.test");
  branchAManagerToken = await login("branchA-planning@jest.test");
  const branchBManagerToken = await login("branchB-planning@jest.test");
  ckManagerToken = await login("ck-planning@jest.test");
  void branchBManagerToken;

  const raw = await pool.query("INSERT INTO inventory_items (name, unit, unit_cost) VALUES ('خام-تخطيط-جست', 'KG', 10) RETURNING id");
  rawItemId = raw.rows[0].id;
  const manufactured = await pool.query(
    "INSERT INTO inventory_items (name, unit, item_type) VALUES ('منتج مصنّع-تخطيط-جست', 'KG', 'manufactured') RETURNING id"
  );
  manufacturedItemId = manufactured.rows[0].id;
  const noRecipe = await pool.query(
    "INSERT INTO inventory_items (name, unit, item_type) VALUES ('منتج بلا وصفة-تخطيط-جست', 'unit', 'manufactured') RETURNING id"
  );
  noRecipeItemId = noRecipe.rows[0].id;

  // وصفة: 4 كيلو خام تنتج 2 كيلو منتج مصنّع (كل كيلو منتج = 2 كيلو خام) - نشطة
  const recipeRes = await request(app).post("/api/recipes").set(authed(adminToken)).send({
    recipeType: "manufactured_item", inventoryItemId: manufacturedItemId, yieldQuantity: 2, yieldUnit: "KG",
    ingredients: [{ ingredientItemId: rawItemId, quantity: 4 }],
  });
  recipeVersionId = recipeRes.body.version.id;
  recipeId = recipeRes.body.recipe.id;
  await request(app).post(`/api/recipes/versions/${recipeVersionId}/submit`).set(authed(adminToken)).expect(200);
  await request(app).post(`/api/recipes/versions/${recipeVersionId}/approve`).set(authed(adminToken)).expect(200);
  await request(app).post(`/api/recipes/versions/${recipeVersionId}/activate`).set(authed(adminToken)).expect(200);

  await pool.query(
    "INSERT INTO branch_inventory_stock (branch_id, inventory_item_id, quantity) VALUES ($1,$2,0),($1,$3,0),($1,$4,0)",
    [ckBranchId, rawItemId, manufacturedItemId, noRecipeItemId]
  );
});

afterAll(async () => {
  await pool.end();
});

describe("GET /api/production-planning/plan - عزل الصلاحيات/الفروع", () => {
  test("مدير فرع عادي (مش سنتر كيتشن) ممنوع", async () => {
    const res = await request(app).get(`/api/production-planning/plan?fromDate=2026-01-01&toDate=2026-01-01`).set(authed(branchAManagerToken));
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("FORBIDDEN_BRANCH");
  });

  test("أدمن من غير ckBranchId - 400", async () => {
    const res = await request(app).get(`/api/production-planning/plan?fromDate=2026-01-01&toDate=2026-01-01`).set(authed(adminToken));
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("INVALID_PARAMETER");
  });

  test("مدير سنتر كيتشن - فرعه بيتحدد أوتوماتيك (مايقدرش يحدد فرع تاني)", async () => {
    const res = await request(app)
      .get(`/api/production-planning/plan?ckBranchId=${otherCkBranchId}&fromDate=2026-01-01&toDate=2026-01-01`)
      .set(authed(ckManagerToken));
    expect(res.status).toBe(200);
    expect(res.body.ckBranchId).toBe(ckBranchId); // اتجاهل الـckBranchId المُرسل، اتستخدم فرعه هو بس
  });

  test("fromDate/toDate بصيغة غلط - 400", async () => {
    const res = await request(app).get(`/api/production-planning/plan?fromDate=2026-13-99&toDate=2026-01-01`).set(authed(ckManagerToken));
    expect(res.status).toBe(400);
  });
});

describe("عدم الاحتساب المزدوج للمطلوب تصنيعه (Non-double-counting formula)", () => {
  const targetDate = "2026-02-10";

  test("طلب معتمد 20 كيلو من فرع واحد، مفيش مخزون ولا تصنيع تحت التنفيذ - المطلوب = 20 كامل", async () => {
    await createApprovedOrder(branchAManagerToken, branchAId, manufacturedItemId, 20, targetDate);
    const res = await request(app)
      .get(`/api/production-planning/plan?ckBranchId=${ckBranchId}&fromDate=${targetDate}&toDate=${targetDate}`)
      .set(authed(ckManagerToken));
    expect(res.status).toBe(200);
    const row = res.body.plan.find((p) => p.inventoryItemId === manufacturedItemId);
    expect(row.approvedDemand).toBe(20);
    expect(row.availableStock).toBe(0);
    expect(row.plannedOrInProgress).toBe(0);
    expect(row.requiredProduction).toBe(20);
    expect(row.demandBranches).toContain("فرع أ-تخطيط-جست");
  });

  test("لو بقى في 8 كيلو متاح فعليًا في السنتر كيتشن - المطلوب بينزل لـ12 (مش هيتحسب مرتين)", async () => {
    await pool.query(
      "UPDATE branch_inventory_stock SET quantity = 8 WHERE branch_id = $1 AND inventory_item_id = $2",
      [ckBranchId, manufacturedItemId]
    );
    const res = await request(app)
      .get(`/api/production-planning/plan?ckBranchId=${ckBranchId}&fromDate=${targetDate}&toDate=${targetDate}`)
      .set(authed(ckManagerToken));
    const row = res.body.plan.find((p) => p.inventoryItemId === manufacturedItemId);
    expect(row.availableStock).toBe(8);
    expect(row.requiredProduction).toBe(12);
  });

  test("إنشاء أمر تصنيع DRAFT بكمية 12 - المطلوب بينزل لصفر (مفيش اقتراح تصنيع مكرر لأمر أصلًا موجود)", async () => {
    const poRes = await request(app).post("/api/production").set(authed(ckManagerToken)).send({
      branchId: ckBranchId, recipeId, plannedQuantity: 12,
    });
    expect(poRes.status).toBe(201);
    const res = await request(app)
      .get(`/api/production-planning/plan?ckBranchId=${ckBranchId}&fromDate=${targetDate}&toDate=${targetDate}`)
      .set(authed(ckManagerToken));
    const row = res.body.plan.find((p) => p.inventoryItemId === manufacturedItemId);
    expect(row.plannedOrInProgress).toBe(12);
    expect(row.requiredProduction).toBe(0);
  });
});

describe("تجميع الطلب من أكتر من فرع (multi-branch aggregation)", () => {
  const targetDate = "2026-03-05";
  let branchBManagerToken2;

  beforeAll(async () => {
    branchBManagerToken2 = await login("branchB-planning@jest.test");
  });

  test("طلب من فرعين مختلفين لنفس اليوم - المطلوب = مجموع الاتنين، والفروع الاتنين ظاهرين", async () => {
    await createApprovedOrder(branchAManagerToken, branchAId, manufacturedItemId, 5, targetDate);
    await createApprovedOrder(branchBManagerToken2, branchBId, manufacturedItemId, 7, targetDate);
    const res = await request(app)
      .get(`/api/production-planning/plan?ckBranchId=${ckBranchId}&fromDate=${targetDate}&toDate=${targetDate}`)
      .set(authed(ckManagerToken));
    const row = res.body.plan.find((p) => p.inventoryItemId === manufacturedItemId);
    expect(row.approvedDemand).toBe(12);
    expect(row.demandBranches.sort()).toEqual(["فرع أ-تخطيط-جست", "فرع ب-تخطيط-جست"].sort());
  });

  test("طلب السنتر كيتشن نفسه (لو كان فيه) لا يُحتسب ضمن الطلب - branch_id <> ckBranchId في الاستعلام", async () => {
    const res = await request(app)
      .get(`/api/production-planning/demand?ckBranchId=${ckBranchId}&fromDate=${targetDate}&toDate=${targetDate}`)
      .set(authed(ckManagerToken));
    expect(res.status).toBe(200);
    expect(res.body.approved.every((r) => r.branch_id !== ckBranchId)).toBe(true);
  });
});

describe("احتياج الخامات (raw material requirement) - نفس محرك الوصفات، مفيش تفجير بديل", () => {
  test("صنف بيه وصفة نشطة - نقص الخام لو المتاح أقل من المطلوب", async () => {
    await pool.query("UPDATE branch_inventory_stock SET quantity = 3 WHERE branch_id = $1 AND inventory_item_id = $2", [ckBranchId, rawItemId]);
    const res = await request(app)
      .get(`/api/production-planning/raw-materials?ckBranchId=${ckBranchId}&inventoryItemId=${manufacturedItemId}&quantity=6&recipeVersionId=${recipeVersionId}`)
      .set(authed(ckManagerToken));
    expect(res.status).toBe(200);
    expect(res.body.hasRecipe).toBe(true);
    expect(res.body.isEstimate).toBe(false);
    const rawRow = res.body.raw.find((r) => r.inventoryItemId === rawItemId);
    // 6 كيلو منتج تحتاج 12 كيلو خام (4 خام / 2 منتج × 6) - متاح 3 بس - نقص 9
    expect(rawRow.required).toBeCloseTo(12, 5);
    expect(rawRow.available).toBe(3);
    expect(rawRow.shortage).toBeCloseTo(9, 5);
  });

  test("صنف مصنّع بلا وصفة مباشرة (بيجي من تعبئة) - isEstimate:true، مفيش احتياج خام مُختلق", async () => {
    const res = await request(app)
      .get(`/api/production-planning/raw-materials?ckBranchId=${ckBranchId}&inventoryItemId=${noRecipeItemId}&quantity=5`)
      .set(authed(ckManagerToken));
    expect(res.status).toBe(200);
    expect(res.body.hasRecipe).toBe(false);
    expect(res.body.isEstimate).toBe(true);
    expect(res.body.raw).toEqual([]);
  });
});

describe("GET /api/production-planning/forecast - نفس محرك الاقتراح الموجود، مفيش تكرار منطق", () => {
  test("الاستجابة بترجع نفس شكل generateSuggestedRequisition - نفس القيم لو نفس المدخلات", async () => {
    const { generateSuggestedRequisition } = require("../db/production-planning");
    const direct = await generateSuggestedRequisition(pool, { branchId: branchAId, targetDate: "2026-04-02", nextReplenishmentDate: null });
    const res = await request(app)
      .get(`/api/production-planning/forecast?ckBranchId=${ckBranchId}&branchId=${branchAId}&targetDate=2026-04-02`)
      .set(authed(ckManagerToken));
    expect(res.status).toBe(200);
    const directPositive = direct.filter((s) => s.suggestedQuantity > 0).length;
    expect(res.body.suggestions.length).toBe(directPositive);
  });
});
