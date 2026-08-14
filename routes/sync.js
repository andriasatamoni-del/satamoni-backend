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

// POST /api/sync/orders
// ملاحظة: مش بنحاول نربط delivery_area_id/payment_method_id/item_id/variant_id/created_by
// بالمركزي، لأن IDs الفرع المحلي منفصلة تمامًا عن IDs المركزي. النسخة المركزية للتقارير
// (الأرقام) بس، مش لإعادة فتح/تعديل الطلب من هناك.
router.post("/orders", async (req, res) => {
  const { branchId, orders } = req.body;
  if (!branchId || !Array.isArray(orders)) return res.status(400).json({ error: "بيانات ناقصة" });
  if (!(await assertBranchExists(branchId))) {
    return res.status(400).json({ error: `مفيش فرع بالرقم ${branchId} في السيرفر المركزي` });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    let inserted = 0;
    for (const o of orders) {
      const result = await client.query(
        `INSERT INTO orders
          (branch_id, source, order_type, table_number, address_details,
           customer_name, customer_phone, subtotal, delivery_fee, discount, total,
           status, created_at, sync_uuid, synced_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14, now())
         ON CONFLICT (sync_uuid) DO NOTHING
         RETURNING id`,
        [branchId, o.source, o.order_type, o.table_number, o.address_details,
         o.customer_name, o.customer_phone, o.subtotal, o.delivery_fee, o.discount, o.total,
         o.status, o.created_at, o.sync_uuid]
      );
      if (result.rows.length > 0) {
        inserted++;
        const orderId = result.rows[0].id;
        for (const it of o.items || []) {
          await client.query(
            `INSERT INTO order_items (order_id, quantity, unit_price, line_total)
             VALUES ($1, $2, $3, $4)`,
            [orderId, it.quantity, it.unit_price, it.line_total]
          );
        }
      }
    }
    await client.query("COMMIT");
    res.json({ ok: true, inserted, received: orders.length });
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

// POST /api/sync/expenses
router.post("/expenses", async (req, res) => {
  const { branchId, rows } = req.body;
  if (!branchId || !Array.isArray(rows)) return res.status(400).json({ error: "بيانات ناقصة" });
  if (!(await assertBranchExists(branchId))) {
    return res.status(400).json({ error: `مفيش فرع بالرقم ${branchId} في السيرفر المركزي` });
  }
  try {
    let inserted = 0;
    for (const r of rows) {
      const result = await pool.query(
        `INSERT INTO expenses (branch_id, business_date, category, amount, notes, sync_uuid, synced_at)
         VALUES ($1,$2,$3,$4,$5,$6, now())
         ON CONFLICT (sync_uuid) DO NOTHING
         RETURNING id`,
        [branchId, r.business_date, r.category, r.amount, r.notes, r.sync_uuid]
      );
      if (result.rows.length > 0) inserted++;
    }
    res.json({ ok: true, inserted, received: rows.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
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
