// المرحلة 8.7: اختبار عدائي - نتصرف كموظف غير أمين بيحاول يلاعب في النظام. أي محاولة تلاعب تنجح
// هي باج حقيقي لازم يتصلّح. الأقسام المُغطاة هنا فقط اللي مش مُغطاة أصلاً بتغطية موجودة (branch
// isolation على الشيفتات/المشتريات اتغطت بالكامل في tests/phase86-security-branch-isolation.test.js،
// وعزل السائقين اتغطى في tests/driver-delivery.test.js - مبتكررناهاش هنا). هنا بنركّز على: التلاعب في
// السعر/الضريبة/الخصم/طريقة الدفع من العميل، إعادة استخدام مفتاح idempotency غلط، تخطي حالة المطبخ،
// طلب فاضي/كمية سالبة/سعر سالب، وتعديل طلب بعد نقطة القطع.
const { app, request, pool, seedUser, login, authed } = require("./helpers");

// نفس ملاحظة tests/phase87-restaurant-day.test.js - أرقام تليفون فريدة فعليًا (آخر 8 أرقام من الطابع
// الزمني + عدّاد)، مش أول 8 أرقام (بتتصادم مع ملفات اختبار تانية بنفس البادئة في نفس نافذة الـ100 ثانية)
let phoneCounter = 0;
function uniquePhone(prefix = "09") {
  phoneCounter += 1;
  return `${prefix}${Date.now().toString().slice(-8)}${phoneCounter}`.slice(0, 11);
}

let branchA;
let cashierToken, managerToken;
let pizzaItemId, pizzaVariantId, cashPmId;

beforeAll(async () => {
  const bA = await pool.query("INSERT INTO branches (name) VALUES ('فرع-8.7-عدائي') RETURNING id");
  branchA = bA.rows[0].id;
  await seedUser({ branchId: branchA, name: "كاشير-8.7-عدائي", email: "cashier87adv@jest.test", role: "cashier" });
  await seedUser({ branchId: branchA, name: "مدير-8.7-عدائي", email: "manager87adv@jest.test", role: "branch_manager" });
  cashierToken = await login("cashier87adv@jest.test");
  managerToken = await login("manager87adv@jest.test");

  const cashPm = await pool.query("INSERT INTO payment_methods (name, kind) VALUES ('كاش-8.7-عدائي', 'cash') RETURNING id");
  cashPmId = cashPm.rows[0].id;

  const cat = await pool.query("INSERT INTO menu_categories (name) VALUES ('8.7-عدائي-قسم') RETURNING id");
  const pizza = await pool.query("INSERT INTO menu_items (category_id, name) VALUES ($1,'بيتزا-8.7-عدائي') RETURNING id", [cat.rows[0].id]);
  pizzaItemId = pizza.rows[0].id;
  const pv = await pool.query("INSERT INTO menu_item_variants (item_id, label, price) VALUES ($1,'وسط',100) RETURNING id", [pizzaItemId]);
  pizzaVariantId = pv.rows[0].id;
});

afterAll(async () => {
  await pool.end();
});

describe("عدائي: التلاعب بالسعر - العميل بيبعت unitPrice/lineTotal مزوّرة", () => {
  test("الطلب بيتسعّر من قاعدة البيانات فعليًا، مش من القيم اللي العميل بعتها", async () => {
    const res = await request(app).post("/api/orders").set(authed(cashierToken)).send({
      branchId: branchA, source: "pos", orderType: "takeaway", paymentMethodId: cashPmId,
      customerPhone: uniquePhone("030"),
      items: [{
        itemId: pizzaItemId, variantId: pizzaVariantId, quantity: 1, modifiers: [],
        unitPrice: 1, lineTotal: 1, price: 1, // محاولة تلاعب - المفروض تتجاهل تمامًا
      }],
    });
    expect(res.status).toBe(201);
    expect(Number(res.body.total)).toBeCloseTo(100, 6); // السعر الحقيقي من المنيو، مش 1 جنيه
  });
});

