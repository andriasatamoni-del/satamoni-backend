// المرحلة 8.6: العرض/الأوفر (combo) لازم يتحل لأصنافه الفعلية القابلة للتحضير في المطبخ/الإيصال/الطباعة
// - مش يظهر كـ"عرض #17" مبهم. الإصلاح بيعتمد على نفس الـjoin اللي المخزون/المحاسبة بيستخدموه أصلًا
// (combo_items->menu_item_variants->menu_items) في نقطتين: GET /api/orders/:id (اللي كل الطباعة بتعتمد
// عليه) وGET /api/kds/orders (لوحة المطبخ نفسها). بيغطي: العرض بيحل لأصنافه الحقيقية بالكميات الصح،
// عرض بمكونين مختلفين بكميات مختلفة، طلب فيه صنف عادي + عرض مع بعض، والقراءة المتكررة (GET مرتين)
// مبتضاعفش أي كمية - القراءة SELECT بحتة فمفيش أي تأثير على البيانات نفسها
const { app, request, pool, seedUser, login, authed } = require("./helpers");

let branchA;
let cashierAToken;
let itemPizzaId, variantPizzaId, itemFriesId, variantFriesId, comboId;

beforeAll(async () => {
  const bA = await pool.query("INSERT INTO branches (name) VALUES ('فرع-8.6-عروض-A-جست') RETURNING id");
  branchA = bA.rows[0].id;
  await seedUser({ branchId: branchA, name: "كاشير-8.6-عروض-A", email: "cashierA-86combo@jest.test", role: "cashier" });
  cashierAToken = await login("cashierA-86combo@jest.test");

  const cat = await pool.query("INSERT INTO menu_categories (name) VALUES ('8.6-عروض-جست-قسم') RETURNING id");
  const piz = await pool.query("INSERT INTO menu_items (category_id, name) VALUES ($1,'بيتزا-8.6-عروض-جست') RETURNING id", [cat.rows[0].id]);
  itemPizzaId = piz.rows[0].id;
  const pv = await pool.query("INSERT INTO menu_item_variants (item_id, label, price) VALUES ($1,'وسط',80) RETURNING id", [itemPizzaId]);
  variantPizzaId = pv.rows[0].id;

  const fries = await pool.query("INSERT INTO menu_items (category_id, name) VALUES ($1,'بطاطس-8.6-عروض-جست') RETURNING id", [cat.rows[0].id]);
  itemFriesId = fries.rows[0].id;
  const fv = await pool.query("INSERT INTO menu_item_variants (item_id, label, price) VALUES ($1,'عادي',25) RETURNING id", [itemFriesId]);
  variantFriesId = fv.rows[0].id;

  // العرض: 2 بيتزا وسط + 1 بطاطس - بسعر إجمالي مخفّض عن مجموع الأصناف منفردة (سيناريو عرض حقيقي)
  const combo = await pool.query("INSERT INTO combos (name, price) VALUES ('عرض عائلي-8.6-جست', 150) RETURNING id");
  comboId = combo.rows[0].id;
  await pool.query("INSERT INTO combo_items (combo_id, variant_id, quantity) VALUES ($1,$2,2)", [comboId, variantPizzaId]);
  await pool.query("INSERT INTO combo_items (combo_id, variant_id, quantity) VALUES ($1,$2,1)", [comboId, variantFriesId]);
});

afterAll(async () => {
  await pool.end();
});

