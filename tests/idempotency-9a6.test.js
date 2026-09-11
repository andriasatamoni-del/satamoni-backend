// المرحلة 9A-6: idempotency-key اختياري لـPOST /api/stocktake وتصحيح سطر الجرد وPOST /api/inventory/
// reconcile وPOST /api/treasuries/:id/transfer - retry شبكة/دبل كليك بنفس المفتاح لازم يرجّع نفس
// النتيجة الأصلية من غير ما يسجّل أثر مخزون/محاسبي مضاعف
const { app, request, pool, seedUser, login, authed } = require("./helpers");
const { getOrCreateMainTreasury } = require("../db/accounting-engine");

let branchId;
let managerToken, accountantToken, adminToken;
let itemId;

beforeAll(async () => {
  const b = await pool.query("INSERT INTO branches (name) VALUES ('فرع 9A6-idempotency-جست') RETURNING id");
  branchId = b.rows[0].id;
  await seedUser({ branchId, name: "مدير-9A6", email: "manager-9a6@jest.test", role: "branch_manager" });
  await seedUser({ branchId, name: "محاسب-9A6", email: "accountant-9a6@jest.test", role: "accountant" });
  await seedUser({ name: "أدمن-9A6", email: "admin-9a6@jest.test", role: "admin" });
  managerToken = await login("manager-9a6@jest.test");
  accountantToken = await login("accountant-9a6@jest.test");
  adminToken = await login("admin-9a6@jest.test");

  const item = await pool.query("INSERT INTO inventory_items (name, unit, unit_cost) VALUES ('خامة-9A6-جست', 'كيلو', 10) RETURNING id");
  itemId = item.rows[0].id;
  await pool.query("INSERT INTO branch_inventory_stock (branch_id, inventory_item_id, quantity) VALUES ($1,$2,100)", [branchId, itemId]);
});

afterAll(async () => {
  await pool.end();
});

describe("POST /api/stocktake - idempotencyKey", () => {
  test("نفس المفتاح مرتين -> ثاني مرة بترجّع نفس الجلسة (200 duplicate:true) من غير تسجيل فرق تاني", async () => {
    const key = `stocktake-9a6-${Date.now()}`;
    const first = await request(app).post("/api/stocktake").set(authed(managerToken)).send({
      branchId, idempotencyKey: key, lines: [{ inventoryItemId: itemId, actualQuantity: 90 }],
    });
    expect(first.status).toBe(201);
    expect(first.body.lines.length).toBe(1);

    const second = await request(app).post("/api/stocktake").set(authed(managerToken)).send({
      branchId, idempotencyKey: key, lines: [{ inventoryItemId: itemId, actualQuantity: 90 }],
    });
    expect(second.status).toBe(200);
    expect(second.body.duplicate).toBe(true);
    expect(second.body.id).toBe(first.body.id);

    const stocktakes = await pool.query("SELECT id FROM stocktakes WHERE idempotency_key = $1", [key]);
    expect(stocktakes.rows.length).toBe(1);
    const stock = await pool.query("SELECT quantity FROM branch_inventory_stock WHERE branch_id=$1 AND inventory_item_id=$2", [branchId, itemId]);
    expect(Number(stock.rows[0].quantity)).toBe(90); // اتخصمت مرة واحدة بس (كانت 100)
  });

  test("من غير idempotencyKey - نفس السلوك القديم، كل نداء جلسة جرد مستقلة", async () => {
    const first = await request(app).post("/api/stocktake").set(authed(managerToken)).send({
      branchId, lines: [{ inventoryItemId: itemId, actualQuantity: 95 }],
    });
    expect(first.status).toBe(201);
    const second = await request(app).post("/api/stocktake").set(authed(managerToken)).send({
      branchId, lines: [{ inventoryItemId: itemId, actualQuantity: 95 }],
    });
    expect(second.status).toBe(201);
    expect(second.body.id).not.toBe(first.body.id);
  });
});

describe("POST /api/stocktake/:id/lines/:lineId/correct - idempotencyKey", () => {
  let stocktakeId, lineId;

  beforeAll(async () => {
    const st = await request(app).post("/api/stocktake").set(authed(managerToken)).send({
      branchId, lines: [{ inventoryItemId: itemId, actualQuantity: 80 }],
    });
    stocktakeId = st.body.id;
    lineId = st.body.lines[0].id;
  });

  test("نفس مفتاح التصحيح مرتين -> ثاني مرة بترجّع نفس التصحيح (200 duplicate:true) من غير delta تاني", async () => {
    const key = `correct-9a6-${Date.now()}`;
    const first = await request(app).post(`/api/stocktake/${stocktakeId}/lines/${lineId}/correct`).set(authed(managerToken)).send({
      correctedActualQuantity: 82, idempotencyKey: key,
    });
    expect(first.status).toBe(201);

    const second = await request(app).post(`/api/stocktake/${stocktakeId}/lines/${lineId}/correct`).set(authed(managerToken)).send({
      correctedActualQuantity: 82, idempotencyKey: key,
    });
    expect(second.status).toBe(200);
    expect(second.body.duplicate).toBe(true);
    expect(second.body.id).toBe(first.body.id);

    const corrections = await pool.query("SELECT id FROM stocktake_line_corrections WHERE idempotency_key = $1", [key]);
    expect(corrections.rows.length).toBe(1);
  });
});

