// المرحلة 7E: شيفتات الكاشير + تقفيل يوم الفرع - ضد Postgres حقيقي (زي كل اختبارات المشروع). بيغطي:
// دورة حياة الشيفت الأساسية، المثال الرقمي الكامل من مواصفة المرحلة (فتح 2000، مبيعات كاش 5000،
// مبيعات كارت 3000، مرتجع كاش 200، مصروف كاش 300 => متوقع 6500، فعلي 6450 => عجز -50)، مراجعة المدير،
// القفل القسري، اشتراط الشيفت لبيع POS، عزل الفروع، تقفيل يوم الفرع، والتزامن (فتح/قفل/مراجعة متوازية).
const { app, request, pool, seedUser, login, authed } = require("./helpers");

let branchA, branchB;
let cashierAToken, cashierA2Token, managerAToken, accountantAToken, adminToken;
let cashierBToken, managerBToken;
let cashierAId, cashierA2Id, managerAId;
let cashPmId, cardPmId, expenseCategoryId;
let itemBigId, variantBig, variantMid, variantSmall; // 5000 / 3000 / 200 على التوالي

beforeAll(async () => {
  const bA = await pool.query("INSERT INTO branches (name) VALUES ('فرع شيفت-A-جست') RETURNING id");
  branchA = bA.rows[0].id;
  const bB = await pool.query("INSERT INTO branches (name) VALUES ('فرع شيفت-B-جست') RETURNING id");
  branchB = bB.rows[0].id;

  cashierAId = await seedUser({ branchId: branchA, name: "كاشير-شيفت-A", email: "cashierA-shift@jest.test", role: "cashier" });
  cashierA2Id = await seedUser({ branchId: branchA, name: "كاشير-شيفت-A2", email: "cashierA2-shift@jest.test", role: "cashier" });
  managerAId = await seedUser({ branchId: branchA, name: "مدير-شيفت-A", email: "managerA-shift@jest.test", role: "branch_manager" });
  await seedUser({ branchId: branchA, name: "محاسب-شيفت-A", email: "accountantA-shift@jest.test", role: "accountant" });
  await seedUser({ branchId: branchB, name: "كاشير-شيفت-B", email: "cashierB-shift@jest.test", role: "cashier" });
  await seedUser({ branchId: branchB, name: "مدير-شيفت-B", email: "managerB-shift@jest.test", role: "branch_manager" });
  await seedUser({ name: "أدمن-شيفت", email: "admin-shift@jest.test", role: "admin" });

  cashierAToken = await login("cashierA-shift@jest.test");
  cashierA2Token = await login("cashierA2-shift@jest.test");
  managerAToken = await login("managerA-shift@jest.test");
  accountantAToken = await login("accountantA-shift@jest.test");
  cashierBToken = await login("cashierB-shift@jest.test");
  managerBToken = await login("managerB-shift@jest.test");
  adminToken = await login("admin-shift@jest.test");

  const pmCash = await pool.query("INSERT INTO payment_methods (name, kind) VALUES ('كاش-شيفت-جست', 'cash') RETURNING id");
  cashPmId = pmCash.rows[0].id;
  const pmCard = await pool.query("INSERT INTO payment_methods (name, kind) VALUES ('كارت-شيفت-جست', 'card_or_wallet') RETURNING id");
  cardPmId = pmCard.rows[0].id;

  const cat = await pool.query("INSERT INTO menu_categories (name) VALUES ('شيفت-جست-قسم') RETURNING id");
  const mi = await pool.query("INSERT INTO menu_items (category_id, name) VALUES ($1,'صنف-شيفت-جست') RETURNING id", [cat.rows[0].id]);
  itemBigId = mi.rows[0].id;
  const vBig = await pool.query("INSERT INTO menu_item_variants (item_id, label, price) VALUES ($1,'كبير',5000) RETURNING id", [itemBigId]);
  variantBig = vBig.rows[0].id;
  const vMid = await pool.query("INSERT INTO menu_item_variants (item_id, label, price) VALUES ($1,'وسط',3000) RETURNING id", [itemBigId]);
  variantMid = vMid.rows[0].id;
  const vSmall = await pool.query("INSERT INTO menu_item_variants (item_id, label, price) VALUES ($1,'صغير',200) RETURNING id", [itemBigId]);
  variantSmall = vSmall.rows[0].id;

  const ec = await pool.query("INSERT INTO expense_categories (name) VALUES ('مصروف-شيفت-جست') RETURNING id");
  expenseCategoryId = ec.rows[0].id;
});

