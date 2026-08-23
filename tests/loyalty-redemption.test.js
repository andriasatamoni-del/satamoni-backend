// خصم نقاط الولاء (استخدام رصيد العميل كخصم على الطلب) ضد Postgres حقيقي - بيتأكد من: الحساب الصحيح
// للقيمة بالجنيه، خصم الرصيد الصحيح من العميل، القيد المحاسبي، ورجوع النقاط لو الطلب اتلغى أو اتسترجع
const { app, request, pool, seedUser, login, authed } = require("./helpers");

let branchId;
let managerToken, adminToken;
let flourId;
let menuItemId, variantId;
let paymentMethodId;

beforeAll(async () => {
  const b1 = await pool.query("INSERT INTO branches (name) VALUES ('فرع ولاء-جست') RETURNING id");
  branchId = b1.rows[0].id;

  await seedUser({ branchId, name: "مدير فرع-ولاء", email: "manager-loyalty@jest.test", role: "branch_manager" });
  await seedUser({ name: "أدمن-ولاء", email: "admin-loyalty@jest.test", role: "admin" });
  managerToken = await login("manager-loyalty@jest.test");
  adminToken = await login("admin-loyalty@jest.test");

  const flour = await pool.query("INSERT INTO inventory_items (name, unit, unit_cost) VALUES ('دقيق-ولاء-جست', 'KG', 20) RETURNING id");
  flourId = flour.rows[0].id;
  await pool.query("INSERT INTO branch_inventory_stock (branch_id, inventory_item_id, quantity) VALUES ($1,$2,0)", [branchId, flourId]);
  await request(app).post("/api/inventory/purchase-receipt").set(authed(managerToken))
    .send({ branchId, inventoryItemId: flourId, quantity: 1000, unitCost: 20 });

  const cat = await pool.query("INSERT INTO menu_categories (name) VALUES ('بيتزا-ولاء-جست') RETURNING id");
  const mi = await pool.query("INSERT INTO menu_items (category_id, name) VALUES ($1,'مارجريتا-ولاء-جست') RETURNING id", [cat.rows[0].id]);
  menuItemId = mi.rows[0].id;
  const variant = await pool.query("INSERT INTO menu_item_variants (item_id, label, price) VALUES ($1,'وسط',1000) RETURNING id", [mi.rows[0].id]);
  variantId = variant.rows[0].id;
  await pool.query("INSERT INTO menu_item_variant_ingredients (variant_id, inventory_item_id, quantity_per_unit) VALUES ($1,$2,1)", [variantId, flourId]);

  const pm = await pool.query("INSERT INTO payment_methods (name, kind) VALUES ('كاش-ولاء-جست', 'cash') RETURNING id");
  paymentMethodId = pm.rows[0].id;

  // معدّل التجربة: نقطة واحدة لكل جنيه (يسهّل الحساب)، وقيمة النقطة عند الاستخدام 0.5 جنيه
  await pool.query("UPDATE pos_settings SET loyalty_points_per_egp = 1, loyalty_redeem_value_egp = 0.5 WHERE id = 1");
});

afterAll(async () => {
  // pos_settings صف عالمي مشترك بين كل ملفات الاختبار (قاعدة واحدة، global-setup بيصفّرها مرة واحدة بس
  // لكل تشغيل npm test كامل) - لازم نرجّعه للقيم الافتراضية اللي schema.sql بيحطها، وإلا ملفات اختبار
  // تانية (زي order-edit.test.js) هتلاقي معدّل نقاط ولاء مختلف عن اللي هي متوقّعاه وتفشل
  await pool.query("UPDATE pos_settings SET loyalty_points_per_egp = 0.1, loyalty_redeem_value_egp = 0.1 WHERE id = 1");
  await pool.end();
});

