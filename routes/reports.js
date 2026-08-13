const express = require("express");
const router = express.Router();
const pool = require("../db/pool");
const { requireAuth, requireRole } = require("../middleware/auth");

const canSeeReports = requireRole("admin", "accountant", "branch_manager");

// GET /api/reports/daily?year=2026&month=7 - بديل شيت "لوحة التحكم"
router.get("/daily", requireAuth, canSeeReports, async (req, res) => {
  const { year, month } = req.query;
  try {
    const result = await pool.query(
      `SELECT * FROM v_daily_branch_summary
       WHERE EXTRACT(YEAR FROM business_date) = $1
         AND EXTRACT(MONTH FROM business_date) = $2
         AND ($3::int IS NULL OR branch_id = $3)
       ORDER BY business_date, branch_id`,
      [year, month, req.user.role === "branch_manager" ? req.user.branchId : null]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/reports/branch-debt - مديونية كل فرع للمخزن الرئيسي لحظيًا
router.get("/branch-debt", requireAuth, canSeeReports, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT b.id AS branch_id, b.name,
              b.opening_debt_to_kitchen
              + COALESCE(SUM(sle.invoice_amount), 0)
              - COALESCE(SUM(sle.payment_amount), 0) AS current_debt
       FROM branches b
       LEFT JOIN supplier_ledger_entries sle ON sle.branch_id = b.id
       WHERE b.is_central_kitchen = FALSE
         AND ($1::int IS NULL OR b.id = $1)
       GROUP BY b.id, b.name, b.opening_debt_to_kitchen`,
      [req.user.role === "branch_manager" ? req.user.branchId : null]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/reports/menu-cost-analysis?targetFoodCostPercent=0.375
// تكلفة الريسبي الفعلية لكل صنف مقابل سعر بيعه، ونسبة تكلفة الطعام، وهامش الربح
// (بديل شيت "تحليل التكلفة والسعر")
router.get("/menu-cost-analysis", requireAuth, canSeeReports, async (req, res) => {
  const targetPercent = Number(req.query.targetFoodCostPercent) || 0.375;
  try {
    const result = await pool.query(`
      SELECT mc.name AS category, mi.name AS item_name, mv.id AS variant_id, mv.label,
             mv.price, mv.talabat_price,
             COALESCE(SUM(mvi.quantity_per_unit * ii.unit_cost), 0) AS recipe_cost,
             COUNT(mvi.id) AS ingredient_count,
             COUNT(mvi.id) FILTER (WHERE ii.unit_cost IS NULL) AS missing_cost_count
      FROM menu_item_variants mv
      JOIN menu_items mi ON mi.id = mv.item_id
      JOIN menu_categories mc ON mc.id = mi.category_id
      LEFT JOIN menu_item_variant_ingredients mvi ON mvi.variant_id = mv.id
      LEFT JOIN inventory_items ii ON ii.id = mvi.inventory_item_id
      WHERE mi.is_active = TRUE
      GROUP BY mc.name, mi.name, mv.id, mv.label, mv.price, mv.talabat_price
      ORDER BY mc.name, mi.name, mv.id
    `);

    const rows = result.rows.map((r) => {
      const price = Number(r.price);
      const recipeCost = Number(r.recipe_cost);
      const hasRecipe = Number(r.ingredient_count) > 0;
      const foodCostPct = price > 0 ? recipeCost / price : null;
      return {
        category: r.category,
        itemName: r.item_name,
        variantId: r.variant_id,
        label: r.label,
        price,
        talabatPrice: r.talabat_price !== null ? Number(r.talabat_price) : null,
        recipeCost,
        hasRecipe,
        missingCostCount: Number(r.missing_cost_count),
        foodCostPercent: foodCostPct,
        profit: hasRecipe ? price - recipeCost : null,
        marginPercent: hasRecipe && price > 0 ? (price - recipeCost) / price : null,
        fairPrice: hasRecipe ? recipeCost / targetPercent : null,
      };
    });
    res.json({ targetFoodCostPercent: targetPercent, items: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
