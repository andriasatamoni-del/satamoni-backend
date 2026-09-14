const express = require("express");
const router = express.Router();
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const pool = require("../db/pool");
const { requireAuth } = require("../middleware/auth");
const { ROLE_PERMISSIONS } = require("../middleware/permissions");
const { logAudit } = require("../db/audit");
const { issueApprovalGrant, APPROVER_PERMISSION_BY_ACTION } = require("../db/approval-engine");

const JWT_SECRET = process.env.JWT_SECRET;
const TOKEN_TTL = "12h";

// المرحلة 6 (6B): تحديد محاولات دخول فاشلة - نفس نمط قفل الـPIN تحت بالظبط (في الذاكرة، مفيش مكتبة
// جديدة). المفتاح هنا IP الطالب بس - مش الإيميل - عمدًا، عشان رد القفل مايبقاش وسيلة غير مباشرة
// لمعرفة إن إيميل معيّن "موجود" (لو كنا بنقفل بالإيميل، محاولات كتير على إيميل حقيقي هتقفل بعد
// N محاولة، بينما إيميل وهمي ممكن يتصرف مختلف لو فيه أي فرق منطقي - بالـIP الرد متطابق تمامًا
// في الحالتين). قابل للتحكم بمتغيرات بيئة (LOGIN_MAX_ATTEMPTS/LOGIN_LOCKOUT_MINUTES) زي ما اتطلب صراحة.
const LOGIN_MAX_ATTEMPTS = Number(process.env.LOGIN_MAX_ATTEMPTS || 10);
const LOGIN_LOCKOUT_MS = Number(process.env.LOGIN_LOCKOUT_MINUTES || 15) * 60 * 1000;
const loginAttempts = new Map(); // ip -> { count, lockedUntil }

function getLoginLockoutSeconds(ip) {
  const entry = loginAttempts.get(ip);
  if (!entry || !entry.lockedUntil) return 0;
  const remaining = entry.lockedUntil - Date.now();
  return remaining > 0 ? Math.ceil(remaining / 1000) : 0;
}
function recordLoginFailure(ip) {
  const entry = loginAttempts.get(ip) || { count: 0, lockedUntil: null };
  entry.count += 1;
  if (entry.count >= LOGIN_MAX_ATTEMPTS) {
    entry.lockedUntil = Date.now() + LOGIN_LOCKOUT_MS;
    entry.count = 0;
  }
  loginAttempts.set(ip, entry);
}
function recordLoginSuccess(ip) {
  loginAttempts.delete(ip);
}

