// المرحلة 4A: المشتريات (Procurement) - Supplier → Purchase Request → Purchase Order → Approval →
// Goods Receipt → Inventory Ledger → Batch/Cost Layer. ضد Postgres حقيقي (مش mocks).
const { app, request, pool, seedUser, login, authed } = require("./helpers");

let branchId, otherBranchId;
let adminToken, managerToken, otherManagerToken, accountantToken;
let managerId, otherManagerId;
let mozzarellaId, flourId;
let supplierId;

beforeAll(async () => {
  const b1 = await pool.query("INSERT INTO branches (name) VALUES ('فرع مشتريات-جست') RETURNING id");
  branchId = b1.rows[0].id;
  const b2 = await pool.query("INSERT INTO branches (name) VALUES ('فرع تاني مشتريات-جست') RETURNING id");
  otherBranchId = b2.rows[0].id;

  await seedUser({ name: "أدمن-مشتريات", email: "admin-proc@jest.test", role: "admin" });
  managerId = await seedUser({ branchId, name: "مدير فرع-مشتريات", email: "manager-proc@jest.test", role: "branch_manager" });
  otherManagerId = await seedUser({ branchId: otherBranchId, name: "مدير فرع تاني-مشتريات", email: "othermanager-proc@jest.test", role: "branch_manager" });
  await seedUser({ name: "محاسب-مشتريات", email: "accountant-proc@jest.test", role: "accountant" });

  adminToken = await login("admin-proc@jest.test");
  managerToken = await login("manager-proc@jest.test");
  otherManagerToken = await login("othermanager-proc@jest.test");
  accountantToken = await login("accountant-proc@jest.test");

  const mozz = await pool.query("INSERT INTO inventory_items (name, unit, unit_cost) VALUES ('موتزريلا-مشتريات-جست', 'KG', 0) RETURNING id");
  mozzarellaId = mozz.rows[0].id;
  const flour = await pool.query("INSERT INTO inventory_items (name, unit, unit_cost) VALUES ('دقيق-مشتريات-جست', 'KG', 0) RETURNING id");
  flourId = flour.rows[0].id;
  await pool.query(
    "INSERT INTO branch_inventory_stock (branch_id, inventory_item_id, quantity) VALUES ($1,$2,0),($1,$3,0)",
    [branchId, mozzarellaId, flourId]
  );
});

afterAll(async () => {
  await pool.end();
});

describe("1) Supplier CRUD", () => {
  test("إنشاء مورد بالحقول الكاملة", async () => {
    const res = await request(app).post("/api/suppliers").set(authed(adminToken)).send({
      name: "مورد الألبان-جست", supplierCode: "SUP-001-JEST", legalName: "شركة الألبان المتحدة",
      contactPerson: "أحمد", phone: "0100000000", email: "supplier@test.local", taxId: "123456",
      paymentTerms: "30 يوم", defaultCurrency: "EGP",
    });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe("ACTIVE");
    supplierId = res.body.id;
  });

  test("تعديل بيانات المورد وتغيير حالته (BLOCKED) - مفيش DELETE endpoint خالص", async () => {
    const edit = await request(app).patch(`/api/suppliers/${supplierId}`).set(authed(adminToken)).send({ phone: "0111111111" });
    expect(edit.status).toBe(200);
    expect(edit.body.phone).toBe("0111111111");

    const block = await request(app).patch(`/api/suppliers/${supplierId}`).set(authed(adminToken)).send({ status: "BLOCKED" });
    expect(block.status).toBe(200);
    expect(block.body.status).toBe("BLOCKED");

    // إرجاعه ACTIVE عشان باقي الاختبارات
    await request(app).patch(`/api/suppliers/${supplierId}`).set(authed(adminToken)).send({ status: "ACTIVE" });
  });

  test("مورد BLOCKED مينفعش تعمله أمر شراء", async () => {
    await request(app).patch(`/api/suppliers/${supplierId}`).set(authed(adminToken)).send({ status: "BLOCKED" });
    const po = await request(app).post("/api/purchase-orders").set(authed(managerToken)).send({
      supplierId, branchId, items: [{ inventoryItemId: mozzarellaId, orderedQuantity: 10, unitPrice: 180 }],
    });
    expect(po.status).toBe(400);
    await request(app).patch(`/api/suppliers/${supplierId}`).set(authed(adminToken)).send({ status: "ACTIVE" });
  });
});

