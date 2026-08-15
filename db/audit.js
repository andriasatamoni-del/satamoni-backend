// تسجيل مركزي لأي عملية حساسة (Audit Log) - append-only. أي route يستخدمها لازم يبعتلها client
// (لو جوه transaction) أو pool (لو مفرده) - قابلة للاستخدام في نص transaction عادي زي أي query تاني.
// أخطاء التسجيل نفسه بتتبلع هنا عمدًا (متبعتش الخطأ تاني) عشان تسجيل الـaudit ميكسرش عملية حقيقية
// (زي تسجيل دخول أو بيع) - مهم خصوصًا لحد لسه ما عملش الـmigration بتاع الجدول ده على قاعدته المحلية.
async function logAudit(executor, {
  branchId = null, userId = null, action, entityType = null, entityId = null,
  oldValues = null, newValues = null, metadata = null, req = null,
}) {
  try {
    await executor.query(
      `INSERT INTO audit_logs
        (branch_id, user_id, action, entity_type, entity_id, old_values, new_values, metadata, ip_address, user_agent)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        branchId, userId, action, entityType, entityId,
        oldValues !== null ? JSON.stringify(oldValues) : null,
        newValues !== null ? JSON.stringify(newValues) : null,
        metadata !== null ? JSON.stringify(metadata) : null,
        req?.ip ?? null,
        req?.get ? req.get("user-agent") || null : null,
      ]
    );
  } catch (err) {
    console.error("audit log failed:", err.message);
  }
}

module.exports = { logAudit };
