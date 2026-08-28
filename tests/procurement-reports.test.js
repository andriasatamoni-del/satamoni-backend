// Procurement v2 STEP K: تقارير جديدة فوق الميزات المبنية في D-J.
const { app, request, pool, seedUser, login, authed } = require("./helpers");

let branchId, ckBranchId;
let adminToken, managerToken, ckManagerToken, otherManagerToken;
let itemAId, itemBId;
let supplierId;

beforeAll(async () => {
  const b1 = await pool.query("INSERT INTO branches (name) VALUES ('فرع تقارير-جست') RETURNING id");
  branchId = b1.rows[0].id;
  const ck = await pool.query("INSERT INTO branches (name, is_central_kitchen) VALUES ('سنتر كيتشن-تقارير-جست', TRUE) RETURNING id");
  ckBranchId = ck.rows[0].id;
  const b2 = await pool.query("INSERT INTO branches (name) VALUES ('فرع تاني تقارير-جست') RETURNING id");

  await seedUser({ name: "أدمن-تقارير", email: "admin-procreports@jest.test", role: "admin" });
  await seedUser({ branchId, name: "مدير فرع-تقارير", email: "manager-procreports@jest.test", role: "branch_manager" });
  await seedUser({ branchId: ckBranchId, name: "مدير سنتر كيتشن-تقارير", email: "ck-procreports@jest.test", role: "branch_manager" });
  await seedUser({ branchId: b2.rows[0].id, name: "مدير فرع تاني-تقارير", email: "othermanager-procreports@jest.test", role: "branch_manager" });

  adminToken = await login("admin-procreports@jest.test");
  managerToken = await login("manager-procreports@jest.test");
  ckManagerToken = await login("ck-procreports@jest.test");
  otherManagerToken = await login("othermanager-procreports@jest.test");

  const a = await pool.query("INSERT INTO inventory_items (name, unit, unit_cost) VALUES ('صنف أ-تقارير-جست', 'KG', 10) RETURNING id");
  itemAId = a.rows[0].id;
  const bItem = await pool.query("INSERT INTO inventory_items (name, unit, unit_cost) VALUES ('صنف ب-تقارير-جست', 'KG', 5) RETURNING id");
  itemBId = bItem.rows[0].id;
  await pool.query(
    "INSERT INTO branch_inventory_stock (branch_id, inventory_item_id, quantity) VALUES ($1,$2,3),($1,$3,1000),($4,$2,0),($4,$3,0)",
    [ckBranchId, itemAId, itemBId, branchId]
  );

  const supplier = await request(app).post("/api/suppliers").set(authed(adminToken)).send({ name: "مورد تقارير-جست" });
  supplierId = supplier.body.id;
});

afterAll(async () => {
  await pool.end();
});

