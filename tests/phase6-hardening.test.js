// المرحلة 6: تدقيق وتقوية الجاهزية للإنتاج - يبني على تدقيق المرحلة 5 (Phase 5) كنقطة بداية معتمدة.
// هذا الملف يغطي: 6A.1 (محاسبة تحويل المخزون بين الفروع - الجزء العام مغطى في phase5-integration.test.js
// ضمن Flow E، هنا اختبار وحدة مباشر لإصلاح consumeFromBatches نفسه) و6A.2 (تزامن أوامر التصنيع)
const { app, request, pool, seedUser, login, authed } = require("./helpers");
const { consumeFromBatches } = require("../db/inventory-ledger");

describe("6A.1 (إصلاح جانبي حقيقي اتكشف أثناء بناء محاسبة التحويل): consumeFromBatches - كمية مطلوبة أكبر من رصيد الدفعات المتاحة", () => {
  let branchId, itemId;

  beforeAll(async () => {
    const b = await pool.query("INSERT INTO branches (name) VALUES ('فرع-م6-دفعات-جست') RETURNING id");
    branchId = b.rows[0].id;
    const item = await pool.query("INSERT INTO inventory_items (name, unit, unit_cost) VALUES ('صنف-م6-دفعات-جست', 'KG', 0) RETURNING id");
    itemId = item.rows[0].id;
    await pool.query("INSERT INTO branch_inventory_stock (branch_id, inventory_item_id, quantity) VALUES ($1,$2,20)", [branchId, itemId]);
    // دفعة واحدة بس فيها 8 كيلو (أقل من الـ15 كيلو المطلوبة تحت) - الباقي (7 كيلو) من رصيد غير متتبّع بدفعات
    await pool.query(
      `INSERT INTO inventory_batches (inventory_item_id, branch_id, received_date, original_quantity, remaining_quantity, unit_cost, status)
       VALUES ($1,$2,CURRENT_DATE,8,8,30,'active')`,
      [itemId, branchId]
    );
  });

  test("قبل الإصلاح: الباقي (غير المغطى بدفعة) كان بيضيع من consumed تمامًا رغم إنه محسوب في التكلفة - دلوقتي بيرجع كجزء صريح", async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await consumeFromBatches(client, { branchId, inventoryItemId: itemId, quantity: 15 });
      expect(result).toBeTruthy();
      // المجموع الكلي لكل أجزاء consumed لازم يساوي الكمية المطلوبة بالظبط - مفيش أي جزء بيضيع
      const totalConsumed = result.consumed.reduce((s, p) => s + Number(p.quantity), 0);
      expect(totalConsumed).toBe(15);
      // جزء من دفعة حقيقية (8 كيلو) + جزء تاني batchId=null يمثل الباقي غير المتتبّع (7 كيلو)
      const batchPart = result.consumed.find((p) => p.batchId !== null);
      const looseePart = result.consumed.find((p) => p.batchId === null);
      expect(Number(batchPart.quantity)).toBe(8);
      expect(Number(looseePart.quantity)).toBe(7);
      expect(Number(looseePart.unitCost)).toBe(30); // بياخد تكلفة آخر دفعة اتصرف منها كتقريب معقول
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  });
});

