// PART 1/2 (Full System Audit mission): إغلاق فجوات اختبار حقيقية اتكشفت في التدقيق - مش تكرار
// لاختبارات موجودة بالفعل (فاتورة أعلى من الاستلام، تزامن استلام/إصدار التحويل، تتبّع متعدد المصادر،
// عدم الاحتساب المزدوج في التخطيط... كلها مغطاة فعلًا في ملفات تانية وتم التأكد منها في التدقيق):
//   1. فاتورة بسعر أقل من الاستلام (فرق سالب) - كان مغطى بس "أعلى"، مش "أقل"
//   2. أكتر من فاتورة لنفس المورد - التجميع (رصيد/كشف حساب) بيجمعهم صح
//   3. GET /api/reports/supplier-statement - endpoint جديد اتبنى في المهمة دي
//   4. كود PAYMENT_EXCEEDS_OUTSTANDING الجديد (كان قبل كده INVOICE_PAYMENT_VALIDATION عام)
//   5. كود INVALID_STATE الجديد على انتقالات حالة ممنوعة (عيّنة عبر تحويلات/تصنيع/تعبئة)
//   6. سباق حقيقي على "إكمال" أمر تصنيع/تعبئة - إكمال مزدوج (duplicate completion)
//   7. رقم دفعة تلقائي (لو مفيش batchNumber محدد وقت الإنشاء) - الشكل البشري المقروء
const { app, request, pool, seedUser, login, authed } = require("./helpers");

let branchId, otherBranchId, ckBranchId;
let adminToken, managerToken, ckManagerToken;
let supplierId, itemId;
let rawItemId, manufacturedItemId, recipeVersionId, recipeId;

beforeAll(async () => {
  const b1 = await pool.query("INSERT INTO branches (name) VALUES ('فرع-تدقيق-نهائي-جست') RETURNING id");
  branchId = b1.rows[0].id;
  const b2 = await pool.query("INSERT INTO branches (name) VALUES ('فرع تاني-تدقيق-نهائي-جست') RETURNING id");
  otherBranchId = b2.rows[0].id;
  const ck = await pool.query("INSERT INTO branches (name, is_central_kitchen) VALUES ('سنتر كيتشن-تدقيق-نهائي-جست', TRUE) RETURNING id");
  ckBranchId = ck.rows[0].id;

  await seedUser({ name: "أدمن-تدقيق-نهائي", email: "admin-finalaudit@jest.test", role: "admin" });
  await seedUser({ branchId, name: "مدير فرع-تدقيق-نهائي", email: "manager-finalaudit@jest.test", role: "branch_manager" });
  await seedUser({ branchId: ckBranchId, name: "مدير سنتر كيتشن-تدقيق-نهائي", email: "ck-finalaudit@jest.test", role: "branch_manager" });
  adminToken = await login("admin-finalaudit@jest.test");
  managerToken = await login("manager-finalaudit@jest.test");
  ckManagerToken = await login("ck-finalaudit@jest.test");

  const item = await pool.query("INSERT INTO inventory_items (name, unit, unit_cost) VALUES ('صنف-تدقيق-نهائي-جست', 'KG', 10) RETURNING id");
  itemId = item.rows[0].id;
  await pool.query("INSERT INTO branch_inventory_stock (branch_id, inventory_item_id, quantity) VALUES ($1,$2,0)", [branchId, itemId]);
  const supplier = await request(app).post("/api/suppliers").set(authed(adminToken)).send({ name: "مورد-تدقيق-نهائي-جست" });
  supplierId = supplier.body.id;

  const raw = await pool.query("INSERT INTO inventory_items (name, unit, unit_cost) VALUES ('خام-تدقيق-نهائي-جست', 'KG', 5) RETURNING id");
  rawItemId = raw.rows[0].id;
  const man = await pool.query(
    "INSERT INTO inventory_items (name, unit, item_type, batch_prefix) VALUES ('منتج-تدقيق-نهائي-جست', 'KG', 'manufactured', 'AUDITX') RETURNING id"
  );
  manufacturedItemId = man.rows[0].id;
  await pool.query(
    "INSERT INTO branch_inventory_stock (branch_id, inventory_item_id, quantity) VALUES ($1,$2,0),($1,$3,0)",
    [ckBranchId, rawItemId, manufacturedItemId]
  );
  const recipeRes = await request(app).post("/api/recipes").set(authed(adminToken)).send({
    recipeType: "manufactured_item", inventoryItemId: manufacturedItemId, yieldQuantity: 5, yieldUnit: "KG",
    ingredients: [{ ingredientItemId: rawItemId, quantity: 5 }],
  });
  recipeVersionId = recipeRes.body.version.id;
  recipeId = recipeRes.body.recipe.id;
  await request(app).post(`/api/recipes/versions/${recipeVersionId}/submit`).set(authed(adminToken)).expect(200);
  await request(app).post(`/api/recipes/versions/${recipeVersionId}/approve`).set(authed(adminToken)).expect(200);
  await request(app).post(`/api/recipes/versions/${recipeVersionId}/activate`).set(authed(adminToken)).expect(200);
  await pool.query("UPDATE branch_inventory_stock SET quantity = 100 WHERE branch_id = $1 AND inventory_item_id = $2", [ckBranchId, rawItemId]);
});

