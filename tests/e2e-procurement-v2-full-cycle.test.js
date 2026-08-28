// STEP L-audit (بند 16 - "محاكاة عمل كاملة") - سيناريو تكاملي واحد بيغطي السلسلة الكاملة اللي طلبها المستخدم
// بالحرف: مورد → شراء (طلب شراء → أمر شراء → استلام GRN → فاتورة مورد) → تصنيع (خام → سائب → حصص معبأة) →
// طلبية فرع (اقتراح مبني على استهلاك تاريخي → مراجعة → تقديم → اعتماد سنتر كيتشن → تجهيز → تحويل → في
// الطريق) → استلام (نقص 10 وحدات → فرق مُسجَّل صراحة → تسوية) → تتبّع (للخلف وللأمام) → مطابقة محاسبية
// ومخزنية. الهدف: إثبات إن السلسلة الكاملة بتوازن آخر السلسلة - "zero unexplained inventory or accounting
// discrepancies" - مش بس كل جزء لوحده (ده مغطّى فعلًا في ملفات STEP المنفصلة).
const { app, request, pool, seedUser, login, authed } = require("./helpers");

let ckBranchId, ibrahimiaBranchId;
let adminToken, ckManagerToken, branchManagerToken, accountantToken;
let supplierId;
let rawMeatId, sausageBulkId, sausagePortionId;
let businessDate;
let openingSnapshot; // {branchId,itemId} -> {stock, ledgerNet} - ملتقطة بعد بذر تاريخ الاستهلاك (اللي بيتحسب بدون
                      // ما يمر على الليدجر عمدًا، زي أي اختبار تاني لمحرك الاقتراح STEP E) عشان فحص المطابقة
                      // المخزنية (بند 9) يقيس بس صافي حركة سلسلة الـE2E الفعلية، مش يتصادم مع بيانات تاريخية مصطنعة

