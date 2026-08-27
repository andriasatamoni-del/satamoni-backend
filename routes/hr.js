const express = require("express");
const router = express.Router();
const pool = require("../db/pool");
const { requireAuth, requireRole, assertOwnBranch } = require("../middleware/auth");
const { logAudit } = require("../db/audit");
const { recordEmployeeHistoryChanges } = require("../db/employee-history");

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

// ============================================================
// المرحلة 4D: دورة حياة الموظف (Employee Lifecycle) - سطح HR منفصل عن /api/payroll/employees عمدًا:
// ده بيانات HR تشغيلية (حالة/إنذارات/إجازات/تاريخ) بيدير الفرع بيحتاجها لموظفي فرعه، لكن الراتب نفسه
// (base_salary/hourly_rate/wage_type) بيانات مالية حساسة تفضل أدمن/محاسب بس (زي ما هي في
// routes/payroll.js من غير أي تغيير). الجدول (employees) واحد، السطح اللي بيتعرض مختلف حسب الحساسية.
// canManageStaff (أدمن + مدير فرع) هي نفسها بالظبط اللي بتحكم شيفتات/حضور فوق - نفس الدايرة اللي كانت
// شغالة على users بس، دلوقتي شاملة employees كمان (لغاية موظف فرعه بس لمدير الفرع)
// ============================================================

const HR_EMPLOYEE_COLUMNS = `
  e.id, e.employee_code, e.name, e.department, e.job_title, e.attendance_system, e.hire_date,
  e.status, e.is_active, e.phone, e.notes, e.restricted_branch_id, e.termination_date, e.termination_reason,
  e.created_at, b.name AS branch_name, e.user_id
`;

// لو مدير فرع، لازم الموظف مربوط بفرعه بالظبط (restricted_branch_id) - موظف من غير فرع محدد (NULL) أو
// مربوط بفرع تاني مش شغل مدير الفرع ده خالص، حتى لو بيشوف باقي موظفي فرعه عادي
function canAccessEmployee(req, employee) {
  if (req.user.role === "admin") return true;
  return employee.restricted_branch_id != null && assertOwnBranch(req.user, employee.restricted_branch_id);
}

async function loadEmployeeOr404(res, id) {
  const result = await pool.query("SELECT * FROM employees WHERE id = $1", [id]);
  if (result.rows.length === 0) { res.status(404).json({ error: "الموظف مش موجود" }); return null; }
  return result.rows[0];
}

