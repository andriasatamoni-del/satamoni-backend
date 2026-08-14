const jwt = require("jsonwebtoken");

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  throw new Error("لازم تحدد JWT_SECRET في متغيرات البيئة (.env) قبل تشغيل السيرفر");
}

// requireAuth - لازم توكن صالح في Authorization: Bearer <token>
function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "لازم تسجل دخول" });

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = {
      id: payload.sub,
      name: payload.name,
      email: payload.email,
      role: payload.role,
      branchId: payload.branchId,
      isCentralKitchen: payload.isCentralKitchen || false,
    };
    next();
  } catch (err) {
    return res.status(401).json({ error: "التوكن غير صالح أو منتهي، سجل دخول تاني" });
  }
}

// requireRole('admin', 'cashier', ...) - لازم يكون req.user.role من ضمن الأدوار المسموحة
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: "لازم تسجل دخول" });
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: "مفيش صلاحية للوصول لده" });
    }
    next();
  };
}

// لغير الأدمن، لازم أي branchId يتبعت يكون هو نفسه فرع المستخدم
function assertOwnBranch(user, branchId) {
  if (user.role === "admin") return true;
  if (!branchId) return false;
  return String(user.branchId) === String(branchId);
}

module.exports = { requireAuth, requireRole, assertOwnBranch };
