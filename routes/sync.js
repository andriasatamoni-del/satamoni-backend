const express = require("express");
const router = express.Router();
const pool = require("../db/pool");

// المزامنة بتستخدم مفتاح ثابت بين السيرفرات (مش توكن مستخدم) - لازم يتحدد SYNC_API_KEY
// على السيرفر المركزي، وإلا المزامنة تبقى متعطّلة تمامًا (أمان افتراضي: مقفولة).
function requireSyncAuth(req, res, next) {
  const key = process.env.SYNC_API_KEY;
  if (!key) return res.status(503).json({ error: "المزامنة المركزية مش مفعّلة على السيرفر ده" });
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token || token !== key) return res.status(401).json({ error: "مفتاح مزامنة غلط" });
  next();
}
router.use(requireSyncAuth);

async function assertBranchExists(branchId) {
  const result = await pool.query("SELECT id FROM branches WHERE id = $1", [branchId]);
  return result.rows.length > 0;
}

// POST /api/sync/heartbeat - {branchId} - المرحلة 8.43: بتترفع كل دورة مزامنة (كل SYNC_INTERVAL_SECONDS)
// من db/sync-worker.js بغض النظر عن وجود بيانات جديدة تترفع أصلًا (orders/expenses/purchases لو كانت
// صفر، ده كان معناه إن last_synced_at مش هيتحدّث خالص حتى لو الفرع متصل تمام - مجرد مفيش عمليات جديدة).
// نجاح النداء ده لوحده كافي كإشارة "وصلنا للمركزي فعليًا في الدورة دي" - مش مربوط بأي جدول بيانات تاني
router.post("/heartbeat", async (req, res) => {
  const { branchId } = req.body;
  if (!branchId) return res.status(400).json({ error: "بيانات ناقصة" });
  if (!(await assertBranchExists(branchId))) {
    return res.status(400).json({ error: `مفيش فرع بالرقم ${branchId} في السيرفر المركزي` });
  }
  await pool.query("UPDATE branches SET last_synced_at = now() WHERE id = $1", [branchId]);
  res.json({ ok: true });
});

