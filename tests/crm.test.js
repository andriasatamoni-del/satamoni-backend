// CRM-1: متابعة أوردرات الدليفري بعد التسليم + شكاوى العملاء. ضد Postgres حقيقي.
// بيغطي: طابور المتابعة (بيشمل لسه-ما-اتصلناش-بيه ومردّش، بيستبعد اتصلنا-3-مرات-وماردّش وغير-متسلّم
// وتم-الرد)، upsert المتابعة (مش صف جديد كل مرة)، إنشاء شكوى من نتيجة متابعة، تحديث حالة شكوى، وآخر
// شكوى لرقم عميل (لبانر شاشة الكول سنتر)، وصلاحيات الأدوار.
const { app, request, pool, seedUser, login, authed } = require("./helpers");

let adminToken, callcenterToken, cashierToken;
let branchId;
let deliveredNoFollowupOrderId, deliveredNoAnswerOrderId, deliveredAnsweredOrderId,
    deliveredGaveUpOrderId, notDeliveredOrderId;

async function insertOrder({ dispatchStatus, deliveredAt, customerPhone }) {
  const result = await pool.query(
    `INSERT INTO orders (branch_id, order_type, customer_name, customer_phone, total, dispatch_status, delivered_at)
     VALUES ($1,'delivery','عميل-جست-كرم',$2,150,$3,$4) RETURNING id`,
    [branchId, customerPhone, dispatchStatus, deliveredAt]
  );
  return result.rows[0].id;
}

beforeAll(async () => {
  await seedUser({ name: "أدمن-كرم-جست", email: "admin-crm@jest.test", role: "admin" });
  await seedUser({ name: "كول سنتر-كرم-جست", email: "callcenter-crm@jest.test", role: "callcenter" });
  await seedUser({ name: "كاشير-كرم-جست", email: "cashier-crm@jest.test", role: "cashier" });
  adminToken = await login("admin-crm@jest.test");
  callcenterToken = await login("callcenter-crm@jest.test");
  cashierToken = await login("cashier-crm@jest.test");

  const branch = await pool.query("INSERT INTO branches (name) VALUES ('فرع-كرم-جست') RETURNING id");
  branchId = branch.rows[0].id;

  deliveredNoFollowupOrderId = await insertOrder({ dispatchStatus: "DELIVERED", deliveredAt: "2026-01-01T10:00:00Z", customerPhone: "01000000001" });
  notDeliveredOrderId = await insertOrder({ dispatchStatus: "OUT_FOR_DELIVERY", deliveredAt: null, customerPhone: "01000000002" });
});

afterAll(async () => {
  await pool.end();
});

describe("GET /api/crm/followup-queue", () => {
  test("مش مسموح لغير أدمن/مدير فرع/كول سنتر", async () => {
    const res = await request(app).get("/api/crm/followup-queue").set(authed(cashierToken));
    expect(res.status).toBe(403);
  });

  test("بيوري الأوردر المتسلّم اللي لسه ما اتصلناش بيه، مش الأوردر اللي لسه مش متسلّم", async () => {
    const res = await request(app).get("/api/crm/followup-queue").set(authed(callcenterToken));
    expect(res.status).toBe(200);
    const ids = res.body.map((r) => r.orderId);
    expect(ids).toContain(deliveredNoFollowupOrderId);
    expect(ids).not.toContain(notDeliveredOrderId);
  });
});

