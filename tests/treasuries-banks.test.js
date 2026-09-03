// المرحلة 8.42: خزائن افتراضية (خزينة رئيسية للفرع + درج لحظي لكل كاشير أثناء شيفته) + البنوك -
// ضد Postgres حقيقي زي كل اختبارات المشروع. بيغطي: توجيه الكاش لحظيًا لدرج الكاشير أثناء الشيفت
// (مش لخزينة الفرع مباشرة)، الرجوع للسلوك القديم لما مفيش شيفت نشط، تسليم الدرج وقت القفل، تصفية
// الفرق التلقائية/بالإقرار/بالاعتماد (سلفة/زيادة) على درج الكاشير مش خزينة الفرع مباشرة، القفل القسري،
// واجهة GET /api/treasuries + POST /:id/transfer، وCRUD البنوك/حساباتها البنكية مع الصلاحيات.
const { app, request, pool, seedUser, login, authed } = require("./helpers");
const { getOrCreateBranchCashAccount } = require("../db/accounting-engine");

let branchA;
let cashierToken, cashierWithEmployeeToken, managerToken, accountantToken, adminToken;
let cashierId, cashierWithEmployeeId, managerId;
let cashPmId, itemId, variantId; // سعر 1000
let mainAccountCode;

async function treasuryBalance(accountId) {
  const r = await pool.query(
    `SELECT COALESCE(SUM(jel.debit) - SUM(jel.credit), 0) AS balance
     FROM journal_entry_lines jel JOIN journal_entries je ON je.id = jel.journal_entry_id
     WHERE jel.account_id = $1 AND je.status <> 'DRAFT'`,
    [accountId]
  );
  return Number(r.rows[0].balance);
}

async function cashierTreasuryAccountId(userId) {
  const r = await pool.query("SELECT id FROM accounts WHERE code = $1", [`1100-${branchA}-${userId}`]);
  return r.rows[0]?.id || null;
}

async function mainTreasuryAccountId() {
  const r = await pool.query("SELECT id FROM accounts WHERE code = $1", [`1100-${branchA}`]);
  return r.rows[0].id;
}

async function sellCash(token, amount) {
  return request(app).post("/api/orders").set(authed(token)).send({
    branchId: branchA, source: "pos", orderType: "takeaway", paymentMethodId: cashPmId,
    items: [{ itemId, variantId, quantity: Math.round(amount / 1000) }],
  });
}

beforeAll(async () => {
  const b = await pool.query("INSERT INTO branches (name) VALUES ('فرع خزائن-جست') RETURNING id");
  branchA = b.rows[0].id;
  mainAccountCode = `1100-${branchA}`;

  cashierId = await seedUser({ branchId: branchA, name: "كاشير-خزائن", email: "cashier-treasury@jest.test", role: "cashier" });
  cashierWithEmployeeId = await seedUser({ branchId: branchA, name: "كاشير-موظف-خزائن", email: "cashier-emp-treasury@jest.test", role: "cashier" });
  managerId = await seedUser({ branchId: branchA, name: "مدير-خزائن", email: "manager-treasury@jest.test", role: "branch_manager" });
  await seedUser({ branchId: branchA, name: "محاسب-خزائن", email: "accountant-treasury@jest.test", role: "accountant" });
  await seedUser({ name: "أدمن-خزائن", email: "admin-treasury@jest.test", role: "admin" });

  await pool.query(
    "INSERT INTO employees (name, department, attendance_system, base_salary, restricted_branch_id, user_id) VALUES ('كاشير-موظف-خزائن','مبيعات','manual',3000,$1,$2)",
    [branchA, cashierWithEmployeeId]
  );

  cashierToken = await login("cashier-treasury@jest.test");
  cashierWithEmployeeToken = await login("cashier-emp-treasury@jest.test");
  managerToken = await login("manager-treasury@jest.test");
  accountantToken = await login("accountant-treasury@jest.test");
  adminToken = await login("admin-treasury@jest.test");

  const pm = await pool.query("INSERT INTO payment_methods (name, kind) VALUES ('كاش-خزائن-جست', 'cash') RETURNING id");
  cashPmId = pm.rows[0].id;

  const cat = await pool.query("INSERT INTO menu_categories (name) VALUES ('خزائن-جست-قسم') RETURNING id");
  const mi = await pool.query("INSERT INTO menu_items (category_id, name) VALUES ($1,'صنف-خزائن-جست') RETURNING id", [cat.rows[0].id]);
  itemId = mi.rows[0].id;
  const v = await pool.query("INSERT INTO menu_item_variants (item_id, label, price) VALUES ($1,'عادي',1000) RETURNING id", [itemId]);
  variantId = v.rows[0].id;

  // نضمن وجود خزينة الفرع الرئيسية من الأول (بدل ما نستنى أول عملية كاش تنشئها) عشان الاختبارات
  // اللي بتاخد "قبل"/"بعد" على رصيدها تبدأ من فرع فعلًا عنده حساب مسجّل
  await getOrCreateBranchCashAccount(pool, branchA);
});

