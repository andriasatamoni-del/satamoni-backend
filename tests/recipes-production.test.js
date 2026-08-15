// Phase 3 regression suite ضد قاعدة بيانات Postgres حقيقية: محرك الوصفات (versioning/approval/activation/
// sub-recipes/circular detection)، أوامر التصنيع (workflow كامل مربوط بالـLedger)، وتقارير التكلفة/التتبّع.
const { app, request, pool, seedUser, login, authed } = require("./helpers");

let branchId, otherBranchId;
let adminToken, managerToken, otherManagerToken, accountantToken;
let managerId;
let flourId, waterId, doughId, cheeseId, pizzaOutputId;
let menuItemId, variantId;

beforeAll(async () => {
  const b1 = await pool.query("INSERT INTO branches (name) VALUES ('فرع وصفات-جست') RETURNING id");
  branchId = b1.rows[0].id;
  const b2 = await pool.query("INSERT INTO branches (name) VALUES ('فرع تاني وصفات-جست') RETURNING id");
  otherBranchId = b2.rows[0].id;

  await seedUser({ name: "أدمن-وصفات", email: "admin-recipes@jest.test", role: "admin" });
  managerId = await seedUser({ branchId, name: "مدير فرع-وصفات", email: "manager-recipes@jest.test", role: "branch_manager" });
  await seedUser({ branchId: otherBranchId, name: "مدير فرع تاني-وصفات", email: "othermanager-recipes@jest.test", role: "branch_manager" });
  await seedUser({ name: "محاسب-وصفات", email: "accountant-recipes@jest.test", role: "accountant" });

  adminToken = await login("admin-recipes@jest.test");
  managerToken = await login("manager-recipes@jest.test");
  otherManagerToken = await login("othermanager-recipes@jest.test");
  accountantToken = await login("accountant-recipes@jest.test");

  const flour = await pool.query("INSERT INTO inventory_items (name, unit, unit_cost) VALUES ('دقيق-وصفات-جست', 'KG', 20) RETURNING id");
  flourId = flour.rows[0].id;
  const water = await pool.query("INSERT INTO inventory_items (name, unit, unit_cost) VALUES ('مياه-وصفات-جست', 'L', 1) RETURNING id");
  waterId = water.rows[0].id;
  const cheese = await pool.query("INSERT INTO inventory_items (name, unit, unit_cost) VALUES ('جبنة-وصفات-جست', 'KG', 120) RETURNING id");
  cheeseId = cheese.rows[0].id;
  const dough = await pool.query(
    "INSERT INTO inventory_items (name, unit, unit_cost, item_type) VALUES ('عجينة-وصفات-جست', 'KG', NULL, 'manufactured') RETURNING id"
  );
  doughId = dough.rows[0].id;
  const pizza = await pool.query(
    "INSERT INTO inventory_items (name, unit, unit_cost, item_type) VALUES ('بيتزا جاهزة-وصفات-جست', 'unit', NULL, 'manufactured') RETURNING id"
  );
  pizzaOutputId = pizza.rows[0].id;

  await pool.query(
    "INSERT INTO branch_inventory_stock (branch_id, inventory_item_id, quantity) VALUES ($1,$2,0),($1,$3,0),($1,$4,0)",
    [branchId, flourId, waterId, cheeseId]
  );

  const cat = await pool.query("INSERT INTO menu_categories (name) VALUES ('بيتزا-وصفات-جست') RETURNING id");
  const mi = await pool.query("INSERT INTO menu_items (category_id, name) VALUES ($1,'مارجريتا-وصفات-جست') RETURNING id", [cat.rows[0].id]);
  menuItemId = mi.rows[0].id;
  const variant = await pool.query("INSERT INTO menu_item_variants (item_id, label, price) VALUES ($1,'وسط',100) RETURNING id", [mi.rows[0].id]);
  variantId = variant.rows[0].id;
});

afterAll(async () => {
  await pool.end();
});

async function purchase(token, itemId, quantity, unitCost) {
  return request(app).post("/api/inventory/purchase-receipt").set(authed(token))
    .send({ branchId, inventoryItemId: itemId, quantity, unitCost });
}

