// المرحلة 8.16: رقم أوردر طلبات (لسهولة المراجعة) + تقسيم دفع أوردر طلبات (جزء نقدي محصّل في الفرع +
// الباقي مستحق من شركة طلبات - حساب 1350). ضد Postgres حقيقي. بيغطي: تسجيل الرقم، افتراضي بدون تقسيم
// (سطر مدين واحد كامل على 1350 زي ما كان دايمًا)، تقسيم صحيح (سطرين: كاش الفرع + الباقي على 1350)،
// رفض مبلغ نقدي أكبر من الإجمالي أو سالب، تجاهل القيمة تمامًا لأي أوردر مش طلبات، وتأثيرها الصحيح على
// معادلة الكاش المتوقع للشيفت (db/shift-engine.js + GET /api/cash-sessions/expected).
const { app, request, pool, seedUser, login, authed } = require("./helpers");

let branchA;
let cashierToken;
let creditPmId, cashPmId;
let itemId, variantId;

beforeAll(async () => {
  const bA = await pool.query("INSERT INTO branches (name) VALUES ('فرع-طلبات-تقسيم-جست') RETURNING id");
  branchA = bA.rows[0].id;
  await seedUser({ branchId: branchA, name: "كاشير-طلبات-تقسيم", email: "cashier-talabatsplit@jest.test", role: "cashier" });
  cashierToken = await login("cashier-talabatsplit@jest.test");

  const credit = await pool.query("INSERT INTO payment_methods (name, kind, enabled) VALUES ('آجل-طلبات-تقسيم-جست','credit',TRUE) RETURNING id");
  creditPmId = credit.rows[0].id;
  const cash = await pool.query("INSERT INTO payment_methods (name, kind, enabled) VALUES ('كاش-طلبات-تقسيم-جست','cash',TRUE) RETURNING id");
  cashPmId = cash.rows[0].id;

  const cat = await pool.query("INSERT INTO menu_categories (name) VALUES ('قسم-طلبات-تقسيم-جست') RETURNING id");
  const mi = await pool.query("INSERT INTO menu_items (category_id, name) VALUES ($1,'صنف-طلبات-تقسيم-جست') RETURNING id", [cat.rows[0].id]);
  itemId = mi.rows[0].id;
  const v = await pool.query("INSERT INTO menu_item_variants (item_id, label, price, talabat_price) VALUES ($1,'عادي',100,100) RETURNING id", [itemId]);
  variantId = v.rows[0].id;
});

afterAll(async () => {
  await pool.end();
});

async function createTalabatOrder(extra = {}) {
  return request(app).post("/api/orders").set(authed(cashierToken)).send({
    branchId: branchA, source: "talabat", orderType: "talabat", paymentMethodId: creditPmId,
    items: [{ itemId, variantId, quantity: 1 }], ...extra,
  });
}

// بيرجع بس سطور "الحساب المدين اللي بيمثّل مين مديون بقيمة الطلب" (1350 مستحق من طلبات، أو 1100-<فرع>
// كاش الفرع) - مش أي سطر مدين تاني في القيد (زي 4100 بتاع استقطاع الضريبة، ده مش جزء من منطق التقسيم
// اللي التست ده بيتحقق منه)
async function journalLinesFor(orderId) {
  const je = await pool.query("SELECT id FROM journal_entries WHERE source_type='order_sale' AND source_id=$1", [orderId]);
  const lines = await pool.query(
    `SELECT jel.debit, jel.credit, a.code AS account_code FROM journal_entry_lines jel
     JOIN accounts a ON a.id = jel.account_id
     WHERE jel.journal_entry_id = $1 AND jel.debit > 0 AND (a.code = '1350' OR a.code = $2)
     ORDER BY jel.id`,
    [je.rows[0].id, `1100-${branchA}`]
  );
  return lines.rows;
}

describe("رقم أوردر طلبات (talabatOrderId)", () => {
  test("بيتسجل مع الأوردر", async () => {
    const res = await createTalabatOrder({ talabatOrderId: "TLB-99123" });
    expect(res.status).toBe(201);
    const row = await pool.query("SELECT talabat_order_id FROM orders WHERE id=$1", [res.body.orderId]);
    expect(row.rows[0].talabat_order_id).toBe("TLB-99123");
  });

  test("مفيش رقم مبعوت - بيفضل NULL (مش إجباري على مستوى الباك إند)", async () => {
    const res = await createTalabatOrder({});
    expect(res.status).toBe(201);
    const row = await pool.query("SELECT talabat_order_id FROM orders WHERE id=$1", [res.body.orderId]);
    expect(row.rows[0].talabat_order_id).toBeNull();
  });
});

