// المرحلة 7M: دفتر عناوين العميل - ضد Postgres حقيقي. بيغطي: التسجيل الضمني التلقائي لعنوان جديد
// وقت إنشاء طلب دليفري (زي تسجيل العميل نفسه ضمنيًا)، عدم تكرار نفس العنوان لو اتكرر حرفيًا، CRUD
// دفتر العناوين (إضافة/تعديل/حذف/تعيين افتراضي)، والصلاحيات (الكاشير يضيف بس، مش يحذف).
const { app, request, pool, seedUser, login, authed } = require("./helpers");

let branchA;
let cashierToken, managerToken, callcenterToken, adminToken;
let cashPmId, itemId, variantId, areaId;

beforeAll(async () => {
  const bA = await pool.query("INSERT INTO branches (name) VALUES ('فرع-عناوين-A-جست') RETURNING id");
  branchA = bA.rows[0].id;

  await seedUser({ branchId: branchA, name: "كاشير-عناوين", email: "cashier-addr@jest.test", role: "cashier" });
  await seedUser({ branchId: branchA, name: "مدير-عناوين", email: "manager-addr@jest.test", role: "branch_manager" });
  await seedUser({ name: "كولسنتر-عناوين", email: "callcenter-addr@jest.test", role: "callcenter" });
  await seedUser({ name: "أدمن-عناوين", email: "admin-addr@jest.test", role: "admin" });

  cashierToken = await login("cashier-addr@jest.test");
  managerToken = await login("manager-addr@jest.test");
  callcenterToken = await login("callcenter-addr@jest.test");
  adminToken = await login("admin-addr@jest.test");

  const pm = await pool.query("INSERT INTO payment_methods (name, kind) VALUES ('كاش-عناوين-جست', 'cash') RETURNING id");
  cashPmId = pm.rows[0].id;
  const cat = await pool.query("INSERT INTO menu_categories (name) VALUES ('عناوين-جست-قسم') RETURNING id");
  const mi = await pool.query("INSERT INTO menu_items (category_id, name) VALUES ($1,'صنف-عناوين-جست') RETURNING id", [cat.rows[0].id]);
  itemId = mi.rows[0].id;
  const v = await pool.query("INSERT INTO menu_item_variants (item_id, label, price) VALUES ($1,'عادي',300) RETURNING id", [itemId]);
  variantId = v.rows[0].id;
  const area = await pool.query("INSERT INTO delivery_areas (name, fee, min_order, branch_id) VALUES ('منطقة-عناوين-جست', 10, 0, $1) RETURNING id", [branchA]);
  areaId = area.rows[0].id;
});

afterAll(async () => {
  await pool.end();
});

// Date.now() لوحده مش كافي هنا - الاختبارات جوا نفس الملف بتتنفذ سريع جدًا وممكن اتنين ياخدوا نفس
// الميلي ثانية بالظبط ويتصادموا على نفس رقم التليفون (نفس العميل)، فبنضيف عداد يضمن التفرد
let phoneCounter = 0;
function nextPhone() {
  phoneCounter += 1;
  const suffix = String(phoneCounter).padStart(3, "0");
  return `015${suffix}${Date.now()}`.slice(0, 11);
}

function makeDeliveryOrder(token, phone, addressDetails, deliveryAreaId) {
  return request(app).post("/api/orders").set(authed(token)).send({
    branchId: branchA, source: "pos", orderType: "delivery", customerPhone: phone,
    addressDetails, deliveryAreaId: deliveryAreaId ?? null, paymentMethodId: cashPmId,
    items: [{ itemId, variantId, quantity: 1 }],
  });
}

