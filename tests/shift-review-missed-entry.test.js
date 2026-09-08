// المرحلة 8.45: مراجعة تفصيلية لشيفت عليه عجز/زيادة - المدير ممكن يكتشف إن الكاشير نسي يسجل مصروف أو
// مشترى نقدي حصل أثناء الشيفت، فيسجله بأثر رجعي (GET /:id/review-detail لعرض التفاصيل، POST
// /:id/missed-entry لتسجيل البند وإعادة حساب الفرق فورًا). بيغطي: تصفير العجز بالكامل تلقائيًا، تسوية
// جزئية بتفضل الشيفت معلّق بأرقام محدّثة (وبتتغذّى صح في مراجعة approve العادية بعد كده - مش الرقم
// الأصلي القديم)، توجيه القيد المحاسبي لدرج الكاشير نفسه (مش حساب كاش الفرع الرئيسي)، وكل حالات الرفض
// (حالة شيفت غلط، صلاحيات، عزل فروع، بيانات ناقصة).
const { app, request, pool, seedUser, login, authed } = require("./helpers");

let branchA, branchB;
let cashierAToken, managerAToken, managerBToken, cashierNoPermToken;
let cashierAId, employeeAId;
let cashPmId, itemId, variantId;
let expenseCategoryId;

beforeAll(async () => {
  const bA = await pool.query("INSERT INTO branches (name) VALUES ('فرع مراجعة-عجز-جست') RETURNING id");
  branchA = bA.rows[0].id;
  const bB = await pool.query("INSERT INTO branches (name) VALUES ('فرع مراجعة-عجز-جست-B') RETURNING id");
  branchB = bB.rows[0].id;

  cashierAId = await seedUser({ branchId: branchA, name: "كاشير-مراجعة-عجز", email: "cashierA-missed@jest.test", role: "cashier" });
  await seedUser({ branchId: branchA, name: "مدير-مراجعة-عجز", email: "managerA-missed@jest.test", role: "branch_manager" });
  await seedUser({ branchId: branchB, name: "مدير-مراجعة-عجز-B", email: "managerB-missed@jest.test", role: "branch_manager" });
  await seedUser({ branchId: branchA, name: "كاشير-تاني-مراجعة-عجز", email: "cashierNoPerm-missed@jest.test", role: "cashier" });

  cashierAToken = await login("cashierA-missed@jest.test");
  managerAToken = await login("managerA-missed@jest.test");
  managerBToken = await login("managerB-missed@jest.test");
  cashierNoPermToken = await login("cashierNoPerm-missed@jest.test");

  const emp = await pool.query(
    "INSERT INTO employees (name, department, attendance_system, base_salary, restricted_branch_id, user_id) VALUES ('كاشير-مراجعة-عجز','مبيعات','manual',3000,$1,$2) RETURNING id",
    [branchA, cashierAId]
  );
  employeeAId = emp.rows[0].id;

  const pm = await pool.query("INSERT INTO payment_methods (name, kind) VALUES ('كاش-مراجعة-عجز-جست', 'cash') RETURNING id");
  cashPmId = pm.rows[0].id;

  const cat = await pool.query("INSERT INTO menu_categories (name) VALUES ('مراجعة-عجز-جست-قسم') RETURNING id");
  const mi = await pool.query("INSERT INTO menu_items (category_id, name) VALUES ($1,'صنف-مراجعة-عجز-جست') RETURNING id", [cat.rows[0].id]);
  itemId = mi.rows[0].id;
  const v = await pool.query("INSERT INTO menu_item_variants (item_id, label, price) VALUES ($1,'عادي',1000) RETURNING id", [itemId]);
  variantId = v.rows[0].id;

  const ec = await pool.query("INSERT INTO expense_categories (name) VALUES ('بند-مراجعة-عجز-جست') RETURNING id");
  expenseCategoryId = ec.rows[0].id;
});

afterAll(async () => {
  await pool.end();
});

async function openAndSell(token, openingCash) {
  const open = await request(app).post("/api/shifts/open").set(authed(token)).send({ openingCash });
  const order = await request(app).post("/api/orders").set(authed(token)).send({
    branchId: branchA, source: "pos", orderType: "takeaway", paymentMethodId: cashPmId,
    items: [{ itemId, variantId, quantity: 1 }],
  });
  return { shiftId: open.body.id, orderId: order.body.orderId };
}

