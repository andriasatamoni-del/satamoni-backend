// Procurement v2 STEP J: التعبئة (Packaging) - routes/packaging.js. نفس شكل production_orders بالظبط
// (DRAFT→APPROVED→IN_PROGRESS→COMPLETED/CANCELLED)، بس بتستهلك دفعة سائبة محددة بعينها (أو FEFO/FIFO لو
// مش محددة) وتنتج دفعة معبأة جديدة مربوطة بيها كـparent_batch_id مباشر (مفيش غموض تعدد مصادر).
const { app, request, pool, seedUser, login, authed } = require("./helpers");

let branchId, otherBranchId;
let adminToken, managerToken, otherManagerToken;
let bulkItemId, packagedItemId;
let bulkBatchId;

async function createApprovedPackagingOrder(extra = {}) {
  const created = await request(app).post("/api/packaging").set(authed(managerToken)).send({
    branchId, inputItemId: bulkItemId, outputItemId: packagedItemId,
    plannedInputQuantity: 10, plannedOutputQuantity: 20, ...extra,
  });
  expect(created.status).toBe(201);
  await request(app).post(`/api/packaging/${created.body.id}/approve`).set(authed(adminToken)).expect(200);
  return created.body.id;
}

beforeAll(async () => {
  const b1 = await pool.query("INSERT INTO branches (name) VALUES ('فرع تعبئة-جست') RETURNING id");
  branchId = b1.rows[0].id;
  const b2 = await pool.query("INSERT INTO branches (name) VALUES ('فرع تاني تعبئة-جست') RETURNING id");
  otherBranchId = b2.rows[0].id;
  await seedUser({ name: "أدمن-تعبئة", email: "admin-packaging@jest.test", role: "admin" });
  await seedUser({ branchId, name: "مدير فرع-تعبئة", email: "manager-packaging@jest.test", role: "branch_manager" });
  await seedUser({ branchId: otherBranchId, name: "مدير فرع تاني-تعبئة", email: "othermanager-packaging@jest.test", role: "branch_manager" });
  adminToken = await login("admin-packaging@jest.test");
  managerToken = await login("manager-packaging@jest.test");
  otherManagerToken = await login("othermanager-packaging@jest.test");

  const bulk = await pool.query(
    "INSERT INTO inventory_items (name, unit, unit_cost, item_type, batch_prefix) VALUES ('صوص سائب-تعبئة-جست', 'KG', 10, 'manufactured', 'SCE') RETURNING id"
  );
  bulkItemId = bulk.rows[0].id;
  const packaged = await pool.query(
    "INSERT INTO inventory_items (name, unit, unit_cost, item_type) VALUES ('صوص معبأ-تعبئة-جست', 'unit', NULL, 'manufactured') RETURNING id"
  );
  packagedItemId = packaged.rows[0].id;

  await pool.query(
    "INSERT INTO branch_inventory_stock (branch_id, inventory_item_id, quantity) VALUES ($1,$2,100),($1,$3,0)",
    [branchId, bulkItemId, packagedItemId]
  );
  const batch = await pool.query(
    `INSERT INTO inventory_batches (batch_number, inventory_item_id, branch_id, received_date, original_quantity, remaining_quantity, unit_cost, status)
     VALUES ('BULK-BATCH-001', $1, $2, CURRENT_DATE, 100, 100, 10, 'active') RETURNING id`,
    [bulkItemId, branchId]
  );
  bulkBatchId = batch.rows[0].id;
});

afterAll(async () => {
  await pool.end();
});

