// المرحلة 7U: تدقيق عدائي شامل قبل التشغيل الحقيقي - ضد Postgres حقيقي. الهدف هنا مش تغطية سعيدة زي
// باقي الاختبارات - الهدف نحاول "نكسر" النظام فعليًا (سباقات تزامن، انتقالات حالة غير شرعية، عزل فروع،
// تحقق مبلغ/مخزون) على الأجزاء اللي بنيت في المرحلة 7 (7E-7T) واللي معندهاش نفس عمق اختبارات
// phase5-integration.test.js/phase6-hardening.test.js على الوحدات الأقدم (المخزون/المحاسبة/المشتريات
// الرسمية).
const { app, request, pool, seedUser, login, authed } = require("./helpers");

let branchA, branchB;
let adminToken, managerAToken, managerBToken, cashierAToken;
let cashPmId, itemId, variantId, areaId;

beforeAll(async () => {
  const bA = await pool.query("INSERT INTO branches (name) VALUES ('فرع-7U-A-جست') RETURNING id");
  branchA = bA.rows[0].id;
  const bB = await pool.query("INSERT INTO branches (name) VALUES ('فرع-7U-B-جست') RETURNING id");
  branchB = bB.rows[0].id;

  await seedUser({ name: "أدمن-7U", email: "admin-7u@jest.test", role: "admin" });
  await seedUser({ branchId: branchA, name: "مدير-7U-A", email: "managerA-7u@jest.test", role: "branch_manager" });
  await seedUser({ branchId: branchB, name: "مدير-7U-B", email: "managerB-7u@jest.test", role: "branch_manager" });
  await seedUser({ branchId: branchA, name: "كاشير-7U-A", email: "cashierA-7u@jest.test", role: "cashier" });

  adminToken = await login("admin-7u@jest.test");
  managerAToken = await login("managerA-7u@jest.test");
  managerBToken = await login("managerB-7u@jest.test");
  cashierAToken = await login("cashierA-7u@jest.test");

  const pm = await pool.query("INSERT INTO payment_methods (name, kind) VALUES ('كاش-7U-جست', 'cash') RETURNING id");
  cashPmId = pm.rows[0].id;
  const cat = await pool.query("INSERT INTO menu_categories (name) VALUES ('7U-جست-قسم') RETURNING id");
  const mi = await pool.query("INSERT INTO menu_items (category_id, name) VALUES ($1,'صنف-7U-جست') RETURNING id", [cat.rows[0].id]);
  itemId = mi.rows[0].id;
  const v = await pool.query("INSERT INTO menu_item_variants (item_id, label, price) VALUES ($1,'عادي',100) RETURNING id", [itemId]);
  variantId = v.rows[0].id;
  const area = await pool.query("INSERT INTO delivery_areas (name, fee, min_order, branch_id) VALUES ('منطقة-7U-جست', 10, 0, $1) RETURNING id", [branchA]);
  areaId = area.rows[0].id;
});

afterAll(async () => {
  await pool.end();
});

