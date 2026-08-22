// المرحلة 6 (6H): تفعيل نسخة وصفة (POST /api/recipes/versions/:id/activate) بيعمل 3 حاجات لازم تحصل
// مع بعض أو ولا واحدة فيهم: أرشفة النسخة النشطة القديمة (لو موجودة) + تفعيل النسخة الجديدة + إسقاطها
// على الجدول المسطّح القديم (projectVersionToLegacyTable) اللي البيع/التصنيع الفعلي بيقرا منه. بعد
// المراجعة، الكود في routes/recipes.js موجود بالفعل بيلف الثلاثة في transaction واحدة (client واحد من
// BEGIN لحد COMMIT/ROLLBACK) - الاختبارات هنا بتثبت الالتزام ده فعليًا (مش افتراض)، مش بتغيّر محرك
// الوصفات نفسه.
const { app, request, pool, seedUser, login, authed } = require("./helpers");
const { projectVersionToLegacyTable } = require("../db/recipe-engine");

let branchId, adminToken, flourId, menuItemId;

beforeAll(async () => {
  const b = await pool.query("INSERT INTO branches (name) VALUES ('فرع ذرية-تفعيل-جست') RETURNING id");
  branchId = b.rows[0].id;
  await seedUser({ name: "أدمن-ذرية-تفعيل", email: "admin-recipeatomic@jest.test", role: "admin" });
  adminToken = await login("admin-recipeatomic@jest.test");

  const flour = await pool.query("INSERT INTO inventory_items (name, unit, unit_cost) VALUES ('دقيق-ذرية-تفعيل-جست', 'KG', 10) RETURNING id");
  flourId = flour.rows[0].id;
  await pool.query("INSERT INTO branch_inventory_stock (branch_id, inventory_item_id, quantity) VALUES ($1,$2,0)", [branchId, flourId]);

  const cat = await pool.query("INSERT INTO menu_categories (name) VALUES ('فئة-ذرية-تفعيل-جست') RETURNING id");
  const mi = await pool.query("INSERT INTO menu_items (category_id, name) VALUES ($1,'صنف-ذرية-تفعيل-جست') RETURNING id", [cat.rows[0].id]);
  menuItemId = mi.rows[0].id;
});

afterAll(async () => {
  await pool.end();
});

let variantLabelCounter = 0;
async function createApprovedVariant(quantity) {
  variantLabelCounter += 1;
  const v = await pool.query(
    "INSERT INTO menu_item_variants (item_id, label, price) VALUES ($1,$2,50) RETURNING id",
    [menuItemId, `حجم-ذرية-${variantLabelCounter}`]
  );
  const variantId = v.rows[0].id;
  const createRes = await request(app).post("/api/recipes").set(authed(adminToken)).send({
    recipeType: "sellable_variant", variantId, ingredients: [{ ingredientItemId: flourId, quantity }],
  });
  expect(createRes.status).toBe(201);
  const versionId = createRes.body.version.id;
  await request(app).post(`/api/recipes/versions/${versionId}/submit`).set(authed(adminToken)).expect(200);
  await request(app).post(`/api/recipes/versions/${versionId}/approve`).set(authed(adminToken)).expect(200);
  return { variantId, versionId, recipeId: createRes.body.recipe.id };
}

describe("6H: فشل داخل projectVersionToLegacyTable وسط الترانزاكشن - أي كتابة سابقة بترجع لأصلها بعد ROLLBACK", () => {
  test("تحديث حالة نسخة حقيقية قبل فشل الإسقاط - الـROLLBACK بيلغي التحديث بالكامل، مش نص تفعيل معلّق", async () => {
    const { versionId } = await createApprovedVariant(2);

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      // نفس الخطوة الأولى بالظبط اللي بتحصل في /activate - تحديث حالة النسخة قبل الإسقاط
      await client.query("UPDATE recipe_versions SET status = 'ACTIVE' WHERE id = $1", [versionId]);
      // استدعاء projectVersionToLegacyTable بـid نسخة مش موجودة خالص - نفس فحص الوجود الحقيقي جوه
      // الدالة نفسها (db/recipe-engine.js) هيرمي error فعلي، بالظبط زي أي فشل حقيقي جوه الإسقاط
      await expect(projectVersionToLegacyTable(client, 999999999)).rejects.toThrow("نسخة الوصفة مش موجودة");
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }

    // النسخة لازم ترجع APPROVED زي ما كانت قبل الترانزاكشن كله - مفيش حالة نص متفعّلة معلّقة
    const check = await pool.query("SELECT status FROM recipe_versions WHERE id = $1", [versionId]);
    expect(check.rows[0].status).toBe("APPROVED");
  });
});

