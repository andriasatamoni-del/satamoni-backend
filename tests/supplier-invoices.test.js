// Procurement v2 STEP B: فاتورة المورد - طبقة مطابقة فوق GRN موجودة بالفعل (مفيش تكرار لقيد الـAP).
// ضد Postgres حقيقي زي باقي اختبارات المشروع.
const { app, request, pool, seedUser, login, authed } = require("./helpers");

let branchId, otherBranchId;
let adminToken, managerToken, otherManagerToken, accountantToken;
let supplierId, itemId;

async function createApprovedPo(qty, unitPrice) {
  const po = await request(app).post("/api/purchase-orders").set(authed(managerToken)).send({
    supplierId, branchId, items: [{ inventoryItemId: itemId, orderedQuantity: qty, unitPrice }],
  });
  await request(app).post(`/api/purchase-orders/${po.body.id}/submit`).set(authed(managerToken)).expect(200);
  await request(app).post(`/api/purchase-orders/${po.body.id}/approve`).set(authed(adminToken)).expect(200);
  const detail = await request(app).get(`/api/purchase-orders/${po.body.id}`).set(authed(adminToken));
  return { poId: po.body.id, poItemId: detail.body.items[0].id };
}

beforeAll(async () => {
  const b1 = await pool.query("INSERT INTO branches (name) VALUES ('فرع فواتير-جست') RETURNING id");
  branchId = b1.rows[0].id;
  const b2 = await pool.query("INSERT INTO branches (name) VALUES ('فرع تاني فواتير-جست') RETURNING id");
  otherBranchId = b2.rows[0].id;

  await seedUser({ name: "أدمن-فواتير", email: "admin-inv@jest.test", role: "admin" });
  await seedUser({ branchId, name: "مدير فرع-فواتير", email: "manager-inv@jest.test", role: "branch_manager" });
  await seedUser({ branchId: otherBranchId, name: "مدير فرع تاني-فواتير", email: "othermanager-inv@jest.test", role: "branch_manager" });
  await seedUser({ name: "محاسب-فواتير", email: "accountant-inv@jest.test", role: "accountant" });

  adminToken = await login("admin-inv@jest.test");
  managerToken = await login("manager-inv@jest.test");
  otherManagerToken = await login("othermanager-inv@jest.test");
  accountantToken = await login("accountant-inv@jest.test");

  const supplier = await request(app).post("/api/suppliers").set(authed(adminToken)).send({ name: "مورد فواتير-جست" });
  supplierId = supplier.body.id;

  const item = await pool.query("INSERT INTO inventory_items (name, unit, unit_cost) VALUES ('صنف فواتير-جست', 'KG', 0) RETURNING id");
  itemId = item.rows[0].id;
  await pool.query("INSERT INTO branch_inventory_stock (branch_id, inventory_item_id, quantity) VALUES ($1,$2,0)", [branchId, itemId]);
});

afterAll(async () => {
  await pool.end();
});