describe("عدائي: تخطي حد الخصم غير المعتمد بدون موافقة صحيحة", () => {
  test("خصم كبير (>10% الافتراضي) من غير discountApprovedBy - مرفوض", async () => {
    const res = await request(app).post("/api/orders").set(authed(cashierToken)).send({
      branchId: branchA, source: "pos", orderType: "takeaway", paymentMethodId: cashPmId,
      customerPhone: uniquePhone("031"),
      items: [{ itemId: pizzaItemId, variantId: pizzaVariantId, quantity: 1, modifiers: [] }],
      discount: 50,
    });
    expect(res.status).toBe(400);
  });

  test("محاولة تمرير discountApprovedBy = الكاشير نفسه (بدل مدير/أدمن حقيقي) - مرفوضة", async () => {
    const cashierRow = await pool.query("SELECT id FROM users WHERE email = 'cashier87adv@jest.test'");
    const res = await request(app).post("/api/orders").set(authed(cashierToken)).send({
      branchId: branchA, source: "pos", orderType: "takeaway", paymentMethodId: cashPmId,
      customerPhone: uniquePhone("032"),
      items: [{ itemId: pizzaItemId, variantId: pizzaVariantId, quantity: 1, modifiers: [] }],
      discount: 50, discountApprovedBy: cashierRow.rows[0].id,
    });
    expect(res.status).toBe(400);
  });

  test("موافقة مدير فرع تاني (مش فرع الطلب) - مرفوضة", async () => {
    const branchB = (await pool.query("INSERT INTO branches (name) VALUES ('فرع-8.7-عدائي-B') RETURNING id")).rows[0];
    const managerBId = await seedUser({ branchId: branchB.id, name: "مدير-فرع-تاني-8.7", email: "managerB87adv@jest.test", role: "branch_manager" });
    const res = await request(app).post("/api/orders").set(authed(cashierToken)).send({
      branchId: branchA, source: "pos", orderType: "takeaway", paymentMethodId: cashPmId,
      customerPhone: uniquePhone("033"),
      items: [{ itemId: pizzaItemId, variantId: pizzaVariantId, quantity: 1, modifiers: [] }],
      discount: 50, discountApprovedBy: managerBId,
    });
    expect(res.status).toBe(400);
  });
});

describe("عدائي: الضريبة (VAT) بتتحسب من إعدادات النظام بس - مفيش أي مسار للعميل يتحكم فيها", () => {
  test("مفيش حقل vatAmount/vatRate في جسم الطلب أصلاً - الضريبة المُسجّلة دايمًا من pos_settings.vat_rate", async () => {
    await pool.query("UPDATE pos_settings SET vat_rate = 0.14 WHERE id = 1");
    const res = await request(app).post("/api/orders").set(authed(cashierToken)).send({
      branchId: branchA, source: "pos", orderType: "takeaway", paymentMethodId: cashPmId,
      customerPhone: uniquePhone("034"),
      items: [{ itemId: pizzaItemId, variantId: pizzaVariantId, quantity: 1, modifiers: [] }],
      vatAmount: 0, vatRate: 0, // محاولة تلاعب - الحقلين دول مش متعرّفين في السيرفر أصلًا
    });
    expect(res.status).toBe(201);
    const order = await pool.query("SELECT vat_amount, total FROM orders WHERE id = $1", [res.body.orderId]);
    expect(Number(order.rows[0].vat_amount)).toBeGreaterThan(0); // الضريبة اتحسبت فعليًا رغم محاولة التصفير
    await pool.query("UPDATE pos_settings SET vat_rate = 0 WHERE id = 1");
  });
});

