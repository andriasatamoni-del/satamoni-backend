const express = require("express");
const router = express.Router();
const pool = require("../db/pool");
const { requireAuth, requireRole, assertOwnBranch } = require("../middleware/auth");

// GET /api/kitchen-transfers?branchId=&date= - تحويلات سنتر كيتشن للفروع
router.get(
  "/",
  requireAuth,
  requireRole("admin", "accountant", "branch_manager"),
  async (req, res) => {
    let { branchId, date } = req.query;
    if (req.user.role === "branch_manager") {
      if (branchId && !assertOwnBranch(req.user, branchId)) {
        return res.status(403).json({ error: "معندكش صلاحية تشوف تحويلات فرع تاني" });
      }
      branchId = req.user.branchId;
    }
    try {
      const result = await pool.query(
        `SELECT * FROM kitchen_transfers
         WHERE ($1::int IS NULL OR to_branch_id = $1)
           AND ($2::date IS NULL OR business_date = $2)
         ORDER BY business_date DESC, id DESC`,
        [branchId || null, date || null]
      );
      res.json(result.rows);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

// POST /api/kitchen-transfers - سنتر كيتشن بيبعت بضاعة بالتكلفة لفرع (أدمن بس)
router.post("/", requireAuth, requireRole("admin"), async (req, res) => {
  const { toBranchId, businessDate, amountAtCost, notes } = req.body;
  if (!toBranchId || !businessDate || !amountAtCost) {
    return res.status(400).json({ error: "بيانات ناقصة" });
  }
  try {
    const result = await pool.query(
      `INSERT INTO kitchen_transfers (to_branch_id, business_date, amount_at_cost, notes)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [toBranchId, businessDate, amountAtCost, notes || null]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
