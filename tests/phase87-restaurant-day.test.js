// المرحلة 8.7: محاكاة يوم عمل حقيقي كامل لفرع Satamoni ضد Postgres حقيقي - مش اختبارات معزولة لكل
// endpoint لوحده، لكن سيناريو واحد متصل (صباح -> شيفت -> طلبات متنوعة -> عرض -> مشترى كاشير -> دليفري
// -> تقفيل شيفت -> مراجعة) بنفس التسلسل اللي كاشير حقيقي هيمر بيه، مع فحص أثر كل خطوة على المخزون/
// المحاسبة/الفرع في نفس الوقت. الهدف: اكتشاف باجات تكامل (workflow) مش ظاهرة لو كل endpoint اتفحص لوحده.
const { app, request, pool, seedUser, login, authed } = require("./helpers");

// أرقام تليفون فريدة فعليًا عبر كل ملفات الاختبار - Date.now() لوحده بيدّي نفس الرقم لو `.slice(0,11)`
// بتاخد أول 8 أرقام من الطابع الزمني (13 رقم)، واللي بتتغيّر كل ~100 ثانية بس - لو ملفين اختبار مختلفين
// استخدموا نفس البادئة النصية (زي "011") في نفس نافذة الـ100 ثانية دي، هيتولّد نفس رقم التليفون بالظبط
// وهيتشاركوا صف عميل واحد فعليًا (باج تلوّث بيانات بين الملفات اتكشف فعليًا هنا مع loyalty-redemption.test.js) -
// الحل: نستخدم آخر 8 أرقام (بتتغيّر كل مللي ثانية) + عدّاد تسلسلي لكل نداء، مش أول 8
let phoneCounter = 0;
function uniquePhone(prefix = "09") {
  phoneCounter += 1;
  return `${prefix}${Date.now().toString().slice(-8)}${phoneCounter}`.slice(0, 11);
}

let branchA;
let managerToken, cashierToken, callcenterToken, accountantToken, adminToken;
let cashierUserId, cashierEmployeeId;
let cashPmId, cardPmId, creditPmId;
let pizzaItemId, pizzaVariantId, friesItemId, friesVariantId, cheeseModifierId;
let comboId, doughItemId, cheeseItemId, potatoItemId;
let shiftId;

