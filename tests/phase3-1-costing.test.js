// المرحلة 3.1: تحصين التكلفة/التقارير - ضد Postgres حقيقي (مش mocks). بيغطي:
// (1) تكلفة تاريخية حقيقية - تقرير قديم لازم يفضل زي ما هو حتى لو سعر المكوّن اتغيّر بعد كده،
// (2) فصل فئات الاستهلاك (بيع/تصنيع/هالك/تسوية) - مش أرقام مخلوطة في بعض،
// (3) سيناريو "محرم بك" العددي (750/300/300/15/5/320/20)،
// (4) مصدر الحقيقة الوحيد - الجدول المسطّح لازم يطابق فك الوصفة النشطة تمامًا، مفيش اختلاف صامت،
// (5) عدم تأثر تقرير تاريخي بأي عملية لاحقة (شراء بسعر جديد، تسوية، تصنيع، هالك، تحويل، استرجاع).
const { app, request, pool, seedUser, login, authed } = require("./helpers");

let branchId, otherBranchId;
let adminToken, managerToken;
let cheeseId, flourId; // cheese: مش متتبّع بدفعات (سيناريو التكلفة النظرية البسيط) - flour: هنستخدمه لسيناريو الدفعات
let menuItemId, variantId, recipeVersionV1Id;

beforeAll(async () => {
  const b1 = await pool.query("INSERT INTO branches (name) VALUES ('فرع تكلفة-جست') RETURNING id");
  branchId = b1.rows[0].id;
  const b2 = await pool.query("INSERT INTO branches (name) VALUES ('فرع تاني تكلفة-جست') RETURNING id");
  otherBranchId = b2.rows[0].id;

  await seedUser({ name: "أدمن-تكلفة", email: "admin-cost@jest.test", role: "admin" });
  await seedUser({ branchId, name: "مدير فرع-تكلفة", email: "manager-cost@jest.test", role: "branch_manager" });
  adminToken = await login("admin-cost@jest.test");
  managerToken = await login("manager-cost@jest.test");

  // جبنة: unit_cost=10 وقت أول بيع، هيتغيّر لـ26 بعد كده (زي مثال يناير/أغسطس بتاع الموتزريلا في الطلب)
  const cheese = await pool.query("INSERT INTO inventory_items (name, unit, unit_cost) VALUES ('جبنة-تكلفة-جست', 'KG', 10) RETURNING id");
  cheeseId = cheese.rows[0].id;
  const flour = await pool.query("INSERT INTO inventory_items (name, unit, unit_cost) VALUES ('دقيق-تكلفة-جست', 'KG', 5) RETURNING id");
  flourId = flour.rows[0].id;
  await pool.query(
    "INSERT INTO branch_inventory_stock (branch_id, inventory_item_id, quantity) VALUES ($1,$2,0),($1,$3,0)",
    [branchId, cheeseId, flourId]
  );
  await pool.query("INSERT INTO branch_inventory_stock (branch_id, inventory_item_id, quantity) VALUES ($1,$2,0)", [otherBranchId, cheeseId]);

  const cat = await pool.query("INSERT INTO menu_categories (name) VALUES ('صنف-تكلفة-جست') RETURNING id");
  const mi = await pool.query("INSERT INTO menu_items (category_id, name) VALUES ($1,'صنف تكلفة-جست') RETURNING id", [cat.rows[0].id]);
  menuItemId = mi.rows[0].id;
  const variant = await pool.query("INSERT INTO menu_item_variants (item_id, label, price) VALUES ($1,'عادي',25) RETURNING id", [mi.rows[0].id]);
  variantId = variant.rows[0].id;

  // وصفة V1: 1 كيلو جبنة بالظبط لكل وحدة مباعة (بدون هالك/فقد) - عشان الأرقام تبقى صحيحة تمامًا
  const recipeRes = await request(app).post("/api/recipes").set(authed(adminToken))
    .send({ recipeType: "sellable_variant", variantId, ingredients: [{ ingredientItemId: cheeseId, quantity: 1 }] });
  recipeVersionV1Id = recipeRes.body.version.id;
  await request(app).post(`/api/recipes/versions/${recipeVersionV1Id}/submit`).set(authed(managerToken)).expect(200);
  await request(app).post(`/api/recipes/versions/${recipeVersionV1Id}/approve`).set(authed(adminToken)).expect(200);
  await request(app).post(`/api/recipes/versions/${recipeVersionV1Id}/activate`).set(authed(adminToken)).expect(200);

  await request(app).post("/api/inventory/purchase-receipt").set(authed(managerToken))
    .send({ branchId, inventoryItemId: cheeseId, quantity: 500, unitCost: 10 });
});

