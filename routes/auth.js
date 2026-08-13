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
      "SELECT * FROM users WHERE email = $1 AND is_active = TRUE",
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
    };
    const token = jwt.sign(payload, JWT_SECRET, { expiresIn: TOKEN_TTL });

    res.json({
      token,
      user: {
        id: user.id, name: user.name, email: user.email,
        role: user.role, branchId: user.branch_id,
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

module.exports = router;
