// إدارة الأقسام: تعطيل قسم كامل (بيختفي من المنيو العام من غير ما يتعطّل كل صنف لوحده)، وحذف قسم/صنف
// نهائي (مسموح للفاضي/مش متباع أبدًا، ممنوع بأمان لو اتباع في أوردر حقيقي). ضد Postgres حقيقي.
const { app, request, pool, seedUser, login, authed } = require("./helpers");

let adminToken, managerToken;
let branchId, paymentMethodId;

beforeAll(async () => {
  const branch = await pool.query("INSERT INTO branches (name) VALUES ('فرع-اقسام-جست') RETURNING id");
  branchId = branch.rows[0].id;

  await seedUser({ name: "أدمن-اقسام-جست", email: "admin-catmgmt@jest.test", role: "admin" });
  await seedUser({ branchId, name: "مدير-اقسام-جست", email: "manager-catmgmt@jest.test", role: "branch_manager" });
  adminToken = await login("admin-catmgmt@jest.test");
  managerToken = await login("manager-catmgmt@jest.test");
  const pm = await pool.query("INSERT INTO payment_methods (name, kind) VALUES ('كاش-اقسام-جست','cash') RETURNING id");
  paymentMethodId = pm.rows[0].id;
});

afterAll(async () => {
  await pool.end();
});

describe("تعطيل قسم كامل", () => {
  let catId, itemId, variantId;

  beforeAll(async () => {
    const cat = await pool.query("INSERT INTO menu_categories (name) VALUES ('قسم-تعطيل-جست') RETURNING id");
    catId = cat.rows[0].id;
    const item = await pool.query("INSERT INTO menu_items (category_id, name) VALUES ($1,'صنف-تعطيل-جست') RETURNING id", [catId]);
    itemId = item.rows[0].id;
    const variant = await pool.query("INSERT INTO menu_item_variants (item_id, label, price) VALUES ($1,'عادي',50) RETURNING id", [itemId]);
    variantId = variant.rows[0].id;
  });

  test("القسم نشط افتراضيًا وأصنافه ظاهرة في GET /api/menu العام", async () => {
    const menu = await request(app).get("/api/menu");
    expect(menu.body.some((i) => i.id === itemId)).toBe(true);
  });

  test("تعطيل القسم من PATCH - بيختفي القسم وكل أصنافه من GET /api/menu وGET /api/config/full", async () => {
    const res = await request(app).patch(`/api/menu/categories/${catId}`).set(authed(adminToken)).send({ isActive: false });
    expect(res.status).toBe(200);
    expect(res.body.is_active).toBe(false);

    const menu = await request(app).get("/api/menu");
    expect(menu.body.some((i) => i.id === itemId)).toBe(false);

    const config = await request(app).get("/api/config/full");
    expect(config.body.menu.some((i) => i.id === itemId)).toBe(false);
  });

  test("القسم المعطّل لسه ظاهر في GET /api/menu/categories (شاشة الإدارة) عشان يتفعّل تاني", async () => {
    const res = await request(app).get("/api/menu/categories").set(authed(adminToken));
    expect(res.body.some((c) => c.id === catId && c.is_active === false)).toBe(true);
  });

  test("إعادة التفعيل بيرجّع القسم وأصنافه يظهروا تاني", async () => {
    await request(app).patch(`/api/menu/categories/${catId}`).set(authed(adminToken)).send({ isActive: true });
    const menu = await request(app).get("/api/menu");
    expect(menu.body.some((i) => i.id === itemId)).toBe(true);
  });
});

