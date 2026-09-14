// تصدير/استيراد شيت إكسيل للمنيو (تعديل جماعي للأسعار أو الريسبي) - ضد Postgres حقيقي.
// بيغطي: تصدير الشيتين، preview من غير كتابة، commit بيطبّق نفس التغييرات، الإبلاغ عن صفوف مش متطابقة
// من غير ما توقف الباقي، واستبدال الريسبي الكامل (مع عدم لمس أي حجم مش موجود أصلاً في الشيت المرفوع).
const ExcelJS = require("exceljs");
const { app, request, pool, seedUser, login, authed } = require("./helpers");

let adminToken, managerToken;
let itemId, variantA, variantB;
let ingFlour, ingCheese, ingOlive;

async function buildXlsx(headers, rows) {
  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet("شيت");
  sheet.addRow(headers);
  for (const row of rows) sheet.addRow(row);
  return wb.xlsx.writeBuffer();
}

// superagent (supertest) مش عارف يفهم content-type بتاع xlsx افتراضيًا فبيرجّع res.body فاضي - بارسر
// يدوي بسيط يجمّع البايتات الخام كـBuffer عشان ExcelJS يقدر يحمّله تاني (نفس فكرة قراءة أي binary response)
function binaryParser(res, callback) {
  res.setEncoding("binary");
  let data = "";
  res.on("data", (chunk) => { data += chunk; });
  res.on("end", () => callback(null, Buffer.from(data, "binary")));
}

beforeAll(async () => {
  await seedUser({ name: "أدمن-اكسيل-منيو-جست", email: "admin-menuexcel@jest.test", role: "admin" });
  await seedUser({ name: "مدير-اكسيل-منيو-جست", email: "manager-menuexcel@jest.test", role: "branch_manager" });
  adminToken = await login("admin-menuexcel@jest.test");
  managerToken = await login("manager-menuexcel@jest.test");

  const cat = await pool.query("INSERT INTO menu_categories (name) VALUES ('قسم-اكسيل-منيو-جست') RETURNING id");
  const item = await pool.query(
    "INSERT INTO menu_items (category_id, name) VALUES ($1,'صنف-اكسيل-منيو-جست') RETURNING id",
    [cat.rows[0].id]
  );
  itemId = item.rows[0].id;
  const vA = await pool.query(
    "INSERT INTO menu_item_variants (item_id, label, price, talabat_price) VALUES ($1,'وسط-اكسيل-جست',100,120) RETURNING id",
    [itemId]
  );
  variantA = vA.rows[0].id;
  const vB = await pool.query(
    "INSERT INTO menu_item_variants (item_id, label, price) VALUES ($1,'كبير-اكسيل-جست',150) RETURNING id",
    [itemId]
  );
  variantB = vB.rows[0].id;

  const flour = await pool.query("INSERT INTO inventory_items (name, unit, unit_cost) VALUES ('دقيق-اكسيل-جست','كيلو',5) RETURNING id");
  ingFlour = flour.rows[0].id;
  const cheese = await pool.query("INSERT INTO inventory_items (name, unit, unit_cost) VALUES ('جبنة-اكسيل-جست','كيلو',40) RETURNING id");
  ingCheese = cheese.rows[0].id;
  const olive = await pool.query("INSERT INTO inventory_items (name, unit, unit_cost) VALUES ('زيتون-اكسيل-جست','كيلو',30) RETURNING id");
  ingOlive = olive.rows[0].id;

  // وسط-اكسيل-جست الريسبي الحالي: دقيق 0.2 + جبنة 0.1
  await pool.query("INSERT INTO menu_item_variant_ingredients (variant_id, inventory_item_id, quantity_per_unit) VALUES ($1,$2,0.2)", [variantA, ingFlour]);
  await pool.query("INSERT INTO menu_item_variant_ingredients (variant_id, inventory_item_id, quantity_per_unit) VALUES ($1,$2,0.1)", [variantA, ingCheese]);
});

afterAll(async () => {
  await pool.end();
});

describe("GET /api/menu/prices/export", () => {
  test("مش مسموح لغير أدمن", async () => {
    const res = await request(app).get("/api/menu/prices/export").set(authed(managerToken));
    expect(res.status).toBe(403);
  });

  test("بيرجع شيت اكسيل فيه الأصناف الحالية", async () => {
    const res = await request(app).get("/api/menu/prices/export").set(authed(adminToken)).buffer(true).parse(binaryParser);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("spreadsheetml");
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.body);
    const sheet = wb.worksheets[0];
    const rows = [];
    sheet.eachRow((row) => rows.push(row.values.slice(1)));
    expect(rows[0]).toEqual(["القسم", "الصنف", "الحجم", "السعر العادي", "سعر طلبات"]);
    const rowA = rows.find((r) => r[2] === "وسط-اكسيل-جست");
    expect(rowA[3]).toBe(100);
    expect(rowA[4]).toBe(120);
  });
});

