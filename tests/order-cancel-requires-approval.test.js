// المرحلة 8.57: بلاغ كاشير حقيقي - قدر يلغي طلب دليفري (زر "❌ إلغاء" في POS) بمجرد تأكيد confirm()
// عادي في المتصفح، من غير أي موافقة مدير/PIN، بعت PATCH /api/orders/:id/status {status:'cancelled'}.
// ده كان مختلف تمامًا عن POST /:id/void (اللي بيطلب PIN مدير للكاشير) رغم إنهم بيوصلوا لنفس النتيجة
// الظاهرية (status='cancelled') - وأسوأ من كده، المسار القديم مكنش بيرجّع المخزون ولا يعكس القيد
// المحاسبي اللي اتسجلوا وقت إنشاء الطلب (مش وقت اكتماله)، فالإلغاء كان بيسيب المخزون/الدفاتر غلط.
//
// الإصلاح: status='cancelled' بقى مش مقبول خالص عبر PATCH /:id/status (بيرجع 400 "حالة غير معروفة")،
// وPOST /:id/void بقى المسار الوحيد للإلغاء - بيغطي دلوقتي preparing/out_for_delivery كمان (مش بس
// completed) بنفس ضمانات الموافقة والعكس الكامل اللي كانت موجودة أصلًا بس لطلب مكتمل.
const { app, request, pool, seedUser, login, authed } = require("./helpers");

let branchId;
let managerToken, adminToken, cashierToken;
let menuItemId, variantId, inventoryItemId, paymentMethodId;

beforeAll(async () => {
  const b = await pool.query("INSERT INTO branches (name) VALUES ('فرع 8.57-جست') RETURNING id");
  branchId = b.rows[0].id;
  await seedUser({ branchId, name: "مدير-8.57", email: "manager-857@jest.test", role: "branch_manager", pin: "1357" });
  managerToken = await login("manager-857@jest.test");
  await seedUser({ name: "أدمن-8.57", email: "admin-857@jest.test", role: "admin" });
  adminToken = await login("admin-857@jest.test");
  await seedUser({ branchId, name: "كاشير-8.57", email: "cashier-857@jest.test", role: "cashier" });
  cashierToken = await login("cashier-857@jest.test");

  const cat = await pool.query("INSERT INTO menu_categories (name) VALUES ('8.57-جست-قسم') RETURNING id");
  const mi = await pool.query("INSERT INTO menu_items (category_id, name) VALUES ($1,'8.57-جست-صنف') RETURNING id", [cat.rows[0].id]);
  menuItemId = mi.rows[0].id;
  const v = await pool.query("INSERT INTO menu_item_variants (item_id, label, price) VALUES ($1,'عادي',100) RETURNING id", [mi.rows[0].id]);
  variantId = v.rows[0].id;

  const ii = await pool.query(
    "INSERT INTO inventory_items (name, unit, unit_cost) VALUES ('خامة-8.57-جست', 'جرام', 2) RETURNING id"
  );
  inventoryItemId = ii.rows[0].id;
  await pool.query(
    "INSERT INTO menu_item_variant_ingredients (variant_id, inventory_item_id, quantity_per_unit) VALUES ($1,$2,10)",
    [variantId, inventoryItemId]
  );
  await pool.query(
    "INSERT INTO branch_inventory_stock (branch_id, inventory_item_id, quantity) VALUES ($1,$2,1000)",
    [branchId, inventoryItemId]
  );

  const pm = await pool.query("INSERT INTO payment_methods (name, kind) VALUES ('كاش-8.57-جست', 'cash') RETURNING id");
  paymentMethodId = pm.rows[0].id;
});

afterAll(async () => {
  await pool.end();
});

async function makeDeliveryOrder(token) {
  const res = await request(app).post("/api/orders").set(authed(token)).send({
    branchId, source: "pos", orderType: "delivery", paymentMethodId,
    customerPhone: `010${Date.now()}`.slice(0, 11), addressDetails: "عنوان 8.57",
    items: [{ itemId: menuItemId, variantId, quantity: 1 }],
  });
  expect(res.status).toBe(201);
  return res.body.orderId;
}

