// المرحلة 6: تدقيق وتقوية الجاهزية للإنتاج - يبني على تدقيق المرحلة 5 (Phase 5) كنقطة بداية معتمدة.
// هذا الملف يغطي: 6A.1 (محاسبة تحويل المخزون بين الفروع - الجزء العام مغطى في phase5-integration.test.js
// ضمن Flow E، هنا اختبار وحدة مباشر لإصلاح consumeFromBatches نفسه) و6A.2 (تزامن أوامر التصنيع)
// و6A.3 (تزامن الجرد + تسريب transaction مفتوحة في تصحيح فروق المخزون)
const { app, request, pool, seedUser, login, authed } = require("./helpers");
const { consumeFromBatches } = require("../db/inventory-ledger");
const { Client } = require("pg");

// لازم اتصال مستقل تمامًا عن الـpool المشترك (مش pool.query) عشان فحص "transaction مفتوحة متسرّبة" -
// لو استخدمنا نفس الـpool، ممكن نفس الاتصال المسموم يترجع من تاني ويُستخدم في تنفيذ فحص pg_stat_activity
// نفسه، فبيظهر حالته "active" (بينفذ الفحص) مش "idle in transaction" ويخفي الباج بدل ما يكتشفه -
// اتأكدنا من الفرق ده فعليًا وقت بناء الاختبار (نفس الفحص عن طريق pool.query كان بيرجّع نتيجة فاضية
// حتى مع الباج موجود فعليًا، وبيرجّع الصف الصحيح لما استخدمنا اتصال منفصل)
async function countIdleInTransaction() {
  const diag = new Client({ connectionString: process.env.DATABASE_URL });
  await diag.connect();
  try {
    const res = await diag.query(
      "SELECT COUNT(*) AS c FROM pg_stat_activity WHERE state = 'idle in transaction' AND datname = current_database()"
    );
    return Number(res.rows[0].c);
  } finally {
    await diag.end();
  }
}

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

// ============================================================
// 6A.3: تزامن حقيقي على /reconcile - نفس نمط باج التزامن اللي اتصلح قبل كده، بس هنا مانفستيشن مختلف:
// الفرق (variance) كان بيتحسب من قراءة غير مقفولة للرصيد الحالي، فطلبين جرد متزامنين ممكن الاتنين
// يحسبوا نفس الفرق مقابل نفس القيمة القديمة ويطبّقوه مرتين
// ============================================================
describe("6A.3 Concurrency: طلبين /reconcile متزامنين لنفس الصنف/الفرع بنفس القيمة الفعلية المستهدفة", () => {
  let branchId, itemId;
  let managerToken;

  beforeAll(async () => {
    const b = await pool.query("INSERT INTO branches (name) VALUES ('فرع-م6-جرد-جست') RETURNING id");
    branchId = b.rows[0].id;
    await seedUser({ branchId, name: "مدير-م6-جرد", email: "manager-p6-reconcile@jest.test", role: "branch_manager" });
    managerToken = await login("manager-p6-reconcile@jest.test");

    const item = await pool.query("INSERT INTO inventory_items (name, unit, unit_cost) VALUES ('صنف-م6-جرد-جست', 'KG', 10) RETURNING id");
    itemId = item.rows[0].id;
    await pool.query("INSERT INTO branch_inventory_stock (branch_id, inventory_item_id, quantity) VALUES ($1,$2,50)", [branchId, itemId]);
  });

  test("طلبين جرد متزامنين لنفس الصنف يستهدفوا نفس الرصيد الفعلي (100) - الرصيد النهائي 100 بالظبط مش 150", async () => {
    const results = await Promise.all(
      Array.from({ length: 2 }, () => request(app).post("/api/inventory/reconcile").set(authed(managerToken))
        .send({ branchId, inventoryItemId: itemId, actualQuantity: 100, notes: "جرد تزامن" }))
    );
    expect(results.every((r) => r.status === 201)).toBe(true);

    const final = await pool.query("SELECT quantity FROM branch_inventory_stock WHERE branch_id=$1 AND inventory_item_id=$2", [branchId, itemId]);
    // قبل الإصلاح: الاتنين كانوا هيقروا previousQuantity=50 (غير مقفول)، يحسبوا variance=+50 لكل
    // واحد، ويطبّقوه مرتين → 150. بعد الإصلاح: التاني بيستنى القفل، يقرا الرصيد بعد أثر الأول (100)،
    // يحسب variance=0، فمفيش تأثير مضاعف
    expect(Number(final.rows[0].quantity)).toBe(100);

    const movements = await pool.query(
      "SELECT COUNT(*) AS c FROM inventory_movements WHERE branch_id=$1 AND inventory_item_id=$2 AND movement_type='STOCK_COUNT'",
      [branchId, itemId]
    );
    expect(Number(movements.rows[0].c)).toBe(1); // الفرق الحقيقي واحد بس - الطلب التاني ملقاش فرق يسجله
  });
});

