// المرحلة 8.17: بطاقات الصفحة الرئيسية (public/index.html) - المالك يقدر يغيّر اسم/وصف/ترتيب أي بطاقة
// من لوحة الأدمن بدل ما تكون ثابتة في كود الـHTML. GET عام (زي index.html نفسها - قبل تسجيل الدخول،
// مفيش بيانات حساسة هنا أصلًا غير أسماء الشاشات)، PATCH أدمن بس.
const express = require("express");
const router = express.Router();
const pool = require("../db/pool");
const { requireAuth, requireRole } = require("../middleware/auth");

// GET /api/home-tiles - كل البطاقات مرتبة بترتيب العرض (index.html بتستخدمها لرسم الصفحة الرئيسية)
router.get("/", async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM home_tiles ORDER BY display_order, id");
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/home-tiles/:id - تعديل اسم/وصف/ترتيب بطاقة (أدمن بس) - tile_key/href/icon ثابتين
// عمدًا (مرتبطين بالشاشة الفعلية نفسها، مش نص عرض قابل للتغيير من هنا)
router.patch("/:id", requireAuth, requireRole("admin"), async (req, res) => {
  const { title, description, displayOrder } = req.body;
  const fields = [];
  const values = [];
  let i = 1;
  if (title !== undefined) {
    if (!title.trim()) return res.status(400).json({ error: "لازم اسم للبطاقة" });
    fields.push(`title = $${i++}`); values.push(title.trim());
  }
  if (description !== undefined) { fields.push(`description = $${i++}`); values.push(description); }
  if (displayOrder !== undefined) {
    if (!Number.isInteger(Number(displayOrder))) return res.status(400).json({ error: "ترتيب العرض لازم يكون رقم صحيح" });
    fields.push(`display_order = $${i++}`); values.push(Number(displayOrder));
  }
  if (fields.length === 0) return res.status(400).json({ error: "مفيش حاجة تتعدل" });

  values.push(req.params.id);
  try {
    const result = await pool.query(
      `UPDATE home_tiles SET ${fields.join(", ")} WHERE id = $${i} RETURNING *`,
      values
    );
    if (result.rows.length === 0) return res.status(404).json({ error: "البطاقة مش موجودة" });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
