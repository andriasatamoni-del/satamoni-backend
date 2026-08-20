const express = require("express");
const router = express.Router();
const pool = require("../db/pool");
const { requireAuth, requireRole } = require("../middleware/auth");
const { logAudit } = require("../db/audit");
const { postJournalEntry, reverseJournalEntry, getOrCreateBranchCashAccount, getAccountByCode } = require("../db/accounting-engine");
const { computePayrollSummary, toCents } = require("../services/payroll-engine");

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
router.get("/summary", async (req, res) => {
  const year = Number(req.query.year);
  const month = Number(req.query.month);
  if (!year || !month) return res.status(400).json({ error: "لازم تحدد السنة والشهر" });

  try {
    const all = await computePayrollSummary(pool, year, month);
    res.json({ year, month, employees: all });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// المرحلة 4C: تشغيلات الرواتب الرسمية + الترحيل المحاسبي
// ============================================================
// GET /summary فوق تقرير حي - لو الحضور أو السلف اتعدّلوا بعد كده، رقمه بيتغيّر معاهم. التشغيلة (Run)
// تحت snapshot ثابت من نفس المحرك (computePayrollSummary) وقت الإنشاء بالظبط - تاريخي ومايتغيّرش.

// GET /api/payroll/runs - كل التشغيلات
router.get("/runs", async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM payroll_runs ORDER BY year DESC, month DESC");
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/payroll/runs/:id - تفاصيل تشغيلة + كل موظف فيها + المتبقي له (net_pay - مجموع مدفوعاته الفعلية)
router.get("/runs/:id", async (req, res) => {
  try {
    const run = await pool.query("SELECT * FROM payroll_runs WHERE id = $1", [req.params.id]);
    if (run.rows.length === 0) return res.status(404).json({ error: "تشغيلة الرواتب مش موجودة" });
    const employees = await pool.query(
      `SELECT pre.*, b.name AS branch_name, COALESCE(pp.paid, 0) AS paid_amount
       FROM payroll_run_employees pre
       LEFT JOIN branches b ON b.id = pre.branch_id
       LEFT JOIN (SELECT payroll_run_employee_id, SUM(amount) AS paid FROM payroll_payments GROUP BY payroll_run_employee_id) pp
         ON pp.payroll_run_employee_id = pre.id
       WHERE pre.payroll_run_id = $1
       ORDER BY pre.employee_name`,
      [req.params.id]
    );
    res.json({ run: run.rows[0], employees: employees.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/payroll/runs - إنشاء تشغيلة DRAFT لشهر معيّن - snapshot ثابت من computePayrollSummary وقت
// النداء (نفس محرك /summary بالظبط). {year, month, idempotencyKey?}
router.post("/runs", async (req, res) => {
  const { year, month, idempotencyKey } = req.body;
  if (!year || !month || month < 1 || month > 12) return res.status(400).json({ error: "لازم سنة وشهر صحيحين" });

  const client = await pool.connect();
  try {
    if (idempotencyKey) {
      const existing = await client.query("SELECT * FROM payroll_runs WHERE idempotency_key = $1", [idempotencyKey]);
      if (existing.rows.length > 0) return res.status(200).json({ ...existing.rows[0], duplicate: true });
    }

    const summary = await computePayrollSummary(pool, year, month);
    if (summary.length === 0) return res.status(400).json({ error: "مفيش موظفين نشطين لحساب راتبهم في الشهر ده" });
    const totalNetPay = summary.reduce((s, r) => s + r.netPay, 0);

    await client.query("BEGIN");
    let run;
    try {
      run = await client.query(
        `INSERT INTO payroll_runs (year, month, total_net_pay, created_by, idempotency_key)
         VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [year, month, totalNetPay, req.user.id, idempotencyKey || null]
      );
    } catch (err) {
      if (err.code === "23505") {
        await client.query("ROLLBACK");
        if (idempotencyKey) {
          const existing = await client.query("SELECT * FROM payroll_runs WHERE idempotency_key = $1", [idempotencyKey]);
          if (existing.rows.length > 0) return res.status(200).json({ ...existing.rows[0], duplicate: true });
        }
        return res.status(409).json({ error: `تشغيلة رواتب ${month}/${year} موجودة بالفعل` });
      }
      throw err;
    }

    for (const r of summary) {
      const branchId = r.attendanceSystem === "fingerprint_auto" ? (r.primaryBranchId || null) : null;
      await client.query(
        `INSERT INTO payroll_run_employees
          (payroll_run_id, employee_id, employee_name, branch_id, gross_pay, advances, penalties, bonuses, net_pay)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [run.rows[0].id, r.employeeId, r.name, branchId, r.payAfterAttendance, r.advances, r.penalties, r.bonuses, r.netPay]
      );
    }

    await logAudit(client, {
      userId: req.user.id, action: "PAYROLL_RUN_CREATED", entityType: "payroll_run", entityId: run.rows[0].id,
      newValues: { year, month, totalNetPay, employeeCount: summary.length }, req,
    });
    await client.query("COMMIT");
    const alerts = summary.filter((r) => r.alert).map((r) => ({ employeeId: r.employeeId, name: r.name, alert: r.alert }));
    res.status(201).json({ ...run.rows[0], employeeCount: summary.length, alerts, duplicate: false });
  } catch (err) {
    await client.query("ROLLBACK");
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// POST /api/payroll/runs/:id/approve - DRAFT → APPROVED - بيرحّل قيد واحد: مدين 6100 الرواتب (سطر منفصل
// لكل فرع بتكلفته - نفس تقسيم computePayrollCostByBranch بالظبط) / دائن 2400 رواتب مستحقة بالإجمالي
router.post("/runs/:id/approve", async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const run = await client.query("SELECT * FROM payroll_runs WHERE id = $1 FOR UPDATE", [req.params.id]);
    if (run.rows.length === 0) { await client.query("ROLLBACK"); return res.status(404).json({ error: "تشغيلة الرواتب مش موجودة" }); }
    if (run.rows[0].status !== "DRAFT") {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "التشغيلة دي مش في حالة قابلة للاعتماد (DRAFT بس)" });
    }

    const employees = await client.query("SELECT branch_id, net_pay FROM payroll_run_employees WHERE payroll_run_id = $1", [req.params.id]);
    // بالقرش الصحيح (نفس أسلوب services/payroll-engine.js بالظبط) - جمع NUMERIC كـfloat عادي هنا كان
    // بيطلع فروق زي 9615.38 مقابل 9615.380000000001 بين إجمالي سطور المدين ومجموعها المستقل، فقيد
    // الاعتماد كان بيترفض كـ"غير متزن" رغم إن الرقمين متطابقين فعليًا لغاية القرش
    const byBranchCents = {};
    let totalCents = 0;
    employees.rows.forEach((e) => {
      const key = e.branch_id || "overhead";
      const cents = toCents(Number(e.net_pay));
      byBranchCents[key] = (byBranchCents[key] || 0) + cents;
      totalCents += cents;
    });
    const byBranch = {};
    Object.entries(byBranchCents).forEach(([key, cents]) => { byBranch[key] = cents / 100; });
    const total = totalCents / 100;

    const salariesExpense = await getAccountByCode(client, "6100");
    const salariesPayable = await getAccountByCode(client, "2400");
    const lines = Object.entries(byBranch)
      .filter(([, amount]) => amount > 0)
      .map(([key, amount]) => ({
        accountId: salariesExpense.id, debit: amount,
        branchId: key === "overhead" ? null : Number(key),
        description: key === "overhead" ? "رواتب - تكلفة عامة (إدارة/مطبخ مركزي)" : null,
      }));
    if (total > 0) lines.push({ accountId: salariesPayable.id, credit: total });

    // تاريخ القيد = آخر يوم في شهر التشغيلة (استحقاق نهاية الشهر) - بدون Date/toISOString عشان نتجنب
    // أي انزلاق تاريخ بسبب فرق التوقيت المحلي (نفس أسلوب resolveDateRange في reports.js بالظبط)
    const lastDay = new Date(run.rows[0].year, run.rows[0].month, 0).getDate();
    const entryDate = `${run.rows[0].year}-${String(run.rows[0].month).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;

    const je = await postJournalEntry(client, {
      entryDate, description: `رواتب شهر ${run.rows[0].month}/${run.rows[0].year}`,
      sourceType: "payroll_run", sourceId: run.rows[0].id, branchId: null,
      lines, idempotencyKey: `payroll-run-${run.rows[0].id}`, userId: req.user.id,
    });

    const updated = await client.query(
      `UPDATE payroll_runs SET status = 'APPROVED', approved_by = $1, approved_at = now(), journal_entry_id = $2 WHERE id = $3 RETURNING *`,
      [req.user.id, je.entry.id, req.params.id]
    );
    await logAudit(client, {
      userId: req.user.id, action: "PAYROLL_RUN_APPROVED", entityType: "payroll_run", entityId: Number(req.params.id),
      newValues: { journalEntryId: je.entry.id, total }, req,
    });
    await client.query("COMMIT");
    res.json(updated.rows[0]);
  } catch (err) {
    await client.query("ROLLBACK");
    if (err.code === "PERIOD_CLOSED") return res.status(400).json({ error: err.message });
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// POST /api/payroll/runs/:id/cancel - APPROVED → CANCELLED - أدمن بس (زي عكس أي قيد محاسبي تمامًا)،
// بيعكس القيد الأصلي، مرفوض لو فيه مدفوعات فعلية اتسجلت بالفعل على التشغيلة (لازم تتعالج الأول)
router.post("/runs/:id/cancel", requireRole("admin"), async (req, res) => {
  const { reason } = req.body;
  if (!reason) return res.status(400).json({ error: "لازم سبب الإلغاء" });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const run = await client.query("SELECT * FROM payroll_runs WHERE id = $1 FOR UPDATE", [req.params.id]);
    if (run.rows.length === 0) { await client.query("ROLLBACK"); return res.status(404).json({ error: "تشغيلة الرواتب مش موجودة" }); }
    if (run.rows[0].status !== "APPROVED") {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "مينفعش تلغي إلا تشغيلة معتمدة (APPROVED)" });
    }

    const payments = await client.query(
      `SELECT COUNT(*) FROM payroll_payments pp
       JOIN payroll_run_employees pre ON pre.id = pp.payroll_run_employee_id
       WHERE pre.payroll_run_id = $1`,
      [req.params.id]
    );
    if (Number(payments.rows[0].count) > 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "مينفعش تلغي التشغيلة - فيه مدفوعات فعلية اتسجلت عليها بالفعل" });
    }

    await reverseJournalEntry(client, {
      originalEntryId: run.rows[0].journal_entry_id, reason, userId: req.user.id,
      idempotencyKey: `payroll-run-cancel-${run.rows[0].id}`,
    });

    const updated = await client.query(
      `UPDATE payroll_runs SET status = 'CANCELLED', cancelled_by = $1, cancelled_at = now(), cancellation_reason = $2 WHERE id = $3 RETURNING *`,
      [req.user.id, reason, req.params.id]
    );
    await logAudit(client, {
      userId: req.user.id, action: "PAYROLL_RUN_CANCELLED", entityType: "payroll_run", entityId: Number(req.params.id),
      metadata: { reason }, req,
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

// POST /api/payroll/runs/:id/payments - سداد فعلي لموظف واحد من تشغيلة معتمدة (زي supplier_payments
// بالظبط) - مدين 2400 رواتب مستحقة (مرتبط بالموظف عن طريق reference_type='employee') / دائن كاش
// الفرع أو البنك. {payrollRunEmployeeId, branchId, amount, paymentDate?, paymentMethodId?, notes?, idempotencyKey?}
router.post("/runs/:id/payments", async (req, res) => {
  const { payrollRunEmployeeId, branchId, amount, paymentDate, paymentMethodId, notes, idempotencyKey } = req.body;
  if (!payrollRunEmployeeId || !branchId || !amount || Number(amount) <= 0) {
    return res.status(400).json({ error: "لازم تحدد الموظف والفرع ومبلغ أكبر من صفر" });
  }
  const client = await pool.connect();
  try {
    if (idempotencyKey) {
      const existing = await client.query("SELECT * FROM payroll_payments WHERE idempotency_key = $1", [idempotencyKey]);
      if (existing.rows.length > 0) return res.status(200).json({ ...existing.rows[0], duplicate: true });
    }

    await client.query("BEGIN");
    const runEmployee = await client.query(
      `SELECT pre.*, pr.status AS run_status FROM payroll_run_employees pre
       JOIN payroll_runs pr ON pr.id = pre.payroll_run_id
       WHERE pre.id = $1 AND pre.payroll_run_id = $2 FOR UPDATE OF pre`,
      [payrollRunEmployeeId, req.params.id]
    );
    if (runEmployee.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "سطر الموظف ده مش موجود في التشغيلة دي" });
    }
    if (runEmployee.rows[0].run_status !== "APPROVED") {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "التشغيلة لازم تكون معتمدة (APPROVED) الأول قبل أي سداد" });
    }

    const paidSoFar = await client.query(
      "SELECT COALESCE(SUM(amount),0) AS total FROM payroll_payments WHERE payroll_run_employee_id = $1", [payrollRunEmployeeId]
    );
    const remaining = Number(runEmployee.rows[0].net_pay) - Number(paidSoFar.rows[0].total);
    if (Number(amount) > remaining + 0.0000001) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: `المبلغ أكبر من المتبقي المستحق للموظف (متبقي ${remaining.toFixed(2)}ج)` });
    }

    let payment;
    try {
      payment = await client.query(
        `INSERT INTO payroll_payments (payroll_run_employee_id, branch_id, payment_date, amount, payment_method_id, notes, idempotency_key, created_by)
         VALUES ($1,$2,COALESCE($3,CURRENT_DATE),$4,$5,$6,$7,$8) RETURNING *`,
        [payrollRunEmployeeId, branchId, paymentDate || null, amount, paymentMethodId || null, notes || null, idempotencyKey || null, req.user.id]
      );
    } catch (err) {
      if (err.code === "23505" && idempotencyKey) {
        await client.query("ROLLBACK");
        const existing = await client.query("SELECT * FROM payroll_payments WHERE idempotency_key = $1", [idempotencyKey]);
        return res.status(200).json({ ...existing.rows[0], duplicate: true });
      }
      throw err;
    }

    const payable = await getAccountByCode(client, "2400");
    let paymentMethodKind = "cash";
    if (paymentMethodId) {
      const pm = await client.query("SELECT kind FROM payment_methods WHERE id = $1", [paymentMethodId]);
      paymentMethodKind = pm.rows[0]?.kind || "cash";
    }
    const cashAccount = paymentMethodKind === "cash"
      ? await getOrCreateBranchCashAccount(client, branchId)
      : await getAccountByCode(client, "1200");

    const je = await postJournalEntry(client, {
      entryDate: payment.rows[0].payment_date, description: `سداد راتب: ${runEmployee.rows[0].employee_name}`,
      sourceType: "payroll_payment", sourceId: payment.rows[0].id, branchId,
      lines: [
        {
          accountId: payable.id, debit: amount, referenceType: "employee", referenceId: runEmployee.rows[0].employee_id,
          description: `سداد لـ${runEmployee.rows[0].employee_name}`,
        },
        { accountId: cashAccount.id, credit: amount },
      ],
      idempotencyKey: `payroll-payment-${payment.rows[0].id}`, userId: req.user.id,
    });
    await client.query("UPDATE payroll_payments SET journal_entry_id = $1 WHERE id = $2", [je.entry.id, payment.rows[0].id]);

    await logAudit(client, {
      branchId, userId: req.user.id, action: "PAYROLL_PAYMENT_CREATED", entityType: "payroll_payment", entityId: payment.rows[0].id,
      newValues: { payrollRunEmployeeId, amount, journalEntryId: je.entry.id }, req,
    });
    await client.query("COMMIT");
    res.status(201).json({ ...payment.rows[0], journal_entry_id: je.entry.id, duplicate: false });
  } catch (err) {
    await client.query("ROLLBACK");
    if (err.code === "PERIOD_CLOSED") return res.status(400).json({ error: err.message });
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

module.exports = router;
