const express = require("express");
const router = express.Router();
const pool = require("../db/pool");
const { requireAuth, requireRole, assertOwnBranch } = require("../middleware/auth");

const canOperate = requireRole("admin", "accountant", "branch_manager", "cashier");

// GET /api/cash-sessions?branchId=&date=
router.get("/", requireAuth, canOperate, async (req, res) => {
  let { branchId, date } = req.query;
  if (req.user.role === "branch_manager" || req.user.role === "cashier") {
    if (branchId && !assertOwnBranch(req.user, branchId)) {
      return res.status(403).json({ error: "معندكش صلاحية تشوف كاش فرع تاني" });
    }
    branchId = req.user.branchId;
  }
  try {
    const result = await pool.query(
      `SELECT * FROM daily_cash_sessions
       WHERE ($1::int IS NULL OR branch_id = $1)
         AND ($2::date IS NULL OR business_date = $2)
       ORDER BY business_date DESC`,
      [branchId || null, date || null]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/cash-sessions/expected?branchId=&date= - نفس معادلة الكاش المتوقع بتاعة الشيفتات (shift-engine)
// بس مجمّعة على مستوى اليوم كله للفرع، مش شيفت واحد - عشان تعبّي فورم "تقفيل الكاش" تلقائيًا من المبيعات/
// المصروفات/المشتريات الحقيقية بدل ما المحاسب يكتبها يدوي من الصفر (كانت السبب في إن كل تقفيلات الكاش
// القديمة طالعة أصفار - الفورم مكنش متوصّل بأي بيانات حقيقية خالص، مجرد إدخال يدوي بحت)
router.get("/expected", requireAuth, canOperate, async (req, res) => {
  let { branchId, date } = req.query;
  if (req.user.role === "branch_manager" || req.user.role === "cashier") {
    if (branchId && !assertOwnBranch(req.user, branchId)) {
      return res.status(403).json({ error: "معندكش صلاحية تشوف كاش فرع تاني" });
    }
    branchId = req.user.branchId;
  }
  if (!branchId || !date) return res.status(400).json({ error: "لازم فرع وتاريخ" });

  try {
    // المرحلة 8.41: كل مقارنة تاريخ هنا بقت صراحة بتوقيت القاهرة (AT TIME ZONE) مش توقيت جلسة Postgres
    // الافتراضي (UTC على استضافة زي Render) - غير كده أي طلب/مصروف اتسجل في أول 2-3 ساعات بعد نص الليل
    // بتوقيت القاهرة كان بيتحسب "إمبارح" هنا، فيختفي من أرقام اليوم الحالي بالغلط
    // كاش أول اليوم = الكاش الفعلي المسجّل آخر تقفيل قبل اليوم ده لنفس الفرع (رصيد آخر يوم بيبقى بداية
    // اليوم اللي بعده) - صفر لو مفيش تقفيل قبل كده خالص
    const openingRes = await pool.query(
      `SELECT actual_counted_cash FROM daily_cash_sessions
       WHERE branch_id = $1 AND business_date < $2 ORDER BY business_date DESC LIMIT 1`,
      [branchId, date]
    );
    const openingCash = openingRes.rows.length ? Number(openingRes.rows[0].actual_counted_cash) : 0;

    // مبيعات اليوم حسب طريقة الدفع - نفس فلتر "محصّلة فعليًا" (payment_status='collected') اللي محرك
    // الشيفتات بيستخدمه بالظبط (routes/shifts.js -> db/shift-engine.js) عشان طلبات دليفري لسه تحت
    // التحصيل ما تتحسبش كاش موجود في الدرج فعليًا دلوقتي
    // المرحلة 8.16: نفس منطق db/shift-engine.js بالظبط - أوردرات طلبات مستبعدة من "كاش" العادي (كلها
    // بترحّل على 1350 بغض النظر عن طريقة الدفع)، والجزء المحصّل كاش فعليًا بس (talabat_cash_collected)
    // هو اللي بيدخل cash_sales، مش إجمالي الطلب. delivery_app_sales لسه رقم معلوماتي منفصل (إجمالي كل
    // مبيعات طلبات بصرف النظر عن جزئها النقدي) زي ما كان دايمًا
    const salesRes = await pool.query(
      `SELECT
         COALESCE(SUM(o.total) FILTER (WHERE pm.kind = 'cash' AND o.source <> 'talabat' AND o.status <> 'cancelled' AND o.payment_status = 'collected'), 0)
           + COALESCE(SUM(o.talabat_cash_collected) FILTER (WHERE o.source = 'talabat' AND o.status <> 'cancelled'), 0) AS cash_sales,
         COALESCE(SUM(o.total) FILTER (WHERE pm.kind = 'card_or_wallet' AND o.status <> 'cancelled' AND o.payment_status = 'collected'), 0) AS card_sales,
         COALESCE(SUM(o.total) FILTER (WHERE pm.kind = 'credit' AND o.status <> 'cancelled' AND o.payment_status = 'collected'), 0) AS credit_sales,
         COALESCE(SUM(o.total) FILTER (WHERE o.source = 'talabat' AND o.status <> 'cancelled' AND o.payment_status = 'collected'), 0) AS delivery_app_sales
       FROM orders o LEFT JOIN payment_methods pm ON pm.id = o.payment_method_id
       WHERE o.branch_id = $1 AND (o.created_at AT TIME ZONE 'Africa/Cairo')::date = $2`,
      [branchId, date]
    );

    // نفس منطق cashPurchasesTotal/cashExpensesTotal بتاع shift-engine.js بالظبط، بس على مستوى اليوم كله
    const purchasesRes = await pool.query(
      `SELECT COALESCE(SUM(p.amount), 0) AS cash_purchases_total
       FROM purchases p
       WHERE p.branch_id = $1 AND p.status <> 'REJECTED' AND (p.created_at AT TIME ZONE 'Africa/Cairo')::date = $2`,
      [branchId, date]
    );
    const expensesRes = await pool.query(
      `SELECT COALESCE(SUM(e.amount), 0) AS cash_expenses_total
       FROM expenses e JOIN payment_methods pm ON pm.id = e.payment_method_id
       WHERE e.branch_id = $1 AND e.status IN ('SUBMITTED', 'APPROVED', 'POSTED') AND pm.kind = 'cash'
         AND (COALESCE(e.posted_at, e.created_at) AT TIME ZONE 'Africa/Cairo')::date = $2`,
      [branchId, date]
    );

    const cashSales = Number(salesRes.rows[0].cash_sales);
    const cashPaidToKitchen = Number(purchasesRes.rows[0].cash_purchases_total);
    const otherCashPayments = Number(expensesRes.rows[0].cash_expenses_total);

    res.json({
      openingCash,
      cashSales,
      cardSales: Number(salesRes.rows[0].card_sales),
      creditSales: Number(salesRes.rows[0].credit_sales),
      deliveryAppSales: Number(salesRes.rows[0].delivery_app_sales),
      cashPaidToKitchen,
      otherCashPayments,
      expectedClosingCash: openingCash + cashSales - cashPaidToKitchen - otherCashPayments,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/cash-sessions - تقفيل/تحديث كاش يوم معين لفرع (بديل شيت "فرع ..." اليدوي)
// expected_closing_cash و cash_difference بيتحسبوا في السيرفر عشان محدش يغلط فيهم يدوي
router.post("/", requireAuth, canOperate, async (req, res) => {
  const {
    branchId, businessDate, openingCash = 0, cashSales = 0, cardSales = 0,
    creditSales = 0, deliveryAppSales = 0, cashPaidToKitchen = 0,
    otherCashPayments = 0, actualCountedCash = 0,
  } = req.body;

  if (!branchId || !businessDate) {
    return res.status(400).json({ error: "لازم فرع وتاريخ" });
  }
  if ((req.user.role === "branch_manager" || req.user.role === "cashier")
      && !assertOwnBranch(req.user, branchId)) {
    return res.status(403).json({ error: "معندكش صلاحية تقفل كاش فرع تاني" });
  }

  try {
    const result = await pool.query(
      `INSERT INTO daily_cash_sessions
        (branch_id, business_date, opening_cash, cash_sales, card_sales, credit_sales,
         delivery_app_sales, cash_paid_to_kitchen, other_cash_payments,
         expected_closing_cash, actual_counted_cash, cash_difference)
       VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9,
         ($3::numeric + $4::numeric - $8::numeric - $9::numeric),
         $10,
         ($10::numeric - ($3::numeric + $4::numeric - $8::numeric - $9::numeric))
       )
       ON CONFLICT (branch_id, business_date) DO UPDATE SET
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
         updated_at = now()
       RETURNING *`,
      [branchId, businessDate, openingCash, cashSales, cardSales, creditSales,
       deliveryAppSales, cashPaidToKitchen, otherCashPayments, actualCountedCash]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
