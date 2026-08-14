const express = require("express");
const router = express.Router();
const pool = require("../db/pool");
const { requireAuth, requireRole } = require("../middleware/auth");

// GET /api/branches - الفروع القابلة للبيع بس (الموقع/الكاشير بيستخدموها) - مش شاملة السنتر كيتشن
router.get("/", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM branches WHERE is_central_kitchen = FALSE ORDER BY id"
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/branches/all - كل الفروع شاملة السنتر كيتشن (أدمن بس - لشاشات الإدارة)
router.get("/all", requireAuth, requireRole("admin"), async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM branches ORDER BY is_central_kitchen, id");
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/branches - إضافة فرع جديد أو السنتر كيتشن (أدمن بس)
// supportsDineIn: هل يظهر خيار "صالة" في شاشة البيع لهذا الفرع (افتراضيًا لأ، عدا الإبراهيمية)
router.post("/", requireAuth, requireRole("admin"), async (req, res) => {
  const { name, address, phone, hours, lat, lng, isCentralKitchen = false, supportsDineIn = false } = req.body;
  if (!name) return res.status(400).json({ error: "لازم اسم الفرع" });
  try {
    const result = await pool.query(
      `INSERT INTO branches (name, address, phone, hours, lat, lng, is_central_kitchen, supports_dine_in)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [name, address, phone, hours, lat, lng, isCentralKitchen, supportsDineIn]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/branches/:id - تعديل بيانات فرع، بما فيها تفعيل/تعطيل الصالة (أدمن بس)
router.patch("/:id", requireAuth, requireRole("admin"), async (req, res) => {
  const { id } = req.params;
  const { name, address, phone, hours, lat, lng, supportsDineIn } = req.body;
  const fields = [];
  const values = [];
  let i = 1;
  if (name !== undefined) { fields.push(`name = $${i++}`); values.push(name); }
  if (address !== undefined) { fields.push(`address = $${i++}`); values.push(address); }
  if (phone !== undefined) { fields.push(`phone = $${i++}`); values.push(phone); }
  if (hours !== undefined) { fields.push(`hours = $${i++}`); values.push(hours); }
  if (lat !== undefined) { fields.push(`lat = $${i++}`); values.push(lat); }
  if (lng !== undefined) { fields.push(`lng = $${i++}`); values.push(lng); }
  if (supportsDineIn !== undefined) { fields.push(`supports_dine_in = $${i++}`); values.push(supportsDineIn); }
  if (fields.length === 0) return res.status(400).json({ error: "مفيش حاجة تتعدل" });

  values.push(id);
  try {
    const result = await pool.query(
      `UPDATE branches SET ${fields.join(", ")} WHERE id = $${i} RETURNING *`,
      values
    );
    if (result.rows.length === 0) return res.status(404).json({ error: "الفرع مش موجود" });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
