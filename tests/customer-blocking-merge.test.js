// المرحلة 7P: حظر عميل + دمج عملاء مكررين - ضد Postgres حقيقي. بيغطي: حظر العميل بيمنع طلب دليفري
// جديد (تيك أواي/صالة مش متأثرين)، إلغاء الحظر بيرجّع الطلب يشتغل عادي، ودمج عميلين (طلبات + عناوين +
// نقاط ولاء) بيتحول للهدف وصف المصدر بيتشال.
const { app, request, pool, seedUser, login, authed } = require("./helpers");

let branchA;
let managerToken, adminToken, callcenterToken;
let cashPmId, itemId, variantId, areaId;

beforeAll(async () => {
  const bA = await pool.query("INSERT INTO branches (name) VALUES ('فرع-حظر-دمج-A-جست') RETURNING id");
  branchA = bA.rows[0].id;

  await seedUser({ branchId: branchA, name: "مدير-حظر-دمج", email: "manager-blockmerge@jest.test", role: "branch_manager" });
  await seedUser({ name: "أدمن-حظر-دمج", email: "admin-blockmerge@jest.test", role: "admin" });
  await seedUser({ name: "كولسنتر-حظر-دمج", email: "callcenter-blockmerge@jest.test", role: "callcenter" });

  managerToken = await login("manager-blockmerge@jest.test");
  adminToken = await login("admin-blockmerge@jest.test");
  callcenterToken = await login("callcenter-blockmerge@jest.test");

  const pm = await pool.query("INSERT INTO payment_methods (name, kind) VALUES ('كاش-حظر-دمج-جست', 'cash') RETURNING id");
  cashPmId = pm.rows[0].id;
  const cat = await pool.query("INSERT INTO menu_categories (name) VALUES ('حظر-دمج-جست-قسم') RETURNING id");
  const mi = await pool.query("INSERT INTO menu_items (category_id, name) VALUES ($1,'صنف-حظر-دمج-جست') RETURNING id", [cat.rows[0].id]);
  itemId = mi.rows[0].id;
  const v = await pool.query("INSERT INTO menu_item_variants (item_id, label, price) VALUES ($1,'عادي',200) RETURNING id", [itemId]);
  variantId = v.rows[0].id;
  const area = await pool.query("INSERT INTO delivery_areas (name, fee, min_order, branch_id) VALUES ('منطقة-حظر-دمج-جست', 10, 0, $1) RETURNING id", [branchA]);
  areaId = area.rows[0].id;
});

afterAll(async () => {
  await pool.end();
});

let phoneCounter = 0;
function nextPhone() {
  phoneCounter += 1;
  const suffix = String(phoneCounter).padStart(3, "0");
  return `016${suffix}${Date.now()}`.slice(0, 11);
}

function makeDeliveryOrder(token, phone) {
  return request(app).post("/api/orders").set(authed(token)).send({
    branchId: branchA, source: "pos", orderType: "delivery", customerPhone: phone,
    addressDetails: "شارع الاختبار", deliveryAreaId: areaId, paymentMethodId: cashPmId,
    items: [{ itemId, variantId, quantity: 1 }],
  });
}