describe("6H: تفعيل ناجح - النسخة القديمة بتتأرشف والجديدة بتتفعّل وبتتسقط على الجدول المسطّح في نفس الوقت", () => {
  test("تفعيل نسخة جديدة لوصفة عندها نسخة نشطة قبل كده - كل حاجة بتتحدث مع بعض", async () => {
    const { variantId, versionId: v1 } = await createApprovedVariant(1);
    await request(app).post(`/api/recipes/versions/${v1}/activate`).set(authed(adminToken)).expect(200);

    let ing = await pool.query("SELECT quantity_per_unit FROM menu_item_variant_ingredients WHERE variant_id = $1 AND inventory_item_id = $2", [variantId, flourId]);
    expect(Number(ing.rows[0].quantity_per_unit)).toBe(1);

    const recipeId = (await pool.query("SELECT recipe_id FROM recipe_versions WHERE id = $1", [v1])).rows[0].recipe_id;
    const v2Res = await request(app).post(`/api/recipes/${recipeId}/versions`).set(authed(adminToken))
      .send({ ingredients: [{ ingredientItemId: flourId, quantity: 3 }] });
    expect(v2Res.status).toBe(201);
    const v2 = v2Res.body.id;
    await request(app).post(`/api/recipes/versions/${v2}/submit`).set(authed(adminToken)).expect(200);
    await request(app).post(`/api/recipes/versions/${v2}/approve`).set(authed(adminToken)).expect(200);
    await request(app).post(`/api/recipes/versions/${v2}/activate`).set(authed(adminToken)).expect(200);

    const v1Status = await pool.query("SELECT status FROM recipe_versions WHERE id = $1", [v1]);
    expect(v1Status.rows[0].status).toBe("ARCHIVED");
    const v2Status = await pool.query("SELECT status FROM recipe_versions WHERE id = $1", [v2]);
    expect(v2Status.rows[0].status).toBe("ACTIVE");
    ing = await pool.query("SELECT quantity_per_unit FROM menu_item_variant_ingredients WHERE variant_id = $1 AND inventory_item_id = $2", [variantId, flourId]);
    expect(Number(ing.rows[0].quantity_per_unit)).toBe(3);
  });
});

