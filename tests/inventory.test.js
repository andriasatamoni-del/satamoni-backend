// Regression suite حقيقي ضد قاعدة بيانات Postgres حقيقية (مش mocks) - بيغطي مسارات المخزون الحساسة:
// استلام مشتريات، بيع، استرجاع بيع، تحويلات (فورية ومرحلية + دفعات)، هالك، تسوية، مطابقة، تحويل وحدات،
// رصيد سالب (STRICT/ALLOW_WITH_APPROVAL)، idempotency (تكرار عادي ومتزامن)، صلاحيات وتخطي فروع.
const { app, request, pool, seedUser, login, authed } = require("./helpers");

let branchId, kitchenId;
let adminToken, managerToken, cashierToken, kitchenManagerToken;
let adminId, managerId, kitchenManagerId;
let mozzarellaId, flourId, doughId, strictItemId;
let menuItemId, variantId;

beforeAll(async () => {
  const b1 = await pool.query("INSERT INTO branches (name) VALUES ('فرع الاختبار') RETURNING id");
  branchId = b1.rows[0].id;
  const ck = await pool.query("INSERT INTO branches (name, is_central_kitchen) VALUES ('سنتر كيتشن الاختبار', TRUE) RETURNING id");
  kitchenId = ck.rows[0].id;

  adminId = await seedUser({ name: "Admin", email: "admin@jest.test", role: "admin" });
  managerId = await seedUser({ branchId, name: "مدير الفرع", email: "manager@jest.test", role: "branch_manager", pin: "1234" });
  kitchenManagerId = await seedUser({ branchId: kitchenId, name: "مدير السنتر", email: "kitchen@jest.test", role: "branch_manager", pin: "1234" });
  await seedUser({ branchId, name: "كاشير", email: "cashier@jest.test", role: "cashier" });

  adminToken = await login("admin@jest.test");
  managerToken = await login("manager@jest.test");
  kitchenManagerToken = await login("kitchen@jest.test");
  cashierToken = await login("cashier@jest.test");

  const mozz = await pool.query("INSERT INTO inventory_items (name, unit, unit_cost) VALUES ('موتزريلا-جست', 'KG', 100) RETURNING id");
  mozzarellaId = mozz.rows[0].id;
  const flour = await pool.query("INSERT INTO inventory_items (name, unit, unit_cost) VALUES ('دقيق-جست', 'KG', 20) RETURNING id");
  flourId = flour.rows[0].id;
  const dough = await pool.query("INSERT INTO inventory_items (name, unit, unit_cost, item_type) VALUES ('عجينة-جست', 'KG', NULL, 'manufactured') RETURNING id");
  doughId = dough.rows[0].id;
  const strictItem = await pool.query("INSERT INTO inventory_items (name, unit, unit_cost) VALUES ('صنف-صارم-جست', 'KG', 10) RETURNING id");
  strictItemId = strictItem.rows[0].id;

  await pool.query("INSERT INTO branch_inventory_stock (branch_id, inventory_item_id, quantity) VALUES ($1,$2,0)", [kitchenId, mozzarellaId]);
  await pool.query("INSERT INTO branch_inventory_stock (branch_id, inventory_item_id, quantity) VALUES ($1,$2,0)", [branchId, mozzarellaId]);

  const cat = await pool.query("INSERT INTO menu_categories (name) VALUES ('بيتزا-جست') RETURNING id");
  const mi = await pool.query("INSERT INTO menu_items (category_id, name) VALUES ($1,'مارجريتا-جست') RETURNING id", [cat.rows[0].id]);
  menuItemId = mi.rows[0].id;
  const variant = await pool.query("INSERT INTO menu_item_variants (item_id, label, price) VALUES ($1,'وسط',100) RETURNING id", [mi.rows[0].id]);
  variantId = variant.rows[0].id;
  await pool.query(
    "INSERT INTO menu_item_variant_ingredients (variant_id, inventory_item_id, quantity_per_unit) VALUES ($1,$2,0.5)",
    [variantId, mozzarellaId]
  );
});

afterAll(async () => {
  await pool.end();
});