afterAll(async () => {
  await pool.end();
});

async function makePosOrder(token, variantId, paymentMethodId, orderType = "takeaway") {
  return request(app).post("/api/orders").set(authed(token)).send({
    branchId: branchA, source: "pos", orderType, paymentMethodId,
    items: [{ itemId: itemBigId, variantId, quantity: 1 }],
  });
}

describe("دورة حياة الشيفت الأساسية", () => {
  let shiftId;

  test("كاشير يقدر يفتح شيفت بكاش افتتاحي", async () => {
    const res = await request(app).post("/api/shifts/open").set(authed(cashierAToken)).send({ openingCash: 500, openingNotes: "بداية اليوم" });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe("ACTIVE");
    expect(Number(res.body.opening_cash)).toBe(500);
    shiftId = res.body.id;
  });

  test("مينفعش تفتح شيفت تاني وأنت شيفتك شغال بالفعل", async () => {
    const res = await request(app).post("/api/shifts/open").set(authed(cashierAToken)).send({ openingCash: 100 });
    expect(res.status).toBe(409);
    expect(res.body.error).toContain("شغال بالفعل");
  });

  test("GET /current بيرجع الشيفت النشط الحالي", async () => {
    const res = await request(app).get("/api/shifts/current").set(authed(cashierAToken));
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(shiftId);
  });

  test("بيع كاش بيترتبط أوتوماتيك بالشيفت النشط ويظهر في المعاينة", async () => {
    const order = await makePosOrder(cashierAToken, variantBig, cashPmId);
    expect(order.status).toBe(201);
    const orderRow = await pool.query("SELECT shift_id FROM orders WHERE id=$1", [order.body.orderId]);
    expect(orderRow.rows[0].shift_id).toBe(shiftId);

    // المرحلة 8.6: /preview بقى مقصور على شيفتس.review (مدير فرع/محاسب/أدمن) - الكاشير مابقاش
    // يشوف الكاش المتوقع خالص (حماية ضد تلاعب: كاشير عارف الرقم المتوقع يقدر يدخل "فعلي" يطابقه)
    const preview = await request(app).get(`/api/shifts/${shiftId}/preview`).set(authed(managerAToken));
    expect(preview.status).toBe(200);
    expect(preview.body.cashSales).toBe(5000);
    expect(preview.body.expectedCash).toBe(5500); // 500 افتتاحي + 5000 كاش

    const cashierPreview = await request(app).get(`/api/shifts/${shiftId}/preview`).set(authed(cashierAToken));
    expect(cashierPreview.status).toBe(403);
  });

  test("قفل الشيفت بمبلغ فعلي = المتوقع بالظبط => فرق صفر وحالة CLOSED (الأرقام المالية مش ظاهرة في رد الكاشير نفسه)", async () => {
    const res = await request(app).post(`/api/shifts/${shiftId}/close`).set(authed(cashierAToken)).send({ actualCash: 5500 });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("CLOSED");
    // المرحلة 8.6: الكاشير مايشوفش أي رقم مالي حساس في رد القفل نفسه - الحماية على مستوى الـresponse
    expect(res.body.expected_cash).toBeUndefined();
    expect(res.body.cash_variance).toBeUndefined();
    expect(res.body.actual_cash).toBeUndefined();
    expect(res.body.cash_sales).toBeUndefined();

    // الأرقام الحقيقية لسه بتترحّل صح جوه القاعدة - بيتأكد منها هنا عن طريق شوف مدير الفرع (مصرّح له)
    const managerView = await request(app).get(`/api/shifts/${shiftId}`).set(authed(managerAToken));
    expect(managerView.status).toBe(200);
    expect(Number(managerView.body.expected_cash)).toBe(5500);
    expect(Number(managerView.body.cash_variance)).toBe(0);
    expect(managerView.body.variance_status).toBe("NONE");
  });

  test("مينفعش تقفل نفس الشيفت تاني وهو مقفول بالفعل", async () => {
    const res = await request(app).post(`/api/shifts/${shiftId}/close`).set(authed(cashierAToken)).send({ actualCash: 5500 });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("مقفول بالفعل");
  });

  test("قيمة كاش سالبة أو ناقصة عند الفتح/القفل مرفوضة", async () => {
    const openRes = await request(app).post("/api/shifts/open").set(authed(cashierA2Token)).send({ openingCash: -10 });
    expect(openRes.status).toBe(400);
    const openOk = await request(app).post("/api/shifts/open").set(authed(cashierA2Token)).send({ openingCash: 0 });
    expect(openOk.status).toBe(201);
    const closeRes = await request(app).post(`/api/shifts/${openOk.body.id}/close`).set(authed(cashierA2Token)).send({ actualCash: -5 });
    expect(closeRes.status).toBe(400);
    await request(app).post(`/api/shifts/${openOk.body.id}/close`).set(authed(cashierA2Token)).send({ actualCash: 0 });
  });
});