afterAll(async () => {
  await pool.end();
});

async function sell(quantity) {
  const res = await request(app).post("/api/orders").set(authed(managerToken))
    .send({ branchId, source: "pos", orderType: "takeaway", items: [{ itemId: menuItemId, variantId, quantity } ] });
  expect(res.status).toBe(201);
  return res.body.orderId;
}

describe("1) التكلفة التاريخية - لازم تفضل زي ما هي حتى لو سعر المكوّن اتغيّر بعد كده", () => {
  let orderId, orderItemId;

  test("بيع بسعر 10ج/كيلو - cost_at_sale وorder_item_ingredient_costs متجمّدين بالسعر ده", async () => {
    orderId = await sell(2); // 2 كيلو جبنة × 10 = 20ج
    const oi = await pool.query("SELECT id, cost_at_sale FROM order_items WHERE order_id = $1", [orderId]);
    orderItemId = oi.rows[0].id;
    expect(Number(oi.rows[0].cost_at_sale)).toBeCloseTo(20, 5);

    const ingCost = await pool.query("SELECT * FROM order_item_ingredient_costs WHERE order_item_id = $1", [orderItemId]);
    expect(ingCost.rows.length).toBe(1);
    expect(Number(ingCost.rows[0].unit_cost)).toBeCloseTo(10, 5);
    expect(Number(ingCost.rows[0].total_cost)).toBeCloseTo(20, 5);
  });

  test("تغيير سعر الجبنة لـ26ج (زي يناير→أغسطس) - القيم المجمّدة فوق ميتغيّروش خالص", async () => {
    await request(app).patch(`/api/inventory/items/${cheeseId}`).set(authed(adminToken)).send({ unitCost: 26 });

    const oi = await pool.query("SELECT cost_at_sale FROM order_items WHERE id = $1", [orderItemId]);
    expect(Number(oi.rows[0].cost_at_sale)).toBeCloseTo(20, 5); // لسه 20، مش 52 (2×26)

    const ingCost = await pool.query("SELECT * FROM order_item_ingredient_costs WHERE order_item_id = $1", [orderItemId]);
    expect(Number(ingCost.rows[0].unit_cost)).toBeCloseTo(10, 5);
    expect(Number(ingCost.rows[0].total_cost)).toBeCloseTo(20, 5);
  });

  test("تقرير food-cost-variance بعد تغيير السعر لسه بيحسب النظري للبيع القديم بالسعر التاريخي مش سعر النهارده", async () => {
    const res = await request(app)
      .get(`/api/reports/food-cost-variance?branchId=${branchId}&from=2000-01-01&to=2099-01-01`)
      .set(authed(adminToken));
    expect(res.status).toBe(200);
    const cheeseRow = res.body.find((r) => r.inventoryItemId === cheeseId);
    expect(cheeseRow).toBeTruthy();
    // لو كان بيستخدم سعر النهارده (26) هتبقى 2×26=52 مش 20 - الفحص ده كان بيفشل قبل إصلاح المرحلة 3.1
    expect(cheeseRow.theoreticalFoodCost).toBeCloseTo(20, 5);
    expect(cheeseRow.salesFoodCost).toBeCloseTo(20, 5);
  });

  test("إنشاء وتفعيل نسخة وصفة V2 (1.2 كيلو بدل 1) - البيع القديم لسه مربوط بـV1 والكمية المجمّدة زي ما هي", async () => {
    const recipeId = (await pool.query("SELECT id FROM recipes WHERE variant_id = $1", [variantId])).rows[0].id;
    const v2 = await request(app).post(`/api/recipes/${recipeId}/versions`).set(authed(adminToken))
      .send({ ingredients: [{ ingredientItemId: cheeseId, quantity: 1.2 }] });
    await request(app).post(`/api/recipes/versions/${v2.body.id}/submit`).set(authed(managerToken)).expect(200);
    await request(app).post(`/api/recipes/versions/${v2.body.id}/approve`).set(authed(adminToken)).expect(200);
    await request(app).post(`/api/recipes/versions/${v2.body.id}/activate`).set(authed(adminToken)).expect(200);

    const oi = await pool.query("SELECT recipe_version_id FROM order_items WHERE id = $1", [orderItemId]);
    expect(oi.rows[0].recipe_version_id).toBe(recipeVersionV1Id); // لسه V1 مش V2

    const ingCost = await pool.query("SELECT quantity FROM order_item_ingredient_costs WHERE order_item_id = $1", [orderItemId]);
    expect(Number(ingCost.rows[0].quantity)).toBeCloseTo(2, 5); // لسه 2 كيلو (1×2) مش 2.4 (1.2×2)
  });

  test("عمليات لاحقة كتير (شراء بسعر جديد، تسوية، هالك، تحويل، تصنيع، استرجاع طلب تاني) - التقرير التاريخي للطلب القديم ميتأثرش", async () => {
    const before = await request(app)
      .get(`/api/reports/food-cost-variance?branchId=${branchId}&from=2000-01-01&to=2020-12-31`)
      .set(authed(adminToken)); // مدى تاريخ سابق لكل حاجة جديدة هتحصل - بيعزل الطلب القديم فقط لو الكل بنفس business_date
    // بما إن كل الاختبارات بتحصل في نفس اليوم فعليًا (business_date=CURRENT_DATE)، الفحص الحقيقي هو إعادة
    // نداء نفس التقرير بنفس المدى قبل/بعد العمليات دي ومقارنة قيمة الطلب القديم بالظبط (مش المدى الفاضي فوق)
    void before;

    const snapshotBefore = await pool.query(
      "SELECT total_cost FROM order_item_ingredient_costs WHERE order_item_id = $1", [orderItemId]
    );

    // شراء بسعر تالت مختلف تمامًا
    await request(app).post("/api/inventory/purchase-receipt").set(authed(managerToken))
      .send({ branchId, inventoryItemId: cheeseId, quantity: 50, unitCost: 999 });
    // تسوية جرد
    await request(app).post("/api/inventory/reconcile").set(authed(managerToken))
      .send({ branchId, inventoryItemId: cheeseId, actualQuantity: 400, notes: "جرد" });
    // هالك
    await request(app).post("/api/inventory/waste").set(authed(managerToken))
      .send({ branchId, inventoryItemId: cheeseId, quantity: 1, wasteReason: "DAMAGED", reason: "test" });
    // تحويل لفرع تاني
    const transferReq = await request(app).post("/api/kitchen-transfers/request").set(authed(managerToken))
      .send({ fromBranchId: branchId, toBranchId: otherBranchId, businessDate: new Date().toISOString().slice(0, 10), items: [{ inventoryItemId: cheeseId, quantity: 1 }] });
    await request(app).post(`/api/kitchen-transfers/${transferReq.body.id}/approve`).set(authed(adminToken)).expect(200);
    await request(app).post(`/api/kitchen-transfers/${transferReq.body.id}/issue`).set(authed(managerToken)).expect(200);
    // استرجاع طلب تاني (مختلف عن الطلب اللي بنراقبه)
    const otherOrderId = await sell(1);
    await request(app).post(`/api/orders/${otherOrderId}/void`).set(authed(managerToken)).send({ reason: "test void" }).expect(200);

    const snapshotAfter = await pool.query(
      "SELECT total_cost FROM order_item_ingredient_costs WHERE order_item_id = $1", [orderItemId]
    );
    expect(Number(snapshotAfter.rows[0].total_cost)).toBeCloseTo(Number(snapshotBefore.rows[0].total_cost), 5);
    expect(Number(snapshotAfter.rows[0].total_cost)).toBeCloseTo(20, 5);

    const oi = await pool.query("SELECT cost_at_sale FROM order_items WHERE id = $1", [orderItemId]);
    expect(Number(oi.rows[0].cost_at_sale)).toBeCloseTo(20, 5);
  });
});