describe("حذف قسم", () => {
  test("مش ممكن تحذف قسم فيه أصناف - 400 برسالة واضحة", async () => {
    const cat = await pool.query("INSERT INTO menu_categories (name) VALUES ('قسم-حذف-ممنوع-جست') RETURNING id");
    await pool.query("INSERT INTO menu_items (category_id, name) VALUES ($1,'صنف-يمنع-الحذف-جست')", [cat.rows[0].id]);

    const res = await request(app).delete(`/api/menu/categories/${cat.rows[0].id}`).set(authed(adminToken));
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("صنف");

    const stillThere = await pool.query("SELECT id FROM menu_categories WHERE id=$1", [cat.rows[0].id]);
    expect(stillThere.rows.length).toBe(1);
  });

  test("حذف قسم فاضي (بدون أصناف) بينجح", async () => {
    const cat = await pool.query("INSERT INTO menu_categories (name) VALUES ('قسم-فاضي-حذف-جست') RETURNING id");
    const res = await request(app).delete(`/api/menu/categories/${cat.rows[0].id}`).set(authed(adminToken));
    expect(res.status).toBe(200);
    const gone = await pool.query("SELECT id FROM menu_categories WHERE id=$1", [cat.rows[0].id]);
    expect(gone.rows.length).toBe(0);
  });

  test("مش مسموح لغير أدمن", async () => {
    const cat = await pool.query("INSERT INTO menu_categories (name) VALUES ('قسم-صلاحية-جست') RETURNING id");
    const res = await request(app).delete(`/api/menu/categories/${cat.rows[0].id}`).set(authed(managerToken));
    expect(res.status).toBe(403);
  });
});

describe("حذف صنف", () => {
  test("حذف صنف تجريبي مش متباع أبدًا - بينجح ويشيل أحجامه معاه", async () => {
    const cat = await pool.query("INSERT INTO menu_categories (name) VALUES ('قسم-صنف-تجريبي-جست') RETURNING id");
    const item = await pool.query("INSERT INTO menu_items (category_id, name) VALUES ($1,'صنف-تجريبي-للحذف-جست') RETURNING id", [cat.rows[0].id]);
    const variant = await pool.query("INSERT INTO menu_item_variants (item_id, label, price) VALUES ($1,'عادي',30) RETURNING id", [item.rows[0].id]);

    const res = await request(app).delete(`/api/menu/items/${item.rows[0].id}`).set(authed(adminToken));
    expect(res.status).toBe(200);

    const goneItem = await pool.query("SELECT id FROM menu_items WHERE id=$1", [item.rows[0].id]);
    expect(goneItem.rows.length).toBe(0);
    const goneVariant = await pool.query("SELECT id FROM menu_item_variants WHERE id=$1", [variant.rows[0].id]);
    expect(goneVariant.rows.length).toBe(0);
  });

  test("مش ممكن تحذف صنف اتباع في أوردر حقيقي - 400 برسالة تقترح التعطيل بدل الحذف", async () => {
    const cat = await pool.query("INSERT INTO menu_categories (name) VALUES ('قسم-صنف-متباع-جست') RETURNING id");
    const item = await pool.query("INSERT INTO menu_items (category_id, name) VALUES ($1,'صنف-متباع-جست') RETURNING id", [cat.rows[0].id]);
    const variant = await pool.query("INSERT INTO menu_item_variants (item_id, label, price) VALUES ($1,'عادي',40) RETURNING id", [item.rows[0].id]);

    const order = await request(app).post("/api/orders").set(authed(managerToken)).send({
      branchId, source: "pos", orderType: "takeaway", paymentMethodId,
      items: [{ itemId: item.rows[0].id, variantId: variant.rows[0].id, quantity: 1 }],
    });
    expect(order.status).toBe(201);

    const res = await request(app).delete(`/api/menu/items/${item.rows[0].id}`).set(authed(adminToken));
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("تعطيله");

    const stillThere = await pool.query("SELECT id FROM menu_items WHERE id=$1", [item.rows[0].id]);
    expect(stillThere.rows.length).toBe(1);
  });

  test("مش مسموح لغير أدمن", async () => {
    const cat = await pool.query("INSERT INTO menu_categories (name) VALUES ('قسم-صلاحية-صنف-جست') RETURNING id");
    const item = await pool.query("INSERT INTO menu_items (category_id, name) VALUES ($1,'صنف-صلاحية-جست') RETURNING id", [cat.rows[0].id]);
    const res = await request(app).delete(`/api/menu/items/${item.rows[0].id}`).set(authed(managerToken));
    expect(res.status).toBe(403);
  });
});
