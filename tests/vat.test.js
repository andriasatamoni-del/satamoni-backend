// المرحلة 7H: ضريبة القيمة المضافة - ضد Postgres حقيقي. بيغطي: الاستخراج العكسي الصحيح من total
// (مش إضافة فوقه)، توازن القيد المحاسبي مع سطور الضريبة الجديدة، عكس الضريبة صح عند Void وإعادة
// ترحيلها صح عند تعديل الطلب، تقرير ملخّص الضريبة، وفحص المطابقة الجديد بين orders.vat_amount وحساب
// 2300 في دفتر الأستاذ.
//
// ملحوظة مهمة: pos_settings صف واحد مشترك على مستوى القاعدة كلها (زي كل ملفات الاختبار التانية اللي
// بتقرأ منه) - أي اختبار محتاج يغيّر vat_rate مؤقتًا (لاختبار نسبة صفر مثلًا) لازم يرجّعه لقيمته الأصلية
// قبل ما الاختبار يخلص (مش بس في afterAll) عشان ملفات الاختبار التانية اللي بتتشغل بعده في نفس التشغيلة
// (jest --runInBand) متتأثرش.
const { app, request, pool, seedUser, login, authed } = require("./helpers");

let branchA, branchB;
let managerAToken, adminToken, cashierAToken, cashierBToken, callcenterToken;
let itemId, variantId; // سعر 114 - رقم سهل يديله vat_rate=0.14 استخراج صحيح تمامًا: 114/1.14 = 100
let originalVatRate;

beforeAll(async () => {
  const bA = await pool.query("INSERT INTO branches (name) VALUES ('فرع ضريبة-A-جست') RETURNING id");
  branchA = bA.rows[0].id;
  const bB = await pool.query("INSERT INTO branches (name) VALUES ('فرع ضريبة-B-جست') RETURNING id");
  branchB = bB.rows[0].id;

  await seedUser({ branchId: branchA, name: "مدير-ضريبة-A", email: "managerA-vat@jest.test", role: "branch_manager" });
  await seedUser({ branchId: branchA, name: "كاشير-ضريبة-A", email: "cashierA-vat@jest.test", role: "cashier" });
  await seedUser({ branchId: branchB, name: "كاشير-ضريبة-B", email: "cashierB-vat@jest.test", role: "cashier" });
  await seedUser({ name: "أدمن-ضريبة", email: "admin-vat@jest.test", role: "admin" });
  await seedUser({ branchId: branchA, name: "كول سنتر-ضريبة", email: "callcenter-vat@jest.test", role: "callcenter" });

  managerAToken = await login("managerA-vat@jest.test");
  cashierAToken = await login("cashierA-vat@jest.test");
  cashierBToken = await login("cashierB-vat@jest.test");
  adminToken = await login("admin-vat@jest.test");
  callcenterToken = await login("callcenter-vat@jest.test");

  const cat = await pool.query("INSERT INTO menu_categories (name) VALUES ('ضريبة-جست-قسم') RETURNING id");
  const mi = await pool.query("INSERT INTO menu_items (category_id, name) VALUES ($1,'صنف-ضريبة-جست') RETURNING id", [cat.rows[0].id]);
  itemId = mi.rows[0].id;
  const v = await pool.query("INSERT INTO menu_item_variants (item_id, label, price) VALUES ($1,'عادي',114) RETURNING id", [itemId]);
  variantId = v.rows[0].id;

  const settings = await pool.query("SELECT vat_rate FROM pos_settings WHERE id = 1");
  originalVatRate = Number(settings.rows[0].vat_rate);
});

afterAll(async () => {
  // شبكة أمان إضافية - لو أي اختبار فشل في النص وسط تغيير مؤقت للنسبة، ده بيضمن رجوعها لقيمتها الأصلية
  await pool.query("UPDATE pos_settings SET vat_rate = $1 WHERE id = 1", [originalVatRate]);
  await pool.end();
});

