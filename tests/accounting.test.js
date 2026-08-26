// المرحلة 4B: اختبارات المحاسبة (دفتر أستاذ مزدوج القيد) ضد Postgres حقيقي (مش mocks) - شجرة الحسابات،
// توازن القيود إجباريًا (على مستوى القاعدة نفسها مش بس التطبيق)، عدم قابلية التعديل بعد الترحيل، الترحيل
// التلقائي من كل حدث تشغيلي (بيع/استرجاع، استلام بضاعة/إلغاء، سداد مورد، مصروف، هالك، تسوية، تصنيع)،
// الصلاحيات (أدمن/محاسب/مدير فرع/كاشير)، عزل الفروع، القفل المحاسبي، الـidempotency تحت التزامن،
// والتقارير المبنية على الدفتر.
const { app, request, pool, seedUser, login, authed } = require("./helpers");

let branchId, otherBranchId;
let adminToken, accountantToken, managerToken, otherManagerToken, cashierToken;
let flourId;
let menuItemId, variantId;
let supplierId;

async function accountId(code) {
  const r = await pool.query("SELECT id FROM accounts WHERE code = $1", [code]);
  return r.rows[0].id;
}

beforeAll(async () => {
  const b1 = await pool.query("INSERT INTO branches (name) VALUES ('فرع محاسبة-جست') RETURNING id");
  branchId = b1.rows[0].id;
  const b2 = await pool.query("INSERT INTO branches (name) VALUES ('فرع تاني محاسبة-جست') RETURNING id");
  otherBranchId = b2.rows[0].id;

  await seedUser({ name: "أدمن-محاسبة", email: "admin-acct@jest.test", role: "admin" });
  await seedUser({ name: "محاسب-محاسبة", email: "accountant-acct@jest.test", role: "accountant" });
  await seedUser({ branchId, name: "مدير فرع-محاسبة", email: "manager-acct@jest.test", role: "branch_manager" });
  await seedUser({ branchId: otherBranchId, name: "مدير فرع تاني-محاسبة", email: "othermanager-acct@jest.test", role: "branch_manager" });
  await seedUser({ branchId, name: "كاشير-محاسبة", email: "cashier-acct@jest.test", role: "cashier" });

  adminToken = await login("admin-acct@jest.test");
  accountantToken = await login("accountant-acct@jest.test");
  managerToken = await login("manager-acct@jest.test");
  otherManagerToken = await login("othermanager-acct@jest.test");
  cashierToken = await login("cashier-acct@jest.test");

  const flour = await pool.query("INSERT INTO inventory_items (name, unit, unit_cost) VALUES ('دقيق-محاسبة-جست', 'KG', 20) RETURNING id");
  flourId = flour.rows[0].id;
  await pool.query("INSERT INTO branch_inventory_stock (branch_id, inventory_item_id, quantity) VALUES ($1,$2,0),($3,$2,0)", [branchId, flourId, otherBranchId]);

  const cat = await pool.query("INSERT INTO menu_categories (name) VALUES ('بيتزا-محاسبة-جست') RETURNING id");
  const mi = await pool.query("INSERT INTO menu_items (category_id, name) VALUES ($1,'مارجريتا-محاسبة-جست') RETURNING id", [cat.rows[0].id]);
  menuItemId = mi.rows[0].id;
  const variant = await pool.query("INSERT INTO menu_item_variants (item_id, label, price) VALUES ($1,'وسط',100) RETURNING id", [mi.rows[0].id]);
  variantId = variant.rows[0].id;
  // بيتزا = 2 كيلو دقيق (تكلفة 40) - مباشرة في الجدول المسطّح زي باقي ملفات الاختبار (inventory.test.js)
  await pool.query("INSERT INTO menu_item_variant_ingredients (variant_id, inventory_item_id, quantity_per_unit) VALUES ($1,$2,2)", [variantId, flourId]);

  const supplier = await pool.query("INSERT INTO suppliers (name, status) VALUES ('مورد-محاسبة-جست', 'ACTIVE') RETURNING id");
  supplierId = supplier.rows[0].id;
});

afterAll(async () => {
  await pool.end();
});

