// Procurement v2 STEP H: تحسينات دفعات التصنيع - ترقيم نظامي إلزامي، علاقة أب/ابن (أمر تصنيع + دفعة)
// للتتبّع متعدد المراحل، وفرق مخطط/فعلي حقيقي على مستوى مدخلات كل أمر تصنيع.
const { app, request, pool, seedUser, login, authed } = require("./helpers");

let branchId;
let adminToken, managerToken;
let flourId, doughId, breadId, plainItemId;

async function createActiveRecipe({ inventoryItemId, yieldQuantity, ingredients }) {
  const created = await request(app).post("/api/recipes").set(authed(adminToken)).send({
    recipeType: "manufactured_item", inventoryItemId, yieldQuantity, yieldUnit: "unit", ingredients,
  });
  const versionId = created.body.version.id;
  await request(app).post(`/api/recipes/versions/${versionId}/submit`).set(authed(managerToken)).expect(200);
  await request(app).post(`/api/recipes/versions/${versionId}/approve`).set(authed(adminToken)).expect(200);
  await request(app).post(`/api/recipes/versions/${versionId}/activate`).set(authed(adminToken)).expect(200);
  return versionId;
}

async function createApprovedOrder(recipeId, plannedQuantity, extra = {}) {
  const created = await request(app).post("/api/production").set(authed(managerToken)).send({
    branchId, recipeId, plannedQuantity, ...extra,
  });
  expect(created.status).toBe(201);
  await request(app).post(`/api/production/${created.body.id}/approve`).set(authed(adminToken)).expect(200);
  return created.body.id;
}

beforeAll(async () => {
  const b1 = await pool.query("INSERT INTO branches (name) VALUES ('فرع دفعات-جست') RETURNING id");
  branchId = b1.rows[0].id;
  await seedUser({ name: "أدمن-دفعات", email: "admin-batchimp@jest.test", role: "admin" });
  await seedUser({ branchId, name: "مدير فرع-دفعات", email: "manager-batchimp@jest.test", role: "branch_manager" });
  adminToken = await login("admin-batchimp@jest.test");
  managerToken = await login("manager-batchimp@jest.test");

  const flour = await pool.query("INSERT INTO inventory_items (name, unit, unit_cost) VALUES ('دقيق-دفعات-جست', 'KG', 10) RETURNING id");
  flourId = flour.rows[0].id;
  const dough = await pool.query(
    "INSERT INTO inventory_items (name, unit, unit_cost, item_type, batch_prefix) VALUES ('عجينة-دفعات-جست', 'KG', NULL, 'manufactured', 'DGH') RETURNING id"
  );
  doughId = dough.rows[0].id;
  const bread = await pool.query(
    "INSERT INTO inventory_items (name, unit, unit_cost, item_type) VALUES ('خبز-دفعات-جست', 'unit', NULL, 'manufactured') RETURNING id"
  );
  breadId = bread.rows[0].id;
  const plain = await pool.query(
    "INSERT INTO inventory_items (name, unit, unit_cost, item_type) VALUES ('صنف بسيط-دفعات-جست', 'unit', NULL, 'manufactured') RETURNING id"
  );
  plainItemId = plain.rows[0].id;

  await pool.query(
    "INSERT INTO branch_inventory_stock (branch_id, inventory_item_id, quantity) VALUES ($1,$2,1000),($1,$3,0),($1,$4,0),($1,$5,0)",
    [branchId, flourId, doughId, breadId, plainItemId]
  );
});

afterAll(async () => {
  await pool.end();
});

