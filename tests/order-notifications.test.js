// المرحلة 7S: تأكيد الطلب بـSMS/واتساب للعميل - ضد Postgres حقيقي + سيرفر HTTP وهمي محلي يمثّل بوابة
// الإرسال. بيغطي: sendMessage() (مفيش بوابة متظبطة / نجاح / فشل)، والتأثير الفعلي جوه إنشاء الطلب:
// الإعداد مطفي بيمنع أي محاولة، صالة/طلبات مش بتتأثر (النوع مش في القايمة القابلة للتأكيد)، فشل الإرسال
// (أو مفيش بوابة أصلًا) مبيأثرش على نجاح تسجيل الطلب نفسه.
const http = require("http");
const { app, request, pool, seedUser, login, authed } = require("./helpers");
const { sendMessage } = require("../db/sms-provider");

let branchA;
let managerToken;
let cashPmId, itemId, variantId;

beforeAll(async () => {
  const bA = await pool.query("INSERT INTO branches (name) VALUES ('فرع-إشعارات-جست') RETURNING id");
  branchA = bA.rows[0].id;
  await seedUser({ branchId: branchA, name: "مدير-إشعارات", email: "manager-notify@jest.test", role: "branch_manager" });
  managerToken = await login("manager-notify@jest.test");

  const pm = await pool.query("INSERT INTO payment_methods (name, kind) VALUES ('كاش-إشعارات-جست', 'cash') RETURNING id");
  cashPmId = pm.rows[0].id;
  const cat = await pool.query("INSERT INTO menu_categories (name) VALUES ('إشعارات-جست-قسم') RETURNING id");
  const mi = await pool.query("INSERT INTO menu_items (category_id, name) VALUES ($1,'صنف-إشعارات-جست') RETURNING id", [cat.rows[0].id]);
  itemId = mi.rows[0].id;
  const v = await pool.query("INSERT INTO menu_item_variants (item_id, label, price) VALUES ($1,'عادي',150) RETURNING id", [itemId]);
  variantId = v.rows[0].id;
});

afterAll(async () => {
  await pool.end();
});

afterEach(async () => {
  delete process.env.SMS_WEBHOOK_URL;
  delete process.env.SMS_WEBHOOK_METHOD;
  delete process.env.SMS_WEBHOOK_AUTH_HEADER;
  await pool.query("UPDATE pos_settings SET sms_confirmations_enabled = FALSE WHERE id = 1");
});

let phoneCounter = 0;
function nextPhone() {
  phoneCounter += 1;
  const suffix = String(phoneCounter).padStart(3, "0");
  return `020${suffix}${Date.now()}`.slice(0, 11);
}

function makeTakeawayOrder(token, phone) {
  return request(app).post("/api/orders").set(authed(token)).send({
    branchId: branchA, source: "pos", orderType: "takeaway", customerPhone: phone,
    paymentMethodId: cashPmId, items: [{ itemId, variantId, quantity: 1 }],
  });
}

function makeDineInOrder(token) {
  return request(app).post("/api/orders").set(authed(token)).send({
    branchId: branchA, source: "pos", orderType: "dinein", tableNumber: "1",
    paymentMethodId: cashPmId, items: [{ itemId, variantId, quantity: 1 }],
  });
}

async function startMockGateway(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  return { server, url: `http://127.0.0.1:${port}/send` };
}

describe("db/sms-provider.js - sendMessage()", () => {
  test("من غير SMS_WEBHOOK_URL -> not_configured من غير أي محاولة اتصال", async () => {
    const result = await sendMessage({ phone: "01000000000", message: "تجربة" });
    expect(result).toEqual({ sent: false, status: "not_configured" });
  });

  test("بوابة شغالة وراجعة 200 -> sent، والبيانات بتوصل صح", async () => {
    let receivedBody = null;
    let receivedAuth = null;
    const { server, url } = await startMockGateway((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        receivedBody = JSON.parse(raw);
        receivedAuth = req.headers.authorization;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      });
    });
    process.env.SMS_WEBHOOK_URL = url;
    process.env.SMS_WEBHOOK_AUTH_HEADER = "Bearer test-key";
    try {
      const result = await sendMessage({ phone: "01011112222", message: "رسالة تجربة" });
      expect(result).toEqual({ sent: true, status: "sent" });
      expect(receivedBody).toEqual({ to: "01011112222", message: "رسالة تجربة" });
      expect(receivedAuth).toBe("Bearer test-key");
    } finally {
      server.close();
    }
  });

  test("بوابة راجعة خطأ HTTP -> failed مع تفاصيل الخطأ، من غير ما ترمي استثناء", async () => {
    const { server, url } = await startMockGateway((req, res) => {
      res.writeHead(503);
      res.end();
    });
    process.env.SMS_WEBHOOK_URL = url;
    try {
      const result = await sendMessage({ phone: "01011112222", message: "تجربة" });
      expect(result.sent).toBe(false);
      expect(result.status).toBe("failed");
      expect(result.error).toMatch(/503/);
    } finally {
      server.close();
    }
  });

  test("مفيش سيرفر أصلًا على البورت (اتصال فاشل) -> failed من غير استثناء", async () => {
    process.env.SMS_WEBHOOK_URL = "http://127.0.0.1:1/send";
    const result = await sendMessage({ phone: "01011112222", message: "تجربة" });
    expect(result.sent).toBe(false);
    expect(result.status).toBe("failed");
    expect(result.error).toBeTruthy();
  });
});

