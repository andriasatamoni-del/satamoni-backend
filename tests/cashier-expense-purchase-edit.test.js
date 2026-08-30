// المرحلة 8.14: الكاشير يقدر يعدّل مصروف/فاتورة مشترى سجّلها هو بنفسه لحد ما تتراجع (SUBMITTED/PENDING)
// - "اظهار مصاريف الشيفت كلها اللي اتسجلت خلال الشيفت وامكانية التعديل قبل المراجعة". ضد Postgres حقيقي.
// بيغطي: تعديل مصروف/مشترى قبل المراجعة، رفض التعديل بعد المراجعة، عزل الملكية (كاشير تاني/فرع تاني)،
// إعادة حساب إجمالي فاتورة المشترى من بنودها الجديدة، ومدير الفرع/المحاسب يقدروا يعدّلوا أي حاجة PENDING/
// SUBMITTED في نطاقهم (مش بس اللي سجّلوها بأنفسهم).
const { app, request, pool, seedUser, login, authed } = require("./helpers");

let branchA, branchB;
let cashierAToken, cashierA2Token, cashierBToken, managerAToken, accountantToken;
let categoryId, categoryId2;
let rawItemId, rawItemId2;

beforeAll(async () => {
  const bA = await pool.query("INSERT INTO branches (name) VALUES ('فرع-تعديل-مصروف-A-جست') RETURNING id");
  branchA = bA.rows[0].id;
  const bB = await pool.query("INSERT INTO branches (name) VALUES ('فرع-تعديل-مصروف-B-جست') RETURNING id");
  branchB = bB.rows[0].id;

  await seedUser({ branchId: branchA, name: "كاشير-تعديل-1", email: "cashierA1-edit@jest.test", role: "cashier" });
  await seedUser({ branchId: branchA, name: "كاشير-تعديل-2", email: "cashierA2-edit@jest.test", role: "cashier" });
  await seedUser({ branchId: branchB, name: "كاشير-تعديل-ب", email: "cashierB-edit@jest.test", role: "cashier" });
  await seedUser({ branchId: branchA, name: "مدير-تعديل-A", email: "managerA-edit@jest.test", role: "branch_manager" });
  await seedUser({ name: "محاسب-تعديل", email: "accountant-edit@jest.test", role: "accountant" });

  cashierAToken = await login("cashierA1-edit@jest.test");
  cashierA2Token = await login("cashierA2-edit@jest.test");
  cashierBToken = await login("cashierB-edit@jest.test");
  managerAToken = await login("managerA-edit@jest.test");
  accountantToken = await login("accountant-edit@jest.test");

  const ec = await pool.query("INSERT INTO expense_categories (name) VALUES ('بند-تعديل-جست') RETURNING id");
  categoryId = ec.rows[0].id;
  const ec2 = await pool.query("INSERT INTO expense_categories (name) VALUES ('بند-تعديل-٢-جست') RETURNING id");
  categoryId2 = ec2.rows[0].id;
  await pool.query("INSERT INTO payment_methods (name, kind) VALUES ('كاش-تعديل-جست', 'cash')");

  const raw = await pool.query("INSERT INTO inventory_items (name, unit, item_type) VALUES ('مادة-تعديل-1-جست', 'كيلو', 'raw') RETURNING id");
  rawItemId = raw.rows[0].id;
  const raw2 = await pool.query("INSERT INTO inventory_items (name, unit, item_type) VALUES ('مادة-تعديل-2-جست', 'لتر', 'raw') RETURNING id");
  rawItemId2 = raw2.rows[0].id;
});

afterAll(async () => {
  await pool.end();
});

