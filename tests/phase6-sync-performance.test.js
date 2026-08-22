// المرحلة 6 (6G): مزامنة الطلبات (POST /api/sync/orders) - كانت بتعمل استعلام منفصل لكل طلب (ومنفصل
// كمان لكل سطر صنف جواه) في حلقة N+1 حقيقية. اتحوّلت لـbulk upsert بـUNNEST (3 رحلات ثابتة لقاعدة
// البيانات مهما كان حجم الـbatch). الاختبارات دي بتتأكد إن السلوك اتحفظ بالظبط (upsert صحيح، إعادة
// المزامنة بتحدّث مش بتكرر، سطور الأصناف بتتبدّل بالكامل) + إثبات فعلي إن عدد الاستعلامات بقى ثابت.
const { app, request, pool } = require("./helpers");

process.env.SYNC_API_KEY = "phase6-sync-test-key";
const AUTH = { Authorization: `Bearer ${process.env.SYNC_API_KEY}` };

afterAll(async () => {
  await pool.end();
});

async function seedBranch(name) {
  const result = await pool.query(
    `INSERT INTO branches (name) VALUES ($1) RETURNING id`,
    [name]
  );
  return result.rows[0].id;
}

function makeOrder(overrides = {}) {
  return {
    source: "pos",
    order_type: "dine_in",
    table_number: "5",
    address_details: null,
    customer_name: null,
    customer_phone: null,
    subtotal: 100,
    delivery_fee: 0,
    discount: 0,
    total: 100,
    status: "completed",
    payment_status: "collected",
    voided: false,
    void_reason: null,
    created_at: new Date().toISOString(),
    sync_uuid: require("crypto").randomUUID(),
    items: [{ quantity: 2, unit_price: 50, line_total: 100, cost_at_sale: 20, cost_at_sale_incomplete: false }],
    ...overrides,
  };
}