describe("المثال الرقمي الكامل من مواصفة المرحلة 7E", () => {
  let shiftPrevId, shiftMainId, prevOrderId;

  test("إعداد: شيفت سابق ببيع كاش 200 جنيه بيتقفل عادي", async () => {
    const openPrev = await request(app).post("/api/shifts/open").set(authed(cashierAToken)).send({ openingCash: 0 });
    shiftPrevId = openPrev.body.id;
    const order = await makePosOrder(cashierAToken, variantSmall, cashPmId);
    prevOrderId = order.body.orderId;
    expect(order.body.total).toBe(200);
    const closePrev = await request(app).post(`/api/shifts/${shiftPrevId}/close`).set(authed(cashierAToken)).send({ actualCash: 200 });
    expect(closePrev.status).toBe(200);
  });

  test("فتح الشيفت الرئيسي بـ2000 جنيه افتتاحي", async () => {
    const res = await request(app).post("/api/shifts/open").set(authed(cashierAToken)).send({ openingCash: 2000 });
    expect(res.status).toBe(201);
    shiftMainId = res.body.id;
  });

  test("مبيعات كاش 5000 (محصّلة فورًا)", async () => {
    const order = await makePosOrder(cashierAToken, variantBig, cashPmId);
    expect(order.body.total).toBe(5000);
  });

  test("مبيعات كارت 3000 - لازم تتأكد التحصيل الأول عشان تتحسب في تسوية الكاش (مش نقدي أصلًا هنا بس مبدأ التحصيل واحد)", async () => {
    const order = await makePosOrder(cashierAToken, variantMid, cardPmId);
    expect(order.body.total).toBe(3000);
    const confirm = await request(app).patch(`/api/orders/${order.body.orderId}/payment-status`).set(authed(cashierAToken)).send({ paymentStatus: "collected" });
    expect(confirm.status).toBe(200);
  });

  test("مرتجع كاش 200 (استرجاع طلب الشيفت السابق أثناء الشيفت الحالي)", async () => {
    const res = await request(app).post(`/api/orders/${prevOrderId}/void`).set(authed(managerAToken)).send({ reason: "استرجاع - مثال المواصفة" });
    expect(res.status).toBe(200);
  });

  test("مصروف كاش 300", async () => {
    const res = await request(app).post("/api/expenses").set(authed(managerAToken)).send({
      branchId: branchA, businessDate: new Date().toISOString().slice(0, 10),
      categoryId: expenseCategoryId, amount: 300, paymentMethodId: cashPmId,
    });
    expect(res.status).toBe(201);
  });

  test("المعاينة قبل القفل: متوقع = 2000+5000-200-300 = 6500 (مدير الفرع بس)", async () => {
    const preview = await request(app).get(`/api/shifts/${shiftMainId}/preview`).set(authed(managerAToken));
    expect(preview.body.cashSales).toBe(5000);
    expect(preview.body.cardSales).toBe(3000);
    expect(preview.body.cashRefunds).toBe(200);
    expect(preview.body.cashExpensesTotal).toBe(300);
    expect(preview.body.expectedCash).toBe(6500);
  });

  test("القفل بعدد فعلي 6450 => عجز -50، فوق عتبة الاعتماد (20) => PENDING_REVIEW (الأرقام تظهر لمدير الفرع بس)", async () => {
    const res = await request(app).post(`/api/shifts/${shiftMainId}/close`).set(authed(cashierAToken)).send({ actualCash: 6450 });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("PENDING_REVIEW");
    expect(res.body.expected_cash).toBeUndefined();
    expect(res.body.cash_variance).toBeUndefined();

    const managerView = await request(app).get(`/api/shifts/${shiftMainId}`).set(authed(managerAToken));
    expect(Number(managerView.body.expected_cash)).toBe(6500);
    expect(Number(managerView.body.cash_variance)).toBe(-50);
    expect(managerView.body.variance_status).toBe("PENDING_REVIEW");
  });

  test("الشيفت في حالة انتظار مراجعة مينفعش يتقفل تاني", async () => {
    const res = await request(app).post(`/api/shifts/${shiftMainId}/close`).set(authed(cashierAToken)).send({ actualCash: 6450 });
    expect(res.status).toBe(400);
  });

  test("مدير الفرع يراجع الفرق (اعتماد) => الشيفت يتقفل نهائيًا CLOSED", async () => {
    const res = await request(app).post(`/api/shifts/${shiftMainId}/review`).set(authed(managerAToken)).send({ decision: "acknowledge", notes: "تم التحقق - عجز بسيط مقبول" });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("CLOSED");
    expect(res.body.variance_status).toBe("ACKNOWLEDGED");
    expect(res.body.variance_reviewed_by).toBe(managerAId);
  });

  test("مراجعة شيفت CLOSED بالفعل بترفض", async () => {
    const res = await request(app).post(`/api/shifts/${shiftMainId}/review`).set(authed(managerAToken)).send({ decision: "approve" });
    expect(res.status).toBe(400);
  });
});

