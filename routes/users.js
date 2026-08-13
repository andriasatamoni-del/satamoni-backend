const express = require("express");
const router = express.Router();
const bcrypt = require("bcryptjs");
const pool = require("../db/pool");
const { requireAuth, requireRole } = require("../middleware/auth");

router.use(requireAuth, requireRole("admin"));

// GET /api/users - كل المستخدمين (أدمن بس)
router.get("/", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT u.id, u.name, u.email, u.role, u.is_active, u.branch_id, b.name AS branch_name, u.created_at
      FROM users u
      LEFT JOIN branches b ON b.id = u.branch_id
      ORDER BY u.id
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/users - إنشاء موظف جديد
router.post("/", async (req, res) => {
  const { name, email, password, role, branchId } = req.body;
  const validRoles = ["admin", "branch_manager", "accountant", "cashier", "callcenter"];
  const branchFreeRoles = ["admin", "accountant", "callcenter"];
  if (!name || !email || !password || !validRoles.includes(role)) {
    return res.status(400).json({ error: "بيانات ناقصة أو الدور غير معروف" });
  }
  if (!branchFreeRoles.includes(role) && !branchId) {
    return res.status(400).json({ error: "لازم تحدد الفرع لدور المدير/الكاشير" });
  }
  try {
    const passwordHash = await bcrypt.hash(password, 10);
    const result = await pool.query(
      `INSERT INTO users (name, email, password_hash, role, branch_id)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, name, email, role, branch_id, is_active, created_at`,
      [name, email, passwordHash, role, branchId || null]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    if (err.code === "23505") {
      return res.status(409).json({ error: "البريد الإلكتروني ده مستخدم بالفعل" });
    }
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/users/:id - تعديل دور/فرع/تفعيل، أو تغيير كلمة المرور
router.patch("/:id", async (req, res) => {
  const { id } = req.params;
  const { role, branchId, isActive, password } = req.body;
  const fields = [];
  const values = [];
  let i = 1;

  if (role !== undefined) { fields.push(`role = $${i++}`); values.push(role); }
  if (branchId !== undefined) { fields.push(`branch_id = $${i++}`); values.push(branchId); }
  if (isActive !== undefined) { fields.push(`is_active = $${i++}`); values.push(isActive); }
  if (password) {
    const passwordHash = await bcrypt.hash(password, 10);
    fields.push(`password_hash = $${i++}`);
    values.push(passwordHash);
  }
  if (fields.length === 0) return res.status(400).json({ error: "مفيش حاجة تتعدل" });

  values.push(id);
  try {
    const result = await pool.query(
      `UPDATE users SET ${fields.join(", ")} WHERE id = $${i}
       RETURNING id, name, email, role, branch_id, is_active, created_at`,
      values
    );
    if (result.rows.length === 0) return res.status(404).json({ error: "المستخدم مش موجود" });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