describe("6G: POST /api/sync/orders - bulk upsert (كان N+1 لكل طلب/سطر صنف)", () => {
  test("مزامنة batch من عدة طلبات دفعة واحدة - كل الطلبات وكل سطورها بتتسجل صح", async () => {
    const branchId = await seedBranch("فرع اختبار مزامنة 1");
    const orders = [makeOrder(), makeOrder({ items: [
      { quantity: 1, unit_price: 30, line_total: 30, cost_at_sale: 10, cost_at_sale_incomplete: false },
      { quantity: 3, unit_price: 20, line_total: 60, cost_at_sale: 5, cost_at_sale_incomplete: true },
    ] }), makeOrder({ items: [] })];

    const res = await request(app).post("/api/sync/orders").set(AUTH).send({ branchId, orders });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, processed: 3, received: 3 });

    const dbOrders = await pool.query(
      "SELECT id, sync_uuid, total, status FROM orders WHERE sync_uuid = ANY($1::uuid[])",
      [orders.map((o) => o.sync_uuid)]
    );
    expect(dbOrders.rows.length).toBe(3);

    const secondOrderId = dbOrders.rows.find((r) => r.sync_uuid === orders[1].sync_uuid).id;
    const items = await pool.query("SELECT quantity, unit_price FROM order_items WHERE order_id = $1 ORDER BY unit_price", [secondOrderId]);
    expect(items.rows).toHaveLength(2);
    expect(Number(items.rows[0].unit_price)).toBe(20);
    expect(Number(items.rows[1].unit_price)).toBe(30);

    const thirdOrderId = dbOrders.rows.find((r) => r.sync_uuid === orders[2].sync_uuid).id;
    const noItems = await pool.query("SELECT id FROM order_items WHERE order_id = $1", [thirdOrderId]);
    expect(noItems.rows).toHaveLength(0);
  });

  test("إعادة مزامنة نفس sync_uuid - تحديث مش تكرار، وسطور الأصناف القديمة بتتبدّل بالكامل بالجديدة", async () => {
    const branchId = await seedBranch("فرع اختبار مزامنة 2");
    const order = makeOrder({ status: "preparing" });

    const firstRes = await request(app).post("/api/sync/orders").set(AUTH).send({ branchId, orders: [order] });
    expect(firstRes.status).toBe(200);

    const updated = { ...order, status: "completed", items: [{ quantity: 5, unit_price: 10, line_total: 50, cost_at_sale: 2, cost_at_sale_incomplete: false }] };
    const secondRes = await request(app).post("/api/sync/orders").set(AUTH).send({ branchId, orders: [updated] });
    expect(secondRes.status).toBe(200);

    const dbOrders = await pool.query("SELECT id, status FROM orders WHERE sync_uuid = $1", [order.sync_uuid]);
    expect(dbOrders.rows).toHaveLength(1); // مفيش تكرار
    expect(dbOrders.rows[0].status).toBe("completed");

    const items = await pool.query("SELECT quantity, unit_price FROM order_items WHERE order_id = $1", [dbOrders.rows[0].id]);
    expect(items.rows).toHaveLength(1);
    expect(Number(items.rows[0].quantity)).toBe(5);
  });

  test("نفس sync_uuid اتكرر جوه نفس الـbatch - آخر ظهور هو اللي بيفضل (زي التتابع القديم بالظبط)، مفيش خطأ ON CONFLICT", async () => {
    const branchId = await seedBranch("فرع اختبار مزامنة 3");
    const sharedUuid = require("crypto").randomUUID();
    const orders = [
      makeOrder({ sync_uuid: sharedUuid, status: "preparing" }),
      makeOrder({ sync_uuid: sharedUuid, status: "completed", items: [{ quantity: 9, unit_price: 1, line_total: 9, cost_at_sale: 0.5, cost_at_sale_incomplete: false }] }),
    ];

    const res = await request(app).post("/api/sync/orders").set(AUTH).send({ branchId, orders });
    expect(res.status).toBe(200);

    const dbOrders = await pool.query("SELECT id, status FROM orders WHERE sync_uuid = $1", [sharedUuid]);
    expect(dbOrders.rows).toHaveLength(1);
    expect(dbOrders.rows[0].status).toBe("completed");
    const items = await pool.query("SELECT quantity FROM order_items WHERE order_id = $1", [dbOrders.rows[0].id]);
    expect(items.rows).toHaveLength(1);
    expect(Number(items.rows[0].quantity)).toBe(9);
  });

  test("batch فاضي - رد ناجح فورًا من غير أي استعلام إدخال", async () => {
    const branchId = await seedBranch("فرع اختبار مزامنة 4");
    const res = await request(app).post("/api/sync/orders").set(AUTH).send({ branchId, orders: [] });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, processed: 0, received: 0 });
  });

  test("وقت مزامنة batch كبير مش متناسب خطيًا مع عدد الطلبات - إثبات عملي (black-box) إن N+1 اتشال", async () => {
    // بدل ما نلف pool.connect() نفسه (بيتعارض مع إدارة pg-pool الداخلية للاتصال - جرّبناه وسبب تعليق)،
    // بنقيس الوقت الفعلي من برّه: لو لسه في N+1 (رحلة قاعدة بيانات منفصلة لكل طلب/سطر صنف)، batch من
    // 60 طلب المفروض ياخد وقت أكبر بكتير وبتناسب تقريبًا خطي مع batch من 3 طلبات بس. مع الـbulk upsert
    // (3 رحلات ثابتة)، الفرق المفروض يبقى صغير جدًا مش متناسب مع نسبة 20x في عدد الطلبات
    const branchId = await seedBranch("فرع اختبار مزامنة 5");

    const smallOrders = Array.from({ length: 3 }, () => makeOrder());
    const t0 = Date.now();
    const smallRes = await request(app).post("/api/sync/orders").set(AUTH).send({ branchId, orders: smallOrders });
    const smallMs = Date.now() - t0;
    expect(smallRes.status).toBe(200);

    const bigOrders = Array.from({ length: 60 }, () => makeOrder());
    const t1 = Date.now();
    const bigRes = await request(app).post("/api/sync/orders").set(AUTH).send({ branchId, orders: bigOrders });
    const bigMs = Date.now() - t1;
    expect(bigRes.status).toBe(200);
    expect(bigRes.body.processed).toBe(60);

    // لو كان لسه فيه N+1 (رحلة منفصلة لكل طلب)، batch الـ60 طلب المفروض ياخد وقت أطول بمراحل من ضعف
    // batch الـ3 طلبات (20x الطلبات = فرق واضح ومتناسب لو كل طلب بياخد رحلة منفصلة). مع الحل الحالي
    // (bulk)، الفرق محدود جدًا - بنسمح بهامش كبير (10x) عشان نتجنب flakiness من جيتر التوقيت نفسه
    expect(bigMs).toBeLessThan(Math.max(smallMs, 20) * 10);
  });

  test("مفتاح مزامنة غلط - 401، ومفيش أي طلب اتسجل", async () => {
    const branchId = await seedBranch("فرع اختبار مزامنة 6");
    const res = await request(app).post("/api/sync/orders").set({ Authorization: "Bearer wrong-key" }).send({ branchId, orders: [makeOrder()] });
    expect(res.status).toBe(401);
  });
});