describe("GET /api/reports/requisition-fulfillment", () => {
  test("طلبية واحدة FULL وواحدة PARTIAL - الملخص والتفصيل صح", async () => {
    const today = new Date().toISOString().slice(0, 10);

    const order1 = await request(app).post("/api/kitchen-orders").set(authed(managerToken)).send({
      branchId, status: "DRAFT", items: [{ inventoryItemId: itemBId, quantityRequested: 5 }],
    });
    await request(app).post(`/api/kitchen-orders/${order1.body.orderId}/submit`).set(authed(managerToken)).expect(200);
    await request(app).post(`/api/kitchen-orders/${order1.body.orderId}/approve`).set(authed(ckManagerToken)).expect(200);
    await request(app).post(`/api/kitchen-orders/${order1.body.orderId}/picking`).set(authed(ckManagerToken)).send({
      items: [{ inventoryItemId: itemBId, quantityToPrepare: 5 }],
    }).expect(200);

    const order2 = await request(app).post("/api/kitchen-orders").set(authed(managerToken)).send({
      branchId, status: "DRAFT", items: [{ inventoryItemId: itemAId, quantityRequested: 10 }],
    });
    await request(app).post(`/api/kitchen-orders/${order2.body.orderId}/submit`).set(authed(managerToken)).expect(200);
    await request(app).post(`/api/kitchen-orders/${order2.body.orderId}/approve`).set(authed(ckManagerToken)).expect(200);
    await request(app).post(`/api/kitchen-orders/${order2.body.orderId}/picking`).set(authed(ckManagerToken)).send({
      items: [{ inventoryItemId: itemAId, quantityToPrepare: 3 }],
    }).expect(200);

    const res = await request(app).get(`/api/reports/requisition-fulfillment?from=${today}&to=${today}&branchId=${branchId}`).set(authed(managerToken));
    expect(res.status).toBe(200);
    expect(res.body.summary.FULL).toBeGreaterThanOrEqual(1);
    expect(res.body.summary.PARTIAL).toBeGreaterThanOrEqual(1);
    const o1 = res.body.orders.find((o) => o.id === order1.body.orderId);
    expect(o1.itemFulfillment.FULL.count).toBe(1);
    const o2 = res.body.orders.find((o) => o.id === order2.body.orderId);
    expect(o2.itemFulfillment.PARTIAL.count).toBe(1);
  });

  test("فرع تاني ممنوع يشوف تقرير فرع مش بتاعه (بيتقيّد أوتوماتيك بفرعه هو)", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const res = await request(app).get(`/api/reports/requisition-fulfillment?from=${today}&to=${today}&branchId=${branchId}`).set(authed(otherManagerToken));
    expect(res.status).toBe(200);
    expect(res.body.orders.every((o) => o.branch_id !== branchId)).toBe(true);
  });
});

describe("GET /api/reports/transfer-discrepancies", () => {
  test("فرق SHORTAGE متراجع (RESOLVED) - القيمة المرحّلة فعليًا بتظهر في totalWriteOffValue", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const reqRes = await request(app).post("/api/kitchen-transfers/request").set(authed(ckManagerToken)).send({
      fromBranchId: ckBranchId, toBranchId: branchId, businessDate: today, items: [{ inventoryItemId: itemBId, quantity: 20 }],
    });
    const transferId = reqRes.body.id;
    await request(app).post(`/api/kitchen-transfers/${transferId}/approve`).set(authed(adminToken)).expect(200);
    await request(app).post(`/api/kitchen-transfers/${transferId}/issue`).set(authed(ckManagerToken)).expect(200);
    await request(app).post(`/api/kitchen-transfers/${transferId}/receive`).set(authed(managerToken)).send({
      items: [{ inventoryItemId: itemBId, quantityReceived: 20 }],
    }).expect(200);

    const disc = await request(app).post(`/api/kitchen-transfers/${transferId}/discrepancies`).set(authed(managerToken)).send({
      items: [{ inventoryItemId: itemBId, discrepancyType: "SHORTAGE", quantity: 4 }],
    });
    const discId = disc.body[0].id;
    await request(app).post(`/api/kitchen-transfers/${transferId}/discrepancies/${discId}/resolve`).set(authed(managerToken)).send({ action: "RESOLVE" }).expect(200);

    const res = await request(app).get(`/api/reports/transfer-discrepancies?from=${today}&to=${today}&branchId=${branchId}`).set(authed(managerToken));
    expect(res.status).toBe(200);
    const shortageResolved = res.body.byTypeAndStatus.find((r) => r.discrepancy_type === "SHORTAGE" && r.status === "RESOLVED");
    expect(shortageResolved).toBeDefined();
    expect(shortageResolved.total_quantity).toBeGreaterThanOrEqual(4);
    expect(res.body.totalWriteOffValue).toBeGreaterThanOrEqual(4 * 5); // 4 كيلو * تكلفة الوحدة 5
  });
});