afterAll(async () => {
  await pool.end();
});

describe("توجيه الكاش لحظيًا لدرج الكاشير أثناء الشيفت", () => {
  test("بيع كاش من غير شيفت نشط بيروح لخزينة الفرع الرئيسية مباشرة (السلوك القديم)", async () => {
    const before = await treasuryBalance(await mainTreasuryAccountId());
    const res = await sellCash(cashierToken, 1000);
    expect(res.status).toBe(201);
    const after = await treasuryBalance(await mainTreasuryAccountId());
    expect(after - before).toBe(1000);
  });

  test("بيع كاش أثناء شيفت نشط بيروح لدرج الكاشير، مش لخزينة الفرع", async () => {
    const open = await request(app).post("/api/shifts/open").set(authed(cashierToken)).send({ openingCash: 0 });
    expect(open.status).toBe(201);
    const mainBefore = await treasuryBalance(await mainTreasuryAccountId());

    const res = await sellCash(cashierToken, 1000);
    expect(res.status).toBe(201);

    const cashierAccId = await cashierTreasuryAccountId(cashierId);
    expect(cashierAccId).not.toBeNull();
    expect(await treasuryBalance(cashierAccId)).toBe(1000);
    expect(await treasuryBalance(await mainTreasuryAccountId())).toBe(mainBefore); // مفيش تغيير في الخزينة الرئيسية لحد التسليم

    // ننضّف الشيفت عشان الاختبارات الجاية تبدأ من درج فاضي
    await request(app).post(`/api/shifts/${open.body.id}/close`).set(authed(cashierToken)).send({ actualCash: 1000 });
  });
});

