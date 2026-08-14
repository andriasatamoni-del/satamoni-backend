const express = require("express");
const router = express.Router();
const pool = require("../db/pool");
const { requireAuth, requireRole, assertOwnBranch } = require("../middleware/auth");

const canManageStaff = requireRole("admin", "branch_manager");
const anyStaff = requireRole("admin", "branch_manager", "accountant", "cashier", "callcenter");

// ---------------- الشيفتات ----------------

// GET /api/hr/shifts?branchId=&date= - جدول الشيفتات
router.get("/shifts", requireAuth, anyStaff, async (req, res) => {
  let { branchId, date } = req.query;
  if (req.user.role === "branch_manager") {
    if (branchId && !assertOwnBranch(req.user, branchId)) {
      return res.status(403).json({ error: "معندكش صلاحية تشوف شيفتات فرع تاني" });
    }
    branchId = req.user.branchId;
  }
  try {
    const result = await pool.query(
      `SELECT s.*, u.name AS user_name
       FROM shifts s
       JOIN users u ON u.id = s.user_id
       WHERE ($1::int IS NULL OR s.branch_id = $1)
         AND ($2::date IS NULL OR s.shift_date = $2)
       ORDER BY s.shift_date, s.start_time`,
      [branchId || null, date || null]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/hr/shifts - تعيين شيفت لموظف (أدمن أو مدير الفرع نفسه)
router.post("/shifts", requireAuth, canManageStaff, async (req, res) => {
  const { userId, branchId, shiftDate, startTime, endTime, notes } = req.body;
  if (!userId || !branchId || !shiftDate || !startTime || !endTime) {
    return res.status(400).json({ error: "بيانات ناقصة" });
  }
  if (req.user.role === "branch_manager" && !assertOwnBranch(req.user, branchId)) {
    return res.status(403).json({ error: "معندكش صلاحية تعيّن شيفت في فرع تاني" });
  }
  try {
    const result = await pool.query(
      `INSERT INTO shifts (user_id, branch_id, shift_date, start_time, end_time, notes)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [userId, branchId, shiftDate, startTime, endTime, notes || null]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------- الحضور والانصراف ----------------

// POST /api/hr/attendance/clock-in - الموظف بيسجل حضوره بنفسه
router.post("/attendance/clock-in", requireAuth, anyStaff, async (req, res) => {
  const { branchId } = req.body;
  const effectiveBranchId = req.user.role === "admin" ? branchId : req.user.branchId;
  try {
    const open = await pool.query(
      "SELECT id FROM attendance_records WHERE user_id = $1 AND clock_out IS NULL",
      [req.user.id]
    );
    if (open.rows.length > 0) {
      return res.status(409).json({ error: "عندك تسجيل حضور مفتوح لسه، سجل انصراف الأول" });
    }
    const result = await pool.query(
      `INSERT INTO attendance_records (user_id, branch_id) VALUES ($1, $2) RETURNING *`,
      [req.user.id, effectiveBranchId || null]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/hr/attendance/clock-out - الموظف بيسجل انصرافه
router.post("/attendance/clock-out", requireAuth, anyStaff, async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE attendance_records SET clock_out = now()
       WHERE id = (
         SELECT id FROM attendance_records
         WHERE user_id = $1 AND clock_out IS NULL
         ORDER BY clock_in DESC LIMIT 1
       )
       RETURNING *`,
      [req.user.id]
    );
    if (result.rows.length === 0) {
      return res.status(409).json({ error: "مفيش تسجيل حضور مفتوح عشان تقفله" });
    }
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/hr/attendance?branchId=&date=&userId= - سجل الحضور (أدمن/مدير فرع)
router.get("/attendance", requireAuth, canManageStaff, async (req, res) => {
  let { branchId, date, userId } = req.query;
  if (req.user.role === "branch_manager") {
    if (branchId && !assertOwnBranch(req.user, branchId)) {
      return res.status(403).json({ error: "معندكش صلاحية تشوف حضور فرع تاني" });
    }
    branchId = req.user.branchId;
  }
  try {
    const result = await pool.query(
      `SELECT a.*, u.name AS user_name
       FROM attendance_records a
       JOIN users u ON u.id = a.user_id
       WHERE ($1::int IS NULL OR a.branch_id = $1)
         AND ($2::date IS NULL OR a.business_date = $2)
         AND ($3::int IS NULL OR a.user_id = $3)
       ORDER BY a.clock_in DESC`,
      [branchId || null, date || null, userId || null]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
