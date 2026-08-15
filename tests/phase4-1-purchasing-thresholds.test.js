// المرحلة 4.1: حدود إعادة الطلب + مقارنة موردين (تكلفة موحّدة بوحدة تخزين الصنف) + توصيات شراء - بدون
// أي تغيير في وحدات المخزون الحالية أو منطق التحويل الموجود. ضد Postgres حقيقي.
const { app, request, pool, seedUser, login, authed } = require("./helpers");

let branchId, otherBranchId;
let adminToken, managerToken, otherManagerToken;
let cheeseId; // KG - وحدة تخزين = وحدة شراء عند أغلب الموردين (الحالة الشائعة فعليًا في بيانات ساتاموني)
let supplierAId, supplierBId, supplierCId, supplierBlockedId;

beforeAll(async () => {
  const b1 = await pool.query("INSERT INTO branches (name) VALUES ('فرع حدود-جست') RETURNING id");
  branchId = b1.rows[0].id;
  const b2 = await pool.query("INSERT INTO branches (name) VALUES ('فرع تاني حدود-جست') RETURNING id");
  otherBranchId = b2.rows[0].id;

  await seedUser({ name: "أدمن-حدود", email: "admin-thresh@jest.test", role: "admin" });
  await seedUser({ branchId, name: "مدير فرع-حدود", email: "manager-thresh@jest.test", role: "branch_manager" });
  await seedUser({ branchId: otherBranchId, name: "مدير فرع تاني-حدود", email: "othermanager-thresh@jest.test", role: "branch_manager" });
  adminToken = await login("admin-thresh@jest.test");
  managerToken = await login("manager-thresh@jest.test");
  otherManagerToken = await login("othermanager-thresh@jest.test");

  const cheese = await pool.query("INSERT INTO inventory_items (name, unit, unit_cost) VALUES ('جبنة-حدود-جست', 'KG', 0) RETURNING id");
  cheeseId = cheese.rows[0].id;
  await pool.query("INSERT INTO branch_inventory_stock (branch_id, inventory_item_id, quantity) VALUES ($1,$2,20)", [branchId, cheeseId]);

  const sA = await request(app).post("/api/suppliers").set(authed(adminToken)).send({ name: "مورد أ-حدود-جست" });
  const sB = await request(app).post("/api/suppliers").set(authed(adminToken)).send({ name: "مورد ب-حدود-جست" });
  const sC = await request(app).post("/api/suppliers").set(authed(adminToken)).send({ name: "مورد ج-حدود-جست" });
  const sBlocked = await request(app).post("/api/suppliers").set(authed(adminToken)).send({ name: "مورد محظور-حدود-جست" });
  supplierAId = sA.body.id; supplierBId = sB.body.id; supplierCId = sC.body.id; supplierBlockedId = sBlocked.body.id;
  await request(app).patch(`/api/suppliers/${supplierBlockedId}`).set(authed(adminToken)).send({ status: "BLOCKED" });
});

afterAll(async () => {
  await pool.end();
});

describe("1) حدود إعادة الطلب - PATCH /api/inventory/stock-thresholds", () => {
  test("تحديد reorder_point/min_stock/max_stock بوحدة الصنف نفسها", async () => {
    const res = await request(app).patch("/api/inventory/stock-thresholds").set(authed(managerToken)).send({
      branchId, inventoryItemId: cheeseId, reorderPoint: 15, minStock: 10, maxStock: 50,
    });
    expect(res.status).toBe(200);
    expect(Number(res.body.reorder_point)).toBe(15);
    expect(Number(res.body.min_stock)).toBe(10);
    expect(Number(res.body.max_stock)).toBe(50);
    // الرصيد نفسه (quantity) متلمسش خالص - PATCH الحدود بس
    expect(Number(res.body.quantity)).toBe(20);
  });

  test("مدير فرع تاني ممنوع يعدّل حدود فرع مش بتاعه", async () => {
    const res = await request(app).patch("/api/inventory/stock-thresholds").set(authed(otherManagerToken)).send({
      branchId, inventoryItemId: cheeseId, reorderPoint: 5,
    });
    expect(res.status).toBe(403);
  });

  test("قيمة سالبة مرفوضة", async () => {
    const res = await request(app).patch("/api/inventory/stock-thresholds").set(authed(managerToken)).send({
      branchId, inventoryItemId: cheeseId, minStock: -5,
    });
    expect(res.status).toBe(400);
  });
});