describe("تسليم الدرج وقت قفل الشيفت + تصفية الفرق", () => {
  test("تطابق تام (فرق صفر): الدرج بيتفضّى بالكامل والخزينة الرئيسية بتزيد بنفس المبلغ", async () => {
    const open = await request(app).post("/api/shifts/open").set(authed(cashierToken)).send({ openingCash: 0 });
    await sellCash(cashierToken, 1000);
    const mainBefore = await treasuryBalance(await mainTreasuryAccountId());

    const close = await request(app).post(`/api/shifts/${open.body.id}/close`).set(authed(cashierToken)).send({ actualCash: 1000 });
    expect(close.status).toBe(200);
    expect(close.body.status).toBe("CLOSED");

    const cashierAccId = await cashierTreasuryAccountId(cashierId);
    expect(await treasuryBalance(cashierAccId)).toBe(0);
    expect(await treasuryBalance(await mainTreasuryAccountId())).toBe(mainBefore + 1000);
  });

  test("فرق تافه (جوّه حد الاعتماد 20) بيتصفّى تلقائيًا على 6950 وقت القفل - الدرج بيرجع صفر", async () => {
    const open = await request(app).post("/api/shifts/open").set(authed(cashierToken)).send({ openingCash: 0 });
    await sellCash(cashierToken, 1000);
    const mainBefore = await treasuryBalance(await mainTreasuryAccountId());
    const writeoffAcc = await pool.query("SELECT id FROM accounts WHERE code = '6950'");
    const writeoffBefore = await treasuryBalance(writeoffAcc.rows[0].id);

    const close = await request(app).post(`/api/shifts/${open.body.id}/close`).set(authed(cashierToken)).send({ actualCash: 990 });
    expect(close.status).toBe(200);
    expect(close.body.status).toBe("CLOSED"); // استجابة الكاشير مصفّاة (بدون variance_status) - راجع sanitizeShiftForCashier

    const cashierAccId = await cashierTreasuryAccountId(cashierId);
    expect(await treasuryBalance(cashierAccId)).toBe(0); // 1000 - 990 (تسليم) - 10 (تصفية) = 0
    expect(await treasuryBalance(await mainTreasuryAccountId())).toBe(mainBefore + 990);
    expect(await treasuryBalance(writeoffAcc.rows[0].id)).toBe(writeoffBefore + 10);

    const je = await pool.query(
      "SELECT * FROM journal_entries WHERE source_type = 'shift_variance_writeoff' AND source_id = $1",
      [open.body.id]
    );
    expect(je.rows.length).toBe(1);
  });

  test("فرق فوق العتبة + إقرار المدير (acknowledge) - لازم يتصفّى الفرق برضو (سلوك جديد)", async () => {
    const open = await request(app).post("/api/shifts/open").set(authed(cashierToken)).send({ openingCash: 0 });
    await sellCash(cashierToken, 1000);

    const close = await request(app).post(`/api/shifts/${open.body.id}/close`).set(authed(cashierToken)).send({ actualCash: 940 }); // عجز 60
    expect(close.status).toBe(200);
    expect(close.body.status).toBe("PENDING_REVIEW");

    const cashierAccId = await cashierTreasuryAccountId(cashierId);
    expect(await treasuryBalance(cashierAccId)).toBe(60); // لسه معلّق - مفيش سلفة ولا تصفية لحد المراجعة

    const review = await request(app).post(`/api/shifts/${open.body.id}/review`).set(authed(managerToken)).send({ decision: "acknowledge" });
    expect(review.status).toBe(200);
    expect(review.body.status).toBe("CLOSED");
    expect(review.body.variance_status).toBe("ACKNOWLEDGED");

    expect(await treasuryBalance(cashierAccId)).toBe(0); // اتصفّى بقيد فروق كاش

    const je = await pool.query(
      "SELECT * FROM journal_entries WHERE source_type = 'shift_variance_writeoff' AND source_id = $1",
      [open.body.id]
    );
    expect(je.rows.length).toBe(1);

    const debtJe = await pool.query(
      "SELECT * FROM journal_entries WHERE source_type = 'shift_variance_debt' AND source_id = $1",
      [open.body.id]
    );
    expect(debtJe.rows.length).toBe(0); // إقرار مش موافقة - مفيش سلفة خالص
  });

  test("فرق فوق العتبة + موافقة المدير (approve) عجز - سلفة موظف حقيقية على درج الكاشير مش خزينة الفرع", async () => {
    const open = await request(app).post("/api/shifts/open").set(authed(cashierWithEmployeeToken)).send({ openingCash: 0 });
    await sellCash(cashierWithEmployeeToken, 1000);
    const mainBefore = await treasuryBalance(await mainTreasuryAccountId());

    const close = await request(app).post(`/api/shifts/${open.body.id}/close`).set(authed(cashierWithEmployeeToken)).send({ actualCash: 940 }); // عجز 60
    expect(close.body.status).toBe("PENDING_REVIEW");

    const review = await request(app).post(`/api/shifts/${open.body.id}/review`).set(authed(managerToken)).send({ decision: "approve" });
    expect(review.status).toBe(200);
    expect(review.body.variance_status).toBe("APPROVED");

    const debtJe = await pool.query(
      "SELECT je.*, jel.account_id, jel.debit, jel.credit FROM journal_entries je JOIN journal_entry_lines jel ON jel.journal_entry_id = je.id WHERE je.source_type = 'shift_variance_debt' AND je.source_id = $1",
      [open.body.id]
    );
    expect(debtJe.rows.length).toBe(2);
    const cashierAccId = await cashierTreasuryAccountId(cashierWithEmployeeId);
    const creditLine = debtJe.rows.find((r) => Number(r.credit) > 0);
    expect(creditLine.account_id).toBe(cashierAccId); // مش خزينة الفرع الرئيسية
    expect(Number(creditLine.credit)).toBe(60);

    expect(await treasuryBalance(cashierAccId)).toBe(0); // 1000 - 940 (تسليم) - 60 (سلفة) = 0
    expect(await treasuryBalance(await mainTreasuryAccountId())).toBe(mainBefore + 940); // بس الفعلي اللي اتسلّم

    const adj = await pool.query("SELECT * FROM payroll_adjustments WHERE shift_id = $1", [open.body.id]);
    expect(adj.rows.length).toBe(1);
    expect(Number(adj.rows[0].amount)).toBe(60);
  });

  test("فرق فوق العتبة + موافقة المدير (approve) زيادة - إيراد آخر من درج الكاشير", async () => {
    const open = await request(app).post("/api/shifts/open").set(authed(cashierWithEmployeeToken)).send({ openingCash: 0 });
    await sellCash(cashierWithEmployeeToken, 1000);
    const mainBefore = await treasuryBalance(await mainTreasuryAccountId());
    const revAcc = await pool.query("SELECT id FROM accounts WHERE code = '4300'");
    const revBefore = await treasuryBalance(revAcc.rows[0].id);

    const close = await request(app).post(`/api/shifts/${open.body.id}/close`).set(authed(cashierWithEmployeeToken)).send({ actualCash: 1060 }); // زيادة 60
    expect(close.body.status).toBe("PENDING_REVIEW");

    const review = await request(app).post(`/api/shifts/${open.body.id}/review`).set(authed(managerToken)).send({ decision: "approve" });
    expect(review.status).toBe(200);

    const cashierAccId = await cashierTreasuryAccountId(cashierWithEmployeeId);
    expect(await treasuryBalance(cashierAccId)).toBe(0); // 1000 - 1060 (تسليم) + 60 (زيادة) = 0
    expect(await treasuryBalance(await mainTreasuryAccountId())).toBe(mainBefore + 1060);
    // 4300 حساب إيراد (رصيده الطبيعي دائن) - treasuryBalance بتحسب مدين-دائن (صيغة الأصول)، فزيادة
    // الإيراد بتقلّل الرقم ده (تزيد الدائن) مش تكبّره - عكس الأصول/الخزائن تمامًا
    expect(await treasuryBalance(revAcc.rows[0].id)).toBe(revBefore - 60);
  });

  test("القفل القسري: بيسلّم الدرج بالفعلي بس من غير تصفية تلقائية للفرق", async () => {
    const open = await request(app).post("/api/shifts/open").set(authed(cashierToken)).send({ openingCash: 0 });
    await sellCash(cashierToken, 1000);
    const mainBefore = await treasuryBalance(await mainTreasuryAccountId());

    const force = await request(app).post(`/api/shifts/${open.body.id}/force-close`).set(authed(adminToken)).send({ actualCash: 950, reason: "الكاشير مسافر مش هيقدر يقفل بنفسه" });
    expect(force.status).toBe(200);
    expect(force.body.status).toBe("FORCE_CLOSED");

    const cashierAccId = await cashierTreasuryAccountId(cashierId);
    expect(await treasuryBalance(cashierAccId)).toBe(50); // الفرق فاضل قايم لحد مراجعة يدوية
    expect(await treasuryBalance(await mainTreasuryAccountId())).toBe(mainBefore + 950);
  });
});