describe("Recipe creation validation", () => {
  test("sellable_variant لازم variantId", async () => {
    const res = await request(app).post("/api/recipes").set(authed(adminToken))
      .send({ recipeType: "sellable_variant", ingredients: [{ ingredientItemId: flourId, quantity: 1 }] });
    expect(res.status).toBe(400);
  });

  test("manufactured_item مينفعش يكون مكوّن في وصفة نفسه", async () => {
    const res = await request(app).post("/api/recipes").set(authed(adminToken))
      .send({
        recipeType: "manufactured_item", inventoryItemId: doughId, yieldQuantity: 10, yieldUnit: "KG",
        ingredients: [{ ingredientItemId: doughId, quantity: 1 }],
      });
    expect(res.status).toBe(400);
  });

  test("منيو بلا صلاحية recipes.create ممنوع (كاشير)", async () => {
    const cashierId = await seedUser({ branchId, name: "كاشير-وصفات", email: "cashier-recipes@jest.test", role: "cashier" });
    const cashierToken = await login("cashier-recipes@jest.test");
    const res = await request(app).post("/api/recipes").set(authed(cashierToken))
      .send({ recipeType: "manufactured_item", inventoryItemId: doughId, yieldQuantity: 10, ingredients: [{ ingredientItemId: flourId, quantity: 1 }] });
    expect(res.status).toBe(403);
    void cashierId;
  });
});

