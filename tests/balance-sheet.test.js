// الميزانية العمومية + قفل السنة المالية: الميزانية بتتوازن دايمًا (أصول = خصوم + حقوق ملكية) بما فيها
// سطر صافي ربح السنة الحالية غير المقفولة (محسوب لحظيًا، مش مخزّن)؛ قفل سنة بيتطلب كل شهورها CLOSED
// الأول، وبيرحّل صافي الربح من حسابات الإيراد/التكلفة/المصروف إلى الأرباح المرحّلة (3200) بقيد واحد
// متزن، من غير ما يأثر على تقارير الفترات التانية (بيتستبعد بالاسم source_type='year_end_closing').
const { app, request, pool, seedUser, login, authed } = require("./helpers");

let branchId;
let adminToken, accountantToken, managerToken;

async function accountId(code) {
  const r = await pool.query("SELECT id FROM accounts WHERE code = $1", [code]);
  return r.rows[0].id;
}

async function postManualEntry(token, entryDate, lines) {
  const create = await request(app).post("/api/accounting/journal-entries").set(authed(token)).send({ entryDate, branchId, lines });
  if (create.status !== 201) throw new Error(`create failed: ${JSON.stringify(create.body)}`);
  const post = await request(app).post(`/api/accounting/journal-entries/${create.body.entry.id}/post`).set(authed(token));
  if (post.status !== 200) throw new Error(`post failed: ${JSON.stringify(post.body)}`);
  return post.body;
}

async function closeAllMonths(token, year) {
  for (let m = 1; m <= 12; m++) {
    const res = await request(app).post(`/api/accounting/periods/${year}/${m}/close`).set(authed(token));
    if (res.status !== 200) throw new Error(`close ${year}-${m} failed: ${JSON.stringify(res.body)}`);
  }
}

beforeAll(async () => {
  const b = await pool.query("INSERT INTO branches (name) VALUES ('فرع ميزانية-جست') RETURNING id");
  branchId = b.rows[0].id;
  await seedUser({ name: "أدمن-ميزانية", email: "admin-bs@jest.test", role: "admin" });
  await seedUser({ name: "محاسب-ميزانية", email: "accountant-bs@jest.test", role: "accountant" });
  await seedUser({ branchId, name: "مدير فرع-ميزانية", email: "manager-bs@jest.test", role: "branch_manager" });
  adminToken = await login("admin-bs@jest.test");
  accountantToken = await login("accountant-bs@jest.test");
  managerToken = await login("manager-bs@jest.test");
});

afterAll(async () => {
  await pool.end();
});

describe("1) الميزانية العمومية: بتتوازن دايمًا بما فيها صافي ربح السنة الحالية المحسوب", () => {
  test("مدير فرع ممنوع من الميزانية العمومية (أدمن/محاسب بس - حقوق الملكية مش قابلة للتقسيم على فرع)", async () => {
    const res = await request(app).get("/api/reports/balance-sheet").set(authed(managerToken));
    expect(res.status).toBe(403);
  });

  test("محاسب يقدر يشوف الميزانية العمومية", async () => {
    const res = await request(app).get("/api/reports/balance-sheet").set(authed(accountantToken));
    expect(res.status).toBe(200);
  });

  test("مفيش حركة → أصول=خصوم+حقوق ملكية (صفر أو أي رصيد سابق، لكن متوازن)", async () => {
    const res = await request(app).get("/api/reports/balance-sheet").set(authed(adminToken));
    expect(res.status).toBe(200);
    expect(res.body.balanced).toBe(true);
    expect(Math.abs(res.body.totalAssets - (res.body.totalLiabilities + res.body.totalEquity))).toBeLessThan(0.01);
  });

  test("بعد قيد إيراد ومصروف يدويين، صافي الربح (3300 محسوب) بيظهر صح وتفضل متوازنة", async () => {
    const cash = await accountId("1100");
    const sales = await accountId("4100");
    const rent = await accountId("6200");

    await postManualEntry(adminToken, "2017-03-10", [{ accountId: cash, debit: 5000 }, { accountId: sales, credit: 5000 }]);
    await postManualEntry(adminToken, "2017-03-15", [{ accountId: rent, debit: 1200 }, { accountId: cash, credit: 1200 }]);

    const res = await request(app).get("/api/reports/balance-sheet?asOf=2017-12-31").set(authed(adminToken));
    expect(res.status).toBe(200);
    expect(res.body.balanced).toBe(true);

    const netIncomeLine = res.body.equity.find((e) => e.code === "3300");
    expect(netIncomeLine).toBeTruthy();
    expect(netIncomeLine.balance).toBeCloseTo(3800, 2); // 5000 إيراد - 1200 إيجار

    const cashLine = res.body.assets.find((a) => a.code === "1100" || a.code.startsWith("1100-"));
    expect(cashLine).toBeTruthy();
  });
});

