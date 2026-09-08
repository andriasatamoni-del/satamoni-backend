// المرحلة 8.43: أتمتة واتساب - بيغطي الجزء اللي مينفعش يتسيب من غير اختبار (أمن الـwebhook: توقيع
// غلط لازم يترفض، والتحقق الأولي وقت ربط الرابط في لوحة Meta) + الشاشات الإدارية (صلاحيات الوصول،
// ودورة حياة الطلب المعلّق/الشكوى من تسجيل لحد المراجعة). مبيغطيش حلقة الذكاء الاصطناعي نفسها (Claude)
// لأنها محتاجة استدعاء شبكة حقيقي لـAnthropic - خارج نطاق اختبار آلي بدون بيانات اعتماد حقيقية.
const crypto = require("crypto");
const { app, request, pool, seedUser, login, authed } = require("./helpers");

let branchA;
let adminToken, callcenterToken, driverToken;

beforeAll(async () => {
  const bA = await pool.query("INSERT INTO branches (name) VALUES ('فرع-واتساب-جست') RETURNING id");
  branchA = bA.rows[0].id;
  await seedUser({ branchId: null, name: "أدمن-واتساب-جست", email: "admin-whatsapp@jest.test", role: "admin" });
  adminToken = await login("admin-whatsapp@jest.test");
  await seedUser({ branchId: null, name: "كول سنتر-واتساب-جست", email: "callcenter-whatsapp@jest.test", role: "callcenter" });
  callcenterToken = await login("callcenter-whatsapp@jest.test");
  await seedUser({ branchId: branchA, name: "طيار-واتساب-جست", email: "driver-whatsapp@jest.test", role: "driver" });
  driverToken = await login("driver-whatsapp@jest.test");
});

afterAll(async () => {
  await pool.end();
});

let phoneCounter = 0;
function nextPhone() {
  phoneCounter += 1;
  return `01000000${String(phoneCounter).padStart(3, "0")}`;
}

async function seedConversation(phone) {
  const res = await pool.query(
    "INSERT INTO whatsapp_conversations (phone, customer_name) VALUES ($1, $2) RETURNING id",
    [phone, "عميل جست"]
  );
  return res.rows[0].id;
}

describe("POST /api/whatsapp/webhook - أمن التوقيع", () => {
  afterEach(() => { delete process.env.WHATSAPP_APP_SECRET; });

  it("بيرفض إشعار من غير توقيع صحيح", async () => {
    process.env.WHATSAPP_APP_SECRET = "test-app-secret";
    const res = await request(app)
      .post("/api/whatsapp/webhook")
      .set("Content-Type", "application/json")
      .set("x-hub-signature-256", "sha256=0000000000000000000000000000000000000000000000000000000000000000")
      .send(JSON.stringify({ entry: [] }));
    expect(res.status).toBe(401);
  });

  it("بيقبل إشعار بتوقيع صحيح فعليًا", async () => {
    process.env.WHATSAPP_APP_SECRET = "test-app-secret";
    const rawBody = JSON.stringify({ entry: [] });
    const signature = "sha256=" + crypto.createHmac("sha256", "test-app-secret").update(rawBody).digest("hex");
    const res = await request(app)
      .post("/api/whatsapp/webhook")
      .set("Content-Type", "application/json")
      .set("x-hub-signature-256", signature)
      .send(rawBody);
    expect(res.status).toBe(200);
  });

  it("لو WHATSAPP_APP_SECRET مش متظبطة، أي إشعار بيترفض (فشل آمن، مش قبول مفتوح)", async () => {
    const rawBody = JSON.stringify({ entry: [] });
    const res = await request(app)
      .post("/api/whatsapp/webhook")
      .set("Content-Type", "application/json")
      .set("x-hub-signature-256", "sha256=" + crypto.createHmac("sha256", "whatever").update(rawBody).digest("hex"))
      .send(rawBody);
    expect(res.status).toBe(401);
  });
});

describe("GET /api/whatsapp/webhook - التحقق الأولي (Meta handshake)", () => {
  afterEach(() => { delete process.env.WHATSAPP_VERIFY_TOKEN; });

  it("بيرجّع الـchallenge لو التوكن مطابق", async () => {
    process.env.WHATSAPP_VERIFY_TOKEN = "verify-me";
    const res = await request(app)
      .get("/api/whatsapp/webhook")
      .query({ "hub.mode": "subscribe", "hub.verify_token": "verify-me", "hub.challenge": "12345" });
    expect(res.status).toBe(200);
    expect(res.text).toBe("12345");
  });

  it("بيرفض لو التوكن غلط", async () => {
    process.env.WHATSAPP_VERIFY_TOKEN = "verify-me";
    const res = await request(app)
      .get("/api/whatsapp/webhook")
      .query({ "hub.mode": "subscribe", "hub.verify_token": "غلط", "hub.challenge": "12345" });
    expect(res.status).toBe(403);
  });
});

