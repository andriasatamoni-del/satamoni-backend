// المرحلة 8.10: توضيح من صاحب المشروع بعد المرحلة 8.9 - وقت الطلب، أي صنف لازم يقدر ياخد (1) ملاحظة حرة
// على سطر الطلب (عجينة رفيعة، مستوى تحمير زيادة...) للمطبخ/الإيصال بس، و(2) "بدون <مكوّن>" بيتولّد
// تلقائيًا من مكوّنات وصفة الصنف نفسها وقت الطلب (مش مرفق مسمّى الأدمن يجهّزه مقدّمًا زي المرحلة 8.9) -
// الكاشير بيختار أي مكوّن من الريسبي مباشرة يستبعده لسطر الطلب ده بس، بدون تأثير على السعر. ضد Postgres
// حقيقي - بيغطي: تسجيل الملاحظة، رفض استبعاد مكوّن مش في الوصفة، الاستبعاد الفعلي في المخزون/التكلفة،
// إن آلية 8.9 وآلية 8.10 بيتفحصوا سوا (استبعاد من الاتنين مع بعض)، تعديل الطلب (PUT) بإضافة استبعاد
// جديد بعد الإنشاء (نفس الباج اللي كان في مسار الإدارة للمرفقات، اتصلح هنا كمان للجدول الجديد)، وGET /:id
// بيرجّع أسماء المكونات المستبعدة.
const { app, request, pool, seedUser, login, authed } = require("./helpers");

let branchId;
let adminToken, managerToken;
let cheeseId, tomatoId, oliveId;
let itemId, variantId;
let modWithoutTomatoId;

beforeAll(async () => {
  const b = await pool.query("INSERT INTO branches (name) VALUES ('فرع ملاحظة-استبعاد-جست') RETURNING id");
  branchId = b.rows[0].id;

  await seedUser({ name: "أدمن-ملاحظة", email: "admin-notes@jest.test", role: "admin" });
  await seedUser({ branchId, name: "مدير فرع-ملاحظة", email: "manager-notes@jest.test", role: "branch_manager" });
  adminToken = await login("admin-notes@jest.test");
  managerToken = await login("manager-notes@jest.test");

  const cheese = await pool.query("INSERT INTO inventory_items (name, unit, unit_cost) VALUES ('جبنة-ملاحظة-جست', 'KG', 10) RETURNING id");
  cheeseId = cheese.rows[0].id;
  const tomato = await pool.query("INSERT INTO inventory_items (name, unit, unit_cost) VALUES ('طماطم-ملاحظة-جست', 'KG', 4) RETURNING id");
  tomatoId = tomato.rows[0].id;
  const olive = await pool.query("INSERT INTO inventory_items (name, unit, unit_cost) VALUES ('زيتون-ملاحظة-جست', 'KG', 6) RETURNING id");
  oliveId = olive.rows[0].id;
  await pool.query(
    "INSERT INTO branch_inventory_stock (branch_id, inventory_item_id, quantity) VALUES ($1,$2,1000),($1,$3,1000),($1,$4,1000)",
    [branchId, cheeseId, tomatoId, oliveId]
  );

  const cat = await pool.query("INSERT INTO menu_categories (name) VALUES ('قسم-ملاحظة-جست') RETURNING id");
  const mi = await pool.query("INSERT INTO menu_items (category_id, name) VALUES ($1,'بيتزا-ملاحظة-جست') RETURNING id", [cat.rows[0].id]);
  itemId = mi.rows[0].id;
  const v = await pool.query("INSERT INTO menu_item_variants (item_id, label, price) VALUES ($1,'وسط',100) RETURNING id", [itemId]);
  variantId = v.rows[0].id;

  // وصفة (1 جبنة + 0.5 طماطم + 0.2 زيتون لكل وحدة)
  await request(app).put(`/api/inventory/recipe/${variantId}`).set(authed(adminToken)).send({
    ingredients: [
      { inventoryItemId: cheeseId, quantityPerUnit: 1 },
      { inventoryItemId: tomatoId, quantityPerUnit: 0.5 },
      { inventoryItemId: oliveId, quantityPerUnit: 0.2 },
    ],
  }).expect(200);

  // مرفق "بدون طماطم" (آلية 8.9) - عشان اختبار إن الاتنين بيتفحصوا سوا
  const modRes = await request(app).post(`/api/menu/items/${itemId}/modifiers`).set(authed(adminToken))
    .send({ name: "بدون طماطم-ملاحظة-جست", priceDelta: 0, excludedIngredientItemId: tomatoId });
  expect(modRes.status).toBe(201);
  modWithoutTomatoId = modRes.body.id;
});