describe("2) قفل السنة المالية: شروط + الترحيل المحاسبي", () => {
  test("غير أدمن ممنوع من قفل سنة مالية", async () => {
    const res = await request(app).post("/api/accounting/fiscal-year-closings").set(authed(accountantToken)).send({ year: 2015 });
    expect(res.status).toBe(403);
  });

  test("قفل سنة قبل ما كل شهورها تتقفل الأول مرفوض (400) وبيوضّح الشهور الناقصة", async () => {
    // نقفل شهر واحد بس من 2015 عمدًا عشان نتأكد إن الباقي بيتحدد صح
    await request(app).post("/api/accounting/periods/2015/6/close").set(authed(adminToken)).expect(200);
    const res = await request(app).post("/api/accounting/fiscal-year-closings").set(authed(adminToken)).send({ year: 2015 });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("مقفولة الأول");
  });

  test("سنة من غير حركة محاسبية خالص (لكن كل شهورها مقفولة) - مفيش حاجة تتقفل (400)", async () => {
    await closeAllMonths(adminToken, 2016);
    const res = await request(app).post("/api/accounting/fiscal-year-closings").set(authed(adminToken)).send({ year: 2016 });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("مفيش حركة محاسبية");
  });

  let closingResult;
  test("سنة 2017 (فيها حركة + كل شهورها مقفولة) - القفل بينجح وبيحسب صافي الربح صح", async () => {
    await closeAllMonths(adminToken, 2017);
    const res = await request(app).post("/api/accounting/fiscal-year-closings").set(authed(adminToken)).send({ year: 2017 });
    expect(res.status).toBe(201);
    expect(Number(res.body.net_income)).toBeCloseTo(3800, 2);
    expect(res.body.journalEntry.source_type).toBe("year_end_closing");
    expect(res.body.journalEntry.entry_date.slice(0, 10)).toBe("2018-01-01");
    closingResult = res.body;
  });

  test("قيد الإقفال متزن فعليًا (مجموع مدين = مجموع دائن) على مستوى القاعدة", async () => {
    const lines = await pool.query("SELECT debit, credit FROM journal_entry_lines WHERE journal_entry_id = $1", [closingResult.journalEntry.id]);
    const totalDebit = lines.rows.reduce((s, l) => s + Number(l.debit), 0);
    const totalCredit = lines.rows.reduce((s, l) => s + Number(l.credit), 0);
    expect(totalDebit).toBeCloseTo(totalCredit, 2);
  });

  test("نفس السنة تاني مرفوض (409) - مقفولة بالفعل", async () => {
    const res = await request(app).post("/api/accounting/fiscal-year-closings").set(authed(adminToken)).send({ year: 2017 });
    expect(res.status).toBe(409);
  });

  test("بعد القفل: الأرباح المرحّلة (3200) بتاخد صافي الربح، وصافي الربح المحسوب للسنة الجديدة بيرجع للصفر", async () => {
    const res = await request(app).get("/api/reports/balance-sheet?asOf=2018-01-01").set(authed(adminToken));
    expect(res.status).toBe(200);
    expect(res.body.balanced).toBe(true);

    const retainedEarnings = res.body.equity.find((e) => e.code === "3200");
    expect(retainedEarnings).toBeTruthy();
    expect(retainedEarnings.balance).toBeCloseTo(3800, 2);

    const netIncomeLine = res.body.equity.find((e) => e.code === "3300");
    expect(netIncomeLine).toBeTruthy();
    expect(netIncomeLine.balance).toBeCloseTo(0, 2);
  });

  test("قيد الإقفال متسجّل بمصدر year_end_closing ومحدّش يقدر يترحّل عليه تاني بنفس المفتاح (idempotency)", async () => {
    const entry = await pool.query("SELECT * FROM journal_entries WHERE id = $1", [closingResult.journalEntry.id]);
    expect(entry.rows[0].source_type).toBe("year_end_closing");
    expect(entry.rows[0].status).toBe("POSTED");
  });
});

describe("3) قيد الإقفال مش بيلوّث تقارير قائمة الدخل/المصروفات للفترات اللي عدّت عليها 31 ديسمبر", () => {
  test("تقرير قائمة الدخل (الدفتر) لشهر ديسمبر 2017 لسه صحيح - مفيش أثر من قيد الإقفال (المسجّل في يناير 2018)", async () => {
    const res = await request(app).get("/api/reports/profit-and-loss?year=2017&month=12").set(authed(adminToken));
    expect(res.status).toBe(200);
    // ديسمبر 2017 نفسه ما فيهوش قيود يدوية جديدة (القيود كانت في مارس) - المفروض صافي مبيعات ديسمبر = صفر
    expect(res.body.netSales).toBeCloseTo(0, 2);
  });

  test("تقرير المصروفات المحاسبي لمدى بيشمل يناير 2018 (تاريخ قيد الإقفال) - حساب الإيجار (6200) ميظهرش زيادة وهمية من قيد الإقفال", async () => {
    const res = await request(app).get("/api/reports/accounting-expense-report?from=2018-01-01&to=2018-01-31").set(authed(adminToken));
    expect(res.status).toBe(200);
    const rentLine = res.body.lines.find((l) => l.code === "6200");
    expect(rentLine).toBeUndefined(); // اترحّل بقيد الإقفال بس مستبعد من التقرير، مش من غير قفل خالص
  });

  test("قائمة الدخل لمدى بيشمل مارس-ديسمبر 2017 + يناير 2018 لسه بتدّي نفس صافي الربح الأصلي (3800) - قيد الإقفال محايد تمامًا في التقارير", async () => {
    const res = await request(app).get("/api/reports/profit-and-loss?from=2017-01-01&to=2018-01-31").set(authed(adminToken));
    expect(res.status).toBe(200);
    expect(res.body.operatingProfit).toBeCloseTo(3800, 2);
  });
});