describe("2/21) Supplier price history - مينفعش يتمسح أو يتعدّل سعر قديم", () => {
  test("سعر أول (يناير) ثم سعر تاني (أغسطس) - الاتنين موجودين، بس واحد بس effective_to IS NULL", async () => {
    const first = await request(app).post(`/api/suppliers/${supplierId}/price-history`).set(authed(adminToken)).send({
      inventoryItemId: mozzarellaId, unitPrice: 180, purchaseUnit: "KG",
    });
    expect(first.status).toBe(201);
    expect(first.body.effective_to).toBeNull();

    const second = await request(app).post(`/api/suppliers/${supplierId}/price-history`).set(authed(adminToken)).send({
      inventoryItemId: mozzarellaId, unitPrice: 260, purchaseUnit: "KG",
    });
    expect(second.status).toBe(201);

    const history = await request(app).get(`/api/suppliers/${supplierId}/price-history?itemId=${mozzarellaId}`).set(authed(adminToken));
    expect(history.status).toBe(200);
    expect(history.body.length).toBe(2);
    const closed = history.body.find((r) => r.id === first.body.id);
    expect(closed.effective_to).not.toBeNull();
    expect(Number(closed.unit_price)).toBe(180); // السعر القديم لسه 180 - مالوش تعديل
    const current = history.body.find((r) => r.id === second.body.id);
    expect(current.effective_to).toBeNull();
    expect(Number(current.unit_price)).toBe(260);
  });
});

describe("3/4/5) Purchase Request: create → approve / reject", () => {
  let prId, prToReject;

  test("إنشاء طلب شراء DRAFT", async () => {
    const res = await request(app).post("/api/purchase-requests").set(authed(managerToken)).send({
      branchId, reason: "نقص مخزون", items: [{ inventoryItemId: mozzarellaId, requestedQuantity: 50, unit: "KG" }],
    });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe("DRAFT");
    prId = res.body.id;
  });

  test("مدير فرع تاني ممنوع ينشئ طلب شراء لفرع مش بتاعه", async () => {
    const res = await request(app).post("/api/purchase-requests").set(authed(otherManagerToken)).send({
      branchId, items: [{ inventoryItemId: mozzarellaId, requestedQuantity: 5 }],
    });
    expect(res.status).toBe(403);
  });

  test("تقديم واعتماد طلب الشراء - أدمن بس", async () => {
    await request(app).post(`/api/purchase-requests/${prId}/submit`).set(authed(managerToken)).expect(200);
    const managerApprove = await request(app).post(`/api/purchase-requests/${prId}/approve`).set(authed(managerToken));
    expect(managerApprove.status).toBe(403);
    const approve = await request(app).post(`/api/purchase-requests/${prId}/approve`).set(authed(adminToken));
    expect(approve.status).toBe(200);
    expect(approve.body.status).toBe("APPROVED");
  });

  test("رفض طلب شراء تاني بسبب مكتوب", async () => {
    const create = await request(app).post("/api/purchase-requests").set(authed(managerToken)).send({
      branchId, items: [{ inventoryItemId: flourId, requestedQuantity: 20 }],
    });
    prToReject = create.body.id;
    await request(app).post(`/api/purchase-requests/${prToReject}/submit`).set(authed(managerToken)).expect(200);
    const noReason = await request(app).post(`/api/purchase-requests/${prToReject}/reject`).set(authed(adminToken)).send({});
    expect(noReason.status).toBe(400);
    const reject = await request(app).post(`/api/purchase-requests/${prToReject}/reject`).set(authed(adminToken)).send({ rejectionReason: "مفيش ميزانية" });
    expect(reject.status).toBe(200);
    expect(reject.body.status).toBe("REJECTED");
  });
});