describe("صلاحيات وعزل الفروع", () => {
  let shiftAId, shiftBId;

  beforeAll(async () => {
    const openA = await request(app).post("/api/shifts/open").set(authed(cashierAToken)).send({ openingCash: 0 });
    shiftAId = openA.body.id;
    const openB = await request(app).post("/api/shifts/open").set(authed(cashierBToken)).send({ openingCash: 0 });
    shiftBId = openB.body.id;
  });

  afterAll(async () => {
    await request(app).post(`/api/shifts/${shiftAId}/close`).set(authed(cashierAToken)).send({ actualCash: 0 });
    await request(app).post(`/api/shifts/${shiftBId}/close`).set(authed(cashierBToken)).send({ actualCash: 0 });
  });

  test("كاشير مينفعش يقفل شيفت زميله", async () => {
    const res = await request(app).post(`/api/shifts/${shiftAId}/close`).set(authed(cashierA2Token)).send({ actualCash: 0 });
    expect(res.status).toBe(403);
  });

  test("مدير فرع B مينفعش يشوف تفاصيل شيفت فرع A", async () => {
    const res = await request(app).get(`/api/shifts/${shiftAId}`).set(authed(managerBToken));
    expect(res.status).toBe(403);
  });

  test("مدير فرع B مينفعش يشوف قايمة شيفتات فرع A", async () => {
    const res = await request(app).get(`/api/shifts?branchId=${branchA}`).set(authed(managerBToken));
    expect(res.status).toBe(403);
  });

  test("مدير الفرع صاحب الفرع يقدر يشوف شيفتات فرعه", async () => {
    const res = await request(app).get(`/api/shifts?branchId=${branchA}`).set(authed(managerAToken));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  test("مدير فرع (مش أدمن) مينفعش يعمل قفل قسري", async () => {
    const res = await request(app).post(`/api/shifts/${shiftBId}/force-close`).set(authed(managerBToken)).send({ reason: "تجربة" });
    expect(res.status).toBe(403);
  });

  test("قفل قسري من الأدمن من غير سبب بيترفض", async () => {
    const res = await request(app).post(`/api/shifts/${shiftBId}/force-close`).set(authed(adminToken)).send({ actualCash: 0 });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("سبب");
  });

  test("قفل قسري من الأدمن بسبب واضح بينجح ويسجل FORCE_CLOSED", async () => {
    const res = await request(app).post(`/api/shifts/${shiftBId}/force-close`).set(authed(adminToken)).send({ actualCash: 0, reason: "الكاشير غاب ونسي يقفل الشيفت" });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("FORCE_CLOSED");
    shiftBId = null; // اتقفل بالفعل - afterAll مش هيحاول يقفله تاني
  });
});

describe("اشتراط فتح شيفت لبيع POS (require_shift_for_pos_sales)", () => {
  beforeAll(async () => {
    await pool.query("UPDATE pos_settings SET require_shift_for_pos_sales = TRUE WHERE id = 1");
  });
  afterAll(async () => {
    await pool.query("UPDATE pos_settings SET require_shift_for_pos_sales = FALSE WHERE id = 1");
  });

  test("بيع POS من غير شيفت نشط بيترفض لما الإعداد شغال", async () => {
    const res = await makePosOrder(cashierA2Token, variantSmall, cashPmId);
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("شيفت");
  });

  test("بعد فتح شيفت، البيع بينجح ويترتبط بيه", async () => {
    const open = await request(app).post("/api/shifts/open").set(authed(cashierA2Token)).send({ openingCash: 0 });
    const order = await makePosOrder(cashierA2Token, variantSmall, cashPmId);
    expect(order.status).toBe(201);
    const row = await pool.query("SELECT shift_id FROM orders WHERE id=$1", [order.body.orderId]);
    expect(row.rows[0].shift_id).toBe(open.body.id);
    await request(app).post(`/api/shifts/${open.body.id}/close`).set(authed(cashierA2Token)).send({ actualCash: 200 });
  });
});

describe("تزامن (Concurrency)", () => {
  test("فتح شيفت بالتوازي لنفس الكاشير - واحد بس ينجح", async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, () => request(app).post("/api/shifts/open").set(authed(cashierA2Token)).send({ openingCash: 10 }))
    );
    const successes = results.filter((r) => r.status === 201);
    const conflicts = results.filter((r) => r.status === 409);
    expect(successes.length).toBe(1);
    expect(conflicts.length).toBe(4);
    await request(app).post(`/api/shifts/${successes[0].body.id}/close`).set(authed(cashierA2Token)).send({ actualCash: 10 });
  });

  test("قفل نفس الشيفت بالتوازي - واحد بس ينجح", async () => {
    const open = await request(app).post("/api/shifts/open").set(authed(cashierA2Token)).send({ openingCash: 50 });
    const results = await Promise.all(
      Array.from({ length: 5 }, () => request(app).post(`/api/shifts/${open.body.id}/close`).set(authed(cashierA2Token)).send({ actualCash: 50 }))
    );
    const successes = results.filter((r) => r.status === 200);
    expect(successes.length).toBe(1);
  });

  test("مراجعة نفس الشيفت المعلّق بالتوازي - واحد بس ينجح", async () => {
    const open = await request(app).post("/api/shifts/open").set(authed(cashierA2Token)).send({ openingCash: 100 });
    const close = await request(app).post(`/api/shifts/${open.body.id}/close`).set(authed(cashierA2Token)).send({ actualCash: 0 }); // عجز 100 => فوق العتبة
    expect(close.body.status).toBe("PENDING_REVIEW");
    const results = await Promise.all(
      Array.from({ length: 5 }, () => request(app).post(`/api/shifts/${open.body.id}/review`).set(authed(managerAToken)).send({ decision: "acknowledge" }))
    );
    const successes = results.filter((r) => r.status === 200);
    expect(successes.length).toBe(1);
  });
});