async function makeOrder(token, branchId, quantity = 1) {
  const res = await request(app).post("/api/orders").set(authed(token)).send({
    branchId, source: "pos", orderType: "takeaway",
    items: [{ itemId, variantId, quantity }],
  });
  expect(res.status).toBe(201);
  return res.body.orderId;
}

async function getOrder(token, orderId) {
  return request(app).get(`/api/orders/${orderId}`).set(authed(token));
}

// بيرجّع سطور كل القيود المرتبطة بالطلب - قيد البيع الأصلي (source_type='order_sale') وأي قيد عكس ليه
// (source_type='reversal', source_id=معرّف القيد الأصلي - نفس نمط db/accounting-engine.js بالظبط)
async function journalLinesFor(orderId) {
  const res = await pool.query(
    `WITH sale_entries AS (
       SELECT id FROM journal_entries WHERE source_type = 'order_sale' AND source_id = $1
     )
     SELECT a.code, jel.debit, jel.credit, je.status
     FROM journal_entry_lines jel
     JOIN journal_entries je ON je.id = jel.journal_entry_id
     JOIN accounts a ON a.id = jel.account_id
     WHERE je.id IN (SELECT id FROM sale_entries)
        OR (je.source_type = 'reversal' AND je.source_id IN (SELECT id FROM sale_entries))
     ORDER BY je.id, jel.id`,
    [orderId]
  );
  return res.rows;
}

describe("حساب الضريبة عند إنشاء الطلب - استخراج عكسي من total", () => {
  test("سعر 114 بنسبة 14% - الضريبة المستخرجة 14.00 بالظبط، وtotal ميتغيرش", async () => {
    // تأكيد إن النسبة الحالية فعلًا 0.14 قبل ما نعتمد على الحساب - لو الأدمن غيّرها قبل كده في نفس القاعدة
    await pool.query("UPDATE pos_settings SET vat_rate = 0.14 WHERE id = 1");
    const orderId = await makeOrder(cashierAToken, branchA, 1);
    const res = await getOrder(cashierAToken, orderId);
    expect(Number(res.body.total)).toBe(114);
    expect(Number(res.body.vat_amount)).toBeCloseTo(14, 6);
  });

  test("كمية 2 (total=228) - الضريبة 28.00 بالظبط", async () => {
    await pool.query("UPDATE pos_settings SET vat_rate = 0.14 WHERE id = 1");
    const orderId = await makeOrder(cashierAToken, branchA, 2);
    const res = await getOrder(cashierAToken, orderId);
    expect(Number(res.body.total)).toBe(228);
    expect(Number(res.body.vat_amount)).toBeCloseTo(28, 6);
  });

  test("نسبة صفر - الضريبة صفر (وtotal برضه ميتغيرش)", async () => {
    await pool.query("UPDATE pos_settings SET vat_rate = 0 WHERE id = 1");
    try {
      const orderId = await makeOrder(cashierAToken, branchA, 1);
      const res = await getOrder(cashierAToken, orderId);
      expect(Number(res.body.total)).toBe(114);
      expect(Number(res.body.vat_amount)).toBe(0);
    } finally {
      await pool.query("UPDATE pos_settings SET vat_rate = $1 WHERE id = 1", [originalVatRate]);
    }
  });
});

describe("توازن القيد المحاسبي مع سطور الضريبة", () => {
  test("القيد لسه متزن (مدين = دائن) بعد إضافة سطري 4100/2300", async () => {
    await pool.query("UPDATE pos_settings SET vat_rate = 0.14 WHERE id = 1");
    const orderId = await makeOrder(cashierAToken, branchA, 1);
    const lines = await journalLinesFor(orderId);
    const totalDebit = lines.reduce((s, l) => s + Number(l.debit), 0);
    const totalCredit = lines.reduce((s, l) => s + Number(l.credit), 0);
    expect(totalDebit).toBeCloseTo(totalCredit, 6);
  });

  test("حساب 2300 اتقيّد بالضريبة بالظبط، و4100 اتخصم منه نفس القيمة", async () => {
    const orderId = await makeOrder(cashierAToken, branchA, 1);
    const lines = await journalLinesFor(orderId);
    const vatLiabilityCredit = lines.filter(l => l.code === "2300").reduce((s, l) => s + Number(l.credit), 0);
    const foodRevenueCredit = lines.filter(l => l.code === "4100").reduce((s, l) => s + Number(l.credit), 0);
    const foodRevenueDebit = lines.filter(l => l.code === "4100").reduce((s, l) => s + Number(l.debit), 0);
    expect(vatLiabilityCredit).toBeCloseTo(14, 6);
    // 4100 اتقيّد أول حاجة بـ114 (subtotal) دائن، وبعدها 14 (الضريبة) مدين - الصافي 100
    expect(foodRevenueCredit - foodRevenueDebit).toBeCloseTo(100, 6);
  });
});