describe("1) شجرة الحسابات (Chart of Accounts)", () => {
  test("الشجرة الافتراضية موجودة (نظامية، أنواع صحيحة)", async () => {
    const res = await request(app).get("/api/accounting/accounts").set(authed(adminToken));
    expect(res.status).toBe(200);
    const cash = res.body.find((a) => a.code === "1100");
    expect(cash).toBeTruthy();
    expect(cash.is_system_account).toBe(true);
    expect(cash.account_type).toBe("ASSET");
  });

  test("كاشير ممنوع يشوف شجرة الحسابات خالص (مفيش صلاحية accounting.* أبدًا)", async () => {
    const res = await request(app).get("/api/accounting/accounts").set(authed(cashierToken));
    expect(res.status).toBe(403);
  });

  test("محاسب يقدر ينشئ حساب مخصّص (مش نظامي)", async () => {
    const res = await request(app).post("/api/accounting/accounts").set(authed(accountantToken))
      .send({ code: "6950-JEST", name: "حساب مخصّص-جست", accountType: "EXPENSE" });
    expect(res.status).toBe(201);
    expect(res.body.is_system_account).toBe(false);
  });

  test("مدير فرع ممنوع ينشئ حساب (معندوش accounting.create)", async () => {
    const res = await request(app).post("/api/accounting/accounts").set(authed(managerToken))
      .send({ code: "6960-JEST", name: "حساب آخر-جست", accountType: "EXPENSE" });
    expect(res.status).toBe(403);
  });

  test("مينفعش تعطّل حساب نظامي أساسي", async () => {
    const cash = await pool.query("SELECT id FROM accounts WHERE code = '1100'");
    const res = await request(app).patch(`/api/accounting/accounts/${cash.rows[0].id}`).set(authed(accountantToken)).send({ isActive: false });
    expect(res.status).toBe(400);
  });
});