describe("Supplier Invoices - matched (variance zero)", () => {
  let grnItemId, invoiceId;

  test("PO + GRN posted @250/unit لـ100 وحدة", async () => {
    const { poId, poItemId } = await createApprovedPo(100, 250);
    const grn = await request(app).post("/api/goods-receipts").set(authed(managerToken)).send({
      purchaseOrderId: poId, items: [{ purchaseOrderItemId: poItemId, receivedQuantity: 100, acceptedQuantity: 100, unitPrice: 250 }],
    });
    expect(grn.status).toBe(201);
    await request(app).post(`/api/goods-receipts/${grn.body.id}/post`).set(authed(managerToken)).expect(200);
    const detail = await request(app).get(`/api/goods-receipts/${grn.body.id}`).set(authed(managerToken));
    grnItemId = detail.body.items[0].id;
  });

  test("فاتورة بنفس سعر الاستلام بالظبط - MATCHED فورًا، الفرق صفر", async () => {
    const res = await request(app).post("/api/supplier-invoices").set(authed(managerToken)).send({
      supplierId, branchId, supplierInvoiceNumber: "INV-MATCH-001",
      lines: [{ goodsReceiptItemId: grnItemId, inventoryItemId: itemId, invoicedQuantity: 100, unitPrice: 250 }],
    });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe("MATCHED");
    expect(Number(res.body.subtotal)).toBe(25000);
    expect(Number(res.body.matched_total)).toBe(25000);
    expect(Number(res.body.variance_amount)).toBe(0);
    invoiceId = res.body.id;
  });

  test("اعتماد فاتورة MATCHED - مفيش قيد فرق يترحّل خالص (الفرق صفر)", async () => {
    const before = await pool.query("SELECT COUNT(*)::int AS n FROM journal_entries WHERE source_type = 'supplier_invoice_variance' AND source_id = $1", [invoiceId]);
    const res = await request(app).post(`/api/supplier-invoices/${invoiceId}/approve`).set(authed(adminToken));
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("APPROVED");
    expect(res.body.variance_journal_entry_id).toBeNull();
    const after = await pool.query("SELECT COUNT(*)::int AS n FROM journal_entries WHERE source_type = 'supplier_invoice_variance' AND source_id = $1", [invoiceId]);
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });

  test("رقم فاتورة مكرر لنفس المورد - 409", async () => {
    const res = await request(app).post("/api/supplier-invoices").set(authed(managerToken)).send({
      supplierId, branchId, supplierInvoiceNumber: "INV-MATCH-001",
      lines: [{ goodsReceiptItemId: grnItemId, inventoryItemId: itemId, invoicedQuantity: 1, unitPrice: 250 }],
    });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("DUPLICATE_INVOICE_NUMBER");
  });

  test("اعتماد فاتورة APPROVED بالفعل - idempotent (duplicate: true)", async () => {
    const res = await request(app).post(`/api/supplier-invoices/${invoiceId}/approve`).set(authed(adminToken));
    expect(res.status).toBe(200);
    expect(res.body.duplicate).toBe(true);
  });

  test("إلغاء فاتورة APPROVED من غير أي سداد عليها - مسموح", async () => {
    const res = await request(app).post(`/api/supplier-invoices/${invoiceId}/cancel`).set(authed(managerToken)).send({ reason: "test" });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("CANCELLED");
  });
});

describe("Supplier Invoices - variance (price higher than GRN)", () => {
  let grnItemId, invoiceId;

  test("PO + GRN posted @250/unit لـ50 وحدة", async () => {
    const { poId, poItemId } = await createApprovedPo(50, 250);
    const grn = await request(app).post("/api/goods-receipts").set(authed(managerToken)).send({
      purchaseOrderId: poId, items: [{ purchaseOrderItemId: poItemId, receivedQuantity: 50, acceptedQuantity: 50, unitPrice: 250 }],
    });
    await request(app).post(`/api/goods-receipts/${grn.body.id}/post`).set(authed(managerToken)).expect(200);
    const detail = await request(app).get(`/api/goods-receipts/${grn.body.id}`).set(authed(managerToken));
    grnItemId = detail.body.items[0].id;
  });

  test("فاتورة بسعر 260 (أعلى من الـGRN 250 لـ50 وحدة) - فرق 500، VARIANCE_PENDING", async () => {
    const res = await request(app).post("/api/supplier-invoices").set(authed(managerToken)).send({
      supplierId, branchId, supplierInvoiceNumber: "INV-VAR-001",
      lines: [{ goodsReceiptItemId: grnItemId, inventoryItemId: itemId, invoicedQuantity: 50, unitPrice: 260 }],
    });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe("VARIANCE_PENDING");
    expect(Number(res.body.subtotal)).toBe(13000);
    expect(Number(res.body.matched_total)).toBe(12500);
    expect(Number(res.body.variance_amount)).toBeCloseTo(500, 5);
    invoiceId = res.body.id;
  });

  test("اعتماد فاتورة فيها فرق - قيد واحد بس بقيمة الفرق (500)، DR 1400 / CR 2100", async () => {
    const res = await request(app).post(`/api/supplier-invoices/${invoiceId}/approve`).set(authed(adminToken));
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("APPROVED");
    expect(res.body.variance_journal_entry_id).not.toBeNull();

    const lines = await pool.query(
      `SELECT jel.debit, jel.credit, a.code FROM journal_entry_lines jel
       JOIN accounts a ON a.id = jel.account_id
       WHERE jel.journal_entry_id = $1 ORDER BY a.code`,
      [res.body.variance_journal_entry_id]
    );
    expect(lines.rows.length).toBe(2);
    const inv1400 = lines.rows.find((l) => l.code === "1400");
    const ap2100 = lines.rows.find((l) => l.code === "2100");
    expect(Number(inv1400.debit)).toBeCloseTo(500, 5);
    expect(Number(ap2100.credit)).toBeCloseTo(500, 5);
  });

  test("إلغاء فاتورة APPROVED فيها قيد فرق - القيد الأصلي بيتعكس (REVERSED)", async () => {
    const invoiceRow = await pool.query("SELECT variance_journal_entry_id FROM supplier_invoices WHERE id = $1", [invoiceId]);
    const jeId = invoiceRow.rows[0].variance_journal_entry_id;

    const res = await request(app).post(`/api/supplier-invoices/${invoiceId}/cancel`).set(authed(managerToken)).send({ reason: "غلط في التسجيل" });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("CANCELLED");

    const je = await pool.query("SELECT status FROM journal_entries WHERE id = $1", [jeId]);
    expect(je.rows[0].status).toBe("REVERSED");
    const reversal = await pool.query("SELECT COUNT(*)::int AS n FROM journal_entries WHERE source_type = 'reversal' AND source_id = $1", [jeId]);
    expect(reversal.rows[0].n).toBe(1);
  });
});

