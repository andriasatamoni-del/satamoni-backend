// المرحلة 8.29: شاشة "الأصناف" (Item Master) - كتالوج موحّد للمواد الخام/المصنّعة وأصناف المنيو.
// يغطي: قايمة/بحث/فلترة الأصناف، تفاصيل كل نوع صنف (خام/مصنّع/منيو)، عرض الريسبي، آخر سعر شراء،
// حد الطلب، الصلاحيات، عزل الفروع، ومعرّف غير موجود/بحث فاضي/بلا نتائج.
const { app, request, pool, seedUser, login, authed } = require("./helpers");

let branch1Id, branch2Id, kitchenId;
let adminToken, accountantToken, manager1Token, manager2Token, cashierToken;
let flourId, doughId, mozzarellaId;
let menuItemId, variantId;
let doughVersionId, variantVersionId;
let supplierId, poId, grnId;

async function createActiveRecipe(token, body) {
  const created = await request(app).post("/api/recipes").set(authed(token)).send(body).expect(201);
  const versionId = created.body.version.id;
  await request(app).post(`/api/recipes/versions/${versionId}/submit`).set(authed(token)).expect(200);
  await request(app).post(`/api/recipes/versions/${versionId}/approve`).set(authed(token)).expect(200);
  await request(app).post(`/api/recipes/versions/${versionId}/activate`).set(authed(token)).expect(200);
  return versionId;
}

