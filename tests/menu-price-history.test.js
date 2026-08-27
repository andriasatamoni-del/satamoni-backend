// المرحلة 7O: سجل تاريخ تغيير أسعار المنيو - ضد Postgres حقيقي. بيغطي: تسجيل تغيير السعر الأساسي/سعر
// طلبات للحجم، السعر الافتراضي للمرفق، والسعر المخصوص لمرفق على حجم معيّن - وعدم تسجيل حاجة لو السعر
// معملوش عليه تغيير فعلي (نفس القيمة القديمة).
const { app, request, pool, seedUser, login, authed } = require("./helpers");

let adminToken;
let itemId, variantA, variantB, modId;

beforeAll(async () => {
  await seedUser({ name: "أدمن-تاريخ-سعر", email: "admin-pricehist@jest.test", role: "admin" });
  adminToken = await login("admin-pricehist@jest.test");

  const cat = await pool.query("INSERT INTO menu_categories (name) VALUES ('قسم-تاريخ-سعر-جست') RETURNING id");
  const item = await pool.query("INSERT INTO menu_items (category_id, name) VALUES ($1,'صنف-تاريخ-سعر-جست') RETURNING id", [cat.rows[0].id]);
  itemId = item.rows[0].id;
  const vA = await pool.query("INSERT INTO menu_item_variants (item_id, label, price) VALUES ($1,'وسط',100) RETURNING id", [itemId]);
  variantA = vA.rows[0].id;
  const vB = await pool.query("INSERT INTO menu_item_variants (item_id, label, price) VALUES ($1,'كبير',150) RETURNING id", [itemId]);
  variantB = vB.rows[0].id;
  const mod = await pool.query("INSERT INTO menu_item_modifiers (item_id, name, price_delta) VALUES ($1,'إضافة جبنة',10) RETURNING id", [itemId]);
  modId = mod.rows[0].id;
});

afterAll(async () => {
  await pool.end();
});

describe("سجل تغيير سعر الحجم", () => {
  test("تعديل السعر الأساسي بيسجل صف في السجل، وسعر طلبات كمان", async () => {
    await request(app).patch(`/api/menu/variants/${variantA}`).set(authed(adminToken)).send({ price: 120 });
    const hist1 = await request(app).get(`/api/menu/variants/${variantA}/price-history`).set(authed(adminToken));
    expect(hist1.status).toBe(200);
    expect(hist1.body.length).toBe(1);
    expect(hist1.body[0].field_name).toBe("price");
    expect(Number(hist1.body[0].old_price)).toBe(100);
    expect(Number(hist1.body[0].new_price)).toBe(120);
    expect(hist1.body[0].changed_by_name).toBe("أدمن-تاريخ-سعر");

    await request(app).patch(`/api/menu/variants/${variantA}`).set(authed(adminToken)).send({ talabatPrice: 130 });
    const hist2 = await request(app).get(`/api/menu/variants/${variantA}/price-history`).set(authed(adminToken));
    expect(hist2.body.length).toBe(2);
    expect(hist2.body[0].field_name).toBe("talabat_price"); // الأحدث أولًا
  });

  test("تعديل بنفس القيمة القديمة - مفيش صف جديد يتسجل", async () => {
    const before = await request(app).get(`/api/menu/variants/${variantB}/price-history`).set(authed(adminToken));
    await request(app).patch(`/api/menu/variants/${variantB}`).set(authed(adminToken)).send({ price: 150 }); // نفس السعر الحالي
    const after = await request(app).get(`/api/menu/variants/${variantB}/price-history`).set(authed(adminToken));
    expect(after.body.length).toBe(before.body.length);
  });
});

describe("سجل تغيير سعر المرفق (الافتراضي والمخصوص)", () => {
  test("تعديل price_delta الافتراضي للمرفق بيتسجل", async () => {
    await request(app).patch(`/api/menu/modifiers/${modId}`).set(authed(adminToken)).send({ priceDelta: 15 });
    const hist = await request(app).get(`/api/menu/modifiers/${modId}/price-history`).set(authed(adminToken));
    expect(hist.status).toBe(200);
    expect(hist.body.length).toBe(1);
    expect(Number(hist.body[0].old_price)).toBe(10);
    expect(Number(hist.body[0].new_price)).toBe(15);
  });

  test("سعر مخصوص لحجم معيّن بيتسجل منفصل عن السعر الافتراضي", async () => {
    await request(app).put(`/api/menu/modifiers/${modId}/variant-prices/${variantB}`).set(authed(adminToken)).send({ priceDelta: 20 });
    await request(app).put(`/api/menu/modifiers/${modId}/variant-prices/${variantB}`).set(authed(adminToken)).send({ priceDelta: 25 });

    const varHist = await request(app).get(`/api/menu/modifiers/${modId}/price-history`).query({ variantId: variantB }).set(authed(adminToken));
    expect(varHist.body.length).toBe(2);
    expect(Number(varHist.body[0].old_price)).toBe(20);
    expect(Number(varHist.body[0].new_price)).toBe(25);

    // السجل ده منفصل عن سجل السعر الافتراضي للمرفق نفسه
    const defaultHist = await request(app).get(`/api/menu/modifiers/${modId}/price-history`).set(authed(adminToken));
    expect(defaultHist.body.length).toBe(1);
  });
});
