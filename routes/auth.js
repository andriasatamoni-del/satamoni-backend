const express = require("express");
const router = express.Router();
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const pool = require("../db/pool");
const { requireAuth } = require("../middleware/auth");

const JWT_SECRET = process.env.JWT_SECRET;
const TOKEN_TTL = "12h";

// POST /api/auth/login - {email, password} -> {token, user}
router.post("/login", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: "لازم تبعت email و password" });
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
    if (!user) return res.status(401).json({ error: "بيانات الدخول غلط" });

    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: "بيانات الدخول غلط" });

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

// GET /api/auth/me - بيانات المستخدم المسجل دخوله حاليًا
router.get("/me", requireAuth, (req, res) => {
  res.json(req.user);
});

// POST /api/auth/verify-override-pin - {pin, branchId?} -> {approverId, approverName}
// موافقة مدير الفرع/الأدمن بـ PIN من غير ما يسجل خروج ودخول تاني على جهاز الكاشير - مستخدمة
// للخصومات اللي فوق الحد المسموح واسترجاع الطلبات المكتملة (Void). أي موظف مسجل دخول يقدر يطلبها،
// بس بترجع موافقة صحيحة بس لو الـ PIN فعلاً بتاع مدير فرع (نفس الفرع) أو أدمن.
router.post("/verify-override-pin", requireAuth, async (req, res) => {
  const { pin, branchId } = req.body;
  if (!pin) return res.status(400).json({ error: "لازم تدخل PIN" });
  try {
    const candidates = await pool.query(
      `SELECT id, name, pin_hash FROM users
       WHERE is_active = TRUE AND pin_hash IS NOT NULL
         AND (role = 'admin' OR (role = 'branch_manager' AND branch_id = $1))`,
      [branchId || null]
    );
    for (const candidate of candidates.rows) {
      if (await bcrypt.compare(pin, candidate.pin_hash)) {
        return res.json({ approverId: candidate.id, approverName: candidate.name });
      }
    }
    res.status(401).json({ error: "PIN غير صحيح" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