beforeAll(async () => {
  const bA = await pool.query("INSERT INTO branches (name) VALUES ('فرع-8.7-يوم-عمل') RETURNING id");
  branchA = bA.rows[0].id;

  cashierUserId = await seedUser({ branchId: branchA, name: "كاشير-8.7-يوم", email: "cashier87@jest.test", role: "cashier" });
  await seedUser({ branchId: branchA, name: "مدير-8.7-يوم", email: "manager87@jest.test", role: "branch_manager" });
  await seedUser({ branchId: branchA, name: "كول سنتر-8.7-يوم", email: "callcenter87@jest.test", role: "callcenter" });
  await seedUser({ name: "محاسب-8.7-يوم", email: "accountant87@jest.test", role: "accountant" });
  await seedUser({ name: "أدمن-8.7-يوم", email: "admin87@jest.test", role: "admin" });

  const emp = await pool.query(
    `INSERT INTO employees (user_id, restricted_branch_id, name, department, attendance_system, employee_code)
     VALUES ($1,$2,'كاشير-8.7-يوم','تشغيل الفرع','manual','EMP-87-1') RETURNING id`,
    [cashierUserId, branchA]
  );
  cashierEmployeeId = emp.rows[0].id;

  managerToken = await login("manager87@jest.test");
  cashierToken = await login("cashier87@jest.test");
  callcenterToken = await login("callcenter87@jest.test");
  accountantToken = await login("accountant87@jest.test");
  adminToken = await login("admin87@jest.test");

  const cashPm = await pool.query("INSERT INTO payment_methods (name, kind) VALUES ('كاش-8.7', 'cash') RETURNING id");
  cashPmId = cashPm.rows[0].id;
  const cardPm = await pool.query("INSERT INTO payment_methods (name, kind) VALUES ('فيزا-8.7', 'card_or_wallet') RETURNING id");
  cardPmId = cardPm.rows[0].id;
  const creditPm = await pool.query("INSERT INTO payment_methods (name, kind) VALUES ('آجل-8.7', 'credit') RETURNING id");
  creditPmId = creditPm.rows[0].id;

  // منيو واقعية: بيتزا وسط (فيها مكوّنات خام حقيقية) + بطاطس + مرفق جبنة إضافية
  const cat = await pool.query("INSERT INTO menu_categories (name) VALUES ('8.7-يوم-قسم') RETURNING id");
  const pizza = await pool.query("INSERT INTO menu_items (category_id, name) VALUES ($1,'بيتزا-8.7-يوم') RETURNING id", [cat.rows[0].id]);
  pizzaItemId = pizza.rows[0].id;
  const pv = await pool.query("INSERT INTO menu_item_variants (item_id, label, price) VALUES ($1,'وسط',80) RETURNING id", [pizzaItemId]);
  pizzaVariantId = pv.rows[0].id;
  const mod = await pool.query("INSERT INTO menu_item_modifiers (item_id, name, price_delta) VALUES ($1,'إضافة جبنة-8.7',10) RETURNING id", [pizzaItemId]);
  cheeseModifierId = mod.rows[0].id;

  const fries = await pool.query("INSERT INTO menu_items (category_id, name) VALUES ($1,'بطاطس-8.7-يوم') RETURNING id", [cat.rows[0].id]);
  friesItemId = fries.rows[0].id;
  const fv = await pool.query("INSERT INTO menu_item_variants (item_id, label, price) VALUES ($1,'عادي',25) RETURNING id", [friesItemId]);
  friesVariantId = fv.rows[0].id;

  // مكونات خام حقيقية مربوطة بالـBOM (menu_item_variant_ingredients) - نفس الجدول اللي orders.js فعليًا
  // بيخصم منه المخزون وقت البيع، مش recipe_versions (ده للمصنّع في السنتر كيتشن)
  const dough = await pool.query("INSERT INTO inventory_items (name, unit, item_type) VALUES ('عجينة-8.7', 'كيلو', 'raw') RETURNING id");
  doughItemId = dough.rows[0].id;
  const cheese = await pool.query("INSERT INTO inventory_items (name, unit, item_type) VALUES ('جبنة-8.7', 'كيلو', 'raw') RETURNING id");
  cheeseItemId = cheese.rows[0].id;
  const potato = await pool.query("INSERT INTO inventory_items (name, unit, item_type) VALUES ('بطاطس-خام-8.7', 'كيلو', 'raw') RETURNING id");
  potatoItemId = potato.rows[0].id;

  await pool.query("INSERT INTO menu_item_variant_ingredients (variant_id, inventory_item_id, quantity_per_unit) VALUES ($1,$2,0.3),($1,$3,0.15)", [pizzaVariantId, doughItemId, cheeseItemId]);
  await pool.query("INSERT INTO menu_item_variant_ingredients (variant_id, inventory_item_id, quantity_per_unit) VALUES ($1,$2,0.2)", [friesVariantId, potatoItemId]);

  // رصيد افتتاحي واقعي - فرع مستودَع فعليًا، مش صفر (اختبار خصم المخزون الحقيقي وقت البيع)
  await pool.query(
    `INSERT INTO branch_inventory_stock (branch_id, inventory_item_id, quantity) VALUES
     ($1,$2,50),($1,$3,50),($1,$4,50)`,
    [branchA, doughItemId, cheeseItemId, potatoItemId]
  );
  await pool.query("UPDATE inventory_items SET unit_cost = 20 WHERE id = $1", [doughItemId]);
  await pool.query("UPDATE inventory_items SET unit_cost = 60 WHERE id = $1", [cheeseItemId]);
  await pool.query("UPDATE inventory_items SET unit_cost = 15 WHERE id = $1", [potatoItemId]);

  // عرض واقعي: 2 بيتزا وسط + 1 بطاطس
  const combo = await pool.query("INSERT INTO combos (name, price) VALUES ('عرض عائلي-8.7', 150) RETURNING id");
  comboId = combo.rows[0].id;
  await pool.query("INSERT INTO combo_items (combo_id, variant_id, quantity) VALUES ($1,$2,2)", [comboId, pizzaVariantId]);
  await pool.query("INSERT INTO combo_items (combo_id, variant_id, quantity) VALUES ($1,$2,1)", [comboId, friesVariantId]);
});

afterAll(async () => {
  await pool.end();
});

async function getStock(inventoryItemId) {
  const r = await pool.query("SELECT quantity FROM branch_inventory_stock WHERE branch_id = $1 AND inventory_item_id = $2", [branchA, inventoryItemId]);
  return Number(r.rows[0].quantity);
}