// POST /api/sync/orders
// ملاحظة: مش بنحاول نربط delivery_area_id/payment_method_id/item_id/variant_id/created_by/
// voided_by/discount_approved_by بالمركزي، لأن IDs الفرع المحلي منفصلة تمامًا عن IDs المركزي
// (نفس المستخدم/الصنف ممكن يكون بأرقام مختلفة تمامًا محليًا ومركزيًا). النسخة المركزية للتقارير
// المجمّعة (الإيرادات/التكلفة/الربح) بس، مش لإعادة فتح/تعديل الطلب من هناك.
// status/payment_status/voided قابلين للتحديث لو الطلب اتغيّر محليًا بعد أول مزامنة (زي استرجاع
// طلب بعد ما كان اتبعت أصلًا) - عشان كده ON CONFLICT بيعمل UPDATE مش DO NOTHING، وبنمسح order_items
// القديمة ونعيد إدخالها من جديد في كل مزامنة (مفيش هوية ثابتة لكل سطر صنف يوضح إنه هو نفسه القديم).
// المرحلة 6 (6G): كان في الأول بيعمل INSERT/UPDATE منفصل لكل طلب في الحلقة (+DELETE وINSERT منفصلين
// لكل سطر صنف جواه) - N+1 حقيقي على مسار المزامنة نفسه (لو فرع اتقطع نت يوم كامل وبعدين رجع، batch
// المزامنة ممكن يوصل مئات الطلبات دفعة واحدة، يعني مئات الرحلات المتتالية لقاعدة البيانات، كل واحدة
// مستنية رد اللي قبلها - على شبكة حقيقية بينها وبين قاعدة البيانات المركزية ده تأخير كبير محسوس، مش
// بس على localhost). دلوقتي كل الطلبات في الـbatch بتتعمل upsert في استعلام واحد بس (UNNEST)، وكل سطور
// الأصناف كمان استعلام واحد بس - العدد الكلي للرحلات لقاعدة البيانات بقى ثابت (3) مهما كان حجم الـbatch.
//
// ملحوظة: لو نفس sync_uuid اتكرر أكتر من مرة جوه نفس الـbatch (مش متوقع عمليًا - كل طلب بيتولّد له
// sync_uuid واحد بس عند إنشائه محليًا - لكن للأمان)، بنحتفظ بآخر ظهور بس قبل الـupsert، لأن ON CONFLICT
// DO UPDATE في نفس استعلام الـINSERT مبيقدرش يعالج نفس صف الصراع مرتين (Postgres بيرمي خطأ صريح لو
// حاولنا) - وده أصلًا نفس سلوك الكود القديم اللي كان بيعالج كل تكرار بالتتابع فآخر واحد هو اللي بيفضل
router.post("/orders", async (req, res) => {
  const { branchId, orders } = req.body;
  if (!branchId || !Array.isArray(orders)) return res.status(400).json({ error: "بيانات ناقصة" });
  if (!(await assertBranchExists(branchId))) {
    return res.status(400).json({ error: `مفيش فرع بالرقم ${branchId} في السيرفر المركزي` });
  }
  if (orders.length === 0) return res.json({ ok: true, processed: 0, received: 0 });

  const bySyncUuid = new Map();
  for (const o of orders) bySyncUuid.set(o.sync_uuid, o); // آخر ظهور بيكسب
  const uniqueOrders = [...bySyncUuid.values()];

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const source = [], orderType = [], tableNumber = [], addressDetails = [], customerName = [], customerPhone = [];
    const subtotal = [], deliveryFee = [], discount = [], total = [], status = [], paymentStatus = [];
    const voided = [], voidReason = [], createdAt = [], syncUuid = [];
    for (const o of uniqueOrders) {
      source.push(o.source); orderType.push(o.order_type); tableNumber.push(o.table_number);
      addressDetails.push(o.address_details); customerName.push(o.customer_name); customerPhone.push(o.customer_phone);
      subtotal.push(o.subtotal); deliveryFee.push(o.delivery_fee); discount.push(o.discount); total.push(o.total);
      status.push(o.status); paymentStatus.push(o.payment_status);
      voided.push(o.voided || false); voidReason.push(o.void_reason || null);
      createdAt.push(o.created_at); syncUuid.push(o.sync_uuid);
    }

    const upsertRes = await client.query(
      `INSERT INTO orders
        (branch_id, source, order_type, table_number, address_details,
         customer_name, customer_phone, subtotal, delivery_fee, discount, total,
         status, payment_status, voided, void_reason, created_at, sync_uuid, synced_at)
       SELECT $1, s.source, s.order_type, s.table_number, s.address_details, s.customer_name, s.customer_phone,
              s.subtotal, s.delivery_fee, s.discount, s.total, s.status, s.payment_status, s.voided, s.void_reason,
              s.created_at, s.sync_uuid, now()
       FROM UNNEST($2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[],
                    $8::numeric[], $9::numeric[], $10::numeric[], $11::numeric[], $12::text[], $13::text[],
                    $14::boolean[], $15::text[], $16::timestamptz[], $17::uuid[])
         AS s(source, order_type, table_number, address_details, customer_name, customer_phone,
              subtotal, delivery_fee, discount, total, status, payment_status, voided, void_reason, created_at, sync_uuid)
       ON CONFLICT (sync_uuid) DO UPDATE SET
         status = EXCLUDED.status,
         payment_status = EXCLUDED.payment_status,
         voided = EXCLUDED.voided,
         void_reason = EXCLUDED.void_reason,
         synced_at = now()
       RETURNING id, sync_uuid`,
      [branchId, source, orderType, tableNumber, addressDetails, customerName, customerPhone,
       subtotal, deliveryFee, discount, total, status, paymentStatus, voided, voidReason, createdAt, syncUuid]
    );

    const orderIdBySyncUuid = new Map(upsertRes.rows.map((r) => [r.sync_uuid, r.id]));
    const orderIds = upsertRes.rows.map((r) => r.id);

    await client.query("DELETE FROM order_items WHERE order_id = ANY($1::int[])", [orderIds]);

    const itemOrderId = [], itemQuantity = [], itemUnitPrice = [], itemLineTotal = [], itemCostAtSale = [], itemCostIncomplete = [];
    for (const o of uniqueOrders) {
      const orderId = orderIdBySyncUuid.get(o.sync_uuid);
      for (const it of o.items || []) {
        itemOrderId.push(orderId); itemQuantity.push(it.quantity); itemUnitPrice.push(it.unit_price);
        itemLineTotal.push(it.line_total); itemCostAtSale.push(it.cost_at_sale ?? null);
        itemCostIncomplete.push(it.cost_at_sale_incomplete || false);
      }
    }
    if (itemOrderId.length > 0) {
      await client.query(
        `INSERT INTO order_items (order_id, quantity, unit_price, line_total, cost_at_sale, cost_at_sale_incomplete)
         SELECT * FROM UNNEST($1::int[], $2::int[], $3::numeric[], $4::numeric[], $5::numeric[], $6::boolean[])`,
        [itemOrderId, itemQuantity, itemUnitPrice, itemLineTotal, itemCostAtSale, itemCostIncomplete]
      );
    }

    await client.query("COMMIT");
    res.json({ ok: true, processed: orders.length, received: orders.length });
  } catch (err) {
    await client.query("ROLLBACK");
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// POST /api/sync/daily_cash_sessions
router.post("/daily_cash_sessions", async (req, res) => {
  const { branchId, rows } = req.body;
  if (!branchId || !Array.isArray(rows)) return res.status(400).json({ error: "بيانات ناقصة" });
  if (!(await assertBranchExists(branchId))) {
    return res.status(400).json({ error: `مفيش فرع بالرقم ${branchId} في السيرفر المركزي` });
  }
  try {
    let upserted = 0;
    for (const r of rows) {
      await pool.query(
        `INSERT INTO daily_cash_sessions
          (branch_id, business_date, opening_cash, cash_sales, card_sales, credit_sales,
           delivery_app_sales, cash_paid_to_kitchen, other_cash_payments,
           expected_closing_cash, actual_counted_cash, cash_difference, sync_uuid, synced_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, now())
         ON CONFLICT (sync_uuid) DO UPDATE SET
           opening_cash = EXCLUDED.opening_cash,
           cash_sales = EXCLUDED.cash_sales,
           card_sales = EXCLUDED.card_sales,
           credit_sales = EXCLUDED.credit_sales,
           delivery_app_sales = EXCLUDED.delivery_app_sales,
           cash_paid_to_kitchen = EXCLUDED.cash_paid_to_kitchen,
           other_cash_payments = EXCLUDED.other_cash_payments,
           expected_closing_cash = EXCLUDED.expected_closing_cash,
           actual_counted_cash = EXCLUDED.actual_counted_cash,
           cash_difference = EXCLUDED.cash_difference,
           updated_at = now(),
           synced_at = now()`,
        [branchId, r.business_date, r.opening_cash, r.cash_sales, r.card_sales, r.credit_sales,
         r.delivery_app_sales, r.cash_paid_to_kitchen, r.other_cash_payments,
         r.expected_closing_cash, r.actual_counted_cash, r.cash_difference, r.sync_uuid]
      );
      upserted++;
    }
    res.json({ ok: true, upserted, received: rows.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// بند المصروف بيتبعت بالاسم (categoryName) مش بالـ id، لأن expense_categories.id محلي للفرع ومختلف
// عن المركزي - بندوّر على بند بنفس الاسم في المركزي، ولو مش موجود بننشئه (findOrCreate)
async function findOrCreateExpenseCategory(client, name) {
  const existing = await client.query("SELECT id FROM expense_categories WHERE name = $1", [name]);
  if (existing.rows.length > 0) return existing.rows[0].id;
  const created = await client.query(
    "INSERT INTO expense_categories (name) VALUES ($1) RETURNING id",
    [name]
  );
  return created.rows[0].id;
}

// POST /api/sync/expenses
router.post("/expenses", async (req, res) => {
  const { branchId, rows } = req.body;
  if (!branchId || !Array.isArray(rows)) return res.status(400).json({ error: "بيانات ناقصة" });
  if (!(await assertBranchExists(branchId))) {
    return res.status(400).json({ error: `مفيش فرع بالرقم ${branchId} في السيرفر المركزي` });
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    let inserted = 0;
    for (const r of rows) {
      const categoryId = await findOrCreateExpenseCategory(client, r.category_name);
      const result = await client.query(
        `INSERT INTO expenses (branch_id, business_date, category_id, amount, notes, sync_uuid, synced_at)
         VALUES ($1,$2,$3,$4,$5,$6, now())
         ON CONFLICT (sync_uuid) DO NOTHING
         RETURNING id`,
        [branchId, r.business_date, categoryId, r.amount, r.notes, r.sync_uuid]
      );
      if (result.rows.length > 0) inserted++;
    }
    await client.query("COMMIT");
    res.json({ ok: true, inserted, received: rows.length });
  } catch (err) {
    await client.query("ROLLBACK");
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// POST /api/sync/purchases
router.post("/purchases", async (req, res) => {
  const { branchId, rows } = req.body;
  if (!branchId || !Array.isArray(rows)) return res.status(400).json({ error: "بيانات ناقصة" });
  if (!(await assertBranchExists(branchId))) {
    return res.status(400).json({ error: `مفيش فرع بالرقم ${branchId} في السيرفر المركزي` });
  }
  try {
    let inserted = 0;
    for (const r of rows) {
      const result = await pool.query(
        `INSERT INTO purchases (branch_id, business_date, category, amount, from_kitchen, notes, sync_uuid, synced_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7, now())
         ON CONFLICT (sync_uuid) DO NOTHING
         RETURNING id`,
        [branchId, r.business_date, r.category, r.amount, r.from_kitchen, r.notes, r.sync_uuid]
      );
      if (result.rows.length > 0) inserted++;
    }
    res.json({ ok: true, inserted, received: rows.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