// المرحلة 8.6: عجز كاش مؤكّد (approve) لازم يتسجل كسلفة حقيقية على الكاشير - مش يختفي كـvariance_status
// بس. الاختبارات دي بتتأكد من: القيد المحاسبي المتزن، ربط الشيفت بالسلفة، تعامل مختلف مع الزيادة
// (إيراد آخر مش سلفة)، عدم إنشاء أي حاجة لو "إقرار" بس، وتزامن مراجعتين على نفس الشيفت
describe("المرحلة 8.6: عجز/زيادة كاش الشيفت - سلفة موظف + قيود محاسبية", () => {
  let debtBranch, debtManagerToken, debtCashierToken, debtEmployeeId;

  beforeAll(async () => {
    const b = await pool.query("INSERT INTO branches (name) VALUES ('فرع سلفة-شيفت-جست') RETURNING id");
    debtBranch = b.rows[0].id;
    await seedUser({ branchId: debtBranch, name: "مدير-سلفة-شيفت", email: "manager-debt-shift@jest.test", role: "branch_manager" });
    const cashierId = await seedUser({ branchId: debtBranch, name: "كاشير-سلفة-شيفت", email: "cashier-debt-shift@jest.test", role: "cashier" });
    debtManagerToken = await login("manager-debt-shift@jest.test");
    debtCashierToken = await login("cashier-debt-shift@jest.test");
    const emp = await pool.query(
      "INSERT INTO employees (name, department, attendance_system, base_salary, restricted_branch_id, user_id) VALUES ('كاشير-سلفة-شيفت','مبيعات','manual',3000,$1,$2) RETURNING id",
      [debtBranch, cashierId]
    );
    debtEmployeeId = emp.rows[0].id;
  });

  test("عجز مؤكّد (approve) => سلفة حقيقية على الموظف + قيد محاسبي متزن مربوط بالشيفت", async () => {
    const open = await request(app).post("/api/shifts/open").set(authed(debtCashierToken)).send({ openingCash: 500 });
    const close = await request(app).post(`/api/shifts/${open.body.id}/close`).set(authed(debtCashierToken)).send({ actualCash: 400 }); // عجز 100
    expect(close.body.status).toBe("PENDING_REVIEW");

    const review = await request(app).post(`/api/shifts/${open.body.id}/review`).set(authed(debtManagerToken)).send({ decision: "approve" });
    expect(review.status).toBe(200);
    expect(review.body.debtCreated).toBeTruthy();
    expect(Number(review.body.debtCreated.amount)).toBe(100);

    const adjustment = await pool.query(
      "SELECT * FROM payroll_adjustments WHERE shift_id = $1", [open.body.id]
    );
    expect(adjustment.rows.length).toBe(1);
    expect(adjustment.rows[0].adjustment_type).toBe("advance");
    expect(adjustment.rows[0].employee_id).toBe(debtEmployeeId);
    expect(Number(adjustment.rows[0].amount)).toBe(100);

    const journal = await pool.query(
      "SELECT * FROM journal_entries WHERE source_type = 'shift_variance_debt' AND source_id = $1",
      [open.body.id]
    );
    expect(journal.rows.length).toBe(1);
    const lines = await pool.query(
      "SELECT * FROM journal_entry_lines WHERE journal_entry_id = $1", [journal.rows[0].id]
    );
    const totalDebit = lines.rows.reduce((s, l) => s + Number(l.debit), 0);
    const totalCredit = lines.rows.reduce((s, l) => s + Number(l.credit), 0);
    expect(totalDebit).toBe(totalCredit); // القيد لازم يكون متزن دايمًا
    expect(totalDebit).toBe(100);

    const receivableAccount = await pool.query("SELECT * FROM accounts WHERE code = $1", [`1160-${debtEmployeeId}`]);
    expect(receivableAccount.rows.length).toBe(1);
    expect(receivableAccount.rows[0].account_type).toBe("ASSET");
  });

  test("زيادة كاش مؤكّدة (approve) => بترحّل كإيراد آخر (4300)، مش سلفة", async () => {
    const open = await request(app).post("/api/shifts/open").set(authed(debtCashierToken)).send({ openingCash: 500 });
    const close = await request(app).post(`/api/shifts/${open.body.id}/close`).set(authed(debtCashierToken)).send({ actualCash: 600 }); // زيادة 100
    expect(close.body.status).toBe("PENDING_REVIEW");

    const review = await request(app).post(`/api/shifts/${open.body.id}/review`).set(authed(debtManagerToken)).send({ decision: "approve" });
    expect(review.status).toBe(200);
    expect(review.body.debtCreated).toBeNull();

    const adjustment = await pool.query("SELECT * FROM payroll_adjustments WHERE shift_id = $1", [open.body.id]);
    expect(adjustment.rows.length).toBe(0); // مفيش سلفة على زيادة خالص

    const journal = await pool.query(
      "SELECT * FROM journal_entries WHERE source_type = 'shift_variance_surplus' AND source_id = $1",
      [open.body.id]
    );
    expect(journal.rows.length).toBe(1);
  });

  test("إقرار (acknowledge) على عجز - مفيش سلفة ولا قيد محاسبي خالص", async () => {
    const open = await request(app).post("/api/shifts/open").set(authed(debtCashierToken)).send({ openingCash: 500 });
    await request(app).post(`/api/shifts/${open.body.id}/close`).set(authed(debtCashierToken)).send({ actualCash: 450 }); // عجز 50

    const review = await request(app).post(`/api/shifts/${open.body.id}/review`).set(authed(debtManagerToken)).send({ decision: "acknowledge", notes: "خطأ POS معروف" });
    expect(review.status).toBe(200);
    expect(review.body.debtCreated).toBeNull();

    const adjustment = await pool.query("SELECT * FROM payroll_adjustments WHERE shift_id = $1", [open.body.id]);
    expect(adjustment.rows.length).toBe(0);
    const journal = await pool.query(
      "SELECT * FROM journal_entries WHERE source_id = $1 AND source_type IN ('shift_variance_debt','shift_variance_surplus')",
      [open.body.id]
    );
    expect(journal.rows.length).toBe(0);
  });

  test("مراجعتين متزامنتين على نفس الشيفت (approve) - سلفة واحدة بس تتسجل", async () => {
    const open = await request(app).post("/api/shifts/open").set(authed(debtCashierToken)).send({ openingCash: 500 });
    await request(app).post(`/api/shifts/${open.body.id}/close`).set(authed(debtCashierToken)).send({ actualCash: 470 }); // عجز 30

    const results = await Promise.all(
      Array.from({ length: 5 }, () => request(app).post(`/api/shifts/${open.body.id}/review`).set(authed(debtManagerToken)).send({ decision: "approve" }))
    );
    const successes = results.filter((r) => r.status === 200);
    expect(successes.length).toBe(1);

    const adjustment = await pool.query("SELECT * FROM payroll_adjustments WHERE shift_id = $1", [open.body.id]);
    expect(adjustment.rows.length).toBe(1); // مفيش تكرار حتى لو 5 محاولات متزامنة
  });

  test("عجز مؤكّد لكاشير مالوش ملف موظف مربوط - مراجعة بتنجح، مفيش سلفة، وده بيتسجل في الـaudit", async () => {
    const orphanCashierId = await seedUser({ branchId: debtBranch, name: "كاشير-من-غير-ملف-موظف", email: "cashier-no-employee@jest.test", role: "cashier" });
    const orphanToken = await login("cashier-no-employee@jest.test");
    const open = await request(app).post("/api/shifts/open").set(authed(orphanToken)).send({ openingCash: 500 });
    await request(app).post(`/api/shifts/${open.body.id}/close`).set(authed(orphanToken)).send({ actualCash: 450 }); // عجز 50

    const review = await request(app).post(`/api/shifts/${open.body.id}/review`).set(authed(debtManagerToken)).send({ decision: "approve" });
    expect(review.status).toBe(200);
    expect(review.body.status).toBe("CLOSED");
    expect(review.body.debtCreated).toBeNull();

    const audit = await pool.query(
      "SELECT * FROM audit_logs WHERE action = 'SHIFT_VARIANCE_DEBT_SKIPPED_NO_EMPLOYEE' AND entity_id = $1",
      [open.body.id]
    );
    expect(audit.rows.length).toBe(1);
    void orphanCashierId;
  });
});