describe("ترقيم دفعات التصنيع النظامي الإلزامي", () => {
  test("بادئة الصنف المحددة (batch_prefix='DGH') بتتستخدم لو الأوبريتور معملش batch_number", async () => {
    const doughRecipeId = (await pool.query("SELECT id FROM recipes WHERE inventory_item_id = $1", [doughId])).rows[0]?.id
      || (await createActiveRecipeForDough());
    const orderId = await createApprovedOrder(doughRecipeId, 10, { expiryDate: "2027-01-01" });
    await request(app).post(`/api/production/${orderId}/start`).set(authed(managerToken)).expect(200);
    const complete = await request(app).post(`/api/production/${orderId}/complete`).set(authed(managerToken)).send({ actualQuantity: 10 });
    expect(complete.status).toBe(200);
    expect(complete.body.generatedBatchNumber).toMatch(/^DGH-\d{8}-\d{3}$/);
    global.__doughOrder1Id = orderId;
    global.__doughBatch1Id = complete.body.batchId;
  });

  async function createActiveRecipeForDough() {
    const versionId = await createActiveRecipe({ inventoryItemId: doughId, yieldQuantity: 10, ingredients: [{ ingredientItemId: flourId, quantity: 10 }] });
    const recipeRow = await pool.query("SELECT recipe_id FROM recipe_versions WHERE id = $1", [versionId]);
    return recipeRow.rows[0].recipe_id;
  }

  test("بادئة عامة افتراضية MFG لصنف من غير batch_prefix + التسلسل بيزيد كل يوم لنفس البادئة", async () => {
    const plainRecipeId = (await createActiveRecipe({ inventoryItemId: plainItemId, yieldQuantity: 1, ingredients: [{ ingredientItemId: flourId, quantity: 1 }] }));
    const plainRecipeRow = await pool.query("SELECT recipe_id FROM recipe_versions WHERE id = $1", [plainRecipeId]);
    const recipeId = plainRecipeRow.rows[0].recipe_id;

    const order1 = await createApprovedOrder(recipeId, 1, { expiryDate: "2027-01-01" });
    await request(app).post(`/api/production/${order1}/start`).set(authed(managerToken)).expect(200);
    const c1 = await request(app).post(`/api/production/${order1}/complete`).set(authed(managerToken)).send({ actualQuantity: 1 });
    expect(c1.body.generatedBatchNumber).toMatch(/^MFG-\d{8}-\d{3}$/);

    const order2 = await createApprovedOrder(recipeId, 1, { expiryDate: "2027-01-01" });
    await request(app).post(`/api/production/${order2}/start`).set(authed(managerToken)).expect(200);
    const c2 = await request(app).post(`/api/production/${order2}/complete`).set(authed(managerToken)).send({ actualQuantity: 1 });
    const seq1 = Number(c1.body.generatedBatchNumber.split("-")[2]);
    const seq2 = Number(c2.body.generatedBatchNumber.split("-")[2]);
    expect(seq2).toBe(seq1 + 1);
  });

  test("رقم دفعة يدوي محدد صراحة - بيتاخد زي ما هو، مفيش توليد تلقائي يستبدله", async () => {
    const plainRecipeRow = await pool.query(
      "SELECT r.id FROM recipes r WHERE r.inventory_item_id = $1", [plainItemId]
    );
    const recipeId = plainRecipeRow.rows[0].id;
    const orderId = await createApprovedOrder(recipeId, 1, { batchNumber: "MANUAL-BATCH-001" });
    await request(app).post(`/api/production/${orderId}/start`).set(authed(managerToken)).expect(200);
    const complete = await request(app).post(`/api/production/${orderId}/complete`).set(authed(managerToken)).send({ actualQuantity: 1 });
    expect(complete.body.generatedBatchNumber).toBe("MANUAL-BATCH-001");
  });
});