describe("GET /api/treasuries - عرض الخزائن بالأرصدة اللحظية", () => {
  test("مدير الفرع يشوف خزائن فرعه (رئيسية + دروج الكاشيرية)", async () => {
    const res = await request(app).get(`/api/treasuries?branchId=${branchA}`).set(authed(managerToken));
    expect(res.status).toBe(200);
    const main = res.body.find((t) => t.kind === "MAIN");
    expect(main).toBeDefined();
    expect(Number(main.balance)).toBe(await treasuryBalance(main.account_id));
    const cashierRow = res.body.find((t) => t.kind === "CASHIER" && t.cashier_user_id === cashierId);
    expect(cashierRow).toBeDefined();
  });

  test("الكاشير معندوش صلاحية يشوف الخزائن خالص", async () => {
    const res = await request(app).get(`/api/treasuries?branchId=${branchA}`).set(authed(cashierToken));
    expect(res.status).toBe(403);
  });

  test("لازم تحدد فرع لو مش أدمن", async () => {
    const res = await request(app).get("/api/treasuries").set(authed(managerToken));
    expect(res.status).toBe(400);
  });

  test("الأدمن يقدر يشوف كل الفروع من غير تحديد", async () => {
    const res = await request(app).get("/api/treasuries").set(authed(adminToken));
    expect(res.status).toBe(200);
    expect(res.body.some((t) => t.branch_id === branchA)).toBe(true);
  });
});