describe("POST /api/menu/prices/import/preview و /commit", () => {
  test("preview بيوري التغييرات من غير ما يكتب في الداتابيز", async () => {
    const buffer = await buildXlsx(
      ["القسم", "الصنف", "الحجم", "السعر العادي", "سعر طلبات"],
      [
        ["قسم-اكسيل-منيو-جست", "صنف-اكسيل-منيو-جست", "وسط-اكسيل-جست", 110, 130],
        ["قسم-اكسيل-منيو-جست", "صنف مش موجود خالص", "حجم وهمي", 200, 250],
      ]
    );
    const res = await request(app)
      .post("/api/menu/prices/import/preview").set(authed(adminToken))
      .attach("file", buffer, "prices.xlsx");
    expect(res.status).toBe(200);
    expect(res.body.changes.length).toBe(1);
    expect(res.body.changes[0]).toMatchObject({ variant: "وسط-اكسيل-جست", oldPrice: 100, newPrice: 110, oldTalabatPrice: 120, newTalabatPrice: 130 });
    expect(res.body.notFound.length).toBe(1);
    expect(res.body.notFound[0]).toContain("صنف مش موجود خالص");

    const row = await pool.query("SELECT price FROM menu_item_variants WHERE id=$1", [variantA]);
    expect(Number(row.rows[0].price)).toBeCloseTo(100, 5); // preview - لسه متغيّرش
  });

  test("commit بيطبّق نفس التغييرات، وبيسجّل تاريخ السعر", async () => {
    const buffer = await buildXlsx(
      ["القسم", "الصنف", "الحجم", "السعر العادي", "سعر طلبات"],
      [["قسم-اكسيل-منيو-جست", "صنف-اكسيل-منيو-جست", "وسط-اكسيل-جست", 110, 130]]
    );
    const res = await request(app)
      .post("/api/menu/prices/import/commit").set(authed(adminToken))
      .attach("file", buffer, "prices.xlsx");
    expect(res.status).toBe(200);
    expect(res.body.updatedCount).toBe(1);

    const row = await pool.query("SELECT price, talabat_price FROM menu_item_variants WHERE id=$1", [variantA]);
    expect(Number(row.rows[0].price)).toBeCloseTo(110, 5);
    expect(Number(row.rows[0].talabat_price)).toBeCloseTo(130, 5);

    const hist = await request(app).get(`/api/menu/variants/${variantA}/price-history`).set(authed(adminToken));
    expect(hist.body.some((h) => h.field_name === "price" && Number(h.new_price) === 110)).toBe(true);
    expect(hist.body.some((h) => h.field_name === "talabat_price" && Number(h.new_price) === 130)).toBe(true);
  });

  test("مدير فرع (مش أدمن) - 403", async () => {
    const buffer = await buildXlsx(["القسم", "الصنف", "الحجم", "السعر العادي", "سعر طلبات"], []);
    const res = await request(app)
      .post("/api/menu/prices/import/commit").set(authed(managerToken))
      .attach("file", buffer, "prices.xlsx");
    expect(res.status).toBe(403);
  });
});

describe("GET /api/menu/recipes/export", () => {
  test("بيرجع شيت فيه سطر لكل مكوّن", async () => {
    const res = await request(app).get("/api/menu/recipes/export").set(authed(adminToken)).buffer(true).parse(binaryParser);
    expect(res.status).toBe(200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.body);
    const sheet = wb.worksheets[0];
    const rows = [];
    sheet.eachRow((row) => rows.push(row.values.slice(1)));
    const flourRow = rows.find((r) => r[2] === "وسط-اكسيل-جست" && r[3] === "دقيق-اكسيل-جست");
    expect(flourRow[4]).toBeCloseTo(0.2, 5);
  });
});

