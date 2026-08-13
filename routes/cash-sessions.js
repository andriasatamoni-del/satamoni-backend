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
         cash_difference = EXCLUDED.cash_difference
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
