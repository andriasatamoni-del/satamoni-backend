// HR Foundation Hardening (HRF-3): تنفيذ واحد كانوني لتحديث بيانات الموظف - كان مكرر بين
// routes/hr.js وroutes/payroll.js (كل واحد بمنطقه الخاص، وبعمود restricted_branch_id بالذات كان
// عند حماية "أدمن بس" في hr.js ومش موجودة خالص في payroll.js - ثغرة صلاحيات حقيقية اتكشفت في التدقيق).
//
// الملف ده مايعرفش حاجة عن أي راوت بيستخدمه ولا عن أي صلاحية دور - كل route لسه مسؤول عن حماية نفسه
// (canManageStaff في hr.js، payrollAccess في payroll.js) وعن اختيار مين الحقول اللي يسمح بيها من جسم
// الطلب (مايتبعتش req.body كامل من غير فلترة أبدًا) - القاعدة الوحيدة اللي الملف ده بيفرضها بنفسه، بغض
// النظر مين المتصل، هي: نقل فرع (restrictedBranchId) أدمن بس، دايمًا.
const { logAudit } = require("./audit");
const { recordEmployeeHistoryChanges } = require("./employee-history");
const { checkTerminationBlockers, applyTerminationCascade } = require("./employee-termination");

const FIELD_MAP = {
  name: "name", department: "department", jobTitle: "job_title", attendanceSystem: "attendance_system",
  hireDate: "hire_date", baseSalary: "base_salary", workingDaysPerMonth: "working_days_per_month",
  shift: "shift", wageType: "wage_type", hourlyRate: "hourly_rate", phone: "phone", notes: "notes",
  countDay31: "count_day_31", restrictedBranchId: "restricted_branch_id",
  employeeCode: "employee_code", status: "status", terminationDate: "termination_date",
  terminationReason: "termination_reason",
};

class EmployeeUpdateError extends Error {
  constructor(message, { status = 400, code, blockers } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.blockers = blockers;
  }
}

// fields: نفس مفاتيح FIELD_MAP بالظبط (camelCase) - المتصل هو اللي بيقرر مين منهم يبعت أصلًا حسب
// صلاحيته (مش كل الحقول متاحة لكل route)، بالإضافة لـ reason/effectiveDate/acknowledgeBlockers
async function updateEmployee(client, { employeeId, actorUser, fields, req }) {
  if (fields.restrictedBranchId !== undefined && actorUser.role !== "admin") {
    throw new EmployeeUpdateError("نقل موظف بين الفروع أدمن بس", { status: 403 });
  }

  const before = await client.query("SELECT * FROM employees WHERE id = $1 FOR UPDATE", [employeeId]);
  if (before.rows.length === 0) throw new EmployeeUpdateError("الموظف مش موجود", { status: 404 });
  const beforeRow = before.rows[0];

  const isTerminating = fields.status === "terminated" && beforeRow.status !== "terminated";
  let terminationCascade = null;
  let acknowledgedBlockers = null;
  if (isTerminating) {
    const { blockers, driver } = await checkTerminationBlockers(client, beforeRow);
    if (blockers.length > 0 && fields.acknowledgeBlockers !== true) {
      throw new EmployeeUpdateError(
        "فيه بنود معلّقة لازم تراجعها قبل إنهاء خدمة الموظف - لو متأكد، ابعت الطلب تاني مع acknowledgeBlockers:true",
        { status: 409, blockers }
      );
    }
    acknowledgedBlockers = blockers;
    terminationCascade = await applyTerminationCascade(client, { employee: beforeRow, driver, actorUserId: actorUser.id });
  }

  const setClauses = [];
  const values = [];
  let i = 1;
  for (const [key, col] of Object.entries(FIELD_MAP)) {
    if (fields[key] !== undefined) { setClauses.push(`${col} = $${i++}`); values.push(fields[key]); }
  }
  if (setClauses.length === 0) throw new EmployeeUpdateError("مفيش حاجة تتعدل", { status: 400 });
  values.push(employeeId);

  const result = await client.query(`UPDATE employees SET ${setClauses.join(", ")} WHERE id = $${i} RETURNING *`, values);

  await recordEmployeeHistoryChanges(client, {
    employeeId, before: beforeRow,
    changes: {
      department: fields.department, job_title: fields.jobTitle,
      restricted_branch_id: fields.restrictedBranchId, status: fields.status,
    },
    changedBy: actorUser.id, reason: fields.reason || null, effectiveDate: fields.effectiveDate || null,
  });

  await logAudit(client, {
    branchId: beforeRow.restricted_branch_id, userId: actorUser.id, action: "EMPLOYEE_UPDATED",
    entityType: "employee", entityId: employeeId, oldValues: beforeRow, newValues: result.rows[0],
    metadata: fields.reason ? { reason: fields.reason } : null, req,
  });

  if (isTerminating) {
    await logAudit(client, {
      branchId: beforeRow.restricted_branch_id, userId: actorUser.id, action: "EMPLOYEE_TERMINATION_CASCADE",
      entityType: "employee", entityId: employeeId, newValues: terminationCascade,
      metadata: {
        acknowledgedBlockerCodes: acknowledgedBlockers.map((b) => b.code),
        blockersFound: acknowledgedBlockers.length,
      },
      req,
    });
  }

  return { employee: result.rows[0], terminationCascade };
}

module.exports = { updateEmployee, EmployeeUpdateError, FIELD_MAP };