describe("POST /api/crm/followups", () => {
  test("مش مسموح لغير أدمن/مدير فرع/كول سنتر", async () => {
    const res = await request(app).post("/api/crm/followups").set(authed(cashierToken)).send({
      orderId: deliveredNoFollowupOrderId, callResult: "answered",
    });
    expect(res.status).toBe(403);
  });

  test("نتيجة اتصال غير معروفة - 400", async () => {
    const res = await request(app).post("/api/crm/followups").set(authed(callcenterToken)).send({
      orderId: deliveredNoFollowupOrderId, callResult: "شيء غريب",
    });
    expect(res.status).toBe(400);
  });

  test("تسجيل متابعة (مردّش) بيسيب الأوردر في الطابور لمحاولة تانية", async () => {
    const res = await request(app).post("/api/crm/followups").set(authed(callcenterToken)).send({
      orderId: deliveredNoFollowupOrderId, callResult: "no_answer", notes: "محاولة أولى",
    });
    expect(res.status).toBe(201);
    expect(res.body.followup.call_result).toBe("no_answer");

    const queue = await request(app).get("/api/crm/followup-queue").set(authed(callcenterToken));
    const entry = queue.body.find((r) => r.orderId === deliveredNoFollowupOrderId);
    expect(entry).toBeDefined();
    expect(entry.lastCallResult).toBe("no_answer");
  });

  test("محاولة تانية على نفس الأوردر بتحدّث نفس الصف (upsert)، مش صف جديد", async () => {
    await request(app).post("/api/crm/followups").set(authed(callcenterToken)).send({
      orderId: deliveredNoFollowupOrderId, callResult: "answered", satisfactionRating: "good", notes: "اتصلنا وردّ",
    });
    const count = await pool.query("SELECT COUNT(*)::int AS c FROM customer_followups WHERE order_id = $1", [deliveredNoFollowupOrderId]);
    expect(count.rows[0].c).toBe(1);

    // دلوقتي "تم الرد" - المفروض يخرج من الطابور
    const queue = await request(app).get("/api/crm/followup-queue").set(authed(callcenterToken));
    expect(queue.body.map((r) => r.orderId)).not.toContain(deliveredNoFollowupOrderId);
  });

  test("اتصلنا 3 مرات وماردّش - نهائي، بيخرج من الطابور ومبيدخلش تاني", async () => {
    deliveredGaveUpOrderId = await insertOrder({ dispatchStatus: "DELIVERED", deliveredAt: "2026-01-02T10:00:00Z", customerPhone: "01000000003" });
    await request(app).post("/api/crm/followups").set(authed(callcenterToken)).send({
      orderId: deliveredGaveUpOrderId, callResult: "no_answer_after_3_tries",
    });
    const queue = await request(app).get("/api/crm/followup-queue").set(authed(callcenterToken));
    expect(queue.body.map((r) => r.orderId)).not.toContain(deliveredGaveUpOrderId);
  });

  test("تسجيل متابعة فيها شكوى بينشئ شكوى مرتبطة بالأوردر ونفس رقم العميل", async () => {
    deliveredAnsweredOrderId = await insertOrder({ dispatchStatus: "DELIVERED", deliveredAt: "2026-01-03T10:00:00Z", customerPhone: "01000000004" });
    const res = await request(app).post("/api/crm/followups").set(authed(callcenterToken)).send({
      orderId: deliveredAnsweredOrderId, callResult: "answered", satisfactionRating: "bad",
      hasComplaint: true,
      complaint: { category: "quality", description: "الأكل وصل بارد", status: "open" },
    });
    expect(res.status).toBe(201);
    expect(res.body.complaint).toBeTruthy();
    expect(res.body.complaint.category).toBe("quality");
    expect(res.body.complaint.customer_phone).toBe("01000000004");
    expect(res.body.complaint.followup_id).toBe(res.body.followup.id);
  });

  test("أوردر مش موجود - 404", async () => {
    const res = await request(app).post("/api/crm/followups").set(authed(callcenterToken)).send({
      orderId: 999999999, callResult: "answered",
    });
    expect(res.status).toBe(404);
  });
});

describe("GET /api/crm/complaints و PATCH", () => {
  let complaintId;

  test("رؤية الشكاوى وفلترة بالحالة", async () => {
    const all = await request(app).get("/api/crm/complaints").set(authed(adminToken));
    expect(all.status).toBe(200);
    const found = all.body.find((c) => c.orderId === deliveredAnsweredOrderId);
    expect(found).toBeDefined();
    complaintId = found.id;

    const open = await request(app).get("/api/crm/complaints?status=open").set(authed(adminToken));
    expect(open.body.some((c) => c.id === complaintId)).toBe(true);
    const resolved = await request(app).get("/api/crm/complaints?status=resolved").set(authed(adminToken));
    expect(resolved.body.some((c) => c.id === complaintId)).toBe(false);
  });

  test("تحديث حالة الشكوى لـresolved بيسجّل مين وامتى", async () => {
    const res = await request(app).patch(`/api/crm/complaints/${complaintId}`).set(authed(callcenterToken)).send({
      status: "resolved", resolutionNotes: "اتبعتله صنف بديل واعتذرنا",
    });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("resolved");
    expect(res.body.resolved_at).toBeTruthy();
    expect(res.body.resolution_notes).toBe("اتبعتله صنف بديل واعتذرنا");
  });

  test("مش مسموح لغير أدمن/مدير فرع/كول سنتر", async () => {
    const res = await request(app).patch(`/api/crm/complaints/${complaintId}`).set(authed(cashierToken)).send({ status: "open" });
    expect(res.status).toBe(403);
  });
});

describe("GET /api/crm/customers/:phone/complaints/latest", () => {
  test("بيرجع آخر شكوى للعميل ده", async () => {
    const res = await request(app).get("/api/crm/customers/01000000004/complaints/latest").set(authed(callcenterToken));
    expect(res.status).toBe(200);
    expect(res.body.category).toBe("quality");
  });

  test("null لو العميل مفيهوش شكاوى خالص", async () => {
    const res = await request(app).get("/api/crm/customers/01099999999/complaints/latest").set(authed(callcenterToken));
    expect(res.status).toBe(200);
    expect(res.body).toBeNull();
  });
});