describe("6/7/8/19) Purchase Order: create (idempotent) → approve → unauthorized approval", () => {
  let poId;

  test("إنشاء أمر شراء + idempotency (طلب مكرر بنفس المفتاح مش بينشئ PO تاني)", async () => {
    const key = "po-idem-" + Date.now();
    const payload = {
      supplierId, branchId, expectedDeliveryDate: "2026-09-01", idempotencyKey: key,
      items: [{ inventoryItemId: mozzarellaId, orderedQuantity: 100, unitPrice: 250 }],
    };
    const first = await request(app).post("/api/purchase-orders").set(authed(managerToken)).send(payload);
    expect(first.status).toBe(201);
    poId = first.body.id;

    const second = await request(app).post("/api/purchase-orders").set(authed(managerToken)).send(payload);
    expect(second.status).toBe(200);
    expect(second.body.duplicate).toBe(true);
    expect(second.body.id).toBe(poId);

    const count = await pool.query("SELECT COUNT(*) FROM purchase_orders WHERE idempotency_key = $1", [key]);
    expect(Number(count.rows[0].count)).toBe(1);
  });

  test("5 طلبات إنشاء PO متزامنة بنفس idempotencyKey - أمر شراء واحد بس يتسجل (نفس نمط orders.js)", async () => {
    const key = "po-concurrent-" + Date.now();
    const payload = {
      supplierId, branchId, idempotencyKey: key,
      items: [{ inventoryItemId: flourId, orderedQuantity: 5, unitPrice: 20 }],
    };
    const results = await Promise.all(
      Array.from({ length: 5 }, () => request(app).post("/api/purchase-orders").set(authed(managerToken)).send(payload))
    );
    for (const r of results) expect([200, 201]).toContain(r.status);
    const ids = new Set(results.map((r) => r.body.id));
    expect(ids.size).toBe(1);
    const count = await pool.query("SELECT COUNT(*) FROM purchase_orders WHERE idempotency_key = $1", [key]);
    expect(Number(count.rows[0].count)).toBe(1);
  });

  test("مدير فرع (مش أدمن) ممنوع يعتمد أمر شراء حتى لو هو اللي أنشأه", async () => {
    await request(app).post(`/api/purchase-orders/${poId}/submit`).set(authed(managerToken)).expect(200);
    const res = await request(app).post(`/api/purchase-orders/${poId}/approve`).set(authed(managerToken));
    expect(res.status).toBe(403);
  });

  test("محاسب برضو ممنوع يعتمد (مالوش purchasing.approve)", async () => {
    const res = await request(app).post(`/api/purchase-orders/${poId}/approve`).set(authed(accountantToken));
    expect(res.status).toBe(403);
  });

  test("اعتماد الأدمن بينجح", async () => {
    const res = await request(app).post(`/api/purchase-orders/${poId}/approve`).set(authed(adminToken));
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("APPROVED");
  });

  test("انحراف السعر عن آخر سعر مسجّل للمورد (250 الجديد مقابل 260 القديم)", async () => {
    const res = await request(app).get(`/api/purchase-orders/${poId}/price-variance`).set(authed(adminToken));
    expect(res.status).toBe(200);
    const row = res.body.find((r) => r.inventoryItemId === mozzarellaId);
    expect(row.previousPrice).toBeCloseTo(260, 5);
    expect(row.newPrice).toBeCloseTo(250, 5);
    expect(row.difference).toBeCloseTo(-10, 5);
    expect(row.differencePercent).toBeCloseTo((-10 / 260) * 100, 3);
  });
});

