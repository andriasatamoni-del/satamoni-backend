// المرحلة 7K: مصروفات/مشتريات نقدية من شاشة الكاشير - ضد Postgres حقيقي. بيغطي: الكاشير يسجل بس (مقفول
// على فرعه/النهاردة/حالة SUBMITTED-PENDING بالكامل من السيرفر مش من العميل)، الكاشير معندوش صلاحية
// "الإصدار" (review/confirm/reject)، مدير الفرع/المحاسب هما اللي بيراجعوا، وحساب كاش الشيفت المتوقع
// بيشمل المصروفات/المشتريات النقدية من لحظة التسجيل مش لحظة المراجعة (الفلوس خرجت من الدرج فعليًا).
const { app, request, pool, seedUser, login, authed } = require("./helpers");

let branchA, branchB;
let cashierAToken, cashierBToken, managerAToken, managerBToken, accountantToken, adminToken;
let categoryId, cashPmId;

beforeAll(async () => {
  const bA = await pool.query("INSERT INTO branches (name) VALUES ('فرع-كاشير-مصروفات-A-جست') RETURNING id");
  branchA = bA.rows[0].id;
  const bB = await pool.query("INSERT INTO branches (name) VALUES ('فرع-كاشير-مصروفات-B-جست') RETURNING id");
  branchB = bB.rows[0].id;

  await seedUser({ branchId: branchA, name: "كاشير-مصروفات-A", email: "cashierA-exp@jest.test", role: "cashier" });
  await seedUser({ branchId: branchB, name: "كاشير-مصروفات-B", email: "cashierB-exp@jest.test", role: "cashier" });
  await seedUser({ branchId: branchA, name: "مدير-مصروفات-A", email: "managerA-exp@jest.test", role: "branch_manager" });
  await seedUser({ branchId: branchB, name: "مدير-مصروفات-B", email: "managerB-exp@jest.test", role: "branch_manager" });
  await seedUser({ name: "محاسب-مصروفات", email: "accountant-exp@jest.test", role: "accountant" });
  await seedUser({ name: "أدمن-مصروفات", email: "admin-exp@jest.test", role: "admin" });

  cashierAToken = await login("cashierA-exp@jest.test");
  cashierBToken = await login("cashierB-exp@jest.test");
  managerAToken = await login("managerA-exp@jest.test");
  managerBToken = await login("managerB-exp@jest.test");
  accountantToken = await login("accountant-exp@jest.test");
  adminToken = await login("admin-exp@jest.test");

  const ec = await pool.query("INSERT INTO expense_categories (name) VALUES ('بند-كاشير-مصروفات-جست') RETURNING id");
  categoryId = ec.rows[0].id;
  const pm = await pool.query("INSERT INTO payment_methods (name, kind) VALUES ('كاش-كاشير-مصروفات-جست', 'cash') RETURNING id");
  cashPmId = pm.rows[0].id;
});

afterAll(async () => {
  await pool.end();
});