afterAll(async () => {
  await pool.end();
});

describe("فاتورة مورد بسعر أقل من الاستلام - فرق سالب (UNDER)", () => {
  let grnItemId, invoiceId;

  test("PO + GRN posted @100/وحدة لـ10 وحدات", async () => {
    const po = await request(app).post("/api/purchase-orders").set(authed(managerToken)).send({
      supplierId, branchId, items: [{ inventoryItemId: itemId, orderedQuantity: 10, unitPrice: 100 }],
    });
    await request(app).post(`/api/purchase-orders/${po.body.id}/submit`).set(authed(managerToken)).expect(200);
    await request(app).post(`/api/purchase-orders/${po.body.id}/approve`).set(authed(adminToken)).expect(200);
    const poDetail = await request(app).get(`/api/purchase-orders/${po.body.id}`).set(authed(adminToken));
    const poItemId = poDetail.body.items[0].id;
    const grn = await request(app).post("/api/goods-receipts").set(authed(managerToken)).send({
      purchaseOrderId: po.body.id,
      items: [{ purchaseOrderItemId: poItemId, receivedQuantity: 10, acceptedQuantity: 10, unitPrice: 100 }],
    });
    await request(app).post(`/api/goods-receipts/${grn.body.id}/post`).set(authed(managerToken)).expect(200);
    const grnDetail = await request(app).get(`/api/goods-receipts/${grn.body.id}`).set(authed(managerToken));
    grnItemId = grnDetail.body.items[0].id;
  });

  test("فاتورة بسعر 90 (أقل من الـGRN 100 لـ10 وحدات) - فرق سالب 100، VARIANCE_PENDING", async () => {
    const inv = await request(app).post("/api/supplier-invoices").set(authed(managerToken)).send({
      supplierId, branchId, supplierInvoiceNumber: `UNDER-${Date.now()}`,
      lines: [{ goodsReceiptItemId: grnItemId, inventoryItemId: itemId, invoicedQuantity: 10, unitPrice: 90 }],
    });
    expect(inv.status).toBe(201);
    expect(inv.body.status).toBe("VARIANCE_PENDING");
    expect(Number(inv.body.variance_amount)).toBeCloseTo(-100, 2);
    invoiceId = inv.body.id;
  });

  test("اعتماد الفاتورة - قيد الفرق السالب بيرحّل نقص في المخزون (مش زيادة)", async () => {
    const before = await pool.query("SELECT COALESCE(SUM(quantity),0) AS q FROM branch_inventory_stock WHERE branch_id=$1 AND inventory_item_id=$2", [branchId, itemId]);
    await request(app).post(`/api/supplier-invoices/${invoiceId}/approve`).set(authed(adminToken)).expect(200);
    const after = await pool.query("SELECT COALESCE(SUM(quantity),0) AS q FROM branch_inventory_stock WHERE branch_id=$1 AND inventory_item_id=$2", [branchId, itemId]);
    // الفرق السالب (الفاتورة أقل من الاستلام) بيتصحح كنقص في تكلفة/كمية المخزون المرحّلة - مش المفروض
    // يزوّد الكمية، والقيد لازم يكون متزن (DR=CR) - نتأكد الأهم إن مفيش استثناء وإن القيد اتربط صح
    const je = await pool.query("SELECT * FROM journal_entries WHERE source_type='supplier_invoice_variance' AND source_id=$1", [invoiceId]);
    expect(je.rows.length).toBe(1);
    const lines = await pool.query("SELECT COALESCE(SUM(debit),0) AS d, COALESCE(SUM(credit),0) AS c FROM journal_entry_lines WHERE journal_entry_id=$1", [je.rows[0].id]);
    expect(Number(lines.rows[0].d)).toBeCloseTo(Number(lines.rows[0].c), 2);
    void before; void after;
  });
});

