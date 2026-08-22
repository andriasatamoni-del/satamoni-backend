const jwt = require("jsonwebtoken");
const pool = require("../db/pool");

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  throw new Error("لازم تحدد JWT_SECRET في متغيرات البيئة (.env) قبل تشغيل السيرفر");
}

// المرحلة 6 (6C): قبل كده كان التوكن (JWT، صالح 12 ساعة) هو مصدر الحقيقة الوحيد لـrole/branchId/
// is_active طول مدة صلاحيته - لو موظف اتعطّل حسابه أو اتغيّر دوره/فرعه، أي توكن قديم بتاعه كان
// فاضل شغال بالصلاحيات القديمة لحد ما ينتهي (لغاية 12 ساعة كاملة). التوكن دلوقتي بيتحقق من توقيعه/
// صلاحيته زي الأول، بس بيتستخدم بس كمعرّف هوية (payload.sub) - كل الصلاحيات الفعلية (role/branchId/
// is_active) بترجع تُقرأ فريش من قاعدة البيانات في كل طلب، مش من التوكن نفسه. ده أبسط آلية آمنة من
// غير أي بنية تحتية جديدة (مفيش token blocklist ولا Redis ولا refresh tokens - مجرد قراءة واحدة
// إضافية بمفتاح أساسي مفهرس أصلًا، تكلفتها ضئيلة) وبتقفل الفجوة كاملة: تعطيل الحساب، وأي تغيير
// لاحق في الدور أو الفرع، بيبقى له أثر فوري من الطلب اللي بعده مباشرة - مش لازم استنى انتهاء التوكن.
async function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "لازم تسجل دخول" });

  let payload;
  try {
    payload = jwt.verify(token, JWT_SECRET);
  } catch (err) {
    return res.status(401).json({ error: "التوكن غير صالح أو منتهي، سجل دخول تاني" });
  }

  try {
    const result = await pool.query(
      `SELECT u.id, u.name, u.email, u.role, u.branch_id, u.is_active,
              COALESCE(b.is_central_kitchen, FALSE) AS is_central_kitchen
       FROM users u LEFT JOIN branches b ON b.id = u.branch_id
       WHERE u.id = $1`,
      [payload.sub]
    );
    const user = result.rows[0];
    if (!user || !user.is_active) {
      return res.status(401).json({ error: "الحساب ده معطّل أو مش موجود - تواصل مع الأدمن" });
    }
    req.user = {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      branchId: user.branch_id,
      isCentralKitchen: user.is_central_kitchen,
    };
    next();
  } catch (err) {
    res.status(500).json({ error: err.message });
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
