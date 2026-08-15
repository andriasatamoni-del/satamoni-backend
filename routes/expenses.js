const express = require("express");
const router = express.Router();
const pool = require("../db/pool");
const { requireAuth, requireRole, assertOwnBranch } = require("../middleware/auth");

const canManage = requireRole("admin", "accountant", "branch_manager");

// ---------------- بنود المصروفات (تكويد) ----------------

// GET /api/expenses/categories - كل البنود (نشطة وغير نشطة) - أي حد يقدر يسجل مصروف محتاج يشوفها في الفورم
router.get("/categories", requireAuth, canManage, async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM expense_categories ORDER BY name");
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/expenses/categories - إضافة بند جديد (أدمن بس - عشان محدش يضيف بنود عشوائية)
router.post("/categories", requireAuth, requireRole("admin"), async (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: "لازم اسم البند" });
  try {
    const result = await pool.query(
      "INSERT INTO expense_categories (name) VALUES ($1) RETURNING *",
      [name]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    if (err.code === "23505") return res.status(409).json({ error: "البند ده موجود بالفعل" });
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/expenses/categories/:id - تعطيل/تفعيل، تعديل اسم بند، أو حد التنبيه (أدمن بس)
// alertThreshold: لو مصروف من البند ده تجاوز المبلغ ده، يتعلّم "غريب" في تقرير المصروفات - ابعت null لإلغائه
router.patch("/categories/:id", requireAuth, requireRole("admin"), async (req, res) => {
  const { id } = req.params;
  const { name, isActive, alertThreshold } = req.body;
  const fields = [];
  const values = [];
  let i = 1;
  if (name !== undefined) { fields.push(`name = $${i++}`); values.push(name); }
  if (isActive !== undefined) { fields.push(`is_active = $${i++}`); values.push(isActive); }
  if (alertThreshold !== undefined) { fields.push(`alert_threshold = $${i++}`); values.push(alertThreshold); }
  if (fields.length === 0) return res.status(400).json({ error: "مفيش حاجة تتعدل" });

  values.push(id);
  try {
    const result = await pool.query(
      `UPDATE expense_categories SET ${fields.join(", ")} WHERE id = $${i} RETURNING *`,
      values
    );
    if (result.rows.length === 0) return res.status(404).json({ error: "البند مش موجود" });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/expenses?branchId=&date=
router.get("/", requireAuth, canManage, async (req, res) => {
  let { branchId, date } = req.query;
  if (req.user.role === "branch_manager") {
    if (branchId && !assertOwnBranch(req.user, branchId)) {
      return res.status(403).json({ error: "معندكش صلاحية تشوف مصروفات فرع تاني" });
    }
    branchId = req.user.branchId;
  }
  try {
    const result = await pool.query(
      `SELECT e.*, ec.name AS category
       FROM expenses e
       JOIN expense_categories ec ON ec.id = e.category_id
       WHERE ($1::int IS NULL OR e.branch_id = $1)
         AND ($2::date IS NULL OR e.business_date = $2)
       ORDER BY e.business_date DESC, e.id DESC`,
      [branchId || null, date || null]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/expenses - تسجيل مصروف يومي - لازم يختار بند من الليستة الثابتة (categoryId)، مش نص حر
router.post("/", requireAuth, canManage, async (req, res) => {
  const { branchId, businessDate, categoryId, amount, notes } = req.body;
  if (!branchId || !businessDate || !categoryId || !amount) {
    return res.status(400).json({ error: "بيانات ناقصة" });
  }
  if (req.user.role === "branch_manager" && !assertOwnBranch(req.user, branchId)) {
    return res.status(403).json({ error: "معندكش صلاحية تسجل مصروف على فرع تاني" });
  }
  try {
    const result = await pool.query(
      `INSERT INTO expenses (branch_id, business_date, category_id, amount, notes)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [branchId, businessDate, categoryId, amount, notes || null]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    if (err.code === "23503") return res.status(400).json({ error: "بند المصروف ده مش موجود" });
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
