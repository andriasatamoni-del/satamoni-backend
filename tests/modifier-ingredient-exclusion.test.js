// المرحلة 8.9: مرفقات "بدون" (بدون طماطم/بدون سدق..) بقت ممكن تستبعد مكوّن فعلي من وصفة الصنف - وقت
// اختيارها في طلب، المكوّن ده بيتشال من خصم المخزون وتكلفة البيع لسطر الطلب ده بس (الوصفة الأصلية
// فضلت زي ما هي، الاستثناء وقت البيع بس). ضد Postgres حقيقي - بيغطي: التحقق من إن المكوّن المستبعد لازم
// يكون فعلًا جزء من وصفة الصنف، البيع بدون المرفق (control)، البيع بيه (استبعاد فعلي في المخزون والتكلفة
// معًا)، وتعديل الطلب (PUT) بإضافة المرفق بعد الإنشاء - بينفّذ نفس الاستبعاد.
const { app, request, pool, seedUser, login, authed } = require("./helpers");

let branchId;
let adminToken, managerToken;
let cheeseId, tomatoId; // cheese: مكوّن أساسي، tomato: المكوّن اللي هيتستبعد
let itemId, variantId;
let modWithoutTomatoId;

beforeAll(async () => {
  const b = await pool.query("INSERT INTO branches (name) VALUES ('فرع استبعاد مكوّن-جست') RETURNING id");
  branchId = b.rows[0].id;

  await seedUser({ name: "أدمن-استبعاد", email: "admin-exclude@jest.test", role: "admin" });
  await seedUser({ branchId, name: "مدير فرع-استبعاد", email: "manager-exclude@jest.test", role: "branch_manager" });
  adminToken = await login("admin-exclude@jest.test");
  managerToken = await login("manager-exclude@jest.test");

  const cheese = await pool.query("INSERT INTO inventory_items (name, unit, unit_cost) VALUES ('جبنة-استبعاد-جست', 'KG', 10) RETURNING id");
  cheeseId = cheese.rows[0].id;
  const tomato = await pool.query("INSERT INTO inventory_items (name, unit, unit_cost) VALUES ('طماطم-استبعاد-جست', 'KG', 4) RETURNING id");
  tomatoId = tomato.rows[0].id;
  await pool.query(
    "INSERT INTO branch_inventory_stock (branch_id, inventory_item_id, quantity) VALUES ($1,$2,1000),($1,$3,1000)",
    [branchId, cheeseId, tomatoId]
  );

  const cat = await pool.query("INSERT INTO menu_categories (name) VALUES ('قسم-استبعاد-جست') RETURNING id");
  const mi = await pool.query("INSERT INTO menu_items (category_id, name) VALUES ($1,'بيتزا-استبعاد-جست') RETURNING id", [cat.rows[0].id]);
  itemId = mi.rows[0].id;
  const v = await pool.query("INSERT INTO menu_item_variants (item_id, label, price) VALUES ($1,'وسط',100) RETURNING id", [itemId]);
  variantId = v.rows[0].id;

  // وصفة مباشرة (1 كيلو جبنة + 0.5 كيلو طماطم لكل وحدة) عن طريق endpoint الوصفة المسطّحة مباشرة - نفس
  // الجدول اللي محرك الوصفات (recipe-engine) بيسقط فيه بعد التفعيل بالظبط
  await request(app).put(`/api/inventory/recipe/${variantId}`).set(authed(adminToken)).send({
    ingredients: [
      { inventoryItemId: cheeseId, quantityPerUnit: 1 },
      { inventoryItemId: tomatoId, quantityPerUnit: 0.5 },
    ],
  }).expect(200);
});

afterAll(async () => {
  await pool.end();
});

