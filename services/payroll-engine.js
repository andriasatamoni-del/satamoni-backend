// محرك حساب الرواتب - بديل شيت "ملخص الرواتب" في إكسل ساتاموني للمرتبات.
// الحساب مقسّم حسب نظام الحضور (fingerprint_auto / manual / none) لأن كل نوع له معادلات مختلفة تمامًا،
// بالظبط زي التفرقة في الشيت الأصلي بين شيتات البصمة وشيت "حضور المطبخ المركزي (يدوي)".

// موظفي البصمة التلقائي: كل الحساب (تأخير/إجازة/غياب زائد/هدر ساعات/أوفر تايم) بيتحسب من attendance_punches
// يوم بدون بصمة = إجازة تلقائيًا (بنولّد كل أيام الشهر بـ generate_series ونعمل LEFT JOIN على البصمات الفعلية،
// عشان نقدر نستورد بصمات الجهاز الخام من غير الحاجة لصفوف فاضية لكل يوم).
async function computeFingerprintPayroll(pool, year, month) {
  const result = await pool.query(
    `WITH month_days AS (
       SELECT generate_series(
         make_date($1::int, $2::int, 1),
         (make_date($1::int, $2::int, 1) + INTERVAL '1 month' - INTERVAL '1 day')::date,
         INTERVAL '1 day'
       )::date AS punch_date
     ),
     raw_punches AS (
       SELECT efc.employee_id, ap.branch_id, ap.punch_date, ap.clock_in, ap.clock_out, ap.exempted
       FROM employee_fingerprint_codes efc
       JOIN attendance_punches ap ON ap.branch_id = efc.branch_id AND ap.device_code = efc.device_code
       WHERE EXTRACT(YEAR FROM ap.punch_date) = $1 AND EXTRACT(MONTH FROM ap.punch_date) = $2
     ),
     collapsed_punches AS (
       -- لو الموظف بيتنقل بين فروع في نفس اليوم (حالة نادرة زي "الطيار")، ناخد سطر البصمة الفعلي بدل الفاضي
       SELECT DISTINCT ON (employee_id, punch_date)
         employee_id, branch_id, punch_date, clock_in, clock_out, exempted
       FROM raw_punches
       ORDER BY employee_id, punch_date, (clock_in IS NULL AND clock_out IS NULL), branch_id
     ),
     fingerprint_employees AS (
       SELECT e.id, e.count_day_31, e.restricted_branch_id
       FROM employees e
       WHERE e.attendance_system = 'fingerprint_auto' AND e.is_active = TRUE
     ),
     emp_days AS (
       SELECT fe.id AS employee_id, md.punch_date, cp.branch_id, cp.clock_in, cp.clock_out,
              COALESCE(cp.exempted, FALSE) AS exempted
       FROM fingerprint_employees fe
       CROSS JOIN month_days md
       LEFT JOIN collapsed_punches cp ON cp.employee_id = fe.id AND cp.punch_date = md.punch_date
         AND (fe.restricted_branch_id IS NULL OR cp.branch_id = fe.restricted_branch_id)
       WHERE NOT (EXTRACT(DAY FROM md.punch_date) = 31 AND NOT fe.count_day_31)
     ),
     derived AS (
       SELECT ed.employee_id, ed.punch_date, ed.branch_id, ed.clock_in, ed.clock_out, ed.exempted,
         CASE WHEN ed.clock_in IS NOT NULL AND (CASE e.shift WHEN 'morning' THEN ps.morning_shift_start WHEN 'evening' THEN ps.evening_shift_start ELSE NULL END) IS NOT NULL
              THEN GREATEST(0, ROUND(EXTRACT(EPOCH FROM (ed.clock_in - (CASE e.shift WHEN 'morning' THEN ps.morning_shift_start WHEN 'evening' THEN ps.evening_shift_start ELSE NULL END))) / 60))
              ELSE 0 END::int AS late_minutes,
         CASE
           WHEN ed.clock_in IS NULL AND ed.clock_out IS NULL THEN 'leave'
           WHEN ed.clock_in IS NULL THEN 'missed_clock_in'
           WHEN ed.clock_out IS NULL THEN 'missed_clock_out'
           ELSE 'present'
         END AS status,
         CASE WHEN ed.clock_in IS NOT NULL AND ed.clock_out IS NOT NULL THEN
           CASE WHEN ed.clock_out >= ed.clock_in
                THEN EXTRACT(EPOCH FROM (ed.clock_out - ed.clock_in)) / 3600.0
                ELSE EXTRACT(EPOCH FROM (ed.clock_out - ed.clock_in + INTERVAL '24 hours')) / 3600.0
           END
         ELSE NULL END AS work_hours
       FROM emp_days ed
       JOIN employees e ON e.id = ed.employee_id
       CROSS JOIN payroll_settings ps
     ),
     tiered AS (
       SELECT d.*,
         COALESCE((SELECT t.deduction_fraction FROM late_deduction_tiers t
                   WHERE d.late_minutes >= t.from_minute AND d.late_minutes < t.to_minute LIMIT 1), 0) AS tier_fraction
       FROM derived d
     ),
     ranked AS (
       SELECT *,
         COUNT(*) FILTER (WHERE status = 'present' AND tier_fraction > 0)
           OVER (PARTITION BY employee_id ORDER BY punch_date ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS late_rank
       FROM tiered
     ),
     priced AS (
       SELECT r.*, e.base_salary, e.working_days_per_month, e.wage_type, e.hourly_rate, e.name, e.department, e.job_title,
              ps.standard_shift_hours, ps.overtime_multiplier, ps.min_overtime_hours,
              ps.allowed_late_exemptions, ps.missed_punch_deduction_fraction,
              (e.base_salary / NULLIF(e.working_days_per_month, 0)) AS day_rate
       FROM ranked r
       JOIN employees e ON e.id = r.employee_id
       CROSS JOIN payroll_settings ps
     ),
     day_calc AS (
       SELECT *,
         CASE
           WHEN status = 'leave' THEN 0
           WHEN exempted THEN 0
           WHEN status IN ('missed_clock_in', 'missed_clock_out') THEN missed_punch_deduction_fraction
           WHEN tier_fraction > 0 AND late_rank <= allowed_late_exemptions THEN 0
           ELSE tier_fraction
         END AS day_deduction_fraction,
         CASE WHEN status = 'present' THEN GREATEST(0, standard_shift_hours - work_hours) ELSE 0 END AS short_hours,
         CASE WHEN status = 'present' AND (work_hours - standard_shift_hours) >= min_overtime_hours
              THEN work_hours - standard_shift_hours ELSE 0 END AS overtime_hours
       FROM priced
     ),
     final_day AS (
       SELECT *,
         ROUND(day_deduction_fraction * day_rate, 2) AS day_deduction_amount,
         ROUND(short_hours * (day_rate / NULLIF(standard_shift_hours, 0)), 2) AS short_hours_deduction,
         ROUND(overtime_hours * (day_rate / NULLIF(standard_shift_hours, 0)) * overtime_multiplier, 2) AS overtime_pay
       FROM day_calc
     ),
     branch_mode AS (
       -- الفرع الأساسي = الفرع اللي بصم فيه أكتر أيام حضور الشهر ده
       SELECT DISTINCT ON (employee_id) employee_id, branch_id
       FROM final_day
       WHERE status = 'present' AND branch_id IS NOT NULL
       GROUP BY employee_id, branch_id
       ORDER BY employee_id, COUNT(*) DESC
     ),
     summary AS (
       SELECT employee_id, MAX(name) AS name, MAX(department) AS department, MAX(job_title) AS job_title,
         MAX(base_salary) AS base_salary, MAX(working_days_per_month) AS working_days_per_month,
         MAX(wage_type) AS wage_type, MAX(hourly_rate) AS hourly_rate, MAX(day_rate) AS day_rate,
         COUNT(*) AS total_days_considered,
         COUNT(*) FILTER (WHERE status = 'present') AS present_days,
         COUNT(*) FILTER (WHERE status = 'leave') AS leave_days,
         SUM(late_minutes) AS total_late_minutes,
         SUM(day_deduction_amount) AS late_deduction_total,
         SUM(short_hours) AS total_short_hours,
         SUM(short_hours_deduction) AS short_hours_deduction_total,
         SUM(overtime_hours) AS total_overtime_hours,
         SUM(overtime_pay) AS overtime_pay_total,
         SUM(work_hours) FILTER (WHERE status = 'present') AS total_work_hours,
         (SELECT MAX(paid_leave_days_per_month) FROM payroll_settings) AS paid_leave_days_per_month
       FROM final_day
       GROUP BY employee_id
     ),
     with_excess AS (
       SELECT s.*,
         GREATEST(0, (s.total_days_considered - s.paid_leave_days_per_month) - s.present_days) AS excess_absence_days,
         GREATEST(0, s.present_days - (s.total_days_considered - s.paid_leave_days_per_month)) AS extra_work_days
       FROM summary s
     )
     -- كل الحساب المالي (ضرب/تقريب) بيحصل جوه SQL بـ NUMERIC عشان نتجنب أخطاء دقة الأرقام العشرية في JS
     SELECT we.*,
       ROUND(we.excess_absence_days * we.day_rate, 2) AS excess_absence_deduction,
       ROUND(we.extra_work_days * we.day_rate, 2) AS extra_work_bonus,
       CASE WHEN we.wage_type = 'hourly' THEN ROUND(COALESCE(we.total_work_hours, 0) * we.hourly_rate, 2)
            ELSE we.base_salary - we.late_deduction_total
                 - ROUND(we.excess_absence_days * we.day_rate, 2) + ROUND(we.extra_work_days * we.day_rate, 2)
                 - we.short_hours_deduction_total + we.overtime_pay_total
       END AS pay_after_attendance,
       b.id AS branch_id, b.name AS branch_name
     FROM with_excess we
     LEFT JOIN branch_mode bm ON bm.employee_id = we.employee_id
     LEFT JOIN branches b ON b.id = bm.branch_id
     ORDER BY we.employee_id`,
    [year, month]
  );

  return result.rows.map((r) => ({
    employeeId: r.employee_id,
    name: r.name,
    department: r.department,
    jobTitle: r.job_title,
    attendanceSystem: "fingerprint_auto",
    baseSalary: Number(r.base_salary),
    wageType: r.wage_type,
    hourlyRate: Number(r.hourly_rate),
    presentDays: Number(r.present_days),
    leaveDays: Number(r.leave_days),
    totalLateMinutes: Number(r.total_late_minutes),
    lateDeductionTotal: Number(r.late_deduction_total),
    excessAbsenceDays: Number(r.excess_absence_days),
    excessAbsenceDeduction: Number(r.excess_absence_deduction),
    extraWorkDays: Number(r.extra_work_days),
    extraWorkBonus: Number(r.extra_work_bonus),
    totalShortHours: Number(r.total_short_hours),
    shortHoursDeductionTotal: Number(r.short_hours_deduction_total),
    totalOvertimeHours: Number(r.total_overtime_hours),
    overtimePayTotal: Number(r.overtime_pay_total),
    totalWorkHours: r.total_work_hours !== null ? Number(r.total_work_hours) : null,
    payAfterAttendance: Number(r.pay_after_attendance),
    primaryBranch: r.branch_name || null,
    primaryBranchId: r.branch_id || null,
  }));
}

