const express = require("express");
const router = express.Router();
const pool = require("../db/pool");

// GET /api/branches - كل الفروع (الموقع بيستخدمها بدل site.branches المحلية)
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

// POST /api/branches - إضافة فرع جديد
router.post("/", async (req, res) => {
  const { name, address, phone, hours, lat, lng } = req.body;
  try {
    const result = await pool.query(
      `INSERT INTO branches (name, address, phone, hours, lat, lng)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [name, address, phone, hours, lat, lng]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
