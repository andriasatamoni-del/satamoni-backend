// المرحلة 9A-1: موافقة PIN مدير/أدمن اللحظية (خصم كبير، استرجاع طلب، فرق تحصيل سائق، ...) - راجع
// db/schema.sql (approval_grants) للشرح الكامل للثغرة اللي الملف ده بيقفلها. القاعدة: أي حد يطلب "توكن
// موافقة" لازم يحدد صراحة عايز يوافق على إيه بالظبط (actionType) ولإيه (targetType/targetId)، والتوكن
// اللي بيرجع منها ميشتغلش إلا لنفس الإجراء ده بالظبط - استهلاكه atomic (نفس نمط claim طابور الطباعة)
// عشان لو نفس التوكن اتبعت مرتين متزامنة، واحدة بس تنجح.
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const { hasPermission } = require("../middleware/permissions");

const GRANT_TTL_MINUTES = 10;

// actionType -> الصلاحية المطلوبة عشان حد يقدر "يوافق" على الإجراء ده (مش الصلاحية اللي بتخليه يطلبه).
// null = زي ما كان قبل كده بالظبط (مدير فرع/أدمن بس على مستوى الدور، مفيش مفتاح صلاحية مخصص ليها لسه)
const APPROVER_PERMISSION_BY_ACTION = {
  ORDER_VOID: "orders.void.approve",
  ORDER_DISCOUNT: "orders.discount.approve",
  INVENTORY_OVERRIDE: null,
  DELIVERY_COLLECTION_VARIANCE: null,
  EMERGENCY_PURCHASE_DUPLICATE_OVERRIDE: null,
};

// POST /api/auth/verify-override-pin بينادي الدالة دي: بيدور على مدير فرع (نفس الفرع) أو أدمن معاه
// الـPIN ده، وبيتأكد كمان إنه ملوش صلاحية الموافقة على الإجراء ده متلغاة (revoke فردي - المرحلة 8.58)
// حتى لو دوره الأساسي بيسمح بيها. بيرجّع {token, approverId, approverName, expiresAt} أو {error}
async function issueApprovalGrant(client, { pin, branchId, actionType, targetType, targetId, requestedByUserId }) {
  if (!APPROVER_PERMISSION_BY_ACTION.hasOwnProperty(actionType)) {
    return { error: "ACTION_TYPE_UNKNOWN" };
  }
  const candidates = await client.query(
    `SELECT id, name, role, branch_id, pin_hash, permission_grants, permission_revokes FROM users
     WHERE is_active = TRUE AND pin_hash IS NOT NULL
       AND (role = 'admin' OR (role = 'branch_manager' AND branch_id = $1))`,
    [branchId || null]
  );
  let matched = null;
  for (const candidate of candidates.rows) {
    if (await bcrypt.compare(pin, candidate.pin_hash)) { matched = candidate; break; }
  }
  if (!matched) return { error: "PIN_INVALID" };

  const requiredPermission = APPROVER_PERMISSION_BY_ACTION[actionType];
  if (requiredPermission) {
    const userForCheck = {
      role: matched.role,
      permissionGrants: matched.permission_grants || [],
      permissionRevokes: matched.permission_revokes || [],
    };
    if (!hasPermission(userForCheck, requiredPermission)) {
      return { error: "PERMISSION_DENIED", approverName: matched.name };
    }
  }

  const token = crypto.randomBytes(24).toString("hex");
  const expiresAt = new Date(Date.now() + GRANT_TTL_MINUTES * 60 * 1000);
  await client.query(
    `INSERT INTO approval_grants
      (token, action_type, target_type, target_id, branch_id, approved_by, requested_by, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [token, actionType, targetType, String(targetId), branchId || null, matched.id, requestedByUserId || null, expiresAt]
  );
  return {
    token, approverId: matched.id, approverName: matched.name, approverRole: matched.role,
    expiresAt: expiresAt.toISOString(),
  };
}

// كل مستهلكي approval grant (void, discount, delivery variance, ...) بينادوا الدالة دي. الاستهلاك
// atomic بالكامل جوه UPDATE...WHERE واحد - أي محاولة استهلاك لتوكن لإجراء/كيان/فرع مختلف عن اللي
// اتسجل ليه أصلًا (أو منتهي/مستخدم قبل كده) مبتأثرش على أي صف خالص، فالتوكن الحقيقي يفضل صالح
async function consumeApprovalGrant(client, { token, actionType, targetType, targetId, branchId, usedByUserId }) {
  if (!token) {
    const err = new Error("محتاج موافقة مدير الفرع أو الأدمن");
    err.code = "APPROVAL_REQUIRED";
    throw err;
  }
  const result = await client.query(
    `UPDATE approval_grants
     SET status = 'USED', used_by = $1, used_at = now()
     WHERE token = $2 AND action_type = $3 AND target_type = $4 AND target_id = $5
       AND status = 'ACTIVE' AND expires_at > now()
       AND ($6::int IS NULL OR branch_id IS NULL OR branch_id = $6)
     RETURNING *`,
    [usedByUserId, token, actionType, targetType, String(targetId), branchId || null]
  );
  if (result.rows.length === 0) {
    const diag = await client.query(`SELECT status, expires_at FROM approval_grants WHERE token = $1`, [token]);
    let message = "الموافقة غير صالحة";
    if (diag.rows.length > 0) {
      const g = diag.rows[0];
      if (g.status === "USED") message = "الموافقة دي اتستخدمت قبل كده";
      else if (g.status === "REVOKED") message = "الموافقة دي اتلغت";
      else if (new Date(g.expires_at) <= new Date()) message = "الموافقة دي منتهية الصلاحية";
      else message = "الموافقة دي مش لنفس العملية";
    }
    const err = new Error(message);
    err.code = "APPROVAL_INVALID";
    throw err;
  }
  const grant = result.rows[0];
  const approverRes = await client.query(
    `SELECT id, name, role, branch_id, is_active FROM users WHERE id = $1`, [grant.approved_by]
  );
  return { grant, approver: approverRes.rows[0] };
}

module.exports = { issueApprovalGrant, consumeApprovalGrant, APPROVER_PERMISSION_BY_ACTION, GRANT_TTL_MINUTES };