describe("GET /api/reports/manufacturing-variance", () => {
  test("أمر تصنيع بفرق ناتج وفرق استهلاك حقيقي - ظاهرين في التقرير بالكامل", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const mfgItem = await pool.query(
      "INSERT INTO inventory_items (name, unit, unit_cost, item_type) VALUES ('منتج تقارير-جست', 'unit', NULL, 'manufactured') RETURNING id"
    );
    const mfgItemId = mfgItem.rows[0].id;
    await pool.query("INSERT INTO branch_inventory_stock (branch_id, inventory_item_id, quantity) VALUES ($1,$2,0)", [ckBranchId, mfgItemId]);

    const recipe = await request(app).post("/api/recipes").set(authed(adminToken)).send({
      recipeType: "manufactured_item", inventoryItemId: mfgItemId, yieldQuantity: 1, yieldUnit: "unit",
      ingredients: [{ ingredientItemId: itemBId, quantity: 2 }],
    });
    const versionId = recipe.body.version.id;
    await request(app).post(`/api/recipes/versions/${versionId}/submit`).set(authed(ckManagerToken)).expect(200);
    await request(app).post(`/api/recipes/versions/${versionId}/approve`).set(authed(adminToken)).expect(200);
    await request(app).post(`/api/recipes/versions/${versionId}/activate`).set(authed(adminToken)).expect(200);
    const recipeId = (await pool.query("SELECT recipe_id FROM recipe_versions WHERE id = $1", [versionId])).rows[0].recipe_id;

    const order = await request(app).post("/api/production").set(authed(ckManagerToken)).send({
      branchId: ckBranchId, recipeId, plannedQuantity: 1,
    });
    await request(app).post(`/api/production/${order.body.id}/approve`).set(authed(adminToken)).expect(200);
    await request(app).post(`/api/production/${order.body.id}/start`).set(authed(ckManagerToken)).send({
      actualConsumption: [{ inventoryItemId: itemBId, actualQuantity: 3, varianceReason: "زيادة استهلاك" }],
    }).expect(200);
    await request(app).post(`/api/production/${order.body.id}/complete`).set(authed(ckManagerToken)).send({
      actualQuantity: 2, varianceReason: "ناتج أعلى من المخطط",
    }).expect(200);

    const res = await request(app).get(`/api/reports/manufacturing-variance?from=${today}&to=${today}&branchId=${ckBranchId}`).set(authed(ckManagerToken));
    expect(res.status).toBe(200);
    const row = res.body.orders.find((o) => o.id === order.body.id);
    expect(row).toBeDefined();
    expect(row.output_variance_percent).toBeCloseTo(100, 5); // (2-1)/1 * 100
    expect(row.inputVariance.planned).toBeCloseTo(2, 5);
    expect(row.inputVariance.actual).toBeCloseTo(3, 5);
    expect(row.inputVariance.variance).toBeCloseTo(1, 5);
  });
});

describe("GET /api/reports/supplier-invoice-variance", () => {
  test("فاتورة فيها فرق - ظاهرة في القايمة والتجميع حسب المورد", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const invoice = await request(app).post("/api/supplier-invoices").set(authed(managerToken)).send({
      supplierId, branchId, supplierInvoiceNumber: "INV-REPORT-001", invoiceDate: today,
      lines: [{ inventoryItemId: itemAId, invoicedQuantity: 2, unitPrice: 50 }],
    });
    expect(invoice.status).toBe(201);
    await request(app).post(`/api/supplier-invoices/${invoice.body.id}/approve`).set(authed(adminToken)).expect(200);

    const res = await request(app).get(`/api/reports/supplier-invoice-variance?from=${today}&to=${today}&supplierId=${supplierId}`).set(authed(managerToken));
    expect(res.status).toBe(200);
    const found = res.body.invoices.find((i) => i.id === invoice.body.id);
    expect(found).toBeDefined();
    expect(found.variance_amount).toBeCloseTo(100, 5);
    const bySupplier = res.body.bySupplier.find((s) => s.supplier_id === supplierId);
    expect(bySupplier.invoice_count).toBeGreaterThanOrEqual(1);
    expect(bySupplier.total_variance).toBeGreaterThanOrEqual(100);
  });
});
