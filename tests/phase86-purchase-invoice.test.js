// المرحلة 8.6: فاتورة مشترى مواد خام حقيقية من شاشة الكاشير - ضد Postgres حقيقي. الكاشير بيختار
// من كتالوج المواد الخام الموجودة فعلاً (item_type='raw') بس - میقدرش يسجل صنف جديد. الترحيل
// الفعلي للمخزون/المحاسبة (postInventoryMovement + postJournalEntry) بيحصل مرة واحدة بس عند التأكيد
// (/:id/confirm)، بنفس قفل FOR UPDATE بتاع مشترى الكاشير (المرحلة 7K/7U) - بيغطي: التحقق من الكتالوج،
// حساب الإجمالي من السيرفر، عدم تأثر المخزون قبل المراجعة، الترحيل الصحيح عند التأكيد، عدم الترحيل
// المزدوج تحت التزامن، وعزل الفروع
const { app, request, pool, seedUser, login, authed } = require("./helpers");

let branchA, branchB;
let cashierAToken, managerAToken, managerBToken, accountantToken;
let rawItemId, manufacturedItemId;

beforeAll(async () => {
  const bA = await pool.query("INSERT INTO branches (name) VALUES ('فرع-فاتورة-مشترى-A-جست') RETURNING id");
  branchA = bA.rows[0].id;
  const bB = await pool.query("INSERT INTO branches (name) VALUES ('فرع-فاتورة-مشترى-B-جست') RETURNING id");
  branchB = bB.rows[0].id;

  await seedUser({ branchId: branchA, name: "كاشير-فاتورة-مشترى-A", email: "cashierA-pinv@jest.test", role: "cashier" });
  await seedUser({ branchId: branchA, name: "مدير-فاتورة-مشترى-A", email: "managerA-pinv@jest.test", role: "branch_manager" });
  await seedUser({ branchId: branchB, name: "مدير-فاتورة-مشترى-B", email: "managerB-pinv@jest.test", role: "branch_manager" });
  await seedUser({ name: "محاسب-فاتورة-مشترى", email: "accountant-pinv@jest.test", role: "accountant" });

  cashierAToken = await login("cashierA-pinv@jest.test");
  managerAToken = await login("managerA-pinv@jest.test");
  managerBToken = await login("managerB-pinv@jest.test");
  accountantToken = await login("accountant-pinv@jest.test");

  const raw = await pool.query(
    "INSERT INTO inventory_items (name, unit, item_type) VALUES ('دقيق-فاتورة-مشترى-جست', 'كيلو', 'raw') RETURNING id"
  );
  rawItemId = raw.rows[0].id;
  const manufactured = await pool.query(
    "INSERT INTO inventory_items (name, unit, item_type) VALUES ('عجينة-جاهزة-فاتورة-مشترى-جست', 'كيلو', 'manufactured') RETURNING id"
  );
  manufacturedItemId = manufactured.rows[0].id;
});

afterAll(async () => {
  await pool.end();
});

async function getStock(branchId, inventoryItemId) {
  const r = await pool.query(
    "SELECT quantity FROM branch_inventory_stock WHERE branch_id = $1 AND inventory_item_id = $2",
    [branchId, inventoryItemId]
  );
  return r.rows.length ? Number(r.rows[0].quantity) : 0;
}