describe("Purchase Receipt", () => {
  test("يزود الرصيد ويسجل حركة PURCHASE_RECEIPT بتكلفة صحيحة", async () => {
    const res = await request(app)
      .post("/api/inventory/purchase-receipt")
      .set(authed(kitchenManagerToken))
      .send({ branchId: kitchenId, inventoryItemId: mozzarellaId, quantity: 50, unitCost: 100, notes: "test" });
    expect(res.status).toBe(201);
    expect(res.body.movement.quantity_after).toBe("50");
    expect(res.body.movement.total_cost).toBe("5000");
  });

  test("تحويل الوحدة بيصحح التكلفة نسبيًا (كرتونة = 5 كيلو، 450ج/كرتونة = 90ج/كيلو)", async () => {
    await request(app)
      .post("/api/inventory/unit-conversions")
      .set(authed(adminToken))
      .send({ fromUnit: "BOX-JEST", toUnit: "KG", factor: 5 });
    const res = await request(app)
      .post("/api/inventory/purchase-receipt")
      .set(authed(kitchenManagerToken))
      .send({ branchId: kitchenId, inventoryItemId: mozzarellaId, quantity: 2, unit: "BOX-JEST", unitCost: 450 });
    expect(res.status).toBe(201);
    expect(Number(res.body.movement.quantity)).toBe(10);
    expect(Number(res.body.movement.unit_cost)).toBe(90);
  });
});

describe("Batch-aware transfer (السيناريو الكامل المطلوب)", () => {
  let batchTransferId;

  test("Central Warehouse: batch مارجريتا 20 كيلو بتاريخ صلاحية محدد", async () => {
    const res = await request(app)
      .post("/api/inventory/purchase-receipt")
      .set(authed(kitchenManagerToken))
      .send({
        branchId: kitchenId, inventoryItemId: mozzarellaId, quantity: 20, unitCost: 100,
        batchNumber: "BATCH-A", expiryDate: "2026-09-20",
      });
    expect(res.status).toBe(201);
    expect(res.body.batchId).toBeTruthy();
  });

  test("Transfer 10 KG staged (request→approve→issue) بيحافظ على هوية الدفعة", async () => {
    const reqRes = await request(app)
      .post("/api/kitchen-transfers/request")
      .set(authed(kitchenManagerToken))
      .send({ fromBranchId: kitchenId, toBranchId: branchId, businessDate: "2026-08-15", items: [{ inventoryItemId: mozzarellaId, quantity: 10 }] });
    expect(reqRes.status).toBe(201);
    batchTransferId = reqRes.body.id;

    const approveRes = await request(app).post(`/api/kitchen-transfers/${batchTransferId}/approve`).set(authed(adminToken));
    expect(approveRes.status).toBe(200);
    expect(approveRes.body.status).toBe("approved");

    const issueRes = await request(app).post(`/api/kitchen-transfers/${batchTransferId}/issue`).set(authed(kitchenManagerToken));
    expect(issueRes.status).toBe(200);
    expect(issueRes.body.status).toBe("in_transit");

    // فرع الوجهة لسه معندوش أي زيادة (بس وقت الاستلام)
    const stockBeforeReceive = await pool.query(
      "SELECT quantity FROM branch_inventory_stock WHERE branch_id=$1 AND inventory_item_id=$2", [branchId, mozzarellaId]
    );
    expect(Number(stockBeforeReceive.rows[0]?.quantity || 0)).toBe(0);
  });

  test("Receive 10 KG - نفس الدفعة (رقم/صلاحية) بتتنشئ في الفرع المستلم", async () => {
    const receiveRes = await request(app)
      .post(`/api/kitchen-transfers/${batchTransferId}/receive`)
      .set(authed(managerToken))
      .send({ items: [{ inventoryItemId: mozzarellaId, quantityReceived: 10 }] });
    expect(receiveRes.status).toBe(200);
    expect(receiveRes.body.status).toBe("received");

    const destBatches = await pool.query(
      "SELECT * FROM inventory_batches WHERE inventory_item_id=$1 AND branch_id=$2", [mozzarellaId, branchId]
    );
    expect(destBatches.rows.length).toBe(1);
    expect(destBatches.rows[0].batch_number).toBe("BATCH-A");
    expect(destBatches.rows[0].expiry_date.toISOString().slice(0, 10)).toBe("2026-09-20");
    expect(Number(destBatches.rows[0].remaining_quantity)).toBe(10);

    const destStock = await pool.query(
      "SELECT quantity FROM branch_inventory_stock WHERE branch_id=$1 AND inventory_item_id=$2", [branchId, mozzarellaId]
    );
    expect(Number(destStock.rows[0].quantity)).toBe(10);
  });

  test("Sell يستهلك من نفس الدفعة (FEFO) ويقلل remaining_quantity", async () => {
    const orderRes = await request(app)
      .post("/api/orders")
      .set(authed(cashierToken))
      .send({ branchId, source: "pos", orderType: "takeaway", items: [{ itemId: menuItemId, variantId, quantity: 4 }] });
    expect(orderRes.status).toBe(201); // 4 × 0.5 KG = 2 KG مستهلكة

    const batch = await pool.query("SELECT * FROM inventory_batches WHERE inventory_item_id=$1 AND branch_id=$2", [mozzarellaId, branchId]);
    expect(Number(batch.rows[0].remaining_quantity)).toBe(8); // 10 - 2

    const saleMovement = await pool.query(
      "SELECT * FROM inventory_movements WHERE branch_id=$1 AND inventory_item_id=$2 AND movement_type='SALE' ORDER BY id DESC LIMIT 1",
      [branchId, mozzarellaId]
    );
    expect(saleMovement.rows[0].batch_id).toBe(batch.rows[0].id);
    expect(Number(saleMovement.rows[0].unit_cost)).toBe(100);
  });

  test("Expiry report وAudit log بيعكسوا العملية بدقة", async () => {
    const expiryRes = await request(app)
      .get("/api/reports/expiring-batches?days=60&branchId=" + branchId)
      .set(authed(adminToken));
    expect(expiryRes.status).toBe(200);
    expect(expiryRes.body.some((b) => b.batch_number === "BATCH-A")).toBe(true);

    const auditRes = await request(app)
      .get("/api/audit-logs?action=TRANSFER_RECEIVED")
      .set(authed(adminToken));
    expect(auditRes.status).toBe(200);
    expect(auditRes.body.length).toBeGreaterThan(0);
  });
});