describe("POST /api/menu/recipes/import/preview و /commit", () => {
  test("preview بيوري إضافة/حذف/تعديل كمية من غير كتابة", async () => {
    // الريسبي الحالي: دقيق 0.2 + جبنة 0.1. الشيت الجديد: دقيق 0.25 (اتغيّر) + زيتون 0.05 (جديد) - جبنة اتشالت
    const buffer = await buildXlsx(
      ["القسم", "الصنف", "الحجم", "المكوّن", "الكمية لكل وحدة", "الوحدة"],
      [
        ["قسم-اكسيل-منيو-جست", "صنف-اكسيل-منيو-جست", "وسط-اكسيل-جست", "دقيق-اكسيل-جست", 0.25, "كيلو"],
        ["قسم-اكسيل-منيو-جست", "صنف-اكسيل-منيو-جست", "وسط-اكسيل-جست", "زيتون-اكسيل-جست", 0.05, "كيلو"],
        ["قسم-اكسيل-منيو-جست", "صنف-اكسيل-منيو-جست", "وسط-اكسيل-جست", "مكوّن مش موجود خالص", 0.1, "كيلو"],
      ]
    );
    const res = await request(app)
      .post("/api/menu/recipes/import/preview").set(authed(adminToken))
      .attach("file", buffer, "recipes.xlsx");
    expect(res.status).toBe(200);
    expect(res.body.variantChanges.length).toBe(1);
    const change = res.body.variantChanges[0];
    expect(change.variant).toBe("وسط-اكسيل-جست");
    expect(change.added.some((a) => a.ingredient === "زيتون-اكسيل-جست")).toBe(true);
    expect(change.removed.some((r) => r.ingredient === "جبنة-اكسيل-جست")).toBe(true);
    expect(change.changed.some((c) => c.ingredient === "دقيق-اكسيل-جست" && c.newQuantityPerUnit === 0.25)).toBe(true);
    expect(res.body.notFoundIngredients.some((n) => n.includes("مكوّن مش موجود خالص"))).toBe(true);

    // preview - الريسبي الفعلي لسه متغيّرش
    const before = await pool.query("SELECT inventory_item_id FROM menu_item_variant_ingredients WHERE variant_id=$1", [variantA]);
    expect(before.rows.length).toBe(2);
  });

  test("commit بيستبدل الريسبي كامل، والحجم التاني (مش في الشيت) بيفضل من غير لمس", async () => {
    const buffer = await buildXlsx(
      ["القسم", "الصنف", "الحجم", "المكوّن", "الكمية لكل وحدة", "الوحدة"],
      [
        ["قسم-اكسيل-منيو-جست", "صنف-اكسيل-منيو-جست", "وسط-اكسيل-جست", "دقيق-اكسيل-جست", 0.25, "كيلو"],
        ["قسم-اكسيل-منيو-جست", "صنف-اكسيل-منيو-جست", "وسط-اكسيل-جست", "زيتون-اكسيل-جست", 0.05, "كيلو"],
      ]
    );
    const res = await request(app)
      .post("/api/menu/recipes/import/commit").set(authed(adminToken))
      .attach("file", buffer, "recipes.xlsx");
    expect(res.status).toBe(200);
    expect(res.body.updatedVariantsCount).toBe(1);

    const after = await pool.query(
      `SELECT ii.name, mvi.quantity_per_unit FROM menu_item_variant_ingredients mvi
       JOIN inventory_items ii ON ii.id = mvi.inventory_item_id WHERE mvi.variant_id=$1 ORDER BY ii.name`,
      [variantA]
    );
    expect(after.rows.length).toBe(2);
    expect(after.rows.some((r) => r.name === "جبنة-اكسيل-جست")).toBe(false); // اتشالت
    const flourRow = after.rows.find((r) => r.name === "دقيق-اكسيل-جست");
    expect(Number(flourRow.quantity_per_unit)).toBeCloseTo(0.25, 5);

    // الحجم التاني (كبير-اكسيل-جست) مالوش أي ريسبي أصلاً ومش موجود في الشيت - يفضل من غير ريسبي (مش خطأ)
    const variantBRecipe = await pool.query("SELECT * FROM menu_item_variant_ingredients WHERE variant_id=$1", [variantB]);
    expect(variantBRecipe.rows.length).toBe(0);
  });

  test("مدير فرع (مش أدمن) - 403", async () => {
    const buffer = await buildXlsx(["القسم", "الصنف", "الحجم", "المكوّن", "الكمية لكل وحدة", "الوحدة"], []);
    const res = await request(app)
      .post("/api/menu/recipes/import/commit").set(authed(managerToken))
      .attach("file", buffer, "recipes.xlsx");
    expect(res.status).toBe(403);
  });
});