describe("الكاشير يسجل مصروف نقدي - مقفول على فرعه/النهاردة/SUBMITTED من السيرفر", () => {
  test("تسجيل مصروف - بيتفرض branchId/businessDate/status/paymentMethodId من السيرفر حتى لو العميل بعت قيم تانية", async () => {
    const res = await request(app).post("/api/expenses").set(authed(cashierAToken)).send({
      branchId: branchB, // محاولة تسجيل على فرع تاني - المفروض يتجاهلها
      businessDate: "2020-01-01", // محاولة تاريخ تاني - المفروض يتجاهلها
      status: "POSTED", // محاولة يرحّل مباشرة - المفروض يتجاهلها
      categoryId, amount: 50, notes: "اختبار كاشير",
    });
    expect(res.status).toBe(201);
    expect(res.body.branch_id).toBe(branchA);
    expect(res.body.business_date.slice(0, 10)).toBe(new Date().toISOString().slice(0, 10));
    expect(res.body.status).toBe("SUBMITTED");
    expect(res.body.payment_method_id).toBeTruthy();
    const pmRow = await pool.query("SELECT kind FROM payment_methods WHERE id = $1", [res.body.payment_method_id]);
    expect(pmRow.rows[0].kind).toBe("cash");
  });

  test("مبلغ صفر أو ناقص - 400", async () => {
    const res = await request(app).post("/api/expenses").set(authed(cashierAToken)).send({ categoryId, amount: 0 });
    expect(res.status).toBe(400);
  });

  test("الكاشير يشوف مصروفات فرعه بس (مش فرع تاني)", async () => {
    const res = await request(app).get("/api/expenses").set(authed(cashierAToken));
    expect(res.status).toBe(200);
    expect(res.body.every((e) => e.branch_id === branchA)).toBe(true);
  });

  test("الكاشير معندوش صلاحية /:id/review ولا /:id/approve ولا /:id/post خالص", async () => {
    const created = await request(app).post("/api/expenses").set(authed(cashierAToken)).send({ categoryId, amount: 20 });
    const id = created.body.id;
    expect((await request(app).post(`/api/expenses/${id}/review`).set(authed(cashierAToken))).status).toBe(403);
    expect((await request(app).post(`/api/expenses/${id}/approve`).set(authed(cashierAToken))).status).toBe(403);
    expect((await request(app).post(`/api/expenses/${id}/post`).set(authed(cashierAToken))).status).toBe(403);
  });

  test("callcenter معندوش أي صلاحية على المصروفات خالص", async () => {
    await seedUser({ name: "كول سنتر-مصروفات", email: "callcenter-exp@jest.test", role: "callcenter" });
    const ccToken = await login("callcenter-exp@jest.test");
    const res = await request(app).post("/api/expenses").set(authed(ccToken)).send({ categoryId, amount: 10 });
    expect(res.status).toBe(403);
  });
});

describe("مدير الفرع/المحاسب يراجعوا مصروف الكاشير عبر /:id/review", () => {
  test("مدير الفرع بيراجع مصروف كاشير فرعه ويترحّل محاسبيًا (SUBMITTED → POSTED)", async () => {
    const created = await request(app).post("/api/expenses").set(authed(cashierAToken)).send({ categoryId, amount: 75 });
    const id = created.body.id;
    const res = await request(app).post(`/api/expenses/${id}/review`).set(authed(managerAToken));
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("POSTED");
    expect(res.body.journal_entry_id).toBeTruthy();

    const lines = await pool.query(
      "SELECT SUM(debit) AS d, SUM(credit) AS c FROM journal_entry_lines WHERE journal_entry_id = $1",
      [res.body.journal_entry_id]
    );
    expect(Number(lines.rows[0].d)).toBeCloseTo(75, 6);
    expect(Number(lines.rows[0].c)).toBeCloseTo(75, 6);
  });

  test("مدير فرع تاني معندوش صلاحية يراجع مصروف فرع مش بتاعه", async () => {
    const created = await request(app).post("/api/expenses").set(authed(cashierAToken)).send({ categoryId, amount: 30 });
    const res = await request(app).post(`/api/expenses/${created.body.id}/review`).set(authed(managerBToken));
    expect(res.status).toBe(403);
  });

  test("المحاسب بيقدر يراجع مصروف أي فرع", async () => {
    const created = await request(app).post("/api/expenses").set(authed(cashierAToken)).send({ categoryId, amount: 15 });
    const res = await request(app).post(`/api/expenses/${created.body.id}/review`).set(authed(accountantToken));
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("POSTED");
  });

  test("مينفعش تراجع مصروف مش في حالة SUBMITTED (اترحّل بالفعل)", async () => {
    const created = await request(app).post("/api/expenses").set(authed(cashierAToken)).send({ categoryId, amount: 15 });
    await request(app).post(`/api/expenses/${created.body.id}/review`).set(authed(managerAToken));
    const second = await request(app).post(`/api/expenses/${created.body.id}/review`).set(authed(managerAToken));
    expect(second.status).toBe(400);
  });

  test("مدير الفرع لسه يقدر يرفض (يلغي) مصروف كاشير SUBMITTED عبر /:id/cancel الموجود أصلًا", async () => {
    const created = await request(app).post("/api/expenses").set(authed(cashierAToken)).send({ categoryId, amount: 40 });
    const res = await request(app).post(`/api/expenses/${created.body.id}/cancel`).set(authed(managerAToken)).send({ reason: "مصروف مكرر" });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("CANCELLED");
  });
});

