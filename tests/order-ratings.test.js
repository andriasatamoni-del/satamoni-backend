// المرحلة 8.40: رسالة واتساب لطلب تقييم بعد التسليم/الاستلام + صفحة التقييم العامة (routes/order-ratings.js).
// بيغطي: وقت إرسال رسالة التقييم لكل نوع طلب (تيك أواي عند READY، دليفري عند completed بس - مش عند
// READY عشان محدش يوصله رسالتين)، صالة مش قابلة للتقييم أصلًا، الإعداد مطفي افتراضيًا، ورينق/تعديل
// التقييم نفسه عبر التوكن العام (بدون تسجيل دخول) - توكن غلط/طلب غلط/نجوم غير صالحة/إعادة إرسال بتحدّث
// مش بتكرر.
const http = require("http");
const { app, request, pool, seedUser, login, authed } = require("./helpers");

let branchA;
let cashierToken;
let cashPmId, itemId, variantId;

beforeAll(async () => {
  const bA = await pool.query("INSERT INTO branches (name) VALUES ('فرع-تقييمات-جست') RETURNING id");
  branchA = bA.rows[0].id;
  await seedUser({ branchId: branchA, name: "كاشير-تقييمات", email: "cashier-ratings@jest.test", role: "cashier" });
  cashierToken = await login("cashier-ratings@jest.test");

  const pm = await pool.query("INSERT INTO payment_methods (name, kind) VALUES ('كاش-تقييمات-جست', 'cash') RETURNING id");
  cashPmId = pm.rows[0].id;
  const cat = await pool.query("INSERT INTO menu_categories (name) VALUES ('تقييمات-جست-قسم') RETURNING id");
  const mi = await pool.query("INSERT INTO menu_items (category_id, name) VALUES ($1,'صنف-تقييمات-جست') RETURNING id", [cat.rows[0].id]);
  itemId = mi.rows[0].id;
  const v = await pool.query("INSERT INTO menu_item_variants (item_id, label, price) VALUES ($1,'عادي',120) RETURNING id", [itemId]);
  variantId = v.rows[0].id;
});

afterAll(async () => {
  await pool.end();
});

afterEach(async () => {
  delete process.env.SMS_WEBHOOK_URL;
  await pool.query("UPDATE pos_settings SET sms_rating_requests_enabled = FALSE WHERE id = 1");
});

let phoneCounter = 0;
function nextPhone() {
  phoneCounter += 1;
  const suffix = String(phoneCounter).padStart(3, "0");
  return `018${suffix}${Date.now()}`.slice(0, 11);
}

async function makeOrder(orderType, phone) {
  const res = await request(app).post("/api/orders").set(authed(cashierToken)).send({
    branchId: branchA, source: "pos", orderType,
    tableNumber: orderType === "dinein" ? "T-تقييم-1" : undefined,
    customerPhone: phone,
    paymentMethodId: cashPmId,
    items: [{ itemId, variantId, quantity: 1 }],
  });
  expect(res.status).toBe(201);
  return res.body.orderId;
}

async function advanceKitchenTo(orderId, status) {
  const sequence = ["ACCEPTED", "PREPARING", "READY"];
  for (const s of sequence) {
    const res = await request(app).patch(`/api/orders/${orderId}/kitchen-status`).set(authed(cashierToken)).send({ status: s });
    expect(res.status).toBe(200);
    if (s === status) break;
  }
}

async function completeDeliveryOrder(orderId) {
  let res = await request(app).patch(`/api/orders/${orderId}/status`).set(authed(cashierToken))
    .send({ status: "out_for_delivery", driverName: "سائق تجربة" });
  expect(res.status).toBe(200);
  res = await request(app).patch(`/api/orders/${orderId}/status`).set(authed(cashierToken)).send({ status: "completed" });
  expect(res.status).toBe(200);
}

async function startMockGateway(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  return { server, url: `http://127.0.0.1:${port}/send` };
}