// POST /api/auth/login - {email, password} -> {token, user}
router.post("/login", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: "لازم تبعت email و password" });
  }

  const lockedSeconds = getLoginLockoutSeconds(req.ip);
  if (lockedSeconds > 0) {
    return res.status(429).json({ error: `محاولات دخول كتير غلط - جرب تاني بعد ${lockedSeconds} ثانية` });
  }

  try {
    const result = await pool.query(
      `SELECT u.*, COALESCE(b.is_central_kitchen, FALSE) AS is_central_kitchen
       FROM users u
       LEFT JOIN branches b ON b.id = u.branch_id
       WHERE u.email = $1 AND u.is_active = TRUE`,
      [email]
    );
    const user = result.rows[0];
    if (!user) {
      recordLoginFailure(req.ip);
      await logAudit(pool, { action: "LOGIN_FAILED", metadata: { email }, req });
      return res.status(401).json({ error: "بيانات الدخول غلط" });
    }

    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) {
      recordLoginFailure(req.ip);
      await logAudit(pool, {
        branchId: user.branch_id, userId: user.id, action: "LOGIN_FAILED", metadata: { email }, req,
      });
      return res.status(401).json({ error: "بيانات الدخول غلط" });
    }
    recordLoginSuccess(req.ip);
    await logAudit(pool, { branchId: user.branch_id, userId: user.id, action: "LOGIN", req });

    const payload = {
      sub: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      branchId: user.branch_id,
      isCentralKitchen: user.is_central_kitchen,
    };
    const token = jwt.sign(payload, JWT_SECRET, { expiresIn: TOKEN_TTL });

    res.json({
      token,
      user: {
        id: user.id, name: user.name, email: user.email,
        role: user.role, branchId: user.branch_id, isCentralKitchen: user.is_central_kitchen,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/auth/me - بيانات المستخدم المسجل دخوله حاليًا + قايمة صلاحياته الدقيقة (permissions)
router.get("/me", requireAuth, (req, res) => {
  res.json({ ...req.user, permissions: ROLE_PERMISSIONS[req.user.role] || [] });
});

// حد محاولات الـ PIN الغلط - في الذاكرة بس (كل فرع بيشغّل عملية Node واحدة طويلة، مش محتاجين
// تخزين دائم)، متتبّع بحساب الموظف اللي بيحاول (req.user.id) بغض النظر عن الفرع اللي بيبعته.
// بعد 5 محاولات غلط بيتقفل 5 دقايق - عشان محدش يقدر يجرب كل الأرقام من 0000 لـ 9999.
const pinAttempts = new Map(); // userId -> { count, lockedUntil }
const MAX_PIN_ATTEMPTS = 5;
const PIN_LOCKOUT_MS = 5 * 60 * 1000;

function getPinLockoutSeconds(userId) {
  const entry = pinAttempts.get(userId);
  if (!entry || !entry.lockedUntil) return 0;
  const remaining = entry.lockedUntil - Date.now();
  return remaining > 0 ? Math.ceil(remaining / 1000) : 0;
}
function recordPinFailure(userId) {
  const entry = pinAttempts.get(userId) || { count: 0, lockedUntil: null };
  entry.count += 1;
  if (entry.count >= MAX_PIN_ATTEMPTS) {
    entry.lockedUntil = Date.now() + PIN_LOCKOUT_MS;
    entry.count = 0;
  }
  pinAttempts.set(userId, entry);
}
function recordPinSuccess(userId) {
  pinAttempts.delete(userId);
}

// POST /api/auth/verify-override-pin - {pin, branchId?, actionType, targetType, targetId} ->
// {token, approverId, approverName, expiresAt}
// المرحلة 9A-1: كانت قبل كده بترجّع هوية المدير (approverId) بس - أي حد يعرفها يقدر يعيد استخدامها
// لأي عملية حساسة تانية من غير ما المدير يدخل الـPIN تاني خالص (ثغرة احتيال حقيقية). دلوقتي لازم تحدد
// صراحة عايز توافق على إيه بالظبط (actionType) ولإيه (targetType/targetId - مثلًا رقم الطلب، أو
// idempotencyKey الطلب لو لسه مش اتسجل) - والتوكن اللي بيرجع مش بيشتغل إلا لنفس العملية دي بالظبط،
// مرة واحدة بس. راجع db/approval-engine.js. أي موظف مسجل دخول يقدر يطلبها، بس بترجع توكن صالح بس لو
// الـPIN فعلاً بتاع مدير فرع (نفس الفرع) أو أدمن معاه صلاحية الموافقة على actionType ده تحديدًا.
router.post("/verify-override-pin", requireAuth, async (req, res) => {
  const { pin, branchId, actionType, targetType, targetId } = req.body;
  if (!pin) return res.status(400).json({ error: "لازم تدخل PIN" });
  if (!actionType || !APPROVER_PERMISSION_BY_ACTION.hasOwnProperty(actionType)) {
    return res.status(400).json({ error: "نوع الإجراء المطلوب موافقة عليه غير معروف" });
  }
  if (!targetType || targetId === undefined || targetId === null || targetId === "") {
    return res.status(400).json({ error: "لازم تحدد العملية المطلوب الموافقة عليها بالظبط" });
  }

  const lockedSeconds = getPinLockoutSeconds(req.user.id);
  if (lockedSeconds > 0) {
    return res.status(429).json({ error: `محاولات كتير غلط - جرب تاني بعد ${lockedSeconds} ثانية` });
  }

  try {
    const result = await issueApprovalGrant(pool, {
      pin, branchId, actionType, targetType, targetId, requestedByUserId: req.user.id,
    });
    if (result.error === "PIN_INVALID") {
      recordPinFailure(req.user.id);
      return res.status(401).json({ error: "PIN غير صحيح" });
    }
    if (result.error === "PERMISSION_DENIED") {
      recordPinFailure(req.user.id);
      return res.status(403).json({ error: `${result.approverName} معندوش صلاحية يوافق على الإجراء ده` });
    }
    recordPinSuccess(req.user.id);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
