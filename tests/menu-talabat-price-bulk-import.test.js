// المرحلة 8.16: POST /api/menu/talabat-prices/import - استيراد أسعار طلبات بالجملة من واجهة المنيو
// (بديل السكريبت db/import-talabat-prices.js اللي محتاج وصول تيرمينال مباشر). ضد Postgres حقيقي.
// بيغطي: تحديث الصفوف المتطابقة، الإبلاغ عن الصفوف اللي متطابقتش، عزل الصفوف الفاشلة عن الناجحة،
// تسجيل تاريخ السعر، ومنع أي حد غير الأدمن.
const { app, request, pool, seedUser, login, authed } = require("./helpers");

let adminToken, managerToken;
let itemId, variantA, variantB;

beforeAll(async () => {
  await seedUser({ name: "أدمن-استيراد-طلبات", email: "admin-talabatimport@jest.test", role: "admin" });
  await seedUser({ name: "مدير-استيراد-طلبات", email: "manager-talabatimport@jest.test", role: "branch_manager" });
  adminToken = await login("admin-talabatimport@jest.test");
  managerToken = await login("manager-talabatimport@jest.test");

  const cat = await pool.query("INSERT INTO menu_categories (name) VALUES ('قسم-استيراد-طلبات-جست') RETURNING id");
  const item = await pool.query("INSERT INTO menu_items (category_id, name) VALUES ($1,'صنف-استيراد-طلبات-جست') RETURNING id", [cat.rows[0].id]);
  itemId = item.rows[0].id;
  const vA = await pool.query("INSERT INTO menu_item_variants (item_id, label, price) VALUES ($1,'وسط-استيراد-جست',100) RETURNING id", [itemId]);
  variantA = vA.rows[0].id;
  const vB = await pool.query("INSERT INTO menu_item_variants (item_id, label, price) VALUES ($1,'كبير-استيراد-جست',150) RETURNING id", [itemId]);
  variantB = vB.rows[0].id;
});

afterAll(async () => {
  await pool.end();
});

describe("POST /api/menu/talabat-prices/import", () => {
  test("مدير فرع (مش أدمن) - 403", async () => {
    const res = await request(app).post("/api/menu/talabat-prices/import").set(authed(managerToken)).send({
      rows: [["صنف-استيراد-طلبات-جست", "وسط-استيراد-جست", 120]],
    });
    expect(res.status).toBe(403);
  });

  test("مفيش rows خالص - 400", async () => {
    const res = await request(app).post("/api/menu/talabat-prices/import").set(authed(adminToken)).send({});
    expect(res.status).toBe(400);
  });

  test("صف متطابق بيتحدّث، صف مش موجود بيتسجل في notFound، الاتنين في نفس الطلب مش بيأثروا في بعض", async () => {
    const res = await request(app).post("/api/menu/talabat-prices/import").set(authed(adminToken)).send({
      rows: [
        ["صنف-استيراد-طلبات-جست", "وسط-استيراد-جست", 120],
        ["صنف مش موجود خالص", "حجم وهمي", 999],
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body.updatedCount).toBe(1);
    expect(res.body.notFound.length).toBe(1);
    expect(res.body.notFound[0]).toContain("صنف مش موجود خالص");

    const row = await pool.query("SELECT talabat_price FROM menu_item_variants WHERE id=$1", [variantA]);
    expect(Number(row.rows[0].talabat_price)).toBeCloseTo(120, 5);

    // تسجيل تاريخ السعر زي ما بيحصل مع PATCH /variants/:id بالظبط
    const hist = await request(app).get(`/api/menu/variants/${variantA}/price-history`).set(authed(adminToken));
    expect(hist.body.some((h) => h.field_name === "talabat_price" && Number(h.new_price) === 120)).toBe(true);
  });

  test("بيانات صف غلط (سعر مش رقم) - بيترفض هو بس، والباقي بيكمل", async () => {
    const res = await request(app).post("/api/menu/talabat-prices/import").set(authed(adminToken)).send({
      rows: [
        ["صنف-استيراد-طلبات-جست", "كبير-استيراد-جست", 180],
        ["صنف-استيراد-طلبات-جست", "وسط-استيراد-جست", "مش رقم"],
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body.updatedCount).toBe(1);
    expect(res.body.notFound.length).toBe(1);
    const row = await pool.query("SELECT talabat_price FROM menu_item_variants WHERE id=$1", [variantB]);
    expect(Number(row.rows[0].talabat_price)).toBeCloseTo(180, 5);
  });
});