// ============================================================
// 1. سباق تزامن حقيقي على routes/purchases.js - /:id/confirm و /:id/reject
// ============================================================
// النقطة دي اتكشفت بمقارنة الكود مع الأنماط المتماثلة في expenses.js/driver-settlements.js/
// purchase-returns.js - التلاتة دول بيستخدموا BEGIN + SELECT...FOR UPDATE قبل أي تغيير حالة، بينما
// purchases.js's confirm/reject بيقروا الحالة (بدون قفل) وبعدين يعملوا UPDATE من غير أي شرط WHERE
// status='PENDING' - يعني نافذة سباق حقيقية: طلبين متزامنين (زي مدير وموظف تاني بيراجعوا في نفس اللحظة)
// ممكن الاتنين يعدّوا فحص "لسه PENDING" قبل ما أي حد يكتب، فالاتنين ينجحوا، والنتيجة النهائية عشوائية
// (آخر UPDATE بيكسب) بدل ما يترفض التاني برسالة واضحة.
describe("سباق تزامن: مراجعة نفس المشترى النقدي (confirm/reject) بالتوازي", () => {
  async function makePendingPurchase() {
    const res = await request(app).post("/api/purchases").set(authed(cashierAToken)).send({
      amount: 500, category: "اختبار 7U",
    });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe("PENDING");
    return res.body.id;
  }

  test("5 طلبات confirm متزامنة لنفس المشترى - المفروض نجاح واحد بس", async () => {
    const purchaseId = await makePendingPurchase();
    const results = await Promise.all(
      Array.from({ length: 5 }, () => request(app).post(`/api/purchases/${purchaseId}/confirm`).set(authed(managerAToken)))
    );
    const successes = results.filter((r) => r.status === 200);
    expect(successes.length).toBe(1);

    const row = await pool.query("SELECT status FROM purchases WHERE id = $1", [purchaseId]);
    expect(row.rows[0].status).toBe("CONFIRMED");
  });

  test("confirm و reject متزامنين لنفس المشترى - واحد بس ينجح، مش الاتنين", async () => {
    const purchaseId = await makePendingPurchase();
    const [confirmRes, rejectRes] = await Promise.all([
      request(app).post(`/api/purchases/${purchaseId}/confirm`).set(authed(managerAToken)),
      request(app).post(`/api/purchases/${purchaseId}/reject`).set(authed(managerAToken)).send({ reason: "سبب اختباري" }),
    ]);
    const successes = [confirmRes, rejectRes].filter((r) => r.status === 200);
    expect(successes.length).toBe(1);

    // الحالة النهائية لازم تطابق الطلب اللي فعلًا نجح - مش نتيجة عشوائية من آخر UPDATE كسب السباق
    const row = await pool.query("SELECT status FROM purchases WHERE id = $1", [purchaseId]);
    if (confirmRes.status === 200) expect(row.rows[0].status).toBe("CONFIRMED");
    else expect(row.rows[0].status).toBe("REJECTED");
  });
});

// ============================================================
// 2. تحقق (مش سباق) لباقي مسارات المراجعة اللي بتستخدم FOR UPDATE فعلًا - للتأكد إنها فعلًا محصّنة
// ============================================================
describe("تحقق: مسارات المراجعة التانية (expenses/purchase-returns) فعلًا محصّنة ضد نفس النوع من السباق", () => {
  test("expenses/:id/review - 5 مراجعات متزامنة لنفس المصروف - نجاح واحد بس", async () => {
    const ec = await pool.query("INSERT INTO expense_categories (name) VALUES ('بند-7U-تزامن-جست') RETURNING id");
    const exp = await request(app).post("/api/expenses").set(authed(cashierAToken)).send({
      categoryId: ec.rows[0].id, amount: 200, notes: "اختبار تزامن 7U",
    });
    expect(exp.status).toBe(201);
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        request(app).post(`/api/expenses/${exp.body.id}/review`).set(authed(managerAToken)).send({ decision: "post" }))
    );
    const successes = results.filter((r) => r.status === 200);
    expect(successes.length).toBe(1);
  });
});

// ============================================================
// 3. عزل الفروع على نقاط 7K الجديدة (المشتريات النقدية للكاشير) - GET و POST/PATCH مع بعض
// ============================================================
describe("عزل الفروع: مدير فرع تاني ممنوع من مراجعة مشترى فرع مش بتاعه (تأكيد إضافي من زاوية 7U)", () => {
  test("مدير فرع B يحاول يراجع مشترى فرع A - 403، والحالة تفضل PENDING", async () => {
    const created = await request(app).post("/api/purchases").set(authed(cashierAToken)).send({ amount: 300 });
    const res = await request(app).post(`/api/purchases/${created.body.id}/confirm`).set(authed(managerBToken));
    expect(res.status).toBe(403);
    const row = await pool.query("SELECT status FROM purchases WHERE id = $1", [created.body.id]);
    expect(row.rows[0].status).toBe("PENDING");
  });
});