function lastWeekday(fromDate, weekday) {
  const d = new Date(`${fromDate}T00:00:00Z`);
  while (d.getUTCDay() !== weekday) d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

beforeAll(async () => {
  const ck = await pool.query("INSERT INTO branches (name, is_central_kitchen) VALUES ('سنتر كيتشن-E2E-جست', TRUE) RETURNING id");
  ckBranchId = ck.rows[0].id;
  const br = await pool.query("INSERT INTO branches (name) VALUES ('فرع الإبراهيمية-E2E-جست') RETURNING id");
  ibrahimiaBranchId = br.rows[0].id;

  await seedUser({ name: "أدمن-E2E", email: "admin-e2e@jest.test", role: "admin" });
  await seedUser({ branchId: ckBranchId, name: "مدير سنتر كيتشن-E2E", email: "ck-e2e@jest.test", role: "branch_manager" });
  await seedUser({ branchId: ibrahimiaBranchId, name: "مدير فرع الإبراهيمية-E2E", email: "branch-e2e@jest.test", role: "branch_manager" });
  await seedUser({ name: "محاسب-E2E", email: "accountant-e2e@jest.test", role: "accountant" });
  adminToken = await login("admin-e2e@jest.test");
  ckManagerToken = await login("ck-e2e@jest.test");
  branchManagerToken = await login("branch-e2e@jest.test");
  accountantToken = await login("accountant-e2e@jest.test");

  const supplier = await request(app).post("/api/suppliers").set(authed(adminToken)).send({ name: "مورد لحوم-E2E-جست" });
  supplierId = supplier.body.id;

  const raw = await pool.query(
    "INSERT INTO inventory_items (name, unit, unit_cost) VALUES ('لحم خام-E2E-جست', 'KG', 300) RETURNING id"
  );
  rawMeatId = raw.rows[0].id;
  const bulk = await pool.query(
    "INSERT INTO inventory_items (name, unit, unit_cost, item_type, batch_prefix) VALUES ('سجق سائب-E2E-جست', 'KG', NULL, 'manufactured', 'SAUB') RETURNING id"
  );
  sausageBulkId = bulk.rows[0].id;
  const portion = await pool.query(
    "INSERT INTO inventory_items (name, unit, unit_cost, item_type) VALUES ('سجق حصص 100ج-E2E-جست', 'unit', NULL, 'manufactured') RETURNING id"
  );
  sausagePortionId = portion.rows[0].id;

  await pool.query(
    `INSERT INTO branch_inventory_stock (branch_id, inventory_item_id, quantity, min_stock, max_stock)
     VALUES ($1,$2,0,NULL,NULL), ($1,$3,0,NULL,NULL), ($1,$4,0,NULL,NULL),
            ($5,$4,0,10,500)`,
    [ckBranchId, rawMeatId, sausageBulkId, sausagePortionId, ibrahimiaBranchId]
  );

  // تاريخ استهلاك حقيقي للفرع لآخر خميس معروف - عشان محرك الاقتراح (STEP E) يبني اقتراح حقيقي مش صفري
  const today = new Date().toISOString().slice(0, 10);
  const pastThursday = lastWeekday(today, 4);
  await pool.query(
    "INSERT INTO inventory_movements (branch_id, inventory_item_id, movement_type, quantity, business_date) VALUES ($1,$2,'SALE',-40,$3)",
    [ibrahimiaBranchId, sausagePortionId, pastThursday]
  );
  const nextThursdayD = new Date(`${pastThursday}T00:00:00Z`);
  nextThursdayD.setUTCDate(nextThursdayD.getUTCDate() + 7);
  businessDate = nextThursdayD.toISOString().slice(0, 10);

  const items = [
    { branchId: ckBranchId, itemId: rawMeatId },
    { branchId: ckBranchId, itemId: sausageBulkId },
    { branchId: ckBranchId, itemId: sausagePortionId },
    { branchId: ibrahimiaBranchId, itemId: sausagePortionId },
  ];
  openingSnapshot = [];
  for (const { branchId, itemId } of items) {
    const stock = await pool.query("SELECT quantity FROM branch_inventory_stock WHERE branch_id=$1 AND inventory_item_id=$2", [branchId, itemId]);
    const ledger = await pool.query("SELECT COALESCE(SUM(quantity),0) AS net FROM inventory_movements WHERE branch_id=$1 AND inventory_item_id=$2", [branchId, itemId]);
    openingSnapshot.push({ branchId, itemId, stock: Number(stock.rows[0].quantity), ledgerNet: Number(ledger.rows[0].net) });
  }
});

afterAll(async () => {
  await pool.end();
});

describe("STEP L-audit Audit 16: محاكاة عمل كاملة من المورد للفرع - end to end", () => {
  let poId, poItemId, grnId, grnBatchId, invoiceId;
  let bulkOrderId, bulkBatchId;
  let portionOrderId, portionBatchId;
  let kitchenOrderId, transferId;
  let discrepancyId;
  let branchReceivedBatchId;

  test("1) الشراء: طلب شراء → أمر شراء → استلام GRN (30كجم) → فاتورة مورد مطابقة", async () => {
    const pr = await request(app).post("/api/purchase-requests").set(authed(ckManagerToken)).send({
      branchId: ckBranchId, reason: "تجديد مخزون اللحم الخام",
      items: [{ inventoryItemId: rawMeatId, requestedQuantity: 30 }],
    });
    expect(pr.status).toBe(201);
    await request(app).post(`/api/purchase-requests/${pr.body.id}/submit`).set(authed(ckManagerToken)).expect(200);
    await request(app).post(`/api/purchase-requests/${pr.body.id}/approve`).set(authed(adminToken)).expect(200);

    const po = await request(app).post("/api/purchase-orders").set(authed(ckManagerToken)).send({
      supplierId, branchId: ckBranchId, purchaseRequestId: pr.body.id,
      items: [{ inventoryItemId: rawMeatId, orderedQuantity: 30, unitPrice: 300 }],
    });
    expect(po.status).toBe(201);
    poId = po.body.id;
    await request(app).post(`/api/purchase-orders/${poId}/submit`).set(authed(ckManagerToken)).expect(200);
    await request(app).post(`/api/purchase-orders/${poId}/approve`).set(authed(adminToken)).expect(200);
    const poDetail = await request(app).get(`/api/purchase-orders/${poId}`).set(authed(ckManagerToken));
    poItemId = poDetail.body.items[0].id;

    const grn = await request(app).post("/api/goods-receipts").set(authed(ckManagerToken)).send({
      purchaseOrderId: poId,
      items: [{ purchaseOrderItemId: poItemId, receivedQuantity: 30, acceptedQuantity: 30, unitPrice: 300, batchNumber: "RAW-E2E-001", expiryDate: "2027-06-01" }],
    });
    expect(grn.status).toBe(201);
    grnId = grn.body.id;
    await request(app).post(`/api/goods-receipts/${grnId}/post`).set(authed(ckManagerToken)).expect(200);
    const grnDetail = await request(app).get(`/api/goods-receipts/${grnId}`).set(authed(ckManagerToken));
    grnBatchId = grnDetail.body.items[0].batch_id;
    const grnItemId = grnDetail.body.items[0].id;
    expect(grnBatchId).not.toBeNull();

    const stockAfterGrn = await pool.query("SELECT quantity FROM branch_inventory_stock WHERE branch_id=$1 AND inventory_item_id=$2", [ckBranchId, rawMeatId]);
    expect(Number(stockAfterGrn.rows[0].quantity)).toBeCloseTo(30, 5);

    const invoice = await request(app).post("/api/supplier-invoices").set(authed(ckManagerToken)).send({
      supplierId, branchId: ckBranchId, supplierInvoiceNumber: "INV-E2E-001", invoiceDate: businessDate,
      lines: [{ goodsReceiptItemId: grnItemId, inventoryItemId: rawMeatId, invoicedQuantity: 30, unitPrice: 300 }],
    });
    expect(invoice.status).toBe(201);
    invoiceId = invoice.body.id;
    expect(invoice.body.status).toBe("MATCHED"); // 30×300 فاتورة = 30×300 GRN بالظبط، مفيش فرق - بيتحسب وقت الإنشاء
    expect(Number(invoice.body.variance_amount)).toBeCloseTo(0, 5);
    const approvedInvoice = await request(app).post(`/api/supplier-invoices/${invoiceId}/approve`).set(authed(adminToken));
    expect(approvedInvoice.status).toBe(200);
    expect(approvedInvoice.body.status).toBe("APPROVED"); // /approve بينقلها من MATCHED/VARIANCE_PENDING إلى APPROVED
  });

  test("2) التصنيع: 30كجم لحم خام → سجق سائب (تصنيع) → حصص 100ج (تعبئة)", async () => {
    const recipe = await request(app).post("/api/recipes").set(authed(adminToken)).send({
      recipeType: "manufactured_item", inventoryItemId: sausageBulkId, yieldQuantity: 30, yieldUnit: "KG",
      ingredients: [{ ingredientItemId: rawMeatId, quantity: 30 }],
    });
    const versionId = recipe.body.version.id;
    await request(app).post(`/api/recipes/versions/${versionId}/submit`).set(authed(ckManagerToken)).expect(200);
    await request(app).post(`/api/recipes/versions/${versionId}/approve`).set(authed(adminToken)).expect(200);
    await request(app).post(`/api/recipes/versions/${versionId}/activate`).set(authed(adminToken)).expect(200);
    const recipeId = (await pool.query("SELECT recipe_id FROM recipe_versions WHERE id = $1", [versionId])).rows[0].recipe_id;

    const bulkOrder = await request(app).post("/api/production").set(authed(ckManagerToken)).send({
      branchId: ckBranchId, recipeId, plannedQuantity: 30, expiryDate: "2027-05-01",
    });
    bulkOrderId = bulkOrder.body.id;
    await request(app).post(`/api/production/${bulkOrderId}/approve`).set(authed(adminToken)).expect(200);
    await request(app).post(`/api/production/${bulkOrderId}/start`).set(authed(ckManagerToken)).expect(200);
    const bulkComplete = await request(app).post(`/api/production/${bulkOrderId}/complete`).set(authed(ckManagerToken)).send({ actualQuantity: 30 });
    expect(bulkComplete.status).toBe(200);
    bulkBatchId = bulkComplete.body.batchId;
    expect(bulkBatchId).not.toBeNull();

    const rawStockAfter = await pool.query("SELECT quantity FROM branch_inventory_stock WHERE branch_id=$1 AND inventory_item_id=$2", [ckBranchId, rawMeatId]);
    expect(Number(rawStockAfter.rows[0].quantity)).toBeCloseTo(0, 5); // كل الخام اتستهلك

    // 30كجم سائب → 300 حصة 100ج (تعبئة - مرحلة منفصلة عن التصنيع، بس نفس محرك الليدجر)
    const packOrder = await request(app).post("/api/packaging").set(authed(ckManagerToken)).send({
      branchId: ckBranchId, inputItemId: sausageBulkId, outputItemId: sausagePortionId,
      inputBatchId: bulkBatchId, plannedInputQuantity: 30, plannedOutputQuantity: 300,
    });
    portionOrderId = packOrder.body.id;
    await request(app).post(`/api/packaging/${portionOrderId}/approve`).set(authed(adminToken)).expect(200);
    await request(app).post(`/api/packaging/${portionOrderId}/start`).set(authed(ckManagerToken)).expect(200);
    const portionComplete = await request(app).post(`/api/packaging/${portionOrderId}/complete`).set(authed(ckManagerToken)).send({ actualOutputQuantity: 300 });
    expect(portionComplete.status).toBe(200);
    portionBatchId = portionComplete.body.batchId;
    expect(portionComplete.body.parentBatchId).toBe(bulkBatchId);

    const portionStock = await pool.query("SELECT quantity FROM branch_inventory_stock WHERE branch_id=$1 AND inventory_item_id=$2", [ckBranchId, sausagePortionId]);
    expect(Number(portionStock.rows[0].quantity)).toBeCloseTo(300, 5);
  });

  test("3) طلبية الفرع: اقتراح مبني على استهلاك تاريخي → مراجعة وتقديم → اعتماد → تجهيز → جاهزة", async () => {
    const suggested = await request(app).get(
      `/api/kitchen-orders/suggested?branchId=${ibrahimiaBranchId}&targetDate=${businessDate}&lookbackWeeks=1`
    ).set(authed(branchManagerToken));
    expect(suggested.status).toBe(200);
    const portionSuggestion = suggested.body.suggestions.find((s) => s.inventoryItemId === sausagePortionId);
    expect(portionSuggestion).toBeDefined();
    expect(portionSuggestion.avgWeekdayConsumption).toBeCloseTo(40, 5); // نفس استهلاك الخميس الماضي المسجّل
    expect(portionSuggestion.suggestedQuantity).toBeGreaterThan(0); // اقتراح حقيقي، مش صفر

    const created = await request(app).post("/api/kitchen-orders").set(authed(branchManagerToken)).send({
      branchId: ibrahimiaBranchId, status: "DRAFT", isAutoSuggested: true,
      items: [{ inventoryItemId: sausagePortionId, quantityRequested: 50, quantitySuggested: portionSuggestion.suggestedQuantity }],
    });
    expect(created.status).toBe(201);
    kitchenOrderId = created.body.orderId;

    await request(app).post(`/api/kitchen-orders/${kitchenOrderId}/submit`).set(authed(branchManagerToken)).expect(200);
    await request(app).post(`/api/kitchen-orders/${kitchenOrderId}/approve`).set(authed(ckManagerToken)).expect(200);

    const picking = await request(app).post(`/api/kitchen-orders/${kitchenOrderId}/picking`).set(authed(ckManagerToken)).send({
      items: [{ inventoryItemId: sausagePortionId, quantityToPrepare: 50 }],
    });
    expect(picking.status).toBe(200);
    expect(picking.body.items[0].fulfillment_status).toBe("FULL");

    const ready = await request(app).post(`/api/kitchen-orders/${kitchenOrderId}/ready`).set(authed(ckManagerToken));
    expect(ready.status).toBe(200);
    expect(ready.body.status).toBe("READY");
  });

  test("4) التحويل: طلب → اعتماد → إصدار (IN_TRANSIT) - الرصيد بينزل من السنتر كيتشن، لسه مازادش في الفرع", async () => {
    const transferReq = await request(app).post("/api/kitchen-transfers/request").set(authed(ckManagerToken)).send({
      fromBranchId: ckBranchId, toBranchId: ibrahimiaBranchId, businessDate,
      items: [{ inventoryItemId: sausagePortionId, quantity: 50 }], kitchenOrderId,
    });
    expect(transferReq.status).toBe(201);
    transferId = transferReq.body.id;
    await request(app).post(`/api/kitchen-transfers/${transferId}/approve`).set(authed(adminToken)).expect(200);
    const issued = await request(app).post(`/api/kitchen-transfers/${transferId}/issue`).set(authed(ckManagerToken));
    expect(issued.status).toBe(200);
    expect(issued.body.status).toBe("in_transit");

    const ckStockAfterIssue = await pool.query("SELECT quantity FROM branch_inventory_stock WHERE branch_id=$1 AND inventory_item_id=$2", [ckBranchId, sausagePortionId]);
    expect(Number(ckStockAfterIssue.rows[0].quantity)).toBeCloseTo(250, 5); // 300 - 50
    const branchStockBeforeReceive = await pool.query("SELECT quantity FROM branch_inventory_stock WHERE branch_id=$1 AND inventory_item_id=$2", [ibrahimiaBranchId, sausagePortionId]);
    expect(Number(branchStockBeforeReceive.rows[0].quantity)).toBeCloseTo(0, 5); // لسه في الطريق، ماوصلش

    const orderStatus = await pool.query("SELECT status FROM kitchen_orders WHERE id = $1", [kitchenOrderId]);
    expect(orderStatus.rows[0].status).toBe("IN_TRANSIT");
  });

  test("5) الاستلام: يستلم الـ50 كاملة، وبعدين يكتشف 10 وحدات ناقصة فعليًا - فرق صريح مش عجز مخفي", async () => {
    const received = await request(app).post(`/api/kitchen-transfers/${transferId}/receive`).set(authed(branchManagerToken)).send({
      items: [{ inventoryItemId: sausagePortionId, quantityReceived: 50 }],
    });
    expect(received.status).toBe(200);
    expect(received.body.status).toBe("received"); // مفيش فرق وقت الاستلام نفسه (المُرسل = المُستلم)

    const branchStockAfterReceive = await pool.query("SELECT quantity FROM branch_inventory_stock WHERE branch_id=$1 AND inventory_item_id=$2", [ibrahimiaBranchId, sausagePortionId]);
    expect(Number(branchStockAfterReceive.rows[0].quantity)).toBeCloseTo(50, 5);

    const destBatch = await pool.query(
      "SELECT id FROM inventory_batches WHERE inventory_item_id = $1 AND branch_id = $2", [sausagePortionId, ibrahimiaBranchId]
    );
    branchReceivedBatchId = destBatch.rows[0].id;

    // بعد فتح الكراتين، اتكتشف 10 وحدات هالكة فعليًا - فرق مُكتشف بعد الاستلام (STEP G) مش وقت الاستلام نفسه
    const discrepancy = await request(app).post(`/api/kitchen-transfers/${transferId}/discrepancies`).set(authed(branchManagerToken)).send({
      items: [{ inventoryItemId: sausagePortionId, discrepancyType: "SHORTAGE", quantity: 10, notes: "اتكتشف نقص بعد فتح الكراتين" }],
    });
    expect(discrepancy.status).toBe(201);
    discrepancyId = discrepancy.body[0].id;

    const resolved = await request(app).post(`/api/kitchen-transfers/${transferId}/discrepancies/${discrepancyId}/resolve`).set(authed(branchManagerToken)).send({ action: "RESOLVE" });
    expect(resolved.status).toBe(200);
    expect(resolved.body.status).toBe("RESOLVED");

    const branchStockFinal = await pool.query("SELECT quantity FROM branch_inventory_stock WHERE branch_id=$1 AND inventory_item_id=$2", [ibrahimiaBranchId, sausagePortionId]);
    expect(Number(branchStockFinal.rows[0].quantity)).toBeCloseTo(40, 5); // 50 - 10 الفرق المُسوّى
  });

  test("6) التتبّع للخلف: من دفعة الفرع المستلمة رجوعًا لحد المورد - مفيش أي حلقة اختفت", async () => {
    const trace = await request(app).get(`/api/inventory/batches/${branchReceivedBatchId}/trace`).set(authed(accountantToken));
    expect(trace.status).toBe(200);

    const branchNode = trace.body.backward;
    expect(branchNode.transferredIn).not.toBeNull(); // وصلت عن طريق تحويل
    expect(branchNode.parent).not.toBeNull(); // وسلسلة الأصل بتكمل للخلف

    const portionNode = branchNode.parent;
    expect(portionNode.batch.id).toBe(portionBatchId);
    expect(portionNode.origin.type).toBe("PACKAGING");
    expect(portionNode.parent).not.toBeNull();

    const bulkNode = portionNode.parent;
    expect(bulkNode.batch.id).toBe(bulkBatchId);
    expect(bulkNode.origin.type).toBe("PRODUCTION");
    expect(bulkNode.origin.inputs.length).toBeGreaterThan(0);
    expect(bulkNode.origin.inputs[0].batch_id).toBe(grnBatchId);
    expect(bulkNode.origin.inputs[0].trace).not.toBeNull();
    expect(bulkNode.origin.inputs[0].trace.batch.id).toBe(grnBatchId);
    expect(bulkNode.origin.inputs[0].trace.origin.type).toBe("PURCHASE");
    expect(bulkNode.origin.inputs[0].trace.origin.supplier_name).toBe("مورد لحوم-E2E-جست");
  });

  test("7) التتبّع للأمام: من دفعة الخام الأصلية - بتوصل فعليًا للتصنيع اللي استهلكها", async () => {
    const trace = await request(app).get(`/api/inventory/batches/${grnBatchId}/trace`).set(authed(accountantToken));
    expect(trace.status).toBe(200);
    const consumed = trace.body.forward.consumedInProduction.find((c) => c.production_order_id === bulkOrderId);
    expect(consumed).toBeDefined();
    expect(consumed.output_batch_id).toBe(bulkBatchId);
  });

  test("8) المطابقة المحاسبية: كل القيود اللي اترحّلت للسلسلة دي متزنة (مدين = دائن) - GRN + فاتورة + تصنيع + تعبئة + تحويل + فرق", async () => {
    const entries = await pool.query(
      `SELECT je.id, je.source_type,
              COALESCE(SUM(jel.debit),0) AS total_debit, COALESCE(SUM(jel.credit),0) AS total_credit
       FROM journal_entries je JOIN journal_entry_lines jel ON jel.journal_entry_id = je.id
       WHERE je.source_type IN ('goods_receipt','supplier_invoice','production_order','packaging_order','kitchen_transfer','transfer_discrepancy')
         AND je.source_id IN ($1,$2,$3,$4,$5,$6)
       GROUP BY je.id, je.source_type ORDER BY je.id`,
      [grnId, invoiceId, bulkOrderId, portionOrderId, transferId, discrepancyId]
    );
    expect(entries.rows.length).toBeGreaterThanOrEqual(4); // GRN + تصنيع + تعبئة + تحويل على الأقل (فرق الفاتورة صفر لأنها MATCHED)
    for (const row of entries.rows) {
      expect(Number(row.total_debit)).toBeCloseTo(Number(row.total_credit), 5);
    }

    const totalAcrossChain = entries.rows.reduce((s, r) => s + Number(r.total_debit), 0);
    const totalCreditAcrossChain = entries.rows.reduce((s, r) => s + Number(r.total_credit), 0);
    expect(totalAcrossChain).toBeCloseTo(totalCreditAcrossChain, 5); // متزنة كمجموعة كمان، مش بس فرادى
  });

  test("9) المطابقة المخزنية: افتتاحي + وارد الليدجر - منصرف الليدجر = رصيد ختامي، لكل صنف وكل فرع لمسته السلسلة", async () => {
    // بالنسبة لصنف الحصص في فرع الإبراهيمية: بذرنا حركة استهلاك تاريخية (-40) في beforeAll خصيصًا عشان
    // نغذّي محرك اقتراح الطلبية (STEP E) - نفس أسلوب requisition-suggestion.test.js بالظبط (حركة ليدجر بدون
    // تحديث رصيد فعلي، لأنها مفروض تمثّل تاريخ استهلاك حقيقي سابق مش جزء من سلسلة الـE2E الفعلية دي). الفحص هنا
    // بيقيس صافي حركة سلسلة الـE2E الفعلية بس (من afterOpening الملتقطة في beforeAll)، مش من صفر مطلق
    for (const { branchId, itemId, stock: openingStock, ledgerNet: openingLedgerNet } of openingSnapshot) {
      const ledgerSum = await pool.query(
        "SELECT COALESCE(SUM(quantity),0) AS net FROM inventory_movements WHERE branch_id=$1 AND inventory_item_id=$2",
        [branchId, itemId]
      );
      const stock = await pool.query(
        "SELECT quantity FROM branch_inventory_stock WHERE branch_id=$1 AND inventory_item_id=$2",
        [branchId, itemId]
      );
      const ledgerDeltaSinceOpening = Number(ledgerSum.rows[0].net) - openingLedgerNet;
      const expectedClosingStock = openingStock + ledgerDeltaSinceOpening;
      expect(Number(stock.rows[0].quantity)).toBeCloseTo(expectedClosingStock, 5);
    }
  });
});