describe("POST /api/inventory/reconcile - idempotencyKey", () => {
  // reconcile بياخد كمية فعلية مطلقة (مش فرق) - فطلب مكرر بنفس الكمية المستهدفة طبيعي بيحسب فرق=صفر
  // مقابل الرصيد اللي اتحدّث بالفعل من المحاولة الأولى (القفل FOR UPDATE بتاع 6A.3 بيضمن الترتيب ده حتى
  // لو الطلبين اتبعتوا فعليًا في نفس اللحظة) - فمفيش تسجيل تاني يحصل أصلًا، من غير ما يحتاج حتى يوصل
  // لفحص idempotencyKey جوه postInventoryMovement. idempotencyKey هنا لسه بيتمرّر وبيتخزّن (نفس نمط
  // /waste بالظبط) كطبقة حماية إضافية، لكن الحماية الأساسية من التكرار موجودة أصلًا بتصميم الـendpoint
  test("نفس المفتاح والكمية المستهدفة مرتين -> الرصيد بيتطبّق مرة واحدة بس (فرق صفر طبيعي في المحاولة التانية)", async () => {
    const key = `reconcile-9a6-${Date.now()}`;
    const before = await pool.query("SELECT quantity FROM branch_inventory_stock WHERE branch_id=$1 AND inventory_item_id=$2", [branchId, itemId]);
    const target = Number(before.rows[0].quantity) - 5;

    const first = await request(app).post("/api/inventory/reconcile").set(authed(managerToken)).send({
      branchId, inventoryItemId: itemId, actualQuantity: target, idempotencyKey: key,
    });
    expect(first.status).toBe(201);
    expect(first.body.duplicate).toBe(false);
    expect(first.body.variance).toBe(-5);

    const second = await request(app).post("/api/inventory/reconcile").set(authed(managerToken)).send({
      branchId, inventoryItemId: itemId, actualQuantity: target, idempotencyKey: key,
    });
    expect(second.status).toBe(201);
    expect(second.body.variance).toBe(0); // الرصيد بقى مطابق بالفعل - مفيش فرق يتسجل تاني

    const after = await pool.query("SELECT quantity FROM branch_inventory_stock WHERE branch_id=$1 AND inventory_item_id=$2", [branchId, itemId]);
    expect(Number(after.rows[0].quantity)).toBe(target); // اتطبق مرة واحدة بس

    const movements = await pool.query("SELECT id FROM inventory_movements WHERE idempotency_key = $1", [key]);
    expect(movements.rows.length).toBe(1);
  });

  test("من غير idempotencyKey - نفس السلوك القديم", async () => {
    const before = await pool.query("SELECT quantity FROM branch_inventory_stock WHERE branch_id=$1 AND inventory_item_id=$2", [branchId, itemId]);
    const res = await request(app).post("/api/inventory/reconcile").set(authed(managerToken)).send({
      branchId, inventoryItemId: itemId, actualQuantity: Number(before.rows[0].quantity) - 1,
    });
    expect(res.status).toBe(201);
    expect(res.body.duplicate).toBe(false);
  });
});

describe("POST /api/treasuries/:id/transfer - idempotencyKey", () => {
  let mainTreasuryId, bankTreasuryId;

  beforeAll(async () => {
    const bankRes = await request(app).post("/api/banks").set(authed(adminToken)).send({ name: `بنك-9A6-${Date.now()}` });
    const acctRes = await request(app).post("/api/banks/accounts").set(authed(adminToken)).send({ bankId: bankRes.body.id, name: "حساب 9A6" });
    bankTreasuryId = acctRes.body.treasury_id;

    const { treasury: mainTreasury } = await getOrCreateMainTreasury(pool, branchId);
    mainTreasuryId = mainTreasury.id;
  });

  test("نفس المفتاح مرتين -> ثاني مرة بترجّع نفس القيد (200 duplicate:true) من غير تحويل مضاعف", async () => {
    const key = `transfer-9a6-${Date.now()}`;
    const first = await request(app).post(`/api/treasuries/${mainTreasuryId}/transfer`).set(authed(accountantToken)).send({
      toTreasuryId: bankTreasuryId, amount: 200, idempotencyKey: key,
    });
    expect(first.status).toBe(201);
    expect(first.body.duplicate).toBe(false);

    const second = await request(app).post(`/api/treasuries/${mainTreasuryId}/transfer`).set(authed(accountantToken)).send({
      toTreasuryId: bankTreasuryId, amount: 200, idempotencyKey: key,
    });
    expect(second.status).toBe(200);
    expect(second.body.duplicate).toBe(true);
    expect(second.body.journalEntry.id).toBe(first.body.journalEntry.id);

    const entries = await pool.query("SELECT id FROM journal_entries WHERE idempotency_key = $1", [key]);
    expect(entries.rows.length).toBe(1);
  });
});