describe("PATCH /:id/status مبقاش بيقبل status=cancelled خالص (8.57)", () => {
  test("محاولة إلغاء عبر /status بيرجع 400 حالة غير معروفة", async () => {
    const orderId = await makeDeliveryOrder(cashierToken);
    const res = await request(app).patch(`/api/orders/${orderId}/status`).set(authed(cashierToken)).send({ status: "cancelled" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/حالة غير معروفة/);

    const check = await pool.query("SELECT status FROM orders WHERE id = $1", [orderId]);
    expect(check.rows[0].status).toBe("preparing");
  });
});

describe("إلغاء طلب لسه تحت التحضير/في الطريق بقى لازم يعدّي بـPOST /:id/void (8.57)", () => {
  test("كاشير من غير approvalToken - مرفوض 400 (محتاج موافقة مدير الفرع أو الأدمن)", async () => {
    const orderId = await makeDeliveryOrder(cashierToken);
    const res = await request(app).post(`/api/orders/${orderId}/void`).set(authed(cashierToken)).send({ reason: "عميل غيّر رأيه" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/محتاج موافقة/);

    const check = await pool.query("SELECT status, voided FROM orders WHERE id = $1", [orderId]);
    expect(check.rows[0].status).toBe("preparing");
    expect(check.rows[0].voided).toBe(false);
  });

  test("كاشير بموافقة approvalToken صحيحة (مدير الفرع، عن طريق verify-override-pin) - ينجح ويرجّع المخزون والقيد", async () => {
    const stockBefore = await pool.query(
      "SELECT quantity FROM branch_inventory_stock WHERE branch_id = $1 AND inventory_item_id = $2",
      [branchId, inventoryItemId]
    );

    const orderId = await makeDeliveryOrder(cashierToken);
    const stockAfterOrder = await pool.query(
      "SELECT quantity FROM branch_inventory_stock WHERE branch_id = $1 AND inventory_item_id = $2",
      [branchId, inventoryItemId]
    );
    // المخزون اتخصم وقت الإنشاء (10 جرام) - نفس فلسفة القيد المحاسبي اللي بيتسجل هناك كمان
    expect(Number(stockAfterOrder.rows[0].quantity)).toBe(Number(stockBefore.rows[0].quantity) - 10);

    const originalEntry = await pool.query(
      "SELECT id FROM journal_entries WHERE source_type = 'order_sale' AND source_id = $1", [orderId]
    );
    expect(originalEntry.rows.length).toBe(1);

    const res = await request(app).post(`/api/orders/${orderId}/void`).set(authed(cashierToken)).send({
      reason: "عميل غيّر رأيه", approvalToken: null,
    });
    // approvalToken null لازم يترفض برضو - نتأكد الأول من رفض approvalToken فاضي صراحة
    expect(res.status).toBe(400);

    // المسار الحقيقي: الكاشير بيطلب موافقة عن طريق verify-override-pin (PIN مدير الفرع)، ده بيرجّع
    // approval-grant توكن مربوط بالإجراء/الطلب ده بالظبط (single-use) - مش مجرد id مدير قابل لإعادة الاستخدام
    const managerRow = await pool.query("SELECT id FROM users WHERE email = $1", ["manager-857@jest.test"]);
    const pinRes = await request(app).post("/api/auth/verify-override-pin").set(authed(cashierToken)).send({
      pin: "1357", branchId, actionType: "ORDER_VOID", targetType: "order", targetId: orderId,
    });
    expect(pinRes.status).toBe(200);
    expect(pinRes.body.approverId).toBe(managerRow.rows[0].id);

    const res2 = await request(app).post(`/api/orders/${orderId}/void`).set(authed(cashierToken)).send({
      reason: "عميل غيّر رأيه", approvalToken: pinRes.body.token,
    });
    expect(res2.status).toBe(200);

    const check = await pool.query("SELECT status, voided, voided_by FROM orders WHERE id = $1", [orderId]);
    expect(check.rows[0].status).toBe("cancelled");
    expect(check.rows[0].voided).toBe(true);
    expect(check.rows[0].voided_by).toBe(managerRow.rows[0].id);

    const stockAfterVoid = await pool.query(
      "SELECT quantity FROM branch_inventory_stock WHERE branch_id = $1 AND inventory_item_id = $2",
      [branchId, inventoryItemId]
    );
    expect(Number(stockAfterVoid.rows[0].quantity)).toBe(Number(stockBefore.rows[0].quantity));

    const reversalEntry = await pool.query(
      "SELECT id FROM journal_entries WHERE source_type = 'reversal' AND source_id = $1", [originalEntry.rows[0].id]
    );
    expect(reversalEntry.rows.length).toBe(1);
  });

  test("مدير الفرع بيوافق بحسابه على طول - من غير PIN/approvalToken خالص", async () => {
    const orderId = await makeDeliveryOrder(managerToken);
    const res = await request(app).post(`/api/orders/${orderId}/void`).set(authed(managerToken)).send({ reason: "خطأ في التسجيل" });
    expect(res.status).toBe(200);
    const check = await pool.query("SELECT status, voided_by FROM orders WHERE id = $1", [orderId]);
    expect(check.rows[0].status).toBe("cancelled");
    const managerRow = await pool.query("SELECT id FROM users WHERE email = $1", ["manager-857@jest.test"]);
    expect(check.rows[0].voided_by).toBe(managerRow.rows[0].id);
  });

  test("طلب اتلغى بالفعل - محاولة إلغاء تانية ترفض 400", async () => {
    const orderId = await makeDeliveryOrder(adminToken);
    const first = await request(app).post(`/api/orders/${orderId}/void`).set(authed(adminToken)).send({ reason: "test" });
    expect(first.status).toBe(200);
    const second = await request(app).post(`/api/orders/${orderId}/void`).set(authed(adminToken)).send({ reason: "test 2" });
    expect(second.status).toBe(400);
    expect(second.body.error).toMatch(/اتلغى أو اتسترجع بالفعل/);
  });
});