// ============================================================
// 4. هجوم انتقالات حالة غير شرعية على دورة حياة الطلب
// ============================================================
describe("هجوم انتقالات غير شرعية على دورة حياة الطلب", () => {
  async function makeOrder(status = "preparing") {
    const res = await request(app).post("/api/orders").set(authed(cashierAToken)).send({
      branchId: branchA, source: "pos", orderType: "takeaway", paymentMethodId: cashPmId,
      items: [{ itemId, variantId, quantity: 1 }],
    });
    expect(res.status).toBe(201);
    return res.body.orderId;
  }

  test("mutfaq_status: قفزة من NEW مباشرة لـCOMPLETED (تخطي ACCEPTED/PREPARING/READY) - مرفوضة", async () => {
    const orderId = await makeOrder();
    const res = await request(app).patch(`/api/orders/${orderId}/kitchen-status`).set(authed(cashierAToken)).send({
      status: "COMPLETED",
    });
    expect(res.status).toBe(400);
  });

  test("طلب دليفري (لسه preparing) اتلغى - محاولة تحويله لـkitchen-status بعد الإلغاء مرفوضة", async () => {
    const delivery = await request(app).post("/api/orders").set(authed(cashierAToken)).send({
      branchId: branchA, source: "pos", orderType: "delivery", customerPhone: "01011112223",
      addressDetails: "عنوان 7U", deliveryAreaId: areaId, paymentMethodId: cashPmId,
      items: [{ itemId, variantId, quantity: 1 }],
    });
    expect(delivery.status).toBe(201);
    const orderId = delivery.body.orderId;
    const orderRow = await pool.query("SELECT status FROM orders WHERE id = $1", [orderId]);
    expect(orderRow.rows[0].status).toBe("preparing");

    const cancel = await request(app).patch(`/api/orders/${orderId}/status`).set(authed(cashierAToken)).send({ status: "cancelled" });
    expect(cancel.status).toBe(200);
    const advance = await request(app).patch(`/api/orders/${orderId}/kitchen-status`).set(authed(cashierAToken)).send({ status: "ACCEPTED" });
    expect(advance.status).toBe(400);
  });

  // ملحوظة توثيق: القيد المحاسبي الأصلي للبيع مصدره source_type='order_sale'، لكن قيد العكس (اللي void
  // بينشئه) بيتسجل بـsource_type='reversal' وsource_id = معرّف القيد الأصلي (مش معرّف الطلب) -
  // db/accounting-engine.js's reverseJournalEntry. لازم نمر عبر القيد الأصلي عشان نلاقي قيد العكس.
  async function findReversalCount(orderId) {
    const original = await pool.query(
      "SELECT id FROM journal_entries WHERE source_type = 'order_sale' AND source_id = $1",
      [orderId]
    );
    if (original.rows.length === 0) return 0;
    const reversal = await pool.query(
      "SELECT COUNT(*)::int AS c FROM journal_entries WHERE source_type = 'reversal' AND source_id = $1",
      [original.rows[0].id]
    );
    return reversal.rows[0].c;
  }

  test("طلب مكتمل (completed) - void مرتين متتاليين: التاني لازم يترفض (مش عكس مزدوج للمخزون/المحاسبة)", async () => {
    const orderId = await makeOrder();
    // بيع takeaway بيتسجل completed على طول (initialStatus) - نتأكد
    const orderRow = await pool.query("SELECT status FROM orders WHERE id = $1", [orderId]);
    expect(orderRow.rows[0].status).toBe("completed");

    const void1 = await request(app).post(`/api/orders/${orderId}/void`).set(authed(managerAToken)).send({ reason: "اختبار 7U" });
    expect(void1.status).toBe(200);
    const void2 = await request(app).post(`/api/orders/${orderId}/void`).set(authed(managerAToken)).send({ reason: "محاولة تانية" });
    expect(void2.status).toBe(400);

    expect(await findReversalCount(orderId)).toBe(1);
  });

  test("void مزدوج متزامن (سباق حقيقي مش تسلسلي) - نجاح واحد بس، وعكس مخزون/محاسبة مرة واحدة بس", async () => {
    const orderId = await makeOrder();
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        request(app).post(`/api/orders/${orderId}/void`).set(authed(managerAToken)).send({ reason: "سباق 7U" }))
    );
    const successes = results.filter((r) => r.status === 200);
    expect(successes.length).toBe(1);
    expect(await findReversalCount(orderId)).toBe(1);
  });
});

// ============================================================
// 5. تحقق مبلغ: القيد المحاسبي متزن (مدين = دائن) لكل نوع عملية جوهرية أُنشئت في هذا الملف
// ============================================================
describe("تحقق المبلغ: مدين = دائن على كل قيد اتسجل من اختبارات 7U", () => {
  test("مفيش أي قيد غير متزن في journal_entries اللي اتسجلوا في الجلسة دي", async () => {
    const unbalanced = await pool.query(`
      SELECT je.id, je.source_type, je.source_id,
             COALESCE(SUM(jl.debit), 0) AS total_debit,
             COALESCE(SUM(jl.credit), 0) AS total_credit
      FROM journal_entries je
      JOIN journal_entry_lines jl ON jl.journal_entry_id = je.id
      WHERE je.created_at > now() - interval '5 minutes'
      GROUP BY je.id, je.source_type, je.source_id
      HAVING ABS(COALESCE(SUM(jl.debit), 0) - COALESCE(SUM(jl.credit), 0)) > 0.01
    `);
    expect(unbalanced.rows).toEqual([]);
  });
});