// ============================================================
// 6A.2: تزامن حقيقي على أوامر التصنيع - نفس نمط الباج اللي اتكشف واتصلح مرتين في المرحلة 5
// (استرجاع بيع في orders.js، إصدار/استلام تحويل في kitchen-transfers.js): القفل (FOR UPDATE) لازم
// يكون أول حاجة بعد BEGIN، قبل أي فحص حالة - وإلا طلبين متزامنين ممكن الاتنين يعدّوا فحص الحالة
// ويخصموا/يرجّعوا المخزون مرتين لنفس أمر التصنيع
// ============================================================
describe("6A.2 Concurrency: أمر تصنيع واحد - طلبات /start و/complete و/cancel متزامنة", () => {
  let branchId, flourId, doughId;
  let adminToken, managerToken;

  beforeAll(async () => {
    const b = await pool.query("INSERT INTO branches (name) VALUES ('فرع-م6-تصنيع-جست') RETURNING id");
    branchId = b.rows[0].id;
    await seedUser({ name: "أدمن-م6-تصنيع", email: "admin-p6-prod@jest.test", role: "admin" });
    await seedUser({ branchId, name: "مدير-م6-تصنيع", email: "manager-p6-prod@jest.test", role: "branch_manager" });
    adminToken = await login("admin-p6-prod@jest.test");
    managerToken = await login("manager-p6-prod@jest.test");

    const flour = await pool.query("INSERT INTO inventory_items (name, unit, unit_cost) VALUES ('دقيق-م6-تصنيع-جست', 'KG', 20) RETURNING id");
    flourId = flour.rows[0].id;
    const dough = await pool.query(
      "INSERT INTO inventory_items (name, unit, unit_cost, item_type) VALUES ('عجينة-م6-تصنيع-جست', 'KG', NULL, 'manufactured') RETURNING id"
    );
    doughId = dough.rows[0].id;
    await pool.query("INSERT INTO branch_inventory_stock (branch_id, inventory_item_id, quantity) VALUES ($1,$2,0)", [branchId, flourId]);

    const recipe = await request(app).post("/api/recipes").set(authed(adminToken)).send({
      recipeType: "manufactured_item", inventoryItemId: doughId, yieldQuantity: 10, yieldUnit: "KG",
      ingredients: [{ ingredientItemId: flourId, quantity: 10 }],
    });
    const versionId = recipe.body.version.id;
    await request(app).post(`/api/recipes/versions/${versionId}/submit`).set(authed(managerToken)).expect(200);
    await request(app).post(`/api/recipes/versions/${versionId}/approve`).set(authed(adminToken)).expect(200);
    await request(app).post(`/api/recipes/versions/${versionId}/activate`).set(authed(adminToken)).expect(200);
  });

  async function makeApprovedOrder() {
    await request(app).post("/api/inventory/purchase-receipt").set(authed(managerToken))
      .send({ branchId, inventoryItemId: flourId, quantity: 50, unitCost: 20 }).expect(201);
    const create = await request(app).post("/api/production").set(authed(managerToken))
      .send({ branchId, recipeId: (await pool.query("SELECT id FROM recipes WHERE inventory_item_id=$1", [doughId])).rows[0].id, plannedQuantity: 10 });
    const orderId = create.body.id;
    await request(app).post(`/api/production/${orderId}/approve`).set(authed(adminToken)).expect(200);
    return orderId;
  }

  test("3 طلبات /start متزامنة لنفس أمر التصنيع - نجاح واحد بس، والمكونات بتتخصم مرة واحدة بس", async () => {
    const orderId = await makeApprovedOrder();
    const flourBefore = await pool.query("SELECT quantity FROM branch_inventory_stock WHERE branch_id=$1 AND inventory_item_id=$2", [branchId, flourId]);

    const results = await Promise.all(
      Array.from({ length: 3 }, () => request(app).post(`/api/production/${orderId}/start`).set(authed(managerToken)))
    );
    const successCount = results.filter((r) => r.status === 200).length;
    expect(successCount).toBe(1);
    expect(results.filter((r) => r.status === 400).length).toBe(2);

    const flourAfter = await pool.query("SELECT quantity FROM branch_inventory_stock WHERE branch_id=$1 AND inventory_item_id=$2", [branchId, flourId]);
    // الوصفة بتاخد 10 كيلو دقيق لكل 10 كيلو عجينة، وplannedQuantity=10 - يبقى خصم 10 كيلو بالظبط، مش 20 أو 30
    expect(Number(flourBefore.rows[0].quantity) - Number(flourAfter.rows[0].quantity)).toBe(10);

    const outMovements = await pool.query(
      "SELECT COUNT(*) AS c FROM inventory_movements WHERE reference_type='production_order' AND reference_id=$1 AND movement_type='PRODUCTION_OUT'",
      [orderId]
    );
    expect(Number(outMovements.rows[0].c)).toBe(1);
  });

  test("3 طلبات /complete متزامنة لنفس أمر التصنيع - نجاح واحد بس وقيد محاسبي واحد بس", async () => {
    const orderId = await makeApprovedOrder();
    await request(app).post(`/api/production/${orderId}/start`).set(authed(managerToken)).expect(200);

    const results = await Promise.all(
      Array.from({ length: 3 }, () => request(app).post(`/api/production/${orderId}/complete`).set(authed(managerToken)).send({ actualQuantity: 10 }))
    );
    const successCount = results.filter((r) => r.status === 200).length;
    expect(successCount).toBe(1);

    const entryCount = await pool.query(
      "SELECT COUNT(*) AS c FROM journal_entries WHERE source_type='production_order' AND source_id=$1",
      [orderId]
    );
    expect(Number(entryCount.rows[0].c)).toBe(1);

    const inMovements = await pool.query(
      "SELECT COUNT(*) AS c FROM inventory_movements WHERE reference_type='production_order' AND reference_id=$1 AND movement_type='PRODUCTION_IN'",
      [orderId]
    );
    expect(Number(inMovements.rows[0].c)).toBe(1);
  });

  test("3 طلبات /cancel متزامنة على أمر IN_PROGRESS - نجاح واحد بس، والمكونات بترجع مرة واحدة بس (مش 3 مرات)", async () => {
    const orderId = await makeApprovedOrder();
    await request(app).post(`/api/production/${orderId}/start`).set(authed(managerToken)).expect(200);
    const flourAfterStart = await pool.query("SELECT quantity FROM branch_inventory_stock WHERE branch_id=$1 AND inventory_item_id=$2", [branchId, flourId]);

    const results = await Promise.all(
      Array.from({ length: 3 }, () => request(app).post(`/api/production/${orderId}/cancel`).set(authed(managerToken)).send({ reason: "اختبار تزامن" }))
    );
    const successCount = results.filter((r) => r.status === 200).length;
    expect(successCount).toBe(1);
    expect(results.filter((r) => r.status === 400).length).toBe(2);

    const flourAfterCancel = await pool.query("SELECT quantity FROM branch_inventory_stock WHERE branch_id=$1 AND inventory_item_id=$2", [branchId, flourId]);
    // المكونات المخصومة وقت /start (10 كيلو) لازم ترجع مرة واحدة بس - مش 3 مرات (30 كيلو)
    expect(Number(flourAfterCancel.rows[0].quantity) - Number(flourAfterStart.rows[0].quantity)).toBe(10);

    const reversalMovements = await pool.query(
      "SELECT COUNT(*) AS c FROM inventory_movements WHERE reference_type='production_order' AND reference_id=$1 AND movement_type='PRODUCTION_REVERSAL'",
      [orderId]
    );
    expect(Number(reversalMovements.rows[0].c)).toBe(1);
  });
});

afterAll(async () => {
  await pool.end();
});