describe("2) فصل فئات الاستهلاك - مش أرقام مخلوطة", () => {
  test("بيع + هالك + تسوية على صنف منفصل - كل فئة بترجع منفصلة والإجمالي بيتجمع صح", async () => {
    const item = await pool.query("INSERT INTO inventory_items (name, unit, unit_cost) VALUES ('صنف-فئات-جست', 'KG', 4) RETURNING id");
    const itemId = item.rows[0].id;
    await pool.query("INSERT INTO branch_inventory_stock (branch_id, inventory_item_id, quantity) VALUES ($1,$2,0)", [branchId, itemId]);
    const cat = await pool.query("INSERT INTO menu_categories (name) VALUES ('فئات-قسم-جست') RETURNING id");
    const mi = await pool.query("INSERT INTO menu_items (category_id, name) VALUES ($1,'صنف فئات منيو-جست') RETURNING id", [cat.rows[0].id]);
    const variant = await pool.query("INSERT INTO menu_item_variants (item_id, label, price) VALUES ($1,'عادي',10) RETURNING id", [mi.rows[0].id]);

    const recipeRes = await request(app).post("/api/recipes").set(authed(adminToken))
      .send({ recipeType: "sellable_variant", variantId: variant.rows[0].id, ingredients: [{ ingredientItemId: itemId, quantity: 1 }] });
    await request(app).post(`/api/recipes/versions/${recipeRes.body.version.id}/submit`).set(authed(managerToken)).expect(200);
    await request(app).post(`/api/recipes/versions/${recipeRes.body.version.id}/approve`).set(authed(adminToken)).expect(200);
    await request(app).post(`/api/recipes/versions/${recipeRes.body.version.id}/activate`).set(authed(adminToken)).expect(200);

    await request(app).post("/api/inventory/purchase-receipt").set(authed(managerToken))
      .send({ branchId, inventoryItemId: itemId, quantity: 100, unitCost: 4 });

    await request(app).post("/api/orders").set(authed(managerToken))
      .send({ branchId, source: "pos", orderType: "takeaway", items: [{ itemId: mi.rows[0].id, variantId: variant.rows[0].id, quantity: 5 }] })
      .expect(201); // 5 كيلو مبيعات × 4 = 20
    await request(app).post("/api/inventory/waste").set(authed(managerToken))
      .send({ branchId, inventoryItemId: itemId, quantity: 2, wasteReason: "DAMAGED", reason: "test" }); // 2×4=8 هالك
    await request(app).post("/api/inventory/stock/adjust").set(authed(managerToken))
      .send({ branchId, inventoryItemId: itemId, quantity: -1, movementType: "adjustment" }); // 1×4=4 تسوية

    const res = await request(app)
      .get(`/api/reports/food-cost-variance?branchId=${branchId}&from=2000-01-01&to=2099-01-01`)
      .set(authed(adminToken));
    const row = res.body.find((r) => r.inventoryItemId === itemId);
    expect(row.theoreticalFoodCost).toBeCloseTo(20, 5);
    expect(row.salesFoodCost).toBeCloseTo(20, 5);
    expect(row.wasteCost).toBeCloseTo(8, 5);
    expect(row.adjustmentCost).toBeCloseTo(4, 5);
    expect(row.totalInventoryUsageCost).toBeCloseTo(32, 5); // 20+8+4 - مفيش هالك/تسوية داخل رقم المبيعات
    expect(row.foodCostVariance).toBeCloseTo(12, 5); // 32-20
  });
});