describe("طلب التقييم - وقت الإرسال حسب نوع الطلب", () => {
  test("الإعداد مطفي (افتراضي) -> مفيش رسالة تقييم حتى لو تيك أواي وصل READY", async () => {
    const orderId = await makeOrder("takeaway", nextPhone());
    await advanceKitchenTo(orderId, "READY");
    const rows = await pool.query("SELECT * FROM order_notifications WHERE order_id = $1 AND kind = 'rating_request'", [orderId]);
    expect(rows.rows.length).toBe(0);
  });

  test("تيك أواي هاتفي + الإعداد شغال -> رسالة تقييم لحظة READY في المطبخ", async () => {
    await pool.query("UPDATE pos_settings SET sms_rating_requests_enabled = TRUE WHERE id = 1");
    const phone = nextPhone();
    const orderId = await makeOrder("takeaway", phone);
    await advanceKitchenTo(orderId, "READY");
    const rows = await pool.query("SELECT * FROM order_notifications WHERE order_id = $1 AND kind = 'rating_request'", [orderId]);
    expect(rows.rows.length).toBe(1);
    expect(rows.rows[0].channel).toBe("whatsapp");
    expect(rows.rows[0].phone).toBe(phone);
    expect(rows.rows[0].message).toContain(`/rate.html?order=${orderId}&token=`);
  });

  test("دليفري + الإعداد شغال -> مفيش رسالة تقييم لحظة READY في المطبخ (لسه ماوصلش فعليًا)", async () => {
    await pool.query("UPDATE pos_settings SET sms_rating_requests_enabled = TRUE WHERE id = 1");
    const orderId = await makeOrder("delivery", nextPhone());
    await advanceKitchenTo(orderId, "READY");
    const rows = await pool.query("SELECT * FROM order_notifications WHERE order_id = $1 AND kind = 'rating_request'", [orderId]);
    expect(rows.rows.length).toBe(0);
  });

  test("دليفري + الإعداد شغال -> رسالة تقييم واحدة بس لحظة ما الطلب يوصل (completed)، مش مرتين", async () => {
    await pool.query("UPDATE pos_settings SET sms_rating_requests_enabled = TRUE WHERE id = 1");
    const orderId = await makeOrder("delivery", nextPhone());
    await advanceKitchenTo(orderId, "READY");
    await completeDeliveryOrder(orderId);
    const rows = await pool.query("SELECT * FROM order_notifications WHERE order_id = $1 AND kind = 'rating_request'", [orderId]);
    expect(rows.rows.length).toBe(1);
  });

  test("طلب صالة - مفيش رسالة تقييم حتى لو وصل READY (النوع مش قابل للتقييم بالواتساب)", async () => {
    await pool.query("UPDATE pos_settings SET sms_rating_requests_enabled = TRUE WHERE id = 1");
    const orderId = await makeOrder("dinein", nextPhone());
    await advanceKitchenTo(orderId, "READY");
    const rows = await pool.query("SELECT * FROM order_notifications WHERE order_id = $1 AND kind = 'rating_request'", [orderId]);
    expect(rows.rows.length).toBe(0);
  });

  test("بوابة شغالة فعليًا -> الرسالة بتتبعت وتتسجل بحالة sent باللينك الصحيح", async () => {
    await pool.query("UPDATE pos_settings SET sms_rating_requests_enabled = TRUE WHERE id = 1");
    let receivedBody = null;
    const { server, url } = await startMockGateway((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        receivedBody = JSON.parse(raw);
        res.writeHead(200);
        res.end();
      });
    });
    process.env.SMS_WEBHOOK_URL = url;
    try {
      const orderId = await makeOrder("takeaway", nextPhone());
      await advanceKitchenTo(orderId, "READY");
      const rows = await pool.query("SELECT * FROM order_notifications WHERE order_id = $1 AND kind = 'rating_request'", [orderId]);
      expect(rows.rows[0].status).toBe("sent");
      expect(receivedBody.message).toContain(`order=${orderId}`);
    } finally {
      server.close();
    }
  });
});