describe("مصروف/مشترى منسي أثناء مراجعة عجز شيفت", () => {
  test("مصروف منسي بمبلغ العجز بالكامل => الشيفت يتقفل تلقائيًا بفرق صفر", async () => {
    const { shiftId } = await openAndSell(cashierAToken, 0);
    const close = await request(app).post(`/api/shifts/${shiftId}/close`).set(authed(cashierAToken)).send({ actualCash: 700 }); // متوقع 1000، عجز 300
    expect(close.body.status).toBe("PENDING_REVIEW");

    const res = await request(app).post(`/api/shifts/${shiftId}/missed-entry`).set(authed(managerAToken)).send({
      entryType: "expense", amount: 300, categoryId: expenseCategoryId, notes: "نسي يسجله وقت الشيفت",
    });
    expect(res.status).toBe(200);
    expect(res.body.resolved).toBe(true);
    expect(res.body.shift.status).toBe("CLOSED");
    expect(Number(res.body.shift.cash_variance)).toBe(0);
    expect(res.body.shift.variance_status).toBe("NONE");
    expect(Number(res.body.entry.amount)).toBe(300);

    // القيد المحاسبي بيروح لدرج الكاشير نفسه (1100-<branchId>-<userId>) مش حساب كاش الفرع الرئيسي
    const cashierAccount = await pool.query("SELECT id FROM accounts WHERE code = $1", [`1100-${branchA}-${cashierAId}`]);
    expect(cashierAccount.rows.length).toBe(1);
    const journal = await pool.query("SELECT * FROM journal_entries WHERE source_type = 'expense' AND source_id = $1", [res.body.entry.id]);
    expect(journal.rows.length).toBe(1);
    const lines = await pool.query("SELECT * FROM journal_entry_lines WHERE journal_entry_id = $1", [journal.rows[0].id]);
    const totalDebit = lines.rows.reduce((s, l) => s + Number(l.debit), 0);
    const totalCredit = lines.rows.reduce((s, l) => s + Number(l.credit), 0);
    expect(totalDebit).toBe(totalCredit);
    expect(totalDebit).toBe(300);
    const creditLine = lines.rows.find((l) => Number(l.credit) > 0);
    expect(creditLine.account_id).toBe(cashierAccount.rows[0].id);

    // المصروف الجديد اتسجل POSTED وبتاريخ جوه نافذة الشيفت
    const expenseRow = await pool.query("SELECT * FROM expenses WHERE id = $1", [res.body.entry.id]);
    expect(expenseRow.rows[0].status).toBe("POSTED");
    expect(expenseRow.rows[0].branch_id).toBe(branchA);

    // مفيش سلفة اتسجلت على الكاشير - العجز اتصفّى بالكامل بالمصروف المنسي، مش بموافقة/سلفة
    const adjustment = await pool.query("SELECT * FROM payroll_adjustments WHERE shift_id = $1", [shiftId]);
    expect(adjustment.rows.length).toBe(0);
  });

  test("مشترى منسي بمبلغ أقل من العجز => الشيفت يفضل PENDING_REVIEW بفرق محدّث، ومراجعة approve بعد كده بتاخد الرقم الجديد مش القديم", async () => {
    const { shiftId } = await openAndSell(cashierAToken, 0);
    const close = await request(app).post(`/api/shifts/${shiftId}/close`).set(authed(cashierAToken)).send({ actualCash: 850 }); // متوقع 1000، عجز 150
    expect(close.body.status).toBe("PENDING_REVIEW");

    const res = await request(app).post(`/api/shifts/${shiftId}/missed-entry`).set(authed(managerAToken)).send({
      entryType: "purchase", amount: 100, notes: "مشترى نسيه الكاشير",
    });
    expect(res.status).toBe(200);
    expect(res.body.resolved).toBe(false);
    expect(res.body.shift.status).toBe("PENDING_REVIEW");
    expect(Number(res.body.shift.cash_variance)).toBe(-50); // 150 - 100 = 50 عجز متبقي

    const purchaseRow = await pool.query("SELECT * FROM purchases WHERE id = $1", [res.body.entry.id]);
    expect(purchaseRow.rows[0].status).toBe("CONFIRMED");
    expect(Number(purchaseRow.rows[0].amount)).toBe(100);

    // approve دلوقتي المفروض ياخد الـ50 المتبقي (بعد التصحيح) مش الـ150 الأصلية
    const review = await request(app).post(`/api/shifts/${shiftId}/review`).set(authed(managerAToken)).send({ decision: "approve" });
    expect(review.status).toBe(200);
    expect(Number(review.body.debtCreated.amount)).toBe(50);
    const adjustment = await pool.query("SELECT * FROM payroll_adjustments WHERE shift_id = $1", [shiftId]);
    expect(adjustment.rows.length).toBe(1);
    expect(Number(adjustment.rows[0].amount)).toBe(50);
    expect(adjustment.rows[0].employee_id).toBe(employeeAId);
  });

  test("مينفعش تضيف بند منسي لشيفت شغال (ACTIVE) أو شيفت اتقفل نهائي (CLOSED)", async () => {
    const openRes = await request(app).post("/api/shifts/open").set(authed(cashierAToken)).send({ openingCash: 0 });
    const activeShiftId = openRes.body.id;
    const activeRes = await request(app).post(`/api/shifts/${activeShiftId}/missed-entry`).set(authed(managerAToken)).send({
      entryType: "expense", amount: 50, categoryId: expenseCategoryId,
    });
    expect(activeRes.status).toBe(400);
    expect(activeRes.body.code).toBe("SHIFT_NOT_PENDING_REVIEW");
    await request(app).post(`/api/shifts/${activeShiftId}/close`).set(authed(cashierAToken)).send({ actualCash: 0 });

    const { shiftId } = await openAndSell(cashierAToken, 0);
    await request(app).post(`/api/shifts/${shiftId}/close`).set(authed(cashierAToken)).send({ actualCash: 1000 }); // فرق صفر => CLOSED فورًا
    const closedRes = await request(app).post(`/api/shifts/${shiftId}/missed-entry`).set(authed(managerAToken)).send({
      entryType: "expense", amount: 50, categoryId: expenseCategoryId,
    });
    expect(closedRes.status).toBe(400);
    expect(closedRes.body.code).toBe("SHIFT_NOT_PENDING_REVIEW");
  });

  test("كاشير معندوش shifts.review يترفض (403)", async () => {
    const { shiftId } = await openAndSell(cashierAToken, 0);
    await request(app).post(`/api/shifts/${shiftId}/close`).set(authed(cashierAToken)).send({ actualCash: 700 });
    const res = await request(app).post(`/api/shifts/${shiftId}/missed-entry`).set(authed(cashierNoPermToken)).send({
      entryType: "expense", amount: 300, categoryId: expenseCategoryId,
    });
    expect(res.status).toBe(403);
  });

  test("مدير فرع تاني يترفض (عزل الفروع)", async () => {
    const { shiftId } = await openAndSell(cashierAToken, 0);
    await request(app).post(`/api/shifts/${shiftId}/close`).set(authed(cashierAToken)).send({ actualCash: 700 });
    const res = await request(app).post(`/api/shifts/${shiftId}/missed-entry`).set(authed(managerBToken)).send({
      entryType: "expense", amount: 300, categoryId: expenseCategoryId,
    });
    expect(res.status).toBe(403);
  });

  test("مصروف من غير categoryId يترفض", async () => {
    const { shiftId } = await openAndSell(cashierAToken, 0);
    await request(app).post(`/api/shifts/${shiftId}/close`).set(authed(cashierAToken)).send({ actualCash: 700 });
    const res = await request(app).post(`/api/shifts/${shiftId}/missed-entry`).set(authed(managerAToken)).send({ entryType: "expense", amount: 300 });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("CATEGORY_REQUIRED");
  });

  test("مبلغ صفر أو سالب يترفض", async () => {
    const { shiftId } = await openAndSell(cashierAToken, 0);
    await request(app).post(`/api/shifts/${shiftId}/close`).set(authed(cashierAToken)).send({ actualCash: 700 });
    const zero = await request(app).post(`/api/shifts/${shiftId}/missed-entry`).set(authed(managerAToken)).send({
      entryType: "expense", amount: 0, categoryId: expenseCategoryId,
    });
    expect(zero.status).toBe(400);
    expect(zero.body.code).toBe("INVALID_AMOUNT");
    const negative = await request(app).post(`/api/shifts/${shiftId}/missed-entry`).set(authed(managerAToken)).send({
      entryType: "expense", amount: -10, categoryId: expenseCategoryId,
    });
    expect(negative.status).toBe(400);
    expect(negative.body.code).toBe("INVALID_AMOUNT");
  });
});

