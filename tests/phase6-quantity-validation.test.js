// المرحلة 6 (6G): quantity في سطر الطلب (POST /api/orders) كان من غير أي تحقق - صفر أو رقم سالب كان
// بيعدي بهدوء ويقلب subtotal/total سالب من غير ما يعدي على تدفق الاسترجاع/الإلغاء الرسمي. دلوقتي في
// طبقتين: تحقق واضح في التطبيق (رسالة عربي، قبل أي حساب) + CHECK constraint على order_items.quantity
// نفسها في القاعدة (دفاع إضافي ضد أي إدخال مباشر مش عن طريق الـAPI)
const { app, request, pool, seedUser, login, authed } = require("./helpers");

let branchId, cashierToken, menuItemId, variantId;

beforeAll(async () => {
  const b = await pool.query("INSERT INTO branches (name) VALUES ('فرع تحقق الكمية-جست') RETURNING id");
  branchId = b.rows[0].id;
  await seedUser({ branchId, name: "كاشير-تحقق-كمية", email: "cashier-qtyval@jest.test", role: "cashier" });
  cashierToken = await login("cashier-qtyval@jest.test");

  const cat = await pool.query("INSERT INTO menu_categories (name) VALUES ('فئة-تحقق-كمية-جست') RETURNING id");
  const mi = await pool.query("INSERT INTO menu_items (category_id, name) VALUES ($1,'صنف-تحقق-كمية-جست') RETURNING id", [cat.rows[0].id]);
  menuItemId = mi.rows[0].id;
  const v = await pool.query("INSERT INTO menu_item_variants (item_id, label, price) VALUES ($1,'عادي',50) RETURNING id", [menuItemId]);
  variantId = v.rows[0].id;
});

afterAll(async () => {
  await pool.end();
});

function postOrder(quantity) {
  return request(app).post("/api/orders").set(authed(cashierToken)).send({
    branchId, source: "pos", orderType: "takeaway",
    items: [{ itemId: menuItemId, variantId, quantity }],
  });
}

describe("6G: POST /api/orders - رفض كمية غير صالحة برسالة واضحة قبل أي حساب", () => {
  test("كمية صفر - 400 مش طلب اتسجل بإجمالي صفر", async () => {
    const res = await postOrder(0);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/أكبر من صفر/);
  });

  test("كمية سالبة - 400، ومفيش أي طلب اتسجل بـsubtotal سالب", async () => {
    const before = await pool.query("SELECT COUNT(*) FROM orders WHERE branch_id = $1", [branchId]);
    const res = await postOrder(-3);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/أكبر من صفر/);
    const after = await pool.query("SELECT COUNT(*) FROM orders WHERE branch_id = $1", [branchId]);
    expect(after.rows[0].count).toBe(before.rows[0].count);
  });

  test("كمية NaN (مش رقم) - 400 برسالة واضحة", async () => {
    const res = await postOrder(NaN);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/رقم صحيح/);
  });

  test("كمية كسر (1.5) - 400", async () => {
    const res = await postOrder(1.5);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/رقم صحيح/);
  });

  test("كمية Infinity - 400", async () => {
    const res = await postOrder(Infinity);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/رقم صحيح/);
  });

  test("كمية أكبر من الحد المسموح (10000) - 400", async () => {
    const res = await postOrder(50000);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/الحد المسموح/);
  });

  test("كمية صحيحة عادية (3) - بتتقبل عادي وبتتسجل صح", async () => {
    const res = await postOrder(3);
    expect(res.status).toBe(201);
    const item = await pool.query("SELECT quantity FROM order_items WHERE order_id = $1", [res.body.orderId]);
    expect(item.rows[0].quantity).toBe(3);
  });
});

describe("6G: CHECK constraint على order_items.quantity - خط دفاع ثاني على مستوى القاعدة نفسها", () => {
  test("إدخال مباشر لقاعدة البيانات بكمية صفر/سالبة - القاعدة بترفض حتى لو التطبيق اتخطّاه", async () => {
    const orderRes = await pool.query(
      `INSERT INTO orders (branch_id, source, order_type, subtotal, total, status)
       VALUES ($1, 'pos', 'takeaway', 0, 0, 'preparing') RETURNING id`,
      [branchId]
    );
    const orderId = orderRes.rows[0].id;

    await expect(
      pool.query(
        "INSERT INTO order_items (order_id, item_id, variant_id, quantity, unit_price, line_total) VALUES ($1,$2,$3,0,50,0)",
        [orderId, menuItemId, variantId]
      )
    ).rejects.toThrow();

    await expect(
      pool.query(
        "INSERT INTO order_items (order_id, item_id, variant_id, quantity, unit_price, line_total) VALUES ($1,$2,$3,-1,50,-50)",
        [orderId, menuItemId, variantId]
      )
    ).rejects.toThrow();

    await expect(
      pool.query(
        "INSERT INTO order_items (order_id, item_id, variant_id, quantity, unit_price, line_total) VALUES ($1,$2,$3,20000,50,1000000)",
        [orderId, menuItemId, variantId]
      )
    ).rejects.toThrow();
  });
});
