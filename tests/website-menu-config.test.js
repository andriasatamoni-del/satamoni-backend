// المرحلة 8.53: الموقع الأونلاين (public/order.html) بقى بياخد نفس تجربة شاشة الكاشير - عادي/صيامي،
// مرفقات، "بدون <مكوّن>"، وملاحظة حرة لكل صنف. بيغطي: GET /api/config/full بيرجّع ingredients لكل حجم
// (مصدر بيانات مودال "بدون" على الموقع، ماكانش موجود قبل كده هناك)، وإن POST /api/orders من مصدر
// website (من غير تسجيل دخول خالص - نفس استخدام order.html الفعلي) بيقبل نفس الحمولة (modifiers/notes/
// excludedIngredientItemIds) اللي شاشة الكاشير بتبعتها، بنفس منطق resolveOrderItems المشترك.
const { app, request, pool, seedUser, login, authed } = require("./helpers");

let branchA;
let managerAToken;
let cashPmId, itemId, variantId, modifierId, cheeseInvId, oliveInvId;

beforeAll(async () => {
  const b = await pool.query("INSERT INTO branches (name) VALUES ('فرع منيو-موقع-جست') RETURNING id");
  branchA = b.rows[0].id;
  await seedUser({ branchId: branchA, name: "مدير-منيو-موقع", email: "managerA-websitemenu@jest.test", role: "branch_manager" });
  managerAToken = await login("managerA-websitemenu@jest.test");

  const pm = await pool.query("INSERT INTO payment_methods (name, kind, enabled) VALUES ('كاش-منيو-موقع-جست', 'cash', TRUE) RETURNING id");
  cashPmId = pm.rows[0].id;

  const cat = await pool.query("INSERT INTO menu_categories (name, display_order, menu_group) VALUES ('بيتزا-موقع-جست', 1, 'regular') RETURNING id");
  const mi = await pool.query("INSERT INTO menu_items (category_id, name) VALUES ($1, 'بيتزا-موقع-جست') RETURNING id", [cat.rows[0].id]);
  itemId = mi.rows[0].id;
  const v = await pool.query("INSERT INTO menu_item_variants (item_id, label, price) VALUES ($1, 'صغير', 100) RETURNING id", [itemId]);
  variantId = v.rows[0].id;

  const cheese = await pool.query("INSERT INTO inventory_items (name, unit) VALUES ('جبنة-موقع-جست', 'kg') RETURNING id");
  cheeseInvId = cheese.rows[0].id;
  const olive = await pool.query("INSERT INTO inventory_items (name, unit) VALUES ('زيتون-موقع-جست', 'kg') RETURNING id");
  oliveInvId = olive.rows[0].id;
  await pool.query(
    "INSERT INTO menu_item_variant_ingredients (variant_id, inventory_item_id, quantity_per_unit) VALUES ($1,$2,0.2),($1,$3,0.05)",
    [variantId, cheeseInvId, oliveInvId]
  );
  // مفيش رصيد مخزون كافي (سياسة STRICT الافتراضية) - الاختبارات هنا بتقفل عند بناء الحمولة والرد
  // بمنطق resolveOrderItems نفسه (validation)، مش لازم تخلص لإنشاء طلب فعليًا ناجح
  await pool.query("INSERT INTO branch_inventory_stock (branch_id, inventory_item_id, quantity) VALUES ($1,$2,1000),($1,$3,1000)", [branchA, cheeseInvId, oliveInvId]);

  const mod = await pool.query(
    "INSERT INTO menu_item_modifiers (item_id, name, price_delta, is_active) VALUES ($1, 'حافة جبنة-موقع-جست', 15, TRUE) RETURNING id",
    [itemId]
  );
  modifierId = mod.rows[0].id;
});

afterAll(async () => {
  await pool.end();
});

