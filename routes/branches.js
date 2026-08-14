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
router.post("/", requireAuth, requireRole("admin"), async (req, res) => {
  const { name, address, phone, hours, lat, lng, isCentralKitchen = false } = req.body;
  if (!name) return res.status(400).json({ error: "لازم اسم الفرع" });
  try {
    const result = await pool.query(
      `INSERT INTO branches (name, address, phone, hours, lat, lng, is_central_kitchen)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [name, address, phone, hours, lat, lng, isCentralKitchen]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
