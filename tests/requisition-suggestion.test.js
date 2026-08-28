// Procurement v2 STEP E: محرك اقتراح الطلبية اليومية الواعي بيوم الأسبوع - db/requisition-suggestion.js
// + GET /api/kitchen-orders/suggested. اختبارات مباشرة على المحرك (بـpool زي أي كود تاني في المشروع)
// + اختبارات API فوقه.
const { app, request, pool, seedUser, login, authed } = require("./helpers");
const { pastOccurrencesOfWeekday, averageWeekdayConsumption, computeSuggestedQuantity, generateSuggestedRequisition } = require("../db/requisition-suggestion");

let branchId, otherBranchId;
let adminToken, managerToken, otherManagerToken;
let thursdayItemId, noParItemId;

// آخر خميس حقيقي قبل أو يساوي تاريخ معيّن - عشان نبني بيانات اختبار متسقة بغض النظر عن تاريخ تشغيل الاختبار
function lastWeekday(fromDate, weekday) {
  const d = new Date(`${fromDate}T00:00:00Z`);
  while (d.getUTCDay() !== weekday) d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

beforeAll(async () => {
  const b1 = await pool.query("INSERT INTO branches (name) VALUES ('فرع اقتراح-جست') RETURNING id");
  branchId = b1.rows[0].id;
  const b2 = await pool.query("INSERT INTO branches (name) VALUES ('فرع تاني اقتراح-جست') RETURNING id");
  otherBranchId = b2.rows[0].id;

  await seedUser({ name: "أدمن-اقتراح", email: "admin-suggest@jest.test", role: "admin" });
  await seedUser({ branchId, name: "مدير فرع-اقتراح", email: "manager-suggest@jest.test", role: "branch_manager" });
  await seedUser({ branchId: otherBranchId, name: "مدير فرع تاني-اقتراح", email: "othermanager-suggest@jest.test", role: "branch_manager" });
  adminToken = await login("admin-suggest@jest.test");
  managerToken = await login("manager-suggest@jest.test");
  otherManagerToken = await login("othermanager-suggest@jest.test");

  const item1 = await pool.query("INSERT INTO inventory_items (name, unit, unit_cost) VALUES ('صنف خميس-جست', 'KG', 5) RETURNING id");
  thursdayItemId = item1.rows[0].id;
  const item2 = await pool.query("INSERT INTO inventory_items (name, unit, unit_cost) VALUES ('صنف من غير حدود-جست', 'KG', 5) RETURNING id");
  noParItemId = item2.rows[0].id;

  // thursdayItemId: حدود مضبوطة + استهلاك خميسات معروف. noParItemId: مفيش حدود خالص (مينفعش يترشّح للاقتراح)
  await pool.query(
    `INSERT INTO branch_inventory_stock (branch_id, inventory_item_id, quantity, min_stock, max_stock, reorder_point)
     VALUES ($1,$2,20,5,100,10)`,
    [branchId, thursdayItemId]
  );
  await pool.query(
    "INSERT INTO branch_inventory_stock (branch_id, inventory_item_id, quantity) VALUES ($1,$2,20)",
    [branchId, noParItemId]
  );

  // آخر 3 خميسات: استهلاك 30، 40، 50 - متوسط = 40. أي خميس أقدم من كده (لو lookbackWeeks أكبر) هيتحسب صفر
  const today = new Date().toISOString().slice(0, 10);
  const thu0 = lastWeekday(today, 4); // 4 = Thursday (UTC getDay())
  const thursdays = [];
  for (let i = 0; i < 3; i++) {
    const d = new Date(`${thu0}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - i * 7);
    thursdays.push(d.toISOString().slice(0, 10));
  }
  const consumptions = [30, 40, 50]; // من الأحدث للأقدم
  for (let i = 0; i < thursdays.length; i++) {
    await pool.query(
      `INSERT INTO inventory_movements (branch_id, inventory_item_id, movement_type, quantity, business_date)
       VALUES ($1,$2,'SALE',$3,$4)`,
      [branchId, thursdayItemId, -consumptions[i], thursdays[i]]
    );
  }
  global.__testThursday = thu0;
});

afterAll(async () => {
  await pool.end();
});

describe("db/requisition-suggestion.js - averageWeekdayConsumption", () => {
  test("متوسط 3 خميسات معروفة (30/40/50) على مدار 3 أسابيع = 40", async () => {
    const nextThursday = new Date(`${global.__testThursday}T00:00:00Z`);
    nextThursday.setUTCDate(nextThursday.getUTCDate() + 7);
    const { average, occurrencesUsed } = await averageWeekdayConsumption(pool, {
      branchId, inventoryItemId: thursdayItemId, targetDate: nextThursday.toISOString().slice(0, 10), lookbackWeeks: 3,
    });
    expect(occurrencesUsed).toBe(3);
    expect(average).toBeCloseTo(40, 5);
  });

  test("توسيع lookbackWeeks لأسابيع من غير بيانات - بتتحسب أصفار مش بتتجاهل (المتوسط بينزل)", async () => {
    const nextThursday = new Date(`${global.__testThursday}T00:00:00Z`);
    nextThursday.setUTCDate(nextThursday.getUTCDate() + 7);
    const { average, occurrencesUsed } = await averageWeekdayConsumption(pool, {
      branchId, inventoryItemId: thursdayItemId, targetDate: nextThursday.toISOString().slice(0, 10), lookbackWeeks: 6,
    });
    expect(occurrencesUsed).toBe(6);
    // (30+40+50+0+0+0)/6 = 20
    expect(average).toBeCloseTo(20, 5);
  });

  test("pastOccurrencesOfWeekday بيرجع نفس يوم الأسبوع بالظبط", () => {
    const dates = pastOccurrencesOfWeekday("2026-09-03", 4); // 2026-09-03 خميس
    for (const d of dates) {
      expect(new Date(`${d}T00:00:00Z`).getUTCDay()).toBe(4);
    }
    expect(dates.length).toBe(4);
  });
});

describe("db/requisition-suggestion.js - computeSuggestedQuantity", () => {
  test("target = متوسط الاستهلاك + min_stock، مسقوف بـmax_stock، ناقص الرصيد الحالي", async () => {
    const nextThursday = new Date(`${global.__testThursday}T00:00:00Z`);
    nextThursday.setUTCDate(nextThursday.getUTCDate() + 7);
    const res = await computeSuggestedQuantity(pool, {
      branchId, inventoryItemId: thursdayItemId, targetDate: nextThursday.toISOString().slice(0, 10), lookbackWeeks: 3,
    });
    // avg=40, min=5 => target=45 (أقل من max=100) - current=20 => suggested=25
    expect(res.avgWeekdayConsumption).toBeCloseTo(40, 5);
    expect(res.suggestedQuantity).toBeCloseTo(25, 5);
  });

  test("سقف max_stock بيقيّد الاقتراح حتى لو المتوسط+الأدنى تخطاه", async () => {
    const branch2 = await pool.query("INSERT INTO branches (name) VALUES ('فرع سقف-جست') RETURNING id");
    const b2 = branch2.rows[0].id;
    await pool.query(
      "INSERT INTO branch_inventory_stock (branch_id, inventory_item_id, quantity, min_stock, max_stock) VALUES ($1,$2,0,10,35)",
      [b2, thursdayItemId]
    );
    const nextThursday = new Date(`${global.__testThursday}T00:00:00Z`);
    nextThursday.setUTCDate(nextThursday.getUTCDate() + 7);
    await pool.query(
      `INSERT INTO inventory_movements (branch_id, inventory_item_id, movement_type, quantity, business_date)
       VALUES ($1,$2,'SALE',-100,$3)`,
      [b2, thursdayItemId, global.__testThursday]
    );
    const res = await computeSuggestedQuantity(pool, {
      branchId: b2, inventoryItemId: thursdayItemId, targetDate: nextThursday.toISOString().slice(0, 10), lookbackWeeks: 1,
    });
    // avg=100, min=10 => target أصله 110 لكن مسقوف على max=35 - current=0 => suggested=35 (مش 110)
    expect(res.suggestedQuantity).toBeCloseTo(35, 5);
  });

  test("صنف جديد من غير أي تاريخ استهلاك - avg=0، الاقتراح بيعتمد بس على min_stock", async () => {
    const branch3 = await pool.query("INSERT INTO branches (name) VALUES ('فرع صنف جديد-جست') RETURNING id");
    const b3 = branch3.rows[0].id;
    await pool.query(
      "INSERT INTO branch_inventory_stock (branch_id, inventory_item_id, quantity, min_stock) VALUES ($1,$2,2,15)",
      [b3, thursdayItemId]
    );
    const res = await computeSuggestedQuantity(pool, {
      branchId: b3, inventoryItemId: thursdayItemId, targetDate: "2026-09-10", lookbackWeeks: 4,
    });
    expect(res.avgWeekdayConsumption).toBe(0);
    expect(res.suggestedQuantity).toBeCloseTo(13, 5); // 0+15-2
  });
});

describe("GET /api/kitchen-orders/suggested", () => {
  test("بيرجّع الأصناف اللي ليها حدود بس، ومايرجّعش الصنف من غير حدود خالص", async () => {
    const nextThursday = new Date(`${global.__testThursday}T00:00:00Z`);
    nextThursday.setUTCDate(nextThursday.getUTCDate() + 7);
    const res = await request(app).get(
      `/api/kitchen-orders/suggested?branchId=${branchId}&targetDate=${nextThursday.toISOString().slice(0, 10)}&lookbackWeeks=3`
    ).set(authed(managerToken));
    expect(res.status).toBe(200);
    const ids = res.body.suggestions.map((s) => s.inventoryItemId);
    expect(ids).toContain(thursdayItemId);
    expect(ids).not.toContain(noParItemId);
    const thu = res.body.suggestions.find((s) => s.inventoryItemId === thursdayItemId);
    expect(thu.suggestedQuantity).toBeCloseTo(25, 5);
  });

  test("فرع تاني ممنوع يشوف اقتراح فرع مش بتاعه", async () => {
    const res = await request(app).get(`/api/kitchen-orders/suggested?branchId=${branchId}`).set(authed(otherManagerToken));
    expect(res.status).toBe(403);
  });

  test("الاقتراح بيتربط فعليًا بـPOST / (status:'DRAFT') - quantitySuggested بتتسجل زي ما هي", async () => {
    const nextThursday = new Date(`${global.__testThursday}T00:00:00Z`);
    nextThursday.setUTCDate(nextThursday.getUTCDate() + 7);
    const suggested = await request(app).get(
      `/api/kitchen-orders/suggested?branchId=${branchId}&targetDate=${nextThursday.toISOString().slice(0, 10)}&lookbackWeeks=3`
    ).set(authed(managerToken));
    const items = suggested.body.suggestions
      .filter((s) => s.suggestedQuantity > 0)
      .map((s) => ({ inventoryItemId: s.inventoryItemId, quantityRequested: s.suggestedQuantity, quantitySuggested: s.suggestedQuantity }));
    const created = await request(app).post("/api/kitchen-orders").set(authed(managerToken)).send({
      branchId, status: "DRAFT", isAutoSuggested: true, items,
    });
    expect(created.status).toBe(201);
    const check = await pool.query("SELECT is_auto_suggested FROM kitchen_orders WHERE id = $1", [created.body.orderId]);
    expect(check.rows[0].is_auto_suggested).toBe(true);
    const itemRow = await pool.query(
      "SELECT quantity_requested, quantity_suggested FROM kitchen_order_items WHERE kitchen_order_id = $1", [created.body.orderId]
    );
    expect(Number(itemRow.rows[0].quantity_requested)).toBeCloseTo(25, 5);
    expect(Number(itemRow.rows[0].quantity_suggested)).toBeCloseTo(25, 5);
  });
});