describe("الكاشير يسجل فاتورة مشترى مواد خام - بنود مش مبلغ حر", () => {
  test("الكاشير بيقدر يسجل فاتورة ببند واحد أو أكتر - PENDING، الإجمالي محسوب من السيرفر", async () => {
    const res = await request(app).post("/api/purchases").set(authed(cashierAToken)).send({
      items: [{ inventoryItemId: rawItemId, quantity: 10, unitPrice: 15 }],
      notes: "مورد الدقيق المعتاد",
    });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe("PENDING");
    expect(res.body.branch_id).toBe(branchA);
    expect(Number(res.body.amount)).toBeCloseTo(150, 6);
    expect(res.body.posted_to_inventory).toBe(false);
  });

  test("الإجمالي بيتحسب من السيرفر مش من العميل - لو العميل بعت amount مختلف بيتجاهله", async () => {
    const res = await request(app).post("/api/purchases").set(authed(cashierAToken)).send({
      items: [{ inventoryItemId: rawItemId, quantity: 2, unitPrice: 20 }],
      amount: 999999,
    });
    expect(res.status).toBe(201);
    expect(Number(res.body.amount)).toBeCloseTo(40, 6);
  });

  test("مينفعش تختار مادة خام غير موجودة في الكتالوج (id وهمي)", async () => {
    const res = await request(app).post("/api/purchases").set(authed(cashierAToken)).send({
      items: [{ inventoryItemId: 99999999, quantity: 1, unitPrice: 5 }],
    });
    expect(res.status).toBe(400);
  });

  test("مينفعش تختار صنف 'مصنّع' - الكاشير بيشتري مواد خام بس", async () => {
    const res = await request(app).post("/api/purchases").set(authed(cashierAToken)).send({
      items: [{ inventoryItemId: manufacturedItemId, quantity: 1, unitPrice: 5 }],
    });
    expect(res.status).toBe(400);
  });

  test("فاتورة قبل المراجعة معندهاش أي أثر على المخزون خالص", async () => {
    const before = await getStock(branchA, rawItemId);
    await request(app).post("/api/purchases").set(authed(cashierAToken)).send({
      items: [{ inventoryItemId: rawItemId, quantity: 5, unitPrice: 10 }],
    });
    const after = await getStock(branchA, rawItemId);
    expect(after).toBeCloseTo(before, 6);
  });
});

