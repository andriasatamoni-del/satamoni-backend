// المرحلة 8.45 (تكملة): مصروف/مشترى نقدي سجّله كاشير كان بيترحّل محاسبيًا على خزينة الفرع الرئيسية
// مباشرة بدل درج الكاشير نفسه - رغم إن حساب كاش الشيفت (computeShiftFinancials) دايمًا افترض إنه بيخصم
// من نفس الدرج اللي المبيعات بتدخله. ده كان بيسيب رصيد معلّق في درج الكاشير (بيتصفّى بالصدفة بس وقت
// مراجعة عجز/زيادة الشيفت). الإصلاح: resolveCashCreditAccount في accounting-engine.js - لو اللي سجّل
// القيد "كاشير"، القيد بيروح لدرجه هو؛ مدير/محاسب بيسجّل مباشرة يفضل يروح لخزينة الفرع زي الأول بالظبط
// (مفيش تغيير في سلوكهم). بيغطي: مصروف كاشير (عبر /review)، مشترى كاشير ببنود حقيقية (عبر /confirm)،
// وتأكيد إن مصروف/مشترى مدير مباشر لسه بيروح لخزينة الفرع زي القديم بالظبط.
const { app, request, pool, seedUser, login, authed } = require("./helpers");

let branchA;
let cashierAId, managerAId;
let cashierAToken, managerAToken;
let cashPmId, expenseCategoryId, rawItemId;

beforeAll(async () => {
  const b = await pool.query("INSERT INTO branches (name) VALUES ('فرع توجيه-درج-جست') RETURNING id");
  branchA = b.rows[0].id;

  cashierAId = await seedUser({ branchId: branchA, name: "كاشير-توجيه-درج", email: "cashierA-drawer@jest.test", role: "cashier" });
  managerAId = await seedUser({ branchId: branchA, name: "مدير-توجيه-درج", email: "managerA-drawer@jest.test", role: "branch_manager" });
  cashierAToken = await login("cashierA-drawer@jest.test");
  managerAToken = await login("managerA-drawer@jest.test");

  const pm = await pool.query("INSERT INTO payment_methods (name, kind) VALUES ('كاش-توجيه-درج-جست', 'cash') RETURNING id");
  cashPmId = pm.rows[0].id;
  const ec = await pool.query("INSERT INTO expense_categories (name) VALUES ('بند-توجيه-درج-جست') RETURNING id");
  expenseCategoryId = ec.rows[0].id;
  const raw = await pool.query("INSERT INTO inventory_items (name, unit, item_type) VALUES ('مادة-توجيه-درج-جست', 'كيلو', 'raw') RETURNING id");
  rawItemId = raw.rows[0].id;
});

afterAll(async () => {
  await pool.end();
});

async function creditAccountOf(sourceType, sourceId) {
  const je = await pool.query("SELECT * FROM journal_entries WHERE source_type = $1 AND source_id = $2", [sourceType, sourceId]);
  expect(je.rows.length).toBe(1);
  const lines = await pool.query("SELECT * FROM journal_entry_lines WHERE journal_entry_id = $1", [je.rows[0].id]);
  const creditLine = lines.rows.find((l) => Number(l.credit) > 0);
  const account = await pool.query("SELECT code FROM accounts WHERE id = $1", [creditLine.account_id]);
  return account.rows[0].code;
}

describe("توجيه القيد المحاسبي لمصروف/مشترى نقدي حسب مين سجّله", () => {
  test("مصروف كاشير (عبر /review) بيروح لدرج الكاشير نفسه، مش خزينة الفرع الرئيسية", async () => {
    const created = await request(app).post("/api/expenses").set(authed(cashierAToken)).send({
      categoryId: expenseCategoryId, amount: 120,
    });
    expect(created.status).toBe(201);
    expect(created.body.status).toBe("SUBMITTED");

    const reviewed = await request(app).post(`/api/expenses/${created.body.id}/review`).set(authed(managerAToken));
    expect(reviewed.status).toBe(200);
    expect(reviewed.body.status).toBe("POSTED");

    const creditCode = await creditAccountOf("expense", created.body.id);
    expect(creditCode).toBe(`1100-${branchA}-${cashierAId}`);
  });

  test("مصروف مدير مباشر (POSTED فورًا، كاش) لسه بيروح لخزينة الفرع الرئيسية زي الأول - مفيش تغيير", async () => {
    const created = await request(app).post("/api/expenses").set(authed(managerAToken)).send({
      branchId: branchA, businessDate: new Date().toISOString().slice(0, 10),
      categoryId: expenseCategoryId, amount: 80, paymentMethodId: cashPmId,
    });
    expect(created.status).toBe(201);
    expect(created.body.status).toBe("POSTED");

    const creditCode = await creditAccountOf("expense", created.body.id);
    expect(creditCode).toBe(`1100-${branchA}`);
  });

  test("مشترى كاشير ببنود حقيقية (PENDING ثم /confirm) بيروح لدرج الكاشير نفسه", async () => {
    const created = await request(app).post("/api/purchases").set(authed(cashierAToken)).send({
      items: [{ inventoryItemId: rawItemId, quantity: 4, unitPrice: 25 }],
    });
    expect(created.status).toBe(201);
    expect(created.body.status).toBe("PENDING");

    const confirmed = await request(app).post(`/api/purchases/${created.body.id}/confirm`).set(authed(managerAToken));
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.posted_to_inventory).toBe(true);

    const creditCode = await creditAccountOf("purchase", created.body.id);
    expect(creditCode).toBe(`1100-${branchA}-${cashierAId}`);
  });

  test("مشترى مدير مباشر ببنود (CONFIRMED فورًا) لسه بيروح لخزينة الفرع الرئيسية زي الأول - مفيش تغيير", async () => {
    const created = await request(app).post("/api/purchases").set(authed(managerAToken)).send({
      branchId: branchA, businessDate: new Date().toISOString().slice(0, 10),
      items: [{ inventoryItemId: rawItemId, quantity: 3, unitPrice: 10 }],
    });
    expect(created.status).toBe(201);
    expect(created.body.status).toBe("CONFIRMED");
    expect(created.body.posted_to_inventory).toBe(true);

    const creditCode = await creditAccountOf("purchase", created.body.id);
    expect(creditCode).toBe(`1100-${branchA}`);
  });
});