describe("عكس الضريبة عند الاسترجاع (Void)", () => {
  test("بعد Void، صافي حساب 2300 للطلب ده يرجع صفر", async () => {
    // طلب تيك أواي بيتسجل status='completed' فورًا من لحظة الإنشاء - الاسترجاع الصحيح للحالة دي هو
    // /void (بيرجّعه لـ'cancelled' مع موافقة مدير الفرع/الأدمن)، مش /status العادي
    const orderId = await makeOrder(cashierAToken, branchA, 1);
    const voidRes = await request(app).post(`/api/orders/${orderId}/void`).set(authed(managerAToken)).send({ reason: "اختبار عكس الضريبة" });
    expect(voidRes.status).toBe(200);

    const lines = await journalLinesFor(orderId);
    const netVat = lines.filter(l => l.code === "2300").reduce((s, l) => s + Number(l.credit) - Number(l.debit), 0);
    expect(netVat).toBeCloseTo(0, 6);
  });
});

describe("إعادة حساب الضريبة عند تعديل الطلب", () => {
  test("تعديل الكمية من 1 لـ2 - vat_amount يتحدّث ويتوازن القيد الجديد", async () => {
    const orderId = await makeOrder(cashierAToken, branchA, 1);
    // الطلب لازم يبقى status='preparing' عشان يتعدل - طلب تيك أواي بيتسجل 'completed' فورًا، فمنستخدمش
    // مسار التعديل هنا على طلب تيك أواي. بدل كده نتأكد من التوازن على طلب دليفري (يبدأ 'preparing')
    const deliveryOrderRes = await request(app).post("/api/orders").set(authed(cashierAToken)).send({
      branchId: branchA, source: "pos", orderType: "delivery",
      customerPhone: `018${Date.now()}`.slice(0, 11), addressDetails: "شارع الاختبار",
      items: [{ itemId, variantId, quantity: 1 }],
    });
    expect(deliveryOrderRes.status).toBe(201);
    const deliveryOrderId = deliveryOrderRes.body.orderId;

    const editRes = await request(app).put(`/api/orders/${deliveryOrderId}`).set(authed(cashierAToken)).send({
      items: [{ itemId, variantId, quantity: 2 }],
    });
    expect(editRes.status).toBe(200);
    expect(Number(editRes.body.total)).toBe(228);
    expect(Number(editRes.body.vat_amount)).toBeCloseTo(28, 6);

    const lines = await journalLinesFor(deliveryOrderId);
    const totalDebit = lines.reduce((s, l) => s + Number(l.debit), 0);
    const totalCredit = lines.reduce((s, l) => s + Number(l.credit), 0);
    expect(totalDebit).toBeCloseTo(totalCredit, 6);
    const netVat = lines.filter(l => l.code === "2300").reduce((s, l) => s + Number(l.credit) - Number(l.debit), 0);
    expect(netVat).toBeCloseTo(28, 6);
  });
});

