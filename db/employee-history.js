// المرحلة 4D: تسجيل مركزي لتغييرات جوهرية على بيانات الموظف (فرع/قسم/وظيفة/حالة...) - append-only، زي
// db/audit.js بالظبط لكن مخصّص لـemployee_history (بيانات موظف موثّقة تاريخيًا، منفصلة عن audit_logs
// العام). بيتستخدم من أكتر من route (routes/payroll.js وroutes/hr.js) عشان دايمًا يبقى نفس منطق الـ"مين
// حقل اتغيّر" مش نسخة مختلفة في كل مكان ممكن تتباعد.
const TRACKED_FIELDS = ["department", "job_title", "restricted_branch_id", "status"];

// changes: {department?, job_title?, restricted_branch_id?, status?} - القيم الجديدة بس (اللي فعليًا
// اتبعتت في الـPATCH)؛ الدالة بتقارنها بـbefore (الصف قبل التعديل) وتسجّل سطر واحد بس للحقول اللي فعليًا
// اتغيّرت (لو نفس القيمة القديمة، مفيش سطر يتسجّل خالص - مش كل PATCH بيعتبر "تغيير")
async function recordEmployeeHistoryChanges(client, { employeeId, before, changes, changedBy, reason = null, effectiveDate = null }) {
  for (const field of TRACKED_FIELDS) {
    if (changes[field] === undefined) continue;
    const oldValue = before[field] === null || before[field] === undefined ? null : String(before[field]);
    const newValue = changes[field] === null ? null : String(changes[field]);
    if (oldValue === newValue) continue;
    await client.query(
      `INSERT INTO employee_history (employee_id, field_name, old_value, new_value, effective_date, changed_by, reason)
       VALUES ($1,$2,$3,$4,COALESCE($5, CURRENT_DATE),$6,$7)`,
      [employeeId, field, oldValue, newValue, effectiveDate, changedBy, reason]
    );
  }
}

module.exports = { recordEmployeeHistoryChanges, TRACKED_FIELDS };