describe("مدير الفرع/المحاسب يراجع فاتورة المشترى - الترحيل الفعلي للمخزون + المحاسبة بيحصل هنا بس", () => {
  test("التأكيد بيزوّد رصيد المخزون بالكمية الصح ويعمل قيد محاسبي متوازن DR1400/CR كاش الفرع", async () => {
    const stockBefore = await getStock(branchA, rawItemId);
    const created = await request(app).post("/api/purchases").set(authed(cashierAToken)).send({
      items: [{ inventoryItemId: rawItemId, quantity: 8, unitPrice: 12 }],
    });
    const id = created.body.id;

    const confirmed = await request(app).post(`/api/purchases/${id}/confirm`).set(authed(managerAToken));
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.status).toBe("CONFIRMED");
    expect(confirmed.body.posted_to_inventory).toBe(true);

    const stockAfter = await getStock(branchA, rawItemId);
    expect(stockAfter - stockBefore).toBeCloseTo(8, 6);

    const movement = await pool.query(
      "SELECT * FROM inventory_movements WHERE reference_type = 'purchase' AND reference_id = $1", [id]
    );
    expect(movement.rows.length).toBe(1);
    expect(movement.rows[0].movement_type).toBe("PURCHASE_RECEIPT");

    const je = await pool.query(
      "SELECT * FROM journal_entries WHERE source_type = 'purchase' AND source_id = $1", [id]
    );
    expect(je.rows.length).toBe(1);
    const lines = await pool.query(
      "SELECT SUM(debit) AS d, SUM(credit) AS c FROM journal_entry_lines WHERE journal_entry_id = $1", [je.rows[0].id]
    );
    expect(Number(lines.rows[0].d)).toBeCloseTo(96, 6);
    expect(Number(lines.rows[0].c)).toBeCloseTo(96, 6);
  });

  test("فاتورة بدون بنود (مبلغ حر قديم) لسه شغالة زي الأول - من غير أي أثر مخزون", async () => {
    const created = await request(app).post("/api/purchases").set(authed(cashierAToken)).send({
      category: "أخرى", amount: 60,
    });
    const confirmed = await request(app).post(`/api/purchases/${created.body.id}/confirm`).set(authed(managerAToken));
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.posted_to_inventory).toBe(false);
    const movement = await pool.query(
      "SELECT * FROM inventory_movements WHERE reference_type = 'purchase' AND reference_id = $1", [created.body.id]
    );
    expect(movement.rows.length).toBe(0);
  });

  test("الرفض (reject) مبيرحّلش أي حركة مخزون خالص", async () => {
    const created = await request(app).post("/api/purchases").set(authed(cashierAToken)).send({
      items: [{ inventoryItemId: rawItemId, quantity: 3, unitPrice: 9 }],
    });
    const rejected = await request(app).post(`/api/purchases/${created.body.id}/reject`).set(authed(managerAToken)).send({ reason: "مورد غير موثوق" });
    expect(rejected.status).toBe(200);
    expect(rejected.body.status).toBe("REJECTED");
    const movement = await pool.query(
      "SELECT * FROM inventory_movements WHERE reference_type = 'purchase' AND reference_id = $1", [created.body.id]
    );
    expect(movement.rows.length).toBe(0);
  });

  test("مدير/محاسب بيسجل فاتورة مباشرة CONFIRMED - بترحّل فورًا وقت الإنشاء نفسه", async () => {
    const stockBefore = await getStock(branchA, rawItemId);
    const res = await request(app).post("/api/purchases").set(authed(managerAToken)).send({
      branchId: branchA, businessDate: new Date().toISOString().slice(0, 10),
      items: [{ inventoryItemId: rawItemId, quantity: 4, unitPrice: 11 }],
    });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe("CONFIRMED");
    expect(res.body.posted_to_inventory).toBe(true);
    const stockAfter = await getStock(branchA, rawItemId);
    expect(stockAfter - stockBefore).toBeCloseTo(4, 6);
  });

  test("مدير فرع تاني معندوش صلاحية يأكّد فاتورة فرع مش بتاعه", async () => {
    const created = await request(app).post("/api/purchases").set(authed(cashierAToken)).send({
      items: [{ inventoryItemId: rawItemId, quantity: 1, unitPrice: 5 }],
    });
    const res = await request(app).post(`/api/purchases/${created.body.id}/confirm`).set(authed(managerBToken));
    expect(res.status).toBe(403);
  });

  test("الكاشير میقدرش يشوف تفاصيل فاتورة فرع تاني (GET /:id)", async () => {
    const created = await request(app).post("/api/purchases").set(authed(managerBToken)).send({
      branchId: branchB, businessDate: new Date().toISOString().slice(0, 10), category: "أخرى", amount: 30,
    });
    const res = await request(app).get(`/api/purchases/${created.body.id}`).set(authed(cashierAToken));
    expect(res.status).toBe(403);
  });

  test("GET /:id بيرجّع البنود مع اسم المادة الخام", async () => {
    const created = await request(app).post("/api/purchases").set(authed(cashierAToken)).send({
      items: [{ inventoryItemId: rawItemId, quantity: 2, unitPrice: 7 }],
    });
    const res = await request(app).get(`/api/purchases/${created.body.id}`).set(authed(managerAToken));
    expect(res.status).toBe(200);
    expect(res.body.items.length).toBe(1);
    expect(res.body.items[0].item_name).toBeTruthy();
  });
});

describe("المرحلة 8.6: تزامن - تأكيد فاتورة مشترى مرتين في نفس الوقت مبيرحّلش المخزون/المحاسبة مرتين", () => {
  test("5 نداءات /:id/confirm متزامنة - ترحيل مخزون/محاسبة مرة واحدة بس", async () => {
    const created = await request(app).post("/api/purchases").set(authed(cashierAToken)).send({
      items: [{ inventoryItemId: rawItemId, quantity: 6, unitPrice: 13 }],
    });
    const id = created.body.id;
    const stockBefore = await getStock(branchA, rawItemId);

    const results = await Promise.all(
      Array.from({ length: 5 }, () => request(app).post(`/api/purchases/${id}/confirm`).set(authed(managerAToken)))
    );
    const successCount = results.filter((r) => r.status === 200).length;
    expect(successCount).toBe(1);

    const stockAfter = await getStock(branchA, rawItemId);
    expect(stockAfter - stockBefore).toBeCloseTo(6, 6);

    const movement = await pool.query(
      "SELECT * FROM inventory_movements WHERE reference_type = 'purchase' AND reference_id = $1", [id]
    );
    expect(movement.rows.length).toBe(1);

    const je = await pool.query(
      "SELECT * FROM journal_entries WHERE source_type = 'purchase' AND source_id = $1", [id]
    );
    expect(je.rows.length).toBe(1);
  });
});