describe("عدائي: طريقة دفع غير موجودة/مزوّرة", () => {
  // المرحلة 8.7: باج حقيقي اتكشف هنا - paymentMethodId وهمي كان بيوصل لـINSERT ويرمي خطأ FK خام
  // (23503 - foreign key violation) كـ500 بدل رسالة عربي واضحة (400). الإصلاح في routes/orders.js:
  // تحقق صريح إن paymentMethodId موجود فعلاً في payment_methods قبل أي BEGIN/INSERT، بنفس نمط التحقق
  // من discountApprovedBy/inventoryOverrideApprovedBy الموجود أصلًا فوقه مباشرة
  test("paymentMethodId لـID مش موجود في الجدول - 400 واضح، مش 500 خام، ومفيش أي طلب اتسجل جزئيًا", async () => {
    const phone = uniquePhone("035");
    const res = await request(app).post("/api/orders").set(authed(cashierToken)).send({
      branchId: branchA, source: "pos", orderType: "takeaway", paymentMethodId: 999999999,
      customerPhone: phone,
      items: [{ itemId: pizzaItemId, variantId: pizzaVariantId, quantity: 1, modifiers: [] }],
    });
    expect(res.status).toBe(400);
    expect(res.body.error).not.toMatch(/foreign key|violates|constraint/i);
    const orphan = await pool.query("SELECT COUNT(*) FROM orders WHERE customer_phone = $1", [phone]);
    expect(Number(orphan.rows[0].count)).toBe(0);
  });

  test("نفس الباج على مسار التعديل (PUT /:id) - طلب دليفري قابل للتعديل، تغيير طريقة الدفع لـID وهمي يترفض 400", async () => {
    const area = await pool.query("INSERT INTO delivery_areas (name, fee, branch_id) VALUES ('منطقة-8.7-عدائي', 10, $1) RETURNING id", [branchA]);
    const created = await request(app).post("/api/orders").set(authed(cashierToken)).send({
      branchId: branchA, source: "pos", orderType: "delivery", paymentMethodId: cashPmId,
      customerPhone: uniquePhone("044"), customerName: "تعديل-عدائي",
      deliveryAreaId: area.rows[0].id, addressDetails: "عنوان",
      items: [{ itemId: pizzaItemId, variantId: pizzaVariantId, quantity: 1, modifiers: [] }],
    });
    const edited = await request(app).put(`/api/orders/${created.body.orderId}`).set(authed(cashierToken)).send({
      paymentMethodId: 999999999,
      items: [{ itemId: pizzaItemId, variantId: pizzaVariantId, quantity: 1, modifiers: [] }],
    });
    expect(edited.status).toBe(400);
    const order = await pool.query("SELECT payment_method_id FROM orders WHERE id = $1", [created.body.orderId]);
    expect(order.rows[0].payment_method_id).toBe(cashPmId); // فضلت زي ما كانت، مش اتغيرت لقيمة وهمية
  });
});

describe("عدائي: طلب فاضي / كمية سالبة / سعر متلاعب فيه بشكل مباشر", () => {
  test("طلب من غير أصناف خالص - مرفوض", async () => {
    const res = await request(app).post("/api/orders").set(authed(cashierToken)).send({
      branchId: branchA, source: "pos", orderType: "takeaway", paymentMethodId: cashPmId,
      customerPhone: uniquePhone("036"),
      items: [],
    });
    expect(res.status).toBe(400);
  });

  test("كمية سالبة - مرفوضة، مبتقلبش الإجمالي سالب", async () => {
    const res = await request(app).post("/api/orders").set(authed(cashierToken)).send({
      branchId: branchA, source: "pos", orderType: "takeaway", paymentMethodId: cashPmId,
      customerPhone: uniquePhone("037"),
      items: [{ itemId: pizzaItemId, variantId: pizzaVariantId, quantity: -1, modifiers: [] }],
    });
    expect(res.status).toBe(400);
  });

  test("كمية صفر - مرفوضة", async () => {
    const res = await request(app).post("/api/orders").set(authed(cashierToken)).send({
      branchId: branchA, source: "pos", orderType: "takeaway", paymentMethodId: cashPmId,
      customerPhone: uniquePhone("038"),
      items: [{ itemId: pizzaItemId, variantId: pizzaVariantId, quantity: 0, modifiers: [] }],
    });
    expect(res.status).toBe(400);
  });
});

describe("عدائي: تخطي حالة المطبخ مباشرة (NEW -> READY)", () => {
  test("تخطي ACCEPTED/PREPARING مرفوض - المطبخ لازم يمر بكل مرحلة", async () => {
    const created = await request(app).post("/api/orders").set(authed(cashierToken)).send({
      branchId: branchA, source: "pos", orderType: "takeaway", paymentMethodId: cashPmId,
      customerPhone: uniquePhone("039"),
      items: [{ itemId: pizzaItemId, variantId: pizzaVariantId, quantity: 1, modifiers: [] }],
    });
    const res = await request(app).patch(`/api/orders/${created.body.orderId}/kitchen-status`).set(authed(cashierToken)).send({ status: "READY" });
    expect(res.status).toBe(400);
    const order = await pool.query("SELECT kitchen_status FROM orders WHERE id = $1", [created.body.orderId]);
    expect(order.rows[0].kitchen_status).toBe("NEW"); // فضلت زي ما هي، مش اتقفزت
  });
});