describe("GET /api/shifts/:id/review-detail", () => {
  test("بيرجّع الشيفت + الطلبات + الأرقام الحية لمدير الفرع", async () => {
    const { shiftId, orderId } = await openAndSell(cashierAToken, 0);
    await request(app).post(`/api/shifts/${shiftId}/close`).set(authed(cashierAToken)).send({ actualCash: 700 });

    const res = await request(app).get(`/api/shifts/${shiftId}/review-detail`).set(authed(managerAToken));
    expect(res.status).toBe(200);
    expect(res.body.shift.id).toBe(shiftId);
    expect(res.body.shift.cashier_name).toBe("كاشير-مراجعة-عجز");
    expect(res.body.orders.map((o) => o.id)).toContain(orderId);
    expect(Number(res.body.financialsLive.expectedCash)).toBe(1000);
    expect(Number(res.body.financialsLive.cashVariance)).toBe(-300);
  });

  test("كاشير معندوش صلاحية يترفض، ومدير فرع تاني يترفض", async () => {
    const { shiftId } = await openAndSell(cashierAToken, 0);
    await request(app).post(`/api/shifts/${shiftId}/close`).set(authed(cashierAToken)).send({ actualCash: 700 });

    const cashierRes = await request(app).get(`/api/shifts/${shiftId}/review-detail`).set(authed(cashierAToken));
    expect(cashierRes.status).toBe(403);

    const otherBranchRes = await request(app).get(`/api/shifts/${shiftId}/review-detail`).set(authed(managerBToken));
    expect(otherBranchRes.status).toBe(403);
  });
});