// ============================================================
// 6A.3: تصحيح فرق مخزون (discrepancy resolve) كان بيرجع 400/404 من غير ROLLBACK بعد BEGIN+FOR UPDATE -
// بيسيب transaction مفتوحة على الاتصال لما يترجّع للـpool (client.release() من غير commit/rollback)
// ============================================================
describe("6A.3 Transaction Leak Fix: تصحيح فرق متحل بالفعل - المرفوض (400) لازم يقفل الـtransaction صح", () => {
  let branchId, itemId, adminToken, discId;

  beforeAll(async () => {
    const b = await pool.query("INSERT INTO branches (name) VALUES ('فرع-م6-فروقات-جست') RETURNING id");
    branchId = b.rows[0].id;
    await seedUser({ name: "أدمن-م6-فروقات", email: "admin-p6-discrepancy@jest.test", role: "admin" });
    adminToken = await login("admin-p6-discrepancy@jest.test");

    const item = await pool.query("INSERT INTO inventory_items (name, unit, unit_cost) VALUES ('صنف-م6-فروقات-جست', 'KG', 10) RETURNING id");
    itemId = item.rows[0].id;
    const disc = await pool.query(
      `INSERT INTO inventory_discrepancies (branch_id, inventory_item_id, ledger_sum, stock_balance, difference)
       VALUES ($1,$2,40,45,5) RETURNING id`,
      [branchId, itemId]
    );
    discId = disc.rows[0].id;
  });

  test("أول تصحيح ينجح، والتاني على نفس الفرق يترفض (400) من غير ما يسيب transaction معلّقة idle-in-transaction", async () => {
    const first = await request(app).patch(`/api/inventory/discrepancies/${discId}/resolve`).set(authed(adminToken))
      .send({ resolutionNotes: "تصحيح أول" });
    expect(first.status).toBe(200);

    const second = await request(app).patch(`/api/inventory/discrepancies/${discId}/resolve`).set(authed(adminToken))
      .send({ resolutionNotes: "محاولة تانية" });
    expect(second.status).toBe(400); // اتحل بالفعل - المفروض يترفض صريح

    // لو الـROLLBACK ناقص، الاتصال بيترجّع للـpool وهو لسه فاتح transaction ماسكة قفل الصف - أي طلب
    // تاني ياخد نفس الاتصال هيلاقي نفسه جوه transaction قديمة معلّقة. نتأكد صراحة إن مفيش أي اتصال
    // فاضل idle-in-transaction بعد الطلبين دول
    expect(await countIdleInTransaction()).toBe(0);
  });

  test("تصحيح فرق مش موجود (404) برضه لازم يقفل الـtransaction صح", async () => {
    const res = await request(app).patch(`/api/inventory/discrepancies/999999999/resolve`).set(authed(adminToken))
      .send({ resolutionNotes: "غير موجود" });
    expect(res.status).toBe(404);
    expect(await countIdleInTransaction()).toBe(0);
  });
});