describe("Dough sub-recipe + Pizza sellable recipe (sub-recipe explosion + activation projection)", () => {
  let doughRecipeVersionId, pizzaRecipeVersionId;

  test("إنشاء وصفة عجينة (manufactured) - 10 كيلو دقيق + 5 لتر مياه = 10 كيلو عجينة", async () => {
    const res = await request(app).post("/api/recipes").set(authed(adminToken))
      .send({
        recipeType: "manufactured_item", inventoryItemId: doughId, yieldQuantity: 10, yieldUnit: "KG",
        ingredients: [
          { ingredientItemId: flourId, quantity: 10 },
          { ingredientItemId: waterId, quantity: 5 },
        ],
      });
    expect(res.status).toBe(201);
    doughRecipeVersionId = res.body.version.id;
  });

  test("submit → approve → activate للعجينة", async () => {
    await request(app).post(`/api/recipes/versions/${doughRecipeVersionId}/submit`).set(authed(managerToken)).expect(200);
    await request(app).post(`/api/recipes/versions/${doughRecipeVersionId}/approve`).set(authed(adminToken)).expect(200);
    const activateRes = await request(app).post(`/api/recipes/versions/${doughRecipeVersionId}/activate`).set(authed(adminToken));
    expect(activateRes.status).toBe(200);
    expect(activateRes.body.status).toBe("ACTIVE");
  });

  test("مينفعش تنشئ وصفة تانية لنفس الصنف المصنّع (UNIQUE inventory_item_id)", async () => {
    const res = await request(app).post("/api/recipes").set(authed(adminToken))
      .send({ recipeType: "manufactured_item", inventoryItemId: doughId, yieldQuantity: 1, ingredients: [{ ingredientItemId: flourId, quantity: 1 }] });
    expect(res.status).toBe(409);
  });

  test("مدير فرع (مش أدمن) ممنوع يعتمد أو يفعّل نسخة وصفة", async () => {
    const draft = await request(app).post(`/api/recipes/${(await pool.query("SELECT id FROM recipes WHERE inventory_item_id=$1", [doughId])).rows[0].id}/versions`)
      .set(authed(adminToken))
      .send({ yieldQuantity: 10, yieldUnit: "KG", ingredients: [{ ingredientItemId: flourId, quantity: 11 }, { ingredientItemId: waterId, quantity: 5 }] });
    expect(draft.status).toBe(201);
    await request(app).post(`/api/recipes/versions/${draft.body.id}/submit`).set(authed(managerToken)).expect(200);

    const approveByManager = await request(app).post(`/api/recipes/versions/${draft.body.id}/approve`).set(authed(managerToken));
    expect(approveByManager.status).toBe(403);

    await request(app).post(`/api/recipes/versions/${draft.body.id}/approve`).set(authed(adminToken)).expect(200);
    const activateByManager = await request(app).post(`/api/recipes/versions/${draft.body.id}/activate`).set(authed(managerToken));
    expect(activateByManager.status).toBe(403);
  });

  test("إنشاء وصفة بيتزا (sellable_variant) بتستخدم العجينة كمكوّن فرعي + جبنة مباشرة", async () => {
    const res = await request(app).post("/api/recipes").set(authed(adminToken))
      .send({
        recipeType: "sellable_variant", variantId, yieldQuantity: 1,
        ingredients: [
          { ingredientItemId: doughId, quantity: 0.3 }, // 300 جم عجينة لكل بيتزا
          { ingredientItemId: cheeseId, quantity: 0.2 }, // 200 جم جبنة لكل بيتزا
        ],
      });
    expect(res.status).toBe(201);
    pizzaRecipeVersionId = res.body.version.id;
    await request(app).post(`/api/recipes/versions/${pizzaRecipeVersionId}/submit`).set(authed(managerToken)).expect(200);
    await request(app).post(`/api/recipes/versions/${pizzaRecipeVersionId}/approve`).set(authed(adminToken)).expect(200);
  });

  test("تفعيل وصفة البيتزا بيفكّ العجينة لمكوناتها الخام ويكتبها مسطّحة في menu_item_variant_ingredients", async () => {
    const activateRes = await request(app).post(`/api/recipes/versions/${pizzaRecipeVersionId}/activate`).set(authed(adminToken));
    expect(activateRes.status).toBe(200);

    const flat = await pool.query(
      "SELECT * FROM menu_item_variant_ingredients WHERE variant_id = $1 ORDER BY inventory_item_id", [variantId]
    );
    // متوقع: دقيق (0.3 × 10/10 = 0.3)، مياه (0.3 × 5/10 = 0.15)، جبنة (0.2) - مفيش "عجينة" نفسها في الجدول المسطّح
    const byItem = Object.fromEntries(flat.rows.map((r) => [r.inventory_item_id, Number(r.quantity_per_unit)]));
    expect(byItem[doughId]).toBeUndefined();
    expect(byItem[flourId]).toBeCloseTo(0.3, 5);
    expect(byItem[waterId]).toBeCloseTo(0.15, 5);
    expect(byItem[cheeseId]).toBeCloseTo(0.2, 5);
  });

  test("بيع بيتزا واحدة بيخصم المكونات الخام المفكوكة (مش العجينة كصنف) ويسجل recipe_version_id على السطر", async () => {
    await purchase(managerToken, flourId, 50, 20);
    await purchase(managerToken, waterId, 50, 1);
    await purchase(managerToken, cheeseId, 50, 120);

    const flourBefore = await pool.query("SELECT quantity FROM branch_inventory_stock WHERE branch_id=$1 AND inventory_item_id=$2", [branchId, flourId]);

    const orderRes = await request(app).post("/api/orders").set(authed(managerToken))
      .send({ branchId, source: "pos", orderType: "takeaway", items: [{ itemId: menuItemId, variantId, quantity: 1 }] });
    expect(orderRes.status).toBe(201);

    const flourAfter = await pool.query("SELECT quantity FROM branch_inventory_stock WHERE branch_id=$1 AND inventory_item_id=$2", [branchId, flourId]);
    expect(Number(flourBefore.rows[0].quantity) - Number(flourAfter.rows[0].quantity)).toBeCloseTo(0.3, 5);

    const orderItem = await pool.query("SELECT recipe_version_id FROM order_items WHERE order_id = $1", [orderRes.body.orderId]);
    expect(orderItem.rows[0].recipe_version_id).toBe(pizzaRecipeVersionId);
  });

  test("Circular recipe: العجينة تاخد البيتزا كمكوّن (A→B→A) - لازم يترفض وقت التفعيل", async () => {
    // نسخة جديدة للعجينة بتاخد "بيتزا جاهزة" كمكوّن، والبيتزا الجاهزة أصلًا بتاخد العجينة - دورة
    const pizzaRawRes = await request(app).post("/api/recipes").set(authed(adminToken))
      .send({
        recipeType: "manufactured_item", inventoryItemId: pizzaOutputId, yieldQuantity: 1,
        ingredients: [{ ingredientItemId: doughId, quantity: 0.3 }],
      });
    expect(pizzaRawRes.status).toBe(201);
    await request(app).post(`/api/recipes/versions/${pizzaRawRes.body.version.id}/submit`).set(authed(managerToken)).expect(200);
    await request(app).post(`/api/recipes/versions/${pizzaRawRes.body.version.id}/approve`).set(authed(adminToken)).expect(200);
    await request(app).post(`/api/recipes/versions/${pizzaRawRes.body.version.id}/activate`).set(authed(adminToken)).expect(200);

    const doughV2 = await request(app).post(`/api/recipes/${(await pool.query("SELECT id FROM recipes WHERE inventory_item_id=$1", [doughId])).rows[0].id}/versions`)
      .set(authed(adminToken))
      .send({ yieldQuantity: 10, yieldUnit: "KG", ingredients: [{ ingredientItemId: pizzaOutputId, quantity: 1 }] });
    expect(doughV2.status).toBe(201);
    await request(app).post(`/api/recipes/versions/${doughV2.body.id}/submit`).set(authed(managerToken)).expect(200);
    await request(app).post(`/api/recipes/versions/${doughV2.body.id}/approve`).set(authed(adminToken)).expect(200);

    const activateAttempt = await request(app).post(`/api/recipes/versions/${doughV2.body.id}/activate`).set(authed(adminToken));
    expect(activateAttempt.status).toBe(400);
    expect(activateAttempt.body.error).toContain("دورة");
  });
});