describe("حظر العميل", () => {
  test("عميل مش موجود -> 404 عند الحظر", async () => {
    const res = await request(app).post(`/api/customers/01699999999/block`).set(authed(managerToken)).send({ reason: "تجربة" });
    expect(res.status).toBe(404);
  });

  test("بدون سبب -> 400", async () => {
    const phone = nextPhone();
    await makeDeliveryOrder(managerToken, phone);
    const res = await request(app).post(`/api/customers/${phone}/block`).set(authed(managerToken)).send({});
    expect(res.status).toBe(400);
  });

  test("حظر عميل بيمنع طلب دليفري جديد بنفس الرقم أو رقمه التاني، ومفيش أثر على العميل التاني", async () => {
    const phone = nextPhone();
    await makeDeliveryOrder(managerToken, phone);
    const otherPhone = nextPhone();
    await makeDeliveryOrder(managerToken, otherPhone);

    const block = await request(app).post(`/api/customers/${phone}/block`).set(authed(managerToken)).send({ reason: "بلاغ كاذب متكرر" });
    expect(block.status).toBe(200);

    const blockedAttempt = await makeDeliveryOrder(managerToken, phone);
    expect(blockedAttempt.status).toBe(403);
    expect(blockedAttempt.body.error).toMatch(/محظور/);

    const otherStillWorks = await makeDeliveryOrder(managerToken, otherPhone);
    expect(otherStillWorks.status).toBe(201);

    const profile = await request(app).get(`/api/customers?phone=${phone}`).set(authed(adminToken));
    expect(profile.body.isBlocked).toBe(true);
    expect(profile.body.blockReason).toBe("بلاغ كاذب متكرر");
  });

  test("إلغاء الحظر بيرجّع الطلب يشتغل عادي", async () => {
    const phone = nextPhone();
    await makeDeliveryOrder(managerToken, phone);
    await request(app).post(`/api/customers/${phone}/block`).set(authed(managerToken)).send({ reason: "تجربة" });
    const unblock = await request(app).post(`/api/customers/${phone}/unblock`).set(authed(managerToken));
    expect(unblock.status).toBe(200);
    const retry = await makeDeliveryOrder(managerToken, phone);
    expect(retry.status).toBe(201);
  });
});

describe("دمج عملاء مكررين", () => {
  test("دمج عميلين - الطلبات والعناوين بتتحول للهدف، نقاط الولاء بتتجمع، والمصدر بيتشال", async () => {
    const targetPhone = nextPhone();
    const sourcePhone = nextPhone();
    const orderTarget = await makeDeliveryOrder(managerToken, targetPhone);
    const orderSource = await makeDeliveryOrder(managerToken, sourcePhone);
    expect(orderTarget.status).toBe(201);
    expect(orderSource.status).toBe(201);

    await pool.query("UPDATE customers SET loyalty_points = 20 WHERE phone = $1", [targetPhone]);
    await pool.query("UPDATE customers SET loyalty_points = 5, name = 'اسم من المصدر' WHERE phone = $1", [sourcePhone]);
    await pool.query("UPDATE customers SET name = NULL WHERE phone = $1", [targetPhone]);

    const merge = await request(app).post("/api/customers/merge").set(authed(callcenterToken)).send({
      sourcePhone, targetPhone,
    });
    expect(merge.status).toBe(200);
    expect(merge.body.loyalty_points).toBe(25);
    expect(merge.body.name).toBe("اسم من المصدر"); // اتملى من المصدر لأن الهدف كان فاضي

    const sourceGone = await pool.query("SELECT * FROM customers WHERE phone = $1", [sourcePhone]);
    expect(sourceGone.rows.length).toBe(0);

    const ordersNowUnderTarget = await pool.query("SELECT COUNT(*)::int AS n FROM orders WHERE customer_phone = $1", [targetPhone]);
    expect(ordersNowUnderTarget.rows[0].n).toBe(2);

    const addressesNowUnderTarget = await pool.query("SELECT COUNT(*)::int AS n FROM customer_addresses WHERE customer_phone = $1", [targetPhone]);
    expect(addressesNowUnderTarget.rows[0].n).toBeGreaterThanOrEqual(1);
  });

  test("دمج عميل في نفسه -> 400، ودمج عميل مش موجود -> 404", async () => {
    const phone = nextPhone();
    await makeDeliveryOrder(managerToken, phone);
    const selfMerge = await request(app).post("/api/customers/merge").set(authed(adminToken)).send({
      sourcePhone: phone, targetPhone: phone,
    });
    expect(selfMerge.status).toBe(400);

    const missing = await request(app).post("/api/customers/merge").set(authed(adminToken)).send({
      sourcePhone: "01600000000", targetPhone: phone,
    });
    expect(missing.status).toBe(404);
  });
});