describe("دورة حياة أمر التعبئة الكاملة - دفعة محددة صراحة", () => {
  let orderId;

  test("إنشاء أمر تعبئة بدفعة سائب محددة + اعتماد", async () => {
    orderId = await createApprovedPackagingOrder({ inputBatchId: bulkBatchId, expiryDate: "2027-03-01" });
    const detail = await request(app).get(`/api/packaging/${orderId}`).set(authed(managerToken));
    expect(detail.status).toBe(200);
    expect(detail.body.status).toBe("APPROVED");
  });

  test("بدء التعبئة - بيستهلك من الدفعة المحددة بالظبط، مفيش FEFO عام", async () => {
    const res = await request(app).post(`/api/packaging/${orderId}/start`).set(authed(managerToken));
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("IN_PROGRESS");
    const batch = await pool.query("SELECT remaining_quantity FROM inventory_batches WHERE id = $1", [bulkBatchId]);
    expect(Number(batch.rows[0].remaining_quantity)).toBeCloseTo(90, 5); // 100 - 10 المخطط
  });

  test("إكمال التعبئة - دفعة ناتج جديدة بترقيم نظامي، parent_batch_id = دفعة السائب، تكلفة الوحدة محسوبة فعليًا (10كيلو×10 / 20 وحدة = 5)", async () => {
    const res = await request(app).post(`/api/packaging/${orderId}/complete`).set(authed(managerToken)).send({ actualOutputQuantity: 20 });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("COMPLETED");
    // batch_prefix (SCE) متسجل على صنف السائب المدخل، مش على الصنف المعبأ الناتج - وده اللي بيتولّد له
    // رقم الدفعة الجديد فعليًا (order.output_item_id) - فبيرجع بالبادئة الافتراضية MFG مش SCE
    expect(res.body.generatedBatchNumber).toMatch(/^MFG-\d{8}-\d{3}$/);
    expect(res.body.parentBatchId).toBe(bulkBatchId);

    const outputBatch = await pool.query("SELECT unit_cost, parent_batch_id, remaining_quantity FROM inventory_batches WHERE id = $1", [res.body.batchId]);
    expect(Number(outputBatch.rows[0].unit_cost)).toBeCloseTo(5, 5);
    expect(outputBatch.rows[0].parent_batch_id).toBe(bulkBatchId);
    expect(Number(outputBatch.rows[0].remaining_quantity)).toBeCloseTo(20, 5);

    const stock = await pool.query("SELECT quantity FROM branch_inventory_stock WHERE branch_id = $1 AND inventory_item_id = $2", [branchId, packagedItemId]);
    expect(Number(stock.rows[0].quantity)).toBeCloseTo(20, 5);
  });
});

describe("التعبئة من غير دفعة محددة (FEFO/FIFO عام) + إلغاء", () => {
  test("تعبئة من غير inputBatchId - بتستهلك من الرصيد العام", async () => {
    const orderId = await createApprovedPackagingOrder();
    const start = await request(app).post(`/api/packaging/${orderId}/start`).set(authed(managerToken));
    expect(start.status).toBe(200);
    const complete = await request(app).post(`/api/packaging/${orderId}/complete`).set(authed(managerToken)).send({ actualOutputQuantity: 20 });
    expect(complete.status).toBe(200);
  });

  test("إلغاء أمر تعبئة IN_PROGRESS - بيرجّع الكمية المستهلكة بالظبط", async () => {
    const orderId = await createApprovedPackagingOrder({ inputBatchId: bulkBatchId });
    const beforeStart = await pool.query("SELECT remaining_quantity FROM inventory_batches WHERE id = $1", [bulkBatchId]);
    await request(app).post(`/api/packaging/${orderId}/start`).set(authed(managerToken)).expect(200);
    const afterStart = await pool.query("SELECT remaining_quantity FROM inventory_batches WHERE id = $1", [bulkBatchId]);
    expect(Number(afterStart.rows[0].remaining_quantity)).toBeCloseTo(Number(beforeStart.rows[0].remaining_quantity) - 10, 5);

    const cancel = await request(app).post(`/api/packaging/${orderId}/cancel`).set(authed(managerToken)).send({ reason: "غلط" });
    expect(cancel.status).toBe(200);
    expect(cancel.body.status).toBe("CANCELLED");
    const afterCancel = await pool.query("SELECT remaining_quantity FROM inventory_batches WHERE id = $1", [bulkBatchId]);
    expect(Number(afterCancel.rows[0].remaining_quantity)).toBeCloseTo(Number(beforeStart.rows[0].remaining_quantity), 5);
  });
});