describe("3) سيناريو محرم بك (750 إيراد / 300 نظري / 300 مبيعات / 15 هالك / 5 تسوية / 320 إجمالي / 20 فرق)", () => {
  test("أرقام مقاسة 1:1000 من مثال الطلب - نفس العلاقات الحسابية بالظبط", async () => {
    const item = await pool.query("INSERT INTO inventory_items (name, unit, unit_cost) VALUES ('صنف-محرم-بك-جست', 'KG', 10) RETURNING id");
    const itemId = item.rows[0].id;
    const mbBranch = await pool.query("INSERT INTO branches (name) VALUES ('محرم بك-جست') RETURNING id");
    const mbBranchId = mbBranch.rows[0].id;
    const mbManagerId = await seedUser({ branchId: mbBranchId, name: "مدير محرم بك", email: "moharam@jest.test", role: "branch_manager" });
    const mbToken = await login("moharam@jest.test");
    void mbManagerId;

    await pool.query("INSERT INTO branch_inventory_stock (branch_id, inventory_item_id, quantity) VALUES ($1,$2,0)", [mbBranchId, itemId]);
    const cat = await pool.query("INSERT INTO menu_categories (name) VALUES ('محرم بك قسم-جست') RETURNING id");
    const mi = await pool.query("INSERT INTO menu_items (category_id, name) VALUES ($1,'صنف محرم بك-جست') RETURNING id", [cat.rows[0].id]);
    const variant = await pool.query("INSERT INTO menu_item_variants (item_id, label, price) VALUES ($1,'عادي',25) RETURNING id", [mi.rows[0].id]);

    const recipeRes = await request(app).post("/api/recipes").set(authed(adminToken))
      .send({ recipeType: "sellable_variant", variantId: variant.rows[0].id, ingredients: [{ ingredientItemId: itemId, quantity: 1 }] });
    await request(app).post(`/api/recipes/versions/${recipeRes.body.version.id}/submit`).set(authed(mbToken)).expect(200);
    await request(app).post(`/api/recipes/versions/${recipeRes.body.version.id}/approve`).set(authed(adminToken)).expect(200);
    await request(app).post(`/api/recipes/versions/${recipeRes.body.version.id}/activate`).set(authed(adminToken)).expect(200);

    await request(app).post("/api/inventory/purchase-receipt").set(authed(mbToken))
      .send({ branchId: mbBranchId, inventoryItemId: itemId, quantity: 100, unitCost: 10 });

    // 30 وحدة × 25ج = 750 إيراد | 30 كيلو × 10 = 300 نظري/مبيعات
    await request(app).post("/api/orders").set(authed(mbToken))
      .send({ branchId: mbBranchId, source: "pos", orderType: "takeaway", items: [{ itemId: mi.rows[0].id, variantId: variant.rows[0].id, quantity: 30 }] })
      .expect(201);
    // هالك 1.5 كيلو × 10 = 15
    await request(app).post("/api/inventory/waste").set(authed(mbToken))
      .send({ branchId: mbBranchId, inventoryItemId: itemId, quantity: 1.5, wasteReason: "DAMAGED", reason: "test" });
    // تسوية 0.5 كيلو × 10 = 5
    await request(app).post("/api/inventory/stock/adjust").set(authed(mbToken))
      .send({ branchId: mbBranchId, inventoryItemId: itemId, quantity: -0.5, movementType: "adjustment" });

    const res = await request(app)
      .get(`/api/reports/branch-food-cost?branchId=${mbBranchId}&from=2000-01-01&to=2099-01-01`)
      .set(authed(adminToken));
    expect(res.status).toBe(200);
    const row = res.body.find((r) => r.branchId === mbBranchId);
    expect(row.revenue).toBeCloseTo(750, 5);
    expect(row.theoreticalFoodCost).toBeCloseTo(300, 5);
    expect(row.salesFoodCost).toBeCloseTo(300, 5);
    expect(row.wasteCost).toBeCloseTo(15, 5);
    expect(row.adjustmentCost).toBeCloseTo(5, 5);
    expect(row.totalInventoryUsageCost).toBeCloseTo(320, 5);
    expect(row.foodCostVariance).toBeCloseTo(20, 5);
    expect(row.foodCostVariancePercent).toBeCloseTo((20 / 300) * 100, 3);
  });
});