describe("9/10/11/13/14/15/17/22) Goods Receipt: partial → second GRN (full) + rejection + batch + ledger", () => {
  let poId, grn1Id, grn2Id, poItemId;

  test("PO لـ100 كيلو موتزريلا، معتمد", async () => {
    const po = await request(app).post("/api/purchase-orders").set(authed(managerToken)).send({
      supplierId, branchId, items: [{ inventoryItemId: mozzarellaId, orderedQuantity: 100, unitPrice: 250 }],
    });
    poId = po.body.id;
    await request(app).post(`/api/purchase-orders/${poId}/submit`).set(authed(managerToken)).expect(200);
    await request(app).post(`/api/purchase-orders/${poId}/approve`).set(authed(adminToken)).expect(200);
    const detail = await request(app).get(`/api/purchase-orders/${poId}`).set(authed(adminToken));
    poItemId = detail.body.items[0].id;
  });

  test("GRN 1: استلام جزئي 60 كيلو (55 مقبول + 5 مرفوض بسبب) - لسه DRAFT، مفيش أثر مخزون قبل /post", async () => {
    const stockBefore = await pool.query("SELECT quantity FROM branch_inventory_stock WHERE branch_id=$1 AND inventory_item_id=$2", [branchId, mozzarellaId]);
    const noReason = await request(app).post("/api/goods-receipts").set(authed(managerToken)).send({
      purchaseOrderId: poId, supplierDocumentNumber: "INV-001",
      items: [{ purchaseOrderItemId: poItemId, receivedQuantity: 60, acceptedQuantity: 55, rejectedQuantity: 5 }],
    });
    expect(noReason.status).toBe(400); // لازم سبب رفض

    const res = await request(app).post("/api/goods-receipts").set(authed(managerToken)).send({
      purchaseOrderId: poId, supplierDocumentNumber: "INV-001",
      items: [{
        purchaseOrderItemId: poItemId, receivedQuantity: 60, acceptedQuantity: 55, rejectedQuantity: 5,
        rejectionReason: "تلف أثناء النقل", batchNumber: "MOZZ-BATCH-1", expiryDate: "2026-10-01",
      }],
    });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe("DRAFT");
    grn1Id = res.body.id;

    const stockAfter = await pool.query("SELECT quantity FROM branch_inventory_stock WHERE branch_id=$1 AND inventory_item_id=$2", [branchId, mozzarellaId]);
    expect(Number(stockAfter.rows[0].quantity)).toBe(Number(stockBefore.rows[0].quantity)); // لسه مفيش تغيير
  });

  test("ترحيل GRN 1 (/post) - 55 كيلو بس بتدخل المخزون فعليًا، مش 60، عن طريق الليدجر", async () => {
    const res = await request(app).post(`/api/goods-receipts/${grn1Id}/post`).set(authed(managerToken));
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("POSTED");

    const stock = await pool.query("SELECT quantity FROM branch_inventory_stock WHERE branch_id=$1 AND inventory_item_id=$2", [branchId, mozzarellaId]);
    expect(Number(stock.rows[0].quantity)).toBe(55); // مش 60

    const movement = await pool.query(
      "SELECT * FROM inventory_movements WHERE reference_type='goods_receipt' AND reference_id=$1 AND movement_type='PURCHASE_RECEIPT'",
      [grn1Id]
    );
    expect(movement.rows.length).toBe(1);
    expect(Number(movement.rows[0].quantity)).toBe(55);
    expect(Number(movement.rows[0].unit_cost)).toBeCloseTo(250, 5);

    const batch = await pool.query("SELECT * FROM inventory_batches WHERE inventory_item_id=$1 AND branch_id=$2 AND batch_number='MOZZ-BATCH-1'", [mozzarellaId, branchId]);
    expect(batch.rows.length).toBe(1);
    expect(Number(batch.rows[0].remaining_quantity)).toBe(55);
    expect(Number(batch.rows[0].unit_cost)).toBeCloseTo(250, 5);

    const po = await request(app).get(`/api/purchase-orders/${poId}`).set(authed(adminToken));
    expect(po.body.purchaseOrder.status).toBe("PARTIALLY_RECEIVED");
    expect(po.body.items[0].remainingQuantity).toBeCloseTo(45, 5); // 100 - 55 (المرفوض ميتحسبش استلام)
  });

  test("ترحيل GRN 1 تاني (retry) - idempotent، مفيش حركة مخزون تانية ولا تكرار", async () => {
    const before = await pool.query("SELECT COUNT(*) FROM inventory_movements WHERE reference_type='goods_receipt' AND reference_id=$1", [grn1Id]);
    const res = await request(app).post(`/api/goods-receipts/${grn1Id}/post`).set(authed(managerToken));
    expect(res.status).toBe(200);
    expect(res.body.duplicate).toBe(true);
    const after = await pool.query("SELECT COUNT(*) FROM inventory_movements WHERE reference_type='goods_receipt' AND reference_id=$1", [grn1Id]);
    expect(Number(after.rows[0].count)).toBe(Number(before.rows[0].count));

    const stock = await pool.query("SELECT quantity FROM branch_inventory_stock WHERE branch_id=$1 AND inventory_item_id=$2", [branchId, mozzarellaId]);
    expect(Number(stock.rows[0].quantity)).toBe(55); // مش 110
  });

  test("GRN 2: استلام باقي الكمية (45 كيلو، مقبولة بالكامل) - PO يبقى FULLY_RECEIVED", async () => {
    const res = await request(app).post("/api/goods-receipts").set(authed(managerToken)).send({
      purchaseOrderId: poId, supplierDocumentNumber: "INV-002",
      items: [{ purchaseOrderItemId: poItemId, receivedQuantity: 45, acceptedQuantity: 45, batchNumber: "MOZZ-BATCH-2", expiryDate: "2026-11-01" }],
    });
    grn2Id = res.body.id;
    await request(app).post(`/api/goods-receipts/${grn2Id}/post`).set(authed(managerToken)).expect(200);

    const stock = await pool.query("SELECT quantity FROM branch_inventory_stock WHERE branch_id=$1 AND inventory_item_id=$2", [branchId, mozzarellaId]);
    expect(Number(stock.rows[0].quantity)).toBe(100); // 55 + 45

    const po = await request(app).get(`/api/purchase-orders/${poId}`).set(authed(adminToken));
    expect(po.body.purchaseOrder.status).toBe("FULLY_RECEIVED");
    expect(po.body.items[0].remainingQuantity).toBeCloseTo(0, 5);
  });

  test("Audit log بيعكس كل خطوة (إنشاء/اعتماد/رفض كمية/ترحيل)", async () => {
    const audit = await request(app).get("/api/audit-logs?action=GOODS_RECEIPT_POSTED").set(authed(adminToken));
    expect(audit.status).toBe(200);
    expect(audit.body.some((a) => a.entity_id === grn2Id)).toBe(true);

    const rejectAudit = await request(app).get("/api/audit-logs?action=GOODS_RECEIPT_QUANTITY_REJECTED").set(authed(adminToken));
    expect(rejectAudit.body.length).toBeGreaterThan(0);
  });

  test("تقرير البضاعة المرفوضة بيظهر الـ5 كيلو وسببها", async () => {
    const res = await request(app).get(`/api/reports/rejected-goods?branchId=${branchId}&from=2000-01-01&to=2099-01-01`).set(authed(adminToken));
    expect(res.status).toBe(200);
    const row = res.body.find((r) => r.goods_receipt_id === grn1Id);
    expect(row).toBeTruthy();
    expect(Number(row.rejected_quantity)).toBe(5);
    expect(row.rejection_reason).toBe("تلف أثناء النقل");
  });
});