describe("Supplier Invoices - unmatched line (no GRN link)", () => {
  test("سطر فاتورة من غير goodsReceiptItemId - قيمته بالكامل بتترحّل كفرق (مفيش قيد سابق يتكرر معاه)", async () => {
    const res = await request(app).post("/api/supplier-invoices").set(authed(managerToken)).send({
      supplierId, branchId, supplierInvoiceNumber: "INV-UNMATCHED-001",
      lines: [{ inventoryItemId: itemId, invoicedQuantity: 10, unitPrice: 100 }],
    });
    expect(res.status).toBe(201);
    expect(Number(res.body.subtotal)).toBe(1000);
    expect(Number(res.body.matched_total)).toBe(0);
    expect(Number(res.body.variance_amount)).toBeCloseTo(1000, 5);
    expect(res.body.status).toBe("VARIANCE_PENDING");

    const approve = await request(app).post(`/api/supplier-invoices/${res.body.id}/approve`).set(authed(adminToken));
    expect(approve.status).toBe(200);
    const lines = await pool.query(
      `SELECT jel.debit, jel.credit, a.code FROM journal_entry_lines jel
       JOIN accounts a ON a.id = jel.account_id WHERE jel.journal_entry_id = $1`,
      [approve.body.variance_journal_entry_id]
    );
    const inv1400 = lines.rows.find((l) => l.code === "1400");
    expect(Number(inv1400.debit)).toBeCloseTo(1000, 5);
  });
});