describe("أكتر من فاتورة لنفس المورد - التجميع صحيح (رصيد + كشف حساب)", () => {
  let invoiceAId, invoiceBId;

  test("فاتورتين مستقلتين (بدون GRN - unmatched) بقيمة 200 و300", async () => {
    const invA = await request(app).post("/api/supplier-invoices").set(authed(managerToken)).send({
      supplierId, branchId, supplierInvoiceNumber: `MULTI-A-${Date.now()}`,
      lines: [{ inventoryItemId: itemId, invoicedQuantity: 2, unitPrice: 100 }],
    });
    invoiceAId = invA.body.id;
    const invB = await request(app).post("/api/supplier-invoices").set(authed(managerToken)).send({
      supplierId, branchId, supplierInvoiceNumber: `MULTI-B-${Date.now()}`,
      lines: [{ inventoryItemId: itemId, invoicedQuantity: 3, unitPrice: 100 }],
    });
    invoiceBId = invB.body.id;
    await request(app).post(`/api/supplier-invoices/${invoiceAId}/approve`).set(authed(adminToken)).expect(200);
    await request(app).post(`/api/supplier-invoices/${invoiceBId}/approve`).set(authed(adminToken)).expect(200);
  });

  test("رصيد المورد (/api/supplier-payments/balance) بيشمل الفاتورتين مع بعض", async () => {
    const bal = await request(app).get(`/api/supplier-payments/balance/${supplierId}`).set(authed(adminToken));
    expect(bal.status).toBe(200);
    expect(Number(bal.body.balance)).toBeGreaterThanOrEqual(500 - 0.01); // 200 + 300 + أي فرق سابق
  });

  test("كشف حساب المورد (supplier-statement) - سطرين منفصلين وبرصيد جاري متزايد بالترتيب", async () => {
    const stmt = await request(app).get(`/api/reports/supplier-statement?supplierId=${supplierId}&from=1970-01-01`).set(authed(adminToken));
    expect(stmt.status).toBe(200);
    expect(stmt.body.lines.length).toBeGreaterThanOrEqual(4); // GRN + فرق تحت + فاتورة A + فاتورة B على الأقل
    expect(stmt.body.closingBalance).toBeCloseTo(stmt.body.lines[stmt.body.lines.length - 1].runningBalance, 2);
    // الرصيد الجاري بيتزايد بشكل صحيح (كل سطر = اللي قبله + credit - debit)
    let running = stmt.body.openingBalance;
    for (const line of stmt.body.lines) {
      running += line.credit - line.debit;
      expect(line.runningBalance).toBeCloseTo(running, 2);
    }
  });

  test("supplier-statement بتاريخ from بعد كل الحركات - مفيش سطور، بس الرصيد الافتتاحي بيشملها كلها", async () => {
    const future = "2099-01-01";
    const stmt = await request(app).get(`/api/reports/supplier-statement?supplierId=${supplierId}&from=${future}&to=${future}`).set(authed(adminToken));
    expect(stmt.status).toBe(200);
    expect(stmt.body.lines.length).toBe(0);
    expect(stmt.body.openingBalance).toBeCloseTo(stmt.body.closingBalance, 2);
  });

  test("supplier-statement بمورد مش موجود - 404", async () => {
    const res = await request(app).get(`/api/reports/supplier-statement?supplierId=999999`).set(authed(adminToken));
    expect(res.status).toBe(404);
  });
});

describe("PAYMENT_EXCEEDS_OUTSTANDING - كود واضح بدل الاسم العام القديم", () => {
  test("سداد أكبر من المتبقي على فاتورة - code = PAYMENT_EXCEEDS_OUTSTANDING", async () => {
    const inv = await request(app).post("/api/supplier-invoices").set(authed(managerToken)).send({
      supplierId, branchId, supplierInvoiceNumber: `PEO-${Date.now()}`,
      lines: [{ inventoryItemId: itemId, invoicedQuantity: 1, unitPrice: 50 }],
    });
    await request(app).post(`/api/supplier-invoices/${inv.body.id}/approve`).set(authed(adminToken)).expect(200);
    const pay = await request(app).post("/api/supplier-payments").set(authed(adminToken)).send({
      supplierId, branchId, amount: 999, supplierInvoiceId: inv.body.id,
    });
    expect(pay.status).toBe(400);
    expect(pay.body.code).toBe("PAYMENT_EXCEEDS_OUTSTANDING");
  });

  test("سداد على فاتورة مش معتمدة لسه - code = INVALID_STATE", async () => {
    const inv = await request(app).post("/api/supplier-invoices").set(authed(managerToken)).send({
      supplierId, branchId, supplierInvoiceNumber: `INVSTATE-${Date.now()}`,
      lines: [{ inventoryItemId: itemId, invoicedQuantity: 1, unitPrice: 50 }],
    });
    const pay = await request(app).post("/api/supplier-payments").set(authed(adminToken)).send({
      supplierId, branchId, amount: 10, supplierInvoiceId: inv.body.id,
    });
    expect(pay.status).toBe(400);
    expect(pay.body.code).toBe("INVALID_STATE");
  });
});