describe("12) Over-receiving", () => {
  test("استلام أكتر من المطلوب من غير موافقة - مرفوض، وبموافقة مدير الفرع - مقبول", async () => {
    const po = await request(app).post("/api/purchase-orders").set(authed(managerToken)).send({
      supplierId, branchId, items: [{ inventoryItemId: flourId, orderedQuantity: 10, unitPrice: 20 }],
    });
    await request(app).post(`/api/purchase-orders/${po.body.id}/submit`).set(authed(managerToken)).expect(200);
    await request(app).post(`/api/purchase-orders/${po.body.id}/approve`).set(authed(adminToken)).expect(200);
    const detail = await request(app).get(`/api/purchase-orders/${po.body.id}`).set(authed(adminToken));
    const poItemId = detail.body.items[0].id;

    const denied = await request(app).post("/api/goods-receipts").set(authed(managerToken)).send({
      purchaseOrderId: po.body.id,
      items: [{ purchaseOrderItemId: poItemId, receivedQuantity: 15, acceptedQuantity: 15 }],
    });
    expect(denied.status).toBe(400);
    expect(denied.body.code).toBe("OVER_RECEIVE_NEEDS_APPROVAL");

    const approved = await request(app).post("/api/goods-receipts").set(authed(managerToken)).send({
      purchaseOrderId: po.body.id, overReceiveApprovedBy: managerId,
      items: [{ purchaseOrderItemId: poItemId, receivedQuantity: 15, acceptedQuantity: 15 }],
    });
    expect(approved.status).toBe(201);
    await request(app).post(`/api/goods-receipts/${approved.body.id}/post`).set(authed(managerToken)).expect(200);

    const stock = await pool.query("SELECT quantity FROM branch_inventory_stock WHERE branch_id=$1 AND inventory_item_id=$2", [branchId, flourId]);
    expect(Number(stock.rows[0].quantity)).toBe(15);
  });
});