describe("2) مقارنة موردين - تكلفة موحّدة بوحدة تخزين الصنف مش وحدة الشراء", () => {
  test("مورد أ: وحدة الشراء = وحدة التخزين (KG) - مفيش تحويل مطلوب خالص", async () => {
    const res = await request(app).post(`/api/suppliers/${supplierAId}/price-history`).set(authed(adminToken)).send({
      inventoryItemId: cheeseId, unitPrice: 260, purchaseUnit: "KG",
    });
    expect(res.status).toBe(201);
  });

  test("مورد ب: بيبيع بالكرتونة (10 كيلو) - conversion_factor محدد مباشرة على supplier_items", async () => {
    const res = await request(app).post(`/api/suppliers/${supplierBId}/price-history`).set(authed(adminToken)).send({
      inventoryItemId: cheeseId, unitPrice: 2400, purchaseUnit: "CARTON-THRESH-JEST", conversionFactor: 10,
    });
    expect(res.status).toBe(201); // 2400/10 = 240 - أرخص من مورد أ (260)
  });

  test("مورد ج: بيبيع بالصندوق (5 كيلو) - من غير conversion_factor، بيتحل من unit_conversions", async () => {
    await request(app).post("/api/inventory/unit-conversions").set(authed(adminToken))
      .send({ fromUnit: "BOX-THRESH-JEST", toUnit: "KG", factor: 5 });
    const res = await request(app).post(`/api/suppliers/${supplierCId}/price-history`).set(authed(adminToken)).send({
      inventoryItemId: cheeseId, unitPrice: 1000, purchaseUnit: "BOX-THRESH-JEST",
    });
    expect(res.status).toBe(201); // 1000/5 = 200 - أرخص واحد
  });

  test("مورد محظور: سعر مسجّل بس المورد BLOCKED - لازم يظهر في المقارنة العامة (سعر ساري) بحالته", async () => {
    await request(app).post(`/api/suppliers/${supplierBlockedId}/price-history`).set(authed(adminToken)).send({
      inventoryItemId: cheeseId, unitPrice: 100, purchaseUnit: "KG",
    });
  });

  test("تقرير المقارنة: التكلفة الموحّدة صحيحة والترتيب من الأرخص، وحالة المورد ظاهرة", async () => {
    const res = await request(app).get(`/api/reports/supplier-comparison?itemId=${cheeseId}`).set(authed(adminToken));
    expect(res.status).toBe(200);
    expect(res.body.stockUnit).toBe("KG");
    const bySupplier = Object.fromEntries(res.body.suppliers.map((s) => [s.supplierId, s]));

    expect(bySupplier[supplierAId].normalizedCost).toBeCloseTo(260, 5); // نفس الوحدة، مفيش تحويل
    expect(bySupplier[supplierBId].normalizedCost).toBeCloseTo(240, 5); // 2400/10 (conversion_factor مباشر)
    expect(bySupplier[supplierCId].normalizedCost).toBeCloseTo(200, 5); // 1000/5 (من unit_conversions)
    expect(bySupplier[supplierBlockedId].normalizedCost).toBeCloseTo(100, 5);
    expect(bySupplier[supplierBlockedId].supplierStatus).toBe("BLOCKED");

    // الترتيب: الأرخص أولًا (المحظور 100 أرخص رقميًا، بيظهر لكن حالته واضحة - القرار للمستخدم)
    expect(res.body.suppliers[0].supplierId).toBe(supplierBlockedId);
    expect(res.body.suppliers[1].supplierId).toBe(supplierCId);
  });

  test("مورد بوحدة شراء من غير conversion_factor ومن غير unit_conversions مسجّل - incomplete=true مش تخمين", async () => {
    const noConvSupplier = await request(app).post("/api/suppliers").set(authed(adminToken)).send({ name: "مورد بلا تحويل-حدود-جست" });
    await request(app).post(`/api/suppliers/${noConvSupplier.body.id}/price-history`).set(authed(adminToken)).send({
      inventoryItemId: cheeseId, unitPrice: 500, purchaseUnit: "DRUM-UNKNOWN-JEST",
    });
    const res = await request(app).get(`/api/reports/supplier-comparison?itemId=${cheeseId}`).set(authed(adminToken));
    const row = res.body.suppliers.find((s) => s.supplierId === noConvSupplier.body.id);
    expect(row.incomplete).toBe(true);
    expect(row.normalizedCost).toBeNull();
    // الصفوف incomplete لازم تتحط آخر الترتيب، مش تتخلط بأسعار حقيقية
    expect(res.body.suppliers[res.body.suppliers.length - 1].supplierId).toBe(noConvSupplier.body.id);
  });
});

