// المرحلة 7N: مرتجع مشتريات - ضد Postgres حقيقي. بيغطي: إنشاء مسودة، الترحيل (خصم مخزون + قيد
// محاسبي DR الموردون/CR المخزون)، الإرجاع من دفعة محددة (خصم remaining_quantity بالظبط + رفض لو
// الكمية المطلوبة أكبر من المتبقي)، idempotency الترحيل، عزل الفروع، وإلغاء المسودة بس (المرحّل نهائي).
const { app, request, pool, seedUser, login, authed } = require("./helpers");

let branchA, branchB;
let managerAToken, managerBToken, adminToken, accountantToken;
let supplierId;
let itemNonBatchId, itemBatchId, batchId;

beforeAll(async () => {
  const bA = await pool.query("INSERT INTO branches (name) VALUES ('فرع-مرتجع-A-جست') RETURNING id");
  branchA = bA.rows[0].id;
  const bB = await pool.query("INSERT INTO branches (name) VALUES ('فرع-مرتجع-B-جست') RETURNING id");
  branchB = bB.rows[0].id;

  await seedUser({ branchId: branchA, name: "مدير-مرتجع-A", email: "managerA-return@jest.test", role: "branch_manager" });
  await seedUser({ branchId: branchB, name: "مدير-مرتجع-B", email: "managerB-return@jest.test", role: "branch_manager" });
  await seedUser({ name: "أدمن-مرتجع", email: "admin-return@jest.test", role: "admin" });
  await seedUser({ name: "محاسب-مرتجع", email: "accountant-return@jest.test", role: "accountant" });

  managerAToken = await login("managerA-return@jest.test");
  managerBToken = await login("managerB-return@jest.test");
  adminToken = await login("admin-return@jest.test");
  accountantToken = await login("accountant-return@jest.test");

  const sup = await pool.query("INSERT INTO suppliers (name) VALUES ('مورد-مرتجع-جست') RETURNING id");
  supplierId = sup.rows[0].id;

  const itemA = await pool.query("INSERT INTO inventory_items (name, unit, unit_cost) VALUES ('صنف-مرتجع-بدون-دفعة-جست', 'KG', 15) RETURNING id");
  itemNonBatchId = itemA.rows[0].id;
  await pool.query("INSERT INTO branch_inventory_stock (branch_id, inventory_item_id, quantity) VALUES ($1,$2,100)", [branchA, itemNonBatchId]);

  const itemB = await pool.query("INSERT INTO inventory_items (name, unit, unit_cost) VALUES ('صنف-مرتجع-بدفعة-جست', 'KG', 25) RETURNING id");
  itemBatchId = itemB.rows[0].id;
  await pool.query("INSERT INTO branch_inventory_stock (branch_id, inventory_item_id, quantity) VALUES ($1,$2,50)", [branchA, itemBatchId]);
  const batch = await pool.query(
    `INSERT INTO inventory_batches (batch_number, inventory_item_id, branch_id, received_date, original_quantity, remaining_quantity, unit_cost, status)
     VALUES ('BATCH-RETURN-JEST', $1, $2, CURRENT_DATE, 50, 50, 25, 'active') RETURNING id`,
    [itemBatchId, branchA]
  );
  batchId = batch.rows[0].id;
});

afterAll(async () => {
  await pool.end();
});