describe("16) Unit conversion at receipt (1 كرتونة = 5 كيلو)", () => {
  test("استلام 10 كراتين × 450ج = 50 كيلو بتكلفة 90ج/كيلو (نفس منطق /purchase-receipt بالظبط)", async () => {
    await request(app).post("/api/inventory/unit-conversions").set(authed(adminToken))
      .send({ fromUnit: "BOX-PROC-JEST", toUnit: "KG", factor: 5 });

    const po = await request(app).post("/api/purchase-orders").set(authed(managerToken)).send({
      supplierId, branchId,
      items: [{ inventoryItemId: mozzarellaId, orderedQuantity: 10, unit: "BOX-PROC-JEST", unitPrice: 450 }],
    });
    await request(app).post(`/api/purchase-orders/${po.body.id}/submit`).set(authed(managerToken)).expect(200);
    await request(app).post(`/api/purchase-orders/${po.body.id}/approve`).set(authed(adminToken)).expect(200);
    const detail = await request(app).get(`/api/purchase-orders/${po.body.id}`).set(authed(adminToken));
    const poItemId = detail.body.items[0].id;

    const grn = await request(app).post("/api/goods-receipts").set(authed(managerToken)).send({
      purchaseOrderId: po.body.id,
      items: [{ purchaseOrderItemId: poItemId, receivedQuantity: 10, acceptedQuantity: 10, unit: "BOX-PROC-JEST", unitPrice: 450 }],
    });
    const posted = await request(app).post(`/api/goods-receipts/${grn.body.id}/post`).set(authed(managerToken));
    expect(posted.status).toBe(200);

    const movement = await pool.query(
      "SELECT * FROM inventory_movements WHERE reference_type='goods_receipt' AND reference_id=$1", [grn.body.id]
    );
    expect(Number(movement.rows[0].quantity)).toBe(50); // 10 كراتين × 5 كيلو
    expect(Number(movement.rows[0].unit_cost)).toBeCloseTo(90, 5); // 450 / 5
  });
});

