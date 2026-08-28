// Procurement v2 STEP I: تتبّع الدفعة الكامل بالاتجاهين - مورد → GRN → دفعة خام → تصنيع → تحويل → فرع،
// وللأمام: استهلاك/تحويل/بيع/هالك. GET /api/inventory/batches/:id/trace.
const { app, request, pool, seedUser, login, authed } = require("./helpers");

let branchId, ckBranchId, otherBranchId;
let adminToken, managerToken, ckManagerToken, otherManagerToken, accountantToken;
let supplierId, rawItemId, manufacturedItemId;

async function createActiveRecipe({ inventoryItemId, yieldQuantity, ingredients }) {
  const created = await request(app).post("/api/recipes").set(authed(adminToken)).send({
    recipeType: "manufactured_item", inventoryItemId, yieldQuantity, yieldUnit: "unit", ingredients,
  });
  const versionId = created.body.version.id;
  await request(app).post(`/api/recipes/versions/${versionId}/submit`).set(authed(ckManagerToken)).expect(200);
  await request(app).post(`/api/recipes/versions/${versionId}/approve`).set(authed(adminToken)).expect(200);
  await request(app).post(`/api/recipes/versions/${versionId}/activate`).set(authed(adminToken)).expect(200);
  const recipeRow = await pool.query("SELECT recipe_id FROM recipe_versions WHERE id = $1", [versionId]);
  return recipeRow.rows[0].recipe_id;
}

beforeAll(async () => {
  const b1 = await pool.query("INSERT INTO branches (name) VALUES ('فرع تتبّع-جست') RETURNING id");
  branchId = b1.rows[0].id;
  const ck = await pool.query("INSERT INTO branches (name, is_central_kitchen) VALUES ('سنتر كيتشن-تتبّع-جست', TRUE) RETURNING id");
  ckBranchId = ck.rows[0].id;
  const b2 = await pool.query("INSERT INTO branches (name) VALUES ('فرع تاني تتبّع-جست') RETURNING id");
  otherBranchId = b2.rows[0].id;

  await seedUser({ name: "أدمن-تتبّع", email: "admin-trace@jest.test", role: "admin" });
  await seedUser({ branchId, name: "مدير فرع-تتبّع", email: "manager-trace@jest.test", role: "branch_manager" });
  await seedUser({ branchId: ckBranchId, name: "مدير سنتر كيتشن-تتبّع", email: "ck-trace@jest.test", role: "branch_manager" });
  await seedUser({ branchId: otherBranchId, name: "مدير فرع تاني-تتبّع", email: "othermanager-trace@jest.test", role: "branch_manager" });
  await seedUser({ name: "محاسب-تتبّع", email: "accountant-trace@jest.test", role: "accountant" });

  adminToken = await login("admin-trace@jest.test");
  managerToken = await login("manager-trace@jest.test");
  ckManagerToken = await login("ck-trace@jest.test");
  otherManagerToken = await login("othermanager-trace@jest.test");
  accountantToken = await login("accountant-trace@jest.test");

  const supplier = await request(app).post("/api/suppliers").set(authed(adminToken)).send({ name: "مورد تتبّع-جست" });
  supplierId = supplier.body.id;

  const raw = await pool.query("INSERT INTO inventory_items (name, unit, unit_cost) VALUES ('خام تتبّع-جست', 'KG', 8) RETURNING id");
  rawItemId = raw.rows[0].id;
  const mfg = await pool.query(
    "INSERT INTO inventory_items (name, unit, unit_cost, item_type) VALUES ('منتج مصنّع-تتبّع-جست', 'KG', NULL, 'manufactured') RETURNING id"
  );
  manufacturedItemId = mfg.rows[0].id;
  await pool.query(
    "INSERT INTO branch_inventory_stock (branch_id, inventory_item_id, quantity) VALUES ($1,$2,0),($1,$3,0),($4,$3,0)",
    [ckBranchId, rawItemId, manufacturedItemId, branchId]
  );
});

afterAll(async () => {
  await pool.end();
});

