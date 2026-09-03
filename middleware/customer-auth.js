const jwt = require("jsonwebtoken");
const pool = require("../db/pool");

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  throw new Error("لازم تحدد JWT_SECRET في متغيرات البيئة (.env) قبل تشغيل السيرفر");
}
// سر مشتق منفصل تمامًا عن توكن الموظفين (middleware/auth.js) - عمدًا، عشان توكن عميل ميتحققش أبدًا
// بمكتبة jwt.verify بتاعة الموظفين ولا العكس، حتى لو بالصدفة عندهم نفس الـsub (رقم تليفون عميل ممكن
// يتساوى رقميًا مع id موظف). الاشتقاق هنا بدل متغير بيئة جديد عشان يشتغل فورًا من غير أي إعداد إضافي
// على الاستضافة.
const CUSTOMER_JWT_SECRET = `${JWT_SECRET}::customer`;
const CUSTOMER_TOKEN_TTL = "180d"; // موقع طلب عادي - الجلسة تفضل طويلة، مفيش حساسية زي حساب موظف

function signCustomerToken(phone) {
  return jwt.sign({ sub: phone }, CUSTOMER_JWT_SECRET, { expiresIn: CUSTOMER_TOKEN_TTL });
}

// requireCustomerAuth - بيتحقق من توكن العميل ويجيب بياناته فريش من قاعدة البيانات في كل طلب (نفس
// فلسفة middleware/auth.js بالظبط: التوكن مجرد هوية، الصلاحية/الحظر بيتقروا لايف)
async function requireCustomerAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "لازم تسجل دخول" });

  let payload;
  try {
    payload = jwt.verify(token, CUSTOMER_JWT_SECRET);
  } catch (err) {
    return res.status(401).json({ error: "التوكن غير صالح أو منتهي، سجل دخول تاني" });
  }

  try {
    const result = await pool.query(
      `SELECT phone, phone2, name, address_details, delivery_area_id, distinguishing_mark,
              loyalty_points, is_blocked, password_hash
       FROM customers WHERE phone = $1`,
      [payload.sub]
    );
    const customer = result.rows[0];
    if (!customer || !customer.password_hash) {
      return res.status(401).json({ error: "الحساب ده مش موجود، سجل دخول تاني" });
    }
    req.customer = {
      phone: customer.phone,
      phone2: customer.phone2,
      name: customer.name,
      addressDetails: customer.address_details,
      deliveryAreaId: customer.delivery_area_id,
      distinguishingMark: customer.distinguishing_mark,
      loyaltyPoints: customer.loyalty_points,
      isBlocked: customer.is_blocked,
    };
    next();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

module.exports = { requireCustomerAuth, signCustomerToken, CUSTOMER_JWT_SECRET };
