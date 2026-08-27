// المرحلة 7T: تسجيل دخول ذاتي للموظف (role='employee') - قسائم الراتب وطلبات الإجازة الخاصة بيه بس.
// نفس نمط driver بالظبط: مقفول على مستوى الكود بمطابقة employees.user_id مع req.user.id، مش بس
// بالصلاحية (زي loadOwnDriver في routes/deliveries.js بالظبط).
const express = require("express");
const router = express.Router();
const pool = require("../db/pool");
const { requireAuth } = require("../middleware/auth");
const { requirePermission } = require("../middleware/permissions");

async function loadOwnEmployee(userId) {
  const result = await pool.query("SELECT * FROM employees WHERE user_id = $1", [userId]);
  return result.rows[0] || null;
}

router.use(requireAuth);

// GET /api/employee-self/profile
router.get("/profile", requirePermission("payslips.view_own"), async (req, res) => {
  try {
    const employee = await loadOwnEmployee(req.user.id);
    if (!employee) return res.status(404).json({ error: "الحساب ده مش مربوط بملف موظف" });
    res.json({
      id: employee.id, employeeCode: employee.employee_code, name: employee.name,
      department: employee.department, jobTitle: employee.job_title, hireDate: employee.hire_date,
      status: employee.status,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/employee-self/payslips - قسائم راتب من تشغيلات معتمدة (APPROVED) بس - تشغيلة لسه مسودة
// (DRAFT) مش نهائية، ملهاش معنى تتعرض للموظف قبل الاعتماد
router.get("/payslips", requirePermission("payslips.view_own"), async (req, res) => {
  try {
    const employee = await loadOwnEmployee(req.user.id);
    if (!employee) return res.status(404).json({ error: "الحساب ده مش مربوط بملف موظف" });
    const result = await pool.query(
      `SELECT pre.id, pr.year, pr.month, pr.approved_at, pre.gross_pay, pre.advances, pre.penalties,
              pre.bonuses, pre.net_pay,
              COALESCE((SELECT SUM(pp.amount) FROM payroll_payments pp WHERE pp.payroll_run_employee_id = pre.id), 0) AS paid_amount
       FROM payroll_run_employees pre
       JOIN payroll_runs pr ON pr.id = pre.payroll_run_id
       WHERE pre.employee_id = $1 AND pr.status = 'APPROVED'
       ORDER BY pr.year DESC, pr.month DESC`,
      [employee.id]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/employee-self/leave-requests - طلبات الإجازة الخاصة بيه (كل الحالات)
router.get("/leave-requests", requirePermission("leave_requests.manage_own"), async (req, res) => {
  try {
    const employee = await loadOwnEmployee(req.user.id);
    if (!employee) return res.status(404).json({ error: "الحساب ده مش مربوط بملف موظف" });
    const result = await pool.query(
      "SELECT * FROM employee_leave_requests WHERE employee_id = $1 ORDER BY created_at DESC",
      [employee.id]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/employee-self/leave-requests - {leaveType, startDate, endDate, reason?}
router.post("/leave-requests", requirePermission("leave_requests.manage_own"), async (req, res) => {
  const { leaveType, startDate, endDate, reason } = req.body;
  if (!leaveType || !startDate || !endDate) {
    return res.status(400).json({ error: "لازم نوع الإجازة وتاريخ البداية والنهاية" });
  }
  if (new Date(endDate) < new Date(startDate)) return res.status(400).json({ error: "تاريخ النهاية قبل البداية" });
  try {
    const employee = await loadOwnEmployee(req.user.id);
    if (!employee) return res.status(404).json({ error: "الحساب ده مش مربوط بملف موظف" });
    const days = Math.round((new Date(endDate) - new Date(startDate)) / 86400000) + 1;
    const result = await pool.query(
      `INSERT INTO employee_leave_requests (employee_id, leave_type, start_date, end_date, days, reason)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [employee.id, leaveType, startDate, endDate, days, reason || null]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    if (err.code === "23514") return res.status(400).json({ error: "بيانات إجازة غير صحيحة" });
    res.status(500).json({ error: err.message });
  }
});

// POST /api/employee-self/leave-requests/:id/cancel - إلغاء طلب لسه معلّق (قبل المراجعة) بنفسه
router.post("/leave-requests/:id/cancel", requirePermission("leave_requests.manage_own"), async (req, res) => {
  const { id } = req.params;
  try {
    const employee = await loadOwnEmployee(req.user.id);
    if (!employee) return res.status(404).json({ error: "الحساب ده مش مربوط بملف موظف" });
    const existing = await pool.query(
      "SELECT * FROM employee_leave_requests WHERE id = $1 AND employee_id = $2",
      [id, employee.id]
    );
    if (existing.rows.length === 0) return res.status(404).json({ error: "طلب الإجازة مش موجود" });
    if (existing.rows[0].status !== "pending") return res.status(400).json({ error: "مينفعش تلغي إلا طلب لسه معلّق مراجعة" });
    const result = await pool.query(
      `UPDATE employee_leave_requests SET status = 'cancelled', reviewed_at = now() WHERE id = $1 RETURNING *`,
      [id]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