describe("Recipe versioning: immutability + rejection + impact analysis", () => {
  let recipeId, v1Id, v2Id;

  test("إنشاء وصفة جديدة + نسخة تانية", async () => {
    const cat = await pool.query("INSERT INTO menu_categories (name) VALUES ('نسخ-وصفات-جست') RETURNING id");
    const mi = await pool.query("INSERT INTO menu_items (category_id, name) VALUES ($1,'صنف نسخ-جست') RETURNING id", [cat.rows[0].id]);
    const variant = await pool.query("INSERT INTO menu_item_variants (item_id, label, price) VALUES ($1,'عادي',80) RETURNING id", [mi.rows[0].id]);
    const v1res = await request(app).post("/api/recipes").set(authed(adminToken))
      .send({ recipeType: "sellable_variant", variantId: variant.rows[0].id, ingredients: [{ ingredientItemId: cheeseId, quantity: 0.08 }] });
    recipeId = v1res.body.recipe.id;
    v1Id = v1res.body.version.id;

    const v2res = await request(app).post(`/api/recipes/${recipeId}/versions`).set(authed(adminToken))
      .send({ ingredients: [{ ingredientItemId: cheeseId, quantity: 0.1 }] }); // زيادة كمية الجبنة
    expect(v2res.status).toBe(201);
    v2Id = v2res.body.id;
  });

  test("مينفعش تعدّل نسخة APPROVED أو ACTIVE", async () => {
    await request(app).post(`/api/recipes/versions/${v1Id}/submit`).set(authed(managerToken)).expect(200);
    await request(app).post(`/api/recipes/versions/${v1Id}/approve`).set(authed(adminToken)).expect(200);
    const editAttempt = await request(app).patch(`/api/recipes/versions/${v1Id}`).set(authed(adminToken)).send({ notes: "تعديل ممنوع" });
    expect(editAttempt.status).toBe(400);
  });

  test("رفض نسخة لازم سبب، وبعد الرفض تقدر تعدّلها/تقدّمها تاني", async () => {
    await request(app).post(`/api/recipes/versions/${v2Id}/submit`).set(authed(managerToken)).expect(200);
    const rejectNoReason = await request(app).post(`/api/recipes/versions/${v2Id}/reject`).set(authed(adminToken)).send({});
    expect(rejectNoReason.status).toBe(400);
    const reject = await request(app).post(`/api/recipes/versions/${v2Id}/reject`).set(authed(adminToken)).send({ rejectionReason: "التكلفة عالية" });
    expect(reject.status).toBe(200);
    expect(reject.body.status).toBe("REJECTED");

    const editAfterReject = await request(app).patch(`/api/recipes/versions/${v2Id}`).set(authed(adminToken)).send({ notes: "معدّلة بعد الرفض" });
    expect(editAfterReject.status).toBe(200);
  });

  test("تفعيل v1، وتحليل أثر v2 المقترحة عليها قبل ما تتفعّل", async () => {
    await request(app).post(`/api/recipes/versions/${v1Id}/activate`).set(authed(adminToken)).expect(200);

    const impact = await request(app).get(`/api/recipes/versions/${v2Id}/impact`).set(authed(adminToken));
    expect(impact.status).toBe(200);
    expect(impact.body.oldVersionId).toBe(v1Id);
    expect(impact.body.newVersionId).toBe(v2Id);
    // v1: 0.08 كيلو جبنة × 120 = 9.6 | v2: 0.1 × 120 = 12 → فرق موجب
    expect(impact.body.oldCost).toBeCloseTo(9.6, 5);
    expect(impact.body.newCost).toBeCloseTo(12, 5);
    expect(impact.body.difference).toBeGreaterThan(0);
  });

  test("تفعيل نسخة جديدة بيؤرشف القديمة أوتوماتيك - نسخة ACTIVE واحدة بس مضمونة على مستوى القاعدة", async () => {
    await request(app).post(`/api/recipes/versions/${v2Id}/submit`).set(authed(managerToken)).expect(200);
    await request(app).post(`/api/recipes/versions/${v2Id}/approve`).set(authed(adminToken)).expect(200);
    await request(app).post(`/api/recipes/versions/${v2Id}/activate`).set(authed(adminToken)).expect(200);

    const activeVersions = await pool.query("SELECT id, status FROM recipe_versions WHERE recipe_id = $1 AND status = 'ACTIVE'", [recipeId]);
    expect(activeVersions.rows.length).toBe(1);
    expect(activeVersions.rows[0].id).toBe(v2Id);

    const v1status = await pool.query("SELECT status FROM recipe_versions WHERE id = $1", [v1Id]);
    expect(v1status.rows[0].status).toBe("ARCHIVED");
  });
});