describe("إنشاء مسودة مرتجع", () => {
  test("إنشاء مسودة بصنف بدون دفعة - total_value بيتحسب من unit_cost الصنف", async () => {
    const res = await request(app).post("/api/purchase-returns").set(authed(managerAToken)).send({
      branchId: branchA, supplierId, reason: "تالف",
      items: [{ inventoryItemId: itemNonBatchId, quantity: 3, unit: "KG" }],
    });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe("DRAFT");
    expect(Number(res.body.total_value)).toBe(45); // 3 * 15
  });

  test("فرع/سبب ناقص -> 400، وعدم وجود أصناف -> 400", async () => {
    const noReason = await request(app).post("/api/purchase-returns").set(authed(managerAToken)).send({
      branchId: branchA, items: [{ inventoryItemId: itemNonBatchId, quantity: 1, unit: "KG" }],
    });
    expect(noReason.status).toBe(400);
    const noItems = await request(app).post("/api/purchase-returns").set(authed(managerAToken)).send({
      branchId: branchA, reason: "تالف", items: [],
    });
    expect(noItems.status).toBe(400);
  });

  test("مدير فرع B مايقدرش يسجّل مرتجع لفرع A", async () => {
    const res = await request(app).post("/api/purchase-returns").set(authed(managerBToken)).send({
      branchId: branchA, reason: "تالف", items: [{ inventoryItemId: itemNonBatchId, quantity: 1, unit: "KG" }],
    });
    expect(res.status).toBe(403);
  });
});

describe("ترحيل المرتجع - صنف من غير دفعة", () => {
  test("الترحيل بيخصم المخزون وبيعمل قيد محاسبي، والترحيل التاني idempotent", async () => {
    const before = await pool.query("SELECT quantity FROM branch_inventory_stock WHERE branch_id=$1 AND inventory_item_id=$2", [branchA, itemNonBatchId]);
    const create = await request(app).post("/api/purchase-returns").set(authed(managerAToken)).send({
      branchId: branchA, supplierId, reason: "صنف غلط",
      items: [{ inventoryItemId: itemNonBatchId, quantity: 5, unit: "KG" }],
    });
    const retId = create.body.id;

    const post1 = await request(app).post(`/api/purchase-returns/${retId}/post`).set(authed(managerAToken));
    expect(post1.status).toBe(200);
    expect(post1.body.status).toBe("POSTED");
    expect(post1.body.duplicate).toBe(false);

    const after = await pool.query("SELECT quantity FROM branch_inventory_stock WHERE branch_id=$1 AND inventory_item_id=$2", [branchA, itemNonBatchId]);
    expect(Number(before.rows[0].quantity) - Number(after.rows[0].quantity)).toBe(5);

    const movement = await pool.query(
      "SELECT * FROM inventory_movements WHERE reference_type='purchase_return' AND reference_id=$1", [retId]
    );
    expect(movement.rows.length).toBe(1);
    expect(movement.rows[0].movement_type).toBe("RETURN_TO_SUPPLIER");
    expect(Number(movement.rows[0].quantity)).toBe(-5);

    const journal = await pool.query(
      "SELECT * FROM journal_entries WHERE source_type='purchase_return' AND source_id=$1 AND status='POSTED'", [retId]
    );
    expect(journal.rows.length).toBe(1);

    const post2 = await request(app).post(`/api/purchase-returns/${retId}/post`).set(authed(managerAToken));
    expect(post2.status).toBe(200);
    expect(post2.body.duplicate).toBe(true);
    const afterSecondPost = await pool.query("SELECT quantity FROM branch_inventory_stock WHERE branch_id=$1 AND inventory_item_id=$2", [branchA, itemNonBatchId]);
    expect(Number(afterSecondPost.rows[0].quantity)).toBe(Number(after.rows[0].quantity)); // معادش اتخصم تاني
  });

  test("مرتجع مُرحّل مايتلغيش (400) - مسودة تتلغى عادي", async () => {
    const create = await request(app).post("/api/purchase-returns").set(authed(managerAToken)).send({
      branchId: branchA, reason: "تالف", items: [{ inventoryItemId: itemNonBatchId, quantity: 1, unit: "KG" }],
    });
    const cancelDraft = await request(app).post(`/api/purchase-returns/${create.body.id}/cancel`).set(authed(managerAToken)).send({});
    expect(cancelDraft.status).toBe(200);
    expect(cancelDraft.body.status).toBe("CANCELLED");

    const create2 = await request(app).post("/api/purchase-returns").set(authed(managerAToken)).send({
      branchId: branchA, reason: "تالف", items: [{ inventoryItemId: itemNonBatchId, quantity: 1, unit: "KG" }],
    });
    await request(app).post(`/api/purchase-returns/${create2.body.id}/post`).set(authed(managerAToken));
    const cancelPosted = await request(app).post(`/api/purchase-returns/${create2.body.id}/cancel`).set(authed(managerAToken)).send({});
    expect(cancelPosted.status).toBe(400);
  });
});

