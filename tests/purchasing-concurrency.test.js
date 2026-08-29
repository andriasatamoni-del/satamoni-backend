// MASTER MISSION - PART 19/22: تزامن حقيقي (نداءات متوازية فعليًا، مش تعاقب مصطنع) على فواتير الموردين،
// السداد، وتصدير التحويلات - نفس فلسفة اختبارات التزامن الموجودة فعليًا (phase86-purchase-invoice.test.js،
// production concurrency في recipes-production.test.js) بس على مسارات procurement v2 اللي كانت من غير
// تغطية تزامن مباشرة.
const { app, request, pool, seedUser, login, authed } = require("./helpers");

let branchId, ckBranchId, otherBranchId;
let adminToken, branchManagerToken, ckManagerToken;
let supplierId, itemId, manufacturedItemId;

beforeAll(async () => {
  const b1 = await pool.query("INSERT INTO branches (name) VALUES ('فرع تزامن-مشتريات-جست') RETURNING id");
  branchId = b1.rows[0].id;
  const b2 = await pool.query("INSERT INTO branches (name) VALUES ('فرع تاني تزامن-مشتريات-جست') RETURNING id");
  otherBranchId = b2.rows[0].id;
  const ck = await pool.query("INSERT INTO branches (name, is_central_kitchen) VALUES ('سنتر كيتشن-تزامن-مشتريات-جست', TRUE) RETURNING id");
  ckBranchId = ck.rows[0].id;

  await seedUser({ name: "أدمن-تزامن-مشتريات", email: "admin-purchconc@jest.test", role: "admin" });
  await seedUser({ branchId, name: "مدير فرع-تزامن-مشتريات", email: "manager-purchconc@jest.test", role: "branch_manager" });
  await seedUser({ branchId: ckBranchId, name: "مدير سنتر كيتشن-تزامن-مشتريات", email: "ck-purchconc@jest.test", role: "branch_manager" });
  adminToken = await login("admin-purchconc@jest.test");
  branchManagerToken = await login("manager-purchconc@jest.test");
  ckManagerToken = await login("ck-purchconc@jest.test");

  const item = await pool.query("INSERT INTO inventory_items (name, unit, unit_cost) VALUES ('صنف-تزامن-مشتريات-جست', 'KG', 10) RETURNING id");
  itemId = item.rows[0].id;
  const man = await pool.query("INSERT INTO inventory_items (name, unit, item_type) VALUES ('منتج-تزامن-تحويل-جست', 'KG', 'manufactured') RETURNING id");
  manufacturedItemId = man.rows[0].id;
  await pool.query(
    "INSERT INTO branch_inventory_stock (branch_id, inventory_item_id, quantity) VALUES ($1,$2,50)",
    [ckBranchId, manufacturedItemId]
  );

  const supplier = await request(app).post("/api/suppliers").set(authed(adminToken)).send({ name: "مورد-تزامن-مشتريات-جست" });
  supplierId = supplier.body.id;
});

afterAll(async () => {
  await pool.end();
});

describe("فواتير الموردين: سباق حقيقي على نفس رقم الفاتورة لنفس المورد", () => {
  test("5 نداءات POST متوازية بنفس رقم الفاتورة - وحدة بس بتنجح، والباقي 409 DUPLICATE_INVOICE_NUMBER (مش خطأ خام)", async () => {
    const invoiceNumber = `CONC-INV-${Date.now()}`;
    const payload = {
      supplierId, branchId, supplierInvoiceNumber: invoiceNumber,
      lines: [{ inventoryItemId: itemId, invoicedQuantity: 2, unitPrice: 15 }],
    };
    const results = await Promise.all(
      Array.from({ length: 5 }, () => request(app).post("/api/supplier-invoices").set(authed(adminToken)).send(payload))
    );
    const successes = results.filter((r) => r.status === 201);
    const conflicts = results.filter((r) => r.status === 409);
    expect(successes.length).toBe(1);
    expect(conflicts.length).toBe(4);
    for (const c of conflicts) expect(c.body.code).toBe("DUPLICATE_INVOICE_NUMBER");

    const rows = await pool.query(
      "SELECT id FROM supplier_invoices WHERE supplier_id = $1 AND supplier_invoice_number = $2",
      [supplierId, invoiceNumber]
    );
    expect(rows.rows.length).toBe(1); // القيد الفريد في السكيمة بيمنع أي تكرار فعلي في الداتا مهما كان توقيت النداءات
  });
});