describe("Supplier Invoices - guards", () => {
  let grnItemId;

  test("PO + GRN posted @250/unit لـ20 وحدة (لاختبارات الحراسة)", async () => {
    const { poId, poItemId } = await createApprovedPo(20, 250);
    const grn = await request(app).post("/api/goods-receipts").set(authed(managerToken)).send({
      purchaseOrderId: poId, items: [{ purchaseOrderItemId: poItemId, receivedQuantity: 20, acceptedQuantity: 20, unitPrice: 250 }],
    });
    await request(app).post(`/api/goods-receipts/${grn.body.id}/post`).set(authed(managerToken)).expect(200);
    const detail = await request(app).get(`/api/goods-receipts/${grn.body.id}`).set(authed(managerToken));
    grnItemId = detail.body.items[0].id;
  });

  test("فوترة كمية أكبر من المقبول فعليًا في الاستلام - 400", async () => {
    const res = await request(app).post("/api/supplier-invoices").set(authed(managerToken)).send({
      supplierId, branchId, supplierInvoiceNumber: "INV-OVERBILL-001",
      lines: [{ goodsReceiptItemId: grnItemId, inventoryItemId: itemId, invoicedQuantity: 25, unitPrice: 250 }],
    });
    expect(res.status).toBe(400);
  });

  test("فوترة على سطر GRN لسه DRAFT (مش POSTED) - مرفوضة", async () => {
    const { poId, poItemId } = await createApprovedPo(5, 250);
    const draftGrn = await request(app).post("/api/goods-receipts").set(authed(managerToken)).send({
      purchaseOrderId: poId, items: [{ purchaseOrderItemId: poItemId, receivedQuantity: 5, acceptedQuantity: 5, unitPrice: 250 }],
    });
    expect(draftGrn.status).toBe(201);
    expect(draftGrn.body.status).toBe("DRAFT");
    const draftGrnDetail = await request(app).get(`/api/goods-receipts/${draftGrn.body.id}`).set(authed(managerToken));
    const draftGrnItemId = draftGrnDetail.body.items[0].id;

    const res = await request(app).post("/api/supplier-invoices").set(authed(managerToken)).send({
      supplierId, branchId, supplierInvoiceNumber: "INV-DRAFT-GRN-001",
      lines: [{ goodsReceiptItemId: draftGrnItemId, inventoryItemId: itemId, invoicedQuantity: 5, unitPrice: 250 }],
    });
    expect(res.status).toBe(400);
  });

  test("مدير فرع تاني ممنوع يشوف/يعتمد فاتورة الفرع ده", async () => {
    const invRes = await request(app).post("/api/supplier-invoices").set(authed(managerToken)).send({
      supplierId, branchId, supplierInvoiceNumber: "INV-ISOLATION-001",
      lines: [{ inventoryItemId: itemId, invoicedQuantity: 1, unitPrice: 10 }],
    });
    expect(invRes.status).toBe(201);

    const createOtherBranch = await request(app).post("/api/supplier-invoices").set(authed(otherManagerToken)).send({
      supplierId, branchId, supplierInvoiceNumber: "INV-ISOLATION-DENIED",
      lines: [{ inventoryItemId: itemId, invoicedQuantity: 1, unitPrice: 10 }],
    });
    expect(createOtherBranch.status).toBe(403);

    const getOtherBranch = await request(app).get(`/api/supplier-invoices/${invRes.body.id}`).set(authed(otherManagerToken));
    expect(getOtherBranch.status).toBe(403);

    const approveOtherBranch = await request(app).post(`/api/supplier-invoices/${invRes.body.id}/approve`).set(authed(otherManagerToken));
    expect(approveOtherBranch.status).toBe(403);
  });

  test("محاسب ممنوع يعتمد فاتورة (مالوش purchasing.approve)", async () => {
    const invRes = await request(app).post("/api/supplier-invoices").set(authed(managerToken)).send({
      supplierId, branchId, supplierInvoiceNumber: "INV-ACCOUNTANT-DENIED",
      lines: [{ inventoryItemId: itemId, invoicedQuantity: 1, unitPrice: 10 }],
    });
    const res = await request(app).post(`/api/supplier-invoices/${invRes.body.id}/approve`).set(authed(accountantToken));
    expect(res.status).toBe(403);
  });

  test("idempotencyKey مكرر - نفس الفاتورة بترجع من غير تكرار", async () => {
    const key = "supplier-invoice-idem-" + Date.now();
    const payload = {
      supplierId, branchId, supplierInvoiceNumber: "INV-IDEM-001", idempotencyKey: key,
      lines: [{ inventoryItemId: itemId, invoicedQuantity: 1, unitPrice: 10 }],
    };
    const first = await request(app).post("/api/supplier-invoices").set(authed(managerToken)).send(payload);
    expect(first.status).toBe(201);
    const second = await request(app).post("/api/supplier-invoices").set(authed(managerToken)).send(payload);
    expect(second.status).toBe(200);
    expect(second.body.duplicate).toBe(true);
    expect(second.body.id).toBe(first.body.id);
    const count = await pool.query("SELECT COUNT(*) FROM supplier_invoices WHERE idempotency_key = $1", [key]);
    expect(Number(count.rows[0].count)).toBe(1);
  });

  test("مينفعش تلغي فاتورة اتسدد عليها بالفعل (سداد مربوط بيها مباشرة)", async () => {
    const invRes = await request(app).post("/api/supplier-invoices").set(authed(managerToken)).send({
      supplierId, branchId, supplierInvoiceNumber: "INV-PAID-GUARD-001",
      lines: [{ inventoryItemId: itemId, invoicedQuantity: 1, unitPrice: 10 }],
    });
    // STEP C (تخصيص السداد على فاتورة) لسه مش مبني - بنحاكي وجود سداد مربوط مباشرة على الجدول عشان نتأكد
    // إن حارس الإلغاء شغال صح بمجرد وجود العمود (supplier_payments.supplier_invoice_id من STEP A)
    await pool.query(
      `INSERT INTO supplier_payments (supplier_id, branch_id, amount, supplier_invoice_id, created_by)
       VALUES ($1,$2,$3,$4,$5)`,
      [supplierId, branchId, 10, invRes.body.id, null]
    );
    const cancel = await request(app).post(`/api/supplier-invoices/${invRes.body.id}/cancel`).set(authed(managerToken)).send({ reason: "test" });
    expect(cancel.status).toBe(400);
  });
});

