// المرحلة 8.56: طلبات دليفري لمنطقة توصيل مش مربوطة بفرع (branch_id فاضي في delivery_areas - زي مناطق
// قديمة اتستوردت من غير فرع محدد، أو منطقة جديدة اتعملت من الأدمن من غير اختيار فرع) كانت بتتسجل
// بـorders.branch_id فاضي - الطلب "ينجح" ظاهريًا (العميل بياخد تأكيد ورقم أوردر) لكن بيفضل صف مخفي
// تمامًا: مبيتطبعش، مبيظهرش في أي شاشة فرع، ومبيوصلش لشاشة المطبخ خالص (ده أصل شكوى عميل حقيقي: "طلبت
// اوردرات من الويب سايت مسمعتش اصلا علي السيستم"). التغطية هنا: (أ) POST بيرفض بوضوح بدل ما "ينجح"
// ويضيع، (ب) الفرع بيتستخرج من منطقة التوصيل نفسها (مصدر الحقيقة) مش من أي branchId اتبعت في الـbody
// (حماية من تلاعب/عدم تطابق)، (ج) أدوات الأدمن لاسترجاع طلبات قديمة اتسجلت بالفعل بـbranch_id فاضي
const { app, request, pool, seedUser, login, authed } = require("./helpers");

let branchId, otherBranchId;
let adminToken, cashierToken;
let menuItemId, variantId, paymentMethodId;
let areaWithBranchId, areaWithoutBranchId;

beforeAll(async () => {
  const b = await pool.query("INSERT INTO branches (name) VALUES ('فرع 8.56-جست') RETURNING id");
  branchId = b.rows[0].id;
  const b2 = await pool.query("INSERT INTO branches (name) VALUES ('فرع 8.56-تاني-جست') RETURNING id");
  otherBranchId = b2.rows[0].id;

  await seedUser({ branchId, name: "أدمن-8.56", email: "admin-856@jest.test", role: "admin" });
  adminToken = await login("admin-856@jest.test");
  await seedUser({ branchId, name: "كاشير-8.56", email: "cashier-856@jest.test", role: "cashier" });
  cashierToken = await login("cashier-856@jest.test");

  const cat = await pool.query("INSERT INTO menu_categories (name) VALUES ('8.56-جست-قسم') RETURNING id");
  const mi = await pool.query("INSERT INTO menu_items (category_id, name) VALUES ($1,'8.56-جست-صنف') RETURNING id", [cat.rows[0].id]);
  menuItemId = mi.rows[0].id;
  const v = await pool.query("INSERT INTO menu_item_variants (item_id, label, price) VALUES ($1,'عادي',80) RETURNING id", [mi.rows[0].id]);
  variantId = v.rows[0].id;
  const pm = await pool.query("INSERT INTO payment_methods (name, kind) VALUES ('كاش-8.56-جست', 'cash') RETURNING id");
  paymentMethodId = pm.rows[0].id;

  const areaOk = await pool.query(
    "INSERT INTO delivery_areas (name, fee, branch_id) VALUES ('منطقة-8.56-مربوطة', 15, $1) RETURNING id", [branchId]
  );
  areaWithBranchId = areaOk.rows[0].id;
  const areaBad = await pool.query(
    "INSERT INTO delivery_areas (name, fee, branch_id) VALUES ('منطقة-8.56-يتيمة', 15, NULL) RETURNING id"
  );
  areaWithoutBranchId = areaBad.rows[0].id;
});

afterAll(async () => {
  await pool.end();
});

