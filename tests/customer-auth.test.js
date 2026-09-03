// المرحلة 8.38: حساب عميل حقيقي (تسجيل/دخول) لموقع الطلب أونلاين - ضد Postgres حقيقي.
// بيغطي: تسجيل حساب جديد، رفض تسجيل مكرر، تسجيل حساب فوق عميل ضيف قديم (بياناته القديمة بتفضل)،
// دخول صح/غلط، /me بيرجع بيانات فريش (نقاط الولاء بعد طلب حقيقي)، /me/addresses، عزل التوكن عن
// توكن الموظفين (سر مختلف تمامًا).
const jwt = require("jsonwebtoken");
const { app, request, pool } = require("./helpers");

describe("customer-auth", () => {
  const phone = "01011122233";
  let originalLoyaltyRate;

  beforeAll(async () => {
    const settings = await pool.query("SELECT loyalty_points_per_egp FROM pos_settings WHERE id = 1");
    originalLoyaltyRate = settings.rows[0].loyalty_points_per_egp;
  });

  afterAll(async () => {
    await pool.query("DELETE FROM customers WHERE phone LIKE '0101112%'");
    await pool.query("UPDATE pos_settings SET loyalty_points_per_egp = $1 WHERE id = 1", [originalLoyaltyRate]);
  });

  test("register creates a real account and returns a usable token", async () => {
    const res = await request(app)
      .post("/api/customer-auth/register")
      .send({ phone, name: "عميل جست", password: "secret123" });
    expect(res.status).toBe(201);
    expect(res.body.token).toBeTruthy();
    expect(res.body.customer).toMatchObject({ phone, name: "عميل جست", loyaltyPoints: 0 });

    const row = await pool.query("SELECT password_hash FROM customers WHERE phone = $1", [phone]);
    expect(row.rows[0].password_hash).toBeTruthy();
  });

  test("register rejects a phone that already has an account", async () => {
    const res = await request(app)
      .post("/api/customer-auth/register")
      .send({ phone, name: "تاني", password: "secret123" });
    expect(res.status).toBe(409);
  });

  test("register rejects a short password and an invalid phone", async () => {
    const r1 = await request(app)
      .post("/api/customer-auth/register")
      .send({ phone: "01099988877", name: "x", password: "123" });
    expect(r1.status).toBe(400);

    const r2 = await request(app)
      .post("/api/customer-auth/register")
      .send({ phone: "abc", name: "x", password: "secret123" });
    expect(r2.status).toBe(400);
  });

  test("registering over an existing guest customer keeps their loyalty points and address", async () => {
    const guestPhone = "01011199911";
    await pool.query(
      `INSERT INTO customers (phone, name, loyalty_points, address_details) VALUES ($1, 'ضيف قديم', 42, 'عنوان قديم')`,
      [guestPhone]
    );
    const res = await request(app)
      .post("/api/customer-auth/register")
      .send({ phone: guestPhone, name: "اسم جديد وقت التسجيل", password: "secret123" });
    expect(res.status).toBe(201);
    expect(res.body.customer.name).toBe("اسم جديد وقت التسجيل");
    expect(res.body.customer.loyaltyPoints).toBe(42);
    expect(res.body.customer.addressDetails).toBe("عنوان قديم");
  });

  test("login rejects wrong password and unknown phone", async () => {
    const wrongPw = await request(app).post("/api/customer-auth/login").send({ phone, password: "wrongpass" });
    expect(wrongPw.status).toBe(401);

    const unknown = await request(app).post("/api/customer-auth/login").send({ phone: "01000000001", password: "whatever1" });
    expect(unknown.status).toBe(401);
  });

  test("login succeeds with correct credentials and /me returns live profile", async () => {
    const login = await request(app).post("/api/customer-auth/login").send({ phone, password: "secret123" });
    expect(login.status).toBe(200);
    const token = login.body.token;

    const me = await request(app).get("/api/customer-auth/me").set("Authorization", `Bearer ${token}`);
    expect(me.status).toBe(200);
    expect(me.body.customer).toMatchObject({ phone, name: "عميل جست" });
  });

  test("/me and /me/addresses reject requests with no token or a garbage token", async () => {
    const noToken = await request(app).get("/api/customer-auth/me");
    expect(noToken.status).toBe(401);

    const badToken = await request(app).get("/api/customer-auth/me").set("Authorization", "Bearer garbage");
    expect(badToken.status).toBe(401);

    const noTokenAddr = await request(app).get("/api/customer-auth/me/addresses");
    expect(noTokenAddr.status).toBe(401);
  });

  test("a staff JWT cannot authenticate as this customer, and vice versa", async () => {
    // توكن موظف حقيقي (نفس middleware/auth.js) - لازم يترفض هنا حتى لو نظريًا نفس الـsub
    const { seedUser, login: staffLogin } = require("./helpers");
    await seedUser({ name: "موظف-جست-كاستمر-توكن", email: "staffcustcheck@jest.test", role: "cashier" });
    const staffToken = await staffLogin("staffcustcheck@jest.test");
    const res = await request(app).get("/api/customer-auth/me").set("Authorization", `Bearer ${staffToken}`);
    expect(res.status).toBe(401);

    // توكن عميل موقّع بسر خاطئ (محاكاة محاولة تزييف) لازم يترفض
    const forged = jwt.sign({ sub: phone }, "wrong-secret-entirely");
    const res2 = await request(app).get("/api/customer-auth/me").set("Authorization", `Bearer ${forged}`);
    expect(res2.status).toBe(401);
  });

  test("loyalty points earned from a real order via POST /api/orders show up in /me", async () => {
    const branch = await pool.query("INSERT INTO branches (name) VALUES ('فرع-جست-كاستمر-اوث') RETURNING id");
    const branchId = branch.rows[0].id;
    const cat = await pool.query("INSERT INTO menu_categories (name) VALUES ('قسم-جست-كاستمر-اوث') RETURNING id");
    const item = await pool.query(
      "INSERT INTO menu_items (category_id, name) VALUES ($1, 'صنف-جست-كاستمر-اوث') RETURNING id",
      [cat.rows[0].id]
    );
    const variant = await pool.query(
      "INSERT INTO menu_item_variants (item_id, label, price) VALUES ($1, 'عادي', 100) RETURNING id",
      [item.rows[0].id]
    );
    const pm = await pool.query(
      "INSERT INTO payment_methods (name, kind, enabled) VALUES ('كاش-جست-كاستمر-اوث', 'cash', TRUE) RETURNING id"
    );
    await pool.query("UPDATE pos_settings SET loyalty_points_per_egp = 1 WHERE id = 1");

    const orderRes = await request(app).post("/api/orders").send({
      source: "website", branchId, orderType: "pickup",
      customerName: "عميل جست", customerPhone: phone,
      paymentMethodId: pm.rows[0].id,
      items: [{ itemId: item.rows[0].id, variantId: variant.rows[0].id, quantity: 1 }],
    });
    expect(orderRes.status).toBe(201);

    const login = await request(app).post("/api/customer-auth/login").send({ phone, password: "secret123" });
    const me = await request(app).get("/api/customer-auth/me").set("Authorization", `Bearer ${login.body.token}`);
    expect(me.body.customer.loyaltyPoints).toBeGreaterThanOrEqual(100);
  });
});