describe("POST /api/treasuries/:id/transfer - تحويل بين الخزائن", () => {
  test("مدير الفرع معندوش صلاحية تحويل (مالي بحت للمحاسب/الأدمن)", async () => {
    const mainId = (await pool.query("SELECT id FROM treasuries WHERE account_id = $1", [await mainTreasuryAccountId()])).rows[0].id;
    const res = await request(app).post(`/api/treasuries/${mainId}/transfer`).set(authed(managerToken)).send({ toTreasuryId: mainId, amount: 100 });
    expect(res.status).toBe(403);
  });

  test("المحاسب يقدر يحوّل من الخزينة الرئيسية لحساب بنكي", async () => {
    const bankRes = await request(app).post("/api/banks").set(authed(adminToken)).send({ name: "بنك-خزائن-جست" });
    expect(bankRes.status).toBe(201);
    const acctRes = await request(app).post("/api/banks/accounts").set(authed(adminToken)).send({ bankId: bankRes.body.id, name: "حساب جاري" });
    expect(acctRes.status).toBe(201);

    const mainTreasury = (await pool.query("SELECT id, account_id FROM treasuries WHERE account_id = $1", [await mainTreasuryAccountId()])).rows[0];
    const mainBefore = await treasuryBalance(mainTreasury.account_id);
    const bankAccBefore = await treasuryBalance((await pool.query("SELECT account_id FROM treasuries WHERE id = $1", [acctRes.body.treasury_id])).rows[0].account_id);

    const transfer = await request(app)
      .post(`/api/treasuries/${mainTreasury.id}/transfer`)
      .set(authed(accountantToken))
      .send({ toTreasuryId: acctRes.body.treasury_id, amount: 500, notes: "تحويل جست" });
    expect(transfer.status).toBe(201);

    expect(await treasuryBalance(mainTreasury.account_id)).toBe(mainBefore - 500);
    const bankAccountId = (await pool.query("SELECT account_id FROM treasuries WHERE id = $1", [acctRes.body.treasury_id])).rows[0].account_id;
    expect(await treasuryBalance(bankAccountId)).toBe(bankAccBefore + 500);
  });

  test("مينفعش تحوّل خزينة لنفسها", async () => {
    const mainId = (await pool.query("SELECT id FROM treasuries WHERE account_id = $1", [await mainTreasuryAccountId()])).rows[0].id;
    const res = await request(app).post(`/api/treasuries/${mainId}/transfer`).set(authed(accountantToken)).send({ toTreasuryId: mainId, amount: 10 });
    expect(res.status).toBe(400);
  });

  test("مبلغ صفر أو سالب مرفوض", async () => {
    const mainId = (await pool.query("SELECT id FROM treasuries WHERE account_id = $1", [await mainTreasuryAccountId()])).rows[0].id;
    const res = await request(app).post(`/api/treasuries/${mainId}/transfer`).set(authed(accountantToken)).send({ toTreasuryId: mainId + 1, amount: 0 });
    expect(res.status).toBe(400);
  });
});

describe("البنوك وحساباتها - إدارة أدمن بس، رؤية للمحاسب", () => {
  let bankId;

  test("الأدمن ينشئ بنك جديد", async () => {
    const res = await request(app).post("/api/banks").set(authed(adminToken)).send({ name: "بنك-إدارة-جست" });
    expect(res.status).toBe(201);
    bankId = res.body.id;
  });

  test("المحاسب معندوش صلاحية إنشاء بنك (رؤية بس)", async () => {
    const res = await request(app).post("/api/banks").set(authed(accountantToken)).send({ name: "بنك-مرفوض" });
    expect(res.status).toBe(403);
  });

  test("مدير الفرع معندوش صلاحية يشوف البنوك خالص", async () => {
    const res = await request(app).get("/api/banks").set(authed(managerToken));
    expect(res.status).toBe(403);
  });

  test("المحاسب يقدر يشوف قايمة البنوك", async () => {
    const res = await request(app).get("/api/banks").set(authed(accountantToken));
    expect(res.status).toBe(200);
    expect(res.body.some((b) => b.id === bankId)).toBe(true);
  });

  test("الأدمن ينشئ حساب بنكي جديد مربوط بخزينة وحساب محاسبي فعلي", async () => {
    const res = await request(app).post("/api/banks/accounts").set(authed(adminToken)).send({ bankId, name: "حساب رئيسي", accountNumber: "12345" });
    expect(res.status).toBe(201);
    expect(res.body.treasury_id).toBeDefined();
    const treasury = await pool.query("SELECT * FROM treasuries WHERE id = $1", [res.body.treasury_id]);
    expect(treasury.rows[0].kind).toBe("BANK");
    const account = await pool.query("SELECT * FROM accounts WHERE id = $1", [treasury.rows[0].account_id]);
    expect(account.rows[0].code).toMatch(/^1200-/);
  });

  test("المحاسب معندوش صلاحية ينشئ حساب بنكي", async () => {
    const res = await request(app).post("/api/banks/accounts").set(authed(accountantToken)).send({ bankId, name: "مرفوض" });
    expect(res.status).toBe(403);
  });

  test("GET /api/banks/accounts بيرجّع الرصيد اللحظي الصحيح", async () => {
    const created = await request(app).post("/api/banks/accounts").set(authed(adminToken)).send({ bankId, name: "حساب توازن" });
    const list = await request(app).get("/api/banks/accounts").set(authed(accountantToken));
    expect(list.status).toBe(200);
    const row = list.body.find((a) => a.id === created.body.id);
    expect(row).toBeDefined();
    expect(Number(row.balance)).toBe(0);
  });
});
