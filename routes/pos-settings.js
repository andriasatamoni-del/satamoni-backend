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

// PATCH /api/pos-settings - تعديل الحد المسموح للخصم من غير موافقة و/أو معدّل نقاط الولاء (أدمن بس)
router.patch("/", requireAuth, requireRole("admin"), async (req, res) => {
  const { maxUnapprovedDiscountPercent, discountManagerMaxPercent, loyaltyPointsPerEgp } = req.body;
  if (maxUnapprovedDiscountPercent === undefined && discountManagerMaxPercent === undefined && loyaltyPointsPerEgp === undefined) {
    return res.status(400).json({ error: "مفيش حاجة تتعدل" });
  }
  if (maxUnapprovedDiscountPercent !== undefined && (maxUnapprovedDiscountPercent < 0 || maxUnapprovedDiscountPercent > 1)) {
    return res.status(400).json({ error: "النسبة لازم تكون بين 0 و 1" });
  }
  if (discountManagerMaxPercent !== undefined && (discountManagerMaxPercent < 0 || discountManagerMaxPercent > 1)) {
    return res.status(400).json({ error: "النسبة لازم تكون بين 0 و 1" });
  }
  if (loyaltyPointsPerEgp !== undefined && loyaltyPointsPerEgp < 0) {
    return res.status(400).json({ error: "معدّل نقاط الولاء لازم يكون صفر أو أكبر" });
  }
  const fields = [];
  const values = [];
  let i = 1;
  if (maxUnapprovedDiscountPercent !== undefined) { fields.push(`max_unapproved_discount_percent = $${i++}`); values.push(maxUnapprovedDiscountPercent); }
  if (discountManagerMaxPercent !== undefined) { fields.push(`discount_manager_max_percent = $${i++}`); values.push(discountManagerMaxPercent); }
  if (loyaltyPointsPerEgp !== undefined) { fields.push(`loyalty_points_per_egp = $${i++}`); values.push(loyaltyPointsPerEgp); }
  try {
    const result = await pool.query(
      `UPDATE pos_settings SET ${fields.join(", ")} WHERE id = 1 RETURNING *`,
      values
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