describe("تتبّع للخلف: مورد → GRN → دفعة خام", () => {
  let grnBatchId;

  test("PO + GRN بدفعة (batch_number/expiry) في السنتر كيتشن", async () => {
    const po = await request(app).post("/api/purchase-orders").set(authed(ckManagerToken)).send({
      supplierId, branchId: ckBranchId, items: [{ inventoryItemId: rawItemId, orderedQuantity: 100, unitPrice: 8 }],
    });
    await request(app).post(`/api/purchase-orders/${po.body.id}/submit`).set(authed(ckManagerToken)).expect(200);
    await request(app).post(`/api/purchase-orders/${po.body.id}/approve`).set(authed(adminToken)).expect(200);
    const detail = await request(app).get(`/api/purchase-orders/${po.body.id}`).set(authed(adminToken));
    const poItemId = detail.body.items[0].id;

    const grn = await request(app).post("/api/goods-receipts").set(authed(ckManagerToken)).send({
      purchaseOrderId: po.body.id,
      items: [{ purchaseOrderItemId: poItemId, receivedQuantity: 100, acceptedQuantity: 100, unitPrice: 8, batchNumber: "RAW-TRACE-001", expiryDate: "2027-01-01" }],
    });
    await request(app).post(`/api/goods-receipts/${grn.body.id}/post`).set(authed(ckManagerToken)).expect(200);
    const grnDetail = await request(app).get(`/api/goods-receipts/${grn.body.id}`).set(authed(ckManagerToken));
    grnBatchId = grnDetail.body.items[0].batch_id;
    expect(grnBatchId).not.toBeNull();
  });

  test("GET /:id/trace - origin.type = PURCHASE ومعاه اسم المورد", async () => {
    const res = await request(app).get(`/api/inventory/batches/${grnBatchId}/trace`).set(authed(ckManagerToken));
    expect(res.status).toBe(200);
    expect(res.body.backward.origin.type).toBe("PURCHASE");
    expect(res.body.backward.origin.supplier_name).toBe("مورد تتبّع-جست");
    expect(res.body.backward.origin.goods_receipt_id).not.toBeUndefined();
    global.__rawBatchId = grnBatchId;
  });

  test("GET /:id/trace - فرع تاني (مش مالك الدفعة) ممنوع", async () => {
    const res = await request(app).get(`/api/inventory/batches/${global.__rawBatchId}/trace`).set(authed(otherManagerToken));
    expect(res.status).toBe(403);
  });

  test("GET /:id/trace - دفعة مش موجودة - 404", async () => {
    const res = await request(app).get(`/api/inventory/batches/999999/trace`).set(authed(adminToken));
    expect(res.status).toBe(404);
  });
});

describe("تتبّع للخلف والأمام: خام → تصنيع → دفعة ناتجة", () => {
  let outputBatchId;

  test("تصنيع منتج من الخام المستلم بالدفعة", async () => {
    const recipeId = await createActiveRecipe({
      inventoryItemId: manufacturedItemId, yieldQuantity: 50, ingredients: [{ ingredientItemId: rawItemId, quantity: 50 }],
    });
    const created = await request(app).post("/api/production").set(authed(ckManagerToken)).send({
      branchId: ckBranchId, recipeId, plannedQuantity: 50, expiryDate: "2027-02-01",
    });
    await request(app).post(`/api/production/${created.body.id}/approve`).set(authed(adminToken)).expect(200);
    await request(app).post(`/api/production/${created.body.id}/start`).set(authed(ckManagerToken)).expect(200);
    const complete = await request(app).post(`/api/production/${created.body.id}/complete`).set(authed(ckManagerToken)).send({ actualQuantity: 50 });
    outputBatchId = complete.body.batchId;
    expect(outputBatchId).not.toBeNull();
    global.__outputBatchId = outputBatchId;
    global.__productionOrderId = created.body.id;
  });

  test("تتبّع للخلف من الدفعة الناتجة - origin.type = PRODUCTION ومعاها مدخلات التصنيع", async () => {
    const res = await request(app).get(`/api/inventory/batches/${outputBatchId}/trace`).set(authed(ckManagerToken));
    expect(res.status).toBe(200);
    expect(res.body.backward.origin.type).toBe("PRODUCTION");
    expect(res.body.backward.origin.production_order_id).toBe(global.__productionOrderId);
    expect(res.body.backward.origin.inputs.length).toBeGreaterThan(0);
    expect(res.body.backward.origin.inputs[0].batch_id).toBe(global.__rawBatchId);
  });

  test("تتبّع للأمام من دفعة الخام - consumedInProduction بيوريها استهلكت في التصنيع ده وطلع منه إيه", async () => {
    const res = await request(app).get(`/api/inventory/batches/${global.__rawBatchId}/trace`).set(authed(ckManagerToken));
    expect(res.status).toBe(200);
    const consumed = res.body.forward.consumedInProduction.find((c) => c.production_order_id === global.__productionOrderId);
    expect(consumed).toBeDefined();
    expect(consumed.output_batch_id).toBe(global.__outputBatchId);
  });
});