// GET /api/hr/employees?branchId=&department=&status= - قائمة HR (من غير راتب) - مدير الفرع مقفول على
// فرعه، أدمن يشوف الكل (مع فلاتر اختيارية)
router.get("/employees", requireAuth, canManageStaff, async (req, res) => {
  let { branchId, department, status } = req.query;
  if (req.user.role === "branch_manager") branchId = req.user.branchId;
  try {
    const result = await pool.query(
      `SELECT ${HR_EMPLOYEE_COLUMNS}
       FROM employees e LEFT JOIN branches b ON b.id = e.restricted_branch_id
       WHERE ($1::int IS NULL OR e.restricted_branch_id = $1)
         AND ($2::text IS NULL OR e.department = $2)
         AND ($3::text IS NULL OR e.status = $3)
       ORDER BY e.department, e.name`,
      [branchId || null, department || null, status || null]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/hr/employees/:id - ملف HR لموظف واحد
router.get("/employees/:id", requireAuth, canManageStaff, async (req, res) => {
  try {
    const employee = await loadEmployeeOr404(res, req.params.id);
    if (!employee) return;
    if (!canAccessEmployee(req, employee)) return res.status(403).json({ error: "معندكش صلاحية تشوف موظف فرع تاني" });
    const result = await pool.query(
      `SELECT ${HR_EMPLOYEE_COLUMNS} FROM employees e LEFT JOIN branches b ON b.id = e.restricted_branch_id WHERE e.id = $1`,
      [req.params.id]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/hr/employees/:id - تعديل بيانات HR بس (مش راتب) - {department?, jobTitle?, status?,
// restrictedBranchId? (أدمن بس - نقل موظف بين الفروع قرار أدمن)، terminationDate?, terminationReason?,
// reason?, effectiveDate?}
router.patch("/employees/:id", requireAuth, canManageStaff, async (req, res) => {
  const { id } = req.params;
  const { department, jobTitle, status, restrictedBranchId, terminationDate, terminationReason, reason, effectiveDate } = req.body;
  if (restrictedBranchId !== undefined && req.user.role !== "admin") {
    return res.status(403).json({ error: "نقل موظف بين الفروع أدمن بس" });
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const before = await client.query("SELECT * FROM employees WHERE id = $1 FOR UPDATE", [id]);
    if (before.rows.length === 0) { await client.query("ROLLBACK"); return res.status(404).json({ error: "الموظف مش موجود" }); }
    if (!canAccessEmployee(req, before.rows[0])) {
      await client.query("ROLLBACK");
      return res.status(403).json({ error: "معندكش صلاحية تعدّل موظف فرع تاني" });
    }
    const fields = [];
    const values = [];
    let i = 1;
    const map = {
      department, job_title: jobTitle, status, restricted_branch_id: restrictedBranchId,
      termination_date: terminationDate, termination_reason: terminationReason,
    };
    for (const [col, val] of Object.entries(map)) {
      if (val !== undefined) { fields.push(`${col} = $${i++}`); values.push(val); }
    }
    if (fields.length === 0) { await client.query("ROLLBACK"); return res.status(400).json({ error: "مفيش حاجة تتعدل" }); }
    values.push(id);
    const result = await client.query(`UPDATE employees SET ${fields.join(", ")} WHERE id = $${i} RETURNING *`, values);
    await recordEmployeeHistoryChanges(client, {
      employeeId: Number(id), before: before.rows[0],
      changes: { department, job_title: jobTitle, restricted_branch_id: restrictedBranchId, status },
      changedBy: req.user.id, reason: reason || null, effectiveDate: effectiveDate || null,
    });
    await logAudit(client, {
      branchId: before.rows[0].restricted_branch_id, userId: req.user.id, action: "EMPLOYEE_HR_UPDATED",
      entityType: "employee", entityId: Number(id), oldValues: before.rows[0], newValues: result.rows[0],
      metadata: reason ? { reason } : null, req,
    });
    await client.query("COMMIT");
    res.json(result.rows[0]);
  } catch (err) {
    await client.query("ROLLBACK");
    if (err.code === "23514") return res.status(400).json({ error: "قيمة غير صحيحة (تحقق من status)" });
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// GET /api/hr/employees/:id/history - سجل التغييرات الجوهرية لموظف واحد
router.get("/employees/:id/history", requireAuth, canManageStaff, async (req, res) => {
  try {
    const employee = await loadEmployeeOr404(res, req.params.id);
    if (!employee) return;
    if (!canAccessEmployee(req, employee)) return res.status(403).json({ error: "معندكش صلاحية تشوف موظف فرع تاني" });
    const result = await pool.query(
      `SELECT h.*, u.name AS changed_by_name FROM employee_history h
       LEFT JOIN users u ON u.id = h.changed_by
       WHERE h.employee_id = $1 ORDER BY h.effective_date DESC, h.id DESC`,
      [req.params.id]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------- الإنذارات ----------------

// POST /api/hr/employees/:id/warnings - append-only، مفيش تعديل ولا حذف أبدًا
router.post("/employees/:id/warnings", requireAuth, canManageStaff, async (req, res) => {
  const { id } = req.params;
  const { severity, warningDate, reason, notes } = req.body;
  if (!severity || !reason) return res.status(400).json({ error: "لازم درجة الإنذار والسبب" });
  try {
    const employee = await loadEmployeeOr404(res, id);
    if (!employee) return;
    if (!canAccessEmployee(req, employee)) return res.status(403).json({ error: "معندكش صلاحية تسجّل إنذار لموظف فرع تاني" });
    const result = await pool.query(
      `INSERT INTO employee_warnings (employee_id, severity, warning_date, reason, issued_by, notes)
       VALUES ($1,$2,COALESCE($3, CURRENT_DATE),$4,$5,$6) RETURNING *`,
      [id, severity, warningDate || null, reason, req.user.id, notes || null]
    );
    await logAudit(pool, {
      branchId: employee.restricted_branch_id, userId: req.user.id, action: "EMPLOYEE_WARNING_ISSUED",
      entityType: "employee_warning", entityId: result.rows[0].id, newValues: result.rows[0], req,
    });
    res.status(201).json(result.rows[0]);
  } catch (err) {
    if (err.code === "23514") return res.status(400).json({ error: "درجة إنذار غير صحيحة" });
    res.status(500).json({ error: err.message });
  }
});

// GET /api/hr/employees/:id/warnings
router.get("/employees/:id/warnings", requireAuth, canManageStaff, async (req, res) => {
  try {
    const employee = await loadEmployeeOr404(res, req.params.id);
    if (!employee) return;
    if (!canAccessEmployee(req, employee)) return res.status(403).json({ error: "معندكش صلاحية تشوف موظف فرع تاني" });
    const result = await pool.query(
      `SELECT w.*, u.name AS issued_by_name FROM employee_warnings w
       LEFT JOIN users u ON u.id = w.issued_by
       WHERE w.employee_id = $1 ORDER BY w.warning_date DESC, w.id DESC`,
      [req.params.id]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/hr/warnings?branchId=&severity=&from=&to= - سجل إنذارات كل الموظفين (تقرير)
router.get("/warnings", requireAuth, canManageStaff, async (req, res) => {
  let { branchId, severity, from, to } = req.query;
  if (req.user.role === "branch_manager") branchId = req.user.branchId;
  try {
    const result = await pool.query(
      `SELECT w.*, e.name AS employee_name, e.employee_code, e.department, u.name AS issued_by_name
       FROM employee_warnings w
       JOIN employees e ON e.id = w.employee_id
       LEFT JOIN users u ON u.id = w.issued_by
       WHERE ($1::int IS NULL OR e.restricted_branch_id = $1)
         AND ($2::text IS NULL OR w.severity = $2)
         AND ($3::date IS NULL OR w.warning_date >= $3)
         AND ($4::date IS NULL OR w.warning_date <= $4)
       ORDER BY w.warning_date DESC, w.id DESC`,
      [branchId || null, severity || null, from || null, to || null]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------- الإجازات ----------------

// POST /api/hr/leaves - تسجيل إجازة نيابة عن موظف - {employeeId, leaveType, startDate, endDate, notes, branchId?}
// مش self-service: مدير الفرع بيسجّلها لموظف فرعه بس، وbranchId بيتقفل على فرعه تلقائي
router.post("/leaves", requireAuth, canManageStaff, async (req, res) => {
  const { employeeId, leaveType, startDate, endDate, notes } = req.body;
  let { branchId } = req.body;
  if (!employeeId || !leaveType || !startDate || !endDate) {
    return res.status(400).json({ error: "لازم الموظف ونوع الإجازة وتاريخ البداية والنهاية" });
  }
  if (new Date(endDate) < new Date(startDate)) return res.status(400).json({ error: "تاريخ النهاية قبل البداية" });
  try {
    const employee = await loadEmployeeOr404(res, employeeId);
    if (!employee) return;
    if (!canAccessEmployee(req, employee)) return res.status(403).json({ error: "معندكش صلاحية تسجّل إجازة لموظف فرع تاني" });
    if (req.user.role === "branch_manager") branchId = req.user.branchId;
    const days = Math.round((new Date(endDate) - new Date(startDate)) / 86400000) + 1;
    const result = await pool.query(
      `INSERT INTO employee_leaves (employee_id, leave_type, start_date, end_date, days, notes, branch_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [employeeId, leaveType, startDate, endDate, days, notes || null, branchId || employee.restricted_branch_id || null, req.user.id]
    );
    await logAudit(pool, {
      branchId: employee.restricted_branch_id, userId: req.user.id, action: "EMPLOYEE_LEAVE_RECORDED",
      entityType: "employee_leave", entityId: result.rows[0].id, newValues: result.rows[0], req,
    });
    res.status(201).json(result.rows[0]);
  } catch (err) {
    if (err.code === "23514") return res.status(400).json({ error: "بيانات إجازة غير صحيحة" });
    res.status(500).json({ error: err.message });
  }
});

// POST /api/hr/leaves/:id/cancel - إلغاء تسجيل إجازة (تصحيح غلط) - مش DELETE، السجل يفضل موجود ومعلّم
router.post("/leaves/:id/cancel", requireAuth, canManageStaff, async (req, res) => {
  const { id } = req.params;
  const { reason } = req.body;
  if (!reason) return res.status(400).json({ error: "لازم سبب الإلغاء" });
  try {
    const leave = await pool.query("SELECT * FROM employee_leaves WHERE id = $1", [id]);
    if (leave.rows.length === 0) return res.status(404).json({ error: "سجل الإجازة مش موجود" });
    const employee = await loadEmployeeOr404(res, leave.rows[0].employee_id);
    if (!employee) return;
    if (!canAccessEmployee(req, employee)) return res.status(403).json({ error: "معندكش صلاحية تلغي إجازة موظف فرع تاني" });
    if (leave.rows[0].status === "cancelled") return res.status(400).json({ error: "الإجازة دي ملغاة بالفعل" });
    const result = await pool.query(
      `UPDATE employee_leaves SET status = 'cancelled', cancelled_by = $1, cancelled_at = now(), cancellation_reason = $2
       WHERE id = $3 RETURNING *`,
      [req.user.id, reason, id]
    );
    await logAudit(pool, {
      branchId: employee.restricted_branch_id, userId: req.user.id, action: "EMPLOYEE_LEAVE_CANCELLED",
      entityType: "employee_leave", entityId: Number(id), oldValues: leave.rows[0], newValues: result.rows[0],
      metadata: { reason }, req,
    });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/hr/leaves?employeeId=&branchId=&leaveType=&from=&to=&status=
router.get("/leaves", requireAuth, canManageStaff, async (req, res) => {
  let { employeeId, branchId, leaveType, from, to, status } = req.query;
  if (req.user.role === "branch_manager") branchId = req.user.branchId;
  try {
    const result = await pool.query(
      `SELECT l.*, e.name AS employee_name, e.employee_code, e.department, b.name AS branch_name
       FROM employee_leaves l
       JOIN employees e ON e.id = l.employee_id
       LEFT JOIN branches b ON b.id = l.branch_id
       WHERE ($1::int IS NULL OR l.employee_id = $1)
         AND ($2::int IS NULL OR e.restricted_branch_id = $2)
         AND ($3::text IS NULL OR l.leave_type = $3)
         AND ($4::date IS NULL OR l.end_date >= $4)
         AND ($5::date IS NULL OR l.start_date <= $5)
         AND ($6::text IS NULL OR l.status = $6)
       ORDER BY l.start_date DESC, l.id DESC`,
      [employeeId || null, branchId || null, leaveType || null, from || null, to || null, status || null]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------- طلبات الإجازة الذاتية (7T) ----------------
// الموظف بيقدّم الطلب بنفسه (routes/employee-self.js) - هنا مراجعته: موافقة (بتحوّله لسجل رسمي حقيقي
// في employee_leaves، نفس منطق POST /leaves بالظبط) أو رفض. نفس نطاق الصلاحية والفرع اللي على /leaves

// GET /api/hr/leave-requests?employeeId=&branchId=&status=
router.get("/leave-requests", requireAuth, canManageStaff, async (req, res) => {
  let { employeeId, branchId, status } = req.query;
  if (req.user.role === "branch_manager") branchId = req.user.branchId;
  try {
    const result = await pool.query(
      `SELECT r.*, e.name AS employee_name, e.employee_code, e.department, b.name AS branch_name,
              reviewer.name AS reviewed_by_name
       FROM employee_leave_requests r
       JOIN employees e ON e.id = r.employee_id
       LEFT JOIN branches b ON b.id = e.restricted_branch_id
       LEFT JOIN users reviewer ON reviewer.id = r.reviewed_by
       WHERE ($1::int IS NULL OR r.employee_id = $1)
         AND ($2::int IS NULL OR e.restricted_branch_id = $2)
         AND ($3::text IS NULL OR r.status = $3)
       ORDER BY r.created_at DESC`,
      [employeeId || null, branchId || null, status || null]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/hr/leave-requests/:id/approve - {reviewNotes?} - بيتحول لسجل رسمي في employee_leaves
router.post("/leave-requests/:id/approve", requireAuth, canManageStaff, async (req, res) => {
  const { id } = req.params;
  const { reviewNotes } = req.body;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const reqRow = await client.query("SELECT * FROM employee_leave_requests WHERE id = $1 FOR UPDATE", [id]);
    if (reqRow.rows.length === 0) { await client.query("ROLLBACK"); return res.status(404).json({ error: "طلب الإجازة مش موجود" }); }
    const request = reqRow.rows[0];
    if (request.status !== "pending") { await client.query("ROLLBACK"); return res.status(400).json({ error: "الطلب ده اتراجع بالفعل" }); }

    const employee = await loadEmployeeOr404(res, request.employee_id);
    if (!employee) { await client.query("ROLLBACK"); return; }
    if (!canAccessEmployee(req, employee)) { await client.query("ROLLBACK"); return res.status(403).json({ error: "معندكش صلاحية تراجع طلب موظف فرع تاني" }); }

    const leave = await client.query(
      `INSERT INTO employee_leaves (employee_id, leave_type, start_date, end_date, days, notes, branch_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [request.employee_id, request.leave_type, request.start_date, request.end_date, request.days,
       request.reason, employee.restricted_branch_id || null, req.user.id]
    );
    const updated = await client.query(
      `UPDATE employee_leave_requests
       SET status = 'approved', reviewed_by = $1, reviewed_at = now(), review_notes = $2, resulting_leave_id = $3
       WHERE id = $4 RETURNING *`,
      [req.user.id, reviewNotes || null, leave.rows[0].id, id]
    );
    await logAudit(client, {
      branchId: employee.restricted_branch_id, userId: req.user.id, action: "EMPLOYEE_LEAVE_REQUEST_APPROVED",
      entityType: "employee_leave_request", entityId: Number(id), newValues: updated.rows[0], req,
    });
    await client.query("COMMIT");
    res.json(updated.rows[0]);
  } catch (err) {
    await client.query("ROLLBACK");
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// POST /api/hr/leave-requests/:id/reject - {reason}
router.post("/leave-requests/:id/reject", requireAuth, canManageStaff, async (req, res) => {
  const { id } = req.params;
  const { reason } = req.body;
  if (!reason) return res.status(400).json({ error: "لازم سبب الرفض" });
  try {
    const reqRow = await pool.query("SELECT * FROM employee_leave_requests WHERE id = $1", [id]);
    if (reqRow.rows.length === 0) return res.status(404).json({ error: "طلب الإجازة مش موجود" });
    const request = reqRow.rows[0];
    if (request.status !== "pending") return res.status(400).json({ error: "الطلب ده اتراجع بالفعل" });

    const employee = await loadEmployeeOr404(res, request.employee_id);
    if (!employee) return;
    if (!canAccessEmployee(req, employee)) return res.status(403).json({ error: "معندكش صلاحية تراجع طلب موظف فرع تاني" });

    const updated = await pool.query(
      `UPDATE employee_leave_requests SET status = 'rejected', reviewed_by = $1, reviewed_at = now(), review_notes = $2
       WHERE id = $3 RETURNING *`,
      [req.user.id, reason, id]
    );
    await logAudit(pool, {
      branchId: employee.restricted_branch_id, userId: req.user.id, action: "EMPLOYEE_LEAVE_REQUEST_REJECTED",
      entityType: "employee_leave_request", entityId: Number(id), metadata: { reason }, req,
    });
    res.json(updated.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------- تقارير HR ----------------
// كل تقرير بيرجّع نتيجة استعلام واحد مجمّع (GROUP BY) - مفيش أي loop بينادي القاعدة لكل موظف لوحده
// (N+1)، حتى تقرير رصيد الإجازات اللي بيلف على كل موظف بيجيب مجموع أيام الإجازة المأخوذة بـLEFT JOIN
// مجمّع واحد، مش استعلام منفصل لكل موظف

// GET /api/hr/reports/employees-by-branch?department=&status= - أدمن بس (مقارنة بين فروع، زي
// branch-profit-and-loss بالظبط - مفيش نسخة "لفرعي بس" منطقية لتقرير مقارنة أصلًا)
router.get("/reports/employees-by-branch", requireAuth, requireRole("admin"), async (req, res) => {
  const { department, status } = req.query;
  try {
    const result = await pool.query(
      `SELECT e.restricted_branch_id AS branch_id, COALESCE(b.name, 'بدون فرع محدد') AS branch_name, COUNT(*) AS employee_count
       FROM employees e LEFT JOIN branches b ON b.id = e.restricted_branch_id
       WHERE ($1::text IS NULL OR e.department = $1) AND ($2::text IS NULL OR e.status = $2)
       GROUP BY e.restricted_branch_id, b.name ORDER BY employee_count DESC`,
      [department || null, status || null]
    );
    res.json(result.rows.map((r) => ({ branchId: r.branch_id, branchName: r.branch_name, employeeCount: Number(r.employee_count) })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/hr/reports/employees-by-department?branchId=&status=
router.get("/reports/employees-by-department", requireAuth, canManageStaff, async (req, res) => {
  let { branchId, status } = req.query;
  if (req.user.role === "branch_manager") branchId = req.user.branchId;
  try {
    const result = await pool.query(
      `SELECT department, COUNT(*) AS employee_count FROM employees e
       WHERE ($1::int IS NULL OR e.restricted_branch_id = $1) AND ($2::text IS NULL OR e.status = $2)
       GROUP BY department ORDER BY employee_count DESC`,
      [branchId || null, status || null]
    );
    res.json(result.rows.map((r) => ({ department: r.department, employeeCount: Number(r.employee_count) })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/hr/reports/employees-by-job-title?branchId=&department=&status=
router.get("/reports/employees-by-job-title", requireAuth, canManageStaff, async (req, res) => {
  let { branchId, department, status } = req.query;
  if (req.user.role === "branch_manager") branchId = req.user.branchId;
  try {
    const result = await pool.query(
      `SELECT COALESCE(job_title, 'بدون مسمى وظيفي') AS job_title, COUNT(*) AS employee_count FROM employees e
       WHERE ($1::int IS NULL OR e.restricted_branch_id = $1) AND ($2::text IS NULL OR e.department = $2)
         AND ($3::text IS NULL OR e.status = $3)
       GROUP BY job_title ORDER BY employee_count DESC`,
      [branchId || null, department || null, status || null]
    );
    res.json(result.rows.map((r) => ({ jobTitle: r.job_title, employeeCount: Number(r.employee_count) })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/hr/reports/employee-status?branchId=&department= - عدد الموظفين حسب الحالة
router.get("/reports/employee-status", requireAuth, canManageStaff, async (req, res) => {
  let { branchId, department } = req.query;
  if (req.user.role === "branch_manager") branchId = req.user.branchId;
  try {
    const result = await pool.query(
      `SELECT status, COUNT(*) AS employee_count FROM employees e
       WHERE ($1::int IS NULL OR e.restricted_branch_id = $1) AND ($2::text IS NULL OR e.department = $2)
       GROUP BY status ORDER BY employee_count DESC`,
      [branchId || null, department || null]
    );
    res.json(result.rows.map((r) => ({ status: r.status, employeeCount: Number(r.employee_count) })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/hr/reports/average-tenure?branchId=&department=&status=&asOf= - متوسط مدة الخدمة بالشهور،
// من hire_date لغاية termination_date (لو خلص شغله) أو asOf (افتراضيًا النهاردة) لو لسه شغال. hire_date
// هو مصدر الحقيقة الوحيد لمدة الخدمة - مش created_at خالص (زي ما اتحدد صراحة)
router.get("/reports/average-tenure", requireAuth, canManageStaff, async (req, res) => {
  let { branchId, department, status } = req.query;
  if (req.user.role === "branch_manager") branchId = req.user.branchId;
  const asOf = req.query.asOf || new Date().toISOString().slice(0, 10);
  try {
    const result = await pool.query(
      `SELECT AVG((COALESCE(termination_date, $4::date) - hire_date) / 30.44) AS avg_months,
              COUNT(*) AS employee_count
       FROM employees e
       WHERE hire_date IS NOT NULL
         AND ($1::int IS NULL OR e.restricted_branch_id = $1) AND ($2::text IS NULL OR e.department = $2)
         AND ($3::text IS NULL OR e.status = $3)`,
      [branchId || null, department || null, status || null, asOf]
    );
    const row = result.rows[0];
    res.json({
      asOf, employeeCount: Number(row.employee_count),
      averageTenureMonths: row.avg_months !== null ? Number(row.avg_months) : null,
      note: "متوسط بالشهور من hire_date لغاية termination_date (لو خلص شغله) أو asOf (لو لسه شغال)",
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/hr/reports/turnover?from=&to=&branchId=&department= - معدل دوران تقديري: عدد اللي خلصوا
// شغلهم (استقالة/إنهاء خدمة) في المدى ÷ متوسط عدد الموظفين (بداية+نهاية المدى /2). تقديري وليس معيار
// محاسبي رسمي - أقرب تقريب عملي بمعطيات hire_date/termination_date المتاحة
router.get("/reports/turnover", requireAuth, canManageStaff, async (req, res) => {
  let { branchId, department } = req.query;
  if (req.user.role === "branch_manager") branchId = req.user.branchId;
  const to = req.query.to || new Date().toISOString().slice(0, 10);
  const from = req.query.from || `${new Date(to).getFullYear()}-01-01`;
  try {
    const departuresRes = await pool.query(
      `SELECT COUNT(*) AS departures FROM employees e
       WHERE status IN ('resigned', 'terminated') AND termination_date BETWEEN $1 AND $2
         AND ($3::int IS NULL OR e.restricted_branch_id = $3) AND ($4::text IS NULL OR e.department = $4)`,
      [from, to, branchId || null, department || null]
    );
    const headcountAt = async (asOfDate) => {
      const r = await pool.query(
        `SELECT COUNT(*) AS c FROM employees e
         WHERE hire_date <= $1 AND (termination_date IS NULL OR termination_date >= $1)
           AND ($2::int IS NULL OR e.restricted_branch_id = $2) AND ($3::text IS NULL OR e.department = $3)`,
        [asOfDate, branchId || null, department || null]
      );
      return Number(r.rows[0].c);
    };
    const [startHeadcount, endHeadcount] = await Promise.all([headcountAt(from), headcountAt(to)]);
    const avgHeadcount = (startHeadcount + endHeadcount) / 2;
    const departures = Number(departuresRes.rows[0].departures);
    res.json({
      from, to, departures, startHeadcount, endHeadcount,
      turnoverRate: avgHeadcount > 0 ? departures / avgHeadcount : null,
      note: "تقديري: عدد الاستقالات/إنهاءات الخدمة في المدى ÷ متوسط عدد الموظفين (بداية ونهاية المدى)",
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/hr/reports/new-hires?from=&to=&branchId=&department=
router.get("/reports/new-hires", requireAuth, canManageStaff, async (req, res) => {
  let { branchId, department, from, to } = req.query;
  if (req.user.role === "branch_manager") branchId = req.user.branchId;
  try {
    const result = await pool.query(
      `SELECT e.id, e.employee_code, e.name, e.department, e.job_title, e.hire_date, b.name AS branch_name
       FROM employees e LEFT JOIN branches b ON b.id = e.restricted_branch_id
       WHERE hire_date IS NOT NULL
         AND ($1::date IS NULL OR hire_date >= $1) AND ($2::date IS NULL OR hire_date <= $2)
         AND ($3::int IS NULL OR e.restricted_branch_id = $3) AND ($4::text IS NULL OR e.department = $4)
       ORDER BY hire_date DESC`,
      [from || null, to || null, branchId || null, department || null]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/hr/reports/terminations?from=&to=&branchId=&department= - استقالات وإنهاءات خدمة
router.get("/reports/terminations", requireAuth, canManageStaff, async (req, res) => {
  let { branchId, department, from, to } = req.query;
  if (req.user.role === "branch_manager") branchId = req.user.branchId;
  try {
    const result = await pool.query(
      `SELECT e.id, e.employee_code, e.name, e.department, e.job_title, e.status, e.termination_date,
              e.termination_reason, b.name AS branch_name
       FROM employees e LEFT JOIN branches b ON b.id = e.restricted_branch_id
       WHERE status IN ('resigned', 'terminated')
         AND ($1::date IS NULL OR termination_date >= $1) AND ($2::date IS NULL OR termination_date <= $2)
         AND ($3::int IS NULL OR e.restricted_branch_id = $3) AND ($4::text IS NULL OR e.department = $4)
       ORDER BY termination_date DESC`,
      [from || null, to || null, branchId || null, department || null]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/hr/reports/leave-balance?branchId=&department=&status=&employeeId=&asOf= - رصيد إجازات
// تقديري: paid_leave_days_per_month (من payroll_settings الموجود بالفعل) × شهور الخدمة، ناقص أيام
// الإجازة السنوية (annual) المسجّلة فعليًا (غير الملغاة). تقديري صراحة - مش نظام استحقاق قانوني كامل
// (مفيش تراكم سنوي بحد أقصى، مفيش استرداد نهاية خدمة...)، ومش متصل بمحرك الرواتب خالص
router.get("/reports/leave-balance", requireAuth, canManageStaff, async (req, res) => {
  let { branchId, department, status, employeeId } = req.query;
  if (req.user.role === "branch_manager") branchId = req.user.branchId;
  const asOf = req.query.asOf || new Date().toISOString().slice(0, 10);
  try {
    const settings = await pool.query("SELECT paid_leave_days_per_month FROM payroll_settings WHERE id = 1");
    const perMonth = Number(settings.rows[0]?.paid_leave_days_per_month || 0);
    const result = await pool.query(
      `SELECT e.id, e.employee_code, e.name, e.department, e.hire_date, e.status, e.restricted_branch_id,
              b.name AS branch_name, COALESCE(taken.days_taken, 0) AS days_taken
       FROM employees e
       LEFT JOIN branches b ON b.id = e.restricted_branch_id
       LEFT JOIN (
         SELECT employee_id, SUM(days) AS days_taken FROM employee_leaves
         WHERE leave_type = 'annual' AND status = 'recorded'
         GROUP BY employee_id
       ) taken ON taken.employee_id = e.id
       WHERE ($1::int IS NULL OR e.restricted_branch_id = $1) AND ($2::text IS NULL OR e.department = $2)
         AND ($3::text IS NULL OR e.status = $3) AND ($4::int IS NULL OR e.id = $4)
       ORDER BY e.department, e.name`,
      [branchId || null, department || null, status || null, employeeId || null]
    );
    const rows = result.rows.map((r) => {
      const daysTaken = Number(r.days_taken);
      let entitledDays = 0;
      if (r.hire_date) {
        const serviceMonths = Math.max(0, (new Date(asOf) - new Date(r.hire_date)) / (1000 * 60 * 60 * 24 * 30.44));
        entitledDays = perMonth * serviceMonths;
      }
      return {
        employeeId: r.id, employeeCode: r.employee_code, name: r.name, department: r.department,
        branchId: r.restricted_branch_id, branchName: r.branch_name, hireDate: r.hire_date, status: r.status,
        estimatedEntitledDays: Math.round(entitledDays * 100) / 100, daysTaken,
        estimatedRemainingDays: Math.round((entitledDays - daysTaken) * 100) / 100,
      };
    });
    res.json({ asOf, paidLeaveDaysPerMonth: perMonth, employees: rows, note: "رصيد تقديري (Estimated) - مش نظام استحقاق قانوني كامل، ومش بيتخصم منه أي حاجة أوتوماتيك في الرواتب" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