beforeAll(async () => {
  const b1 = await pool.query("INSERT INTO branches (name) VALUES ('فرع أصناف 1 جست') RETURNING id");
  branch1Id = b1.rows[0].id;
  const b2 = await pool.query("INSERT INTO branches (name) VALUES ('فرع أصناف 2 جست') RETURNING id");
  branch2Id = b2.rows[0].id;
  const ck = await pool.query("INSERT INTO branches (name, is_central_kitchen) VALUES ('سنتر كيتشن أصناف جست', TRUE) RETURNING id");
  kitchenId = ck.rows[0].id;

  await seedUser({ name: "أدمن أصناف", email: "admin-items@jest.test", role: "admin" });
  await seedUser({ name: "محاسب أصناف", email: "accountant-items@jest.test", role: "accountant" });
  await seedUser({ branchId: branch1Id, name: "مدير فرع 1 أصناف", email: "mgr1-items@jest.test", role: "branch_manager" });
  await seedUser({ branchId: branch2Id, name: "مدير فرع 2 أصناف", email: "mgr2-items@jest.test", role: "branch_manager" });
  await seedUser({ branchId: branch1Id, name: "كاشير أصناف", email: "cashier-items@jest.test", role: "cashier" });

  adminToken = await login("admin-items@jest.test");
  accountantToken = await login("accountant-items@jest.test");
  manager1Token = await login("mgr1-items@jest.test");
  manager2Token = await login("mgr2-items@jest.test");
  cashierToken = await login("cashier-items@jest.test");

  // مادة خام: دقيق - رصيد بحالات مختلفة عبر 3 فروع (طبيعي/يحتاج طلب/نفد)
  const flour = await pool.query(
    "INSERT INTO inventory_items (name, unit, unit_cost, item_type) VALUES ('دقيق-اصناف-جست', 'KG', 10, 'raw') RETURNING id"
  );
  flourId = flour.rows[0].id;
  await pool.query(
    "INSERT INTO branch_inventory_stock (branch_id, inventory_item_id, quantity, reorder_point) VALUES ($1,$2,100,20)",
    [branch1Id, flourId]
  );
  await pool.query(
    "INSERT INTO branch_inventory_stock (branch_id, inventory_item_id, quantity, reorder_point) VALUES ($1,$2,10,20)",
    [branch2Id, flourId]
  );
  await pool.query(
    "INSERT INTO branch_inventory_stock (branch_id, inventory_item_id, quantity, reorder_point) VALUES ($1,$2,0,20)",
    [kitchenId, flourId]
  );

  // صنف تاني بلا رصيد خالص - لاختبار "مفيش رصيد مسجّل"
  const mozz = await pool.query(
    "INSERT INTO inventory_items (name, unit, unit_cost, item_type) VALUES ('موتزريلا-اصناف-جست', 'KG', 150, 'raw') RETURNING id"
  );
  mozzarellaId = mozz.rows[0].id;

  // مادة مصنّعة: عجينة - وصفة نشطة بتستهلك الدقيق
  const dough = await pool.query(
    "INSERT INTO inventory_items (name, unit, unit_cost, item_type) VALUES ('عجينة-اصناف-جست', 'KG', 5, 'manufactured') RETURNING id"
  );
  doughId = dough.rows[0].id;
  doughVersionId = await createActiveRecipe(adminToken, {
    recipeType: "manufactured_item", inventoryItemId: doughId, yieldQuantity: 1, yieldUnit: "KG",
    ingredients: [{ ingredientItemId: flourId, quantity: 2, unit: "KG" }],
  });
  await pool.query(
    "INSERT INTO production_orders (branch_id, recipe_id, recipe_version_id, planned_quantity, status, production_date) VALUES ($1,(SELECT recipe_id FROM recipe_versions WHERE id=$2),$2,10,'COMPLETED',CURRENT_DATE)",
    [kitchenId, doughVersionId]
  );

  // صنف منيو: بيتزا اصناف - حجم واحد بريسبي نشط بيستهلك الدقيق
  const cat = await pool.query("INSERT INTO menu_categories (name) VALUES ('بيتزا-اصناف-جست') RETURNING id");
  const mi = await pool.query(
    "INSERT INTO menu_items (category_id, name) VALUES ($1,'بيتزا اصناف جست') RETURNING id",
    [cat.rows[0].id]
  );
  menuItemId = mi.rows[0].id;
  const variant = await pool.query(
    "INSERT INTO menu_item_variants (item_id, label, price) VALUES ($1,'وسط',100) RETURNING id",
    [menuItemId]
  );
  variantId = variant.rows[0].id;
  variantVersionId = await createActiveRecipe(adminToken, {
    recipeType: "sellable_variant", variantId, yieldQuantity: 1, yieldUnit: "قطعة",
    ingredients: [{ ingredientItemId: flourId, quantity: 0.5, unit: "KG" }],
  });

  // مشتريات فعلية للدقيق (PO -> GRN -> POSTED) عشان "آخر سعر شراء"
  const supplier = await pool.query("INSERT INTO suppliers (name, status) VALUES ('مورد-اصناف-جست', 'ACTIVE') RETURNING id");
  supplierId = supplier.rows[0].id;
  const po = await request(app).post("/api/purchase-orders").set(authed(manager1Token)).send({
    supplierId, branchId: branch1Id, items: [{ inventoryItemId: flourId, orderedQuantity: 50, unitPrice: 12 }],
  });
  poId = po.body.id;
  await request(app).post(`/api/purchase-orders/${poId}/submit`).set(authed(manager1Token)).expect(200);
  await request(app).post(`/api/purchase-orders/${poId}/approve`).set(authed(adminToken)).expect(200);
  const poDetail = await request(app).get(`/api/purchase-orders/${poId}`).set(authed(adminToken));
  const poItemId = poDetail.body.items[0].id;
  const grn = await request(app).post("/api/goods-receipts").set(authed(manager1Token)).send({
    purchaseOrderId: poId, supplierDocumentNumber: "ITEMS-GRN-1",
    items: [{ purchaseOrderItemId: poItemId, receivedQuantity: 50, acceptedQuantity: 50, rejectedQuantity: 0 }],
  });
  grnId = grn.body.id;
  await request(app).post(`/api/goods-receipts/${grnId}/post`).set(authed(manager1Token)).expect(200);
});

afterAll(async () => {
  await pool.end();
});