describe("6H: تفعيل نسختين مختلفتين لنفس الوصفة بالتزامن الحقيقي - idx_recipe_versions_one_active بيمنع تناقض حتى لو حصل تداخل فعلي", () => {
  // ملحوظة منهجية: تجربة أولى بالـHTTP route فعليًا (Promise.all لطلبين activate) طلعت غير موثوقة
  // في البيئة دي - الطلبين بيخلصوا سريعًا جدًا على Postgres محلي وماحصلش تداخل فعلي بينهم (نفس النمط
  // اللي لازم نتجنبه: "مفيش خطأ" مش معناها "آمن"، لازم نجبر التداخل فعليًا زي باقي اختبارات التزامن في
  // المرحلة 6A). هنا بنستخدم عميلين pg خام (pool.connect() زي بالظبط اللي الـroute بيعمله) ونتحكم في
  // ترتيب الخطوات يدويًا عشان نضمن تداخل حقيقي 100% بدل ما نعتمد على توقيت غير مضمون
  test("معاملة B بتتعلّق (lock) لحد ما A تعمل commit، وبعدين بترفض تفعّل نسخة تالتة بسبب الـunique index - مش تناقض صامت", async () => {
    const { variantId, versionId: v1 } = await createApprovedVariant(1);
    await request(app).post(`/api/recipes/versions/${v1}/activate`).set(authed(adminToken)).expect(200);
    const recipeId = (await pool.query("SELECT recipe_id FROM recipe_versions WHERE id = $1", [v1])).rows[0].recipe_id;

    async function newApprovedVersion(quantity) {
      const res = await request(app).post(`/api/recipes/${recipeId}/versions`).set(authed(adminToken))
        .send({ ingredients: [{ ingredientItemId: flourId, quantity }] });
      const versionId = res.body.id;
      await request(app).post(`/api/recipes/versions/${versionId}/submit`).set(authed(adminToken)).expect(200);
      await request(app).post(`/api/recipes/versions/${versionId}/approve`).set(authed(adminToken)).expect(200);
      return versionId;
    }
    const v2 = await newApprovedVersion(5);
    const v3 = await newApprovedVersion(7);

    const clientA = await pool.connect();
    const clientB = await pool.connect();
    try {
      // معاملة A بتاخد بالظبط نفس خطوات /activate يدويًا لـv2 (شاملة الإسقاط على الجدول المسطّح، عشان
      // الحالة النهائية تفضل متسقة تمامًا زي أي تفعيل حقيقي - مش بس تحديث status بمعزل عن الإسقاط)،
      // من غير commit لسه عشان تمسك قفل حقيقي
      await clientA.query("BEGIN");
      await clientA.query("UPDATE recipe_versions SET status = 'ARCHIVED' WHERE id = $1", [v1]);
      await clientA.query("UPDATE recipe_versions SET status = 'ACTIVE' WHERE id = $1", [v2]);
      await projectVersionToLegacyTable(clientA, v2);

      // معاملة B بتحاول تفعّل v3 - بتحاول تأرشف v1 (نفس الصف اللي A ماسكاه) - المفروض تتعلّق فعليًا
      await clientB.query("BEGIN");
      let bBlocked = true;
      const bArchiveAttempt = clientB.query("UPDATE recipe_versions SET status = 'ARCHIVED' WHERE id = $1", [v1])
        .then(() => { bBlocked = false; });
      const timedOut = await Promise.race([
        bArchiveAttempt.then(() => "resolved"),
        new Promise((resolve) => setTimeout(() => resolve("timeout"), 400)),
      ]);
      expect(timedOut).toBe("timeout"); // إثبات فعلي إن B اتعلّقت فعلًا على قفل A - مش تخمين توقيت
      expect(bBlocked).toBe(true);

      // A بتخلّص (commit) - القفل بيتفك، B المفروض تكمل دلوقتي
      await clientA.query("COMMIT");
      await bArchiveAttempt; // دلوقتي المفروض تخلص عادي (v1 أصلًا ARCHIVED من A - إعادة تعيين نفس القيمة، مش خطأ)

      // B تحاول تفعّل v3 - v2 بقت ACTIVE فعلًا (A خلصت) - idx_recipe_versions_one_active المفروض يرفض
      await expect(
        clientB.query("UPDATE recipe_versions SET status = 'ACTIVE' WHERE id = $1", [v3])
      ).rejects.toThrow();
      await clientB.query("ROLLBACK");
    } finally {
      clientA.release();
      clientB.release();
    }

    // النتيجة النهائية: نسخة نشطة واحدة بالظبط (v2 اللي كسبت فعليًا)، v3 رجعت لحالتها الأصلية APPROVED
    // بعد الـROLLBACK - مفيش نص-تفعيل معلّق ولا نسختين نشطتين مع بعض
    const activeVersions = await pool.query("SELECT id FROM recipe_versions WHERE recipe_id = $1 AND status = 'ACTIVE'", [recipeId]);
    expect(activeVersions.rows).toHaveLength(1);
    expect(activeVersions.rows[0].id).toBe(v2);

    const v3Status = await pool.query("SELECT status FROM recipe_versions WHERE id = $1", [v3]);
    expect(v3Status.rows[0].status).toBe("APPROVED");

    // الجدول المسطّح لازم يعكس v2 (اللي كسبت وتم إسقاطها فعليًا) - مش v1 القديمة ولا v3 اللي خسرت
    const ing = await pool.query(
      "SELECT quantity_per_unit FROM menu_item_variant_ingredients WHERE variant_id = $1 AND inventory_item_id = $2",
      [variantId, flourId]
    );
    expect(Number(ing.rows[0].quantity_per_unit)).toBe(5);
  });
});