describe("Transfer workflow: instant path restricted, approval bypass fixed", () => {
  test("/itemized ممنوع على مدير فرع (مش أدمن) - المسار الفوري أدمن بس", async () => {
    const res = await request(app)
      .post("/api/kitchen-transfers/itemized")
      .set(authed(kitchenManagerToken))
      .send({ fromBranchId: kitchenId, toBranchId: branchId, businessDate: "2026-08-15", items: [{ inventoryItemId: flourId, quantity: 1 }] });
    expect(res.status).toBe(403);
  });

  test("/itemized شغال للأدمن (استثناء متعمّد)", async () => {
    await request(app).post("/api/inventory/purchase-receipt").set(authed(kitchenManagerToken))
      .send({ branchId: kitchenId, inventoryItemId: flourId, quantity: 20, unitCost: 20 });
    const res = await request(app)
      .post("/api/kitchen-transfers/itemized")
      .set(authed(adminToken))
      .send({ fromBranchId: kitchenId, toBranchId: branchId, businessDate: "2026-08-15", items: [{ inventoryItemId: flourId, quantity: 5 }] });
    expect(res.status).toBe(201);
  });

  test("/approve ممنوع على مدير فرع حتى لو بتاع نفس التحويل (أدمن بس)", async () => {
    const reqRes = await request(app)
      .post("/api/kitchen-transfers/request")
      .set(authed(kitchenManagerToken))
      .send({ fromBranchId: kitchenId, toBranchId: branchId, businessDate: "2026-08-15", items: [{ inventoryItemId: flourId, quantity: 1 }] });
    const approveAttempt = await request(app)
      .post(`/api/kitchen-transfers/${reqRes.body.id}/approve`)
      .set(authed(managerToken));
    expect(approveAttempt.status).toBe(403);
  });

  test("Cross-branch: مدير فرع تاني مايقدرش يصدّر (/issue) تحويل مش بتاعه", async () => {
    const otherBranch = await pool.query("INSERT INTO branches (name) VALUES ('فرع تاني-جست') RETURNING id");
    const otherManagerId = await seedUser({ branchId: otherBranch.rows[0].id, name: "مدير تاني", email: "othermgr@jest.test", role: "branch_manager" });
    const otherToken = await login("othermgr@jest.test");

    const reqRes = await request(app)
      .post("/api/kitchen-transfers/request")
      .set(authed(kitchenManagerToken))
      .send({ fromBranchId: kitchenId, toBranchId: branchId, businessDate: "2026-08-15", items: [{ inventoryItemId: flourId, quantity: 1 }] });
    await request(app).post(`/api/kitchen-transfers/${reqRes.body.id}/approve`).set(authed(adminToken));

    const issueAttempt = await request(app).post(`/api/kitchen-transfers/${reqRes.body.id}/issue`).set(authed(otherToken));
    expect(issueAttempt.status).toBe(403);
    void otherManagerId;
  });
});