describe("الكاشير يسجل مشترى نقدي - مقفول على فرعه/النهاردة/PENDING من السيرفر", () => {
  test("تسجيل مشترى - بيتفرض branchId/businessDate/status من السيرفر", async () => {
    const res = await request(app).post("/api/purchases").set(authed(cashierAToken)).send({
      branchId: branchB, businessDate: "2020-01-01", category: "لحوم", amount: 120, fromKitchen: true,
    });
    expect(res.status).toBe(201);
    expect(res.body.branch_id).toBe(branchA);
    expect(res.body.status).toBe("PENDING");
    expect(res.body.from_kitchen).toBe(false); // اتفرضت false برضه - الكاشير مش هو اللي بيقرر ده
  });

  test("المدير/المحاسب المباشر لسه بيسجل CONFIRMED على طول - مفيش تغيير في سلوكهم", async () => {
    const res = await request(app).post("/api/purchases").set(authed(managerAToken)).send({
      branchId: branchA, businessDate: new Date().toISOString().slice(0, 10), category: "خضار", amount: 90,
    });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe("CONFIRMED");
  });

  test("الكاشير معندوش صلاحية /:id/confirm ولا /:id/reject خالص", async () => {
    const created = await request(app).post("/api/purchases").set(authed(cashierAToken)).send({ category: "بقالة", amount: 25 });
    expect((await request(app).post(`/api/purchases/${created.body.id}/confirm`).set(authed(cashierAToken))).status).toBe(403);
    expect((await request(app).post(`/api/purchases/${created.body.id}/reject`).set(authed(cashierAToken))).status).toBe(403);
  });
});

describe("مدير الفرع/المحاسب يراجعوا مشترى الكاشير", () => {
  test("مدير الفرع بيأكّد مشترى كاشير فرعه (PENDING → CONFIRMED)", async () => {
    const created = await request(app).post("/api/purchases").set(authed(cashierAToken)).send({ category: "أخرى", amount: 60 });
    const res = await request(app).post(`/api/purchases/${created.body.id}/confirm`).set(authed(managerAToken));
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("CONFIRMED");
    expect(res.body.reviewed_by).toBeTruthy();
  });

  test("مدير فرع تاني معندوش صلاحية يأكّد مشترى فرع مش بتاعه", async () => {
    const created = await request(app).post("/api/purchases").set(authed(cashierAToken)).send({ category: "أخرى", amount: 60 });
    const res = await request(app).post(`/api/purchases/${created.body.id}/confirm`).set(authed(managerBToken));
    expect(res.status).toBe(403);
  });

  test("المحاسب بيرفض مشترى بسبب - REJECTED", async () => {
    const created = await request(app).post("/api/purchases").set(authed(cashierAToken)).send({ category: "مشكوك فيه", amount: 999 });
    const res = await request(app).post(`/api/purchases/${created.body.id}/reject`).set(authed(accountantToken)).send({ reason: "مبلغ غير منطقي" });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("REJECTED");
    expect(res.body.rejection_reason).toBe("مبلغ غير منطقي");
  });
});

