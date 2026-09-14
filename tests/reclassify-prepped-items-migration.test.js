// ترحيل 0044: أصناف "برسيون ..."/"عجين ..."/فيها "مصنع" في الاسم المفروض تبقى item_type='manufactured'
// مش 'raw' (كانت بتتسجل raw بالغلط وقت الاستيراد الأول). ضد Postgres حقيقي.
const { pool } = require("./helpers");
const migration = require("../db/migrations/0044_reclassify_prepped_items_as_manufactured");

async function addItem(name, itemType) {
  const result = await pool.query(
    "INSERT INTO inventory_items (name, unit, item_type) VALUES ($1,'قطعة',$2) RETURNING id",
    [name, itemType]
  );
  return result.rows[0].id;
}

afterAll(async () => {
  await pool.end();
});

describe("ترحيل 0044: إعادة تصنيف الأصناف المتجهزة كـmanufactured", () => {
  test("أصناف برسيون/عجين/فيها مصنع في الاسم بتتحول من raw لـmanufactured، وباقي الأصناف متتأثرش", async () => {
    const bersyonId = await addItem("برسيون بسطرمة صغير-جست0044", "raw");
    const dough1Id = await addItem("عجين بيتزا-جست0044", "raw");
    const dough2Id = await addItem("عجين كريب (مصنع بالمطعم)-جست0044", "raw"); // فيه الكلمتين مع بعض
    const sauceId = await addItem("صلصة مصنع-جست0044", "raw");
    const untouchedRawId = await addItem("طماطم-جست0044", "raw"); // ملوش علاقة - المفروض يفضل raw
    const alreadyManufacturedId = await addItem("برسيون جبنة-جست0044", "manufactured"); // idempotency

    await migration.up(pool);

    const result = await pool.query(
      "SELECT id, item_type FROM inventory_items WHERE id = ANY($1)",
      [[bersyonId, dough1Id, dough2Id, sauceId, untouchedRawId, alreadyManufacturedId]]
    );
    const byId = Object.fromEntries(result.rows.map((r) => [r.id, r.item_type]));

    expect(byId[bersyonId]).toBe("manufactured");
    expect(byId[dough1Id]).toBe("manufactured");
    expect(byId[dough2Id]).toBe("manufactured");
    expect(byId[sauceId]).toBe("manufactured");
    expect(byId[untouchedRawId]).toBe("raw");
    expect(byId[alreadyManufacturedId]).toBe("manufactured");
  });

  test("تشغيله تاني (idempotency) - مبيرميش استثناء ومبيغيّرش حاجة تاني", async () => {
    await expect(migration.up(pool)).resolves.not.toThrow();
  });
});