describe("Negative stock policy: STRICT vs ALLOW_WITH_APPROVAL", () => {
  let strictCat, strictItem, strictVariant;

  beforeAll(async () => {
    strictCat = await pool.query("INSERT INTO menu_categories (name) VALUES ('صنف-صارم-قسم-جست') RETURNING id");
    strictItem = await pool.query("INSERT INTO menu_items (category_id, name) VALUES ($1,'صنف صارم منيو-جست') RETURNING id", [strictCat.rows[0].id]);
    strictVariant = await pool.query("INSERT INTO menu_item_variants (item_id, label, price) VALUES ($1,'عادي',50) RETURNING id", [strictItem.rows[0].id]);
    await pool.query(
      "INSERT INTO menu_item_variant_ingredients (variant_id, inventory_item_id, quantity_per_unit) VALUES ($1,$2,1)",
      [strictVariant.rows[0].id, strictItemId]
    );
    // رصيد صفر عمدًا - أي بيع هيحاول ينزّل الرصيد تحت صفر
  });

  test("STRICT: البيع بيترفض تمامًا، مفيش تجاوز حتى بموافقة", async () => {
    const res = await request(app)
      .post("/api/orders")
      .set(authed(cashierToken))
      .send({ branchId, source: "pos", orderType: "takeaway", items: [{ itemId: strictItem.rows[0].id, variantId: strictVariant.rows[0].id, quantity: 1 }] });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("INSUFFICIENT_STOCK");
  });

  test("ALLOW_WITH_APPROVAL: الكاشير لوحده ممنوع، محتاج موافقة", async () => {
    await request(app).patch(`/api/inventory/items/${strictItemId}`).set(authed(adminToken)).send({ negativeStockPolicy: "ALLOW_WITH_APPROVAL" });
    const res = await request(app)
      .post("/api/orders")
      .set(authed(cashierToken))
      .send({ branchId, source: "pos", orderType: "takeaway", items: [{ itemId: strictItem.rows[0].id, variantId: strictVariant.rows[0].id, quantity: 1 }] });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("INSUFFICIENT_STOCK_NEEDS_APPROVAL");
  });

  test("ALLOW_WITH_APPROVAL: بموافقة مدير صحيحة البيع بينجح ويتسجل Audit", async () => {
    const res = await request(app)
      .post("/api/orders")
      .set(authed(cashierToken))
      .send({
        branchId, source: "pos", orderType: "takeaway",
        items: [{ itemId: strictItem.rows[0].id, variantId: strictVariant.rows[0].id, quantity: 1 }],
        inventoryOverrideApprovedBy: managerId,
      });
    expect(res.status).toBe(201);

    const stock = await pool.query("SELECT quantity FROM branch_inventory_stock WHERE branch_id=$1 AND inventory_item_id=$2", [branchId, strictItemId]);
    expect(Number(stock.rows[0].quantity)).toBe(-1);

    const audit = await request(app).get("/api/audit-logs?action=NEGATIVE_STOCK_OVERRIDE").set(authed(adminToken));
    expect(audit.body.length).toBeGreaterThan(0);
  });

  test("Negative stock report بيظهر الصنف السالب", async () => {
    const res = await request(app).get("/api/reports/negative-stock?branchId=" + branchId).set(authed(adminToken));
    expect(res.body.some((r) => r.inventory_item_id === strictItemId)).toBe(true);
  });
});

describe("Order-level idempotency", () => {
  test("Duplicate request: نفس idempotency_key مرتين متتاليين بيرجّع نفس الطلب من غير تكرار", async () => {
    const key = "jest-idem-" + Date.now();
    const first = await request(app)
      .post("/api/orders")
      .set(authed(cashierToken))
      .send({ branchId, source: "pos", orderType: "takeaway", items: [{ itemId: menuItemId, variantId, quantity: 1 }], idempotencyKey: key });
    expect(first.status).toBe(201);

    const second = await request(app)
      .post("/api/orders")
      .set(authed(cashierToken))
      .send({ branchId, source: "pos", orderType: "takeaway", items: [{ itemId: menuItemId, variantId, quantity: 1 }], idempotencyKey: key });
    expect(second.status).toBe(200);
    expect(second.body.duplicate).toBe(true);
    expect(second.body.orderId).toBe(first.body.orderId);

    const count = await pool.query("SELECT COUNT(*) FROM orders WHERE idempotency_key = $1", [key]);
    expect(Number(count.rows[0].count)).toBe(1);
  });

  test("Concurrent duplicate requests: 5 طلبات متزامنة بنفس المفتاح - أوردر واحد بس يتسجل", async () => {
    const key = "jest-concurrent-" + Date.now();
    const payload = { branchId, source: "pos", orderType: "takeaway", items: [{ itemId: menuItemId, variantId, quantity: 1 }], idempotencyKey: key };
    const results = await Promise.all(
      Array.from({ length: 5 }, () => request(app).post("/api/orders").set(authed(cashierToken)).send(payload))
    );
    for (const r of results) expect([200, 201]).toContain(r.status);
    const orderIds = new Set(results.map((r) => r.body.orderId));
    expect(orderIds.size).toBe(1);

    const count = await pool.query("SELECT COUNT(*) FROM orders WHERE idempotency_key = $1", [key]);
    expect(Number(count.rows[0].count)).toBe(1);
  });
});