describe("تقسيم دفع أوردر طلبات (جزء نقدي + الباقي على 1350)", () => {
  test("افتراضيًا (من غير تقسيم) - سطر مدين واحد بكل الإجمالي على 1350 زي ما كان دايمًا", async () => {
    const res = await createTalabatOrder({});
    expect(res.status).toBe(201);
    const row = await pool.query("SELECT talabat_cash_collected FROM orders WHERE id=$1", [res.body.orderId]);
    expect(Number(row.rows[0].talabat_cash_collected)).toBe(0);
    const lines = await journalLinesFor(res.body.orderId);
    expect(lines.length).toBe(1);
    expect(lines[0].account_code).toBe("1350");
    expect(Number(lines[0].debit)).toBeCloseTo(100, 5);
  });

  test("تقسيم جزئي - سطرين: كاش الفرع + الباقي مستحق على 1350", async () => {
    const res = await createTalabatOrder({ talabatCashCollected: 30 });
    expect(res.status).toBe(201);
    const row = await pool.query("SELECT talabat_cash_collected FROM orders WHERE id=$1", [res.body.orderId]);
    expect(Number(row.rows[0].talabat_cash_collected)).toBeCloseTo(30, 5);
    const lines = await journalLinesFor(res.body.orderId);
    expect(lines.length).toBe(2);
    const cashLine = lines.find((l) => l.account_code !== "1350");
    const receivableLine = lines.find((l) => l.account_code === "1350");
    expect(Number(cashLine.debit)).toBeCloseTo(30, 5);
    expect(Number(receivableLine.debit)).toBeCloseTo(70, 5);
  });

  test("تقسيم كامل (كل الإجمالي كاش) - سطر واحد بس على حساب الكاش، مفيش سطر 1350 بقيمة صفر", async () => {
    const res = await createTalabatOrder({ talabatCashCollected: 100 });
    expect(res.status).toBe(201);
    const lines = await journalLinesFor(res.body.orderId);
    expect(lines.length).toBe(1);
    expect(lines[0].account_code).not.toBe("1350");
    expect(Number(lines[0].debit)).toBeCloseTo(100, 5);
  });

  test("مبلغ نقدي أكبر من الإجمالي - 400", async () => {
    const res = await createTalabatOrder({ talabatCashCollected: 150 });
    expect(res.status).toBe(400);
  });

  test("مبلغ نقدي سالب - 400", async () => {
    const res = await createTalabatOrder({ talabatCashCollected: -10 });
    expect(res.status).toBe(400);
  });

  test("أوردر عادي (مش طلبات) بيتجاهل talabatCashCollected تمامًا حتى لو اتبعت", async () => {
    const res = await request(app).post("/api/orders").set(authed(cashierToken)).send({
      branchId: branchA, source: "pos", orderType: "takeaway", paymentMethodId: cashPmId,
      items: [{ itemId, variantId, quantity: 1 }], talabatCashCollected: 50,
    });
    expect(res.status).toBe(201);
    const row = await pool.query("SELECT talabat_cash_collected, talabat_order_id FROM orders WHERE id=$1", [res.body.orderId]);
    expect(Number(row.rows[0].talabat_cash_collected)).toBe(0);
    expect(row.rows[0].talabat_order_id).toBeNull();
  });
});

describe("تأثير الجزء النقدي المحصّل على معادلة الكاش المتوقع", () => {
  test("GET /api/cash-sessions/expected - الجزء النقدي بس بيدخل cashSales، مش الإجمالي كله", async () => {
    const date = "2025-02-15";
    const res = await createTalabatOrder({ talabatCashCollected: 40 });
    await pool.query("UPDATE orders SET created_at = $1::date + time '12:00' WHERE id = $2", [date, res.body.orderId]);

    const before = await request(app).get(`/api/cash-sessions/expected?branchId=${branchA}&date=${date}`).set(authed(cashierToken));
    expect(before.status).toBe(200);
    // مفيش أي أوردر تاني في الملف ده متسجّل بنفس التاريخ ده (2025-02-15) - الرقم لازم يبقى 40 بالظبط
    expect(before.body.cashSales).toBeCloseTo(40, 5);
  });
});
