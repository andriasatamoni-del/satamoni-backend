const express = require("express");
const router = express.Router();
const pool = require("../db/pool");
const { requireAuth, requireRole } = require("../middleware/auth");

// GET /api/pos-settings - إعدادات نقطة البيع (أي موظف مسجل دخول يقدر يشوفها، عشان الكاشير
// يعرف الحد المسموح للخصم من غير موافقة)
router.get("/", requireAuth, async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM pos_settings WHERE id = 1");
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/pos-settings - تعديل الحد المسموح للخصم من غير موافقة (أدمن بس)
router.patch("/", requireAuth, requireRole("admin"), async (req, res) => {
  const { maxUnapprovedDiscountPercent } = req.body;
  if (maxUnapprovedDiscountPercent === undefined) {
    return res.status(400).json({ error: "مفيش حاجة تتعدل" });
  }
  if (maxUnapprovedDiscountPercent < 0 || maxUnapprovedDiscountPercent > 1) {
    return res.status(400).json({ error: "النسبة لازم تكون بين 0 و 1" });
  }
  try {
    const result = await pool.query(
      "UPDATE pos_settings SET max_unapproved_discount_percent = $1 WHERE id = 1 RETURNING *",
      [maxUnapprovedDiscountPercent]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