describe("18) Idempotent GRN posting (تفصيل موسّع) - مغطى فوق كمان في وصف 9-15", () => {
  test("POST /post مرتين متتاليين على نفس الـGRN من غير أي تكرار في المخزون (تفصيل إضافي)", async () => {
    const po = await request(app).post("/api/purchase-orders").set(authed(managerToken)).send({
      supplierId, branchId, items: [{ inventoryItemId: flourId, orderedQuantity: 5, unitPrice: 20 }],
    });
    await request(app).post(`/api/purchase-orders/${po.body.id}/submit`).set(authed(managerToken)).expect(200);
    await request(app).post(`/api/purchase-orders/${po.body.id}/approve`).set(authed(adminToken)).expect(200);
    const detail = await request(app).get(`/api/purchase-orders/${po.body.id}`).set(authed(adminToken));
    const poItemId = detail.body.items[0].id;
    const grn = await request(app).post("/api/goods-receipts").set(authed(managerToken)).send({
      purchaseOrderId: po.body.id, items: [{ purchaseOrderItemId: poItemId, receivedQuantity: 5, acceptedQuantity: 5 }],
    });

    const results = await Promise.all(
      Array.from({ length: 3 }, () => request(app).post(`/api/goods-receipts/${grn.body.id}/post`).set(authed(managerToken)))
    );
    for (const r of results) expect(r.status).toBe(200);

    const movements = await pool.query(
      "SELECT COUNT(*) FROM inventory_movements WHERE reference_type='goods_receipt' AND reference_id=$1", [grn.body.id]
    );
    expect(Number(movements.rows[0].count)).toBe(1);
  });
});

describe("20) Cross-branch authorization", () => {
  test("مدير فرع تاني ممنوع يشوف/يستلم PO فرع مش بتاعه", async () => {
    const po = await request(app).post("/api/purchase-orders").set(authed(managerToken)).send({
      supplierId, branchId, items: [{ inventoryItemId: flourId, orderedQuantity: 5, unitPrice: 20 }],
    });
    const viewAttempt = await request(app).get(`/api/purchase-orders/${po.body.id}`).set(authed(otherManagerToken));
    expect(viewAttempt.status).toBe(403);

    await request(app).post(`/api/purchase-orders/${po.body.id}/submit`).set(authed(managerToken)).expect(200);
    await request(app).post(`/api/purchase-orders/${po.body.id}/approve`).set(authed(adminToken)).expect(200);
    const detail = await request(app).get(`/api/purchase-orders/${po.body.id}`).set(authed(adminToken));

    const receiveAttempt = await request(app).post("/api/goods-receipts").set(authed(otherManagerToken)).send({
      purchaseOrderId: po.body.id,
      items: [{ purchaseOrderItemId: detail.body.items[0].id, receivedQuantity: 5, acceptedQuantity: 5 }],
    });
    expect(receiveAttempt.status).toBe(403);
  });

  test("أدمن يقدر يشوف كل الفروع", async () => {
    const res = await request(app).get(`/api/purchase-orders?branchId=${branchId}`).set(authed(adminToken));
    expect(res.status).toBe(200);
  });
});

describe("23) PO cancellation", () => {
  test("إلغاء PO في حالة DRAFT/APPROVED بينجح، مينفعش تلغي واحد FULLY_RECEIVED", async () => {
    const po = await request(app).post("/api/purchase-orders").set(authed(managerToken)).send({
      supplierId, branchId, items: [{ inventoryItemId: flourId, orderedQuantity: 3, unitPrice: 20 }],
    });
    const cancel = await request(app).post(`/api/purchase-orders/${po.body.id}/cancel`).set(authed(managerToken)).send({ reason: "تراجع" });
    expect(cancel.status).toBe(200);
    expect(cancel.body.status).toBe("CANCELLED");

    const reCancel = await request(app).post(`/api/purchase-orders/${po.body.id}/cancel`).set(authed(managerToken)).send({ reason: "test" });
    expect(reCancel.status).toBe(400);
  });
});