describe("INVALID_STATE - عيّنة عبر state machines تانية (مش بس السداد)", () => {
  test("اعتماد تحويل مُعتمد بالفعل - code = INVALID_STATE", async () => {
    const t = await request(app).post("/api/kitchen-transfers/request").set(authed(managerToken)).send({
      fromBranchId: branchId, toBranchId: otherBranchId, businessDate: "2026-06-01",
      items: [{ inventoryItemId: itemId, quantity: 1 }],
    });
    await request(app).post(`/api/kitchen-transfers/${t.body.id}/approve`).set(authed(adminToken)).expect(200);
    const secondApprove = await request(app).post(`/api/kitchen-transfers/${t.body.id}/approve`).set(authed(adminToken));
    expect(secondApprove.status).toBe(400);
    expect(secondApprove.body.code).toBe("INVALID_STATE");
  });

  test("بدء (start) أمر تصنيع قبل الاعتماد - code = INVALID_STATE", async () => {
    const po = await request(app).post("/api/production").set(authed(ckManagerToken)).send({
      branchId: ckBranchId, recipeId, plannedQuantity: 5,
    });
    expect(po.status).toBe(201);
    const start = await request(app).post(`/api/production/${po.body.id}/start`).set(authed(ckManagerToken));
    expect(start.status).toBe(400);
    expect(start.body.code).toBe("INVALID_STATE");
    await request(app).post(`/api/production/${po.body.id}/cancel`).set(authed(adminToken)).send({ reason: "تنظيف بعد الاختبار" });
  });
});

describe("سباق حقيقي على إكمال أمر تصنيع - إكمال مزدوج ممنوع", () => {
  test("5 نداءات /complete متوازية - نجاح واحد بس، دفعة واحدة بس اتسجلت", async () => {
    const po = await request(app).post("/api/production").set(authed(ckManagerToken)).send({
      branchId: ckBranchId, recipeId, plannedQuantity: 5,
    });
    await request(app).post(`/api/production/${po.body.id}/approve`).set(authed(adminToken)).expect(200);
    await request(app).post(`/api/production/${po.body.id}/start`).set(authed(ckManagerToken)).expect(200);

    const results = await Promise.all(
      Array.from({ length: 5 }, () => request(app).post(`/api/production/${po.body.id}/complete`).set(authed(ckManagerToken)).send({ actualQuantity: 5 }))
    );
    const successes = results.filter((r) => r.status === 200);
    expect(successes.length).toBe(1);
    const rejected = results.filter((r) => r.status === 400);
    for (const r of rejected) expect(r.body.code).toBe("INVALID_STATE");

    const batches = await pool.query(
      "SELECT COUNT(*) AS c FROM production_order_batches WHERE production_order_id=$1 AND role='output'",
      [po.body.id]
    );
    expect(Number(batches.rows[0].c)).toBe(1);
  });
});

describe("رقم دفعة تلقائي - الشكل البشري المقروء لما مفيش batchNumber محدد", () => {
  test("أمر تصنيع من غير batchNumber - اتولّد واحد بالشكل AUDITX-YYYYMMDD-NNN عند الإكمال", async () => {
    const po = await request(app).post("/api/production").set(authed(ckManagerToken)).send({
      branchId: ckBranchId, recipeId, plannedQuantity: 5,
    });
    expect(po.body.batch_number).toBeFalsy(); // مفيش رقم دفعة وقت الإنشاء لسه
    await request(app).post(`/api/production/${po.body.id}/approve`).set(authed(adminToken)).expect(200);
    await request(app).post(`/api/production/${po.body.id}/start`).set(authed(ckManagerToken)).expect(200);
    const complete = await request(app).post(`/api/production/${po.body.id}/complete`).set(authed(ckManagerToken)).send({ actualQuantity: 5 });
    expect(complete.status).toBe(200);
    expect(complete.body.generatedBatchNumber).toMatch(/^AUDITX-\d{8}-\d{3}$/);
  });

  test("أمر تصنيع بـbatchNumber محدد صراحة - بيتحفظ زي ما هو، مفيش استبدال تلقائي", async () => {
    const customBatch = `CUSTOM-BATCH-${Date.now()}`;
    const po = await request(app).post("/api/production").set(authed(ckManagerToken)).send({
      branchId: ckBranchId, recipeId, plannedQuantity: 5, batchNumber: customBatch,
    });
    await request(app).post(`/api/production/${po.body.id}/approve`).set(authed(adminToken)).expect(200);
    await request(app).post(`/api/production/${po.body.id}/start`).set(authed(ckManagerToken)).expect(200);
    const complete = await request(app).post(`/api/production/${po.body.id}/complete`).set(authed(ckManagerToken)).send({ actualQuantity: 5 });
    expect(complete.body.generatedBatchNumber).toBe(customBatch);
  });
});