describe("تتبّع عبر التحويل بين الفروع (هوية الدفعة محفوظة، id مختلف)", () => {
  let destBatchId;

  test("تحويل جزء من الدفعة الناتجة من السنتر كيتشن للفرع", async () => {
    const reqRes = await request(app).post("/api/kitchen-transfers/request").set(authed(ckManagerToken)).send({
      fromBranchId: ckBranchId, toBranchId: branchId, businessDate: "2027-02-02",
      items: [{ inventoryItemId: manufacturedItemId, quantity: 20 }],
    });
    const transferId = reqRes.body.id;
    await request(app).post(`/api/kitchen-transfers/${transferId}/approve`).set(authed(adminToken)).expect(200);
    await request(app).post(`/api/kitchen-transfers/${transferId}/issue`).set(authed(ckManagerToken)).expect(200);
    await request(app).post(`/api/kitchen-transfers/${transferId}/receive`).set(authed(managerToken)).send({
      items: [{ inventoryItemId: manufacturedItemId, quantityReceived: 20 }],
    }).expect(200);

    const destBatch = await pool.query(
      "SELECT id FROM inventory_batches WHERE inventory_item_id = $1 AND branch_id = $2", [manufacturedItemId, branchId]
    );
    expect(destBatch.rows.length).toBe(1);
    destBatchId = destBatch.rows[0].id;
    expect(destBatchId).not.toBe(global.__outputBatchId); // صف مختلف تمامًا في فرع الاستلام
  });

  test("تتبّع للخلف من دفعة فرع الاستلام - transferredIn معبّي، وparent بيكمل لأصل التصنيع", async () => {
    const res = await request(app).get(`/api/inventory/batches/${destBatchId}/trace`).set(authed(managerToken));
    expect(res.status).toBe(200);
    expect(res.body.backward.transferredIn).not.toBeNull();
    expect(res.body.backward.transferredIn.to_branch_id).toBe(branchId);
    expect(res.body.backward.parent).not.toBeNull();
    expect(res.body.backward.parent.batch.id).toBe(global.__outputBatchId);
    expect(res.body.backward.parent.origin.type).toBe("PRODUCTION");
  });

  test("تتبّع للأمام من الدفعة الأصلية في السنتر كيتشن - transferredOut بيوضّح التحويل", async () => {
    const res = await request(app).get(`/api/inventory/batches/${global.__outputBatchId}/trace`).set(authed(ckManagerToken));
    expect(res.status).toBe(200);
    expect(res.body.forward.transferredOut.length).toBeGreaterThan(0);
    expect(res.body.forward.transferredOut[0].to_branch_id).toBe(branchId);
  });
});

describe("صلاحيات إضافية", () => {
  test("محاسب (دور مركزي) يقدر يتتبّع أي دفعة في أي فرع", async () => {
    const res = await request(app).get(`/api/inventory/batches/${global.__rawBatchId}/trace`).set(authed(accountantToken));
    expect(res.status).toBe(200);
  });
});

