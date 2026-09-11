// المرحلة 9A-3: فحص التكرار بين مسار مشترى الكاشير الطارئ (routes/purchases.js) ومسار GRN الرسمي
// (routes/goods-receipts.js) - نفس المورد ونفس رقم مستنده مسجل مرتين في نفس الفرع لازم يتعرض صراحة
// (409 + duplicateReferences) ويتطلب acknowledgeDuplicate:true قبل ما يكمل
const { app, request, pool, seedUser, login, authed } = require("./helpers");

let branchId, otherBranchId;
let adminToken, managerToken;
let supplierId, itemId;

async function createApprovedPO(supplierIdArg, branchIdArg, quantity = 10, unitPrice = 20) {
  const po = await request(app).post("/api/purchase-orders").set(authed(managerToken)).send({
    supplierId: supplierIdArg, branchId: branchIdArg, items: [{ inventoryItemId: itemId, orderedQuantity: quantity, unitPrice }],
  });
  await request(app).post(`/api/purchase-orders/${po.body.id}/submit`).set(authed(managerToken)).expect(200);
  await request(app).post(`/api/purchase-orders/${po.body.id}/approve`).set(authed(adminToken)).expect(200);
  const detail = await request(app).get(`/api/purchase-orders/${po.body.id}`).set(authed(adminToken));
  return { poId: po.body.id, poItemId: detail.body.items[0].id };
}

beforeAll(async () => {
  const b1 = await pool.query("INSERT INTO branches (name) VALUES ('فرع تكرار-مشتريات-جست') RETURNING id");
  branchId = b1.rows[0].id;
  const b2 = await pool.query("INSERT INTO branches (name) VALUES ('فرع تاني تكرار-مشتريات-جست') RETURNING id");
  otherBranchId = b2.rows[0].id;

  await seedUser({ name: "أدمن-تكرار-مشتريات", email: "admin-purchdup@jest.test", role: "admin" });
  await seedUser({ branchId, name: "مدير فرع-تكرار-مشتريات", email: "manager-purchdup@jest.test", role: "branch_manager" });
  adminToken = await login("admin-purchdup@jest.test");
  managerToken = await login("manager-purchdup@jest.test");

  const item = await pool.query("INSERT INTO inventory_items (name, unit, unit_cost) VALUES ('صنف-تكرار-مشتريات-جست', 'KG', 20) RETURNING id");
  itemId = item.rows[0].id;
  await pool.query(
    "INSERT INTO branch_inventory_stock (branch_id, inventory_item_id, quantity) VALUES ($1,$2,0),($3,$2,0)",
    [branchId, itemId, otherBranchId]
  );

  const supplier = await request(app).post("/api/suppliers").set(authed(adminToken)).send({ name: "مورد-تكرار-مشتريات-جست" });
  supplierId = supplier.body.id;
});

afterAll(async () => {
  await pool.end();
});

describe("مشترى مسجل الأول، GRN بيحاول يسجل نفس التوريدة تاني - لازم يتعرض", () => {
  test("مشترى نقدي بمورد+رقم مستند، بعدين GRN رسمي بنفس المورد ونفس الرقم -> 409 duplicateReferences يشمل مصدر purchase", async () => {
    const docNumber = `DUP-A-${Date.now()}`;
    const purchase = await request(app).post("/api/purchases").set(authed(managerToken)).send({
      branchId, businessDate: "2026-01-01", supplierId, supplierDocumentNumber: docNumber,
      items: [{ inventoryItemId: itemId, quantity: 5, unitPrice: 20 }],
    });
    expect(purchase.status).toBe(201);
    expect(purchase.body.status).toBe("CONFIRMED");

    const { poId, poItemId } = await createApprovedPO(supplierId, branchId);
    const grn = await request(app).post("/api/goods-receipts").set(authed(managerToken)).send({
      purchaseOrderId: poId, supplierDocumentNumber: docNumber,
      items: [{ purchaseOrderItemId: poItemId, receivedQuantity: 10, acceptedQuantity: 10 }],
    });
    expect(grn.status).toBe(409);
    expect(grn.body.duplicateReferences.some((d) => d.source === "purchase")).toBe(true);

    const grnAck = await request(app).post("/api/goods-receipts").set(authed(managerToken)).send({
      purchaseOrderId: poId, supplierDocumentNumber: docNumber, acknowledgeDuplicate: true,
      items: [{ purchaseOrderItemId: poItemId, receivedQuantity: 10, acceptedQuantity: 10 }],
    });
    expect(grnAck.status).toBe(201);
  });
});