// Procurement v2 STEP C: تخصيص سداد المورد على فاتورة محددة (routes/supplier-payments.js) - نفس القيد
// المحاسبي بالظبط (DR 2100 / CR كاش)، بس بيتتبّع "المتبقي" على الفاتورة ويحدّث حالتها
describe("Supplier Payments - invoice allocation (STEP C)", () => {
  async function createApprovedInvoice(invoiceNumber, total) {
    const created = await request(app).post("/api/supplier-invoices").set(authed(managerToken)).send({
      supplierId, branchId, supplierInvoiceNumber: invoiceNumber,
      lines: [{ inventoryItemId: itemId, invoicedQuantity: 1, unitPrice: total }],
    });
    expect(created.status).toBe(201);
    const approved = await request(app).post(`/api/supplier-invoices/${created.body.id}/approve`).set(authed(adminToken));
    expect(approved.status).toBe(200);
    return approved.body;
  }

  test("سداد كامل المبلغ دفعة واحدة - الفاتورة بتتحول PAID", async () => {
    const invoice = await createApprovedInvoice("INV-PAY-FULL-001", 1000);
    const res = await request(app).post("/api/supplier-payments").set(authed(managerToken)).send({
      supplierId, branchId, amount: 1000, supplierInvoiceId: invoice.id,
    });
    expect(res.status).toBe(201);
    expect(res.body.supplier_invoice_id).toBe(invoice.id);

    const invAfter = await request(app).get(`/api/supplier-invoices/${invoice.id}`).set(authed(managerToken));
    expect(invAfter.body.invoice.status).toBe("PAID");
    expect(invAfter.body.payments.length).toBe(1);
  });

  test("سداد على مرحلتين (جزئي ثم مكمل) - PARTIALLY_PAID ثم PAID", async () => {
    const invoice = await createApprovedInvoice("INV-PAY-PARTIAL-001", 1000);
    const first = await request(app).post("/api/supplier-payments").set(authed(managerToken)).send({
      supplierId, branchId, amount: 400, supplierInvoiceId: invoice.id,
    });
    expect(first.status).toBe(201);
    let invMid = await request(app).get(`/api/supplier-invoices/${invoice.id}`).set(authed(managerToken));
    expect(invMid.body.invoice.status).toBe("PARTIALLY_PAID");

    const second = await request(app).post("/api/supplier-payments").set(authed(managerToken)).send({
      supplierId, branchId, amount: 600, supplierInvoiceId: invoice.id,
    });
    expect(second.status).toBe(201);
    const invFinal = await request(app).get(`/api/supplier-invoices/${invoice.id}`).set(authed(managerToken));
    expect(invFinal.body.invoice.status).toBe("PAID");
    expect(invFinal.body.payments.length).toBe(2);
  });

  test("سداد أكبر من المتبقي على الفاتورة - مرفوض", async () => {
    const invoice = await createApprovedInvoice("INV-PAY-OVER-001", 500);
    const res = await request(app).post("/api/supplier-payments").set(authed(managerToken)).send({
      supplierId, branchId, amount: 600, supplierInvoiceId: invoice.id,
    });
    expect(res.status).toBe(400);
  });

  test("سداد جزئي ثم محاولة سداد يتخطى المتبقي - مرفوض حتى لو المبلغ نفسه أقل من الإجمالي", async () => {
    const invoice = await createApprovedInvoice("INV-PAY-OVER-002", 500);
    await request(app).post("/api/supplier-payments").set(authed(managerToken)).send({
      supplierId, branchId, amount: 300, supplierInvoiceId: invoice.id,
    }).expect(201);
    const res = await request(app).post("/api/supplier-payments").set(authed(managerToken)).send({
      supplierId, branchId, amount: 300, supplierInvoiceId: invoice.id,
    });
    expect(res.status).toBe(400);
  });

  test("سداد على فاتورة لسه مش معتمدة (MATCHED/VARIANCE_PENDING) - مرفوض", async () => {
    const created = await request(app).post("/api/supplier-invoices").set(authed(managerToken)).send({
      supplierId, branchId, supplierInvoiceNumber: "INV-PAY-UNAPPROVED-001",
      lines: [{ inventoryItemId: itemId, invoicedQuantity: 1, unitPrice: 100 }],
    });
    expect(created.status).toBe(201);
    expect(created.body.status).toBe("VARIANCE_PENDING");
    const res = await request(app).post("/api/supplier-payments").set(authed(managerToken)).send({
      supplierId, branchId, amount: 100, supplierInvoiceId: created.body.id,
    });
    expect(res.status).toBe(400);
  });

  test("سداد بفرع مختلف عن فرع الفاتورة - مرفوض", async () => {
    const invoice = await createApprovedInvoice("INV-PAY-BRANCH-001", 100);
    const res = await request(app).post("/api/supplier-payments").set(authed(otherManagerToken)).send({
      supplierId, branchId: otherBranchId, amount: 100, supplierInvoiceId: invoice.id,
    });
    expect(res.status).toBe(400);
  });

  test("idempotencyKey على سداد مخصص لفاتورة - مفيش تكرار في السداد ولا في تحديث حالة الفاتورة", async () => {
    const invoice = await createApprovedInvoice("INV-PAY-IDEM-001", 200);
    const key = "supplier-payment-invoice-idem-" + Date.now();
    const payload = { supplierId, branchId, amount: 200, supplierInvoiceId: invoice.id, idempotencyKey: key };
    const first = await request(app).post("/api/supplier-payments").set(authed(managerToken)).send(payload);
    expect(first.status).toBe(201);
    const second = await request(app).post("/api/supplier-payments").set(authed(managerToken)).send(payload);
    expect(second.status).toBe(200);
    expect(second.body.duplicate).toBe(true);

    const count = await pool.query("SELECT COUNT(*) FROM supplier_payments WHERE supplier_invoice_id = $1", [invoice.id]);
    expect(Number(count.rows[0].count)).toBe(1);
    const invAfter = await request(app).get(`/api/supplier-invoices/${invoice.id}`).set(authed(managerToken));
    expect(invAfter.body.invoice.status).toBe("PAID");
  });

  test("سداد من غير supplierInvoiceId لسه شغال زي الأول (سداد عام على رصيد المورد)", async () => {
    const res = await request(app).post("/api/supplier-payments").set(authed(managerToken)).send({
      supplierId, branchId, amount: 50,
    });
    expect(res.status).toBe(201);
    expect(res.body.supplier_invoice_id).toBeNull();
  });
});
