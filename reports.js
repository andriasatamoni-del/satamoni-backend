const express = require("express");
const router = express.Router();
const pool = require("../db/pool");

// GET /api/reports/daily?year=2026&month=7 - بديل شيت "لوحة التحكم"
router.get("/daily", async (req, res) => {
  const { year, month } = req.query;
  try {
    const result = await pool.query(
      `SELECT * FROM v_daily_branch_summary
       WHERE EXTRACT(YEAR FROM business_date) = $1
         AND EXTRACT(MONTH FROM business_date) = $2
       ORDER BY business_date, branch_id`,
      [year, month]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/reports/branch-debt - مديونية كل فرع للمخزن الرئيسي لحظيًا
router.get("/branch-debt", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT b.id AS branch_id, b.name,
             b.opening_debt_to_kitchen
             + COALESCE(SUM(sle.invoice_amount), 0)
             - COALESCE(SUM(sle.payment_amount), 0) AS current_debt
      FROM branches b
      LEFT JOIN supplier_ledger_entries sle ON sle.branch_id = b.id
      WHERE b.is_central_kitchen = FALSE
      GROUP BY b.id, b.name, b.opening_debt_to_kitchen
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