describe("2) القيد اليدوي: توازن إجباري وعدم قابلية التعديل بعد الترحيل (على مستوى القاعدة)", () => {
  test("قيد غير متزن مرفوض (400) قبل ما يتسجل في القاعدة أصلًا", async () => {
    const cash = await accountId("1100");
    const sales = await accountId("4100");
    const res = await request(app).post("/api/accounting/journal-entries").set(authed(accountantToken)).send({
      entryDate: "2026-01-10", branchId, lines: [{ accountId: cash, debit: 100 }, { accountId: sales, credit: 50 }],
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("غير متزن");
  });

  let manualEntryId;
  test("قيد متزن: بينشئ DRAFT ثم يترحّل (/post)", async () => {
    const cash = await accountId("1100");
    const sales = await accountId("4100");
    const create = await request(app).post("/api/accounting/journal-entries").set(authed(accountantToken)).send({
      entryDate: "2026-01-10", description: "قيد يدوي تجريبي", branchId,
      lines: [{ accountId: cash, debit: 100 }, { accountId: sales, credit: 100 }],
    });
    expect(create.status).toBe(201);
    expect(create.body.entry.status).toBe("DRAFT");
    manualEntryId = create.body.entry.id;

    const post = await request(app).post(`/api/accounting/journal-entries/${manualEntryId}/post`).set(authed(accountantToken));
    expect(post.status).toBe(200);
    expect(post.body.status).toBe("POSTED");
  });

  test("تعديل سطر قيد مرحّل مباشرة في القاعدة مرفوض من الـtrigger نفسه (مش بس التطبيق)", async () => {
    await expect(
      pool.query("UPDATE journal_entry_lines SET debit = debit + 1 WHERE journal_entry_id = $1 AND debit > 0", [manualEntryId])
    ).rejects.toThrow(/غير قابل للتعديل/);
  });

  test("مسح قيد مرحّل مباشرة في القاعدة مرفوض من الـtrigger نفسه", async () => {
    await expect(pool.query("DELETE FROM journal_entries WHERE id = $1", [manualEntryId])).rejects.toThrow(/مرحّل بالفعل/);
  });

  test("قيد فردي (سطر واحد بس) داخل معاملة SQL مباشرة - الـCONSTRAINT TRIGGER بيرفض الـCOMMIT نفسه لو مش متزن", async () => {
    const cash = await accountId("1100");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const entry = await client.query(
        `INSERT INTO journal_entries (entry_number, entry_date, source_type, status)
         VALUES ('JE-TEST-UNBALANCED', '2026-01-11', 'manual', 'DRAFT') RETURNING id`
      );
      await client.query("INSERT INTO journal_entry_lines (journal_entry_id, account_id, debit, credit) VALUES ($1,$2,50,0)", [entry.rows[0].id, cash]);
      await expect(client.query("COMMIT")).rejects.toThrow(/غير متزن/);
    } finally {
      await client.query("ROLLBACK").catch(() => {});
      client.release();
    }
  });
});

describe("3) بيع تلقائي: قيد متزن + idempotency + عكس عند الاسترجاع (Void)", () => {
  let orderId, saleEntryId;

  test("توريد دقيق للفرع (مسار قديم مش محاسبي - المشتريات الحقيقية بتعدّي على GRN)", async () => {
    const res = await request(app).post("/api/inventory/purchase-receipt").set(authed(managerToken))
      .send({ branchId, inventoryItemId: flourId, quantity: 100, unitCost: 20 });
    expect(res.status).toBe(201);
  });

  test("بيع بيتزا واحدة (100ج) بيرحّل قيد متزن: كاش/مبيعات + تكلفة/مخزون", async () => {
    const res = await request(app).post("/api/orders").set(authed(managerToken))
      .send({ branchId, source: "pos", orderType: "takeaway", items: [{ itemId: menuItemId, variantId, quantity: 1 }] });
    expect(res.status).toBe(201);
    orderId = res.body.orderId;

    const entry = await pool.query("SELECT * FROM journal_entries WHERE source_type = 'order_sale' AND source_id = $1", [orderId]);
    expect(entry.rows.length).toBe(1);
    expect(entry.rows[0].status).toBe("POSTED");
    saleEntryId = entry.rows[0].id;

    const lines = await pool.query("SELECT jel.*, a.code FROM journal_entry_lines jel JOIN accounts a ON a.id = jel.account_id WHERE journal_entry_id = $1", [saleEntryId]);
    const totalDebit = lines.rows.reduce((s, l) => s + Number(l.debit), 0);
    const totalCredit = lines.rows.reduce((s, l) => s + Number(l.credit), 0);
    expect(totalDebit).toBe(totalCredit);

    const cashLine = lines.rows.find((l) => l.code.startsWith("1100"));
    const salesLine = lines.rows.find((l) => l.code === "4100");
    const cogsLine = lines.rows.find((l) => l.code === "5100");
    const invLine = lines.rows.find((l) => l.code === "1400");
    expect(Number(cashLine.debit)).toBe(100);
    expect(Number(salesLine.credit)).toBe(100);
    expect(Number(cogsLine.debit)).toBe(40); // 2 كيلو × 20ج
    expect(Number(invLine.credit)).toBe(40);
    // كل سطور القيد لازم تحمل نفس الفرع
    lines.rows.forEach((l) => expect(l.branch_id).toBe(branchId));
  });

  test("استرجاع (Void) الطلب بيعكس القيد الأصلي - مش يمسحه، ومتزن بنفس القيمة", async () => {
    const res = await request(app).post(`/api/orders/${orderId}/void`).set(authed(adminToken)).send({ reason: "استرجاع تجريبي" });
    expect(res.status).toBe(200);

    const original = await pool.query("SELECT status FROM journal_entries WHERE id = $1", [saleEntryId]);
    expect(original.rows[0].status).toBe("REVERSED");

    const reversal = await pool.query("SELECT * FROM journal_entries WHERE source_type = 'reversal' AND source_id = $1", [saleEntryId]);
    expect(reversal.rows.length).toBe(1);
    expect(reversal.rows[0].status).toBe("POSTED");

    const revLines = await pool.query("SELECT * FROM journal_entry_lines WHERE journal_entry_id = $1", [reversal.rows[0].id]);
    const revDebit = revLines.rows.reduce((s, l) => s + Number(l.debit), 0);
    const revCredit = revLines.rows.reduce((s, l) => s + Number(l.credit), 0);
    expect(revDebit).toBe(revCredit);
    // المرحلة 7H: 100 (كاش/مبيعات) + 40 (تكلفة/مخزون) + الضريبة المستقطعة من المبيعات (سطر إضافي جديد
    // على حساب 4100 لصالح 2300) - مبلغها بيتغيّر مع vat_rate الحالي فبنجيبه من الطلب نفسه بدل ما نفترضه
    const orderRow = await pool.query("SELECT vat_amount FROM orders WHERE id = $1", [orderId]);
    expect(revDebit).toBeCloseTo(140 + Number(orderRow.rows[0].vat_amount), 6);
  });

  test("Void تاني لنفس الطلب - مينفعش يترحّل قيد عكسي تاني (الطلب أصلًا cancelled)", async () => {
    const res = await request(app).post(`/api/orders/${orderId}/void`).set(authed(adminToken)).send({ reason: "تكرار" });
    expect(res.status).toBe(400);
    const reversalCount = await pool.query("SELECT COUNT(*) FROM journal_entries WHERE source_type = 'reversal' AND source_id = $1", [saleEntryId]);
    expect(Number(reversalCount.rows[0].count)).toBe(1);
  });
});

describe("4) استلام بضاعة (GRN): ترحيل تلقائي + إلغاء بيعكس القيد", () => {
  let poId, poItemId, grnId, grnEntryId;

  test("PO معتمد لـ50 كيلو دقيق بـ25ج/كيلو", async () => {
    const po = await request(app).post("/api/purchase-orders").set(authed(managerToken)).send({
      supplierId, branchId, items: [{ inventoryItemId: flourId, orderedQuantity: 50, unitPrice: 25 }],
    });
    expect(po.status).toBe(201);
    poId = po.body.id;
    await request(app).post(`/api/purchase-orders/${poId}/submit`).set(authed(managerToken)).expect(200);
    await request(app).post(`/api/purchase-orders/${poId}/approve`).set(authed(adminToken)).expect(200);
    const detail = await request(app).get(`/api/purchase-orders/${poId}`).set(authed(adminToken));
    poItemId = detail.body.items[0].id;
  });

  test("استلام كامل الكمية وترحيله - قيد: مدين المخزون 1250 / دائن الموردين 1250", async () => {
    const grn = await request(app).post("/api/goods-receipts").set(authed(managerToken)).send({
      purchaseOrderId: poId, items: [{ purchaseOrderItemId: poItemId, receivedQuantity: 50, acceptedQuantity: 50 }],
    });
    expect(grn.status).toBe(201);
    grnId = grn.body.id;

    const post = await request(app).post(`/api/goods-receipts/${grnId}/post`).set(authed(managerToken));
    expect(post.status).toBe(200);

    const entry = await pool.query("SELECT * FROM journal_entries WHERE source_type = 'goods_receipt' AND source_id = $1", [grnId]);
    expect(entry.rows.length).toBe(1);
    grnEntryId = entry.rows[0].id;
    const lines = await pool.query(
      "SELECT jel.*, a.code FROM journal_entry_lines jel JOIN accounts a ON a.id = jel.account_id WHERE journal_entry_id = $1", [grnEntryId]
    );
    const inv = lines.rows.find((l) => l.code === "1400");
    const ap = lines.rows.find((l) => l.code === "2100");
    expect(Number(inv.debit)).toBe(1250);
    expect(Number(ap.credit)).toBe(1250);
    expect(ap.reference_type).toBe("supplier");
    expect(ap.reference_id).toBe(supplierId);
  });

  test("رصيد المورد بيعكس الـ1250 دائنة", async () => {
    const res = await request(app).get(`/api/supplier-payments/balance/${supplierId}`).set(authed(accountantToken));
    expect(res.status).toBe(200);
    expect(Number(res.body.balance)).toBe(1250);
  });

  test("إلغاء GRN بيعكس القيد ويرجّع رصيد المورد صفر", async () => {
    const res = await request(app).post(`/api/goods-receipts/${grnId}/cancel`).set(authed(managerToken)).send({ reason: "غلط في الاستلام" });
    expect(res.status).toBe(200);

    const original = await pool.query("SELECT status FROM journal_entries WHERE id = $1", [grnEntryId]);
    expect(original.rows[0].status).toBe("REVERSED");

    const balance = await request(app).get(`/api/supplier-payments/balance/${supplierId}`).set(authed(accountantToken));
    expect(Number(balance.body.balance)).toBe(0);
  });
});

describe("5) سداد مورد: قيد + رصيد + idempotency تحت التزامن", () => {
  test("سداد 500ج للمورد - مدين موردين / دائن كاش الفرع", async () => {
    // نعمل عليه دين الأول عشان الرصيد يتحرك بمعنى
    await request(app).post("/api/purchase-orders").set(authed(managerToken)).send({
      supplierId, branchId, items: [{ inventoryItemId: flourId, orderedQuantity: 100, unitPrice: 25 }],
    }).then(async (po) => {
      await request(app).post(`/api/purchase-orders/${po.body.id}/submit`).set(authed(managerToken));
      await request(app).post(`/api/purchase-orders/${po.body.id}/approve`).set(authed(adminToken));
      const detail = await request(app).get(`/api/purchase-orders/${po.body.id}`).set(authed(adminToken));
      const grn = await request(app).post("/api/goods-receipts").set(authed(managerToken)).send({
        purchaseOrderId: po.body.id, items: [{ purchaseOrderItemId: detail.body.items[0].id, receivedQuantity: 100, acceptedQuantity: 100 }],
      });
      await request(app).post(`/api/goods-receipts/${grn.body.id}/post`).set(authed(managerToken));
    });

    const balanceBefore = await request(app).get(`/api/supplier-payments/balance/${supplierId}`).set(authed(accountantToken));
    expect(Number(balanceBefore.body.balance)).toBe(2500); // 100 كيلو × 25ج

    const res = await request(app).post("/api/supplier-payments").set(authed(managerToken)).send({
      supplierId, branchId, amount: 500,
    });
    expect(res.status).toBe(201);
    expect(res.body.journal_entry_id).toBeTruthy();

    const balanceAfter = await request(app).get(`/api/supplier-payments/balance/${supplierId}`).set(authed(accountantToken));
    expect(Number(balanceAfter.body.balance)).toBe(2000);
  });

  test("3 طلبات سداد متزامنة بنفس idempotencyKey - سداد واحد بس بيترحّل فعليًا", async () => {
    const idempotencyKey = "concurrent-payment-jest-1";
    const payload = { supplierId, branchId, amount: 100, idempotencyKey };
    const results = await Promise.all(
      Array.from({ length: 3 }, () => request(app).post("/api/supplier-payments").set(authed(managerToken)).send(payload))
    );
    const successStatuses = results.map((r) => r.status).sort();
    expect(successStatuses).toEqual([200, 200, 201]);
    const ids = new Set(results.map((r) => r.body.id));
    expect(ids.size).toBe(1);

    const payments = await pool.query("SELECT COUNT(*) FROM supplier_payments WHERE idempotency_key = $1", [idempotencyKey]);
    expect(Number(payments.rows[0].count)).toBe(1);
    const entries = await pool.query("SELECT COUNT(*) FROM journal_entries WHERE idempotency_key = $1", [`supplier-payment-${results[0].body.id}`]);
    expect(Number(entries.rows[0].count)).toBe(1);
  });

  // المرحلة 6.5 (متابعة): المحاسب (accountant) دور مركزي (branch_id = NULL) بالتصميم، بس كان
  // assertOwnBranch بيرفضه دايمًا مهما كان الفرع المحدد - رغم إن الـendpoint نفسه صراحة بيقبل صلاحية
  // accounting.create (اللي المحاسب عنده) كبديل لـpurchasing.create. الفحص اتقصر على مدير الفرع بس -
  // نفس النمط المستخدم فعليًا في routes/expenses.js. مدير الفرع لسه ممنوع يسدد لفرع تاني (الاختبار
  // التاني تحت يتأكد من كده - الإصلاح ميضعفش عزل الفروع، بس بيفتح الوصول المركزي الصحيح للمحاسب)
  test("محاسب (دور مركزي، مش مربوط بفرع) يقدر يسدد لأي فرع - كان ممنوع بالغلط قبل كده", async () => {
    const res = await request(app).post("/api/supplier-payments").set(authed(accountantToken)).send({
      supplierId, branchId, amount: 50,
    });
    expect(res.status).toBe(201);
    expect(res.body.journal_entry_id).toBeTruthy();

    const resOtherBranch = await request(app).post("/api/supplier-payments").set(authed(accountantToken)).send({
      supplierId, branchId: otherBranchId, amount: 50,
    });
    expect(resOtherBranch.status).toBe(201);
  });

  test("مدير فرع لسه ممنوع يسدد لفرع تاني غير فرعه - العزل بين الفروع محافَظ عليه بعد الإصلاح", async () => {
    const res = await request(app).post("/api/supplier-payments").set(authed(managerToken)).send({
      supplierId, branchId: otherBranchId, amount: 50,
    });
    expect(res.status).toBe(403);
  });
});

describe("6) دورة حياة المصروف: قديم فوري + DRAFT→SUBMITTED→APPROVED→POSTED→CANCELLED", () => {
  let categoryId, draftExpenseId;

  test("إعداد بند مصروف", async () => {
    const cat = await pool.query("INSERT INTO expense_categories (name) VALUES ('بند-محاسبة-جست') RETURNING id");
    categoryId = cat.rows[0].id;
  });

  test("POST قديم من غير status - بيترحّل فورًا (توافق عكسي)", async () => {
    const res = await request(app).post("/api/expenses").set(authed(managerToken)).send({
      branchId, businessDate: "2026-02-01", categoryId, amount: 300, notes: "إيجار",
    });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe("POSTED");
    expect(res.body.journal_entry_id).toBeTruthy();
  });

  test("مسار DRAFT الاختياري: إنشاء ثم تقديم ثم اعتماد ثم ترحيل", async () => {
    const create = await request(app).post("/api/expenses").set(authed(managerToken)).send({
      branchId, businessDate: "2026-02-02", categoryId, amount: 150, status: "DRAFT",
    });
    expect(create.status).toBe(201);
    draftExpenseId = create.body.id;

    await request(app).post(`/api/expenses/${draftExpenseId}/submit`).set(authed(managerToken)).expect(200);

    const approveDenied = await request(app).post(`/api/expenses/${draftExpenseId}/approve`).set(authed(managerToken));
    expect(approveDenied.status).toBe(403); // مدير الفرع معندوش accounting.approve

    await request(app).post(`/api/expenses/${draftExpenseId}/approve`).set(authed(accountantToken)).expect(200);
    const post = await request(app).post(`/api/expenses/${draftExpenseId}/post`).set(authed(accountantToken));
    expect(post.status).toBe(200);
    expect(post.body.journal_entry_id).toBeTruthy();
  });

  test("إلغاء مصروف مرحّل بعد كده يحتاج صلاحية عكس (أدمن بس) وبيعكس القيد", async () => {
    const denied = await request(app).post(`/api/expenses/${draftExpenseId}/cancel`).set(authed(accountantToken)).send({ reason: "تصحيح" });
    expect(denied.status).toBe(403);

    const res = await request(app).post(`/api/expenses/${draftExpenseId}/cancel`).set(authed(adminToken)).send({ reason: "تصحيح" });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("CANCELLED");

    const expense = await pool.query("SELECT journal_entry_id FROM expenses WHERE id = $1", [draftExpenseId]);
    const entry = await pool.query("SELECT status FROM journal_entries WHERE id = $1", [expense.rows[0].journal_entry_id]);
    expect(entry.rows[0].status).toBe("REVERSED");
  });
});

describe("7) هالك وتسوية مخزون: قيد تلقائي على 5300/1400", () => {
  test("توريد 50 كيلو دقيق إضافية للهالك/التسوية", async () => {
    await request(app).post("/api/inventory/purchase-receipt").set(authed(managerToken))
      .send({ branchId, inventoryItemId: flourId, quantity: 50, unitCost: 20 }).expect(201);
  });

  test("تسجيل هالك 5 كيلو - مدين 5300 (100ج) / دائن 1400 (100ج)", async () => {
    const res = await request(app).post("/api/inventory/waste").set(authed(managerToken)).send({
      branchId, inventoryItemId: flourId, quantity: 5, reason: "تلف", wasteReason: "DAMAGED",
    });
    expect(res.status).toBe(201);

    const entry = await pool.query("SELECT * FROM journal_entries WHERE source_type = 'waste' AND source_id = $1", [res.body.id]);
    expect(entry.rows.length).toBe(1);
    const lines = await pool.query(
      "SELECT jel.*, a.code FROM journal_entry_lines jel JOIN accounts a ON a.id = jel.account_id WHERE journal_entry_id = $1", [entry.rows[0].id]
    );
    const waste = lines.rows.find((l) => l.code === "5300");
    const inv = lines.rows.find((l) => l.code === "1400");
    expect(Number(waste.debit)).toBe(100);
    expect(Number(inv.credit)).toBe(100);
  });

  test("جرد فعلي بعجز 2 كيلو - مدين 5300 (40ج) / دائن 1400 (40ج)", async () => {
    const stock = await pool.query("SELECT quantity FROM branch_inventory_stock WHERE branch_id=$1 AND inventory_item_id=$2", [branchId, flourId]);
    const actualQuantity = Number(stock.rows[0].quantity) - 2;
    const res = await request(app).post("/api/inventory/reconcile").set(authed(managerToken)).send({
      branchId, inventoryItemId: flourId, actualQuantity, notes: "جرد شهري",
    });
    expect(res.status).toBe(201);
    expect(res.body.variance).toBe(-2);

    const movement = await pool.query(
      "SELECT * FROM inventory_movements WHERE branch_id=$1 AND inventory_item_id=$2 AND movement_type='STOCK_COUNT' ORDER BY id DESC LIMIT 1",
      [branchId, flourId]
    );
    const entry = await pool.query("SELECT * FROM journal_entries WHERE source_type = 'stock_count' AND source_id = $1", [movement.rows[0].id]);
    expect(entry.rows.length).toBe(1);
    const lines = await pool.query(
      "SELECT jel.*, a.code FROM journal_entry_lines jel JOIN accounts a ON a.id = jel.account_id WHERE journal_entry_id = $1", [entry.rows[0].id]
    );
    const waste = lines.rows.find((l) => l.code === "5300");
    const inv = lines.rows.find((l) => l.code === "1400");
    expect(Number(waste.debit)).toBe(40);
    expect(Number(inv.credit)).toBe(40);
  });
});

describe("8) تصنيع: قيد تحويل قيمة داخل 1400 (خام→تام) + فرق إنتاج على 5300", () => {
  let doughId, productionOrderId;

  test("إعداد صنف مصنّع (عجينة) بوصفة دقيق فقط + إنشاء أمر تصنيع معتمد ومنفّذ", async () => {
    const dough = await pool.query(
      "INSERT INTO inventory_items (name, unit, unit_cost, item_type) VALUES ('عجينة-محاسبة-جست', 'KG', NULL, 'manufactured') RETURNING id"
    );
    doughId = dough.rows[0].id;
    const recipe = await pool.query("INSERT INTO recipes (recipe_type, inventory_item_id) VALUES ('manufactured_item', $1) RETURNING id", [doughId]);
    const version = await pool.query(
      `INSERT INTO recipe_versions (recipe_id, version_number, yield_quantity, yield_unit, status, created_by)
       VALUES ($1,1,10,'KG','ACTIVE',$2) RETURNING id`,
      [recipe.rows[0].id, (await pool.query("SELECT id FROM users WHERE email='admin-acct@jest.test'")).rows[0].id]
    );
    await pool.query(
      "INSERT INTO recipe_ingredients (recipe_version_id, ingredient_item_id, quantity) VALUES ($1,$2,10)",
      [version.rows[0].id, flourId]
    );

    await request(app).post("/api/inventory/purchase-receipt").set(authed(managerToken))
      .send({ branchId, inventoryItemId: flourId, quantity: 100, unitCost: 20 }).expect(201);

    const create = await request(app).post("/api/production").set(authed(managerToken))
      .send({ branchId, recipeId: recipe.rows[0].id, plannedQuantity: 10 });
    expect(create.status).toBe(201);
    productionOrderId = create.body.id;
    await request(app).post(`/api/production/${productionOrderId}/approve`).set(authed(adminToken)).expect(200);
    await request(app).post(`/api/production/${productionOrderId}/start`).set(authed(managerToken)).expect(200);
  });

  test("إكمال التصنيع بدون فرق (10 فعلي = 10 مخطط) - قيد متزن بدون سطر فرق", async () => {
    const complete = await request(app).post(`/api/production/${productionOrderId}/complete`).set(authed(managerToken))
      .send({ actualQuantity: 10 });
    expect(complete.status).toBe(200);

    const entry = await pool.query("SELECT * FROM journal_entries WHERE source_type = 'production_order' AND source_id = $1", [productionOrderId]);
    expect(entry.rows.length).toBe(1);
    const lines = await pool.query(
      "SELECT jel.*, a.code FROM journal_entry_lines jel JOIN accounts a ON a.id = jel.account_id WHERE journal_entry_id = $1", [entry.rows[0].id]
    );
    const totalDebit = lines.rows.reduce((s, l) => s + Number(l.debit), 0);
    const totalCredit = lines.rows.reduce((s, l) => s + Number(l.credit), 0);
    expect(totalDebit).toBe(totalCredit);
    expect(totalDebit).toBe(200); // 10 كيلو دقيق × 20ج
    // كل السطور على 1400 (تحويل قيمة داخلي)، مفيش سطر فرق لأن الكمية طابقت بالظبط
    expect(lines.rows.every((l) => l.code === "1400")).toBe(true);
  });
});

describe("9) عزل الفروع: كل قيد بيحمل الفرع الصح، ومدير الفرع مايشوفش فرع تاني", () => {
  let otherOrderId;

  test("بيع في الفرع التاني بيرحّل قيد بفرعه الصح", async () => {
    await request(app).post("/api/inventory/purchase-receipt").set(authed(otherManagerToken))
      .send({ branchId: otherBranchId, inventoryItemId: flourId, quantity: 20, unitCost: 20 }).expect(201);

    const res = await request(app).post("/api/orders").set(authed(otherManagerToken))
      .send({ branchId: otherBranchId, source: "pos", orderType: "takeaway", items: [{ itemId: menuItemId, variantId, quantity: 1 }] });
    expect(res.status).toBe(201);
    otherOrderId = res.body.orderId;
    const entry = await pool.query("SELECT branch_id FROM journal_entries WHERE source_type='order_sale' AND source_id=$1", [otherOrderId]);
    expect(entry.rows[0].branch_id).toBe(otherBranchId);
  });

  test("مدير الفرع الأول ممنوع يشوف قيود الفرع التاني حتى لو حدد branchId بتاعه في الكويري", async () => {
    const res = await request(app).get(`/api/reports/general-ledger?accountId=${await accountId("1400")}&branchId=${otherBranchId}`).set(authed(managerToken));
    expect(res.status).toBe(200);
    expect(res.body.branchId).toBe(branchId); // اتفرض على فرعه هو رغم إنه طلب فرع تاني
  });

  test("مدير الفرع ممنوع من تقرير مقارنة الفروع (أدمن/محاسب بس)", async () => {
    const res = await request(app).get("/api/reports/revenue-by-branch?year=2026&month=2").set(authed(managerToken));
    expect(res.status).toBe(403);
  });
});

describe("10) القفل المحاسبي: شهر مقفول يمنع أي ترحيل جديد عليه", () => {
  test("قفل شهر بعيد (يناير 2020) - قيد يدوي بتاريخ فيه مرفوض وقت /post", async () => {
    const close = await request(app).post("/api/accounting/periods/2020/1/close").set(authed(adminToken));
    expect(close.status).toBe(200);
    expect(close.body.status).toBe("CLOSED");

    const cash = await accountId("1100");
    const sales = await accountId("4100");
    const create = await request(app).post("/api/accounting/journal-entries").set(authed(accountantToken)).send({
      entryDate: "2020-01-15", branchId, lines: [{ accountId: cash, debit: 10 }, { accountId: sales, credit: 10 }],
    });
    expect(create.status).toBe(201); // إنشاء الـDRAFT نفسه مسموح، الترحيل بس هو الممنوع

    const post = await request(app).post(`/api/accounting/journal-entries/${create.body.entry.id}/post`).set(authed(accountantToken));
    expect(post.status).toBe(400);
    expect(post.body.error).toContain("مقفول");
  });

  test("مدير فرع ومحاسب ممنوعين من قفل الشهر (أدمن بس)", async () => {
    const managerAttempt = await request(app).post("/api/accounting/periods/2020/2/close").set(authed(managerToken));
    expect(managerAttempt.status).toBe(403);
    const accountantAttempt = await request(app).post("/api/accounting/periods/2020/2/close").set(authed(accountantToken));
    expect(accountantAttempt.status).toBe(403);
  });
});

describe("11) صلاحيات القيود اليدوية والعكس (مصفوفة الأدوار زي ما اتحدد بالظبط)", () => {
  test("مدير فرع ممنوع من إنشاء قيد يدوي (accounting.create معندوش)", async () => {
    const cash = await accountId("1100");
    const sales = await accountId("4100");
    const res = await request(app).post("/api/accounting/journal-entries").set(authed(managerToken)).send({
      entryDate: "2026-03-01", branchId, lines: [{ accountId: cash, debit: 10 }, { accountId: sales, credit: 10 }],
    });
    expect(res.status).toBe(403);
  });

  test("محاسب ممنوع من عكس قيد (accounting.reverse أدمن بس)", async () => {
    const cash = await accountId("1100");
    const sales = await accountId("4100");
    const create = await request(app).post("/api/accounting/journal-entries").set(authed(accountantToken)).send({
      entryDate: "2026-03-01", branchId, lines: [{ accountId: cash, debit: 10 }, { accountId: sales, credit: 10 }],
    });
    await request(app).post(`/api/accounting/journal-entries/${create.body.entry.id}/post`).set(authed(accountantToken)).expect(200);

    const reverseAttempt = await request(app).post(`/api/accounting/journal-entries/${create.body.entry.id}/reverse`)
      .set(authed(accountantToken)).send({ reason: "test" });
    expect(reverseAttempt.status).toBe(403);

    const adminReverse = await request(app).post(`/api/accounting/journal-entries/${create.body.entry.id}/reverse`)
      .set(authed(adminToken)).send({ reason: "test" });
    expect(adminReverse.status).toBe(200);
  });

  test("كاشير ممنوع تمامًا من أي endpoint محاسبي", async () => {
    const accountsRes = await request(app).get("/api/accounting/accounts").set(authed(cashierToken));
    expect(accountsRes.status).toBe(403);
    const journalRes = await request(app).get("/api/accounting/journal-entries").set(authed(cashierToken));
    expect(journalRes.status).toBe(403);
    const reportRes = await request(app).get("/api/reports/trial-balance").set(authed(cashierToken));
    expect(reportRes.status).toBe(403);
  });
});

describe("12) تقارير المحاسبة المبنية على الدفتر", () => {
  test("ميزان المراجعة متزن دايمًا (مجموع مدين = مجموع دائن)", async () => {
    const res = await request(app).get("/api/reports/trial-balance").set(authed(adminToken));
    expect(res.status).toBe(200);
    expect(res.body.balanced).toBe(true);
    // المرحلة 7F: toBeCloseTo بدل toBe - المجموعين بيترحّلوا من جمع أرقام NUMERIC كتير عبر كل قيود
    // النظام (كل ملفات الاختبار مع بعض)، وده عرضة لانحراف تقريب float عادي (فرق فلسات جزء من مليون
    // جنيه) حتى لو كل قيد فردي متزن تمامًا فعليًا (postJournalEntry بيتأكد من كده وقت الإدخال نفسه) -
    // res.body.balanced فوق هو نفسه بيستخدم tolerance مماثل من السيرفر، فمينفعش نطلب هنا دقة أعلى منه
    expect(res.body.totalDebit).toBeCloseTo(res.body.totalCredit, 6);
  });

  test("تقرير أرصدة الموردين وأعمار الديون بيرجعوا 200", async () => {
    const balances = await request(app).get("/api/reports/supplier-balances").set(authed(accountantToken));
    expect(balances.status).toBe(200);
    const aging = await request(app).get("/api/reports/ap-aging").set(authed(accountantToken));
    expect(aging.status).toBe(200);
  });

  test("تقرير المطابقة (Reconciliation) بيرجع فحوصات لكل زوج مصدرين", async () => {
    const res = await request(app).get("/api/reports/accounting-reconciliation?year=2026&month=2").set(authed(adminToken));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.checks)).toBe(true);
    expect(res.body.checks.length).toBeGreaterThanOrEqual(5);
    res.body.checks.forEach((c) => expect(typeof c.matched).toBe("boolean"));
  });
});
