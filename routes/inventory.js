const express = require("express");
const router = express.Router();
const pool = require("../db/pool");
const { requireAuth, requireRole, assertOwnBranch } = require("../middleware/auth");
const { logAudit } = require("../db/audit");

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

// POST /api/inventory/items - إضافة مكوّن جديد للكتالوج (أدمن أو مدير السنتر كيتشن)
// itemType: 'raw' (بيتشترى من مورد) أو 'manufactured' (بيتعمل في السنتر كيتشن من مكونات تانية)
router.post("/items", requireAuth, stockManagers, async (req, res) => {
  if (req.user.role !== "admin" && !req.user.isCentralKitchen) {
    return res.status(403).json({ error: "إضافة مكونات جديدة للكتالوج للأدمن أو مدير السنتر كيتشن بس" });
  }
  const { name, unit, itemType = "raw" } = req.body;
  if (!name || !unit) return res.status(400).json({ error: "لازم اسم ووحدة قياس" });
  if (!["raw", "manufactured"].includes(itemType)) {
    return res.status(400).json({ error: "نوع الصنف غير معروف" });
  }
  try {
    const result = await pool.query(
      "INSERT INTO inventory_items (name, unit, item_type) VALUES ($1, $2, $3) RETURNING *",
      [name, unit, itemType]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    if (err.code === "23505") return res.status(409).json({ error: "المكوّن ده موجود بالفعل" });
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/inventory/items/:id - تصحيح اسم/وحدة/تكلفة/نوع مكوّن (أدمن أو مدير السنتر كيتشن)
router.patch("/items/:id", requireAuth, stockManagers, async (req, res) => {
  if (req.user.role !== "admin" && !req.user.isCentralKitchen) {
    return res.status(403).json({ error: "تعديل الكتالوج للأدمن أو مدير السنتر كيتشن بس" });
  }
  const { name, unit, unitCost, itemType } = req.body;
  const fields = [];
  const values = [];
  let i = 1;
  if (name !== undefined) { fields.push(`name = $${i++}`); values.push(name); }
  if (unit !== undefined) { fields.push(`unit = $${i++}`); values.push(unit); }
  if (unitCost !== undefined) { fields.push(`unit_cost = $${i++}`); values.push(unitCost); }
  if (itemType !== undefined) {
    if (!["raw", "manufactured"].includes(itemType)) return res.status(400).json({ error: "نوع الصنف غير معروف" });
    fields.push(`item_type = $${i++}`); values.push(itemType);
  }
  if (fields.length === 0) return res.status(400).json({ error: "مفيش حاجة تتعدل" });

  values.push(req.params.id);
  try {
    const result = await pool.query(
      `UPDATE inventory_items SET ${fields.join(", ")} WHERE id = $${i} RETURNING *`,
      values
    );
    if (result.rows.length === 0) return res.status(404).json({ error: "المكوّن مش موجود" });
    res.json(result.rows[0]);
  } catch (err) {
    if (err.code === "23505") return res.status(409).json({ error: "الاسم ده مستخدم بالفعل" });
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
    await logAudit(client, {
      branchId, userId: req.user.id, action: "INVENTORY_ADJUSTMENT", entityType: "inventory_item", entityId: inventoryItemId,
      newValues: { quantity, movementType }, metadata: { notes }, req,
    });
    await client.query("COMMIT");
    res.status(201).json({ ok: true });
  } catch (err) {
    await client.query("ROLLBACK");
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// POST /api/inventory/reconcile - جرد فعلي: تدخل الكمية الحقيقية اللي عددتها، والسيستم
// بيحسب الفرق عن رصيده الحالي ويسجله تلقائي (بدل ما تحسب الفرق بنفسك)
// {branchId, inventoryItemId, actualQuantity, notes}
router.post("/reconcile", requireAuth, stockManagers, async (req, res) => {
  const { branchId, inventoryItemId, actualQuantity, notes } = req.body;
  if (!branchId || !inventoryItemId || actualQuantity === undefined) {
    return res.status(400).json({ error: "بيانات ناقصة" });
  }
  if (!assertOwnBranch(req.user, branchId)) {
    return res.status(403).json({ error: "معندكش صلاحية تعدّل مخزون فرع تاني" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const current = await client.query(
      "SELECT quantity FROM branch_inventory_stock WHERE branch_id = $1 AND inventory_item_id = $2",
      [branchId, inventoryItemId]
    );
    const previousQuantity = current.rows.length > 0 ? Number(current.rows[0].quantity) : 0;
    const variance = Number(actualQuantity) - previousQuantity;

    if (variance !== 0) {
      await client.query(
        `INSERT INTO branch_inventory_stock (branch_id, inventory_item_id, quantity)
         VALUES ($1, $2, $3)
         ON CONFLICT (branch_id, inventory_item_id) DO UPDATE SET quantity = $3`,
        [branchId, inventoryItemId, actualQuantity]
      );
      const reconcileNote = `جرد: كان ${previousQuantity}، الفعلي ${actualQuantity}` + (notes ? ` - ${notes}` : "");
      await client.query(
        `INSERT INTO inventory_movements
          (branch_id, inventory_item_id, movement_type, quantity, business_date, notes, created_by)
         VALUES ($1, $2, 'adjustment', $3, CURRENT_DATE, $4, $5)`,
        [branchId, inventoryItemId, variance, reconcileNote, req.user.id]
      );
      await logAudit(client, {
        branchId, userId: req.user.id, action: "INVENTORY_COUNT", entityType: "inventory_item", entityId: inventoryItemId,
        oldValues: { quantity: previousQuantity }, newValues: { quantity: Number(actualQuantity) },
        metadata: { variance, notes }, req,
      });
    }
    await client.query("COMMIT");
    res.status(201).json({ previousQuantity, actualQuantity: Number(actualQuantity), variance });
  } catch (err) {
    await client.query("ROLLBACK");
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// POST /api/inventory/waste - تسجيل هالك (تلف/انتهاء صلاحية/كسر) - بيخصم من المخزون فورًا زي البيع
// بالظبط، بس بحركة مخزون منفصلة (movement_type='waste') عشان تقارير الهالك تفرّقه عن خصم المبيعات
// {branchId, inventoryItemId, quantity, reason, businessDate?}
router.post("/waste", requireAuth, stockManagers, async (req, res) => {
  const { branchId, inventoryItemId, quantity, reason, businessDate } = req.body;
  if (!branchId || !inventoryItemId || !quantity || quantity <= 0) {
    return res.status(400).json({ error: "بيانات ناقصة أو الكمية لازم تكون أكبر من صفر" });
  }
  if (!assertOwnBranch(req.user, branchId)) {
    return res.status(403).json({ error: "معندكش صلاحية تسجل هالك على فرع تاني" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO branch_inventory_stock (branch_id, inventory_item_id, quantity)
       VALUES ($1, $2, -$3::numeric)
       ON CONFLICT (branch_id, inventory_item_id) DO UPDATE SET quantity = branch_inventory_stock.quantity - $3::numeric`,
      [branchId, inventoryItemId, quantity]
    );
    const result = await client.query(
      `INSERT INTO inventory_movements
        (branch_id, inventory_item_id, movement_type, quantity, business_date, notes, created_by)
       VALUES ($1, $2, 'waste', -$3::numeric, COALESCE($4, CURRENT_DATE), $5, $6)
       RETURNING *`,
      [branchId, inventoryItemId, quantity, businessDate || null, reason || null, req.user.id]
    );
    await client.query("COMMIT");
    res.status(201).json(result.rows[0]);
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
    const before = await client.query(
      `SELECT inventory_item_id, quantity_per_unit FROM menu_item_variant_ingredients WHERE variant_id = $1`,
      [variantId]
    );
    await client.query("DELETE FROM menu_item_variant_ingredients WHERE variant_id = $1", [variantId]);
    for (const ing of ingredients) {
      await client.query(
        `INSERT INTO menu_item_variant_ingredients (variant_id, inventory_item_id, quantity_per_unit)
         VALUES ($1, $2, $3)`,
        [variantId, ing.inventoryItemId, ing.quantityPerUnit]
      );
    }
    await logAudit(client, {
      userId: req.user.id, action: "RECIPE_CHANGE", entityType: "menu_variant", entityId: Number(variantId),
      oldValues: { ingredients: before.rows }, newValues: { ingredients }, req,
    });
    await client.query("COMMIT");
    res.json({ ok: true });
  } catch (err) {
    await client.query("ROLLBACK");
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ---------------- التصنيع (خام -> مصنّع) ----------------

// GET /api/inventory/manufacturing-recipe/:itemId - وصفة تصنيع صنف مصنّع
router.get("/manufacturing-recipe/:itemId", requireAuth, staffRoles, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT mri.input_item_id, ii.name, ii.unit, mri.quantity_per_unit
       FROM manufacturing_recipe_items mri
       JOIN inventory_items ii ON ii.id = mri.input_item_id
       WHERE mri.output_item_id = $1
       ORDER BY ii.name`,
      [req.params.itemId]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/inventory/manufacturing-recipe/:itemId - استبدال وصفة تصنيع بالكامل (أدمن أو مدير السنتر كيتشن)
// body: { ingredients: [{ inputItemId, quantityPerUnit }] }
router.put("/manufacturing-recipe/:itemId", requireAuth, stockManagers, async (req, res) => {
  if (req.user.role !== "admin" && !req.user.isCentralKitchen) {
    return res.status(403).json({ error: "وصفات التصنيع بيعدّلها الأدمن أو مدير السنتر كيتشن بس" });
  }
  const { itemId } = req.params;
  const { ingredients } = req.body;
  if (!Array.isArray(ingredients)) return res.status(400).json({ error: "لازم قايمة مكونات" });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const before = await client.query(
      `SELECT input_item_id, quantity_per_unit FROM manufacturing_recipe_items WHERE output_item_id = $1`,
      [itemId]
    );
    await client.query("DELETE FROM manufacturing_recipe_items WHERE output_item_id = $1", [itemId]);
    for (const ing of ingredients) {
      await client.query(
        `INSERT INTO manufacturing_recipe_items (output_item_id, input_item_id, quantity_per_unit)
         VALUES ($1, $2, $3)`,
        [itemId, ing.inputItemId, ing.quantityPerUnit]
      );
    }
    await logAudit(client, {
      userId: req.user.id, action: "RECIPE_CHANGE", entityType: "inventory_item", entityId: Number(itemId),
      oldValues: { ingredients: before.rows }, newValues: { ingredients }, req,
    });
    await client.query("COMMIT");
    res.json({ ok: true });
  } catch (err) {
    await client.query("ROLLBACK");
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// POST /api/inventory/produce - تسجيل عملية تصنيع فعلية (بيستهلك المكونات الخام وينتج الصنف المصنّع)
// {branchId (لازم يكون فرع is_central_kitchen), outputItemId, quantityProduced, notes}
router.post("/produce", requireAuth, stockManagers, async (req, res) => {
  const { branchId, outputItemId, quantityProduced, notes } = req.body;
  if (!branchId || !outputItemId || !quantityProduced || quantityProduced <= 0) {
    return res.status(400).json({ error: "بيانات ناقصة" });
  }
  if (!assertOwnBranch(req.user, branchId)) {
    return res.status(403).json({ error: "معندكش صلاحية تسجل تصنيع لفرع تاني" });
  }

  const client = await pool.connect();
  try {
    const branchCheck = await client.query("SELECT is_central_kitchen FROM branches WHERE id = $1", [branchId]);
    if (branchCheck.rows.length === 0 || !branchCheck.rows[0].is_central_kitchen) {
      return res.status(400).json({ error: "التصنيع بيتسجل بس على فرع السنتر كيتشن" });
    }

    const recipe = await client.query(
      "SELECT input_item_id, quantity_per_unit FROM manufacturing_recipe_items WHERE output_item_id = $1",
      [outputItemId]
    );
    if (recipe.rows.length === 0) {
      return res.status(400).json({ error: "الصنف ده مفيش له وصفة تصنيع محددة لسه" });
    }

    await client.query("BEGIN");

    for (const ing of recipe.rows) {
      await client.query(
        `INSERT INTO branch_inventory_stock (branch_id, inventory_item_id, quantity)
         VALUES ($1, $2, -($3::numeric * $4::numeric))
         ON CONFLICT (branch_id, inventory_item_id)
         DO UPDATE SET quantity = branch_inventory_stock.quantity - ($3::numeric * $4::numeric)`,
        [branchId, ing.input_item_id, ing.quantity_per_unit, quantityProduced]
      );
      await client.query(
        `INSERT INTO inventory_movements
          (branch_id, inventory_item_id, movement_type, quantity, business_date, notes)
         VALUES ($1, $2, 'production_out', -($3::numeric * $4::numeric), CURRENT_DATE, $5)`,
        [branchId, ing.input_item_id, ing.quantity_per_unit, quantityProduced, notes || null]
      );
    }

    await client.query(
      `INSERT INTO branch_inventory_stock (branch_id, inventory_item_id, quantity)
       VALUES ($1, $2, $3)
       ON CONFLICT (branch_id, inventory_item_id)
       DO UPDATE SET quantity = branch_inventory_stock.quantity + $3`,
      [branchId, outputItemId, quantityProduced]
    );
    await client.query(
      `INSERT INTO inventory_movements
        (branch_id, inventory_item_id, movement_type, quantity, business_date, notes)
       VALUES ($1, $2, 'production_in', $3, CURRENT_DATE, $4)`,
      [branchId, outputItemId, quantityProduced, notes || null]
    );

    await client.query("COMMIT");
    res.status(201).json({ ok: true, consumedIngredients: recipe.rows.length });
  } catch (err) {
    await client.query("ROLLBACK");
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

module.exports = router;