// موظفي المطبخ المركزي (يدوي - بدون بصمة): الحضور/الغياب بيتدخل يدويًا شهريًا لكل موظف،
// خصم الغياب بيتحسب بمعدل يوم العمل زي الفينجربرنت، لكن مفيش مفهوم "أيام عمل إضافية" هنا
// ومفيش هدر ساعات/أوفر تايم (مفيش بصمة تفصيلية أصلًا) - الخصم اليدوي الإضافي بييجي كرقم جاهز بالجنيه.
async function computeManualPayroll(pool, year, month) {
  const result = await pool.query(
    `SELECT e.id AS employee_id, e.name, e.department, e.job_title, e.base_salary, e.working_days_per_month,
            COALESCE(cka.present_days, 0) AS present_days,
            COALESCE(cka.absent_days, 0) AS absent_days,
            COALESCE(cka.total_late_minutes, 0) AS total_late_minutes,
            COALESCE(cka.manual_deduction, 0) AS manual_deduction,
            ROUND(COALESCE(cka.absent_days, 0) * (e.base_salary / NULLIF(e.working_days_per_month, 0)), 2) AS excess_absence_deduction,
            e.base_salary - COALESCE(cka.manual_deduction, 0)
              - ROUND(COALESCE(cka.absent_days, 0) * (e.base_salary / NULLIF(e.working_days_per_month, 0)), 2) AS pay_after_attendance
     FROM employees e
     LEFT JOIN central_kitchen_manual_attendance cka
       ON cka.employee_id = e.id AND cka.year = $1 AND cka.month = $2
     WHERE e.attendance_system = 'manual' AND e.is_active = TRUE`,
    [year, month]
  );

  return result.rows.map((r) => ({
    employeeId: r.employee_id,
    name: r.name,
    department: r.department,
    jobTitle: r.job_title,
    attendanceSystem: "manual",
    baseSalary: Number(r.base_salary),
    wageType: "fixed_monthly",
    hourlyRate: 0,
    presentDays: Number(r.present_days),
    leaveDays: 0,
    totalLateMinutes: Number(r.total_late_minutes),
    lateDeductionTotal: Number(r.manual_deduction),
    excessAbsenceDays: Number(r.absent_days),
    excessAbsenceDeduction: Number(r.excess_absence_deduction),
    extraWorkDays: 0,
    extraWorkBonus: 0,
    totalShortHours: 0,
    shortHoursDeductionTotal: 0,
    totalOvertimeHours: 0,
    overtimePayTotal: 0,
    totalWorkHours: null,
    payAfterAttendance: Number(r.pay_after_attendance),
    primaryBranch: null,
    primaryBranchId: null,
  }));
}