describe("GET /api/order-ratings/:orderId - صفحة التقييم العامة (بدون تسجيل دخول)", () => {
  test("توكن ورقم طلب صحيحين -> بيانات الطلب + الأصناف", async () => {
    const orderId = await makeOrder("takeaway", nextPhone());
    const tokenRow = await pool.query("SELECT rating_token FROM orders WHERE id = $1", [orderId]);
    const token = tokenRow.rows[0].rating_token;

    const res = await request(app).get(`/api/order-ratings/${orderId}?token=${token}`);
    expect(res.status).toBe(200);
    expect(res.body.orderId).toBe(orderId);
    expect(res.body.items.length).toBe(1);
    expect(res.body.existingRating).toBeNull();
  });

  test("توكن غلط -> 404", async () => {
    const orderId = await makeOrder("takeaway", nextPhone());
    const res = await request(app).get(`/api/order-ratings/${orderId}?token=00000000-0000-0000-0000-000000000000`);
    expect(res.status).toBe(404);
  });

  test("توكن طلب تاني مع رقم طلب مش بتاعه -> 404 (محدش يقدر يشوف طلب مش بتاعه)", async () => {
    const orderIdA = await makeOrder("takeaway", nextPhone());
    const orderIdB = await makeOrder("takeaway", nextPhone());
    const tokenB = (await pool.query("SELECT rating_token FROM orders WHERE id = $1", [orderIdB])).rows[0].rating_token;
    const res = await request(app).get(`/api/order-ratings/${orderIdA}?token=${tokenB}`);
    expect(res.status).toBe(404);
  });

  test("رقم طلب مش رقم صحيح -> 400", async () => {
    const res = await request(app).get(`/api/order-ratings/abc?token=x`);
    expect(res.status).toBe(400);
  });
});

describe("POST /api/order-ratings/:orderId - إرسال/تحديث التقييم", () => {
  test("تقييم صحيح -> ok:true وصف واحد في order_ratings", async () => {
    const orderId = await makeOrder("takeaway", nextPhone());
    const token = (await pool.query("SELECT rating_token FROM orders WHERE id = $1", [orderId])).rows[0].rating_token;

    const res = await request(app).post(`/api/order-ratings/${orderId}`).send({ token, stars: 5, comment: "ممتاز" });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    const rows = await pool.query("SELECT * FROM order_ratings WHERE order_id = $1", [orderId]);
    expect(rows.rows.length).toBe(1);
    expect(rows.rows[0].stars).toBe(5);
    expect(rows.rows[0].comment).toBe("ممتاز");
    expect(rows.rows[0].branch_id).toBe(branchA);
  });

  test("إعادة إرسال بنفس اللينك بتحدّث نفس الصف مش تنشئ صف جديد", async () => {
    const orderId = await makeOrder("takeaway", nextPhone());
    const token = (await pool.query("SELECT rating_token FROM orders WHERE id = $1", [orderId])).rows[0].rating_token;

    await request(app).post(`/api/order-ratings/${orderId}`).send({ token, stars: 2, comment: "معلش" });
    const res = await request(app).post(`/api/order-ratings/${orderId}`).send({ token, stars: 5, comment: "غيرت رأيي" });
    expect(res.status).toBe(200);
    const rows = await pool.query("SELECT * FROM order_ratings WHERE order_id = $1", [orderId]);
    expect(rows.rows.length).toBe(1);
    expect(rows.rows[0].stars).toBe(5);
    expect(rows.rows[0].comment).toBe("غيرت رأيي");
  });

  test("نجوم برة النطاق (0 أو 6) -> 400", async () => {
    const orderId = await makeOrder("takeaway", nextPhone());
    const token = (await pool.query("SELECT rating_token FROM orders WHERE id = $1", [orderId])).rows[0].rating_token;

    let res = await request(app).post(`/api/order-ratings/${orderId}`).send({ token, stars: 0 });
    expect(res.status).toBe(400);
    res = await request(app).post(`/api/order-ratings/${orderId}`).send({ token, stars: 6 });
    expect(res.status).toBe(400);
  });

  test("توكن غلط -> 404 ومفيش تقييم اتسجل", async () => {
    const orderId = await makeOrder("takeaway", nextPhone());
    const res = await request(app).post(`/api/order-ratings/${orderId}`)
      .send({ token: "00000000-0000-0000-0000-000000000000", stars: 4 });
    expect(res.status).toBe(404);
    const rows = await pool.query("SELECT * FROM order_ratings WHERE order_id = $1", [orderId]);
    expect(rows.rows.length).toBe(0);
  });
});