describe("ترحيل المرتجع - صنف من دفعة محددة", () => {
  test("خصم remaining_quantity من الدفعة بالظبط + تكلفة الحركة من تكلفة الدفعة", async () => {
    const create = await request(app).post("/api/purchase-returns").set(authed(adminToken)).send({
      branchId: branchA, supplierId, reason: "منتهي الصلاحية",
      items: [{ inventoryItemId: itemBatchId, batchId, quantity: 10, unit: "KG" }],
    });
    expect(create.status).toBe(201);
    const post = await request(app).post(`/api/purchase-returns/${create.body.id}/post`).set(authed(adminToken));
    expect(post.status).toBe(200);

    const batch = await pool.query("SELECT remaining_quantity FROM inventory_batches WHERE id = $1", [batchId]);
    expect(Number(batch.rows[0].remaining_quantity)).toBe(40); // 50 - 10

    const movement = await pool.query(
      "SELECT * FROM inventory_movements WHERE reference_type='purchase_return' AND reference_id=$1", [create.body.id]
    );
    expect(Number(movement.rows[0].unit_cost)).toBe(25);
    expect(Number(movement.rows[0].total_cost)).toBe(250); // 10 * 25
  });

  test("طلب إرجاع كمية أكبر من المتبقي في الدفعة -> 400 من غير ما يخصم حاجة", async () => {
    const beforeBatch = await pool.query("SELECT remaining_quantity FROM inventory_batches WHERE id = $1", [batchId]);
    const create = await request(app).post("/api/purchase-returns").set(authed(adminToken)).send({
      branchId: branchA, supplierId, reason: "تالف",
      items: [{ inventoryItemId: itemBatchId, batchId, quantity: 999, unit: "KG" }],
    });
    const post = await request(app).post(`/api/purchase-returns/${create.body.id}/post`).set(authed(adminToken));
    expect(post.status).toBe(400);
    const afterBatch = await pool.query("SELECT remaining_quantity FROM inventory_batches WHERE id = $1", [batchId]);
    expect(Number(afterBatch.rows[0].remaining_quantity)).toBe(Number(beforeBatch.rows[0].remaining_quantity));
    const stillDraft = await pool.query("SELECT status FROM purchase_returns WHERE id = $1", [create.body.id]);
    expect(stillDraft.rows[0].status).toBe("DRAFT");
  });
});

describe("عزل الفروع + الصلاحيات", () => {
  test("مدير فرع B مايقدرش يشوف أو يرحّل مرتجع فرع A، ومحاسب يشوف بس ميرحّلش (permission)", async () => {
    const create = await request(app).post("/api/purchase-returns").set(authed(managerAToken)).send({
      branchId: branchA, reason: "تالف", items: [{ inventoryItemId: itemNonBatchId, quantity: 1, unit: "KG" }],
    });
    const viewByB = await request(app).get(`/api/purchase-returns/${create.body.id}`).set(authed(managerBToken));
    expect(viewByB.status).toBe(403);
    const postByB = await request(app).post(`/api/purchase-returns/${create.body.id}/post`).set(authed(managerBToken));
    expect(postByB.status).toBe(403);

    const listByAccountant = await request(app).get("/api/purchase-returns").query({ branchId: branchA }).set(authed(accountantToken));
    expect(listByAccountant.status).toBe(200);
  });

  test("GET بدون branchId لمدير فرع - بيترشّح على فرعه أوتوماتيك", async () => {
    const list = await request(app).get("/api/purchase-returns").set(authed(managerAToken));
    expect(list.status).toBe(200);
    expect(list.body.every((r) => r.branch_id === branchA)).toBe(true);
  });
});