describe("عدائي: تعديل طلب بعد نقطة القطع (completed) رغم محاولة صريحة", () => {
  test("طلب تيك أواي مكتمل بالفعل - محاولة تعديله بأي صيغة ترجع 400", async () => {
    const created = await request(app).post("/api/orders").set(authed(cashierToken)).send({
      branchId: branchA, source: "pos", orderType: "takeaway", paymentMethodId: cashPmId,
      customerPhone: uniquePhone("040"),
      items: [{ itemId: pizzaItemId, variantId: pizzaVariantId, quantity: 1, modifiers: [] }],
    });
    const attempt = await request(app).put(`/api/orders/${created.body.orderId}`).set(authed(cashierToken)).send({
      items: [{ itemId: pizzaItemId, variantId: pizzaVariantId, quantity: 100, modifiers: [] }],
      discount: 1000,
    });
    expect(attempt.status).toBe(400);
    const order = await pool.query("SELECT total FROM orders WHERE id = $1", [created.body.orderId]);
    expect(Number(order.rows[0].total)).toBeCloseTo(100, 6); // الإجمالي الأصلي فضل زي ما هو
  });
});

describe("عدائي: إعادة استخدام مفتاح idempotency بمحتوى مختلف - مفيش طلب تاني ولا خصم مخزون تاني", () => {
  test("نفس idempotencyKey باتنين محتوى مختلف - النتيجة نفس الطلب الأصلي، مفيش تكرار", async () => {
    const key = `adv-idem-${Date.now()}`;
    const first = await request(app).post("/api/orders").set(authed(cashierToken)).send({
      branchId: branchA, source: "pos", orderType: "takeaway", paymentMethodId: cashPmId,
      customerPhone: uniquePhone("041"), idempotencyKey: key,
      items: [{ itemId: pizzaItemId, variantId: pizzaVariantId, quantity: 1, modifiers: [] }],
    });
    expect(first.status).toBe(201);

    const second = await request(app).post("/api/orders").set(authed(cashierToken)).send({
      branchId: branchA, source: "pos", orderType: "takeaway", paymentMethodId: cashPmId,
      customerPhone: uniquePhone("042"), idempotencyKey: key,
      items: [{ itemId: pizzaItemId, variantId: pizzaVariantId, quantity: 5, modifiers: [] }], // محتوى مختلف تمامًا
    });
    expect(second.status).toBe(200);
    expect(second.body.duplicate).toBe(true);
    expect(second.body.orderId).toBe(first.body.orderId); // نفس الطلب الأصلي، الكمية الجديدة اتجاهلت

    const count = await pool.query("SELECT COUNT(*) FROM orders WHERE idempotency_key = $1", [key]);
    expect(Number(count.rows[0].count)).toBe(1);
  });

  test("5 نداءات متزامنة بنفس idempotencyKey - طلب واحد بس اتسجل فعليًا", async () => {
    const key = `adv-idem-concurrent-${Date.now()}`;
    const results = await Promise.all(
      Array.from({ length: 5 }, () => request(app).post("/api/orders").set(authed(cashierToken)).send({
        branchId: branchA, source: "pos", orderType: "takeaway", paymentMethodId: cashPmId,
        customerPhone: uniquePhone("043"), idempotencyKey: key,
        items: [{ itemId: pizzaItemId, variantId: pizzaVariantId, quantity: 1, modifiers: [] }],
      }))
    );
    expect(results.every((r) => [200, 201].includes(r.status))).toBe(true);
    const orderIds = new Set(results.map((r) => r.body.orderId));
    expect(orderIds.size).toBe(1);
    const count = await pool.query("SELECT COUNT(*) FROM orders WHERE idempotency_key = $1", [key]);
    expect(Number(count.rows[0].count)).toBe(1);
  });
});