describe("4) مصدر الحقيقة الوحيد - الجدول المسطّح لازم يطابق فك الوصفة النشطة تمامًا", () => {
  test("لأي نسخة ACTIVE، menu_item_variant_ingredients لازم يطابق explodeRecipeConsumption(version, 1) بالظبط", async () => {
    const { explodeRecipeConsumption } = require("../db/recipe-engine");
    const activeVersions = await pool.query(
      `SELECT rv.id AS version_id, r.variant_id FROM recipe_versions rv
       JOIN recipes r ON r.id = rv.recipe_id
       WHERE rv.status = 'ACTIVE' AND r.recipe_type = 'sellable_variant'`
    );
    expect(activeVersions.rows.length).toBeGreaterThan(0);
    for (const v of activeVersions.rows) {
      const { raw } = await explodeRecipeConsumption(pool, v.version_id, 1, new Set());
      const flat = await pool.query(
        "SELECT inventory_item_id, quantity_per_unit FROM menu_item_variant_ingredients WHERE variant_id = $1",
        [v.variant_id]
      );
      const flatByItem = new Map(flat.rows.map((r) => [r.inventory_item_id, Number(r.quantity_per_unit)]));
      expect(flatByItem.size).toBe(raw.size);
      for (const [itemId, data] of raw) {
        expect(flatByItem.has(itemId)).toBe(true);
        expect(flatByItem.get(itemId)).toBeCloseTo(data.quantity, 6);
      }
    }
  });
});