describe("حساب الكاش المتوقع للشيفت بيشمل مصروفات/مشتريات الكاشير من لحظة التسجيل", () => {
  let shiftId;

  test("فتح شيفت بـ1000 افتتاحي", async () => {
    const res = await request(app).post("/api/shifts/open").set(authed(cashierAToken)).send({ openingCash: 1000 });
    expect(res.status).toBe(201);
    shiftId = res.body.id;
  });

  test("معاينة أولية - مفيش مصروفات/مشتريات لسه، متوقع = 1000", async () => {
    // المرحلة 8.6: /preview بقى مقصور على شيفتس.review (مدير فرع/محاسب/أدمن) - الكاشير مابقاش يشوفه
    const preview = await request(app).get(`/api/shifts/${shiftId}/preview`).set(authed(managerAToken));
    expect(preview.body.cashExpensesTotal).toBe(0);
    expect(preview.body.cashPurchasesTotal).toBe(0);
    expect(preview.body.expectedCash).toBe(1000);
  });

  test("الكاشير يسجل مصروف 80 ومشترى 45 - لسه SUBMITTED/PENDING بس اتحسبوا في المعاينة فورًا", async () => {
    const exp = await request(app).post("/api/expenses").set(authed(cashierAToken)).send({ categoryId, amount: 80 });
    expect(exp.body.status).toBe("SUBMITTED");
    const pur = await request(app).post("/api/purchases").set(authed(cashierAToken)).send({ category: "طوارئ", amount: 45 });
    expect(pur.body.status).toBe("PENDING");

    // المرحلة 8.6: /preview بقى مقصور على شيفتس.review (مدير فرع/محاسب/أدمن) - الكاشير مابقاش يشوفه
    const preview = await request(app).get(`/api/shifts/${shiftId}/preview`).set(authed(managerAToken));
    expect(preview.body.cashExpensesTotal).toBe(80);
    expect(preview.body.cashPurchasesTotal).toBe(45);
    expect(preview.body.expectedCash).toBe(1000 - 80 - 45); // 875 - قبل أي مراجعة من المدير خالص
  });

  test("مدير الفرع يراجع المصروف (يترحّل POSTED) - المعاينة تفضل نفس الرقم (80 لسه محسوبة)", async () => {
    const pending = await pool.query(
      "SELECT id FROM expenses WHERE branch_id = $1 AND status = 'SUBMITTED' AND amount = 80 ORDER BY id DESC LIMIT 1",
      [branchA]
    );
    await request(app).post(`/api/expenses/${pending.rows[0].id}/review`).set(authed(managerAToken));

    // المرحلة 8.6: /preview بقى مقصور على شيفتس.review (مدير فرع/محاسب/أدمن) - الكاشير مابقاش يشوفه
    const preview = await request(app).get(`/api/shifts/${shiftId}/preview`).set(authed(managerAToken));
    expect(preview.body.cashExpensesTotal).toBe(80);
    expect(preview.body.expectedCash).toBe(1000 - 80 - 45);
  });

  test("لو المدير رفض المشترى، بيتشال من حساب الكاش المتوقع (المشترى ده مش معتبر خروج كاش حقيقي)", async () => {
    const pending = await pool.query(
      "SELECT id FROM purchases WHERE branch_id = $1 AND status = 'PENDING' AND amount = 45 ORDER BY id DESC LIMIT 1",
      [branchA]
    );
    await request(app).post(`/api/purchases/${pending.rows[0].id}/reject`).set(authed(managerAToken)).send({ reason: "غير حقيقي" });

    // المرحلة 8.6: /preview بقى مقصور على شيفتس.review (مدير فرع/محاسب/أدمن) - الكاشير مابقاش يشوفه
    const preview = await request(app).get(`/api/shifts/${shiftId}/preview`).set(authed(managerAToken));
    expect(preview.body.cashPurchasesTotal).toBe(0);
    expect(preview.body.expectedCash).toBe(1000 - 80);
  });

  test("قفل الشيفت بالمبلغ المتوقع بالظبط - مفيش فرق كاش", async () => {
    const res = await request(app).post(`/api/shifts/${shiftId}/close`).set(authed(cashierAToken)).send({ actualCash: 920 });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("CLOSED");
    // المرحلة 8.6: الأرقام المالية مش ظاهرة في رد الكاشير - بتتأكد من مدير الفرع
    const managerView = await request(app).get(`/api/shifts/${shiftId}`).set(authed(managerAToken));
    expect(Number(managerView.body.cash_variance)).toBeCloseTo(0, 6);
    expect(Number(managerView.body.cash_purchases_total)).toBe(0);
  });
});
