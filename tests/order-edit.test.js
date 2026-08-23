// تعديل طلب "تحت التحضير" (PUT /api/orders/:id) ضد Postgres حقيقي - بيتأكد إن التعديل بيعيد بناء
// كل أثر الطلب صح (مخزون، قيد محاسبي، نقاط ولاء) وإنه ممنوع خالص بعد ما الطلب يتحرك من حالة "تحت التحضير"
const { app, request, pool, seedUser, login, authed } = require("./helpers");

let branchId, otherBranchId;
let adminToken, managerToken, otherManagerToken, cashierToken;
let flourId;
let menuItemId, variantId;
let areaId, paymentMethodId;

beforeAll(async () => {
  const b1 = await pool.query("INSERT INTO branches (name) VALUES ('فرع تعديل-جست') RETURNING id");
  branchId = b1.rows[0].id;
  const b2 = await pool.query("INSERT INTO branches (name) VALUES ('فرع تعديل تاني-جست') RETURNING id");
  otherBranchId = b2.rows[0].id;

  await seedUser({ name: "أدمن-تعديل", email: "admin-edit@jest.test", role: "admin" });
  await seedUser({ branchId, name: "مدير فرع-تعديل", email: "manager-edit@jest.test", role: "branch_manager" });
  await seedUser({ branchId: otherBranchId, name: "مدير فرع تاني-تعديل", email: "othermanager-edit@jest.test", role: "branch_manager" });
  await seedUser({ branchId, name: "كاشير-تعديل", email: "cashier-edit@jest.test", role: "cashier" });

  adminToken = await login("admin-edit@jest.test");
  managerToken = await login("manager-edit@jest.test");
  otherManagerToken = await login("othermanager-edit@jest.test");
  cashierToken = await login("cashier-edit@jest.test");

  const flour = await pool.query("INSERT INTO inventory_items (name, unit, unit_cost) VALUES ('دقيق-تعديل-جست', 'KG', 20) RETURNING id");
  flourId = flour.rows[0].id;
  await pool.query("INSERT INTO branch_inventory_stock (branch_id, inventory_item_id, quantity) VALUES ($1,$2,0)", [branchId, flourId]);
  await request(app).post("/api/inventory/purchase-receipt").set(authed(managerToken))
    .send({ branchId, inventoryItemId: flourId, quantity: 100, unitCost: 20 });

  const cat = await pool.query("INSERT INTO menu_categories (name) VALUES ('بيتزا-تعديل-جست') RETURNING id");
  const mi = await pool.query("INSERT INTO menu_items (category_id, name) VALUES ($1,'مارجريتا-تعديل-جست') RETURNING id", [cat.rows[0].id]);
  menuItemId = mi.rows[0].id;
  const variant = await pool.query("INSERT INTO menu_item_variants (item_id, label, price) VALUES ($1,'وسط',100) RETURNING id", [mi.rows[0].id]);
  variantId = variant.rows[0].id;
  // بيتزا = 2 كيلو دقيق (تكلفة 40)
  await pool.query("INSERT INTO menu_item_variant_ingredients (variant_id, inventory_item_id, quantity_per_unit) VALUES ($1,$2,2)", [variantId, flourId]);

  const area = await pool.query("INSERT INTO delivery_areas (name, fee, branch_id) VALUES ('منطقة-تعديل-جست', 10, $1) RETURNING id", [branchId]);
  areaId = area.rows[0].id;
  const pm = await pool.query("INSERT INTO payment_methods (name, kind) VALUES ('كاش-تعديل-جست', 'cash') RETURNING id");
  paymentMethodId = pm.rows[0].id;
});

afterAll(async () => {
  await pool.end();
});

async function stock() {
  const r = await pool.query("SELECT quantity FROM branch_inventory_stock WHERE branch_id=$1 AND inventory_item_id=$2", [branchId, flourId]);
  return Number(r.rows[0].quantity);
}