describe("تقفيل يوم الفرع", () => {
  let dedicatedBranch, dedicatedManagerToken, dedicatedCashierToken;
  const businessDate = "2030-01-15"; // تاريخ مستقبلي مخصص عشان ميتلخبطش مع بيانات اختبارات تانية

  beforeAll(async () => {
    const b = await pool.query("INSERT INTO branches (name) VALUES ('فرع تقفيل-يوم-جست') RETURNING id");
    dedicatedBranch = b.rows[0].id;
    await seedUser({ branchId: dedicatedBranch, name: "مدير-تقفيل-يوم", email: "manager-dayclose@jest.test", role: "branch_manager" });
    await seedUser({ branchId: dedicatedBranch, name: "كاشير-تقفيل-يوم", email: "cashier-dayclose@jest.test", role: "cashier" });
    dedicatedManagerToken = await login("manager-dayclose@jest.test");
    dedicatedCashierToken = await login("cashier-dayclose@jest.test");
  });

  test("الحالة الأولية: مفيش شيفتات ولا طلبات مفتوحة => أخضر وقابل للقفل", async () => {
    const res = await request(app).get(`/api/branch-days/${dedicatedBranch}/status`).set(authed(dedicatedManagerToken));
    expect(res.status).toBe(200);
    expect(res.body.color).toBe("GREEN");
    expect(res.body.canClose).toBe(true);
  });

  test("شيفت شغال بيمنع القفل (أحمر)", async () => {
    const open = await request(app).post("/api/shifts/open").set(authed(dedicatedCashierToken)).send({ openingCash: 0 });
    const status = await request(app).get(`/api/branch-days/${dedicatedBranch}/status`).set(authed(dedicatedManagerToken));
    expect(status.body.color).toBe("RED");
    expect(status.body.canClose).toBe(false);
    expect(status.body.redItems.some((i) => i.code === "ACTIVE_SHIFTS")).toBe(true);

    const closeAttempt = await request(app).post(`/api/branch-days/${dedicatedBranch}/close`).set(authed(dedicatedManagerToken)).send({ businessDate });
    expect(closeAttempt.status).toBe(400);

    await request(app).post(`/api/shifts/${open.body.id}/close`).set(authed(dedicatedCashierToken)).send({ actualCash: 0 });
  });

  test("طلب دليفري لسه تحت التحضير بيمنع القفل (أحمر)", async () => {
    const order = await request(app).post("/api/orders").set(authed(dedicatedCashierToken)).send({
      branchId: dedicatedBranch, source: "pos", orderType: "delivery", customerPhone: "01000000099", paymentMethodId: cashPmId,
      items: [{ itemId: itemBigId, variantId: variantSmall, quantity: 1 }],
    });
    expect(order.status).toBe(201);
    expect(order.body).toHaveProperty("orderId");

    const status = await request(app).get(`/api/branch-days/${dedicatedBranch}/status`).set(authed(dedicatedManagerToken));
    expect(status.body.color).toBe("RED");
    expect(status.body.redItems.some((i) => i.code === "OPEN_ORDERS")).toBe(true);

    const closeAttempt = await request(app).post(`/api/branch-days/${dedicatedBranch}/close`).set(authed(dedicatedManagerToken)).send({ businessDate });
    expect(closeAttempt.status).toBe(400);

    await pool.query("UPDATE orders SET status = 'completed' WHERE id = $1", [order.body.orderId]);
  });

  test("بعد ما كل حاجة اتقفلت/اكتملت - القفل بينجح ويتسجل في branch_days", async () => {
    const res = await request(app).post(`/api/branch-days/${dedicatedBranch}/close`).set(authed(dedicatedManagerToken)).send({ businessDate, managerNotes: "يوم عادي" });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe("CLOSED");
    expect(res.body.business_date.slice(0, 10)).toBe(businessDate);
  });

  test("قفل نفس اليوم تاني بيترفض (اليوم مقفول بالفعل)", async () => {
    const res = await request(app).post(`/api/branch-days/${dedicatedBranch}/close`).set(authed(dedicatedManagerToken)).send({ businessDate });
    expect(res.status).toBe(409);
  });

  test("مدير فرع تاني مينفعش يشوف/يقفل حالة الفرع ده", async () => {
    const res = await request(app).get(`/api/branch-days/${dedicatedBranch}/status`).set(authed(managerBToken));
    expect(res.status).toBe(403);
  });

  test("سجل تقفيلات الفرع بيرجع اليوم اللي اتقفل", async () => {
    const res = await request(app).get(`/api/branch-days/${dedicatedBranch}/history`).set(authed(dedicatedManagerToken));
    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThanOrEqual(1);
  });

  test("قفل يوم تاني بالتوازي (تكرار طلب) - واحد بس ينجح لنفس التاريخ", async () => {
    const businessDate2 = "2030-01-16";
    const results = await Promise.all(
      Array.from({ length: 4 }, () => request(app).post(`/api/branch-days/${dedicatedBranch}/close`).set(authed(dedicatedManagerToken)).send({ businessDate: businessDate2 }))
    );
    const successes = results.filter((r) => r.status === 201);
    expect(successes.length).toBe(1);
  });
});