describe("إعداد مرفق من نوع بدون - لازم يكون مكوّن فعلي في وصفة الصنف", () => {
  test("رفض استبعاد مكوّن مش موجود في وصفة الصنف", async () => {
    const otherItem = await pool.query("INSERT INTO inventory_items (name, unit) VALUES ('صنف تاني مش في الوصفة-جست', 'KG') RETURNING id");
    const res = await request(app).post(`/api/menu/items/${itemId}/modifiers`).set(authed(adminToken))
      .send({ name: "بدون حاجة غلط", priceDelta: 0, excludedIngredientItemId: otherItem.rows[0].id });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("INVALID_PARAMETER");
  });

  test("قبول استبعاد مكوّن فعلي (طماطم) من وصفة الصنف", async () => {
    const res = await request(app).post(`/api/menu/items/${itemId}/modifiers`).set(authed(adminToken))
      .send({ name: "بدون طماطم", priceDelta: 0, excludedIngredientItemId: tomatoId });
    expect(res.status).toBe(201);
    expect(res.body.excluded_ingredient_item_id).toBe(tomatoId);
    modWithoutTomatoId = res.body.id;
  });

  test("GET /items/:id/ingredients بيرجّع مكونات الوصفة (جبنة وطماطم)", async () => {
    const res = await request(app).get(`/api/menu/items/${itemId}/ingredients`).set(authed(adminToken));
    expect(res.status).toBe(200);
    const ids = res.body.map((i) => i.id).sort();
    expect(ids).toEqual([cheeseId, tomatoId].sort());
  });

  test("GET /items/:id/modifiers بيرجّع اسم المكوّن المستبعد", async () => {
    const res = await request(app).get(`/api/menu/items/${itemId}/modifiers`).set(authed(adminToken));
    const mod = res.body.find((m) => m.id === modWithoutTomatoId);
    expect(mod.excluded_ingredient_name).toBe("طماطم-استبعاد-جست");
  });
});

async function stockOf(inventoryItemId) {
  const r = await pool.query(
    "SELECT quantity FROM branch_inventory_stock WHERE branch_id = $1 AND inventory_item_id = $2",
    [branchId, inventoryItemId]
  );
  return Number(r.rows[0].quantity);
}

describe("البيع بدون المرفق (control) - الطماطم بتتخصم وتتحسب زي أي مكوّن عادي", () => {
  let orderId, orderItemId, cheeseBefore, tomatoBefore;

  test("بيع صنف واحد من غير أي مرفق", async () => {
    cheeseBefore = await stockOf(cheeseId);
    tomatoBefore = await stockOf(tomatoId);
    const res = await request(app).post("/api/orders").set(authed(managerToken)).send({
      branchId, source: "pos", orderType: "takeaway",
      items: [{ itemId, variantId, quantity: 1, modifiers: [] }],
    });
    expect(res.status).toBe(201);
    orderId = res.body.orderId;
    const oi = await pool.query("SELECT id, cost_at_sale FROM order_items WHERE order_id = $1", [orderId]);
    orderItemId = oi.rows[0].id;
    // التكلفة = 1×10 (جبنة) + 0.5×4 (طماطم) = 12
    expect(Number(oi.rows[0].cost_at_sale)).toBeCloseTo(12, 5);
  });

  test("المخزون اتخصم للاتنين - جبنة وطماطم", async () => {
    expect(await stockOf(cheeseId)).toBeCloseTo(cheeseBefore - 1, 5);
    expect(await stockOf(tomatoId)).toBeCloseTo(tomatoBefore - 0.5, 5);
  });

  test("order_item_ingredient_costs فيه صف للطماطم", async () => {
    const rows = await pool.query(
      "SELECT * FROM order_item_ingredient_costs WHERE order_item_id = $1 AND ingredient_item_id = $2",
      [orderItemId, tomatoId]
    );
    expect(rows.rows.length).toBe(1);
    expect(Number(rows.rows[0].total_cost)).toBeCloseTo(2, 5); // 0.5×4
  });
});