describe("PATCH /api/pos-settings - vat_rate", () => {
  test("أدمن يقدر يغيّر نسبة الضريبة", async () => {
    const res = await request(app).patch("/api/pos-settings").set(authed(adminToken)).send({ vatRate: 0.15 });
    expect(res.status).toBe(200);
    expect(Number(res.body.vat_rate)).toBeCloseTo(0.15, 6);
    await pool.query("UPDATE pos_settings SET vat_rate = $1 WHERE id = 1", [originalVatRate]);
  });

  test("مدير فرع/كاشير معندهمش صلاحية يغيّروا الإعدادات", async () => {
    const res1 = await request(app).patch("/api/pos-settings").set(authed(managerAToken)).send({ vatRate: 0.2 });
    expect(res1.status).toBe(403);
    const res2 = await request(app).patch("/api/pos-settings").set(authed(cashierAToken)).send({ vatRate: 0.2 });
    expect(res2.status).toBe(403);
  });

  test("نسبة خارج المدى (0-1) مرفوضة", async () => {
    const res = await request(app).patch("/api/pos-settings").set(authed(adminToken)).send({ vatRate: 1.5 });
    expect(res.status).toBe(400);
  });
});

describe("تقرير ملخّص الضريبة (vat-summary)", () => {
  test("بيرجّع إجمالي وصافي وضريبة صحيحين لفرع محدد", async () => {
    await pool.query("UPDATE pos_settings SET vat_rate = 0.14 WHERE id = 1");
    const orderId = await makeOrder(cashierAToken, branchA, 1);
    const orderRes = await getOrder(cashierAToken, orderId);
    const createdAt = new Date(orderRes.body.created_at);
    const year = createdAt.getUTCFullYear();
    const month = createdAt.getUTCMonth() + 1;

    const res = await request(app)
      .get(`/api/reports/vat-summary?year=${year}&month=${month}&branchId=${branchA}`)
      .set(authed(adminToken));
    expect(res.status).toBe(200);
    expect(res.body.grossSales).toBeGreaterThanOrEqual(114);
    expect(res.body.vatCollected).toBeGreaterThanOrEqual(14);
    expect(res.body.netSales).toBeCloseTo(res.body.grossSales - res.body.vatCollected, 4);
    const branchRow = res.body.byBranch.find(b => b.branchId === branchA);
    expect(branchRow).toBeTruthy();
    expect(branchRow.netSales).toBeCloseTo(branchRow.grossSales - branchRow.vatCollected, 4);
  });

  test("كاشير/كول سنتر معندهمش صلاحية accounting.view يشوفوا تقرير الضريبة", async () => {
    const res1 = await request(app).get("/api/reports/vat-summary?year=2026&month=1").set(authed(cashierAToken));
    expect(res1.status).toBe(403);
    const res2 = await request(app).get("/api/reports/vat-summary?year=2026&month=1").set(authed(callcenterToken));
    expect(res2.status).toBe(403);
  });

  test("مدير فرع مقفول على فرعه بس حتى لو حدد فرع تاني", async () => {
    const res = await request(app)
      .get(`/api/reports/vat-summary?year=2026&month=1&branchId=${branchB}`)
      .set(authed(managerAToken));
    expect(res.status).toBe(200);
    expect(res.body.branchId).toBe(branchA);
  });
});

describe("فحص المطابقة الجديد - الضريبة التشغيلية مقابل حساب 2300", () => {
  test("orders.vat_amount مقابل رصيد 2300 الدائن - متطابقين", async () => {
    await pool.query("UPDATE pos_settings SET vat_rate = 0.14 WHERE id = 1");
    const orderId = await makeOrder(cashierAToken, branchA, 1);
    const orderRes = await getOrder(cashierAToken, orderId);
    const createdAt = new Date(orderRes.body.created_at);
    const year = createdAt.getUTCFullYear();
    const month = createdAt.getUTCMonth() + 1;

    const res = await request(app)
      .get(`/api/reports/accounting-reconciliation?year=${year}&month=${month}&branchId=${branchA}`)
      .set(authed(adminToken));
    expect(res.status).toBe(200);
    const vatCheck = res.body.checks.find(c => c.name.includes("ضريبة القيمة المضافة"));
    expect(vatCheck).toBeTruthy();
    expect(vatCheck.matched).toBe(true);
    expect(Math.abs(vatCheck.diff)).toBeLessThan(0.01);
  });
});
