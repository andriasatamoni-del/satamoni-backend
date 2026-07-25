const express = require("express");
const router = express.Router();
const pool = require("../db/pool");

// GET /api/menu - المنيو كامل مع الأصناف والأسعار (شكل جاهز للموقع)
router.get("/", async (req, res) => {
  try {
    const items = await pool.query(`
      SELECT mi.id, mi.name, mi.description, mi.image_url, mi.is_best,
             mc.name AS category,
             json_agg(json_build_object('id', v.id, 'label', v.label, 'price', v.price)) AS variants
      FROM menu_items mi
      JOIN menu_categories mc ON mc.id = mi.category_id
      JOIN menu_item_variants v ON v.item_id = mi.id
      WHERE mi.is_active = TRUE
      GROUP BY mi.id, mc.name
      ORDER BY mc.name, mi.id
    `);
    res.json(items.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
