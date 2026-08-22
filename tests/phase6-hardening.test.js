// المرحلة 6: تدقيق وتقوية الجاهزية للإنتاج - يبني على تدقيق المرحلة 5 (Phase 5) كنقطة بداية معتمدة.
// هذا الملف يغطي بالتحديد: 6A.1 (محاسبة تحويل المخزون بين الفروع - الجزء العام مغطى في
// phase5-integration.test.js ضمن Flow E، هنا اختبار وحدة مباشر لإصلاح consumeFromBatches نفسه)
const { pool } = require("./helpers");
const { consumeFromBatches } = require("../db/inventory-ledger");

describe("6A.1 (إصلاح جانبي حقيقي اتكشف أثناء بناء محاسبة التحويل): consumeFromBatches - كمية مطلوبة أكبر من رصيد الدفعات المتاحة", () => {
  let branchId, itemId;

  beforeAll(async () => {
    const b = await pool.query("INSERT INTO branches (name) VALUES ('فرع-م6-دفعات-جست') RETURNING id");
    branchId = b.rows[0].id;
    const item = await pool.query("INSERT INTO inventory_items (name, unit, unit_cost) VALUES ('صنف-م6-دفعات-جست', 'KG', 0) RETURNING id");
    itemId = item.rows[0].id;
    await pool.query("INSERT INTO branch_inventory_stock (branch_id, inventory_item_id, quantity) VALUES ($1,$2,20)", [branchId, itemId]);
    // دفعة واحدة بس فيها 8 كيلو (أقل من الـ15 كيلو المطلوبة تحت) - الباقي (7 كيلو) من رصيد غير متتبّع بدفعات
    await pool.query(
      `INSERT INTO inventory_batches (inventory_item_id, branch_id, received_date, original_quantity, remaining_quantity, unit_cost, status)
       VALUES ($1,$2,CURRENT_DATE,8,8,30,'active')`,
      [itemId, branchId]
    );
  });

  afterAll(async () => {
    await pool.end();
  });

  test("قبل الإصلاح: الباقي (غير المغطى بدفعة) كان بيضيع من consumed تمامًا رغم إنه محسوب في التكلفة - دلوقتي بيرجع كجزء صريح", async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await consumeFromBatches(client, { branchId, inventoryItemId: itemId, quantity: 15 });
      expect(result).toBeTruthy();
      // المجموع الكلي لكل أجزاء consumed لازم يساوي الكمية المطلوبة بالظبط - مفيش أي جزء بيضيع
      const totalConsumed = result.consumed.reduce((s, p) => s + Number(p.quantity), 0);
      expect(totalConsumed).toBe(15);
      // جزء من دفعة حقيقية (8 كيلو) + جزء تاني batchId=null يمثل الباقي غير المتتبّع (7 كيلو)
      const batchPart = result.consumed.find((p) => p.batchId !== null);
      const looseePart = result.consumed.find((p) => p.batchId === null);
      expect(Number(batchPart.quantity)).toBe(8);
      expect(Number(looseePart.quantity)).toBe(7);
      expect(Number(looseePart.unitCost)).toBe(30); // بياخد تكلفة آخر دفعة اتصرف منها كتقريب معقول
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  });
});