describe("GET /api/config/full - ingredients لكل حجم (8.53)", () => {
  test("كل variant برجّع ingredients بأسمائها - مصدر بيانات مودال بدون في الموقع", async () => {
    const res = await request(app).get("/api/config/full");
    expect(res.status).toBe(200);
    const item = res.body.menu.find((m) => m.id === itemId);
    expect(item).toBeTruthy();
    expect(item.menuGroup).toBe("regular");
    const variant = item.variants.find((v) => v.id === variantId);
    const names = variant.ingredients.map((i) => i.name).sort();
    expect(names).toEqual(["جبنة-موقع-جست", "زيتون-موقع-جست"].sort());
    expect(variant.ingredients.every((i) => Number.isInteger(i.inventoryItemId))).toBe(true);
  });

  test("صنف من غير وصفة مسجّلة برجع ingredients فاضية", async () => {
    const cat2 = await pool.query("INSERT INTO menu_categories (name) VALUES ('بدون وصفة-موقع-جست') RETURNING id");
    const mi2 = await pool.query("INSERT INTO menu_items (category_id, name) VALUES ($1, 'صنف بلا وصفة-موقع-جست') RETURNING id", [cat2.rows[0].id]);
    await pool.query("INSERT INTO menu_item_variants (item_id, label, price) VALUES ($1, 'عادي', 50)", [mi2.rows[0].id]);

    const res = await request(app).get("/api/config/full");
    const item = res.body.menu.find((m) => m.id === mi2.rows[0].id);
    expect(item.variants[0].ingredients).toEqual([]);
  });
});

describe("POST /api/orders (source=website, من غير تسجيل دخول) - مرفقات/بدون/ملاحظة (8.53)", () => {
  test("طلب من الموقع بمرفق واحد + استبعاد مكوّن + ملاحظة - بيتسجل بنفس تفاصيل الكاشير بالظبط", async () => {
    const res = await request(app).post("/api/orders").send({
      source: "website", branchId: branchA, orderType: "takeaway",
      customerName: "عميل موقع جست", customerPhone: `016${Date.now()}`.slice(0, 11),
      paymentMethodId: cashPmId,
      items: [{
        itemId, variantId, quantity: 2,
        modifiers: [{ id: modifierId }],
        notes: "تحمير زيادة لو سمحت",
        excludedIngredientItemIds: [oliveInvId],
      }],
    });
    expect(res.status).toBe(201);
    // 100 (أساسي) + 15 (مرفق) = 115 × 2 = 230
    expect(Number(res.body.total)).toBe(230);

    const item = await pool.query(
      "SELECT id, notes, unit_price, quantity FROM order_items WHERE order_id = $1", [res.body.orderId]
    );
    expect(item.rows.length).toBe(1);
    expect(item.rows[0].notes).toBe("تحمير زيادة لو سمحت");
    expect(Number(item.rows[0].unit_price)).toBe(115);

    const mods = await pool.query("SELECT modifier_id FROM order_item_modifiers WHERE order_item_id = $1", [item.rows[0].id]);
    expect(mods.rows.map((m) => m.modifier_id)).toEqual([modifierId]);

    const excl = await pool.query("SELECT inventory_item_id FROM order_item_excluded_ingredients WHERE order_item_id = $1", [item.rows[0].id]);
    expect(excl.rows.map((e) => e.inventory_item_id)).toEqual([oliveInvId]);
  });

  test("استبعاد مكوّن مش جزء من وصفة الحجم ده - بيترفض (نفس تحقق الكاشير بالظبط)", async () => {
    const otherInv = await pool.query("INSERT INTO inventory_items (name, unit) VALUES ('مش في الوصفة-موقع-جست', 'kg') RETURNING id");
    const res = await request(app).post("/api/orders").send({
      source: "website", branchId: branchA, orderType: "takeaway",
      customerName: "عميل موقع جست 2", customerPhone: `016${Date.now()}`.slice(0, 11),
      paymentMethodId: cashPmId,
      items: [{ itemId, variantId, quantity: 1, excludedIngredientItemIds: [otherInv.rows[0].id] }],
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("مش جزء من وصفة الصنف");
  });
});