describe("خصم نقاط الولاء", () => {
  let phone, orderId;

  test("طلب أول (تيك أواي) بيكسب نقاط ولاء = الإجمالي (معدّل 1:1)", async () => {
    phone = `011${Date.now()}`.slice(0, 11);
    const res = await request(app).post("/api/orders").set(authed(managerToken)).send({
      branchId, source: "pos", orderType: "takeaway", customerPhone: phone, paymentMethodId,
      items: [{ itemId: menuItemId, variantId, quantity: 1 }],
    });
    expect(res.status).toBe(201);
    expect(res.body.total).toBe(1000);

    const cust = await pool.query("SELECT loyalty_points FROM customers WHERE phone=$1", [phone]);
    expect(cust.rows[0].loyalty_points).toBe(1000);
  });

  test("مينفعش تستخدم نقاط أكتر من رصيد العميل", async () => {
    const res = await request(app).post("/api/orders").set(authed(managerToken)).send({
      branchId, source: "pos", orderType: "takeaway", customerPhone: phone, paymentMethodId,
      loyaltyPointsRedeemed: 5000,
      items: [{ itemId: menuItemId, variantId, quantity: 1 }],
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("نقطة بس");
  });

  test("استخدام 200 نقطة كخصم = 100 جنيه (200 × 0.5) - بيتخصموا من رصيد العميل وبيترحّل قيد متزن", async () => {
    const res = await request(app).post("/api/orders").set(authed(managerToken)).send({
      branchId, source: "pos", orderType: "takeaway", customerPhone: phone, paymentMethodId,
      loyaltyPointsRedeemed: 200,
      items: [{ itemId: menuItemId, variantId, quantity: 1 }],
    });
    expect(res.status).toBe(201);
    orderId = res.body.orderId;
    // subtotal 1000 - خصم نقاط 100 = 900، وده كمان الأساس لحساب نقاط الاكتساب الجديدة (900 نقطة بمعدل 1:1)
    expect(res.body.total).toBe(900);

    const order = await pool.query("SELECT loyalty_points_redeemed, loyalty_redeem_value, loyalty_points_earned FROM orders WHERE id=$1", [orderId]);
    expect(order.rows[0].loyalty_points_redeemed).toBe(200);
    expect(Number(order.rows[0].loyalty_redeem_value)).toBe(100);
    expect(order.rows[0].loyalty_points_earned).toBe(900);

    // الرصيد: كان 1000 (من الطلب الأول)، اتخصم منه 200 المستخدمة واتضاف 900 المكتسبة من الطلب ده = 1700
    const cust = await pool.query("SELECT loyalty_points FROM customers WHERE phone=$1", [phone]);
    expect(cust.rows[0].loyalty_points).toBe(1700);

    const entry = await pool.query("SELECT id FROM journal_entries WHERE source_type='order_sale' AND source_id=$1 AND status='POSTED'", [orderId]);
    const lines = await pool.query(
      "SELECT jel.*, a.code FROM journal_entry_lines jel JOIN accounts a ON a.id=jel.account_id WHERE journal_entry_id=$1",
      [entry.rows[0].id]
    );
    const totalDebit = lines.rows.reduce((s, l) => s + Number(l.debit), 0);
    const totalCredit = lines.rows.reduce((s, l) => s + Number(l.credit), 0);
    expect(totalDebit).toBe(totalCredit);
    const discountLines = lines.rows.filter((l) => l.code === "4900");
    const redeemLine = discountLines.find((l) => Number(l.debit) === 100);
    expect(redeemLine).toBeTruthy();
  });

  test("استرجاع (Void) الطلب بيرجّع صافي أثر النقاط (المكتسبة ناقص المستخدمة) لرصيد العميل", async () => {
    // تيك أواي بيتحاسب ويكتمل فورًا (status='completed' من الإنشاء) - الاسترجاع هنا لازم يبقى Void مش
    // إلغاء عادي (PATCH /status بيرفض التعديل على طلب في حالة نهائية زي completed أصلًا)
    const before = await pool.query("SELECT loyalty_points FROM customers WHERE phone=$1", [phone]);
    const res = await request(app).post(`/api/orders/${orderId}/void`).set(authed(adminToken)).send({ reason: "اختبار استرجاع" });
    expect(res.status).toBe(200);
    const after = await pool.query("SELECT loyalty_points FROM customers WHERE phone=$1", [phone]);
    // صافي أثر الطلب ده كان +900 (مكتسبة) -200 (مستخدمة) = +700 - لازم يترجع بالظبط
    expect(Number(before.rows[0].loyalty_points) - Number(after.rows[0].loyalty_points)).toBe(700);
  });

  test("خصم نقاط الولاء محتاج رقم تليفون العميل", async () => {
    const res = await request(app).post("/api/orders").set(authed(managerToken)).send({
      branchId, source: "pos", orderType: "takeaway", paymentMethodId,
      loyaltyPointsRedeemed: 10,
      items: [{ itemId: menuItemId, variantId, quantity: 1 }],
    });
    expect(res.status).toBe(400);
  });
});