// ============================================================
// 6. مدخلات فاسدة/خبيثة على POST /api/orders
// ============================================================
describe("مدخلات فاسدة على إنشاء الطلب", () => {
  test("branchId مش موجود أصلًا - مرفوض من غير 500 (لازم رسالة تجارية واضحة مش انهيار)", async () => {
    const res = await request(app).post("/api/orders").set(authed(cashierAToken)).send({
      branchId: 999999999, source: "pos", orderType: "takeaway", paymentMethodId: cashPmId,
      items: [{ itemId, variantId, quantity: 1 }],
    });
    expect(res.status).toBeLessThan(500);
  });

  test("variantId مش تابع للـitemId المبعوت - مرفوض", async () => {
    const otherItem = await pool.query("INSERT INTO menu_items (category_id, name) VALUES ((SELECT category_id FROM menu_items WHERE id=$1), 'صنف-تاني-7U') RETURNING id", [itemId]);
    const otherVariant = await pool.query("INSERT INTO menu_item_variants (item_id, label, price) VALUES ($1,'عادي',50) RETURNING id", [otherItem.rows[0].id]);
    const res = await request(app).post("/api/orders").set(authed(cashierAToken)).send({
      branchId: branchA, source: "pos", orderType: "takeaway", paymentMethodId: cashPmId,
      items: [{ itemId, variantId: otherVariant.rows[0].id, quantity: 1 }],
    });
    expect(res.status).toBeLessThan(500);
    expect(res.status).not.toBe(201);
  });

  test("items[] فاضية - مرفوض 400", async () => {
    const res = await request(app).post("/api/orders").set(authed(cashierAToken)).send({
      branchId: branchA, source: "pos", orderType: "takeaway", paymentMethodId: cashPmId, items: [],
    });
    expect(res.status).toBe(400);
  });

  test("discount أكبر من subtotal (نسبة مستحيلة) - مرفوض أو بيتقفل عند صفر، مش إجمالي سالب", async () => {
    const res = await request(app).post("/api/orders").set(authed(cashierAToken)).send({
      branchId: branchA, source: "pos", orderType: "takeaway", paymentMethodId: cashPmId,
      items: [{ itemId, variantId, quantity: 1 }], discount: 999999,
    });
    if (res.status === 201) {
      expect(Number(res.body.total)).toBeGreaterThanOrEqual(0);
    } else {
      expect(res.status).toBeLessThan(500);
    }
  });
});