describe("البيع مع مرفق بدون طماطم - الطماطم متتخصمش ولا تتحسب خالص", () => {
  let orderId, orderItemId, cheeseBefore, tomatoBefore;

  test("بيع صنف مع مرفق بدون طماطم", async () => {
    cheeseBefore = await stockOf(cheeseId);
    tomatoBefore = await stockOf(tomatoId);
    // orderType دليفري عمدًا هنا - الطلب لازم يفضل "preparing" (مش "completed" زي تيك أواي) عشان
    // اختبار التعديل (PUT) اللي جاي تحت يقدر يشتغل عليه (endpoint التعديل بيرفض أي حالة تانية)
    const res = await request(app).post("/api/orders").set(authed(managerToken)).send({
      branchId, source: "pos", orderType: "delivery",
      items: [{ itemId, variantId, quantity: 1, modifiers: [{ id: modWithoutTomatoId }] }],
    });
    expect(res.status).toBe(201);
    orderId = res.body.orderId;
    const oi = await pool.query("SELECT id, cost_at_sale FROM order_items WHERE order_id = $1", [orderId]);
    orderItemId = oi.rows[0].id;
    // التكلفة = 1×10 (جبنة بس) - الطماطم مستبعدة خالص
    expect(Number(oi.rows[0].cost_at_sale)).toBeCloseTo(10, 5);
  });

  test("المخزون: الجبنة اتخصمت، الطماطم متأثرتش خالص", async () => {
    expect(await stockOf(cheeseId)).toBeCloseTo(cheeseBefore - 1, 5);
    expect(await stockOf(tomatoId)).toBeCloseTo(tomatoBefore, 5); // زي ما هي بالظبط
  });

  test("order_item_ingredient_costs مفيهوش أي صف للطماطم لسطر ده", async () => {
    const rows = await pool.query(
      "SELECT * FROM order_item_ingredient_costs WHERE order_item_id = $1 AND ingredient_item_id = $2",
      [orderItemId, tomatoId]
    );
    expect(rows.rows.length).toBe(0);
    const cheeseRow = await pool.query(
      "SELECT * FROM order_item_ingredient_costs WHERE order_item_id = $1 AND ingredient_item_id = $2",
      [orderItemId, cheeseId]
    );
    expect(cheeseRow.rows.length).toBe(1);
  });

  test("order_item_modifiers سجّل excluded_ingredient_item_id (snapshot) بشكل صحيح", async () => {
    const rows = await pool.query(
      "SELECT excluded_ingredient_item_id FROM order_item_modifiers WHERE order_item_id = $1",
      [orderItemId]
    );
    expect(rows.rows.length).toBe(1);
    expect(rows.rows[0].excluded_ingredient_item_id).toBe(tomatoId);
  });

  test("تعديل الطلب (PUT) بشيل المرفق - الطماطم ترجع تتحسب/تتخصم تاني (مسار التعديل بنفس منطق الإنشاء)", async () => {
    const cheeseBeforeEdit = await stockOf(cheeseId);
    const tomatoBeforeEdit = await stockOf(tomatoId);
    const res = await request(app).put(`/api/orders/${orderId}`).set(authed(managerToken)).send({
      items: [{ itemId, variantId, quantity: 1, modifiers: [] }],
    });
    expect(res.status).toBe(200);
    const oi = await pool.query("SELECT id, cost_at_sale FROM order_items WHERE order_id = $1", [orderId]);
    expect(Number(oi.rows[0].cost_at_sale)).toBeCloseTo(12, 5); // رجعت 12 (10 جبنة + 2 طماطم) بعد ما اتشال المرفق
    // خصم المخزون بيحصل من جديد بالكامل وقت التعديل (رجوع الأثر القديم + خصم الجديد، نفس سلوك أي تعديل
    // طلب موجود من قبل) - الطماطم اتخصمت دلوقتي لأول مرة فعليًا (منكنش خصمها قبل كده لأنها كانت مستبعدة)
    expect(await stockOf(tomatoId)).toBeCloseTo(tomatoBeforeEdit - 0.5, 5);
    // الجبنة: كانت اتخصمت بالفعل وقت الإنشاء - التعديل بيرجّع أثرها القديم (+1) ثم يخصمها تاني (-1)،
    // يعني صافي التغيير صفر من قيمتها قبل التعديل مباشرة
    expect(await stockOf(cheeseId)).toBeCloseTo(cheeseBeforeEdit, 5);
  });
});

describe("إلغاء ربط الاستبعاد (PATCH null) - المرفق يرجع مرفق عادي", () => {
  test("PATCH excludedIngredientItemId=null بيشيل الربط", async () => {
    const res = await request(app).patch(`/api/menu/modifiers/${modWithoutTomatoId}`).set(authed(adminToken))
      .send({ excludedIngredientItemId: null });
    expect(res.status).toBe(200);
    expect(res.body.excluded_ingredient_item_id).toBeNull();
  });

  test("بيع بنفس المرفق بعد إلغاء الربط - الطماطم بترجع تتحسب زي أي مرفق إضافة عادي", async () => {
    const tomatoBefore = await stockOf(tomatoId);
    const res = await request(app).post("/api/orders").set(authed(managerToken)).send({
      branchId, source: "pos", orderType: "takeaway",
      items: [{ itemId, variantId, quantity: 1, modifiers: [{ id: modWithoutTomatoId }] }],
    });
    expect(res.status).toBe(201);
    const oi = await pool.query("SELECT cost_at_sale FROM order_items WHERE order_id = $1", [res.body.orderId]);
    expect(Number(oi.rows[0].cost_at_sale)).toBeCloseTo(12, 5); // زي البيع العادي - مفيش استبعاد بقى
    expect(await stockOf(tomatoId)).toBeCloseTo(tomatoBefore - 0.5, 5);
  });
});
