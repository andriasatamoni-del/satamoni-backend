// استيراد بيانات الرواتب الحقيقية من db/seed-data/payroll-data.json (مستخرجة من شيت "ساتاموني - نظام
// حساب المرتبات الشهري" الأصلي): الموظفين (بيانات يوليو 2026)، أكواد بصمتهم لكل فرع، بصمات الفروع الخام
// ليوليو 2026، حضور المطبخ المركزي اليدوي، والسلف/الجزاءات/المكافآت.
// آمن تكراره - بيحدّث نفس السجلات بدل ما يكرّرها (عدا السلف/الجزاءات/المكافآت، بيتجنب تكرار نفس القيد بالظبط).
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const pool = require("./pool");

async function findOrCreateBranch(client, name, isCentralKitchen = false) {
  const existing = await client.query("SELECT id FROM branches WHERE name = $1 LIMIT 1", [name]);
  if (existing.rows.length > 0) return existing.rows[0].id;
  const created = await client.query(
    "INSERT INTO branches (name, is_central_kitchen) VALUES ($1, $2) RETURNING id",
    [name, isCentralKitchen]
  );
  return created.rows[0].id;
}

// مفيش كود خارجي مخزّن في جدول employees، فبنستخدم (الاسم + القسم + الوظيفة) كمفتاح تمييز عشان الاستيراد
// يفضل آمن تكراره - ده بيفرّق فعليًا بين موظفين بنفس الاسم في نفس القسم (زي حالتين "عبد الرحمن محمد" في
// البيانات الحقيقية: استيوارد وكاشير، مختلفين في الوظيفة).
async function upsertEmployee(client, emp) {
  const existing = await client.query(
    "SELECT id FROM employees WHERE name = $1 AND department = $2 AND job_title = $3 LIMIT 1",
    [emp.name, emp.department, emp.jobTitle]
  );
  const values = [
    emp.name, emp.department, emp.jobTitle, emp.attendanceSystem, emp.hireDate || null,
    emp.baseSalary, emp.workingDaysPerMonth, emp.shift, emp.wageType, emp.hourlyRate,
    emp.phone || null, emp.notes || null, emp.countDay31,
  ];
  if (existing.rows.length > 0) {
    await client.query(
      `UPDATE employees SET attendance_system=$1, hire_date=$2, base_salary=$3,
         working_days_per_month=$4, shift=$5, wage_type=$6, hourly_rate=$7, phone=$8, notes=$9, count_day_31=$10
       WHERE id = $11`,
      [...values.slice(3), existing.rows[0].id]
    );
    return existing.rows[0].id;
  }
  const inserted = await client.query(
    `INSERT INTO employees
      (name, department, job_title, attendance_system, hire_date, base_salary,
       working_days_per_month, shift, wage_type, hourly_rate, phone, notes, count_day_31)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
    values
  );
  return inserted.rows[0].id;
}

async function main() {
  const dataPath = path.join(__dirname, "seed-data", "payroll-data.json");
  const data = JSON.parse(fs.readFileSync(dataPath, "utf8"));

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const branchIds = {};
    for (const name of Object.keys(data.punchesByBranch)) {
      branchIds[name] = await findOrCreateBranch(client, name, false);
    }

    const employeeIdByCode = {};
    for (const emp of data.employees) {
      const employeeId = await upsertEmployee(client, emp);
      employeeIdByCode[emp.code] = employeeId;

      for (const [branchName, deviceCode] of Object.entries(emp.fingerprintCodes || {})) {
        const branchId = branchIds[branchName];
        if (!branchId) continue;
        await client.query(
          `INSERT INTO employee_fingerprint_codes (employee_id, branch_id, device_code)
           VALUES ($1,$2,$3)
           ON CONFLICT (branch_id, device_code) DO UPDATE SET employee_id = EXCLUDED.employee_id`,
          [employeeId, branchId, deviceCode]
        );
      }

      if (emp.restrictedBranch && branchIds[emp.restrictedBranch]) {
        await client.query("UPDATE employees SET restricted_branch_id = $1 WHERE id = $2", [
          branchIds[emp.restrictedBranch], employeeId,
        ]);
      }
    }

    let punchCount = 0;
    for (const [branchName, rows] of Object.entries(data.punchesByBranch)) {
      const branchId = branchIds[branchName];
      for (const p of rows) {
        await client.query(
          `INSERT INTO attendance_punches (branch_id, device_code, punch_date, clock_in, clock_out)
           VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (branch_id, device_code, punch_date)
           DO UPDATE SET clock_in = EXCLUDED.clock_in, clock_out = EXCLUDED.clock_out`,
          [branchId, p.deviceCode, p.date, p.clockIn, p.clockOut]
        );
        punchCount++;
      }
    }

    let manualCount = 0;
    for (const m of data.manualAttendance) {
      const employeeId = employeeIdByCode[m.code];
      if (!employeeId) continue;
      await client.query(
        `INSERT INTO central_kitchen_manual_attendance
          (employee_id, year, month, present_days, absent_days, total_late_minutes, manual_deduction, notes)
         VALUES ($1,2026,7,$2,$3,$4,$5,$6)
         ON CONFLICT (employee_id, year, month) DO UPDATE SET
           present_days = EXCLUDED.present_days, absent_days = EXCLUDED.absent_days,
           total_late_minutes = EXCLUDED.total_late_minutes, manual_deduction = EXCLUDED.manual_deduction,
           notes = EXCLUDED.notes`,
        [employeeId, m.presentDays, m.absentDays, m.totalLateMinutes, m.manualDeduction, m.notes || null]
      );
      manualCount++;
    }

    let adjustmentCount = 0;
    for (const a of data.adjustments) {
      const employeeId = employeeIdByCode[a.code];
      if (!employeeId) continue;
      const dup = await client.query(
        `SELECT id FROM payroll_adjustments
         WHERE employee_id = $1 AND entry_date = $2 AND adjustment_type = $3 AND amount = $4 LIMIT 1`,
        [employeeId, a.date, a.type, a.amount]
      );
      if (dup.rows.length > 0) continue;
      await client.query(
        `INSERT INTO payroll_adjustments (employee_id, entry_date, adjustment_type, amount, notes)
         VALUES ($1,$2,$3,$4,$5)`,
        [employeeId, a.date, a.type, a.amount, a.notes || null]
      );
      adjustmentCount++;
    }

    await client.query("COMMIT");
    console.log(`الموظفين: ${data.employees.length}`);
    console.log(`بصمات الفروع (يوليو 2026): ${punchCount}`);
    console.log(`حضور المطبخ المركزي: ${manualCount}`);
    console.log(`السلف/الجزاءات/المكافآت: ${adjustmentCount}`);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error("فشل الاستيراد:", err.message);
  process.exit(1);
});