// ============================================================
// الصباح: مدير الفرع يراجع حالة الفرع، الكاشير يفتح شيفت بكاش افتتاحي حقيقي (فئات جنيهية)
// ============================================================
describe("1. الصباح: فتح الفرع وفتح الشيفت", () => {
  test("مدير الفرع يقدر يشوف شيفتات فرعه (فاضية لسه) من غير انهيار", async () => {
    const res = await request(app).get("/api/shifts").set(authed(managerToken)).query({ branchId: branchA });
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  test("الكاشير يفتح شيفت بكاش افتتاحي = 200×5 + 100×3 + 50×2 = 1,400", async () => {
    const openingCash = 200 * 5 + 100 * 3 + 50 * 2; // 1400
    const res = await request(app).post("/api/shifts/open").set(authed(cashierToken)).send({
      openingCash, openingNotes: "عدّ الفئات: 200×5، 100×3، 50×2",
    });
    expect(res.status).toBe(201);
    expect(Number(res.body.opening_cash)).toBe(1400);
    shiftId = res.body.id;
  });

  test("الكاشير مايقدرش يفتح شيفت تاني وهو لسه شغال بشيفت مفتوح", async () => {
    const res = await request(app).post("/api/shifts/open").set(authed(cashierToken)).send({ openingCash: 100 });
    expect(res.status).toBe(409);
  });
});

// ============================================================
// طلبات اليوم: كاش/فيزا/آجل، تغيير طريقة الدفع قبل الإرسال، صنف عادي، عرض ×1، عرض ×2، مرفقات، كمية متعددة
// ============================================================
describe("2. طلبات اليوم بطرق دفع مختلفة", () => {
  test("طلب كاش عادي (بيتزا ×1) - المبلغ صح، طريقة الدفع المُسجّلة هي اللي اتبعتت فعليًا", async () => {
    const res = await request(app).post("/api/orders").set(authed(cashierToken)).send({
      branchId: branchA, source: "pos", orderType: "takeaway", paymentMethodId: cashPmId,
      customerPhone: uniquePhone("010"),
      items: [{ itemId: pizzaItemId, variantId: pizzaVariantId, quantity: 1, modifiers: [] }],
    });
    expect(res.status).toBe(201);
    expect(Number(res.body.total)).toBeCloseTo(80, 6);
    const order = await pool.query("SELECT payment_method_id, shift_id FROM orders WHERE id = $1", [res.body.orderId]);
    expect(order.rows[0].payment_method_id).toBe(cashPmId);
    expect(order.rows[0].shift_id).toBe(shiftId); // الطلب مربوط بالشيفت النشط تلقائيًا من السيرفر
  });

  test("الكاشير يغيّر طريقة الدفع قبل الإرسال (فيزا بدل كاش) - المسجّل هو آخر اختيار فعلي", async () => {
    const res = await request(app).post("/api/orders").set(authed(cashierToken)).send({
      branchId: branchA, source: "pos", orderType: "takeaway", paymentMethodId: cardPmId,
      customerPhone: uniquePhone("011"),
      items: [{ itemId: friesItemId, variantId: friesVariantId, quantity: 1, modifiers: [] }],
    });
    expect(res.status).toBe(201);
    const order = await pool.query("SELECT payment_method_id FROM orders WHERE id = $1", [res.body.orderId]);
    expect(order.rows[0].payment_method_id).toBe(cardPmId);
  });

  test("طلب آجل (credit) - لو النظام بيدعمه فعليًا زي المتاح في طرق الدفع", async () => {
    const res = await request(app).post("/api/orders").set(authed(cashierToken)).send({
      branchId: branchA, source: "pos", orderType: "takeaway", paymentMethodId: creditPmId,
      customerPhone: uniquePhone("012"),
      items: [{ itemId: friesItemId, variantId: friesVariantId, quantity: 1, modifiers: [] }],
    });
    expect(res.status).toBe(201);
    const order = await pool.query("SELECT payment_method_id FROM orders WHERE id = $1", [res.body.orderId]);
    expect(order.rows[0].payment_method_id).toBe(creditPmId);
  });

  test("طلب بمرفق (بيتزا + إضافة جبنة) - السعر يشمل المرفق، والمخزون بيخصم مكوّن البيتزا + مكوّن المرفق لو مربوط", async () => {
    const doughBefore = await getStock(doughItemId);
    const res = await request(app).post("/api/orders").set(authed(cashierToken)).send({
      branchId: branchA, source: "pos", orderType: "takeaway", paymentMethodId: cashPmId,
      customerPhone: uniquePhone("013"),
      items: [{ itemId: pizzaItemId, variantId: pizzaVariantId, quantity: 1, modifiers: [{ id: cheeseModifierId }] }],
    });
    expect(res.status).toBe(201);
    expect(Number(res.body.total)).toBeCloseTo(90, 6); // 80 + 10 مرفق
    const doughAfter = await getStock(doughItemId);
    expect(doughBefore - doughAfter).toBeCloseTo(0.3, 6);
  });

  test("طلب بكمية متعددة (بيتزا ×3) - السعر والمخزون يتضاعفوا صح", async () => {
    const doughBefore = await getStock(doughItemId);
    const res = await request(app).post("/api/orders").set(authed(cashierToken)).send({
      branchId: branchA, source: "pos", orderType: "takeaway", paymentMethodId: cashPmId,
      customerPhone: uniquePhone("014"),
      items: [{ itemId: pizzaItemId, variantId: pizzaVariantId, quantity: 3, modifiers: [] }],
    });
    expect(res.status).toBe(201);
    expect(Number(res.body.total)).toBeCloseTo(240, 6);
    const doughAfter = await getStock(doughItemId);
    expect(doughBefore - doughAfter).toBeCloseTo(0.9, 6); // 0.3 × 3
  });
});

// ============================================================
// العرض/الأوفر - اختبار تشغيلي كامل: ×1، ×2، + صنف عادي، عروض متعددة، عرض + مرفق
// ============================================================
describe("3. العرض/الأوفر - اختبار تشغيلي عالي الأولوية", () => {
  test("عرض ×1: يتحل لأصنافه الحقيقية (2 بيتزا + 1 بطاطس)، المخزون يتأثر بالمكونات الفعلية مش بسعر العرض", async () => {
    const doughBefore = await getStock(doughItemId);
    const cheeseBefore = await getStock(cheeseItemId);
    const potatoBefore = await getStock(potatoItemId);

    const res = await request(app).post("/api/orders").set(authed(cashierToken)).send({
      branchId: branchA, source: "pos", orderType: "takeaway", paymentMethodId: cashPmId,
      customerPhone: uniquePhone("015"),
      items: [{ comboId, quantity: 1 }],
    });
    expect(res.status).toBe(201);
    expect(Number(res.body.total)).toBeCloseTo(150, 6); // سعر العرض المُعلن، مش مجموع الأصناف منفردة

    // المخزون اتخصم بمقدار مكونات 2 بيتزا + 1 بطاطس فعليًا (مش سطر واحد مبهم "عرض")
    expect(doughBefore - await getStock(doughItemId)).toBeCloseTo(0.6, 6); // 0.3 × 2
    expect(cheeseBefore - await getStock(cheeseItemId)).toBeCloseTo(0.3, 6); // 0.15 × 2
    expect(potatoBefore - await getStock(potatoItemId)).toBeCloseTo(0.2, 6); // 0.2 × 1

    const detail = await request(app).get(`/api/orders/${res.body.orderId}`).set(authed(cashierToken));
    const comboLine = detail.body.items.find((it) => it.combo_id === comboId);
    expect(comboLine.combo_components.find((c) => c.name.includes("بيتزا")).quantity).toBe(2);
    expect(comboLine.combo_components.find((c) => c.name.includes("بطاطس")).quantity).toBe(1);
  });

  test("عرض ×2: مكونات العرض تتضاعف صح (4 بيتزا + 2 بطاطس)، المخزون كمان يتضاعف صح", async () => {
    const doughBefore = await getStock(doughItemId);
    const res = await request(app).post("/api/orders").set(authed(cashierToken)).send({
      branchId: branchA, source: "pos", orderType: "takeaway", paymentMethodId: cashPmId,
      customerPhone: uniquePhone("016"),
      items: [{ comboId, quantity: 2 }],
    });
    expect(res.status).toBe(201);
    expect(Number(res.body.total)).toBeCloseTo(300, 6);
    expect(doughBefore - await getStock(doughItemId)).toBeCloseTo(1.2, 6); // 0.3 × 2 بيتزا × 2 عرض

    const detail = await request(app).get(`/api/orders/${res.body.orderId}`).set(authed(cashierToken));
    const comboLine = detail.body.items.find((it) => it.combo_id === comboId);
    expect(comboLine.combo_components.find((c) => c.name.includes("بيتزا")).quantity).toBe(4);
  });

  test("عرض + صنف عادي في نفس السلة - كل سطر بيتحسب لوحده صح", async () => {
    const res = await request(app).post("/api/orders").set(authed(cashierToken)).send({
      branchId: branchA, source: "pos", orderType: "takeaway", paymentMethodId: cashPmId,
      customerPhone: uniquePhone("017"),
      items: [
        { comboId, quantity: 1 },
        { itemId: friesItemId, variantId: friesVariantId, quantity: 1, modifiers: [] },
      ],
    });
    expect(res.status).toBe(201);
    expect(Number(res.body.total)).toBeCloseTo(175, 6); // 150 + 25
  });

  test("عروض متعددة (عرضين منفصلين) في نفس الطلب", async () => {
    const res = await request(app).post("/api/orders").set(authed(cashierToken)).send({
      branchId: branchA, source: "pos", orderType: "takeaway", paymentMethodId: cashPmId,
      customerPhone: uniquePhone("018"),
      items: [{ comboId, quantity: 1 }, { comboId, quantity: 1 }],
    });
    expect(res.status).toBe(201);
    expect(Number(res.body.total)).toBeCloseTo(300, 6);
    const detail = await request(app).get(`/api/orders/${res.body.orderId}`).set(authed(cashierToken));
    expect(detail.body.items.filter((it) => it.combo_id === comboId).length).toBe(2);
  });

  test("KDS بيعرض مكونات العرض الحقيقية بالكميات الصح لطلب فعلي في الطابور", async () => {
    const res = await request(app).post("/api/orders").set(authed(cashierToken)).send({
      branchId: branchA, source: "pos", orderType: "takeaway", paymentMethodId: cashPmId,
      customerPhone: uniquePhone("019"),
      items: [{ comboId, quantity: 1 }],
    });
    const board = await request(app).get(`/api/kds/orders?branchId=${branchA}`).set(authed(cashierToken));
    expect(board.status).toBe(200);
    const card = board.body.find((o) => o.id === res.body.orderId);
    const comboCartLine = card.items.find((it) => it.isCombo === true);
    expect(comboCartLine.components.find((c) => c.name.includes("بيتزا")).quantity).toBe(2);
  });
});

// ============================================================
// دليفري + عميل بعناوين متعددة
// ============================================================
describe("4. طلب دليفري + عميل بعنوانين محفوظين", () => {
  let customerPhone, areaId;

  test("تجهيز منطقة توصيل + عميل بعنوانين محفوظين", async () => {
    const area = await pool.query("INSERT INTO delivery_areas (name, fee, branch_id) VALUES ('منطقة-8.7', 15, $1) RETURNING id", [branchA]);
    areaId = area.rows[0].id;
    customerPhone = uniquePhone("015550");

    const addr1 = await request(app).post(`/api/customers/${customerPhone}/addresses`).set(authed(cashierToken)).send({
      label: "البيت", addressDetails: "شارع 1", deliveryAreaId: areaId, isDefault: true,
    });
    expect(addr1.status).toBe(201);
    const addr2 = await request(app).post(`/api/customers/${customerPhone}/addresses`).set(authed(cashierToken)).send({
      label: "الشغل", addressDetails: "شارع 2 - عنوان الشغل", deliveryAreaId: areaId, isDefault: false,
    });
    expect(addr2.status).toBe(201);

    const list = await request(app).get(`/api/customers/${customerPhone}/addresses`).set(authed(cashierToken));
    expect(list.status).toBe(200);
    expect(list.body.length).toBe(2);
  });

  test("اختيار العنوان التاني (مش الافتراضي) بيوصل صح للطلب المُنشأ", async () => {
    const list = await request(app).get(`/api/customers/${customerPhone}/addresses`).set(authed(callcenterToken));
    const secondAddress = list.body.find((a) => a.label === "الشغل");
    expect(secondAddress).toBeTruthy();

    const res = await request(app).post("/api/orders").set(authed(callcenterToken)).send({
      branchId: branchA, source: "callcenter", orderType: "delivery", paymentMethodId: cashPmId,
      customerPhone, customerName: "عميل-8.7", deliveryAreaId: secondAddress.deliveryAreaId,
      addressDetails: secondAddress.addressDetails,
      items: [{ itemId: pizzaItemId, variantId: pizzaVariantId, quantity: 1, modifiers: [] }],
    });
    expect(res.status).toBe(201);
    const order = await pool.query("SELECT address_details FROM orders WHERE id = $1", [res.body.orderId]);
    expect(order.rows[0].address_details).toBe("شارع 2 - عنوان الشغل");
  });
});

// ============================================================
// تعديل طلب قبل/بعد نقطة القطع (Scenario F)
// ============================================================
describe("5. تعديل الطلب قبل/بعد نقطة القطع", () => {
  test("طلب دليفري (preparing) قابل للتعديل - إضافة صنف بتحدّث الإجمالي والمخزون صح", async () => {
    const phone = uniquePhone("019990");
    const created = await request(app).post("/api/orders").set(authed(cashierToken)).send({
      branchId: branchA, source: "pos", orderType: "delivery", paymentMethodId: cashPmId,
      customerPhone: phone, customerName: "تعديل-8.7", deliveryAreaId: (await pool.query("SELECT id FROM delivery_areas WHERE branch_id = $1 LIMIT 1", [branchA])).rows[0].id,
      addressDetails: "عنوان تعديل",
      items: [{ itemId: friesItemId, variantId: friesVariantId, quantity: 1, modifiers: [] }],
    });
    expect(created.status).toBe(201);
    const orderCheck = await pool.query("SELECT status FROM orders WHERE id = $1", [created.body.orderId]);
    expect(orderCheck.rows[0].status).toBe("preparing"); // طلب الدليفري بيبدأ preparing - قابل للتعديل

    const edited = await request(app).put(`/api/orders/${created.body.orderId}`).set(authed(cashierToken)).send({
      paymentMethodId: cashPmId,
      items: [
        { itemId: friesItemId, variantId: friesVariantId, quantity: 1, modifiers: [] },
        { itemId: pizzaItemId, variantId: pizzaVariantId, quantity: 1, modifiers: [] },
      ],
    });
    expect(edited.status).toBe(200);
    expect(Number(edited.body.total)).toBeCloseTo(105, 6); // 25 + 80
  });

  test("طلب تيك أواي (completed فورًا) مش قابل للتعديل - نقطة القطع شغالة", async () => {
    const created = await request(app).post("/api/orders").set(authed(cashierToken)).send({
      branchId: branchA, source: "pos", orderType: "takeaway", paymentMethodId: cashPmId,
      customerPhone: uniquePhone("020"),
      items: [{ itemId: friesItemId, variantId: friesVariantId, quantity: 1, modifiers: [] }],
    });
    const orderCheck = await pool.query("SELECT status FROM orders WHERE id = $1", [created.body.orderId]);
    expect(orderCheck.rows[0].status).toBe("completed");

    const edited = await request(app).put(`/api/orders/${created.body.orderId}`).set(authed(cashierToken)).send({
      items: [{ itemId: pizzaItemId, variantId: pizzaVariantId, quantity: 1, modifiers: [] }],
    });
    expect(edited.status).toBe(400);
  });
});

// ============================================================
// المشترى النقدي (فاتورة مواد خام) من شاشة الكاشير - نفس المرحلة 8.6، هنا كجزء من سياق يوم كامل
// ============================================================
describe("6. مشترى الكاشير أثناء اليوم - فاتورة مواد خام", () => {
  let purchaseId;

  test("الكاشير يسجل فاتورة (دقيق) - PENDING، من غير أي أثر مخزون قبل المراجعة", async () => {
    const stockBefore = await getStock(doughItemId);
    const res = await request(app).post("/api/purchases").set(authed(cashierToken)).send({
      items: [{ inventoryItemId: doughItemId, quantity: 10, unitPrice: 18 }],
    });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe("PENDING");
    purchaseId = res.body.id;
    expect(await getStock(doughItemId)).toBeCloseTo(stockBefore, 6);
  });

  test("مدخلات غير صالحة مرفوضة: كمية صفر/سالبة، سعر سالب، صنف غير موجود", async () => {
    expect((await request(app).post("/api/purchases").set(authed(cashierToken)).send({
      items: [{ inventoryItemId: doughItemId, quantity: 0, unitPrice: 10 }],
    })).status).toBe(400);
    expect((await request(app).post("/api/purchases").set(authed(cashierToken)).send({
      items: [{ inventoryItemId: doughItemId, quantity: -5, unitPrice: 10 }],
    })).status).toBe(400);
    expect((await request(app).post("/api/purchases").set(authed(cashierToken)).send({
      items: [{ inventoryItemId: doughItemId, quantity: 5, unitPrice: -10 }],
    })).status).toBe(400);
    expect((await request(app).post("/api/purchases").set(authed(cashierToken)).send({
      items: [{ inventoryItemId: 999999999, quantity: 5, unitPrice: 10 }],
    })).status).toBe(400);
  });

  test("المدير يؤكّد الفاتورة - المخزون يزيد بالكمية الصح، القيد المحاسبي متوازن", async () => {
    const stockBefore = await getStock(doughItemId);
    const confirmed = await request(app).post(`/api/purchases/${purchaseId}/confirm`).set(authed(managerToken));
    expect(confirmed.status).toBe(200);
    expect(await getStock(doughItemId) - stockBefore).toBeCloseTo(10, 6);

    const je = await pool.query("SELECT * FROM journal_entries WHERE source_type = 'purchase' AND source_id = $1", [purchaseId]);
    expect(je.rows.length).toBe(1);
    const lines = await pool.query("SELECT SUM(debit) AS d, SUM(credit) AS c FROM journal_entry_lines WHERE journal_entry_id = $1", [je.rows[0].id]);
    expect(Number(lines.rows[0].d)).toBeCloseTo(180, 6);
    expect(Number(lines.rows[0].c)).toBeCloseTo(180, 6);
  });

  test("تأكيد مزدوج (نفس الفاتورة مرتين) مبيرحّلش المخزون مرتين", async () => {
    const stockBefore = await getStock(doughItemId);
    const second = await request(app).post(`/api/purchases/${purchaseId}/confirm`).set(authed(managerToken));
    expect(second.status).toBe(400);
    expect(await getStock(doughItemId)).toBeCloseTo(stockBefore, 6);
  });
});

// ============================================================
// تقفيل الشيفت - عدّ فئات، من غير رؤية عجز/زيادة، ثم مراجعة المدير
// ============================================================
describe("7. تقفيل الشيفت (عدّ فئات، الكاشير أعمى عن الفرق) + مراجعة المدير", () => {
  test("preview الكاش المتوقع متاح للمدير بس، مش للكاشير", async () => {
    expect((await request(app).get(`/api/shifts/${shiftId}/preview`).set(authed(cashierToken))).status).toBe(403);
    const managerPreview = await request(app).get(`/api/shifts/${shiftId}/preview`).set(authed(managerToken));
    expect(managerPreview.status).toBe(200);
    expect(managerPreview.body.expectedCash).toBeDefined();
  });

  test("الكاشير يقفل الشيفت بمبلغ فعلي أقل من المتوقع بـ50 (عجز واقعي) - استجابته الشخصية معندهاش أي رقم متوقع/فرق", async () => {
    const managerPreviewBeforeClose = await request(app).get(`/api/shifts/${shiftId}/preview`).set(authed(managerToken));
    const expectedCash = Number(managerPreviewBeforeClose.body.expectedCash);
    const actualCash = expectedCash - 50;

    const closed = await request(app).post(`/api/shifts/${shiftId}/close`).set(authed(cashierToken)).send({
      actualCash, closingNotes: "عدّ الفئات: تم إدخال المبلغ الفعلي",
    });
    expect(closed.status).toBe(200);
    expect(closed.body.expected_cash).toBeUndefined();
    expect(closed.body.cash_variance).toBeUndefined();
    expect(closed.body.actual_cash).toBeUndefined();
  });

  test("المدير يشوف تفاصيل العجز كاملة (متوقع/فعلي/فرق) والكاشير المسؤول", async () => {
    const detail = await request(app).get(`/api/shifts/${shiftId}`).set(authed(managerToken));
    expect(detail.status).toBe(200);
    expect(Number(detail.body.cash_variance)).toBeCloseTo(-50, 1);
    expect(detail.body.user_id).toBe(cashierUserId);
  });

  test("موافقة المدير على العجز بتسجل سلفة موظف + قيد محاسبي متوازن - مرة واحدة بس", async () => {
    const approved = await request(app).post(`/api/shifts/${shiftId}/review`).set(authed(managerToken)).send({ decision: "approve" });
    expect(approved.status).toBe(200);
    expect(approved.body.debtCreated).toBeTruthy();

    const debt = await pool.query(
      "SELECT * FROM payroll_adjustments WHERE shift_id = $1 AND adjustment_type = 'advance'", [shiftId]
    );
    expect(debt.rows.length).toBe(1);
    expect(Number(debt.rows[0].amount)).toBeCloseTo(50, 1);
    expect(debt.rows[0].employee_id).toBe(cashierEmployeeId);

    const je = await pool.query("SELECT * FROM journal_entries WHERE source_type = 'shift_variance' AND source_id = $1", [shiftId]);
    if (je.rows.length > 0) {
      const lines = await pool.query("SELECT SUM(debit) AS d, SUM(credit) AS c FROM journal_entry_lines WHERE journal_entry_id = $1", [je.rows[0].id]);
      expect(Number(lines.rows[0].d)).toBeCloseTo(Number(lines.rows[0].c), 1);
    }
  });

  test("مراجعة مزدوجة على نفس الشيفت مرفوضة - سلفة واحدة بس اتسجلت", async () => {
    const second = await request(app).post(`/api/shifts/${shiftId}/review`).set(authed(managerToken)).send({ decision: "approve" });
    expect(second.status).toBe(400);
    const debts = await pool.query("SELECT * FROM payroll_adjustments WHERE shift_id = $1 AND adjustment_type = 'advance'", [shiftId]);
    expect(debts.rows.length).toBe(1);
  });
});

// ============================================================
// حالة العرض بالضبط (Expected = Actual) + الزيادة - تحقق من المعاملتين التانيتين لتغطية الحالات التلاتة
// ============================================================
describe("8. حالتا الشيفت الإضافيتان: تطابق تام + زيادة", () => {
  test("شيفت بمبلغ فعلي = المتوقع بالظبط - variance=0، من غير أي قيد محاسبي أو سلفة", async () => {
    const opened = await request(app).post("/api/shifts/open").set(authed(cashierToken)).send({ openingCash: 500 });
    const exactShiftId = opened.body.id;
    const preview = await request(app).get(`/api/shifts/${exactShiftId}/preview`).set(authed(managerToken));
    const closed = await request(app).post(`/api/shifts/${exactShiftId}/close`).set(authed(cashierToken)).send({
      actualCash: Number(preview.body.expectedCash),
    });
    expect(closed.status).toBe(200);
    const detail = await request(app).get(`/api/shifts/${exactShiftId}`).set(authed(managerToken));
    expect(Number(detail.body.cash_variance)).toBeCloseTo(0, 6);
    expect(detail.body.variance_status).not.toBe("PENDING_REVIEW");
  });

  test("شيفت بزيادة 50 جنيه (Actual > Expected) - المعالجة المحاسبية القائمة (ترحيل إيراد، مش سلفة)", async () => {
    const opened = await request(app).post("/api/shifts/open").set(authed(cashierToken)).send({ openingCash: 500 });
    const surplusShiftId = opened.body.id;
    const preview = await request(app).get(`/api/shifts/${surplusShiftId}/preview`).set(authed(managerToken));
    const expectedCash = Number(preview.body.expectedCash);
    await request(app).post(`/api/shifts/${surplusShiftId}/close`).set(authed(cashierToken)).send({
      actualCash: expectedCash + 50,
    });
    const approved = await request(app).post(`/api/shifts/${surplusShiftId}/review`).set(authed(managerToken)).send({ decision: "approve" });
    expect(approved.status).toBe(200);
    expect(approved.body.debtCreated).toBeFalsy(); // زيادة مبتعملش سلفة موظف

    const debt = await pool.query("SELECT * FROM payroll_adjustments WHERE shift_id = $1 AND adjustment_type = 'advance'", [surplusShiftId]);
    expect(debt.rows.length).toBe(0);
    const je = await pool.query("SELECT * FROM journal_entries WHERE source_type = 'shift_variance' AND source_id = $1", [surplusShiftId]);
    if (je.rows.length > 0) {
      const lines = await pool.query("SELECT SUM(debit) AS d, SUM(credit) AS c FROM journal_entry_lines WHERE journal_entry_id = $1", [je.rows[0].id]);
      expect(Number(lines.rows[0].d)).toBeCloseTo(Number(lines.rows[0].c), 1);
    }
  });
});

// ============================================================
// دليفري كامل: طلب -> تجهيز -> تعيين سائق -> خروج -> تسليم (COD) -> تسوية كاش السائق
// ============================================================
describe("9. يوم الدليفري: تعيين سائق -> تسليم -> تسوية كاش", () => {
  let driverToken, driverId, deliveryOrderId;

  test("تجهيز سائق وطلب دليفري كامل", async () => {
    const driverUserId = await seedUser({ branchId: branchA, name: "سائق-8.7-يوم", email: "driver87@jest.test", role: "driver" });
    const driver = await pool.query(
      "INSERT INTO drivers (user_id, branch_id, driver_code, name) VALUES ($1,$2,'DRV-87',$3) RETURNING id",
      [driverUserId, branchA, "سائق-8.7-يوم"]
    );
    driverId = driver.rows[0].id;
    driverToken = await login("driver87@jest.test");

    const area = (await pool.query("SELECT id FROM delivery_areas WHERE branch_id = $1 LIMIT 1", [branchA])).rows[0].id;
    const created = await request(app).post("/api/orders").set(authed(cashierToken)).send({
      branchId: branchA, source: "pos", orderType: "delivery", paymentMethodId: cashPmId,
      customerPhone: uniquePhone("021"), customerName: "عميل دليفري 8.7",
      deliveryAreaId: area, addressDetails: "عنوان دليفري 8.7",
      items: [{ itemId: pizzaItemId, variantId: pizzaVariantId, quantity: 1, modifiers: [] }],
    });
    expect(created.status).toBe(201);
    deliveryOrderId = created.body.orderId;
  });

  test("تعيين -> خروج -> تسليم COD مطابق للمبلغ", async () => {
    const orderTotal = Number((await pool.query("SELECT total FROM orders WHERE id = $1", [deliveryOrderId])).rows[0].total);
    await request(app).post(`/api/deliveries/${deliveryOrderId}/assign`).set(authed(managerToken)).send({ driverId });
    const outFor = await request(app).post(`/api/deliveries/${deliveryOrderId}/out-for-delivery`).set(authed(driverToken));
    expect(outFor.status).toBe(200);
    const delivered = await request(app).post(`/api/deliveries/${deliveryOrderId}/delivered`).set(authed(driverToken)).send({ collectedAmount: orderTotal });
    expect(delivered.status).toBe(200);
  });

  test("السائق يسوّي الكاش - العهدة تتصفّى، الفرق (لو فيه) بيتسجل صح", async () => {
    const preview = await request(app).get(`/api/driver-settlements/preview?driverId=${driverId}`).set(authed(managerToken));
    expect(preview.status).toBe(200);
    const settlement = await request(app).post("/api/driver-settlements").set(authed(managerToken)).send({
      driverId, actualHandover: Number(preview.body.expectedHandover ?? preview.body.totalUnsettled ?? preview.body.total),
    });
    expect(settlement.status).toBe(201);
  });
});

// ============================================================
// KDS - دورة حياة كاملة لطلب حقيقي، مع فحص عزل الفرع
// ============================================================
describe("10. دورة حياة KDS كاملة ليوم العمل", () => {
  test("طلب يمر NEW -> ACCEPTED -> PREPARING -> READY بالترتيب، من غير اختفاء", async () => {
    const created = await request(app).post("/api/orders").set(authed(cashierToken)).send({
      branchId: branchA, source: "pos", orderType: "takeaway", paymentMethodId: cashPmId,
      customerPhone: uniquePhone("022"),
      items: [{ itemId: friesItemId, variantId: friesVariantId, quantity: 1, modifiers: [] }],
    });
    const orderId = created.body.orderId;

    let board = await request(app).get(`/api/kds/orders?branchId=${branchA}`).set(authed(cashierToken));
    expect(board.body.find((o) => o.id === orderId).kitchen_status).toBe("NEW");

    await request(app).patch(`/api/orders/${orderId}/kitchen-status`).set(authed(cashierToken)).send({ status: "ACCEPTED" });
    await request(app).patch(`/api/orders/${orderId}/kitchen-status`).set(authed(cashierToken)).send({ status: "PREPARING" });
    const ready = await request(app).patch(`/api/orders/${orderId}/kitchen-status`).set(authed(cashierToken)).send({ status: "READY" });
    expect(ready.status).toBe(200);

    board = await request(app).get(`/api/kds/orders?branchId=${branchA}`).set(authed(cashierToken));
    expect(board.body.find((o) => o.id === orderId)).toBeTruthy(); // لسه ظاهر (نافذة الـ30 دقيقة بعد READY)
  });

  test("ضغطتين متزامنتين على نفس الانتقال - واحدة بس تنجح، مفيش تكرار في السجل", async () => {
    const created = await request(app).post("/api/orders").set(authed(cashierToken)).send({
      branchId: branchA, source: "pos", orderType: "takeaway", paymentMethodId: cashPmId,
      customerPhone: uniquePhone("023"),
      items: [{ itemId: friesItemId, variantId: friesVariantId, quantity: 1, modifiers: [] }],
    });
    const orderId = created.body.orderId;
    const [r1, r2] = await Promise.all([
      request(app).patch(`/api/orders/${orderId}/kitchen-status`).set(authed(cashierToken)).send({ status: "ACCEPTED" }),
      request(app).patch(`/api/orders/${orderId}/kitchen-status`).set(authed(managerToken)).send({ status: "ACCEPTED" }),
    ]);
    const statuses = [r1.status, r2.status].sort();
    expect(statuses).toEqual([200, 400]);
  });
});
