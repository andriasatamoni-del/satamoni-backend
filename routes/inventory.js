const express = require("express");
const router = express.Router();
const pool = require("../db/pool");
const { requireAuth, requireRole, assertOwnBranch } = require("../middleware/auth");
const { logAudit } = require("../db/audit");
const { postInventoryMovement } = require("../db/inventory-ledger");

const WASTE_REASONS = ["EXPIRED", "DAMAGED", "BURNED", "PREPARATION_WASTE", "OVERPRODUCTION", "QUALITY_ISSUE", "CUSTOMER_RETURN", "UNKNOWN"];

// تحويل كمية من وحدة لوحدة تانية باستخدام unit_conversions - لو الوحدتين زي بعض بيرجع نفس الكمية
// من غير أي بحث. بيرمي error واضح لو مفيش تحويل مسجّل بين الوحدتين.
async function convertQuantity(client, quantity, fromUnit, toUnit) {
  if (!fromUnit || !toUnit || fromUnit === toUnit) return Number(quantity);
  const direct = await client.query(
    "SELECT factor FROM unit_conversions WHERE from_unit = $1 AND to_unit = $2", [fromUnit, toUnit]
  );
  if (direct.rows.length > 0) return Number(quantity) * Number(direct.rows[0].factor);
  const inverse = await client.query(
    "SELECT factor FROM unit_conversions WHERE from_unit = $1 AND to_unit = $2", [toUnit, fromUnit]
  );
  if (inverse.rows.length > 0) return Number(quantity) / Number(inverse.rows[0].factor);
  const err = new Error(`مفيش تحويل مسجّل بين وحدة "${fromUnit}" ووحدة "${toUnit}"`);
  err.code = "NO_UNIT_CONVERSION";
  throw err;
}

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
  const { name, unit, unitCost, itemType, allowNegativeStock, negativeStockPolicy } = req.body;
  const fields = [];
  const values = [];
  let i = 1;
  if (name !== undefined) { fields.push(`name = $${i++}`); values.push(name); }
  if (unit !== undefined) { fields.push(`unit = $${i++}`); values.push(unit); }
  if (unitCost !== undefined) { fields.push(`unit_cost = $${i++}`); values.push(unitCost); }
  if (allowNegativeStock !== undefined) { fields.push(`allow_negative_stock = $${i++}`); values.push(!!allowNegativeStock); }
  if (negativeStockPolicy !== undefined) {
    if (!["STRICT", "ALLOW_WITH_APPROVAL"].includes(negativeStockPolicy)) {
      return res.status(400).json({ error: "سياسة الرصيد السالب غير معروفة" });
    }
    fields.push(`negative_stock_policy = $${i++}`); values.push(negativeStockPolicy);
  }
  if (itemType !== undefined) {
    if (!["raw", "manufactured"].includes(itemType)) return res.status(400).json({ error: "نوع الصنف غير معروف" });
    fields.push(`item_type = $${i++}`); values.push(itemType);
  }
  if (fields.length === 0) return res.status(400).json({ error: "مفيش حاجة تتعدل" });

  values.push(req.params.id);
  try {
    const before = await pool.query("SELECT unit_cost, negative_stock_policy FROM inventory_items WHERE id = $1", [req.params.id]);
    const result = await pool.query(
      `UPDATE inventory_items SET ${fields.join(", ")} WHERE id = $${i} RETURNING *`,
      values
    );
    if (result.rows.length === 0) return res.status(404).json({ error: "المكوّن مش موجود" });
    if (unitCost !== undefined && before.rows[0] && Number(before.rows[0].unit_cost) !== Number(unitCost)) {
      await logAudit(pool, {
        userId: req.user.id, action: "COST_CHANGE", entityType: "inventory_item", entityId: Number(req.params.id),
        oldValues: { unitCost: before.rows[0].unit_cost }, newValues: { unitCost }, req,
      });
    }
    if (negativeStockPolicy !== undefined && before.rows[0] && before.rows[0].negative_stock_policy !== negativeStockPolicy) {
      await logAudit(pool, {
        userId: req.user.id, action: "NEGATIVE_STOCK_POLICY_CHANGE", entityType: "inventory_item", entityId: Number(req.params.id),
        oldValues: { negativeStockPolicy: before.rows[0].negative_stock_policy }, newValues: { negativeStockPolicy }, req,
      });
    }
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

// POST /api/inventory/stock/adjust - تسوية/توريد يدوي لرصيد فرع (بيعدّي على الليدجر - مفيش تعديل مباشر
// على الرصيد أبدًا). {branchId, inventoryItemId, quantity, movementType, notes, idempotencyKey?}
// quantity موجب = زيادة (توريد/تحويل وارد)، سالب = نقصان (تحويل صادر/تسوية عجز)
const LEGACY_MOVEMENT_TYPE_MAP = { purchase: "PURCHASE_RECEIPT", transfer_in: "TRANSFER_IN", transfer_out: "TRANSFER_OUT", adjustment: "ADJUSTMENT" };
router.post("/stock/adjust", requireAuth, stockManagers, async (req, res) => {
  const { branchId, inventoryItemId, quantity, movementType = "adjustment", notes, idempotencyKey } = req.body;
  const validTypes = Object.keys(LEGACY_MOVEMENT_TYPE_MAP);
  if (!branchId || !inventoryItemId || !quantity || !validTypes.includes(movementType)) {
    return res.status(400).json({ error: "بيانات ناقصة أو نوع الحركة غير معروف" });
  }
  if (!assertOwnBranch(req.user, branchId)) {
    return res.status(403).json({ error: "معندكش صلاحية تعدّل مخزون فرع تاني" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { movement, duplicate } = await postInventoryMovement(client, {
      branchId, inventoryItemId, quantity, movementType: LEGACY_MOVEMENT_TYPE_MAP[movementType],
      notes, userId: req.user.id, idempotencyKey, negativeStockOverrideApproved: true,
    });
    if (!duplicate) {
      await logAudit(client, {
        branchId, userId: req.user.id, action: "INVENTORY_ADJUSTMENT", entityType: "inventory_item", entityId: inventoryItemId,
        newValues: { quantity, movementType: movement.movement_type }, metadata: { notes }, req,
      });
    }
    await client.query("COMMIT");
    res.status(201).json({ ok: true, movement, duplicate });
  } catch (err) {
    await client.query("ROLLBACK");
    if (err.code === "INSUFFICIENT_STOCK") return res.status(400).json({ error: err.message });
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
      const reconcileNote = `جرد: كان ${previousQuantity}، الفعلي ${actualQuantity}` + (notes ? ` - ${notes}` : "");
      await postInventoryMovement(client, {
        branchId, inventoryItemId, quantity: variance, movementType: "STOCK_COUNT",
        notes: reconcileNote, userId: req.user.id, negativeStockOverrideApproved: true,
      });
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
    if (err.code === "INSUFFICIENT_STOCK") return res.status(400).json({ error: err.message });
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// POST /api/inventory/waste - تسجيل هالك (تلف/انتهاء صلاحية/كسر) - بيخصم من المخزون فورًا زي البيع
// بالظبط، بس بحركة مخزون منفصلة (movement_type='WASTE') عشان تقارير الهالك تفرّقه عن خصم المبيعات.
// reason: نص حر زي الأول (بيتسجل في notes). wasteReason (اختياري): سبب مقنّن من قايمة ثابتة
// (EXPIRED/DAMAGED/BURNED/PREPARATION_WASTE/OVERPRODUCTION/QUALITY_ISSUE/CUSTOMER_RETURN/UNKNOWN)
// {branchId, inventoryItemId, quantity, reason, wasteReason?, businessDate?, idempotencyKey?}
router.post("/waste", requireAuth, stockManagers, async (req, res) => {
  const { branchId, inventoryItemId, quantity, reason, wasteReason, businessDate, idempotencyKey } = req.body;
  if (!branchId || !inventoryItemId || !quantity || quantity <= 0) {
    return res.status(400).json({ error: "بيانات ناقصة أو الكمية لازم تكون أكبر من صفر" });
  }
  if (wasteReason !== undefined && wasteReason !== null && !WASTE_REASONS.includes(wasteReason)) {
    return res.status(400).json({ error: "سبب الهالك غير معروف" });
  }
  if (!assertOwnBranch(req.user, branchId)) {
    return res.status(403).json({ error: "معندكش صلاحية تسجل هالك على فرع تاني" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { movement, duplicate } = await postInventoryMovement(client, {
      branchId, inventoryItemId, quantity: -Math.abs(Number(quantity)), movementType: "WASTE",
      reason: wasteReason || "UNKNOWN", notes: reason || null, businessDate: businessDate || null,
      userId: req.user.id, idempotencyKey, negativeStockOverrideApproved: true,
    });
    if (!duplicate) {
      await logAudit(client, {
        branchId, userId: req.user.id, action: "WASTE_RECORDED", entityType: "inventory_item", entityId: inventoryItemId,
        newValues: { quantity, wasteReason: wasteReason || "UNKNOWN" }, metadata: { reason }, req,
      });
    }
    await client.query("COMMIT");
    res.status(201).json(movement);
  } catch (err) {
    await client.query("ROLLBACK");
    if (err.code === "INSUFFICIENT_STOCK") return res.status(400).json({ error: err.message });
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
// {branchId (لازم يكون فرع is_central_kitchen), outputItemId, quantityProduced, notes, idempotencyKey?}
router.post("/produce", requireAuth, stockManagers, async (req, res) => {
  const { branchId, outputItemId, quantityProduced, notes, idempotencyKey } = req.body;
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

    // مفتاح idempotency واحد كافي هنا: حركة الإنتاج (PRODUCTION_IN) هي آخر خطوة في العملية، فلو موجودة
    // بالفعل يبقى الطلب ده كامل اتنفذ قبل كده (retry شبكة مكرر) - نرجّع نفس النتيجة من غير ما نكرر الاستهلاك
    if (idempotencyKey) {
      const existing = await client.query(
        "SELECT * FROM inventory_movements WHERE idempotency_key = $1", [`${idempotencyKey}:in`]
      );
      if (existing.rows.length > 0) {
        await client.query("ROLLBACK");
        return res.status(201).json({ ok: true, duplicate: true, outputMovement: existing.rows[0] });
      }
    }

    for (const ing of recipe.rows) {
      await postInventoryMovement(client, {
        branchId, inventoryItemId: ing.input_item_id,
        quantity: -(Number(ing.quantity_per_unit) * Number(quantityProduced)),
        movementType: "PRODUCTION_OUT", referenceType: "production", notes: notes || null,
        userId: req.user.id, negativeStockOverrideApproved: true,
      });
    }

    const { movement: outputMovement } = await postInventoryMovement(client, {
      branchId, inventoryItemId: outputItemId, quantity: Number(quantityProduced),
      movementType: "PRODUCTION_IN", referenceType: "production", notes: notes || null,
      userId: req.user.id, idempotencyKey: idempotencyKey ? `${idempotencyKey}:in` : null,
    });

    await client.query("COMMIT");
    res.status(201).json({ ok: true, consumedIngredients: recipe.rows.length, outputMovement });
  } catch (err) {
    await client.query("ROLLBACK");
    if (err.code === "INSUFFICIENT_STOCK") return res.status(400).json({ error: err.message });
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ---------------- استلام مشتريات (Purchase Receipt) وتتبّع الدفعات ----------------

// POST /api/inventory/purchase-receipt - تسجيل استلام كمية فعلية من مورد لمخزون فرع (منفصل عن السجل
// المالي في routes/purchases.js اللي لسه شغال زي ما هو للمصروفات الإجمالية) - ده بيأثر على الرصيد
// فعليًا وبيقدر ينشئ دفعة (Batch) لو اتبعت تفاصيل صلاحية/رقم دفعة، عشان الصرف بعدين يبقى FEFO/FIFO
// {branchId, inventoryItemId, quantity, unit? (لو مختلف عن وحدة تتبّع الصنف، هيتحول تلقائيًا),
//  unitCost, supplierId?, batchNumber?, receivedDate?, productionDate?, expiryDate?, notes?, idempotencyKey?}
router.post("/purchase-receipt", requireAuth, stockManagers, async (req, res) => {
  const {
    branchId, inventoryItemId, quantity, unit, unitCost, supplierId,
    batchNumber, receivedDate, productionDate, expiryDate, notes, idempotencyKey,
  } = req.body;
  if (!branchId || !inventoryItemId || !quantity || quantity <= 0) {
    return res.status(400).json({ error: "بيانات ناقصة أو الكمية لازم تكون أكبر من صفر" });
  }
  if (!assertOwnBranch(req.user, branchId)) {
    return res.status(403).json({ error: "معندكش صلاحية تسجل استلام على فرع تاني" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const itemRes = await client.query("SELECT unit FROM inventory_items WHERE id = $1", [inventoryItemId]);
    if (itemRes.rows.length === 0) throw new Error("الصنف مش موجود");
    const stockUnit = itemRes.rows[0].unit;
    const convertedQuantity = await convertQuantity(client, quantity, unit || stockUnit, stockUnit);
    // unitCost المُدخل هو تكلفة وحدة الاستلام (unit) اللي ممكن تختلف عن وحدة تتبّع الرصيد (stockUnit) -
    // لازم نحوّله لتكلفة "وحدة الرصيد" قبل ما نسجله، وإلا التكلفة الإجمالية (total_cost) هتبقى غلط
    // بمقدار نسبة التحويل بالظبط (مثال: 450ج للكرتونة اللي = 5 كيلو لازم يبقى 90ج/كيلو مش 450ج/كيلو)
    const conversionFactor = Number(quantity) > 0 ? convertedQuantity / Number(quantity) : 1;
    const unitCostInStockUnit = unitCost != null ? Number(unitCost) / conversionFactor : null;

    let batchId = null;
    if (batchNumber || expiryDate) {
      const batch = await client.query(
        `INSERT INTO inventory_batches
          (batch_number, inventory_item_id, branch_id, supplier_id, received_date, production_date,
           expiry_date, original_quantity, remaining_quantity, unit_cost, created_by)
         VALUES ($1,$2,$3,$4, COALESCE($5, CURRENT_DATE), $6, $7, $8, $8, $9, $10)
         RETURNING *`,
        [batchNumber || null, inventoryItemId, branchId, supplierId || null, receivedDate || null,
         productionDate || null, expiryDate || null, convertedQuantity, unitCostInStockUnit, req.user.id]
      );
      batchId = batch.rows[0].id;
      await logAudit(client, {
        branchId, userId: req.user.id, action: "BATCH_CREATED", entityType: "inventory_batch", entityId: batchId,
        newValues: { batchNumber, expiryDate, quantity: convertedQuantity }, req,
      });
    }

    const { movement, duplicate } = await postInventoryMovement(client, {
      branchId, inventoryItemId, quantity: convertedQuantity, movementType: "PURCHASE_RECEIPT",
      referenceType: "purchase_receipt", unit: stockUnit, unitCost: unitCostInStockUnit, batchId,
      notes: notes || null, userId: req.user.id, idempotencyKey,
    });
    if (!duplicate) {
      await logAudit(client, {
        branchId, userId: req.user.id, action: "PURCHASE_RECEIPT", entityType: "inventory_item", entityId: inventoryItemId,
        newValues: { quantity: convertedQuantity, unitCost: unitCostInStockUnit, batchId }, req,
      });
    }
    await client.query("COMMIT");
    res.status(201).json({ movement, batchId, duplicate });
  } catch (err) {
    await client.query("ROLLBACK");
    if (err.code === "INSUFFICIENT_STOCK" || err.code === "NO_UNIT_CONVERSION") return res.status(400).json({ error: err.message });
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// GET /api/inventory/batches?branchId=&itemId= - الدفعات النشطة (للمراجعة/تقرير الصلاحية)
router.get("/batches", requireAuth, staffRoles, async (req, res) => {
  let { branchId, itemId } = req.query;
  if (req.user.role === "branch_manager" || req.user.role === "cashier") branchId = req.user.branchId;
  const conditions = [];
  const values = [];
  let i = 1;
  if (branchId) { conditions.push(`b.branch_id = $${i++}`); values.push(branchId); }
  if (itemId) { conditions.push(`b.inventory_item_id = $${i++}`); values.push(itemId); }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  try {
    const result = await pool.query(
      `SELECT b.*, ii.name AS item_name, ii.unit, br.name AS branch_name
       FROM inventory_batches b
       JOIN inventory_items ii ON ii.id = b.inventory_item_id
       JOIN branches br ON br.id = b.branch_id
       ${where}
       ORDER BY b.expiry_date ASC NULLS LAST, b.id`,
      values
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------- تحويلات الوحدات (اختياري - مطلوب بس لو حد بيستلم بوحدة مختلفة عن وحدة تتبّع الصنف) ----------------

router.get("/unit-conversions", requireAuth, staffRoles, async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM unit_conversions ORDER BY from_unit, to_unit");
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/unit-conversions", requireAuth, requireRole("admin"), async (req, res) => {
  const { fromUnit, toUnit, factor } = req.body;
  if (!fromUnit || !toUnit || !factor || Number(factor) <= 0) {
    return res.status(400).json({ error: "بيانات ناقصة" });
  }
  try {
    const result = await pool.query(
      `INSERT INTO unit_conversions (from_unit, to_unit, factor) VALUES ($1,$2,$3)
       ON CONFLICT (from_unit, to_unit) DO UPDATE SET factor = $3 RETURNING *`,
      [fromUnit, toUnit, factor]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------- مطابقة المخزون (Reconciliation) واكتشاف الفروقات ----------------

// POST /api/inventory/reconcile-check?branchId= - يقارن رصيد كل صنف (branch_inventory_stock) بمجموع
// حركاته المسجّلة في الليدجر (inventory_movements) - أي فرق مش بيتصلّح تلقائي، بيتسجل كـdiscrepancy
// يحتاج مراجعة وتصحيح واعي (PATCH /discrepancies/:id/resolve). الفرق متوقع يبقى صفر دايمًا للحركات
// اللي عدّت من postInventoryMovement - الفائدة الحقيقية هنا هي اكتشاف أي حركة قديمة قبل هذه المرحلة
// أو أي تلاعب مباشر في القاعدة تم من غير ما يعدّي على الليدجر
router.post("/reconcile-check", requireAuth, stockManagers, async (req, res) => {
  let { branchId } = req.query;
  if (req.user.role === "branch_manager") branchId = req.user.branchId;
  if (!branchId) return res.status(400).json({ error: "لازم تحدد branchId" });
  try {
    const result = await pool.query(
      `SELECT bis.branch_id, bis.inventory_item_id, bis.quantity AS stock_balance,
              COALESCE(SUM(im.quantity), 0) AS ledger_sum
       FROM branch_inventory_stock bis
       LEFT JOIN inventory_movements im ON im.branch_id = bis.branch_id AND im.inventory_item_id = bis.inventory_item_id
       WHERE bis.branch_id = $1
       GROUP BY bis.branch_id, bis.inventory_item_id, bis.quantity
       HAVING bis.quantity != COALESCE(SUM(im.quantity), 0)`,
      [branchId]
    );
    const created = [];
    for (const row of result.rows) {
      const difference = Number(row.stock_balance) - Number(row.ledger_sum);
      const inserted = await pool.query(
        `INSERT INTO inventory_discrepancies (branch_id, inventory_item_id, ledger_sum, stock_balance, difference)
         VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [row.branch_id, row.inventory_item_id, row.ledger_sum, row.stock_balance, difference]
      );
      created.push(inserted.rows[0]);
    }
    res.json({ checked: true, discrepanciesFound: created.length, discrepancies: created });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/inventory/discrepancies?branchId=&resolved=false
router.get("/discrepancies", requireAuth, stockManagers, async (req, res) => {
  let { branchId } = req.query;
  if (req.user.role === "branch_manager") branchId = req.user.branchId;
  const conditions = [];
  const values = [];
  let i = 1;
  if (branchId) { conditions.push(`d.branch_id = $${i++}`); values.push(branchId); }
  if (req.query.resolved === "false") conditions.push("d.resolved_at IS NULL");
  if (req.query.resolved === "true") conditions.push("d.resolved_at IS NOT NULL");
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  try {
    const result = await pool.query(
      `SELECT d.*, ii.name AS item_name, br.name AS branch_name
       FROM inventory_discrepancies d
       JOIN inventory_items ii ON ii.id = d.inventory_item_id
       JOIN branches br ON br.id = d.branch_id
       ${where}
       ORDER BY d.detected_at DESC`,
      values
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/inventory/discrepancies/:id/resolve - تصحيح واعي (أدمن بس)
// ملاحظة مهمة: الفرق هنا معناه إن الرصيد (branch_inventory_stock) اتغيّر يومًا ما من غير ما الحركة
// دي تتسجل في الليدجر (زي حركات قديمة قبل هذه المرحلة، أو تعديل مباشر في القاعدة) - فالتصحيح
// الصحيح إننا "نوثّق" الفرق كحركة OPENING_BALANCE بتغطي الفجوة في تاريخ الليدجر، من غير ما نلمس
// الرصيد الحالي تاني (هو أصلًا صحيح، الناقص هو توثيقه في الليدجر بس). لو استخدمنا postInventoryMovement
// العادية هنا هتعدّل الرصيد كمان وهيفضل فيه فرق (لأنها بتحرك الاتنين مع بعض دايمًا بنفس القيمة)
router.patch("/discrepancies/:id/resolve", requireAuth, requireRole("admin"), async (req, res) => {
  const { resolutionNotes } = req.body;
  if (!resolutionNotes) return res.status(400).json({ error: "لازم توضيح سبب/طريقة التصحيح" });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const disc = await client.query("SELECT * FROM inventory_discrepancies WHERE id = $1 FOR UPDATE", [req.params.id]);
    if (disc.rows.length === 0) return res.status(404).json({ error: "السجل مش موجود" });
    const d = disc.rows[0];
    if (d.resolved_at) return res.status(400).json({ error: "الفرق ده اتحل بالفعل" });

    const correction = Number(d.stock_balance) - Number(d.ledger_sum);
    if (correction !== 0) {
      await client.query(
        `INSERT INTO inventory_movements
          (branch_id, inventory_item_id, movement_type, quantity, quantity_before, quantity_after,
           reference_type, reference_id, notes, created_by)
         VALUES ($1,$2,'OPENING_BALANCE',$3,$4,$5,'discrepancy',$6,$7,$8)`,
        [d.branch_id, d.inventory_item_id, correction, d.ledger_sum, d.stock_balance, d.id,
         `توثيق فرق تاريخي: الرصيد ${d.stock_balance}، الليدجر كان ${d.ledger_sum} - ${resolutionNotes}`, req.user.id]
      );
    }
    const updated = await client.query(
      `UPDATE inventory_discrepancies SET resolved_at = now(), resolved_by = $1, resolution_notes = $2 WHERE id = $3 RETURNING *`,
      [req.user.id, resolutionNotes, d.id]
    );
    await logAudit(client, {
      branchId: d.branch_id, userId: req.user.id, action: "DISCREPANCY_RESOLVED", entityType: "inventory_item", entityId: d.inventory_item_id,
      oldValues: { stockBalance: d.stock_balance, ledgerSum: d.ledger_sum }, metadata: { resolutionNotes }, req,
    });
    await client.query("COMMIT");
    res.json(updated.rows[0]);
  } catch (err) {
    await client.query("ROLLBACK");
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

module.exports = router;