describe("تأكيد الطلب - أثره جوه إنشاء الطلب فعليًا", () => {
  test("الإعداد مطفي (افتراضي) -> مفيش أي صف في order_notifications حتى لو الطلب دليفري/تيك أواي", async () => {
    const phone = nextPhone();
    const res = await makeTakeawayOrder(managerToken, phone);
    expect(res.status).toBe(201);
    const rows = await pool.query("SELECT * FROM order_notifications WHERE order_id = $1", [res.body.orderId]);
    expect(rows.rows.length).toBe(0);
  });

  test("الإعداد شغال بس مفيش بوابة متظبطة -> صف بحالة not_configured، والطلب لسه بينجح عادي", async () => {
    await pool.query("UPDATE pos_settings SET sms_confirmations_enabled = TRUE WHERE id = 1");
    const phone = nextPhone();
    const res = await makeTakeawayOrder(managerToken, phone);
    expect(res.status).toBe(201);
    const rows = await pool.query("SELECT * FROM order_notifications WHERE order_id = $1", [res.body.orderId]);
    expect(rows.rows.length).toBe(1);
    expect(rows.rows[0].status).toBe("not_configured");
    expect(rows.rows[0].phone).toBe(phone);
  });

  test("الإعداد شغال + بوابة شغالة -> صف بحالة sent، والرسالة فيها رقم الطلب والمبلغ", async () => {
    await pool.query("UPDATE pos_settings SET sms_confirmations_enabled = TRUE WHERE id = 1");
    const { server, url } = await startMockGateway((req, res) => {
      res.writeHead(200);
      res.end();
    });
    process.env.SMS_WEBHOOK_URL = url;
    try {
      const phone = nextPhone();
      const res = await makeTakeawayOrder(managerToken, phone);
      expect(res.status).toBe(201);
      const rows = await pool.query("SELECT * FROM order_notifications WHERE order_id = $1", [res.body.orderId]);
      expect(rows.rows.length).toBe(1);
      expect(rows.rows[0].status).toBe("sent");
      expect(rows.rows[0].message).toContain(String(res.body.orderId));
    } finally {
      server.close();
    }
  });

  test("الإعداد شغال + بوابة فاشلة -> الطلب لسه بينجح 201، والصف بيتسجل بحالة failed", async () => {
    await pool.query("UPDATE pos_settings SET sms_confirmations_enabled = TRUE WHERE id = 1");
    const { server, url } = await startMockGateway((req, res) => {
      res.writeHead(500);
      res.end();
    });
    process.env.SMS_WEBHOOK_URL = url;
    try {
      const phone = nextPhone();
      const res = await makeTakeawayOrder(managerToken, phone);
      expect(res.status).toBe(201);
      const rows = await pool.query("SELECT * FROM order_notifications WHERE order_id = $1", [res.body.orderId]);
      expect(rows.rows.length).toBe(1);
      expect(rows.rows[0].status).toBe("failed");
    } finally {
      server.close();
    }
  });

  test("طلب صالة (dine_in) - مفيش محاولة إرسال حتى لو الإعداد شغال (النوع مش قابل للتأكيد)", async () => {
    await pool.query("UPDATE pos_settings SET sms_confirmations_enabled = TRUE WHERE id = 1");
    const res = await makeDineInOrder(managerToken);
    expect(res.status).toBe(201);
    const rows = await pool.query("SELECT * FROM order_notifications WHERE order_id = $1", [res.body.orderId]);
    expect(rows.rows.length).toBe(0);
  });
});