describe("قايمة الأصناف والبحث والفلترة", () => {
  test("GET /api/inventory/items بيرجّع كل الأصناف الخام والمصنّعة من غير فلترة", async () => {
    const res = await request(app).get("/api/inventory/items").set(authed(adminToken)).expect(200);
    expect(res.body.some((i) => i.id === flourId)).toBe(true);
    expect(res.body.some((i) => i.id === doughId)).toBe(true);
  });

  test("فلترة itemType=raw بترجّع خام بس", async () => {
    const res = await request(app).get("/api/inventory/items?itemType=raw").set(authed(adminToken)).expect(200);
    expect(res.body.every((i) => i.item_type === "raw")).toBe(true);
    expect(res.body.some((i) => i.id === flourId)).toBe(true);
    expect(res.body.some((i) => i.id === doughId)).toBe(false);
  });

  test("فلترة itemType=manufactured بترجّع مصنّع بس", async () => {
    const res = await request(app).get("/api/inventory/items?itemType=manufactured").set(authed(adminToken)).expect(200);
    expect(res.body.every((i) => i.item_type === "manufactured")).toBe(true);
    expect(res.body.some((i) => i.id === doughId)).toBe(true);
  });

  test("itemType غير معروف بيرجّع 400", async () => {
    await request(app).get("/api/inventory/items?itemType=bogus").set(authed(adminToken)).expect(400);
  });

  test("بحث جزئي بالاسم غير حساس لحالة الحروف - 'دقيق' بيلاقي 'دقيق-اصناف-جست'", async () => {
    const res = await request(app).get("/api/inventory/items?search=دقيق").set(authed(adminToken)).expect(200);
    expect(res.body.some((i) => i.id === flourId)).toBe(true);
    expect(res.body.some((i) => i.id === mozzarellaId)).toBe(false);
  });

  test("بحث فاضي بيرجّع كل الأصناف زي مفيش فلتر خالص", async () => {
    const res = await request(app).get("/api/inventory/items?search=").set(authed(adminToken)).expect(200);
    expect(res.body.some((i) => i.id === flourId)).toBe(true);
    expect(res.body.some((i) => i.id === doughId)).toBe(true);
  });

  test("بحث بكلمة مالهاش نتائج بيرجّع مصفوفة فاضية", async () => {
    const res = await request(app).get("/api/inventory/items?search=كلمة-مش-موجودة-خالص-١٢٣").set(authed(adminToken)).expect(200);
    expect(res.body).toEqual([]);
  });

  test("GET /api/menu/items?search= بيلاقي صنف المنيو بالاسم الجزئي", async () => {
    const res = await request(app).get("/api/menu/items?search=بيتزا اصناف").set(authed(adminToken)).expect(200);
    expect(res.body.some((i) => i.id === menuItemId)).toBe(true);
  });
});

describe("تفاصيل صنف خام", () => {
  test("بيانات أساسية + المخزون بحالاته الثلاثة + آخر سعر شراء + يستخدم في", async () => {
    const res = await request(app).get(`/api/inventory/items/${flourId}/detail`).set(authed(adminToken)).expect(200);
    expect(res.body.item.name).toBe("دقيق-اصناف-جست");
    expect(res.body.item.unit).toBe("KG");
    expect(Number(res.body.item.unit_cost)).toBe(10);

    const stockByBranch = Object.fromEntries(res.body.stock.map((s) => [s.branch_id, s]));
    expect(stockByBranch[branch1Id].status).toBe("NORMAL");
    expect(stockByBranch[branch2Id].status).toBe("NEEDS_REORDER");
    expect(stockByBranch[kitchenId].status).toBe("OUT");

    expect(res.body.lastPurchase).not.toBeNull();
    expect(Number(res.body.lastPurchase.unit_price)).toBe(12);
    expect(res.body.lastPurchase.supplier_name).toBe("مورد-اصناف-جست");

    expect(res.body.recipe).toBeNull();
    expect(res.body.production).toEqual([]);

    const usedInDough = res.body.usedIn.find((u) => u.recipe_type === "manufactured_item");
    expect(usedInDough).toBeDefined();
    expect(usedInDough.manufactured_item_name).toBe("عجينة-اصناف-جست");
    const usedInMenu = res.body.usedIn.find((u) => u.recipe_type === "sellable_variant");
    expect(usedInMenu).toBeDefined();
    expect(usedInMenu.menu_item_name).toBe("بيتزا اصناف جست");
  });

  test("صنف خام من غير أي رصيد مسجّل بيرجّع stock فاضي و lastPurchase null", async () => {
    const res = await request(app).get(`/api/inventory/items/${mozzarellaId}/detail`).set(authed(adminToken)).expect(200);
    expect(res.body.stock).toEqual([]);
    expect(res.body.lastPurchase).toBeNull();
    expect(res.body.usedIn).toEqual([]);
  });
});