describe("المرحلة 8.6: العرض بيتحل لأصنافه الفعلية - المطبخ ميستقبلش 'عرض #كذا' مبهم", () => {
  test("طلب فيه العرض بس - GET /:id بيرجّع combo_components بالكميات الصح", async () => {
    const res = await request(app).post("/api/orders").set(authed(cashierAToken)).send({
      branchId: branchA, source: "pos", orderType: "takeaway",
      customerPhone: `018${Date.now()}`.slice(0, 11),
      items: [{ comboId, quantity: 1 }],
    });
    expect(res.status).toBe(201);
    const detail = await request(app).get(`/api/orders/${res.body.orderId}`).set(authed(cashierAToken));
    expect(detail.status).toBe(200);
    const comboLine = detail.body.items.find((it) => it.combo_id === comboId);
    expect(comboLine).toBeTruthy();
    expect(comboLine.combo_components.length).toBe(2);
    const pizzaComponent = comboLine.combo_components.find((c) => c.name === "بيتزا-8.6-عروض-جست");
    const friesComponent = comboLine.combo_components.find((c) => c.name === "بطاطس-8.6-عروض-جست");
    expect(pizzaComponent.quantity).toBe(2);
    expect(pizzaComponent.variant).toBe("وسط");
    expect(friesComponent.quantity).toBe(1);
  });

  test("العرض ×2 (الكاشير اختار 2 من نفس العرض) - الكميات المُحلّلة بتتضاعف صح (مش أصلية بس)", async () => {
    const res = await request(app).post("/api/orders").set(authed(cashierAToken)).send({
      branchId: branchA, source: "pos", orderType: "takeaway",
      customerPhone: `017${Date.now()}`.slice(0, 11),
      items: [{ comboId, quantity: 2 }],
    });
    expect(res.status).toBe(201);
    const detail = await request(app).get(`/api/orders/${res.body.orderId}`).set(authed(cashierAToken));
    const comboLine = detail.body.items.find((it) => it.combo_id === comboId);
    const pizzaComponent = comboLine.combo_components.find((c) => c.name === "بيتزا-8.6-عروض-جست");
    expect(pizzaComponent.quantity).toBe(4); // 2 بيتزا × 2 عرض
  });

  test("سلة مختلطة (صنف عادي + عرض) - كل سطر بيتحل صح لوحده من غير تداخل", async () => {
    const res = await request(app).post("/api/orders").set(authed(cashierAToken)).send({
      branchId: branchA, source: "pos", orderType: "takeaway",
      customerPhone: `016${Date.now()}`.slice(0, 11),
      items: [
        { itemId: itemFriesId, variantId: variantFriesId, quantity: 3, modifiers: [] },
        { comboId, quantity: 1 },
      ],
    });
    expect(res.status).toBe(201);
    const detail = await request(app).get(`/api/orders/${res.body.orderId}`).set(authed(cashierAToken));
    expect(detail.body.items.length).toBe(2);
    const normalLine = detail.body.items.find((it) => it.combo_id === null);
    const comboLine = detail.body.items.find((it) => it.combo_id === comboId);
    expect(normalLine.item_name).toBe("بطاطس-8.6-عروض-جست");
    expect(normalLine.quantity).toBe(3);
    expect(normalLine.combo_components).toBeNull();
    expect(comboLine.combo_components.length).toBe(2);
  });

  test("قراءة GET /:id مرتين متتاليتين - نفس الكميات بالظبط (قراءة بحتة، مفيش تضاعف)", async () => {
    const res = await request(app).post("/api/orders").set(authed(cashierAToken)).send({
      branchId: branchA, source: "pos", orderType: "takeaway",
      customerPhone: `015${Date.now()}`.slice(0, 11),
      items: [{ comboId, quantity: 1 }],
    });
    const first = await request(app).get(`/api/orders/${res.body.orderId}`).set(authed(cashierAToken));
    const second = await request(app).get(`/api/orders/${res.body.orderId}`).set(authed(cashierAToken));
    const firstPizza = first.body.items[0].combo_components.find((c) => c.name === "بيتزا-8.6-عروض-جست");
    const secondPizza = second.body.items[0].combo_components.find((c) => c.name === "بيتزا-8.6-عروض-جست");
    expect(firstPizza.quantity).toBe(2);
    expect(secondPizza.quantity).toBe(2);
  });

  test("لوحة المطبخ (GET /api/kds/orders) بترجّع نفس أصناف العرض الفعلية (components) بالكميات الصح", async () => {
    const res = await request(app).post("/api/orders").set(authed(cashierAToken)).send({
      branchId: branchA, source: "pos", orderType: "takeaway",
      customerPhone: `014${Date.now()}`.slice(0, 11),
      items: [{ comboId, quantity: 1 }],
    });
    const board = await request(app).get(`/api/kds/orders?branchId=${branchA}`).set(authed(cashierAToken));
    expect(board.status).toBe(200);
    const card = board.body.find((o) => o.id === res.body.orderId);
    expect(card).toBeTruthy();
    const comboCartLine = card.items.find((it) => it.isCombo === true);
    expect(comboCartLine).toBeTruthy();
    expect(comboCartLine.components.length).toBe(2);
    const pizzaComponent = comboCartLine.components.find((c) => c.name === "بيتزا-8.6-عروض-جست");
    expect(pizzaComponent.quantity).toBe(2);
  });
});