describe("Production order workflow", () => {
  let productionOrderId;

  test("مينفعش تعمل أمر تصنيع لوصفة معندهاش نسخة نشطة", async () => {
    const emptyItem = await pool.query("INSERT INTO inventory_items (name, unit, item_type) VALUES ('صنف بلا وصفة-جست', 'unit', 'manufactured') RETURNING id");
    const emptyRecipe = await pool.query("INSERT INTO recipes (recipe_type, inventory_item_id) VALUES ('manufactured_item', $1) RETURNING id", [emptyItem.rows[0].id]);
    const res = await request(app).post("/api/production").set(authed(managerToken))
      .send({ branchId, recipeId: emptyRecipe.rows[0].id, plannedQuantity: 5 });
    expect(res.status).toBe(400);
  });

  test("مدير فرع تاني ممنوع يعمل أمر تصنيع لفرع مش بتاعه", async () => {
    const doughRecipe = await pool.query("SELECT id FROM recipes WHERE inventory_item_id = $1", [doughId]);
    const res = await request(app).post("/api/production").set(authed(otherManagerToken))
      .send({ branchId, recipeId: doughRecipe.rows[0].id, plannedQuantity: 5 });
    expect(res.status).toBe(403);
  });

  test("إنشاء أمر تصنيع DRAFT للعجينة (5 كيلو مخططة)", async () => {
    const doughRecipe = await pool.query("SELECT id FROM recipes WHERE inventory_item_id = $1", [doughId]);
    const res = await request(app).post("/api/production").set(authed(managerToken))
      .send({ branchId, recipeId: doughRecipe.rows[0].id, plannedQuantity: 5, batchNumber: "DOUGH-BATCH-1", expiryDate: "2026-09-01" });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe("DRAFT");
    productionOrderId = res.body.id;
  });

  test("مينفعش تبدأ (start) قبل الاعتماد", async () => {
    const res = await request(app).post(`/api/production/${productionOrderId}/start`).set(authed(managerToken));
    expect(res.status).toBe(400);
  });

  test("مدير فرع ممنوع يعتمد أمر تصنيع (أدمن بس)", async () => {
    const res = await request(app).post(`/api/production/${productionOrderId}/approve`).set(authed(managerToken));
    expect(res.status).toBe(403);
  });

  test("اعتماد الأدمن، وبدء التصنيع بيخصم المكونات فعليًا من المخزون عن طريق الـLedger", async () => {
    await request(app).post(`/api/production/${productionOrderId}/approve`).set(authed(adminToken)).expect(200);

    const flourBefore = await pool.query("SELECT quantity FROM branch_inventory_stock WHERE branch_id=$1 AND inventory_item_id=$2", [branchId, flourId]);
    const startRes = await request(app).post(`/api/production/${productionOrderId}/start`).set(authed(managerToken));
    expect(startRes.status).toBe(200);
    expect(startRes.body.status).toBe("IN_PROGRESS");

    // 5 كيلو عجينة تحتاج 5 كيلو دقيق (10 دقيق / 10 عجينة × 5)
    const flourAfter = await pool.query("SELECT quantity FROM branch_inventory_stock WHERE branch_id=$1 AND inventory_item_id=$2", [branchId, flourId]);
    expect(Number(flourBefore.rows[0].quantity) - Number(flourAfter.rows[0].quantity)).toBeCloseTo(5, 5);

    const consumeMovement = await pool.query(
      "SELECT * FROM inventory_movements WHERE reference_type='production_order' AND reference_id=$1 AND movement_type='PRODUCTION_OUT' AND inventory_item_id=$2",
      [productionOrderId, flourId]
    );
    expect(consumeMovement.rows.length).toBeGreaterThan(0);
  });

  test("إكمال بفرق إنتاج كبير (أكتر من الحد الافتراضي 10%) من غير سبب - مرفوض", async () => {
    const res = await request(app).post(`/api/production/${productionOrderId}/complete`).set(authed(managerToken))
      .send({ actualQuantity: 4 }); // 5 مخطط → 4 فعلي = -20% بدون سبب
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("VARIANCE_REASON_REQUIRED");
  });

  test("إكمال بسبب مكتوب - بينجح، بيسجل دفعة جديدة للناتج ويحدّث المخزون", async () => {
    const res = await request(app).post(`/api/production/${productionOrderId}/complete`).set(authed(managerToken))
      .send({ actualQuantity: 4, varianceReason: "فقد أثناء العجن أكتر من المتوقع" });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("COMPLETED");
    expect(Number(res.body.variance)).toBeCloseTo(-1, 5);
    expect(Number(res.body.variancePercent)).toBeCloseTo(-20, 5);

    const doughStock = await pool.query("SELECT quantity FROM branch_inventory_stock WHERE branch_id=$1 AND inventory_item_id=$2", [branchId, doughId]);
    expect(Number(doughStock.rows[0].quantity)).toBeCloseTo(4, 5);

    const batch = await pool.query("SELECT * FROM inventory_batches WHERE inventory_item_id=$1 AND branch_id=$2 AND batch_number='DOUGH-BATCH-1'", [doughId, branchId]);
    expect(batch.rows.length).toBe(1);
    expect(Number(batch.rows[0].remaining_quantity)).toBeCloseTo(4, 5);
  });

  test("مينفعش تلغي أمر تصنيع مكتمل بالفعل", async () => {
    const res = await request(app).post(`/api/production/${productionOrderId}/cancel`).set(authed(managerToken)).send({ reason: "test" });
    expect(res.status).toBe(400);
  });
});

