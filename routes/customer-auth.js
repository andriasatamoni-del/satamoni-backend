// المرحلة 8.38: تسجيل/دخول حساب عميل حقيقي لموقع الطلب أونلاين (public/order.html) - رقم تليفون +
// كلمة سر (مفيش بوابة SMS/واتساب حقيقية موصولة دلوقتي عشان OTP - راجع db/sms-provider.js؛ لما بوابة
// حقيقية تتظبط، ممكن تحويل الدخول لـOTP بدل كلمة السر من غير أي تغيير في شكل الحساب نفسه). التسجيل/
// الدخول اختياري بالكامل - الطلب كضيف (بدون حساب) فاضل شغال بالظبط زي ما هو في POST /api/orders.
const express = require("express");
const router = express.Router();
const bcrypt = require("bcryptjs");
const pool = require("../db/pool");
const { requireCustomerAuth, signCustomerToken } = require("../middleware/customer-auth");

const MIN_PASSWORD_LENGTH = 6;

function normalizePhone(raw) {
  return String(raw || "").replace(/[\s-]/g, "");
}
function isValidPhone(phone) {
  return /^\d{8,15}$/.test(phone);
}

function toProfile(customer) {
  return {
    phone: customer.phone,
    phone2: customer.phone2,
    name: customer.name,
    addressDetails: customer.address_details,
    deliveryAreaId: customer.delivery_area_id,
    distinguishingMark: customer.distinguishing_mark,
    loyaltyPoints: customer.loyalty_points,
  };
}

// حد محاولات دخول غلط بالـIP - نفس نمط routes/auth.js بالظبط (خريطة في الذاكرة، مفتاح IP مش رقم
// التليفون عشان رد القفل ميبقاش وسيلة غير مباشرة لمعرفة إن رقم معيّن "عنده حساب")
const LOGIN_MAX_ATTEMPTS = Number(process.env.LOGIN_MAX_ATTEMPTS || 10);
const LOGIN_LOCKOUT_MS = Number(process.env.LOGIN_LOCKOUT_MINUTES || 15) * 60 * 1000;
const loginAttempts = new Map();
function getLockoutSeconds(ip) {
  const entry = loginAttempts.get(ip);
  if (!entry || !entry.lockedUntil) return 0;
  const remaining = entry.lockedUntil - Date.now();
  return remaining > 0 ? Math.ceil(remaining / 1000) : 0;
}
function recordFailure(ip) {
  const entry = loginAttempts.get(ip) || { count: 0, lockedUntil: null };
  entry.count += 1;
  if (entry.count >= LOGIN_MAX_ATTEMPTS) {
    entry.lockedUntil = Date.now() + LOGIN_LOCKOUT_MS;
    entry.count = 0;
  }
  loginAttempts.set(ip, entry);
}
function recordSuccess(ip) {
  loginAttempts.delete(ip);
}

// POST /api/customer-auth/register - {phone, name, password} -> {token, customer}
// لو الرقم ده موجود قبل كده من طلب ضيف سابق (مفيش عليه حساب لسه)، بيتحول لحساب حقيقي وبياناته
// القديمة (نقاط الولاء، العنوان المحفوظ) بتفضل زي ما هي - مش بنبدأ من صفر.
router.post("/register", async (req, res) => {
  const phone = normalizePhone(req.body.phone);
  const name = String(req.body.name || "").trim();
  const password = String(req.body.password || "");

  if (!isValidPhone(phone)) return res.status(400).json({ error: "رقم التليفون غير صالح" });
  if (!name) return res.status(400).json({ error: "لازم الاسم" });
  if (password.length < MIN_PASSWORD_LENGTH) {
    return res.status(400).json({ error: `كلمة السر لازم تكون ${MIN_PASSWORD_LENGTH} حروف/أرقام على الأقل` });
  }

  try {
    const existing = await pool.query("SELECT phone, password_hash FROM customers WHERE phone = $1", [phone]);
    if (existing.rows[0]?.password_hash) {
      return res.status(409).json({ error: "الرقم ده عنده حساب بالفعل - سجل دخول بدل التسجيل" });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const result = await pool.query(
      `INSERT INTO customers (phone, name, password_hash)
       VALUES ($1, $2, $3)
       ON CONFLICT (phone) DO UPDATE SET
         name = EXCLUDED.name,
         password_hash = EXCLUDED.password_hash,
         updated_at = now()
       RETURNING phone, phone2, name, address_details, delivery_area_id, distinguishing_mark, loyalty_points`,
      [phone, name, passwordHash]
    );

    const token = signCustomerToken(phone);
    res.status(201).json({ token, customer: toProfile(result.rows[0]) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/customer-auth/login - {phone, password} -> {token, customer}
router.post("/login", async (req, res) => {
  const phone = normalizePhone(req.body.phone);
  const password = String(req.body.password || "");
  if (!phone || !password) return res.status(400).json({ error: "لازم رقم التليفون وكلمة السر" });

  const lockedSeconds = getLockoutSeconds(req.ip);
  if (lockedSeconds > 0) {
    return res.status(429).json({ error: `محاولات دخول كتير غلط - جرب تاني بعد ${lockedSeconds} ثانية` });
  }

  try {
    const result = await pool.query(
      `SELECT phone, phone2, name, address_details, delivery_area_id, distinguishing_mark,
              loyalty_points, password_hash
       FROM customers WHERE phone = $1`,
      [phone]
    );
    const customer = result.rows[0];
    if (!customer || !customer.password_hash) {
      recordFailure(req.ip);
      return res.status(401).json({ error: "رقم التليفون أو كلمة السر غلط" });
    }
    const ok = await bcrypt.compare(password, customer.password_hash);
    if (!ok) {
      recordFailure(req.ip);
      return res.status(401).json({ error: "رقم التليفون أو كلمة السر غلط" });
    }
    recordSuccess(req.ip);

    const token = signCustomerToken(phone);
    res.json({ token, customer: toProfile(customer) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/customer-auth/me - بيانات الحساب الحالي + رصيد نقاط الولاء (فريش من قاعدة البيانات)
router.get("/me", requireCustomerAuth, (req, res) => {
  res.json({
    customer: {
      phone: req.customer.phone,
      phone2: req.customer.phone2,
      name: req.customer.name,
      addressDetails: req.customer.addressDetails,
      deliveryAreaId: req.customer.deliveryAreaId,
      distinguishingMark: req.customer.distinguishingMark,
      loyaltyPoints: req.customer.loyaltyPoints,
    },
  });
});

// GET /api/customer-auth/me/addresses - دفتر عناوين العميل المحفوظ (بيتراكم أوتوماتيك مع كل طلب
// دليفري - routes/orders.js) عشان يختار منه بضغطة بدل ما يدوّن العنوان تاني
router.get("/me/addresses", requireCustomerAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT ca.id, ca.label, ca.address_details, ca.delivery_area_id, da.name AS area_name,
              ca.distinguishing_mark, ca.is_default
       FROM customer_addresses ca
       LEFT JOIN delivery_areas da ON da.id = ca.delivery_area_id
       WHERE ca.customer_phone = $1
       ORDER BY ca.is_default DESC, ca.updated_at DESC`,
      [req.customer.phone]
    );
    res.json({
      addresses: result.rows.map((a) => ({
        id: a.id, label: a.label, addressDetails: a.address_details,
        deliveryAreaId: a.delivery_area_id, areaName: a.area_name,
        distinguishingMark: a.distinguishing_mark, isDefault: a.is_default,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
