const express = require("express");
const router = express.Router();
const pool = require("../db/pool");
const { requireAuth, requireRole, assertOwnBranch } = require("../middleware/auth");

const staffRoles = requireRole("admin", "branch_manager", "accountant", "cashier");
const stockManagers = requireRole("admin", "branch_manager");

// GET /api/inventory/items - كتالوج المكونات الخام
router.get("/items", requireAuth, staffRoles, async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM inventory_items ORDER BY name");
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/inventory/items - إضافة مكوّن جديد للكتالوج (أدمن بس)
router.post("/items", requireAuth, requireRole("admin"), async (req, res) => {
  const { name, unit } = req.body;
  if (!name || !unit) return res.status(400).json({ error: "لازم اسم ووحدة قياس" });
  try {
    const result = await pool.query(
      "INSERT INTO inventory_items (name, unit) VALUES ($1, $2) RETURNING *",
      [name, unit]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    if (err.code === "23505") return res.status(409).json({ error: "المكوّن ده موجود بالفعل" });
    res.status(500).json({ error: err.message });
  }
});

// GET /api/inventory/stock?branchId= - رصيد المخزون الحالي لفرع
router.get("/stock", requireAuth, staffRoles, async (req, res) => {
  let { branchId } = req.query;
  if (req.user.role === "branch_manager" || req.user.role === "cashier") {
    if (branchId && !assertOwnBranch(req.user, branchId)) {
      return res.status(403).json({ error: "معندكش صلاحية تشوف مخزون فرع تاني" });
    }
    branchId = req.user.branchId;
  }
  if (!branchId) return res.status(400).json({ error: "لازم تحدد branchId" });
  try {
    const result = await pool.query(
      `SELECT bis.inventory_item_id, ii.name, ii.unit, bis.quantity
       FROM branch_inventory_stock bis
       JOIN inventory_items ii ON ii.id = bis.inventory_item_id
       WHERE bis.branch_id = $1
       ORDER BY ii.name`,
      [branchId]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/inventory/stock/adjust - تسوية/توريد يدوي لرصيد فرع
// {branchId, inventoryItemId, quantity, movementType, notes}
// quantity موجب = زيادة (توريد/تحويل وارد)، سالب = نقصان (تحويل صادر/تسوية عجز)
router.post("/stock/adjust", requireAuth, stockManagers, async (req, res) => {
  const { branchId, inventoryItemId, quantity, movementType = "adjustment", notes } = req.body;
  const validTypes = ["purchase", "transfer_in", "transfer_out", "adjustment"];
  if (!branchId || !inventoryItemId || !quantity || !validTypes.includes(movementType)) {
    return res.status(400).json({ error: "بيانات ناقصة أو نوع الحركة غير معروف" });
  }
  if (!assertOwnBranch(req.user, branchId)) {
    return res.status(403).json({ error: "معندكش صلاحية تعدّل مخزون فرع تاني" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO branch_inventory_stock (branch_id, inventory_item_id, quantity)
       VALUES ($1, $2, $3)
       ON CONFLICT (branch_id, inventory_item_id)
       DO UPDATE SET quantity = branch_inventory_stock.quantity + $3`,
      [branchId, inventoryItemId, quantity]
    );
    await client.query(
      `INSERT INTO inventory_movements
        (branch_id, inventory_item_id, movement_type, quantity, business_date, notes, created_by)
       VALUES ($1, $2, $3, $4, CURRENT_DATE, $5, $6)`,
      [branchId, inventoryItemId, movementType, quantity, notes || null, req.user.id]
    );
    await client.query("COMMIT");
    res.status(201).json({ ok: true });
  } catch (err) {
    await client.query("ROLLBACK");
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// GET /api/inventory/recipe/:variantId - وصفة صنف (المكونات وكمياتها)
router.get("/recipe/:variantId", requireAuth, staffRoles, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT mvi.inventory_item_id, ii.name, ii.unit, mvi.quantity_per_unit
       FROM menu_item_variant_ingredients mvi
       JOIN inventory_items ii ON ii.id = mvi.inventory_item_id
       WHERE mvi.variant_id = $1
       ORDER BY ii.name`,
      [req.params.variantId]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/inventory/recipe/:variantId - استبدال وصفة صنف بالكامل (أدمن بس)
// body: { ingredients: [{ inventoryItemId, quantityPerUnit }] }
router.put("/recipe/:variantId", requireAuth, requireRole("admin"), async (req, res) => {
  const { variantId } = req.params;
  const { ingredients } = req.body;
  if (!Array.isArray(ingredients)) return res.status(400).json({ error: "لازم قايمة مكونات" });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM menu_item_variant_ingredients WHERE variant_id = $1", [variantId]);
    for (const ing of ingredients) {
      await client.query(
        `INSERT INTO menu_item_variant_ingredients (variant_id, inventory_item_id, quantity_per_unit)
         VALUES ($1, $2, $3)`,
        [variantId, ing.inventoryItemId, ing.quantityPerUnit]
      );
    }
    await client.query("COMMIT");
    res.json({ ok: true });
  } catch (err) {
    await client.query("ROLLBACK");
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

module.exports = router;
