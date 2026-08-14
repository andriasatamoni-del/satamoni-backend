const express = require("express");
const router = express.Router();
const pool = require("../db/pool");
const { requireAuth, requireRole } = require("../middleware/auth");

// نظام الرواتب حساس ماليًا وشامل كل الفروع - أدمن ومحاسب بس (مش مقفول على فرع زي المصروفات العادية)
const payrollAccess = requireRole("admin", "accountant");
router.use(requireAuth, payrollAccess);

// ---------------- الإعدادات وسلم خصم التأخير ----------------
router.get("/settings", async (req, res) => {
  try {
    const settings = await pool.query("SELECT * FROM payroll_settings WHERE id = 1");
    const tiers = await pool.query("SELECT * FROM late_deduction_tiers ORDER BY from_minute");
    res.json({ settings: settings.rows[0], tiers: tiers.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch("/settings", requireRole("admin"), async (req, res) => {
  const fields = [];
  const values = [];
  let i = 1;
  const allowed = [
    "defaultWorkingDays", "paidLeaveDaysPerMonth", "payrollToSalesWarnRatio",
    "standardShiftHours", "overtimeMultiplier", "minOvertimeHours",
    "allowedLateExemptions", "missedPunchDeductionFraction",
    "morningShiftStart", "eveningShiftStart",
  ];
  const columnMap = {
    defaultWorkingDays: "default_working_days", paidLeaveDaysPerMonth: "paid_leave_days_per_month",
    payrollToSalesWarnRatio: "payroll_to_sales_warn_ratio", standardShiftHours: "standard_shift_hours",
    overtimeMultiplier: "overtime_multiplier", minOvertimeHours: "min_overtime_hours",
    allowedLateExemptions: "allowed_late_exemptions", missedPunchDeductionFraction: "missed_punch_deduction_fraction",
    morningShiftStart: "morning_shift_start", eveningShiftStart: "evening_shift_start",
  };
  for (const key of allowed) {
    if (req.body[key] !== undefined) { fields.push(`${columnMap[key]} = $${i++}`); values.push(req.body[key]); }
  }
  if (fields.length === 0) return res.status(400).json({ error: "مفيش حاجة تتعدل" });
  try {
    const result = await pool.query(`UPDATE payroll_settings SET ${fields.join(", ")} WHERE id = 1 RETURNING *`, values);
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/payroll/late-tiers - استبدال سلم خصم التأخير بالكامل
router.put("/late-tiers", requireRole("admin"), async (req, res) => {
  const { tiers } = req.body;
  if (!Array.isArray(tiers) || tiers.length === 0) return res.status(400).json({ error: "لازم سلم تأخير صحيح" });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM late_deduction_tiers");
    for (const t of tiers) {
      await client.query(
        "INSERT INTO late_deduction_tiers (from_minute, to_minute, deduction_fraction) VALUES ($1,$2,$3)",
        [t.fromMinute, t.toMinute, t.deductionFraction]
      );
    }
    await client.query("COMMIT");
    res.status(201).json({ ok: true });
  } catch (err) {
    await client.query("ROLLBACK");
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ---------------- الموظفين ----------------
router.get("/employees", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT e.*, COALESCE(
        json_agg(json_build_object('branchId', efc.branch_id, 'branchName', b.name, 'deviceCode', efc.device_code))
          FILTER (WHERE efc.id IS NOT NULL), '[]'
      ) AS fingerprint_codes
      FROM employees e
      LEFT JOIN employee_fingerprint_codes efc ON efc.employee_id = e.id
      LEFT JOIN branches b ON b.id = efc.branch_id
      GROUP BY e.id
      ORDER BY e.department, e.name
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/employees", async (req, res) => {
  const {
    name, department, jobTitle, attendanceSystem, hireDate, baseSalary = 0,
    workingDaysPerMonth = 26, shift, wageType = "fixed_monthly", hourlyRate = 0,
    phone, notes, countDay31 = false, restrictedBranchId,
  } = req.body;
  if (!name || !department || !attendanceSystem) {
    return res.status(400).json({ error: "لازم الاسم والقسم ونظام الحضور" });
  }
  try {
    const result = await pool.query(
      `INSERT INTO employees
        (name, department, job_title, attendance_system, hire_date, base_salary,
         working_days_per_month, shift, wage_type, hourly_rate, phone, notes, count_day_31, restricted_branch_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
      [name, department, jobTitle || null, attendanceSystem, hireDate || null, baseSalary,
       workingDaysPerMonth, shift || null, wageType, hourlyRate, phone || null, notes || null,
       countDay31, restrictedBranchId || null]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch("/employees/:id", async (req, res) => {
  const { id } = req.params;
  const map = {
    name: "name", department: "department", jobTitle: "job_title", attendanceSystem: "attendance_system",
    hireDate: "hire_date", baseSalary: "base_salary", workingDaysPerMonth: "working_days_per_month",
    shift: "shift", wageType: "wage_type", hourlyRate: "hourly_rate", phone: "phone", notes: "notes",
    isActive: "is_active", countDay31: "count_day_31", restrictedBranchId: "restricted_branch_id",
  };
  const fields = [];
  const values = [];
  let i = 1;
  for (const [key, col] of Object.entries(map)) {
    if (req.body[key] !== undefined) { fields.push(`${col} = $${i++}`); values.push(req.body[key]); }
  }
  if (fields.length === 0) return res.status(400).json({ error: "مفيش حاجة تتعدل" });
  values.push(id);
  try {
    const result = await pool.query(`UPDATE employees SET ${fields.join(", ")} WHERE id = $${i} RETURNING *`, values);
    if (result.rows.length === 0) return res.status(404).json({ error: "الموظف مش موجود" });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/payroll/employees/:id/fingerprint-codes - استبدال أكواد البصمة بالكامل لموظف
router.put("/employees/:id/fingerprint-codes", async (req, res) => {
  const { id } = req.params;
  const { codes } = req.body; // [{branchId, deviceCode}]
  if (!Array.isArray(codes)) return res.status(400).json({ error: "لازم قايمة أكواد صحيحة" });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM employee_fingerprint_codes WHERE employee_id = $1", [id]);
    for (const c of codes) {
      if (!c.branchId || !c.deviceCode) continue;
      await client.query(
        `INSERT INTO employee_fingerprint_codes (employee_id, branch_id, device_code) VALUES ($1,$2,$3)
         ON CONFLICT (branch_id, device_code) DO UPDATE SET employee_id = EXCLUDED.employee_id`,
        [id, c.branchId, c.deviceCode]
      );
    }
    await client.query("COMMIT");
    res.status(201).json({ ok: true });
  } catch (err) {
    await client.query("ROLLBACK");
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ---------------- استيراد بصمة الفروع ----------------
// POST /api/payroll/attendance-punches/import
// { branchId, rows: [{deviceCode, date:'YYYY-MM-DD', clockIn:'HH:MM'|null, clockOut:'HH:MM'|null}] }
router.post("/attendance-punches/import", async (req, res) => {
  const { branchId, rows } = req.body;
  if (!branchId || !Array.isArray(rows) || rows.length === 0) {
    return res.status(400).json({ error: "لازم فرع وصفوف بصمة" });
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    let imported = 0;
    for (const r of rows) {
      if (!r.deviceCode || !r.date) continue;
      await client.query(
        `INSERT INTO attendance_punches (branch_id, device_code, punch_date, clock_in, clock_out)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (branch_id, device_code, punch_date)
         DO UPDATE SET clock_in = EXCLUDED.clock_in, clock_out = EXCLUDED.clock_out`,
        [branchId, String(r.deviceCode).trim(), r.date, r.clockIn || null, r.clockOut || null]
      );
      imported++;
    }
    await client.query("COMMIT");
    res.status(201).json({ imported });
  } catch (err) {
    await client.query("ROLLBACK");
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// GET /api/payroll/attendance-punches?branchId=&year=&month= - لمراجعة/تصحيح بصمات ناقصة
router.get("/attendance-punches", async (req, res) => {
  const { branchId, year, month } = req.query;
  if (!branchId || !year || !month) return res.status(400).json({ error: "لازم تحدد الفرع والسنة والشهر" });
  try {
    const result = await pool.query(
      `SELECT ap.*, efc.employee_id, e.name AS employee_name
       FROM attendance_punches ap
       LEFT JOIN employee_fingerprint_codes efc ON efc.branch_id = ap.branch_id AND efc.device_code = ap.device_code
       LEFT JOIN employees e ON e.id = efc.employee_id
       WHERE ap.branch_id = $1 AND EXTRACT(YEAR FROM ap.punch_date) = $2 AND EXTRACT(MONTH FROM ap.punch_date) = $3
       ORDER BY employee_name NULLS FIRST, ap.punch_date`,
      [branchId, year, month]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/payroll/attendance-punches/:id - تصحيح بصمة ناقصة يدويًا أو تفعيل إذن تأخير
router.patch("/attendance-punches/:id", async (req, res) => {
  const { id } = req.params;
  const { clockIn, clockOut, exempted } = req.body;
  const fields = [];
  const values = [];
  let i = 1;
  if (clockIn !== undefined) { fields.push(`clock_in = $${i++}`); values.push(clockIn); }
  if (clockOut !== undefined) { fields.push(`clock_out = $${i++}`); values.push(clockOut); }
  if (exempted !== undefined) { fields.push(`exempted = $${i++}`); values.push(exempted); }
  if (fields.length === 0) return res.status(400).json({ error: "مفيش حاجة تتعدل" });
  values.push(id);
  try {
    const result = await pool.query(`UPDATE attendance_punches SET ${fields.join(", ")} WHERE id = $${i} RETURNING *`, values);
    if (result.rows.length === 0) return res.status(404).json({ error: "السجل مش موجود" });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------- حضور المطبخ المركزي (يدوي) ----------------
router.get("/central-kitchen-attendance", async (req, res) => {
  const { year, month } = req.query;
  if (!year || !month) return res.status(400).json({ error: "لازم تحدد السنة والشهر" });
  try {
    const result = await pool.query(
      `SELECT cka.*, e.name AS employee_name
       FROM central_kitchen_manual_attendance cka
       JOIN employees e ON e.id = cka.employee_id
       WHERE cka.year = $1 AND cka.month = $2
       ORDER BY e.name`,
      [year, month]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/central-kitchen-attendance", async (req, res) => {
  const { employeeId, year, month, presentDays = 0, absentDays = 0, totalLateMinutes = 0, manualDeduction = 0, notes } = req.body;
  if (!employeeId || !year || !month) return res.status(400).json({ error: "لازم الموظف والسنة والشهر" });
  try {
    const result = await pool.query(
      `INSERT INTO central_kitchen_manual_attendance
        (employee_id, year, month, present_days, absent_days, total_late_minutes, manual_deduction, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (employee_id, year, month) DO UPDATE SET
         present_days = EXCLUDED.present_days, absent_days = EXCLUDED.absent_days,
         total_late_minutes = EXCLUDED.total_late_minutes, manual_deduction = EXCLUDED.manual_deduction,
         notes = EXCLUDED.notes
       RETURNING *`,
      [employeeId, year, month, presentDays, absentDays, totalLateMinutes, manualDeduction, notes || null]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------- السلف والجزاءات والمكافآت ----------------
router.get("/adjustments", async (req, res) => {
  const { employeeId, year, month } = req.query;
  try {
    const result = await pool.query(
      `SELECT pa.*, e.name AS employee_name
       FROM payroll_adjustments pa
       JOIN employees e ON e.id = pa.employee_id
       WHERE ($1::int IS NULL OR pa.employee_id = $1)
         AND ($2::int IS NULL OR EXTRACT(YEAR FROM pa.entry_date) = $2)
         AND ($3::int IS NULL OR EXTRACT(MONTH FROM pa.entry_date) = $3)
       ORDER BY pa.entry_date DESC`,
      [employeeId || null, year || null, month || null]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/adjustments", async (req, res) => {
  const { employeeId, entryDate, adjustmentType, amount, notes } = req.body;
  if (!employeeId || !entryDate || !adjustmentType || amount === undefined) {
    return res.status(400).json({ error: "بيانات ناقصة" });
  }
  try {
    const result = await pool.query(
      `INSERT INTO payroll_adjustments (employee_id, entry_date, adjustment_type, amount, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [employeeId, entryDate, adjustmentType, amount, notes || null, req.user.id]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete("/adjustments/:id", async (req, res) => {
  try {
    await pool.query("DELETE FROM payroll_adjustments WHERE id = $1", [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------- مبيعات الأقسام الشهرية (لمقارنة تكلفة الرواتب بالمبيعات) ----------------
router.get("/department-sales", async (req, res) => {
  const { year, month } = req.query;
  if (!year || !month) return res.status(400).json({ error: "لازم تحدد السنة والشهر" });
  try {
    const result = await pool.query(
      `SELECT ds.*, b.name AS branch_name FROM department_sales ds
       JOIN branches b ON b.id = ds.branch_id
       WHERE ds.year = $1 AND ds.month = $2 ORDER BY b.name, ds.department`,
      [year, month]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/department-sales", async (req, res) => {
  const { branchId, department, year, month, salesAmount = 0 } = req.body;
  if (!branchId || !department || !year || !month) return res.status(400).json({ error: "بيانات ناقصة" });
  try {
    const result = await pool.query(
      `INSERT INTO department_sales (branch_id, department, year, month, sales_amount)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (branch_id, department, year, month) DO UPDATE SET sales_amount = EXCLUDED.sales_amount
       RETURNING *`,
      [branchId, department, year, month, salesAmount]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------- ملخص الرواتب المحسوب ----------------
const {
  computeFingerprintPayroll,
  computeManualPayroll,
  computeNoTrackingPayroll,
} = require("../services/payroll-engine");

function toCents(n) {
  return Math.round(n * 100);
}

router.get("/summary", async (req, res) => {
  const year = Number(req.query.year);
  const month = Number(req.query.month);
  if (!year || !month) return res.status(400).json({ error: "لازم تحدد السنة والشهر" });

  try {
    const [fingerprintRows, manualRows, noTrackingRows, adjustments, branches] = await Promise.all([
      computeFingerprintPayroll(pool, year, month),
      computeManualPayroll(pool, year, month),
      computeNoTrackingPayroll(pool),
      pool.query(
        `SELECT employee_id,
                SUM(amount) FILTER (WHERE adjustment_type = 'advance') AS advances,
                SUM(amount) FILTER (WHERE adjustment_type = 'penalty') AS penalties,
                SUM(amount) FILTER (WHERE adjustment_type = 'bonus') AS bonuses
         FROM payroll_adjustments
         WHERE EXTRACT(YEAR FROM entry_date) = $1 AND EXTRACT(MONTH FROM entry_date) = $2
         GROUP BY employee_id`,
        [year, month]
      ),
      pool.query("SELECT id, name FROM branches WHERE is_central_kitchen = TRUE LIMIT 1"),
    ]);

    const adjByEmployee = {};
    adjustments.rows.forEach((r) => {
      adjByEmployee[r.employee_id] = {
        advances: Number(r.advances || 0),
        penalties: Number(r.penalties || 0),
        bonuses: Number(r.bonuses || 0),
      };
    });
    const centralKitchenName = branches.rows[0]?.name || "المطبخ المركزي";

    const all = [...fingerprintRows, ...manualRows, ...noTrackingRows].map((r) => {
      const adj = adjByEmployee[r.employeeId] || { advances: 0, penalties: 0, bonuses: 0 };
      // جمع/طرح مبالغ جاهزة (كل واحدة متقرّبة لـ 2 خانة عشرية بالفعل من SQL) بالقرش الصحيح
      // عشان نتجنب أي انحراف في دقة الأرقام العشرية لجمع/طرح JS العادي
      const netPayCents = toCents(r.payAfterAttendance) - toCents(adj.advances) - toCents(adj.penalties) + toCents(adj.bonuses);
      const netPay = netPayCents / 100;
      const missingBaseSalary = r.wageType === "hourly" ? Number(r.hourlyRate || 0) === 0 : Number(r.baseSalary) === 0;
      let alert = null;
      if (netPay < 0) alert = "⚠ راتب بالسالب - راجع الخصومات";
      else if (missingBaseSalary && r.attendanceSystem !== "none") alert = "⚠ الراتب الأساسي غير مُدخل";
      else if (r.attendanceSystem === "fingerprint_auto" && !r.primaryBranch) alert = "⚠ لا يوجد سجل بصمة له في أي فرع";

      return {
        ...r,
        primaryBranch: r.primaryBranch || (r.attendanceSystem === "manual" ? centralKitchenName : r.attendanceSystem === "none" ? "الإدارة العامة" : null),
        advances: adj.advances,
        penalties: adj.penalties,
        bonuses: adj.bonuses,
        netPay,
        alert,
      };
    });

    res.json({ year, month, employees: all });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