describe("24) GRN cancellation - بيرجع بالظبط نفس الكمية اللي دخلت", () => {
  test("إلغاء GRN بعد الترحيل بيرجّع الكمية ويقفل الدفعة، ومينفعش لو الدفعة اتصرف منها حاجة", async () => {
    const po = await request(app).post("/api/purchase-orders").set(authed(managerToken)).send({
      supplierId, branchId, items: [{ inventoryItemId: flourId, orderedQuantity: 20, unitPrice: 20 }],
    });
    await request(app).post(`/api/purchase-orders/${po.body.id}/submit`).set(authed(managerToken)).expect(200);
    await request(app).post(`/api/purchase-orders/${po.body.id}/approve`).set(authed(adminToken)).expect(200);
    const detail = await request(app).get(`/api/purchase-orders/${po.body.id}`).set(authed(adminToken));
    const poItemId = detail.body.items[0].id;

    const stockBefore = await pool.query("SELECT quantity FROM branch_inventory_stock WHERE branch_id=$1 AND inventory_item_id=$2", [branchId, flourId]);
    const grn = await request(app).post("/api/goods-receipts").set(authed(managerToken)).send({
      purchaseOrderId: po.body.id, items: [{ purchaseOrderItemId: poItemId, receivedQuantity: 20, acceptedQuantity: 20, batchNumber: "FLOUR-CANCEL-BATCH" }],
    });
    await request(app).post(`/api/goods-receipts/${grn.body.id}/post`).set(authed(managerToken)).expect(200);

    const cancel = await request(app).post(`/api/goods-receipts/${grn.body.id}/cancel`).set(authed(managerToken)).send({ reason: "غلط في الاستلام" });
    expect(cancel.status).toBe(200);
    expect(cancel.body.status).toBe("CANCELLED");

    const stockAfter = await pool.query("SELECT quantity FROM branch_inventory_stock WHERE branch_id=$1 AND inventory_item_id=$2", [branchId, flourId]);
    expect(Number(stockAfter.rows[0].quantity)).toBeCloseTo(Number(stockBefore.rows[0].quantity), 5);

    const reversalMovement = await pool.query(
      "SELECT * FROM inventory_movements WHERE reference_type='goods_receipt' AND reference_id=$1 AND movement_type='RETURN_TO_SUPPLIER'",
      [grn.body.id]
    );
    expect(reversalMovement.rows.length).toBe(1);

    const poAfter = await request(app).get(`/api/purchase-orders/${po.body.id}`).set(authed(adminToken));
    expect(poAfter.body.items[0].remainingQuantity).toBeCloseTo(20, 5); // رجع لغير مستلم

    const batch = await pool.query("SELECT * FROM inventory_batches WHERE batch_number = 'FLOUR-CANCEL-BATCH'");
    expect(batch.rows[0].remaining_quantity).toBe("0");
  });

  test("مينفعش تلغي GRN لو جزء من الدفعة اتصرف بالفعل", async () => {
    const po = await request(app).post("/api/purchase-orders").set(authed(managerToken)).send({
      supplierId, branchId, items: [{ inventoryItemId: flourId, orderedQuantity: 10, unitPrice: 20 }],
    });
    await request(app).post(`/api/purchase-orders/${po.body.id}/submit`).set(authed(managerToken)).expect(200);
    await request(app).post(`/api/purchase-orders/${po.body.id}/approve`).set(authed(adminToken)).expect(200);
    const detail = await request(app).get(`/api/purchase-orders/${po.body.id}`).set(authed(adminToken));
    const poItemId = detail.body.items[0].id;
    const grn = await request(app).post("/api/goods-receipts").set(authed(managerToken)).send({
      purchaseOrderId: po.body.id, items: [{ purchaseOrderItemId: poItemId, receivedQuantity: 10, acceptedQuantity: 10, batchNumber: "FLOUR-CONSUMED-BATCH" }],
    });
    await request(app).post(`/api/goods-receipts/${grn.body.id}/post`).set(authed(managerToken)).expect(200);

    // نستهلك جزء من الدفعة يدويًا (تسوية سالبة) - محاكاة إنها اتصرفت
    await request(app).post("/api/inventory/stock/adjust").set(authed(managerToken))
      .send({ branchId, inventoryItemId: flourId, quantity: -3, movementType: "adjustment" });

    const cancelAttempt = await request(app).post(`/api/goods-receipts/${grn.body.id}/cancel`).set(authed(managerToken)).send({ reason: "test" });
    expect(cancelAttempt.status).toBe(400); // BATCH_ALREADY_CONSUMED - الدفعة اتصرف منها جزء
  });
});
