const express = require("express");
const router = express.Router();
const pool = require("../db/pool");
const { requireAuth, requireRole, assertOwnBranch } = require("../middleware/auth");

// GET /api/suppliers/ledger?branchId= - كشف حساب فرع مع المخزن الرئيسي (كمورد)
router.get(
  "/ledger",
  requireAuth,
  requireRole("admin", "accountant", "branch_manager"),
  async (req, res) => {
    let { branchId } = req.query;
    if (req.user.role === "branch_manager") {
      if (branchId && !assertOwnBranch(req.user, branchId)) {
        return res.status(403).json({ error: "معندكش صلاحية تشوف كشف حساب فرع تاني" });
      }
      branchId = req.user.branchId;
    }
    try {
      const result = await pool.query(
        `SELECT * FROM supplier_ledger_entries
         WHERE ($1::int IS NULL OR branch_id = $1)
         ORDER BY entry_date DESC, id DESC`,
        [branchId || null]
      );
      res.json(result.rows);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

// POST /api/suppliers/ledger - إضافة قيد (فاتورة مشتريات أو سداد) - أدمن ومحاسب بس
router.post("/ledger", requireAuth, requireRole("admin", "accountant"), async (req, res) => {
  const { branchId, entryDate, documentNo, entryType, invoiceAmount = 0, paymentAmount = 0, notes } = req.body;
  if (!branchId || !entryDate || !entryType) {
    return res.status(400).json({ error: "بيانات ناقصة" });
  }
  try {
    const result = await pool.query(
      `INSERT INTO supplier_ledger_entries
        (branch_id, entry_date, document_no, entry_type, invoice_amount, payment_amount, notes, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [branchId, entryDate, documentNo || null, entryType, invoiceAmount, paymentAmount, notes || null, req.user.name]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