afterAll(async () => {
  await pool.end();
});

async function stockOf(inventoryItemId) {
  const r = await pool.query(
    "SELECT quantity FROM branch_inventory_stock WHERE branch_id = $1 AND inventory_item_id = $2",
    [branchId, inventoryItemId]
  );
  return Number(r.rows[0].quantity);
}

describe("GET /api/inventory/recipe/:variantId بيرجّع مكونات الوصفة عشان الفرونت يبني اختيارات بدون", () => {
  test("بيرجّع التلات مكونات", async () => {
    const res = await request(app).get(`/api/inventory/recipe/${variantId}`).set(authed(managerToken));
    expect(res.status).toBe(200);
    const ids = res.body.map((r) => r.inventory_item_id).sort();
    expect(ids).toEqual([cheeseId, tomatoId, oliveId].sort());
  });
});

describe("رفض استبعاد مكوّن مش جزء من وصفة الصنف", () => {
  test("POST /api/orders برفض excludedIngredientItemIds فيها ID مش في الوصفة", async () => {
    const otherItem = await pool.query("INSERT INTO inventory_items (name, unit) VALUES ('صنف تاني مش في الوصفة-ملاحظة-جست', 'KG') RETURNING id");
    const res = await request(app).post("/api/orders").set(authed(managerToken)).send({
      branchId, source: "pos", orderType: "takeaway",
      items: [{ itemId, variantId, quantity: 1, excludedIngredientItemIds: [otherItem.rows[0].id] }],
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("مش جزء من وصفة الصنف");
  });
});

describe("ملاحظة حرة على السطر - عرض بس، مفيش أي تأثير على المخزون/التكلفة", () => {
  let orderId, cheeseBefore, tomatoBefore, oliveBefore;

  test("بيع صنف مع ملاحظة حرة", async () => {
    cheeseBefore = await stockOf(cheeseId);
    tomatoBefore = await stockOf(tomatoId);
    oliveBefore = await stockOf(oliveId);
    const res = await request(app).post("/api/orders").set(authed(managerToken)).send({
      branchId, source: "pos", orderType: "takeaway",
      items: [{ itemId, variantId, quantity: 1, notes: "  عجينة رفيعة  " }],
    });
    expect(res.status).toBe(201);
    orderId = res.body.orderId;
    const oi = await pool.query("SELECT notes, cost_at_sale FROM order_items WHERE order_id = $1", [orderId]);
    // الملاحظة اتقصّت من المسافات الفاضية
    expect(oi.rows[0].notes).toBe("عجينة رفيعة");
    // التكلفة كاملة زي أي بيع عادي - الملاحظة مالهاش تأثير
    expect(Number(oi.rows[0].cost_at_sale)).toBeCloseTo(10 + 2 + 1.2, 5);
  });

  test("المخزون اتخصم عادي للتلات مكونات - الملاحظة ملهاش أي تأثير", async () => {
    expect(await stockOf(cheeseId)).toBeCloseTo(cheeseBefore - 1, 5);
    expect(await stockOf(tomatoId)).toBeCloseTo(tomatoBefore - 0.5, 5);
    expect(await stockOf(oliveId)).toBeCloseTo(oliveBefore - 0.2, 5);
  });

  test("GET /api/orders/:id بيرجّع الملاحظة", async () => {
    const res = await request(app).get(`/api/orders/${orderId}`).set(authed(managerToken));
    expect(res.status).toBe(200);
    expect(res.body.items[0].notes).toBe("عجينة رفيعة");
  });

  test("ملاحظة أطول من 500 حرف بتتقصّ كشبكة أمان", async () => {
    const longNote = "أ".repeat(600);
    const res = await request(app).post("/api/orders").set(authed(managerToken)).send({
      branchId, source: "pos", orderType: "takeaway",
      items: [{ itemId, variantId, quantity: 1, notes: longNote }],
    });
    expect(res.status).toBe(201);
    const oi = await pool.query("SELECT notes FROM order_items WHERE order_id = $1", [res.body.orderId]);
    expect(oi.rows[0].notes.length).toBe(500);
  });
});

describe("استبعاد مباشر ديناميكي (بدون زيتون) - بيتشال من المخزون والتكلفة لسطر الطلب ده بس", () => {
  let orderId, orderItemId, cheeseBefore, tomatoBefore, oliveBefore;

  test("بيع صنف مع استبعاد الزيتون مباشرة (مش عن طريق مرفق مسمّى)", async () => {
    cheeseBefore = await stockOf(cheeseId);
    tomatoBefore = await stockOf(tomatoId);
    oliveBefore = await stockOf(oliveId);
    const res = await request(app).post("/api/orders").set(authed(managerToken)).send({
      branchId, source: "pos", orderType: "delivery",
      items: [{ itemId, variantId, quantity: 1, excludedIngredientItemIds: [oliveId] }],
    });
    expect(res.status).toBe(201);
    orderId = res.body.orderId;
    const oi = await pool.query("SELECT id, cost_at_sale FROM order_items WHERE order_id = $1", [orderId]);
    orderItemId = oi.rows[0].id;
    // التكلفة = 1×10 (جبنة) + 0.5×4 (طماطم) - الزيتون مستبعد
    expect(Number(oi.rows[0].cost_at_sale)).toBeCloseTo(12, 5);
  });

  test("المخزون: الجبنة والطماطم اتخصموا، الزيتون متأثرش خالص", async () => {
    expect(await stockOf(cheeseId)).toBeCloseTo(cheeseBefore - 1, 5);
    expect(await stockOf(tomatoId)).toBeCloseTo(tomatoBefore - 0.5, 5);
    expect(await stockOf(oliveId)).toBeCloseTo(oliveBefore, 5);
  });

  test("order_item_ingredient_costs مفيهوش صف للزيتون، وفيه صف للطماطم والجبنة", async () => {
    const olive = await pool.query(
      "SELECT * FROM order_item_ingredient_costs WHERE order_item_id = $1 AND ingredient_item_id = $2",
      [orderItemId, oliveId]
    );
    expect(olive.rows.length).toBe(0);
    const tomato = await pool.query(
      "SELECT * FROM order_item_ingredient_costs WHERE order_item_id = $1 AND ingredient_item_id = $2",
      [orderItemId, tomatoId]
    );
    expect(tomato.rows.length).toBe(1);
  });

  test("order_item_excluded_ingredients فيه صف الزيتون", async () => {
    const rows = await pool.query(
      "SELECT inventory_item_id FROM order_item_excluded_ingredients WHERE order_item_id = $1", [orderItemId]
    );
    expect(rows.rows.map((r) => r.inventory_item_id)).toEqual([oliveId]);
  });

  test("GET /api/orders/:id بيرجّع اسم المكوّن المستبعد (زيتون)", async () => {
    const res = await request(app).get(`/api/orders/${orderId}`).set(authed(managerToken));
    const excluded = res.body.items[0].excludedIngredients;
    expect(excluded.length).toBe(1);
    expect(excluded[0]).toEqual({ inventoryItemId: oliveId, name: "زيتون-ملاحظة-جست" });
  });
});

describe("الاتنين مع بعض - مرفق بدون طماطم (8.9) + استبعاد مباشر بدون زيتون (8.10) في نفس السطر", () => {
  let orderId, cheeseBefore, tomatoBefore, oliveBefore;

  test("بيع صنف بمرفق بدون طماطم + استبعاد مباشر للزيتون + ملاحظة", async () => {
    cheeseBefore = await stockOf(cheeseId);
    tomatoBefore = await stockOf(tomatoId);
    oliveBefore = await stockOf(oliveId);
    const res = await request(app).post("/api/orders").set(authed(managerToken)).send({
      branchId, source: "pos", orderType: "takeaway",
      items: [{
        itemId, variantId, quantity: 1,
        modifiers: [{ id: modWithoutTomatoId }],
        excludedIngredientItemIds: [oliveId],
        notes: "تحمير زيادة",
      }],
    });
    expect(res.status).toBe(201);
    orderId = res.body.orderId;
    const oi = await pool.query("SELECT notes, cost_at_sale FROM order_items WHERE order_id = $1", [orderId]);
    // التكلفة = 1×10 (جبنة بس) - الطماطم والزيتون مستبعدين مع بعض
    expect(Number(oi.rows[0].cost_at_sale)).toBeCloseTo(10, 5);
    expect(oi.rows[0].notes).toBe("تحمير زيادة");
  });

  test("المخزون: الجبنة بس اتخصمت", async () => {
    expect(await stockOf(cheeseId)).toBeCloseTo(cheeseBefore - 1, 5);
    expect(await stockOf(tomatoId)).toBeCloseTo(tomatoBefore, 5);
    expect(await stockOf(oliveId)).toBeCloseTo(oliveBefore, 5);
  });
});

describe("تعديل الطلب (PUT) بإضافة استبعاد جديد بعد الإنشاء - لازم يتخصم صح (باج مشابه لباج المرفقات اتصلح)", () => {
  let orderId, cheeseBeforeCreate, tomatoBeforeCreate, oliveBeforeCreate;

  test("إنشاء طلب من غير أي استبعاد", async () => {
    cheeseBeforeCreate = await stockOf(cheeseId);
    tomatoBeforeCreate = await stockOf(tomatoId);
    oliveBeforeCreate = await stockOf(oliveId);
    const res = await request(app).post("/api/orders").set(authed(managerToken)).send({
      branchId, source: "pos", orderType: "delivery",
      items: [{ itemId, variantId, quantity: 1 }],
    });
    expect(res.status).toBe(201);
    orderId = res.body.orderId;
    expect(await stockOf(oliveId)).toBeCloseTo(oliveBeforeCreate - 0.2, 5);
  });

  test("تعديل الطلب بإضافة استبعاد الزيتون - المخزون يرجع للزيتون ويفضل مخصوم منه صفر (اتشال من الوصفة)", async () => {
    const res = await request(app).put(`/api/orders/${orderId}`).set(authed(managerToken)).send({
      items: [{ itemId, variantId, quantity: 1, excludedIngredientItemIds: [oliveId] }],
    });
    expect(res.status).toBe(200);
    const oi = await pool.query("SELECT id, cost_at_sale FROM order_items WHERE order_id = $1", [orderId]);
    // التكلفة بقت 10 + 2 (جبنة+طماطم) - الزيتون اتشال من الحساب
    expect(Number(oi.rows[0].cost_at_sale)).toBeCloseTo(12, 5);
    // المخزون: الزيتون رجع لقيمته الأصلية قبل الإنشاء (اترجع أثر الخصم الأول، والتعديل مبيخصمهوش تاني لأنه مستبعد دلوقتي)
    expect(await stockOf(oliveId)).toBeCloseTo(oliveBeforeCreate, 5);
    // الجبنة والطماطم: كانوا متخصومين من الإنشاء، اترجعوا وقت التعديل وخصموا تاني - صافي التغيير صفر من قبل التعديل
    expect(await stockOf(cheeseId)).toBeCloseTo(cheeseBeforeCreate - 1, 5);
    expect(await stockOf(tomatoId)).toBeCloseTo(tomatoBeforeCreate - 0.5, 5);
    const excl = await pool.query(
      "SELECT inventory_item_id FROM order_item_excluded_ingredients WHERE order_item_id = $1", [oi.rows[0].id]
    );
    expect(excl.rows.map((r) => r.inventory_item_id)).toEqual([oliveId]);
  });
});

describe("الكومبو ملوش استبعادات ولا ملاحظة أبدًا (مفيش ريسبي مباشر للعرض نفسه)", () => {
  test("عنصر combo في الطلب بيتجاهل أي excludedIngredientItemIds/notes مبعوتة بالغلط", async () => {
    const combo = await pool.query(
      "INSERT INTO combos (name, price, is_active) VALUES ('عرض-ملاحظة-جست', 50, TRUE) RETURNING id"
    );
    const res = await request(app).post("/api/orders").set(authed(managerToken)).send({
      branchId, source: "pos", orderType: "takeaway",
      items: [{ comboId: combo.rows[0].id, quantity: 1, excludedIngredientItemIds: [oliveId], notes: "ملحوظة غلط" }],
    });
    expect(res.status).toBe(201);
    const oi = await pool.query("SELECT notes FROM order_items WHERE order_id = $1", [res.body.orderId]);
    expect(oi.rows[0].notes).toBeNull();
    const excl = await pool.query(
      "SELECT * FROM order_item_excluded_ingredients WHERE order_item_id = $1", [oi.rows[0].id]
    );
    expect(excl.rows.length).toBe(0);
  });
});
