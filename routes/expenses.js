const express = require("express");
const router = express.Router();
const pool = require("../db/pool");
const { requireAuth, requireRole, assertOwnBranch } = require("../middleware/auth");

const canManage = requireRole("admin", "accountant", "branch_manager");

// GET /api/expenses?branchId=&date=
router.get("/", requireAuth, canManage, async (req, res) => {
  let { branchId, date } = req.query;
  if (req.user.role === "branch_manager") {
    if (branchId && !assertOwnBranch(req.user, branchId)) {
      return res.status(403).json({ error: "معندكش صلاحية تشوف مصروفات فرع تاني" });
    }
    branchId = req.user.branchId;
  }
  try {
    const result = await pool.query(
      `SELECT * FROM expenses
       WHERE ($1::int IS NULL OR branch_id = $1)
         AND ($2::date IS NULL OR business_date = $2)
       ORDER BY business_date DESC, id DESC`,
      [branchId || null, date || null]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/expenses - تسجيل مصروف يومي
router.post("/", requireAuth, canManage, async (req, res) => {
  const { branchId, businessDate, category, amount, notes } = req.body;
  if (!branchId || !businessDate || !category || !amount) {
    return res.status(400).json({ error: "بيانات ناقصة" });
  }
  if (req.user.role === "branch_manager" && !assertOwnBranch(req.user, branchId)) {
    return res.status(403).json({ error: "معندكش صلاحية تسجل مصروف على فرع تاني" });
  }
  try {
    const result = await pool.query(
      `INSERT INTO expenses (branch_id, business_date, category, amount, notes)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [branchId, businessDate, category, amount, notes || null]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