describe("GRN مسجل الأول، مشترى بيحاول يسجل نفس التوريدة تاني - لازم يتعرض", () => {
  test("GRN مرحّل بمورد+رقم مستند، بعدين مشترى نقدي بنفس المورد ونفس الرقم -> 409 duplicateReferences يشمل مصدر goods_receipt", async () => {
    const docNumber = `DUP-B-${Date.now()}`;
    const { poId, poItemId } = await createApprovedPO(supplierId, branchId);
    const grn = await request(app).post("/api/goods-receipts").set(authed(managerToken)).send({
      purchaseOrderId: poId, supplierDocumentNumber: docNumber,
      items: [{ purchaseOrderItemId: poItemId, receivedQuantity: 10, acceptedQuantity: 10 }],
    });
    expect(grn.status).toBe(201);
    await request(app).post(`/api/goods-receipts/${grn.body.id}/post`).set(authed(managerToken)).expect(200);

    const purchase = await request(app).post("/api/purchases").set(authed(managerToken)).send({
      branchId, businessDate: "2026-01-01", supplierId, supplierDocumentNumber: docNumber,
      items: [{ inventoryItemId: itemId, quantity: 3, unitPrice: 20 }],
    });
    expect(purchase.status).toBe(409);
    expect(purchase.body.duplicateReferences.some((d) => d.source === "goods_receipt")).toBe(true);
    const stillNothing = await pool.query("SELECT id FROM purchases WHERE branch_id=$1 AND supplier_id=$2 AND supplier_document_number=$3 AND status <> 'REJECTED'", [branchId, supplierId, docNumber]);
    expect(stillNothing.rows.length).toBe(0); // مفيش تسجيل اتحصل - الرفض حصل قبل الـINSERT

    const purchaseAck = await request(app).post("/api/purchases").set(authed(managerToken)).send({
      branchId, businessDate: "2026-01-01", supplierId, supplierDocumentNumber: docNumber, acknowledgeDuplicate: true,
      items: [{ inventoryItemId: itemId, quantity: 3, unitPrice: 20 }],
    });
    expect(purchaseAck.status).toBe(201);
  });
});

describe("مفيش تكرار حقيقي - مينفعش يتعرض بلاش سبب", () => {
  test("مورد ورقم مستند مختلفين -> مفيش أي blocker على أي مسار", async () => {
    const purchase = await request(app).post("/api/purchases").set(authed(managerToken)).send({
      branchId, businessDate: "2026-01-01", supplierId, supplierDocumentNumber: `DUP-C-${Date.now()}`,
      items: [{ inventoryItemId: itemId, quantity: 2, unitPrice: 20 }],
    });
    expect(purchase.status).toBe(201);

    const { poId, poItemId } = await createApprovedPO(supplierId, branchId);
    const grn = await request(app).post("/api/goods-receipts").set(authed(managerToken)).send({
      purchaseOrderId: poId, supplierDocumentNumber: `DUP-D-${Date.now()}`,
      items: [{ purchaseOrderItemId: poItemId, receivedQuantity: 10, acceptedQuantity: 10 }],
    });
    expect(grn.status).toBe(201);
  });

  test("مشترى نقدي بسيط من غير مورد محدد خالص - نفس السلوك القديم بالظبط، مفيش أي تأثير", async () => {
    const purchase = await request(app).post("/api/purchases").set(authed(managerToken)).send({
      branchId, businessDate: "2026-01-01", category: "مباشر", amount: 100,
    });
    expect(purchase.status).toBe(201);
    expect(purchase.body.supplier_id).toBeNull();
  });

  test("نفس المورد ونفس رقم المستند بس في فرع مختلف - مش نفس التوريدة، مفيش blocker", async () => {
    const docNumber = `DUP-BRANCH-${Date.now()}`;
    const purchase1 = await request(app).post("/api/purchases").set(authed(adminToken)).send({
      branchId, businessDate: "2026-01-01", supplierId, supplierDocumentNumber: docNumber,
      items: [{ inventoryItemId: itemId, quantity: 1, unitPrice: 20 }],
    });
    expect(purchase1.status).toBe(201);

    const purchase2 = await request(app).post("/api/purchases").set(authed(adminToken)).send({
      branchId: otherBranchId, businessDate: "2026-01-01", supplierId, supplierDocumentNumber: docNumber,
      items: [{ inventoryItemId: itemId, quantity: 1, unitPrice: 20 }],
    });
    expect(purchase2.status).toBe(201);
  });

  test("مشترى اتراجع (REJECTED) بمورد+رقم مستند معينين - مش بيتحسب كتكرار لأي محاولة تسجيل تاني", async () => {
    const docNumber = `DUP-REJ-${Date.now()}`;
    const purchase = await request(app).post("/api/purchases").set(authed(managerToken)).send({
      branchId, businessDate: getTestDate(), supplierId, supplierDocumentNumber: docNumber,
      items: [{ inventoryItemId: itemId, quantity: 1, unitPrice: 20 }],
    });
    // المدير بيسجل مباشر CONFIRMED - نرفضه يدوي عن طريق تحديث مباشر في القاعدة عشان نختبر سيناريو
    // REJECTED (مفيش مسار API يرفض مشترى CONFIRMED - الرفض بس لمشترى الكاشير PENDING)
    await pool.query("UPDATE purchases SET status = 'REJECTED' WHERE id = $1", [purchase.body.id]);

    const purchase2 = await request(app).post("/api/purchases").set(authed(managerToken)).send({
      branchId, businessDate: getTestDate(), supplierId, supplierDocumentNumber: docNumber,
      items: [{ inventoryItemId: itemId, quantity: 1, unitPrice: 20 }],
    });
    expect(purchase2.status).toBe(201); // المرفوض متعتبرش تكرار حقيقي
  });
});

function getTestDate() {
  return "2026-01-02";
}