// موظفي الإدارة/الحسابات بدون تتبع حضور خالص - الراتب الأساسي زي ما هو، مفيش خصومات حضور
async function computeNoTrackingPayroll(pool) {
  const result = await pool.query(
    "SELECT id AS employee_id, name, department, job_title, base_salary FROM employees WHERE attendance_system = 'none' AND is_active = TRUE"
  );
  return result.rows.map((r) => ({
    employeeId: r.employee_id,
    name: r.name,
    department: r.department,
    jobTitle: r.job_title,
    attendanceSystem: "none",
    baseSalary: Number(r.base_salary),
    wageType: "fixed_monthly",
    hourlyRate: 0,
    presentDays: null,
    leaveDays: 0,
    totalLateMinutes: 0,
    lateDeductionTotal: 0,
    excessAbsenceDays: 0,
    excessAbsenceDeduction: 0,
    extraWorkDays: 0,
    extraWorkBonus: 0,
    totalShortHours: 0,
    shortHoursDeductionTotal: 0,
    totalOvertimeHours: 0,
    overtimePayTotal: 0,
    totalWorkHours: null,
    payAfterAttendance: Number(r.base_salary),
    primaryBranch: null,
    primaryBranchId: null,
  }));
}

module.exports = { computeFingerprintPayroll, computeManualPayroll, computeNoTrackingPayroll };