// ============================================================
// 7. محاكاة يوم تشغيل كامل - سيناريو متصل واحد، والتحقق النهائي: كل جنيه وكل وحدة مخزون قابلة للتفسير
// ============================================================
describe("محاكاة يوم تشغيل كامل: فتح شيفت -> بيع -> مصروف -> إقفال -> مطابقة", () => {
  let dayBranchId, dayManagerToken, dayCashierToken, dayItemId, dayVariantId, ingredientId;

  beforeAll(async () => {
    const b = await pool.query("INSERT INTO branches (name, supports_dine_in) VALUES ('فرع-يوم-كامل-7U-جست', TRUE) RETURNING id");
    dayBranchId = b.rows[0].id;
    await seedUser({ branchId: dayBranchId, name: "مدير-يوم-كامل-7U", email: "manager-fullday-7u@jest.test", role: "branch_manager" });
    await seedUser({ branchId: dayBranchId, name: "كاشير-يوم-كامل-7U", email: "cashier-fullday-7u@jest.test", role: "cashier" });
    dayManagerToken = await login("manager-fullday-7u@jest.test");
    dayCashierToken = await login("cashier-fullday-7u@jest.test");

    const cat = await pool.query("INSERT INTO menu_categories (name) VALUES ('يوم-كامل-7U-قسم') RETURNING id");
    const mi = await pool.query("INSERT INTO menu_items (category_id, name) VALUES ($1,'صنف-يوم-كامل-7U') RETURNING id", [cat.rows[0].id]);
    dayItemId = mi.rows[0].id;
    const v = await pool.query("INSERT INTO menu_item_variants (item_id, label, price) VALUES ($1,'عادي',200) RETURNING id", [dayItemId]);
    dayVariantId = v.rows[0].id;

    const ing = await pool.query("INSERT INTO inventory_items (name, unit) VALUES ('مكوّن-يوم-كامل-7U', 'كيلو') RETURNING id");
    ingredientId = ing.rows[0].id;
    await pool.query(
      "INSERT INTO branch_inventory_stock (branch_id, inventory_item_id, quantity) VALUES ($1,$2,100)",
      [dayBranchId, ingredientId]
    );
  });

  test("السيناريو الكامل بيتنفذ من غير أخطاء، وكل رقم قابل للتفسير في الآخر", async () => {
    // 1) فتح شيفت
    const shiftOpen = await request(app).post("/api/shifts/open").set(authed(dayCashierToken)).send({
      branchId: dayBranchId, openingCash: 500,
    });
    expect(shiftOpen.status).toBe(201);
    const shiftId = shiftOpen.body.id;

    // 2) بيع كاش عادي
    const sale1 = await request(app).post("/api/orders").set(authed(dayCashierToken)).send({
      branchId: dayBranchId, source: "pos", orderType: "dinein", tableNumber: "1", paymentMethodId: cashPmId,
      items: [{ itemId: dayItemId, variantId: dayVariantId, quantity: 1 }],
    });
    expect(sale1.status).toBe(201);

    // 3) مصروف كاشير نقدي
    const ec = await pool.query("INSERT INTO expense_categories (name) VALUES ('بند-يوم-كامل-7U-جست') RETURNING id");
    const expense = await request(app).post("/api/expenses").set(authed(dayCashierToken)).send({
      categoryId: ec.rows[0].id, amount: 30, notes: "مصروف يوم كامل 7U",
    });
    expect(expense.status).toBe(201);
    const reviewExpense = await request(app).post(`/api/expenses/${expense.body.id}/review`).set(authed(dayManagerToken)).send({ decision: "post" });
    expect(reviewExpense.status).toBe(200);

    // 4) هالك مخزون
    const waste = await request(app).post("/api/inventory/waste").set(authed(dayManagerToken)).send({
      branchId: dayBranchId, inventoryItemId: ingredientId, quantity: 2, wasteReason: "DAMAGED", reason: "تلف - اختبار 7U",
    });
    expect(waste.status).toBe(201);

    // 5) قفل الشيفت - المعاينة بقت مقصورة على مدير الفرع/المحاسب (المرحلة 8.6)
    const preview = await request(app).get(`/api/shifts/${shiftId}/preview`).set(authed(dayManagerToken));
    expect(preview.status).toBe(200);
    const expectedCash = Number(preview.body.expectedCash);
    const shiftClose = await request(app).post(`/api/shifts/${shiftId}/close`).set(authed(dayCashierToken)).send({
      actualCash: expectedCash,
    });
    expect(shiftClose.status).toBe(200);
    const closedShift = await request(app).get(`/api/shifts/${shiftId}`).set(authed(dayManagerToken));
    expect(Number(closedShift.body.cash_variance)).toBeCloseTo(0, 2);

    // 6) إقفال يوم الفرع - لازم ينجح من غير عمليات معلّقة
    const branchDayClose = await request(app).post(`/api/branch-days/${dayBranchId}/close`).set(authed(dayManagerToken)).send({});
    expect(branchDayClose.status).toBe(201);

    // 7) المطابقة النهائية: المخزون المتبقي = الافتتاحي - الاستهلاك بالبيع (لو الصنف مربوط بريسبي) - الهالك
    const stockRow = await pool.query(
      "SELECT quantity FROM branch_inventory_stock WHERE branch_id = $1 AND inventory_item_id = $2",
      [dayBranchId, ingredientId]
    );
    // الصنف ده مش مربوط بريسبي فعليًا (مفيش recipe_ingredients) فالبيع مبيستهلكش منه - بس الهالك (2) لازم يتخصم بالظبط
    expect(Number(stockRow.rows[0].quantity)).toBe(98);

    // 8) القيود المحاسبية للجلسة دي كلها متزنة (مدين = دائن)
    const unbalanced = await pool.query(`
      SELECT je.id FROM journal_entries je
      JOIN journal_entry_lines jl ON jl.journal_entry_id = je.id
      WHERE je.created_at > now() - interval '5 minutes'
      GROUP BY je.id
      HAVING ABS(COALESCE(SUM(jl.debit),0) - COALESCE(SUM(jl.credit),0)) > 0.01
    `);
    expect(unbalanced.rows).toEqual([]);
  });
});