describe("Production order cancellation reverses consumption symmetrically", () => {
  let orderId;

  test("بدء تصنيع ثم إلغاؤه أثناء التنفيذ بيرجّع بالظبط نفس الكمية المخصومة", async () => {
    const doughRecipe = await pool.query("SELECT id FROM recipes WHERE inventory_item_id = $1", [doughId]);
    const create = await request(app).post("/api/production").set(authed(managerToken))
      .send({ branchId, recipeId: doughRecipe.rows[0].id, plannedQuantity: 2 });
    orderId = create.body.id;
    await request(app).post(`/api/production/${orderId}/approve`).set(authed(adminToken)).expect(200);

    const flourBefore = await pool.query("SELECT quantity FROM branch_inventory_stock WHERE branch_id=$1 AND inventory_item_id=$2", [branchId, flourId]);
    await request(app).post(`/api/production/${orderId}/start`).set(authed(managerToken)).expect(200);
    const flourDuring = await pool.query("SELECT quantity FROM branch_inventory_stock WHERE branch_id=$1 AND inventory_item_id=$2", [branchId, flourId]);
    expect(Number(flourBefore.rows[0].quantity)).toBeGreaterThan(Number(flourDuring.rows[0].quantity));

    const cancelRes = await request(app).post(`/api/production/${orderId}/cancel`).set(authed(managerToken)).send({ reason: "تراجع" });
    expect(cancelRes.status).toBe(200);
    expect(cancelRes.body.status).toBe("CANCELLED");

    const flourAfterCancel = await pool.query("SELECT quantity FROM branch_inventory_stock WHERE branch_id=$1 AND inventory_item_id=$2", [branchId, flourId]);
    expect(Number(flourAfterCancel.rows[0].quantity)).toBeCloseTo(Number(flourBefore.rows[0].quantity), 5);

    const reversalMovement = await pool.query(
      "SELECT * FROM inventory_movements WHERE reference_type='production_order' AND reference_id=$1 AND movement_type='PRODUCTION_REVERSAL'",
      [orderId]
    );
    expect(reversalMovement.rows.length).toBeGreaterThan(0);
  });
});

