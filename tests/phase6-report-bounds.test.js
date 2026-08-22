// المرحلة 6 (6G): تقارير كانت من غير حدود واضحة على حجم البيانات اللي بتمسحها/بترجّعها:
// - purchasing-recommendations: كان بيبعت query منفصل لكل صنف تحت نقطة إعادة الطلب (N+1 حقيقي)،
//   دلوقتي استعلام واحد مجمّع - هنا بنتأكد إن منطق "أرخص مورد/المورد المفضّل" اتحفظ بالظبط بعد التجميع
// - general-ledger: كان بيرجّع كل تاريخ الحساب من غير from - دلوقتي افتراضيًا آخر سنة بس + LIMIT
// - catalog: كان الافتراضي "من أول الزمن" (1900-2999) - دلوقتي آخر 90 يوم بس
const { app, request, pool, seedUser, login, authed } = require("./helpers");

let branchId, adminToken;

async function accountId(code) {
  const r = await pool.query("SELECT id FROM accounts WHERE code = $1", [code]);
  return r.rows[0].id;
}

beforeAll(async () => {
  const b = await pool.query("INSERT INTO branches (name) VALUES ('فرع حدود التقارير-جست') RETURNING id");
  branchId = b.rows[0].id;
  await seedUser({ name: "أدمن-حدود-تقارير", email: "admin-reportbounds@jest.test", role: "admin" });
  adminToken = await login("admin-reportbounds@jest.test");
});

afterAll(async () => {
  await pool.end();
});

describe("6G: GET /api/reports/purchasing-recommendations - المنطق اتحفظ بعد إزالة N+1", () => {
  test("مورد مفضّل بيتفضّل حتى لو مش الأرخص، ولو مفيش مفضّل بياخد الأرخص - لكل صنف لوحده بعد التجميع الدفعي", async () => {
    const item1 = await pool.query("INSERT INTO inventory_items (name, unit) VALUES ('صنف-حدود-1', 'KG') RETURNING id");
    const item2 = await pool.query("INSERT INTO inventory_items (name, unit) VALUES ('صنف-حدود-2', 'KG') RETURNING id");
    const item1Id = item1.rows[0].id, item2Id = item2.rows[0].id;
    await pool.query(
      "INSERT INTO branch_inventory_stock (branch_id, inventory_item_id, quantity, reorder_point, max_stock) VALUES ($1,$2,5,20,100), ($1,$3,5,20,100)",
      [branchId, item1Id, item2Id]
    );

    const supA = await pool.query("INSERT INTO suppliers (name, status) VALUES ('مورد-حدود-أ', 'ACTIVE') RETURNING id");
    const supB = await pool.query("INSERT INTO suppliers (name, status) VALUES ('مورد-حدود-ب', 'ACTIVE') RETURNING id");
    const supAId = supA.rows[0].id, supBId = supB.rows[0].id;

    // الصنف 1: مورد أ أرخص (10) بس مورد ب هو المفضّل (15) - المفروض المفضّل يتختار رغم إنه أغلى
    await pool.query(
      "INSERT INTO supplier_items (supplier_id, inventory_item_id, unit_price, purchase_unit, preferred_supplier) VALUES ($1,$2,10,'KG',false), ($3,$2,15,'KG',true)",
      [supAId, item1Id, supBId]
    );
    // الصنف 2: مفيش مفضّل - المفروض الأرخص (مورد أ بـ8) يتختار
    await pool.query(
      "INSERT INTO supplier_items (supplier_id, inventory_item_id, unit_price, purchase_unit, preferred_supplier) VALUES ($1,$2,8,'KG',false), ($3,$2,12,'KG',false)",
      [supAId, item2Id, supBId]
    );

    const res = await request(app).get(`/api/reports/purchasing-recommendations?branchId=${branchId}`).set(authed(adminToken));
    expect(res.status).toBe(200);
    const rec1 = res.body.find((r) => r.inventoryItemId === item1Id);
    const rec2 = res.body.find((r) => r.inventoryItemId === item2Id);
    expect(rec1.recommendedSupplier.supplierId).toBe(supBId);
    expect(rec1.recommendedSupplier.reason).toBe("preferred");
    expect(rec2.recommendedSupplier.supplierId).toBe(supAId);
    expect(rec2.recommendedSupplier.reason).toBe("cheapest");
    expect(rec2.recommendedSupplier.normalizedCost).toBe(8);
  });
});

describe("6G: GET /api/reports/general-ledger - محدود بسنة افتراضيًا بدل كل التاريخ", () => {
  test("من غير from - بيرجّع from تلقائي آخر سنة تقريبًا (مش null ولا من أول الزمن)، مع علم truncated", async () => {
    const cashAccountId = await accountId("1100");
    const res = await request(app).get(`/api/reports/general-ledger?accountId=${cashAccountId}`).set(authed(adminToken));
    expect(res.status).toBe(200);
    expect(res.body.from).toBeTruthy();
    const fromDate = new Date(res.body.from);
    const daysAgo = (Date.now() - fromDate.getTime()) / (1000 * 60 * 60 * 24);
    expect(daysAgo).toBeGreaterThan(360);
    expect(daysAgo).toBeLessThan(370);
    expect(res.body).toHaveProperty("truncated");
    expect(res.body.truncated).toBe(false);
  });

  test("لسه ممكن تحدد from صراحة لمراجعة تاريخية أبعد من سنة", async () => {
    const cashAccountId = await accountId("1100");
    const res = await request(app).get(`/api/reports/general-ledger?accountId=${cashAccountId}&from=2020-01-01`).set(authed(adminToken));
    expect(res.status).toBe(200);
    expect(res.body.from).toBe("2020-01-01");
  });
});

describe("6G: GET /api/reports/catalog - محدود بآخر 90 يوم افتراضيًا بدل كل التاريخ", () => {
  test("من غير from/to - الرد بيرجع بنجاح بمدى آخر 90 يوم تقريبًا (مش 1900)", async () => {
    const res = await request(app).get("/api/reports/catalog").set(authed(adminToken));
    expect(res.status).toBe(200);
    expect(res.body.from).not.toBe("1900-01-01");
    const fromDate = new Date(res.body.from);
    const daysAgo = (Date.now() - fromDate.getTime()) / (1000 * 60 * 60 * 24);
    expect(daysAgo).toBeGreaterThan(85);
    expect(daysAgo).toBeLessThan(95);
    expect(Array.isArray(res.body.items)).toBe(true);
  });
});