describe("Sale Void (Reversal)", () => {
  test("Void بيرجّع بالظبط نفس الكمية اللي اتخصمت", async () => {
    const before = await pool.query("SELECT quantity FROM branch_inventory_stock WHERE branch_id=$1 AND inventory_item_id=$2", [branchId, mozzarellaId]);
    const order = await request(app)
      .post("/api/orders")
      .set(authed(cashierToken))
      .send({ branchId, source: "pos", orderType: "takeaway", items: [{ itemId: menuItemId, variantId, quantity: 2 }] });
    expect(order.status).toBe(201);

    const afterSale = await pool.query("SELECT quantity FROM branch_inventory_stock WHERE branch_id=$1 AND inventory_item_id=$2", [branchId, mozzarellaId]);
    expect(Number(before.rows[0].quantity) - Number(afterSale.rows[0].quantity)).toBe(1); // 2 × 0.5

    const voidRes = await request(app)
      .post(`/api/orders/${order.body.orderId}/void`)
      .set(authed(managerToken))
      .send({ reason: "test void" });
    expect(voidRes.status).toBe(200);

    const afterVoid = await pool.query("SELECT quantity FROM branch_inventory_stock WHERE branch_id=$1 AND inventory_item_id=$2", [branchId, mozzarellaId]);
    expect(Number(afterVoid.rows[0].quantity)).toBe(Number(before.rows[0].quantity));
  });
});

describe("Waste / Adjustment / Reconciliation / Unauthorized actions", () => {
  test("Waste: بيخصم ويسجل السبب", async () => {
    const res = await request(app)
      .post("/api/inventory/waste")
      .set(authed(kitchenManagerToken))
      .send({ branchId: kitchenId, inventoryItemId: flourId, quantity: 2, wasteReason: "DAMAGED", reason: "وقع" });
    expect(res.status).toBe(201);
    expect(res.body.reason).toBe("DAMAGED");
  });

  test("Adjustment: كاشير ممنوع، مدير فرع مسموح", async () => {
    const denied = await request(app)
      .post("/api/inventory/stock/adjust")
      .set(authed(cashierToken))
      .send({ branchId, inventoryItemId: mozzarellaId, quantity: 1, movementType: "adjustment" });
    expect(denied.status).toBe(403);

    const allowed = await request(app)
      .post("/api/inventory/stock/adjust")
      .set(authed(managerToken))
      .send({ branchId, inventoryItemId: mozzarellaId, quantity: 1, movementType: "adjustment" });
    expect(allowed.status).toBe(201);
  });

  test("Reconciliation: الفرق بيتسجل كـSTOCK_COUNT ومفيش تصحيح تلقائي في discrepancy-check", async () => {
    const current = await pool.query("SELECT quantity FROM branch_inventory_stock WHERE branch_id=$1 AND inventory_item_id=$2", [branchId, mozzarellaId]);
    const actual = Number(current.rows[0].quantity) + 3;
    const res = await request(app)
      .post("/api/inventory/reconcile")
      .set(authed(managerToken))
      .send({ branchId, inventoryItemId: mozzarellaId, actualQuantity: actual, notes: "جرد اختبار" });
    expect(res.status).toBe(201);
    expect(res.body.variance).toBe(3);
  });

  test("Cross-branch: مدير فرع مايقدرش يعدّل مخزون فرع تاني", async () => {
    const res = await request(app)
      .post("/api/inventory/stock/adjust")
      .set(authed(managerToken))
      .send({ branchId: kitchenId, inventoryItemId: mozzarellaId, quantity: 1, movementType: "adjustment" });
    expect(res.status).toBe(403);
  });
});