describe("تفاصيل صنف مصنّع", () => {
  test("الريسبي + التكلفة + سجل الإنتاج", async () => {
    const res = await request(app).get(`/api/inventory/items/${doughId}/detail`).set(authed(adminToken)).expect(200);
    expect(res.body.item.item_type).toBe("manufactured");
    expect(res.body.lastPurchase).toBeNull();

    expect(res.body.recipe).not.toBeNull();
    expect(res.body.recipe.version.id).toBe(doughVersionId);
    expect(res.body.recipe.ingredients.length).toBe(1);
    expect(res.body.recipe.ingredients[0].ingredient_item_id).toBe(flourId);
    expect(Number(res.body.recipe.ingredients[0].line_cost)).toBe(20); // 2 كجم × 10
    expect(Number(res.body.recipe.cost.totalCost)).toBe(20);

    expect(res.body.production.length).toBe(1);
    expect(res.body.production[0].status).toBe("COMPLETED");
    expect(Number(res.body.production[0].planned_quantity)).toBe(10);
  });
});

describe("تفاصيل صنف منيو", () => {
  test("كل حجم بسعره وريسبيه وتكلفته وFood Cost% وهامش الربح", async () => {
    const res = await request(app).get(`/api/menu/items/${menuItemId}/detail`).set(authed(adminToken)).expect(200);
    expect(res.body.item.name).toBe("بيتزا اصناف جست");
    expect(res.body.variants.length).toBe(1);
    const v = res.body.variants[0];
    expect(v.id).toBe(variantId);
    expect(Number(v.price)).toBe(100);
    expect(v.recipe).not.toBeNull();
    expect(v.recipe.version.id).toBe(variantVersionId);
    expect(Number(v.recipe.cost.totalCost)).toBe(5); // 0.5 كجم × 10
    expect(Number(v.foodCostPercent)).toBeCloseTo(5, 5);
    expect(Number(v.margin)).toBeCloseTo(95, 5);
    expect(Number(v.marginPercent)).toBeCloseTo(95, 5);
  });

  test("معرّف صنف منيو غير موجود بيرجّع 404", async () => {
    await request(app).get("/api/menu/items/999999999/detail").set(authed(adminToken)).expect(404);
  });
});

describe("معرّف غير موجود", () => {
  test("GET /api/inventory/items/:id/detail بمعرّف غير موجود بيرجّع 404", async () => {
    await request(app).get("/api/inventory/items/999999999/detail").set(authed(adminToken)).expect(404);
  });
});