describe("3) توصيات الشراء - أصناف تحت حد إعادة الطلب", () => {
  test("جبنة تحت الحد (20 <= reorder_point=15؟ لأ - نخليها فعلاً تحت الحد أولًا)", async () => {
    // الرصيد الحالي 20، الحد 15 - مش تحت الحد لسه. نعدّل الرصيد يدويًا لمحاكاة استهلاك (تسوية جرد حقيقية)
    await request(app).post("/api/inventory/stock/adjust").set(authed(managerToken))
      .send({ branchId, inventoryItemId: cheeseId, quantity: -10, movementType: "adjustment" }); // 20-10=10 <= 15

    const res = await request(app).get(`/api/reports/purchasing-recommendations?branchId=${branchId}`).set(authed(adminToken));
    expect(res.status).toBe(200);
    const row = res.body.find((r) => r.inventoryItemId === cheeseId);
    expect(row).toBeTruthy();
    expect(row.currentQuantity).toBe(10);
    expect(row.reorderPoint).toBe(15);
    expect(row.suggestedOrderQuantity).toBeCloseTo(40, 5); // maxStock(50) - current(10)

    // المورد المحظور والمورد بلا تحويل مستبعدين، الأرخص الفعلي (مورد ج، 200) هو الموصى بيه
    expect(row.recommendedSupplier.supplierId).toBe(supplierCId);
    expect(row.recommendedSupplier.reason).toBe("cheapest");
  });

  test("تفضيل preferred_supplier حتى لو مش الأرخص", async () => {
    await request(app).post(`/api/suppliers/${supplierAId}/price-history`).set(authed(adminToken)).send({
      inventoryItemId: cheeseId, unitPrice: 260, purchaseUnit: "KG", preferredSupplier: true,
    });
    const res = await request(app).get(`/api/reports/purchasing-recommendations?branchId=${branchId}`).set(authed(adminToken));
    const row = res.body.find((r) => r.inventoryItemId === cheeseId);
    expect(row.recommendedSupplier.supplierId).toBe(supplierAId); // مش الأرخص (260 > 200) بس preferred
    expect(row.recommendedSupplier.reason).toBe("preferred");
  });

  test("صنف فوق حد إعادة الطلب متظهرش في التوصيات، وفرع من غير حدود متظهرش أصلًا", async () => {
    const aboveItem = await pool.query("INSERT INTO inventory_items (name, unit) VALUES ('صنف-فوق-الحد-جست', 'KG') RETURNING id");
    await pool.query(
      "INSERT INTO branch_inventory_stock (branch_id, inventory_item_id, quantity, reorder_point) VALUES ($1,$2,100,10)",
      [branchId, aboveItem.rows[0].id]
    );
    const res = await request(app).get(`/api/reports/purchasing-recommendations?branchId=${branchId}`).set(authed(adminToken));
    expect(res.body.some((r) => r.inventoryItemId === aboveItem.rows[0].id)).toBe(false);

    const otherRes = await request(app).get(`/api/reports/purchasing-recommendations?branchId=${otherBranchId}`).set(authed(adminToken));
    expect(otherRes.body.length).toBe(0);
  });

  test("مدير فرع تاني ممنوع يشوف توصيات فرع مش بتاعه (branchId بيتحدد من التوكن مش من الكويري)", async () => {
    const res = await request(app).get(`/api/reports/purchasing-recommendations?branchId=${branchId}`).set(authed(otherManagerToken));
    expect(res.status).toBe(200);
    // مفروض يرجّع بيانات فرعه هو (otherBranchId) مش فرع branchId اللي طلبه - مفيش صنف جبنة-حدود-جست فيها
    expect(res.body.some((r) => r.inventoryItemId === cheeseId)).toBe(false);
  });
});