describe("تعديل مصروف كاشير قبل المراجعة (PATCH /api/expenses/:id)", () => {
  let expenseId;

  test("الكاشير يسجل مصروف ثم يعدّل بنده ومبلغه", async () => {
    const created = await request(app).post("/api/expenses").set(authed(cashierAToken)).send({ categoryId, amount: 100 });
    expenseId = created.body.id;
    const res = await request(app).patch(`/api/expenses/${expenseId}`).set(authed(cashierAToken)).send({
      categoryId: categoryId2, amount: 150, notes: "اتصحح",
    });
    expect(res.status).toBe(200);
    expect(res.body.category_id).toBe(categoryId2);
    expect(Number(res.body.amount)).toBeCloseTo(150, 5);
    expect(res.body.notes).toBe("اتصحح");
    expect(res.body.status).toBe("SUBMITTED"); // لسه في انتظار مراجعة، التعديل ملوش تأثير على الحالة
  });

  test("مبلغ صفر أو سالب في التعديل - 400", async () => {
    const res = await request(app).patch(`/api/expenses/${expenseId}`).set(authed(cashierAToken)).send({ amount: 0 });
    expect(res.status).toBe(400);
  });

  test("كاشير تاني في نفس الفرع مش يقدر يعدّل مصروف مش بتاعه", async () => {
    const res = await request(app).patch(`/api/expenses/${expenseId}`).set(authed(cashierA2Token)).send({ amount: 200 });
    expect(res.status).toBe(403);
  });

  test("كاشير فرع تاني مش يقدر يعدّل مصروف فرع مختلف", async () => {
    const res = await request(app).patch(`/api/expenses/${expenseId}`).set(authed(cashierBToken)).send({ amount: 200 });
    expect(res.status).toBe(403);
  });

  test("مدير الفرع يقدر يعدّل مصروف الكاشير حتى لو مش هو اللي سجّله", async () => {
    const res = await request(app).patch(`/api/expenses/${expenseId}`).set(authed(managerAToken)).send({ notes: "راجعها المدير" });
    expect(res.status).toBe(200);
    expect(res.body.notes).toBe("راجعها المدير");
  });

  test("بعد المراجعة (POSTED) - مینفعش يتعدّل خالص", async () => {
    await request(app).post(`/api/expenses/${expenseId}/review`).set(authed(managerAToken));
    const res = await request(app).patch(`/api/expenses/${expenseId}`).set(authed(cashierAToken)).send({ amount: 999 });
    expect(res.status).toBe(400);
  });
});

describe("تعديل فاتورة مشترى كاشير قبل المراجعة (PATCH /api/purchases/:id)", () => {
  let purchaseId;

  test("الكاشير يسجل فاتورة ثم يستبدل بنودها بالكامل - الإجمالي بيتحسب من جديد", async () => {
    const created = await request(app).post("/api/purchases").set(authed(cashierAToken)).send({
      items: [{ inventoryItemId: rawItemId, quantity: 10, unitPrice: 5 }], // 50
    });
    purchaseId = created.body.id;
    expect(Number(created.body.amount)).toBeCloseTo(50, 5);

    const res = await request(app).patch(`/api/purchases/${purchaseId}`).set(authed(cashierAToken)).send({
      items: [
        { inventoryItemId: rawItemId, quantity: 4, unitPrice: 5 },   // 20
        { inventoryItemId: rawItemId2, quantity: 2, unitPrice: 30 }, // 60
      ],
      notes: "صححنا الكمية",
    });
    expect(res.status).toBe(200);
    expect(Number(res.body.amount)).toBeCloseTo(80, 5);
    expect(res.body.notes).toBe("صححنا الكمية");

    const itemsRes = await pool.query("SELECT inventory_item_id, quantity FROM purchase_items WHERE purchase_id = $1 ORDER BY id", [purchaseId]);
    expect(itemsRes.rows.length).toBe(2);
  });

  test("مادة خام مش موجودة في الكتالوج - رفض التعديل بالكامل", async () => {
    const res = await request(app).patch(`/api/purchases/${purchaseId}`).set(authed(cashierAToken)).send({
      items: [{ inventoryItemId: 999999, quantity: 1, unitPrice: 5 }],
    });
    expect(res.status).toBe(400);
    // البنود القديمة (من التعديل الناجح فوق) لازم تفضل زي ما هي، مش اتمسحت
    const itemsRes = await pool.query("SELECT * FROM purchase_items WHERE purchase_id = $1", [purchaseId]);
    expect(itemsRes.rows.length).toBe(2);
  });

  test("كاشير تاني مش يقدر يعدّل فاتورة مش بتاعته", async () => {
    const res = await request(app).patch(`/api/purchases/${purchaseId}`).set(authed(cashierA2Token)).send({
      items: [{ inventoryItemId: rawItemId, quantity: 1, unitPrice: 1 }],
    });
    expect(res.status).toBe(403);
  });

  test("بعد التأكيد (CONFIRMED) - مینفعش يتعدّل خالص، والمخزون اتاثر", async () => {
    await request(app).post(`/api/purchases/${purchaseId}/confirm`).set(authed(managerAToken));
    const res = await request(app).patch(`/api/purchases/${purchaseId}`).set(authed(cashierAToken)).send({
      items: [{ inventoryItemId: rawItemId, quantity: 1, unitPrice: 1 }],
    });
    expect(res.status).toBe(400);
  });

  test("محاسب يقدر يعدّل فاتورة PENDING تانية حتى لو مش هو اللي سجّلها", async () => {
    const created = await request(app).post("/api/purchases").set(authed(cashierAToken)).send({
      items: [{ inventoryItemId: rawItemId, quantity: 1, unitPrice: 10 }],
    });
    const res = await request(app).patch(`/api/purchases/${created.body.id}`).set(authed(accountantToken)).send({
      items: [{ inventoryItemId: rawItemId, quantity: 3, unitPrice: 10 }],
    });
    expect(res.status).toBe(200);
    expect(Number(res.body.amount)).toBeCloseTo(30, 5);
  });
});