// ملحوظة معمارية مهمة: explodeRecipeConsumption (محرك الوصفات، المرحلة 3) بيفجّر أي مكوّن "مصنّع" ليه
// وصفة نشطة لمكوناته الخام بالكامل بشكل نظري دايمًا - مفيش نقطة توقف عند مخزون المكوّن الوسيط نفسه لو
// كانت له وصفة نشطة (ده سلوك متعمّد وموجود من المرحلة 3 للتكلفة النظرية، مش حاجة STEP H بتغيّرها).
// يعني: تسلسل تصنيع مرحلتين حقيقي (استهلاك فعلي لدفعة مرحلة أولى كمكوّن مباشر في تصنيع مرحلة تانية)
// بيحصل بس لما المكوّن الوسيط **مالوش وصفة نشطة وقت التصنيع** (بيتعامل كخام قابل للاستهلاك من دفعاته
// مباشرة - نفس مسار "مكوّن مصنّع من غير وصفة" الموجود بالفعل في recipe-engine.js). الاختبار هنا بيبني
// "أمر تصنيع أب" ودفعته مباشرة عن طريق SQL (تمثيلًا لمرحلة أولى سابقة) عشان يعزل اختبار منطق الربط
// (parent_production_order_id / parent_batch_id) نفسه في STEP H، من غير ما يتعارض مع سلوك التفجير النظري
describe("تتبّع متعدد المراحل: علاقة أب/ابن بين أمري التصنيع وبين الدفعتين", () => {
  test("مكوّن وسيط بلا وصفة نشطة، مستهلك من دفعة أمر تصنيع سابق - parent_production_order_id و parent_batch_id بيتحددوا صح", async () => {
    const semi = await pool.query(
      "INSERT INTO inventory_items (name, unit, unit_cost, item_type) VALUES ('وسيط بلا وصفة-دفعات-جست', 'KG', NULL, 'manufactured') RETURNING id"
    );
    const semiId = semi.rows[0].id;
    await pool.query("INSERT INTO branch_inventory_stock (branch_id, inventory_item_id, quantity) VALUES ($1,$2,20)", [branchId, semiId]);

    const anyVersion = await pool.query("SELECT id, recipe_id FROM recipe_versions LIMIT 1");
    const parentOrder = await pool.query(
      `INSERT INTO production_orders (branch_id, recipe_id, recipe_version_id, status, planned_quantity, actual_quantity, operator_id)
       VALUES ($1,$2,$3,'COMPLETED',20,20,$4) RETURNING id`,
      [branchId, anyVersion.rows[0].recipe_id, anyVersion.rows[0].id, (await pool.query("SELECT id FROM users WHERE email = 'manager-batchimp@jest.test'")).rows[0].id]
    );
    const parentOrderId = parentOrder.rows[0].id;
    const parentBatch = await pool.query(
      `INSERT INTO inventory_batches (batch_number, inventory_item_id, branch_id, received_date, original_quantity, remaining_quantity, unit_cost, status)
       VALUES ('PARENT-BATCH-TEST', $1, $2, CURRENT_DATE, 20, 20, 15, 'active') RETURNING id`,
      [semiId, branchId]
    );
    const parentBatchId = parentBatch.rows[0].id;
    await pool.query(
      `INSERT INTO production_order_batches (production_order_id, role, inventory_item_id, batch_id, quantity) VALUES ($1,'output',$2,$3,20)`,
      [parentOrderId, semiId, parentBatchId]
    );

    const breadVersionId = await createActiveRecipe({ inventoryItemId: breadId, yieldQuantity: 5, ingredients: [{ ingredientItemId: semiId, quantity: 5 }] });
    const breadRecipeRow = await pool.query("SELECT recipe_id FROM recipe_versions WHERE id = $1", [breadVersionId]);
    const breadRecipeId = breadRecipeRow.rows[0].recipe_id;

    const orderId = await createApprovedOrder(breadRecipeId, 5, { expiryDate: "2027-01-01" });
    const start = await request(app).post(`/api/production/${orderId}/start`).set(authed(managerToken));
    expect(start.status).toBe(200);
    expect(start.body.parent_production_order_id).toBe(parentOrderId);

    const complete = await request(app).post(`/api/production/${orderId}/complete`).set(authed(managerToken)).send({ actualQuantity: 5 });
    expect(complete.status).toBe(200);
    expect(complete.body.parentBatchId).toBe(parentBatchId);

    const batchRow = await pool.query("SELECT parent_batch_id FROM inventory_batches WHERE id = $1", [complete.body.batchId]);
    expect(batchRow.rows[0].parent_batch_id).toBe(parentBatchId);
  });
});