describe("5) أداء: نفس نسخة الوصفة مستخدمة في أوردرات كتير - النتيجة صح رغم الكاش المشترك", () => {
  test("10 أوردرات بنفس الوصفة النشطة - التجميع صحيح رياضيًا (الكاش مبيوهمش النتيجة)", async () => {
    for (let i = 0; i < 10; i++) {
      await sell(1); // 1 كيلو جبنة لكل مرة، 10 مرات = 10 كيلو إضافية
    }
    const res = await request(app)
      .get(`/api/reports/theoretical-vs-actual-consumption?branchId=${branchId}&from=2000-01-01&to=2099-01-01`)
      .set(authed(adminToken));
    const cheeseRow = res.body.find((r) => r.inventoryItemId === cheeseId);
    // النظري بيتجاهل الطلبات اللي اتلغت (voided) تمامًا (قسم 1 فيه طلب اتباع بعد تفعيل V2 وبعدين اتلغى) -
    // لكن حركة SALE الأصلية بتاعته لسه ظاهرة في salesQty (تاريخ حقيقي)، والإرجاع بتاعها ظاهر في returnsQty
    // منفصل - يعني الهوية الصحيحة هي "نظري = مبيعات - مرتجعات" مش "نظري = مبيعات" مباشرة
    expect(cheeseRow.theoreticalQty).toBeCloseTo(cheeseRow.salesQty - cheeseRow.returnsQty, 5);
    expect(Number.isNaN(cheeseRow.theoreticalQty)).toBe(false);
  });
});