describe("الشاشات الإدارية - صلاحيات الوصول", () => {
  it("محتاج تسجيل دخول", async () => {
    const res = await request(app).get("/api/whatsapp/pending-orders");
    expect(res.status).toBe(401);
  });

  it("دور مش مسموح بيه (طيار) بيترفض", async () => {
    const res = await request(app).get("/api/whatsapp/pending-orders").set(authed(driverToken));
    expect(res.status).toBe(403);
  });

  it("أدمن/كول سنتر يقدروا يشوفوا القايمة", async () => {
    const res = await request(app).get("/api/whatsapp/pending-orders").set(authed(adminToken));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });
});

describe("دورة حياة الطلب المعلّق", () => {
  it("رفض طلب معلّق بيغيّر حالته لـrejected", async () => {
    const phone = nextPhone();
    const conversationId = await seedConversation(phone);
    const po = await pool.query(
      `INSERT INTO whatsapp_pending_orders (conversation_id, customer_phone, customer_name, order_type, items, subtotal, total, status)
       VALUES ($1,$2,'عميل جست','takeaway','[]',0,0,'pending') RETURNING id`,
      [conversationId, phone]
    );
    const poId = po.rows[0].id;

    const res = await request(app)
      .post(`/api/whatsapp/pending-orders/${poId}/reject`)
      .set(authed(callcenterToken))
      .send({ reason: "العميل عدل رأيه" });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("rejected");
    expect(res.body.rejection_reason).toBe("العميل عدل رأيه");
  });

  it("ربط طلب معلّق بطلب حقيقي بيأكده", async () => {
    const phone = nextPhone();
    const conversationId = await seedConversation(phone);
    const po = await pool.query(
      `INSERT INTO whatsapp_pending_orders (conversation_id, customer_phone, customer_name, order_type, items, subtotal, total, status)
       VALUES ($1,$2,'عميل جست','takeaway','[]',0,0,'pending') RETURNING id`,
      [conversationId, phone]
    );
    const poId = po.rows[0].id;

    const orderRow = await pool.query("INSERT INTO orders (branch_id, order_type) VALUES ($1,'takeaway') RETURNING id", [branchA]);
    const orderId = orderRow.rows[0].id;

    const res = await request(app)
      .post(`/api/whatsapp/pending-orders/${poId}/link-order`)
      .set(authed(callcenterToken))
      .send({ orderId });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("confirmed");
    expect(res.body.confirmed_order_id).toBe(orderId);
  });

  it("مفيش مسودة مفتوحة تانية لنفس المحادثة (unique constraint)", async () => {
    const phone = nextPhone();
    const conversationId = await seedConversation(phone);
    await pool.query(
      `INSERT INTO whatsapp_pending_orders (conversation_id, customer_phone, order_type, items, subtotal, total, status)
       VALUES ($1,$2,'takeaway','[]',0,0,'draft')`,
      [conversationId, phone]
    );
    await expect(
      pool.query(
        `INSERT INTO whatsapp_pending_orders (conversation_id, customer_phone, order_type, items, subtotal, total, status)
         VALUES ($1,$2,'takeaway','[]',0,0,'draft')`,
        [conversationId, phone]
      )
    ).rejects.toThrow();
  });
});

describe("PATCH /api/pos-settings - whatsapp_bot_enabled", () => {
  afterEach(async () => {
    await pool.query("UPDATE pos_settings SET whatsapp_bot_enabled = FALSE WHERE id = 1");
  });

  it("أدمن يقدر يفعّل/يعطّل بوت واتساب من غير Shell", async () => {
    const res = await request(app).patch("/api/pos-settings").set(authed(adminToken)).send({ whatsappBotEnabled: true });
    expect(res.status).toBe(200);
    expect(res.body.whatsapp_bot_enabled).toBe(true);
  });

  it("كول سنتر معندوش صلاحية يفعّل البوت (أدمن بس)", async () => {
    const res = await request(app).patch("/api/pos-settings").set(authed(callcenterToken)).send({ whatsappBotEnabled: true });
    expect(res.status).toBe(403);
  });
});

describe("دورة حياة الشكاوى", () => {
  it("تسجيل شكوى وحلها", async () => {
    const phone = nextPhone();
    const conversationId = await seedConversation(phone);
    const complaint = await pool.query(
      `INSERT INTO whatsapp_complaints (conversation_id, customer_phone, category, description)
       VALUES ($1,$2,'late_order','الأوردر اتأخر ساعة') RETURNING id`,
      [conversationId, phone]
    );
    const complaintId = complaint.rows[0].id;

    const listRes = await request(app).get("/api/whatsapp/complaints?status=open").set(authed(adminToken));
    expect(listRes.status).toBe(200);
    expect(listRes.body.some((c) => c.id === complaintId)).toBe(true);

    const resolveRes = await request(app)
      .post(`/api/whatsapp/complaints/${complaintId}/resolve`)
      .set(authed(adminToken))
      .send({ resolutionNotes: "اتكلمنا مع العميل واعتذرنا" });
    expect(resolveRes.status).toBe(200);
    expect(resolveRes.body.status).toBe("resolved");
  });
});
