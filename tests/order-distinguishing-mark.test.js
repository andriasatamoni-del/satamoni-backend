// المرحلة 8.55: علامة مميزة الطلب (بجوار كذا، لون العمارة...) كانت بتتسجل في ملف العميل (customers)
// بس - مش على الطلب نفسه، فإيصال الكاشير/تذكرة المطبخ مقدروش يعرضوها لأي طلب أبدًا (اتكشفت من طلب
// حقيقي من الموقع مبانش ظاهر فيه العنوان ولا العلامة المميزة في الإيصال). دلوقتي بتتجمّد على الطلب
// نفسه وقت الإنشاء/التعديل زي address_details بالظبط. بيغطي: التسجيل من الموقع (من غير تسجيل دخول -
// نفس استخدام order.html الفعلي)، التعديل، واستبعادها لطلبات غير الدليفري (مفهوم "بدون" مبيتطبقش عليهم)
const { app, request, pool, seedUser, login, authed } = require("./helpers");

let branchId;
let managerToken;
let menuItemId, variantId, areaId, paymentMethodId;

beforeAll(async () => {
  const b = await pool.query("INSERT INTO branches (name) VALUES ('فرع علامة-مميزة-جست') RETURNING id");
  branchId = b.rows[0].id;
  await seedUser({ branchId, name: "مدير-علامة-مميزة", email: "manager-mark@jest.test", role: "branch_manager" });
  managerToken = await login("manager-mark@jest.test");

  const cat = await pool.query("INSERT INTO menu_categories (name) VALUES ('علامة-مميزة-جست-قسم') RETURNING id");
  const mi = await pool.query("INSERT INTO menu_items (category_id, name) VALUES ($1,'صنف-علامة-مميزة-جست') RETURNING id", [cat.rows[0].id]);
  menuItemId = mi.rows[0].id;
  const v = await pool.query("INSERT INTO menu_item_variants (item_id, label, price) VALUES ($1,'عادي',80) RETURNING id", [mi.rows[0].id]);
  variantId = v.rows[0].id;

  const area = await pool.query("INSERT INTO delivery_areas (name, fee, branch_id) VALUES ('منطقة-علامة-مميزة-جست', 15, $1) RETURNING id", [branchId]);
  areaId = area.rows[0].id;
  const pm = await pool.query("INSERT INTO payment_methods (name, kind) VALUES ('كاش-علامة-مميزة-جست', 'cash') RETURNING id");
  paymentMethodId = pm.rows[0].id;
});

afterAll(async () => {
  await pool.end();
});

describe("العلامة المميزة بتتجمّد على الطلب نفسه (8.55)", () => {
  test("طلب دليفري من الموقع (من غير تسجيل دخول) بعلامة مميزة - بترجع في GET /:id", async () => {
    const res = await request(app).post("/api/orders").send({
      source: "website", branchId, orderType: "delivery", deliveryAreaId: areaId,
      addressDetails: "شارع الاختبار", distinguishingMark: "بجوار الصيدلية، عمارة زرقاء",
      customerName: "عميل جست", customerPhone: `015${Date.now()}`.slice(0, 11),
      paymentMethodId, deliveryFee: 15,
      items: [{ itemId: menuItemId, variantId, quantity: 1 }],
    });
    expect(res.status).toBe(201);

    const full = await request(app).get(`/api/orders/${res.body.orderId}`).set(authed(managerToken));
    expect(full.status).toBe(200);
    expect(full.body.address_details).toBe("شارع الاختبار");
    expect(full.body.distinguishing_mark).toBe("بجوار الصيدلية، عمارة زرقاء");
  });

  test("طلب تيك أواي (مش دليفري) - العلامة المميزة المبعوتة بتتجاهل (مفهوم بدون مكان لطلب مش دليفري)", async () => {
    const res = await request(app).post("/api/orders").set(authed(managerToken)).send({
      branchId, source: "pos", orderType: "takeaway", paymentMethodId,
      distinguishingMark: "ملهاش معنى هنا",
      items: [{ itemId: menuItemId, variantId, quantity: 1 }],
    });
    expect(res.status).toBe(201);
    const full = await request(app).get(`/api/orders/${res.body.orderId}`).set(authed(managerToken));
    expect(full.body.distinguishing_mark).toBeNull();
  });

  test("تعديل الطلب (PUT /:id) بيحدّث العلامة المميزة زي العنوان بالظبط", async () => {
    const phone = `014${Date.now()}`.slice(0, 11);
    const created = await request(app).post("/api/orders").set(authed(managerToken)).send({
      branchId, source: "pos", orderType: "delivery", deliveryAreaId: areaId,
      addressDetails: "عنوان أول", distinguishingMark: "علامة أولى",
      customerName: "عميل تعديل", customerPhone: phone, paymentMethodId, deliveryFee: 15,
      items: [{ itemId: menuItemId, variantId, quantity: 1 }],
    });
    expect(created.status).toBe(201);

    const edited = await request(app).put(`/api/orders/${created.body.orderId}`).set(authed(managerToken)).send({
      deliveryAreaId: areaId, addressDetails: "عنوان معدّل", distinguishingMark: "علامة معدّلة",
      customerName: "عميل تعديل", customerPhone: phone, paymentMethodId, deliveryFee: 15,
      items: [{ itemId: menuItemId, variantId, quantity: 1 }],
    });
    expect(edited.status).toBe(200);

    const full = await request(app).get(`/api/orders/${created.body.orderId}`).set(authed(managerToken));
    expect(full.body.address_details).toBe("عنوان معدّل");
    expect(full.body.distinguishing_mark).toBe("علامة معدّلة");
  });

  test("التعديل من غير ما تبعت distinguishingMark بيسيبها زي ما هي (مش بتتصفّر بهدوء)", async () => {
    const phone = `013${Date.now()}`.slice(0, 11);
    const created = await request(app).post("/api/orders").set(authed(managerToken)).send({
      branchId, source: "pos", orderType: "delivery", deliveryAreaId: areaId,
      addressDetails: "عنوان", distinguishingMark: "علامة تفضل موجودة",
      customerName: "عميل تعديل 2", customerPhone: phone, paymentMethodId, deliveryFee: 15,
      items: [{ itemId: menuItemId, variantId, quantity: 1 }],
    });
    const edited = await request(app).put(`/api/orders/${created.body.orderId}`).set(authed(managerToken)).send({
      deliveryAreaId: areaId, addressDetails: "عنوان", // من غير distinguishingMark خالص
      customerName: "عميل تعديل 2", customerPhone: phone, paymentMethodId, deliveryFee: 15,
      items: [{ itemId: menuItemId, variantId, quantity: 2 }],
    });
    expect(edited.status).toBe(200);

    const full = await request(app).get(`/api/orders/${created.body.orderId}`).set(authed(managerToken));
    expect(full.body.distinguishing_mark).toBe("علامة تفضل موجودة");
  });
});