describe("حراسات وصلاحيات", () => {
  test("رصيد دفعة محددة مش كافي - مرفوض", async () => {
    const smallBatch = await pool.query(
      `INSERT INTO inventory_batches (batch_number, inventory_item_id, branch_id, received_date, original_quantity, remaining_quantity, unit_cost, status)
       VALUES ('SMALL-BATCH', $1, $2, CURRENT_DATE, 2, 2, 10, 'active') RETURNING id`,
      [bulkItemId, branchId]
    );
    const orderId = await createApprovedPackagingOrder({ inputBatchId: smallBatch.rows[0].id, plannedInputQuantity: 10 });
    const res = await request(app).post(`/api/packaging/${orderId}/start`).set(authed(managerToken));
    expect(res.status).toBe(400);
  });

  test("أمر تعبئة بكمية مخططة صفر أو سالبة - مرفوض عند الإنشاء", async () => {
    const res = await request(app).post("/api/packaging").set(authed(managerToken)).send({
      branchId, inputItemId: bulkItemId, outputItemId: packagedItemId, plannedInputQuantity: 0, plannedOutputQuantity: 20,
    });
    expect(res.status).toBe(400);
  });

  test("مدير فرع مش أدمن ممنوع يعتمد أمر تعبئة", async () => {
    const created = await request(app).post("/api/packaging").set(authed(managerToken)).send({
      branchId, inputItemId: bulkItemId, outputItemId: packagedItemId, plannedInputQuantity: 5, plannedOutputQuantity: 10,
    });
    const res = await request(app).post(`/api/packaging/${created.body.id}/approve`).set(authed(managerToken));
    expect(res.status).toBe(403);
  });
});

// STEP L-audit (بند 13 - عزل الفروع "حرج"): مفيش أي اختبار عزل فروع كان موجود لأوامر التعبئة قبل كده -
// الكود فيه assertOwnBranch على كل نقطة (POST /، GET /:id، /start، /complete، /cancel) بس من غير اختبار
// فعلي يثبت إنها شغالة. الاختبارات دي بتسد الفجوة دي.
describe("عزل الفروع - أمر تعبئة", () => {
  let isolatedOrderId;

  test("إنشاء أمر تعبئة لفرع تاني - مرفوض", async () => {
    const res = await request(app).post("/api/packaging").set(authed(otherManagerToken)).send({
      branchId, inputItemId: bulkItemId, outputItemId: packagedItemId, plannedInputQuantity: 5, plannedOutputQuantity: 10,
    });
    expect(res.status).toBe(403);
  });

  test("مدير فرع تاني ممنوع يشوف/يبدأ أمر تعبئة مش بتاعه", async () => {
    isolatedOrderId = await createApprovedPackagingOrder();

    const get = await request(app).get(`/api/packaging/${isolatedOrderId}`).set(authed(otherManagerToken));
    expect(get.status).toBe(403);

    const start = await request(app).post(`/api/packaging/${isolatedOrderId}/start`).set(authed(otherManagerToken));
    expect(start.status).toBe(403);
  });

  test("مدير الفرع صاحب أمر التعبئة يبدأه فعليًا - وبعد كده الفرع التاني لسه ممنوع يكمّل/يلغي (الحالة بقت IN_PROGRESS دلوقتي فالفحص فعليًا بيوصل لعزل الفرع)", async () => {
    const start = await request(app).post(`/api/packaging/${isolatedOrderId}/start`).set(authed(managerToken));
    expect(start.status).toBe(200);

    const complete = await request(app).post(`/api/packaging/${isolatedOrderId}/complete`).set(authed(otherManagerToken)).send({ actualOutputQuantity: 10 });
    expect(complete.status).toBe(403);

    const cancel = await request(app).post(`/api/packaging/${isolatedOrderId}/cancel`).set(authed(otherManagerToken)).send({ reason: "محاولة اختراق عزل" });
    expect(cancel.status).toBe(403);
  });

  test("مدير الفرع صاحب أمر التعبئة لسه يقدر يكمّله عادي بعد محاولات الفرع التاني", async () => {
    const complete = await request(app).post(`/api/packaging/${isolatedOrderId}/complete`).set(authed(managerToken)).send({ actualOutputQuantity: 10 });
    expect(complete.status).toBe(200);
  });
});