describe("فرق مخطط/فعلي حقيقي على مدخلات التصنيع (actualConsumption)", () => {
  let simpleRecipeId;

  test("استخدام وصفة الصنف البسيط النشطة بالفعل من قبل (دقيق فقط، 2 كيلو لكل وحدة)", async () => {
    // plainItemId له وصفة نشطة بالفعل من describe السابق ("بادئة عامة افتراضية") - نفس الوصفة (2 دقيق
    // لكل وحدة مش صحيح، الوصفة الأصلية كانت 1 دقيق لكل وحدة) - بنستخدمها زي ما هي، مش بننشئ وصفة تانية
    // (UNIQUE inventory_item_id مينفعش يبقى فيه أكتر من وصفة نشطة لنفس الصنف المصنّع)
    const recipeRow = await pool.query("SELECT id FROM recipes WHERE inventory_item_id = $1", [plainItemId]);
    simpleRecipeId = recipeRow.rows[0].id;
  });

  test("من غير actualConsumption - الفعلي = النظري، فرق صفر (نفس السلوك القديم بالظبط)", async () => {
    const orderId = await createApprovedOrder(simpleRecipeId, 1);
    await request(app).post(`/api/production/${orderId}/start`).set(authed(managerToken)).expect(200);
    const rows = await pool.query(
      "SELECT quantity, planned_quantity, variance_quantity FROM production_order_batches WHERE production_order_id = $1 AND role = 'input'",
      [orderId]
    );
    expect(rows.rows.length).toBe(1);
    expect(Number(rows.rows[0].quantity)).toBeCloseTo(1, 5);
    expect(Number(rows.rows[0].quantity)).toBeCloseTo(Number(rows.rows[0].planned_quantity), 5);
    expect(Number(rows.rows[0].variance_quantity)).toBeCloseTo(0, 5);
  });

  test("actualConsumption بكمية أكبر من النظري (تسرّب/زيادة استهلاك) - بيتسجل الفرق صراحة", async () => {
    const orderId = await createApprovedOrder(simpleRecipeId, 1);
    const res = await request(app).post(`/api/production/${orderId}/start`).set(authed(managerToken)).send({
      actualConsumption: [{ inventoryItemId: flourId, actualQuantity: 3, varianceReason: "تسرّب أثناء العجن" }],
    });
    expect(res.status).toBe(200);
    const rows = await pool.query(
      "SELECT quantity, planned_quantity, variance_quantity, variance_reason FROM production_order_batches WHERE production_order_id = $1 AND role = 'input'",
      [orderId]
    );
    expect(Number(rows.rows[0].quantity)).toBeCloseTo(3, 5);
    expect(Number(rows.rows[0].planned_quantity)).toBeCloseTo(1, 5);
    expect(Number(rows.rows[0].variance_quantity)).toBeCloseTo(2, 5);
    expect(rows.rows[0].variance_reason).toBe("تسرّب أثناء العجن");

    const movement = await pool.query(
      "SELECT quantity FROM inventory_movements WHERE reference_type = 'production_order' AND reference_id = $1 AND movement_type = 'PRODUCTION_OUT'",
      [orderId]
    );
    expect(Number(movement.rows[0].quantity)).toBeCloseTo(-3, 5); // الفعلي هو اللي اتخصم من المخزون، مش النظري
  });

  test("actualConsumption بقيمة سالبة - مرفوض", async () => {
    const orderId = await createApprovedOrder(simpleRecipeId, 1);
    const res = await request(app).post(`/api/production/${orderId}/start`).set(authed(managerToken)).send({
      actualConsumption: [{ inventoryItemId: flourId, actualQuantity: -1 }],
    });
    expect(res.status).toBe(400);
  });
});
