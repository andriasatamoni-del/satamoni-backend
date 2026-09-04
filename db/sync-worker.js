// بيشتغل على سيرفر الفرع المحلي بس. كل شوية بيدور على أي بيانات لسه ما اترفعتش
// للسيرفر المركزي، ويحاول يبعتها. لو الإنترنت مقطوع أو السيرفر المركزي مش متاح،
// بيسجل الخطأ ويحاول تاني في الدورة الجاية - من غير ما يوقف السيرفر المحلي أو يوقف
// الكاشير عن الشغل.
require("dotenv").config();
const pool = require("./pool");

const CENTRAL_URL = process.env.CENTRAL_SYNC_URL;
const SYNC_KEY = process.env.SYNC_API_KEY;
const BRANCH_ID = process.env.CENTRAL_BRANCH_ID;
const INTERVAL_MS = (Number(process.env.SYNC_INTERVAL_SECONDS) || 300) * 1000;
const BATCH_LIMIT = 200;

const SIMPLE_TABLES = ["daily_cash_sessions", "purchases"];

if (!CENTRAL_URL || !SYNC_KEY || !BRANCH_ID) {
  console.log(
    "[sync] CENTRAL_SYNC_URL / SYNC_API_KEY / CENTRAL_BRANCH_ID مش متحددين — " +
    "المزامنة المركزية متوقفة (السيستم المحلي شغال عادي من غيرها)."
  );
  process.exit(0);
}

async function postJson(path, body) {
  const res = await fetch(`${CENTRAL_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${SYNC_KEY}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${res.status} ${text}`);
  }
  return res.json();
}

async function syncOrders() {
  // status/payment_status/voided/discount بيترجعوا NULL لـ synced_at (من routes/orders.js) لما
  // يتغيّروا بعد أول مزامنة - عشان كده نفس الشرط (synced_at IS NULL) بيلقط الطلبات الجديدة
  // والطلبات القديمة اللي اتغيّرت محليًا (زي استرجاع Void) في نفس الوقت
  const { rows: orders } = await pool.query(
    `SELECT * FROM orders WHERE synced_at IS NULL ORDER BY id LIMIT $1`,
    [BATCH_LIMIT]
  );
  if (orders.length === 0) return 0;

  const orderIds = orders.map((o) => o.id);
  const { rows: items } = await pool.query(
    `SELECT * FROM order_items WHERE order_id = ANY($1)`,
    [orderIds]
  );

  const payload = orders.map((o) => ({
    sync_uuid: o.sync_uuid,
    order_type: o.order_type,
    source: o.source,
    table_number: o.table_number,
    address_details: o.address_details,
    customer_name: o.customer_name,
    customer_phone: o.customer_phone,
    subtotal: o.subtotal,
    delivery_fee: o.delivery_fee,
    discount: o.discount,
    total: o.total,
    status: o.status,
    payment_status: o.payment_status,
    voided: o.voided,
    void_reason: o.void_reason,
    created_at: o.created_at,
    items: items
      .filter((it) => it.order_id === o.id)
      .map((it) => ({
        quantity: it.quantity, unit_price: it.unit_price, line_total: it.line_total,
        cost_at_sale: it.cost_at_sale, cost_at_sale_incomplete: it.cost_at_sale_incomplete,
      })),
  }));

  await postJson("/api/sync/orders", { branchId: BRANCH_ID, orders: payload });
  await pool.query(`UPDATE orders SET synced_at = now() WHERE id = ANY($1)`, [orderIds]);
  return orders.length;
}

async function syncExpenses() {
  // بنبعت اسم البند (category_name) مش الـ id، لأن expense_categories.id محلي وممكن يختلف عن
  // نفس البند بالمركزي - المركزي بيدوّر/ينشئ بند بنفس الاسم (findOrCreate) لوحده
  const { rows } = await pool.query(
    `SELECT e.*, ec.name AS category_name
     FROM expenses e
     JOIN expense_categories ec ON ec.id = e.category_id
     WHERE e.synced_at IS NULL ORDER BY e.id LIMIT $1`,
    [BATCH_LIMIT]
  );
  if (rows.length === 0) return 0;

  await postJson("/api/sync/expenses", { branchId: BRANCH_ID, rows });
  const ids = rows.map((r) => r.id);
  await pool.query(`UPDATE expenses SET synced_at = now() WHERE id = ANY($1)`, [ids]);
  return rows.length;
}

async function syncSimpleTable(table) {
  if (!SIMPLE_TABLES.includes(table)) throw new Error(`جدول مزامنة غير معروف: ${table}`);
  const staleCondition = table === "daily_cash_sessions"
    ? "(synced_at IS NULL OR updated_at > synced_at)"
    : "synced_at IS NULL";
  const { rows } = await pool.query(
    `SELECT * FROM ${table} WHERE ${staleCondition} ORDER BY id LIMIT $1`,
    [BATCH_LIMIT]
  );
  if (rows.length === 0) return 0;

  await postJson(`/api/sync/${table}`, { branchId: BRANCH_ID, rows });
  const ids = rows.map((r) => r.id);
  await pool.query(`UPDATE ${table} SET synced_at = now() WHERE id = ANY($1)`, [ids]);
  return rows.length;
}

// المرحلة 8.43: نبضة بسيطة بتترفع كل دورة بغض النظر عن وجود بيانات جديدة - عشان لو الفرع متصل بس هادي
// (مفيش أوردرات جديدة في آخر دورة) branches.last_synced_at يفضل محدّث برضو، مش يبان "قاطع" غلط
async function sendHeartbeat() {
  await postJson("/api/sync/heartbeat", { branchId: BRANCH_ID });
}

async function runOnce() {
  const results = {};
  try {
    await sendHeartbeat();
    results.orders = await syncOrders();
    results.expenses = await syncExpenses();
    for (const table of SIMPLE_TABLES) {
      results[table] = await syncSimpleTable(table);
    }
    const total = Object.values(results).reduce((s, n) => s + n, 0);
    if (total > 0) {
      console.log(`[sync] اترفع: ${JSON.stringify(results)}`);
    }
  } catch (err) {
    console.log(`[sync] فشلت المحاولة دي (هيتعاد المحاولة تلقائيًا بعد ${INTERVAL_MS / 1000} ثانية): ${err.message}`);
  }
}

console.log(`[sync] شغالة كل ${INTERVAL_MS / 1000} ثانية، بترفع لـ ${CENTRAL_URL} كفرع رقم ${BRANCH_ID}`);
runOnce();
setInterval(runOnce, INTERVAL_MS);