// ============================================================
// 6A.4: تدقيق تزامن شامل عبر الباك اند - لقينا باجين إضافيين حقيقيين بنفس النمط أثناء المراجعة:
// (أ) إلغاء سند استلام (GRN) POSTED كان بيقرا الحالة قبل BEGIN/قفل، فطلبين إلغاء متزامنين كانوا هيرجّعوا
//     المخزون للمورد مرتين (RETURN_TO_SUPPLIER مرتين)
// (ب) PATCH /api/orders/:id/status لما status='cancelled' كان بيخصم نقاط ولاء العميل من غير أي transaction
//     أو قفل خالص - طلبين إلغاء متزامنين كانوا هيخصموا نفس النقاط مرتين من رصيد العميل
// ============================================================
describe("6A.4 Concurrency: إلغاء سند استلام (GRN) POSTED - إلغاء واحد بس يرجّع المخزون للمورد", () => {
  let branchId, itemId, supplierId, adminToken, managerToken, grnId, poId;

  beforeAll(async () => {
    const b = await pool.query("INSERT INTO branches (name) VALUES ('فرع-م6-استلام-جست') RETURNING id");
    branchId = b.rows[0].id;
    await seedUser({ name: "أدمن-م6-استلام", email: "admin-p6-grn@jest.test", role: "admin" });
    await seedUser({ branchId, name: "مدير-م6-استلام", email: "manager-p6-grn@jest.test", role: "branch_manager" });
    adminToken = await login("admin-p6-grn@jest.test");
    managerToken = await login("manager-p6-grn@jest.test");

    // negative_stock_policy = ALLOW_WITH_APPROVAL عمدًا: لو الصنف STRICT (الافتراضي)، محاولة إلغاء
    // تانية متزامنة كانت هترفض تلقائيًا بـINSUFFICIENT_STOCK بغض النظر عن إصلاح القفل هنا - ده كان
    // بيخفي الباج الحقيقي بدل ما يثبته. ALLOW_WITH_APPROVAL هو اللي بيكشف السباق الفعلي، وهو سياسة
    // حقيقية مستخدمة فعليًا (مش سيناريو مصطنع) - وdefault handler هنا أصلًا بيمرّر
    // negativeStockOverrideApproved: true بشكل غير مشروط
    const item = await pool.query(
      "INSERT INTO inventory_items (name, unit, unit_cost, negative_stock_policy) VALUES ('صنف-م6-استلام-جست', 'KG', 0, 'ALLOW_WITH_APPROVAL') RETURNING id"
    );
    itemId = item.rows[0].id;
    await pool.query("INSERT INTO branch_inventory_stock (branch_id, inventory_item_id, quantity) VALUES ($1,$2,0)", [branchId, itemId]);
    const supplier = await pool.query("INSERT INTO suppliers (name, status) VALUES ('مورد-م6-استلام-جست', 'ACTIVE') RETURNING id");
    supplierId = supplier.rows[0].id;

    const po = await request(app).post("/api/purchase-orders").set(authed(managerToken)).send({
      supplierId, branchId, items: [{ inventoryItemId: itemId, orderedQuantity: 50, unitPrice: 20 }],
    });
    poId = po.body.id;
    await request(app).post(`/api/purchase-orders/${poId}/submit`).set(authed(managerToken)).expect(200);
    await request(app).post(`/api/purchase-orders/${poId}/approve`).set(authed(adminToken)).expect(200);
    const detail = await request(app).get(`/api/purchase-orders/${poId}`).set(authed(adminToken));
    const poItemId = detail.body.items[0].id;

    const grn = await request(app).post("/api/goods-receipts").set(authed(managerToken)).send({
      purchaseOrderId: poId, supplierDocumentNumber: "P6-GRN-1",
      items: [{ purchaseOrderItemId: poItemId, receivedQuantity: 50, acceptedQuantity: 50, rejectedQuantity: 0 }],
    });
    grnId = grn.body.id;
    await request(app).post(`/api/goods-receipts/${grnId}/post`).set(authed(managerToken)).expect(200);
  });

  test("3 طلبات إلغاء متزامنة لنفس سند الاستلام الـPOSTED - نجاح واحد بس، ورصيد المخزون بيرجع لصفر مش سالب", async () => {
    const stockAfterPost = await pool.query("SELECT quantity FROM branch_inventory_stock WHERE branch_id=$1 AND inventory_item_id=$2", [branchId, itemId]);
    expect(Number(stockAfterPost.rows[0].quantity)).toBe(50);

    const results = await Promise.all(
      Array.from({ length: 3 }, () => request(app).post(`/api/goods-receipts/${grnId}/cancel`).set(authed(adminToken)).send({ reason: "اختبار تزامن" }))
    );
    const successCount = results.filter((r) => r.status === 200).length;
    expect(successCount).toBe(1);

    const stockAfterCancel = await pool.query("SELECT quantity FROM branch_inventory_stock WHERE branch_id=$1 AND inventory_item_id=$2", [branchId, itemId]);
    expect(Number(stockAfterCancel.rows[0].quantity)).toBe(0); // رجعت مرة واحدة بس - مش -50

    const returnMovements = await pool.query(
      "SELECT COUNT(*) AS c FROM inventory_movements WHERE reference_type='goods_receipt' AND reference_id=$1 AND movement_type='RETURN_TO_SUPPLIER'",
      [grnId]
    );
    expect(Number(returnMovements.rows[0].c)).toBe(1);
  });
});

describe("6A.4 Concurrency: إلغاء طلب دليفري (PATCH /:id/status → cancelled) - خصم نقاط الولاء مرة واحدة بس", () => {
  let branchId, adminToken, orderId;
  const customerPhone = "01099998888";

  beforeAll(async () => {
    const b = await pool.query("INSERT INTO branches (name) VALUES ('فرع-م6-ولاء-جست') RETURNING id");
    branchId = b.rows[0].id;
    await seedUser({ name: "أدمن-م6-ولاء", email: "admin-p6-loyalty@jest.test", role: "admin" });
    adminToken = await login("admin-p6-loyalty@jest.test");

    await pool.query(
      `INSERT INTO customers (phone, name, loyalty_points) VALUES ($1, 'عميل-م6-ولاء-جست', 100)`,
      [customerPhone]
    );
    const order = await pool.query(
      `INSERT INTO orders (branch_id, source, order_type, customer_phone, total, status, loyalty_points_earned)
       VALUES ($1, 'pos', 'delivery', $2, 200, 'preparing', 30) RETURNING id`,
      [branchId, customerPhone]
    );
    orderId = order.rows[0].id;
  });

  test("3 طلبات إلغاء متزامنة لنفس الطلب - نجاح واحد بس، ونقاط الولاء بتتخصم مرة واحدة بس (30 مش 90)", async () => {
    const results = await Promise.all(
      Array.from({ length: 3 }, () => request(app).patch(`/api/orders/${orderId}/status`).set(authed(adminToken)).send({ status: "cancelled" }))
    );
    const successCount = results.filter((r) => r.status === 200).length;
    expect(successCount).toBe(1);
    expect(results.filter((r) => r.status === 400).length).toBe(2);

    const customer = await pool.query("SELECT loyalty_points FROM customers WHERE phone = $1", [customerPhone]);
    expect(Number(customer.rows[0].loyalty_points)).toBe(70); // 100 - 30 مرة واحدة بس، مش 100 - 90
  });
});

afterAll(async () => {
  await pool.end();
});
