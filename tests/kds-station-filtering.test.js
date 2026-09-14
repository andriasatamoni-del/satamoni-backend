// المرحلة 9A-9: قبل كده لوحة المطبخ الرقمية (GET /api/kds/orders) كانت بترجّع كل أصناف كل الطلبات
// دايمًا، بغض النظر عن محطة التحضير - عكس التذاكر الورقية اللي كل واحدة فيها أصناف محطتها بس. هنا
// بنتأكد: فلتر stationId بيرجّع بس الأصناف/مكوّنات الكومبو الخاصة بالمحطة دي، طلب مالوش حاجة تخص
// المحطة بيتشال تمامًا، وعرض/كومبو بمكوّنات في محطات مختلفة بيتفلتر صح من غير ما يتكرر أو يضيع
const { app, request, pool, seedUser, login, authed } = require("./helpers");

let branchA;
let managerAToken, cashierAToken;
let pizzaStationId, drinksStationId, inactiveStationId;
let itemPizzaId, variantPizzaId, itemDrinkId, variantDrinkId, itemPlainId, variantPlainId, comboId;

beforeAll(async () => {
  const bA = await pool.query("INSERT INTO branches (name) VALUES ('فرع-9A9-محطات') RETURNING id");
  branchA = bA.rows[0].id;
  await seedUser({ branchId: branchA, name: "مدير-9A9-محطات", email: "managerA-9a9stations@jest.test", role: "branch_manager" });
  managerAToken = await login("managerA-9a9stations@jest.test");
  await seedUser({ branchId: branchA, name: "كاشير-9A9-محطات", email: "cashierA-9a9stations@jest.test", role: "cashier" });
  cashierAToken = await login("cashierA-9a9stations@jest.test");

  const pizzaStation = await pool.query("INSERT INTO kitchen_stations (branch_id, name) VALUES ($1,'محطة بيتزا-9A9') RETURNING id", [branchA]);
  pizzaStationId = pizzaStation.rows[0].id;
  const drinksStation = await pool.query("INSERT INTO kitchen_stations (branch_id, name) VALUES ($1,'محطة مشروبات-9A9') RETURNING id", [branchA]);
  drinksStationId = drinksStation.rows[0].id;
  const inactiveStation = await pool.query(
    "INSERT INTO kitchen_stations (branch_id, name, is_active) VALUES ($1,'محطة معطّلة-9A9', FALSE) RETURNING id", [branchA]
  );
  inactiveStationId = inactiveStation.rows[0].id;

  const cat = await pool.query("INSERT INTO menu_categories (name) VALUES ('9A9-محطات-قسم') RETURNING id");

  const piz = await pool.query(
    "INSERT INTO menu_items (category_id, name, station_id) VALUES ($1,'بيتزا-9A9',$2) RETURNING id", [cat.rows[0].id, pizzaStationId]
  );
  itemPizzaId = piz.rows[0].id;
  const pv = await pool.query("INSERT INTO menu_item_variants (item_id, label, price) VALUES ($1,'وسط',80) RETURNING id", [itemPizzaId]);
  variantPizzaId = pv.rows[0].id;

  const drink = await pool.query(
    "INSERT INTO menu_items (category_id, name, station_id) VALUES ($1,'مشروب-9A9',$2) RETURNING id", [cat.rows[0].id, drinksStationId]
  );
  itemDrinkId = drink.rows[0].id;
  const dv = await pool.query("INSERT INTO menu_item_variants (item_id, label, price) VALUES ($1,'عادي',15) RETURNING id", [itemDrinkId]);
  variantDrinkId = dv.rows[0].id;

  // صنف من غير محطة مسجّلة خالص (station_id NULL) - لازم يختفي لو فلترنا بمحطة معيّنة، ويظهر عادي
  // من غير فلتر
  const plain = await pool.query("INSERT INTO menu_items (category_id, name) VALUES ($1,'صنف-من-غير-محطة-9A9') RETURNING id", [cat.rows[0].id]);
  itemPlainId = plain.rows[0].id;
  const plv = await pool.query("INSERT INTO menu_item_variants (item_id, label, price) VALUES ($1,'عادي',20) RETURNING id", [itemPlainId]);
  variantPlainId = plv.rows[0].id;

  // عرض/كومبو فيه بيتزا (محطة بيتزا) + مشروب (محطة مشروبات) مع بعض - نفس فلسفة الطباعة بالظبط: كل
  // تذكرة محطة بتاخد مكوّنها هو بس، مش العرض ككل
  const combo = await pool.query("INSERT INTO combos (name, price) VALUES ('عرض-9A9', 90) RETURNING id");
  comboId = combo.rows[0].id;
  await pool.query("INSERT INTO combo_items (combo_id, variant_id, quantity) VALUES ($1,$2,1)", [comboId, variantPizzaId]);
  await pool.query("INSERT INTO combo_items (combo_id, variant_id, quantity) VALUES ($1,$2,2)", [comboId, variantDrinkId]);
});