describe("طلب دليفري لمنطقة من غير فرع بيترفض بدل ما يضيع بهدوء (8.56)", () => {
  test("طلب من الموقع لمنطقة يتيمة - 400 واضح، والطلب مبيتسجلش خالص", async () => {
    const before = await pool.query("SELECT COUNT(*)::int AS c FROM orders");
    const res = await request(app).post("/api/orders").send({
      source: "website", orderType: "delivery", deliveryAreaId: areaWithoutBranchId,
      customerName: "عميل يتيم", customerPhone: `016${Date.now()}`.slice(0, 11),
      paymentMethodId, deliveryFee: 15,
      items: [{ itemId: menuItemId, variantId, quantity: 1 }],
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/التوصيل غير متاح/);
    const after = await pool.query("SELECT COUNT(*)::int AS c FROM orders");
    expect(after.rows[0].c).toBe(before.rows[0].c);
  });

  test("منطقة توصيل غير موجودة أصلًا - 400 واضح", async () => {
    const res = await request(app).post("/api/orders").send({
      source: "website", orderType: "delivery", deliveryAreaId: 999999999,
      customerName: "عميل", customerPhone: `017${Date.now()}`.slice(0, 11),
      paymentMethodId, deliveryFee: 15,
      items: [{ itemId: menuItemId, variantId, quantity: 1 }],
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/منطقة التوصيل غير موجودة/);
  });

  test("الفرع بيتستخرج من منطقة التوصيل نفسها، مش من branchId المبعوت (حماية من عدم تطابق/تلاعب)", async () => {
    const res = await request(app).post("/api/orders").send({
      source: "website", orderType: "delivery", deliveryAreaId: areaWithBranchId,
      branchId: otherBranchId, // فرع مختلف عمدًا - المفروض يتجاهله ويستخدم فرع المنطقة الحقيقي
      customerName: "عميل مطابق", customerPhone: `018${Date.now()}`.slice(0, 11),
      paymentMethodId, deliveryFee: 15,
      items: [{ itemId: menuItemId, variantId, quantity: 1 }],
    });
    expect(res.status).toBe(201);

    const full = await request(app).get(`/api/orders/${res.body.orderId}`).set(authed(adminToken));
    expect(full.body.branch_id).toBe(branchId);
  });
});

describe("أدوات الأدمن لاسترجاع طلبات قديمة اتسجلت بـbranch_id فاضي (8.56)", () => {
  let orphanOrderId;

  beforeAll(async () => {
    // بيحاكي طلب قديم اتسجل قبل الإصلاح ده (branch_id فاضي فعليًا في القاعدة) - ما ينفعش نعمله دلوقتي
    // عن طريق POST (بقى مرفوض عن حق)، فبنحاكيه بـINSERT مباشر زي أي بيانات موروثة حقيقية
    const o = await pool.query(
      `INSERT INTO orders (branch_id, source, order_type, delivery_area_id, address_details, customer_name,
                            customer_phone, payment_method_id, subtotal, delivery_fee, total, status, payment_status)
       VALUES (NULL, 'website', 'delivery', $1, 'عنوان يتيم', 'عميل يتيم قديم', '01000000000', $2, 80, 15, 95, 'preparing', 'pending_collection')
       RETURNING id`,
      [areaWithoutBranchId, paymentMethodId]
    );
    orphanOrderId = o.rows[0].id;
  });

  test("GET /api/orders/unassigned - أدمن بس", async () => {
    const denied = await request(app).get("/api/orders/unassigned").set(authed(cashierToken));
    expect(denied.status).toBe(403);

    const res = await request(app).get("/api/orders/unassigned").set(authed(adminToken));
    expect(res.status).toBe(200);
    expect(res.body.some((o) => o.id === orphanOrderId)).toBe(true);
  });

  test("PATCH /:id/assign-branch - بيربط الطلب بفرع، بيطبع، وبيبقى ظاهر في GET العادي بعد كده", async () => {
    const denied = await request(app)
      .patch(`/api/orders/${orphanOrderId}/assign-branch`)
      .set(authed(cashierToken))
      .send({ branchId });
    expect(denied.status).toBe(403);

    const res = await request(app)
      .patch(`/api/orders/${orphanOrderId}/assign-branch`)
      .set(authed(adminToken))
      .send({ branchId });
    expect(res.status).toBe(200);

    const full = await request(app).get(`/api/orders/${orphanOrderId}`).set(authed(adminToken));
    expect(full.body.branch_id).toBe(branchId);

    const listed = await request(app).get(`/api/orders?branchId=${branchId}&orderId=${orphanOrderId}`).set(authed(adminToken));
    expect(listed.body.some((o) => o.id === orphanOrderId)).toBe(true);

    const jobs = await pool.query("SELECT * FROM print_jobs WHERE order_id = $1", [orphanOrderId]);
    expect(jobs.rows.length).toBeGreaterThan(0);
  });

  test("طلب اتربط بفرع بالفعل - إعادة تعيين ترفض بـ400", async () => {
    const res = await request(app)
      .patch(`/api/orders/${orphanOrderId}/assign-branch`)
      .set(authed(adminToken))
      .send({ branchId: otherBranchId });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/مرتبط بفرع بالفعل/);
  });
});