describe("سداد الموردين: سباق حقيقي على نفس الفاتورة - مفيش سداد زيادة عن المتبقي", () => {
  let invoiceId;

  beforeAll(async () => {
    const invRes = await request(app).post("/api/supplier-invoices").set(authed(adminToken)).send({
      supplierId, branchId, supplierInvoiceNumber: `CONC-PAY-INV-${Date.now()}`,
      lines: [{ inventoryItemId: itemId, invoicedQuantity: 10, unitPrice: 10 }], // إجمالي 100
    });
    invoiceId = invRes.body.id;
    await request(app).post(`/api/supplier-invoices/${invoiceId}/approve`).set(authed(adminToken)).expect(200);
  });

  test("5 نداءات سداد متوازية بـ30 لكل واحد على فاتورة إجمالها 100 - يتقبل بس أول 3 (90)، والرابع يترفض", async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        request(app).post("/api/supplier-payments").set(authed(adminToken)).send({
          supplierId, branchId, amount: 30, supplierInvoiceId: invoiceId,
        })
      )
    );
    const successes = results.filter((r) => r.status === 201);
    const rejected = results.filter((r) => r.status === 400);
    // 3×30=90 يتقبلوا (تحت أو يساوي 100)، الرابع (يوصل لـ120) لازم يترفض - القفل (FOR UPDATE) بيمنع
    // اتنين يقروا "المتبقي" في نفس اللحظة ويعدّوا عليه مع بعض
    expect(successes.length).toBe(3);
    expect(rejected.length).toBe(2);

    const totalPaidRes = await pool.query(
      "SELECT COALESCE(SUM(amount),0) AS paid FROM supplier_payments WHERE supplier_invoice_id = $1", [invoiceId]
    );
    expect(Number(totalPaidRes.rows[0].paid)).toBeLessThanOrEqual(100.01);
    expect(Number(totalPaidRes.rows[0].paid)).toBeCloseTo(90, 2);

    const invStatus = await pool.query("SELECT status FROM supplier_invoices WHERE id = $1", [invoiceId]);
    expect(invStatus.rows[0].status).toBe("PARTIALLY_PAID");
  });
});

describe("تصدير التحويل (kitchen-transfers /issue): سباق حقيقي - مفيش خصم مخزون مزدوج", () => {
  let transferId;

  beforeAll(async () => {
    const created = await request(app).post("/api/kitchen-transfers/request").set(authed(ckManagerToken)).send({
      fromBranchId: ckBranchId, toBranchId: branchId, businessDate: "2026-05-01",
      items: [{ inventoryItemId: manufacturedItemId, quantity: 10 }],
    });
    transferId = created.body.id;
    await request(app).post(`/api/kitchen-transfers/${transferId}/approve`).set(authed(adminToken)).expect(200);
  });

  test("5 نداءات /issue متوازية على نفس التحويل - وحدة بس بتنجح، الباقي 400 (مش في حالة قابلة للإصدار)", async () => {
    const stockBefore = await pool.query(
      "SELECT quantity FROM branch_inventory_stock WHERE branch_id = $1 AND inventory_item_id = $2",
      [ckBranchId, manufacturedItemId]
    );
    const results = await Promise.all(
      Array.from({ length: 5 }, () => request(app).post(`/api/kitchen-transfers/${transferId}/issue`).set(authed(ckManagerToken)))
    );
    const successes = results.filter((r) => r.status === 200);
    expect(successes.length).toBe(1);

    const stockAfter = await pool.query(
      "SELECT quantity FROM branch_inventory_stock WHERE branch_id = $1 AND inventory_item_id = $2",
      [ckBranchId, manufacturedItemId]
    );
    // اتخصم 10 مرة واحدة بس، مش 10×5=50 لو مفيش قفل صحيح
    expect(Number(stockBefore.rows[0].quantity) - Number(stockAfter.rows[0].quantity)).toBeCloseTo(10, 5);

    const movements = await pool.query(
      "SELECT * FROM inventory_movements WHERE reference_type='kitchen_transfer' AND reference_id=$1 AND movement_type='TRANSFER_OUT'",
      [transferId]
    );
    expect(movements.rows.length).toBe(1);
  });
});

describe("عزل الفروع - تأكيد إضافي إن السداد/الفواتير الجديدة برضه محكومة بنفس عزل الفروع القديم", () => {
  test("مدير فرع تاني ممنوع يسجل فاتورة مورد لفرع مش بتاعه", async () => {
    const otherManagerId = await seedUser({ branchId: otherBranchId, name: "مدير فرع تالت-تزامن", email: "othermgr-purchconc@jest.test", role: "branch_manager" });
    const otherToken = await login("othermgr-purchconc@jest.test");
    const res = await request(app).post("/api/supplier-invoices").set(authed(otherToken)).send({
      supplierId, branchId, supplierInvoiceNumber: `ISOLATION-${Date.now()}`,
      lines: [{ inventoryItemId: itemId, invoicedQuantity: 1, unitPrice: 5 }],
    });
    expect(res.status).toBe(403);
    void otherManagerId;
  });
});