afterAll(async () => {
  await pool.end();
});

async function makeOrder(items) {
  const res = await request(app).post("/api/orders").set(authed(cashierAToken)).send({
    branchId: branchA, source: "pos", orderType: "takeaway",
    customerPhone: `016${Date.now()}`.slice(0, 11),
    items,
  });
  expect(res.status).toBe(201);
  return res.body.orderId;
}

describe("GET /api/kds/stations (9A-9)", () => {
  test("بيرجّع محطات الفرع النشطة بس - المعطّلة مش موجودة", async () => {
    const res = await request(app).get(`/api/kds/stations?branchId=${branchA}`).set(authed(managerAToken));
    expect(res.status).toBe(200);
    const ids = res.body.map((s) => s.id);
    expect(ids).toContain(pizzaStationId);
    expect(ids).toContain(drinksStationId);
    expect(ids).not.toContain(inactiveStationId);
  });

  test("كاشير (معاه kitchen.view بس، مش print_routing.view) لسه يقدر يشوف قايمة المحطات", async () => {
    const res = await request(app).get(`/api/kds/stations?branchId=${branchA}`).set(authed(cashierAToken));
    expect(res.status).toBe(200);
  });
});

describe("GET /api/kds/orders?stationId= - فلترة الأصناف حسب المحطة (9A-9)", () => {
  test("صنف مباشر بمحطة معيّنة - بيظهر بس لو الفلتر نفس المحطة، ويختفي لو محطة تانية", async () => {
    const orderId = await makeOrder([{ itemId: itemPizzaId, variantId: variantPizzaId, quantity: 1 }]);

    const pizzaView = await request(app).get(`/api/kds/orders?branchId=${branchA}&stationId=${pizzaStationId}`).set(authed(managerAToken));
    expect(pizzaView.status).toBe(200);
    expect(pizzaView.body.some((o) => o.id === orderId)).toBe(true);

    const drinksView = await request(app).get(`/api/kds/orders?branchId=${branchA}&stationId=${drinksStationId}`).set(authed(managerAToken));
    expect(drinksView.body.some((o) => o.id === orderId)).toBe(false);
  });

  test("صنف من غير محطة مسجّلة - بيظهر عادي من غير فلتر، بس بيختفي لو فلترنا بمحطة معيّنة", async () => {
    const orderId = await makeOrder([{ itemId: itemPlainId, variantId: variantPlainId, quantity: 1 }]);

    const unfiltered = await request(app).get(`/api/kds/orders?branchId=${branchA}`).set(authed(managerAToken));
    expect(unfiltered.body.some((o) => o.id === orderId)).toBe(true);

    const pizzaView = await request(app).get(`/api/kds/orders?branchId=${branchA}&stationId=${pizzaStationId}`).set(authed(managerAToken));
    expect(pizzaView.body.some((o) => o.id === orderId)).toBe(false);
  });

  test("عرض/كومبو بمكوّنات محطات مختلفة - كل محطة بتشوف مكوّنها هو بس، من غير تكرار كمية ولا فقدان مكوّن", async () => {
    const orderId = await makeOrder([{ comboId, quantity: 1 }]);

    const pizzaView = await request(app).get(`/api/kds/orders?branchId=${branchA}&stationId=${pizzaStationId}`).set(authed(managerAToken));
    const pizzaOrder = pizzaView.body.find((o) => o.id === orderId);
    expect(pizzaOrder).toBeTruthy();
    expect(pizzaOrder.items.length).toBe(1);
    expect(pizzaOrder.items[0].isCombo).toBe(true);
    expect(pizzaOrder.items[0].components.length).toBe(1);
    expect(pizzaOrder.items[0].components[0].name).toBe("بيتزا-9A9");
    expect(pizzaOrder.items[0].components[0].quantity).toBe(1);

    const drinksView = await request(app).get(`/api/kds/orders?branchId=${branchA}&stationId=${drinksStationId}`).set(authed(managerAToken));
    const drinksOrder = drinksView.body.find((o) => o.id === orderId);
    expect(drinksOrder).toBeTruthy();
    expect(drinksOrder.items.length).toBe(1);
    expect(drinksOrder.items[0].components.length).toBe(1);
    expect(drinksOrder.items[0].components[0].name).toBe("مشروب-9A9");
    expect(drinksOrder.items[0].components[0].quantity).toBe(2);

    // من غير فلتر - العرض بيفضل يظهر كامل (المكوّنين مع بعض)، مش مقسوم - التأكد إن الفلترة نفسها
    // مبتأثرش على السلوك الافتراضي (regression)
    const unfiltered = await request(app).get(`/api/kds/orders?branchId=${branchA}`).set(authed(managerAToken));
    const unfilteredOrder = unfiltered.body.find((o) => o.id === orderId);
    expect(unfilteredOrder.items[0].components.length).toBe(2);
  });

  test("طلب فيه صنف عادي (محطة بيتزا) + عرض (بيتزا+مشروب) مع بعض - فلتر المشروبات بيرجّع مكوّن العرض بس، مش الصنف العادي", async () => {
    const orderId = await makeOrder([
      { itemId: itemPizzaId, variantId: variantPizzaId, quantity: 1 },
      { comboId, quantity: 1 },
    ]);

    const drinksView = await request(app).get(`/api/kds/orders?branchId=${branchA}&stationId=${drinksStationId}`).set(authed(managerAToken));
    const order = drinksView.body.find((o) => o.id === orderId);
    expect(order).toBeTruthy();
    expect(order.items.length).toBe(1);
    expect(order.items[0].isCombo).toBe(true);
    expect(order.items[0].components[0].name).toBe("مشروب-9A9");

    const pizzaView = await request(app).get(`/api/kds/orders?branchId=${branchA}&stationId=${pizzaStationId}`).set(authed(managerAToken));
    const pizzaOrder = pizzaView.body.find((o) => o.id === orderId);
    // لازم السطرين يظهروا: الصنف العادي (بيتزا مباشرة) + مكوّن البيتزا جوه العرض
    expect(pizzaOrder.items.length).toBe(2);
  });

  test("طلب مفيهوش ولا صنف واحد يخص المحطة المطلوبة - بيتشال تمامًا من الرد", async () => {
    const orderId = await makeOrder([{ itemId: itemDrinkId, variantId: variantDrinkId, quantity: 1 }]);
    const pizzaView = await request(app).get(`/api/kds/orders?branchId=${branchA}&stationId=${pizzaStationId}`).set(authed(managerAToken));
    expect(pizzaView.body.some((o) => o.id === orderId)).toBe(false);
  });
});