// STEP L-audit (بند 5+6 - "المخاطرة المعروفة المتبقية"): سلسلة كاملة متعددة المراحل ومتعددة المصادر -
// خام أ (10كجم) + خام ب (15كجم) → تصنيع سائب X (يستهلك 10 من كل دفعة عبر FEFO - أ تنتهي صلاحيتها الأول)
// → تعبئة حصص Y (من X) → تعبئة كراتين Z (من Y). قبل الإصلاح: traceBackward كانت بترجع inputs[A,B] على
// مستوى X بس من غير ما تكمل تتبّع أي منهم لأصله (GRN/المورد) - يعني تتبّع Z للخلف كان بيوصل لـX وبعدين
// A/B بيظهروا كمدخلات بس من غير سلسلتهم الأصلية بالكامل. الاختبار ده بيتأكد إن "ولا دفعة مصدر بتختفي".
describe("تتبّع متعدد المراحل ومتعدد المصادر (Z→Y→X→أ+ب) - بدون فقد أي دفعة مصدر", () => {
  let rawMultiItemId, bulkMultiItemId, portionMultiItemId, cartonMultiItemId;
  let batchAId, batchBId, xBatchId, yBatchId, zBatchId;

  test("إعداد: خامين بدفعتين منفصلتين (أ = 10كجم صلاحية أقرب، ب = 15كجم صلاحية أبعد) عبر GRN حقيقي", async () => {
    const raw = await pool.query("INSERT INTO inventory_items (name, unit, unit_cost) VALUES ('خام متعدد-تتبّع-جست', 'KG', 8) RETURNING id");
    rawMultiItemId = raw.rows[0].id;
    const bulk = await pool.query(
      "INSERT INTO inventory_items (name, unit, unit_cost, item_type) VALUES ('سائب متعدد-تتبّع-جست', 'KG', NULL, 'manufactured') RETURNING id"
    );
    bulkMultiItemId = bulk.rows[0].id;
    const portion = await pool.query(
      "INSERT INTO inventory_items (name, unit, unit_cost, item_type) VALUES ('حصة متعدد-تتبّع-جست', 'unit', NULL, 'manufactured') RETURNING id"
    );
    portionMultiItemId = portion.rows[0].id;
    const carton = await pool.query(
      "INSERT INTO inventory_items (name, unit, unit_cost, item_type) VALUES ('كرتونة متعدد-تتبّع-جست', 'unit', NULL, 'manufactured') RETURNING id"
    );
    cartonMultiItemId = carton.rows[0].id;
    await pool.query(
      "INSERT INTO branch_inventory_stock (branch_id, inventory_item_id, quantity) VALUES ($1,$2,0),($1,$3,0),($1,$4,0),($1,$5,0)",
      [ckBranchId, rawMultiItemId, bulkMultiItemId, portionMultiItemId, cartonMultiItemId]
    );

    async function receiveBatch(batchNumber, expiryDate, quantity) {
      const po = await request(app).post("/api/purchase-orders").set(authed(ckManagerToken)).send({
        supplierId, branchId: ckBranchId, items: [{ inventoryItemId: rawMultiItemId, orderedQuantity: quantity, unitPrice: 8 }],
      });
      await request(app).post(`/api/purchase-orders/${po.body.id}/submit`).set(authed(ckManagerToken)).expect(200);
      await request(app).post(`/api/purchase-orders/${po.body.id}/approve`).set(authed(adminToken)).expect(200);
      const detail = await request(app).get(`/api/purchase-orders/${po.body.id}`).set(authed(adminToken));
      const poItemId = detail.body.items[0].id;
      const grn = await request(app).post("/api/goods-receipts").set(authed(ckManagerToken)).send({
        purchaseOrderId: po.body.id,
        items: [{ purchaseOrderItemId: poItemId, receivedQuantity: quantity, acceptedQuantity: quantity, unitPrice: 8, batchNumber, expiryDate }],
      });
      await request(app).post(`/api/goods-receipts/${grn.body.id}/post`).set(authed(ckManagerToken)).expect(200);
      const grnDetail = await request(app).get(`/api/goods-receipts/${grn.body.id}`).set(authed(ckManagerToken));
      return grnDetail.body.items[0].batch_id;
    }

    batchAId = await receiveBatch("RAW-MULTI-A", "2027-01-01", 10); // صلاحية أقرب - FEFO هتستهلكها الأول
    batchBId = await receiveBatch("RAW-MULTI-B", "2027-06-01", 15);
    expect(batchAId).not.toBeNull();
    expect(batchBId).not.toBeNull();
  });

  test("تصنيع X: يستهلك 10كجم من كل دفعة (أ بالكامل + جزء من ب) - production_order_batches بترصد الدفعتين", async () => {
    const recipeId = await createActiveRecipe({
      inventoryItemId: bulkMultiItemId, yieldQuantity: 20, ingredients: [{ ingredientItemId: rawMultiItemId, quantity: 20 }],
    });
    const created = await request(app).post("/api/production").set(authed(ckManagerToken)).send({
      branchId: ckBranchId, recipeId, plannedQuantity: 20, expiryDate: "2027-03-01",
    });
    await request(app).post(`/api/production/${created.body.id}/approve`).set(authed(adminToken)).expect(200);
    await request(app).post(`/api/production/${created.body.id}/start`).set(authed(ckManagerToken)).expect(200);
    const complete = await request(app).post(`/api/production/${created.body.id}/complete`).set(authed(ckManagerToken)).send({ actualQuantity: 20 });
    xBatchId = complete.body.batchId;
    expect(xBatchId).not.toBeNull();

    const inputs = await pool.query(
      "SELECT batch_id, quantity FROM production_order_batches WHERE production_order_id = $1 AND role = 'input'", [created.body.id]
    );
    expect(inputs.rows.map((r) => r.batch_id).sort()).toEqual([batchAId, batchBId].sort());
    const aRow = inputs.rows.find((r) => r.batch_id === batchAId);
    const bRow = inputs.rows.find((r) => r.batch_id === batchBId);
    expect(Number(aRow.quantity)).toBeCloseTo(10, 5);
    expect(Number(bRow.quantity)).toBeCloseTo(10, 5);
  });

  test("تعبئة Y من X، وتعبئة Z من Y - سلسلة مراحل متتالية كل واحدة بدفعة فريدة مربوطة بالأب المباشر", async () => {
    const packY = await request(app).post("/api/packaging").set(authed(ckManagerToken)).send({
      branchId: ckBranchId, inputItemId: bulkMultiItemId, outputItemId: portionMultiItemId,
      inputBatchId: xBatchId, plannedInputQuantity: 20, plannedOutputQuantity: 200,
    });
    await request(app).post(`/api/packaging/${packY.body.id}/approve`).set(authed(adminToken)).expect(200);
    await request(app).post(`/api/packaging/${packY.body.id}/start`).set(authed(ckManagerToken)).expect(200);
    const completeY = await request(app).post(`/api/packaging/${packY.body.id}/complete`).set(authed(ckManagerToken)).send({ actualOutputQuantity: 200 });
    yBatchId = completeY.body.batchId;
    expect(completeY.body.parentBatchId).toBe(xBatchId);

    const packZ = await request(app).post("/api/packaging").set(authed(ckManagerToken)).send({
      branchId: ckBranchId, inputItemId: portionMultiItemId, outputItemId: cartonMultiItemId,
      inputBatchId: yBatchId, plannedInputQuantity: 200, plannedOutputQuantity: 10,
    });
    await request(app).post(`/api/packaging/${packZ.body.id}/approve`).set(authed(adminToken)).expect(200);
    await request(app).post(`/api/packaging/${packZ.body.id}/start`).set(authed(ckManagerToken)).expect(200);
    const completeZ = await request(app).post(`/api/packaging/${packZ.body.id}/complete`).set(authed(ckManagerToken)).send({ actualOutputQuantity: 10 });
    zBatchId = completeZ.body.batchId;
    expect(completeZ.body.parentBatchId).toBe(yBatchId);
  });

  test("GET /:id/trace من Z للخلف - Z→Y→X، وX بيوريّ الدفعتين أ وب معًا، وكل واحدة فيهم متتبّعة لأصلها (GRN/مورد) - ولا واحدة اختفت", async () => {
    const res = await request(app).get(`/api/inventory/batches/${zBatchId}/trace`).set(authed(ckManagerToken));
    expect(res.status).toBe(200);

    const zNode = res.body.backward;
    expect(zNode.origin.type).toBe("PACKAGING");
    expect(zNode.parent).not.toBeNull();

    const yNode = zNode.parent;
    expect(yNode.batch.id).toBe(yBatchId);
    expect(yNode.origin.type).toBe("PACKAGING");
    expect(yNode.parent).not.toBeNull();

    const xNode = yNode.parent;
    expect(xNode.batch.id).toBe(xBatchId);
    expect(xNode.origin.type).toBe("PRODUCTION");
    expect(xNode.origin.inputs.length).toBe(2);

    const aInput = xNode.origin.inputs.find((i) => i.batch_id === batchAId);
    const bInput = xNode.origin.inputs.find((i) => i.batch_id === batchBId);
    expect(aInput).toBeDefined();
    expect(bInput).toBeDefined();

    // قبل الإصلاح: aInput.trace/bInput.trace ماكانوش موجودين خالص - التتبّع كان بيوقف عند مستوى X
    expect(aInput.trace).not.toBeNull();
    expect(aInput.trace.batch.id).toBe(batchAId);
    expect(aInput.trace.origin.type).toBe("PURCHASE");
    expect(aInput.trace.origin.supplier_name).toBe("مورد تتبّع-جست");

    expect(bInput.trace).not.toBeNull();
    expect(bInput.trace.batch.id).toBe(batchBId);
    expect(bInput.trace.origin.type).toBe("PURCHASE");
    expect(bInput.trace.origin.supplier_name).toBe("مورد تتبّع-جست");
  });
});