describe("Permissions: accountant can view recipes/production/food-cost but not create/approve", () => {
  test("محاسب يقدر يشوف الوصفات لكن مش ينشئ", async () => {
    const view = await request(app).get("/api/recipes").set(authed(accountantToken));
    expect(view.status).toBe(200);
    const create = await request(app).post("/api/recipes").set(authed(accountantToken))
      .send({ recipeType: "manufactured_item", inventoryItemId: doughId, yieldQuantity: 1, ingredients: [{ ingredientItemId: flourId, quantity: 1 }] });
    expect(create.status).toBe(403);
  });

  test("محاسب يقدر يشوف تقارير التكلفة (food_cost.view)", async () => {
    const res = await request(app)
      .get(`/api/reports/branch-food-cost?branchId=${branchId}&from=2020-01-01&to=2030-01-01`)
      .set(authed(accountantToken));
    expect(res.status).toBe(200);
  });
});

describe("Food cost / traceability reports", () => {
  test("branch-food-cost بيحسب نسبة تكلفة الطعام من cost_at_sale التاريخية مقابل الإيراد", async () => {
    const res = await request(app)
      .get(`/api/reports/branch-food-cost?branchId=${branchId}&from=2020-01-01&to=2030-01-01`)
      .set(authed(adminToken));
    expect(res.status).toBe(200);
    const row = res.body.find((r) => r.branchId === branchId);
    expect(row).toBeTruthy();
    expect(row.revenue).toBeGreaterThan(0);
    expect(row.foodCostPercent).not.toBeNull();
  });

  test("theoretical-vs-actual-consumption بيرجّع فرق معقول للدقيق (نظري من فك الوصفة، فعلي من حركات المخزون)", async () => {
    const res = await request(app)
      .get(`/api/reports/theoretical-vs-actual-consumption?branchId=${branchId}&from=2020-01-01&to=2030-01-01`)
      .set(authed(adminToken));
    expect(res.status).toBe(200);
    const flourRow = res.body.find((r) => r.inventoryItemId === flourId);
    expect(flourRow).toBeTruthy();
    expect(flourRow.theoreticalQty).toBeGreaterThan(0);
    expect(flourRow.salesQty).toBeGreaterThan(0);
  });

  test("food-cost-variance بيرجّع فرق الكمية والتكلفة لكل مكوّن", async () => {
    const res = await request(app)
      .get(`/api/reports/food-cost-variance?branchId=${branchId}&from=2020-01-01&to=2030-01-01`)
      .set(authed(adminToken));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThan(0);
  });

  test("production-variance بيعرض أمر التصنيع المكتمل بفرقه المسجّل", async () => {
    const res = await request(app)
      .get(`/api/reports/production-variance?branchId=${branchId}&from=2020-01-01&to=2030-01-01`)
      .set(authed(adminToken));
    expect(res.status).toBe(200);
    expect(res.body.some((r) => Number(r.variance) === -1)).toBe(true);
  });

  test("cost-traceability لطلب فيه بيتزا بيرجّع السلسلة كاملة: سطر الطلب → نسخة الوصفة → المكونات → حركة المخزون الفعلية", async () => {
    const orderRes = await request(app).post("/api/orders").set(authed(managerToken))
      .send({ branchId, source: "pos", orderType: "takeaway", items: [{ itemId: menuItemId, variantId, quantity: 1 }] });
    expect(orderRes.status).toBe(201);

    const trace = await request(app).get(`/api/reports/cost-traceability/${orderRes.body.orderId}`).set(authed(adminToken));
    expect(trace.status).toBe(200);
    expect(trace.body.items.length).toBeGreaterThan(0);
    expect(trace.body.items[0].ingredients.length).toBeGreaterThan(0);
    expect(trace.body.inventoryMovements.length).toBeGreaterThan(0);
  });

  test("مدير فرع تاني ممنوع يشوف تتبّع طلب فرع مش بتاعه", async () => {
    const orderRes = await request(app).post("/api/orders").set(authed(managerToken))
      .send({ branchId, source: "pos", orderType: "takeaway", items: [{ itemId: menuItemId, variantId, quantity: 1 }] });
    const trace = await request(app).get(`/api/reports/cost-traceability/${orderRes.body.orderId}`).set(authed(otherManagerToken));
    expect(trace.status).toBe(403);
  });
});