describe("الصلاحيات", () => {
  test("الكاشير معندوش صلاحية GET /api/inventory/items/:id/detail", async () => {
    await request(app).get(`/api/inventory/items/${flourId}/detail`).set(authed(cashierToken)).expect(403);
  });

  test("الكاشير معندوش صلاحية GET /api/menu/items/:id/detail", async () => {
    await request(app).get(`/api/menu/items/${menuItemId}/detail`).set(authed(cashierToken)).expect(403);
  });

  test("المحاسب عنده صلاحية يشوف تفاصيل صنف خام ومنيو", async () => {
    await request(app).get(`/api/inventory/items/${flourId}/detail`).set(authed(accountantToken)).expect(200);
    await request(app).get(`/api/menu/items/${menuItemId}/detail`).set(authed(accountantToken)).expect(200);
  });

  test("مدير الفرع عنده صلاحية يشوف كتالوج الأصناف والمنيو", async () => {
    await request(app).get("/api/inventory/items").set(authed(manager1Token)).expect(200);
    await request(app).get("/api/menu/items").set(authed(manager1Token)).expect(200);
  });
});

describe("عزل الفروع", () => {
  test("مدير فرع 1 بيشوف رصيد فرعه بس في تفاصيل الصنف الخام", async () => {
    const res = await request(app).get(`/api/inventory/items/${flourId}/detail`).set(authed(manager1Token)).expect(200);
    expect(res.body.stock.length).toBe(1);
    expect(res.body.stock[0].branch_id).toBe(branch1Id);
    expect(res.body.stock[0].status).toBe("NORMAL");
  });

  test("مدير فرع 2 بيشوف رصيد فرعه بس (يحتاج طلب) - مش رصيد فرع 1 ولا السنتر كيتشن", async () => {
    const res = await request(app).get(`/api/inventory/items/${flourId}/detail`).set(authed(manager2Token)).expect(200);
    expect(res.body.stock.length).toBe(1);
    expect(res.body.stock[0].branch_id).toBe(branch2Id);
    expect(res.body.stock[0].status).toBe("NEEDS_REORDER");
  });

  test("أدمن ومحاسب بيشوفوا رصيد كل الفروع الثلاثة", async () => {
    const res = await request(app).get(`/api/inventory/items/${flourId}/detail`).set(authed(adminToken)).expect(200);
    expect(res.body.stock.length).toBe(3);
    const resAcct = await request(app).get(`/api/inventory/items/${flourId}/detail`).set(authed(accountantToken)).expect(200);
    expect(resAcct.body.stock.length).toBe(3);
  });

  test("مدير فرع 1 بيشوف سجل تصنيع السنتر كيتشن بس لو هو نفسه تابع لفرعه - هنا مش تابع فمش بيشوفه", async () => {
    const res = await request(app).get(`/api/inventory/items/${doughId}/detail`).set(authed(manager1Token)).expect(200);
    expect(res.body.production).toEqual([]);
  });
});

describe("حد الطلب مقابل الكمية المقترحة - مصدرين مختلفين", () => {
  test("حد الطلب المعروض في شاشة الأصناف هو reorder_point المُهيّأ نفسه، مش حساب اقتراح جديد", async () => {
    const res = await request(app).get(`/api/inventory/items/${flourId}/detail`).set(authed(adminToken)).expect(200);
    const branch2Stock = res.body.stock.find((s) => s.branch_id === branch2Id);
    expect(Number(branch2Stock.reorder_point)).toBe(20);
  });
});

describe("لا يمس السلوك القديم", () => {
  test("GET /api/recipes/versions/:versionId لسه بيرجّع نفس شكل الرد القديم (version/ingredients/cost) بعد الريفاكتور", async () => {
    const res = await request(app).get(`/api/recipes/versions/${doughVersionId}`).set(authed(adminToken)).expect(200);
    expect(res.body.version.id).toBe(doughVersionId);
    expect(Array.isArray(res.body.ingredients)).toBe(true);
    expect(res.body.cost).not.toBeNull();
    expect(Number(res.body.cost.totalCost)).toBe(20);
  });

  test("GET /api/recipes/usage/:itemId بيرجّع الاستخدامات النشطة للصنف", async () => {
    const res = await request(app).get(`/api/recipes/usage/${flourId}`).set(authed(adminToken)).expect(200);
    expect(res.body.length).toBe(2);
  });
});