describe("تسجيل العنوان ضمنيًا وقت إنشاء طلب دليفري", () => {
  test("عميل جديد + عنوان جديد -> أول سطر في دفتر العناوين وبيبقى افتراضي", async () => {
    const phone = nextPhone();
    const res = await makeDeliveryOrder(cashierToken, phone, "شارع الأول 1", areaId);
    expect(res.status).toBe(201);

    const list = await request(app).get(`/api/customers/${phone}/addresses`).set(authed(managerToken));
    expect(list.status).toBe(200);
    expect(list.body.length).toBe(1);
    expect(list.body[0].addressDetails).toBe("شارع الأول 1");
    expect(list.body[0].isDefault).toBe(true);
    expect(list.body[0].deliveryAreaId).toBe(areaId);
  });

  test("نفس العميل بعنوان مختلف -> سطر تاني، مش افتراضي، الأول فاضل زي ما هو", async () => {
    const phone = nextPhone();
    await makeDeliveryOrder(cashierToken, phone, "شارع الأول 1", areaId);
    const res2 = await makeDeliveryOrder(cashierToken, phone, "شارع تاني مختلف 2");
    expect(res2.status).toBe(201);

    const list = await request(app).get(`/api/customers/${phone}/addresses`).set(authed(managerToken));
    expect(list.body.length).toBe(2);
    const defaults = list.body.filter((a) => a.isDefault);
    expect(defaults.length).toBe(1);
    expect(defaults[0].addressDetails).toBe("شارع الأول 1");
  });

  test("نفس العميل بنفس العنوان حرفيًا تاني -> مفيش سطر جديد (مفيش تكرار)", async () => {
    const phone = nextPhone();
    await makeDeliveryOrder(cashierToken, phone, "شارع مكرر", areaId);
    await makeDeliveryOrder(cashierToken, phone, "شارع مكرر", areaId);

    const list = await request(app).get(`/api/customers/${phone}/addresses`).set(authed(managerToken));
    expect(list.body.length).toBe(1);
  });
});

describe("CRUD دفتر العناوين + الصلاحيات", () => {
  test("POST إضافة عنوان جديد (كول سنتر) - بينشئ العميل لو مش موجود أصلًا", async () => {
    const phone = nextPhone();
    const res = await request(app).post(`/api/customers/${phone}/addresses`).set(authed(callcenterToken)).send({
      label: "البيت", addressDetails: "عنوان مباشر من الكول سنتر", deliveryAreaId: areaId,
    });
    expect(res.status).toBe(201);
    expect(res.body.label).toBe("البيت");

    const list = await request(app).get(`/api/customers/${phone}/addresses`).set(authed(adminToken));
    expect(list.body.length).toBe(1);
  });

  test("POST من غير addressDetails -> 400", async () => {
    const res = await request(app).post(`/api/customers/015xxxx/addresses`).set(authed(adminToken)).send({ label: "بدون عنوان" });
    expect(res.status).toBe(400);
  });

  test("الكاشير يقدر يضيف عنوان (مصرّح له) بس مايقدرش يحذف", async () => {
    const phone = nextPhone();
    const add = await request(app).post(`/api/customers/${phone}/addresses`).set(authed(cashierToken)).send({
      addressDetails: "عنوان من الكاشير مباشرة",
    });
    expect(add.status).toBe(201);
    const addrId = add.body.id;

    const del = await request(app).delete(`/api/customers/${phone}/addresses/${addrId}`).set(authed(cashierToken));
    expect(del.status).toBe(403);

    const delByManager = await request(app).delete(`/api/customers/${phone}/addresses/${addrId}`).set(authed(managerToken));
    expect(delByManager.status).toBe(200);
    const list = await request(app).get(`/api/customers/${phone}/addresses`).set(authed(adminToken));
    expect(list.body.length).toBe(0);
  });

  test("PATCH تعيين عنوان كافتراضي - بيلغي الافتراضي القديم أوتوماتيك", async () => {
    const phone = nextPhone();
    const a1 = await request(app).post(`/api/customers/${phone}/addresses`).set(authed(adminToken)).send({
      addressDetails: "عنوان 1", isDefault: true,
    });
    const a2 = await request(app).post(`/api/customers/${phone}/addresses`).set(authed(adminToken)).send({
      addressDetails: "عنوان 2",
    });

    const patch = await request(app).patch(`/api/customers/${phone}/addresses/${a2.body.id}`).set(authed(managerToken)).send({
      isDefault: true,
    });
    expect(patch.status).toBe(200);
    expect(patch.body.isDefault).toBe(true);

    const list = await request(app).get(`/api/customers/${phone}/addresses`).set(authed(adminToken));
    const a1Row = list.body.find((a) => a.id === a1.body.id);
    expect(a1Row.isDefault).toBe(false);
  });

  test("عنوان مش موجود -> 404 في التعديل والحذف", async () => {
    const patch = await request(app).patch(`/api/customers/01500000000/addresses/999999999`).set(authed(adminToken)).send({ label: "س" });
    expect(patch.status).toBe(404);
    const del = await request(app).delete(`/api/customers/01500000000/addresses/999999999`).set(authed(adminToken));
    expect(del.status).toBe(404);
  });
});