describe("PUT /api/orders/:id - تعديل طلب تحت التحضير", () => {
  let orderId, originalEntryId, customerPhone;

  test("إنشاء طلب دليفري بصنف واحد", async () => {
    customerPhone = `010${Date.now()}`.slice(0, 11);
    const stockBefore = await stock();
    const res = await request(app).post("/api/orders").set(authed(managerToken)).send({
      branchId, source: "pos", orderType: "delivery", deliveryAreaId: areaId,
      addressDetails: "شارع الاختبار", customerName: "عميل تجريبي", customerPhone,
      paymentMethodId, deliveryFee: 10, items: [{ itemId: menuItemId, variantId, quantity: 1 }],
    });
    expect(res.status).toBe(201);
    orderId = res.body.orderId;
    expect(res.body.subtotal).toBe(100);
    expect(res.body.total).toBe(110);

    expect(await stock()).toBe(stockBefore - 2);

    const order = await pool.query("SELECT * FROM orders WHERE id = $1", [orderId]);
    expect(order.rows[0].status).toBe("preparing");
    expect(order.rows[0].payment_status).toBe("pending_collection");

    const entry = await pool.query("SELECT id FROM journal_entries WHERE source_type='order_sale' AND source_id=$1 AND status='POSTED'", [orderId]);
    expect(entry.rows.length).toBe(1);
    originalEntryId = entry.rows[0].id;

    const cust = await pool.query("SELECT loyalty_points FROM customers WHERE phone=$1", [customerPhone]);
    expect(cust.rows[0].loyalty_points).toBe(11); // floor(110 * 0.1)
  });

  test("مينفعش تعدّل من غير صنف واحد على الأقل", async () => {
    const res = await request(app).put(`/api/orders/${orderId}`).set(authed(managerToken)).send({
      deliveryAreaId: areaId, addressDetails: "شارع الاختبار", customerName: "عميل تجريبي", customerPhone,
      paymentMethodId, deliveryFee: 10, items: [],
    });
    expect(res.status).toBe(400);
  });

  test("مدير فرع تاني ممنوع يعدّل طلب فرع مش بتاعه", async () => {
    const res = await request(app).put(`/api/orders/${orderId}`).set(authed(otherManagerToken)).send({
      deliveryAreaId: areaId, addressDetails: "شارع الاختبار", customerName: "عميل تجريبي", customerPhone,
      paymentMethodId, deliveryFee: 10, items: [{ itemId: menuItemId, variantId, quantity: 2 }],
    });
    expect(res.status).toBe(403);
  });

  test("تعديل الكمية لـ2: بيعيد حساب الإجمالي والمخزون والقيد المحاسبي ونقاط الولاء من الصفر", async () => {
    const stockBefore = await stock(); // 98
    const res = await request(app).put(`/api/orders/${orderId}`).set(authed(managerToken)).send({
      deliveryAreaId: areaId, addressDetails: "شارع الاختبار المعدّل", customerName: "عميل تجريبي", customerPhone,
      paymentMethodId, deliveryFee: 10, items: [{ itemId: menuItemId, variantId, quantity: 2 }],
    });
    expect(res.status).toBe(200);
    expect(Number(res.body.subtotal)).toBe(200);
    expect(Number(res.body.total)).toBe(210);
    expect(res.body.address_details).toBe("شارع الاختبار المعدّل");

    // رجّع 2 كيلو (استرجاع الصنف القديم) ثم خصم 4 كيلو (الصنف الجديد) = صافي -2 كيلو عن آخر رصيد
    expect(await stock()).toBe(stockBefore - 2);

    const items = await pool.query("SELECT * FROM order_items WHERE order_id=$1", [orderId]);
    expect(items.rows.length).toBe(1);
    expect(items.rows[0].quantity).toBe(2);
    expect(Number(items.rows[0].line_total)).toBe(200);

    const original = await pool.query("SELECT status FROM journal_entries WHERE id=$1", [originalEntryId]);
    expect(original.rows[0].status).toBe("REVERSED");

    const newEntry = await pool.query(
      "SELECT * FROM journal_entries WHERE source_type='order_sale' AND source_id=$1 AND status='POSTED'", [orderId]
    );
    expect(newEntry.rows.length).toBe(1);
    const lines = await pool.query(
      "SELECT jel.*, a.code FROM journal_entry_lines jel JOIN accounts a ON a.id=jel.account_id WHERE journal_entry_id=$1",
      [newEntry.rows[0].id]
    );
    const totalDebit = lines.rows.reduce((s, l) => s + Number(l.debit), 0);
    const totalCredit = lines.rows.reduce((s, l) => s + Number(l.credit), 0);
    expect(totalDebit).toBe(totalCredit);
    const receivableLine = lines.rows.find((l) => l.code === "1300"); // تحت التحصيل (طلب دليفري)
    expect(Number(receivableLine.debit)).toBe(210);
    const cogsLine = lines.rows.find((l) => l.code === "5100");
    expect(Number(cogsLine.debit)).toBe(80); // 4 كيلو × 20ج

    const cust = await pool.query("SELECT loyalty_points FROM customers WHERE phone=$1", [customerPhone]);
    expect(cust.rows[0].loyalty_points).toBe(21); // اترجعت 11 القديمة واتضافت 21 الجديدة (floor(210*0.1))

    const log = await pool.query("SELECT notes FROM order_status_log WHERE order_id=$1 ORDER BY changed_at", [orderId]);
    expect(log.rows.some((r) => r.notes === "تعديل الطلب")).toBe(true);
  });

  test("التعديل من غير ما تبعت deliveryFee/discount بيسيبهم زي ما هم (مش بيتصفّروا بهدوء)", async () => {
    const res = await request(app).put(`/api/orders/${orderId}`).set(authed(managerToken)).send({
      deliveryAreaId: areaId, addressDetails: "شارع الاختبار المعدّل", customerName: "عميل تجريبي", customerPhone,
      paymentMethodId, items: [{ itemId: menuItemId, variantId, quantity: 1 }], // من غير deliveryFee/discount خالص
    });
    expect(res.status).toBe(200);
    expect(Number(res.body.delivery_fee)).toBe(10); // فضلت 10 (القيمة الأصلية) مش اتصفّرت لـ0
    expect(Number(res.body.subtotal)).toBe(100);
    expect(Number(res.body.total)).toBe(110);
  });

  test("مفيش تعديل بعد ما الطلب يتحرك لحالة تانية غير تحت التحضير", async () => {
    const move = await request(app).patch(`/api/orders/${orderId}/status`).set(authed(managerToken))
      .send({ status: "out_for_delivery", driverName: "طيار تجريبي" });
    expect(move.status).toBe(200);

    const res = await request(app).put(`/api/orders/${orderId}`).set(authed(managerToken)).send({
      deliveryAreaId: areaId, addressDetails: "محاولة تعديل متأخرة", customerName: "عميل تجريبي", customerPhone,
      paymentMethodId, deliveryFee: 10, items: [{ itemId: menuItemId, variantId, quantity: 1 }],
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("تحت التحضير");
  });
});
