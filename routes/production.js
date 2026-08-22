const express = require("express");
const router = express.Router();
const pool = require("../db/pool");
const { requireAuth, requireRole, assertOwnBranch } = require("../middleware/auth");
const { requirePermission } = require("../middleware/permissions");
const { logAudit } = require("../db/audit");
const { postInventoryMovement, consumeFromBatches } = require("../db/inventory-ledger");
const { explodeRecipeConsumption, computeRecipeCost } = require("../db/recipe-engine");
const { postJournalEntry, getAccountByCode } = require("../db/accounting-engine");

// POST /api/production - أمر تصنيع جديد (DRAFT) - بياخد الوصفة من النسخة النشطة حاليًا للصنف الناتج
// {branchId, recipeId, plannedQuantity, productionDate?, batchNumber?, expiryDate?, notes?}
router.post("/", requireAuth, requirePermission("production.create"), async (req, res) => {
  const { branchId, recipeId, plannedQuantity, productionDate, batchNumber, expiryDate, notes } = req.body;
  if (!branchId || !recipeId || !plannedQuantity || plannedQuantity <= 0) {
    return res.status(400).json({ error: "بيانات ناقصة أو الكمية المخططة لازم تكون أكبر من صفر" });
  }
  if (!assertOwnBranch(req.user, branchId)) return res.status(403).json({ error: "معندكش صلاحية تصنّع لفرع تاني" });

  try {
    const activeVersion = await pool.query(
      "SELECT id FROM recipe_versions WHERE recipe_id = $1 AND status = 'ACTIVE'", [recipeId]
    );
    if (activeVersion.rows.length === 0) return res.status(400).json({ error: "الوصفة دي معندهاش نسخة نشطة حاليًا" });

    const result = await pool.query(
      `INSERT INTO production_orders
        (branch_id, recipe_id, recipe_version_id, planned_quantity, production_date, batch_number, expiry_date, notes, operator_id)
       VALUES ($1,$2,$3,$4,COALESCE($5,CURRENT_DATE),$6,$7,$8,$9) RETURNING *`,
      [branchId, recipeId, activeVersion.rows[0].id, plannedQuantity, productionDate || null,
       batchNumber || null, expiryDate || null, notes || null, req.user.id]
    );
    await logAudit(pool, {
      branchId, userId: req.user.id, action: "PRODUCTION_ORDER_CREATED", entityType: "production_order", entityId: result.rows[0].id,
      newValues: { recipeId, plannedQuantity }, req,
    });
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/production?branchId=&status= - قايمة أوامر التصنيع
router.get("/", requireAuth, requirePermission("production.view"), async (req, res) => {
  let { branchId, status } = req.query;
  if (req.user.role === "branch_manager") branchId = req.user.branchId;
  const conditions = [];
  const values = [];
  let i = 1;
  if (branchId) { conditions.push(`po.branch_id = $${i++}`); values.push(branchId); }
  if (status) { conditions.push(`po.status = $${i++}`); values.push(status); }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  try {
    const result = await pool.query(
      `SELECT po.*, b.name AS branch_name,
              COALESCE(mi.name || ' - ' || v.label, ii.name) AS product_name
       FROM production_orders po
       JOIN branches b ON b.id = po.branch_id
       JOIN recipes r ON r.id = po.recipe_id
       LEFT JOIN menu_item_variants v ON v.id = r.variant_id
       LEFT JOIN menu_items mi ON mi.id = v.item_id
       LEFT JOIN inventory_items ii ON ii.id = r.inventory_item_id
       ${where}
       ORDER BY po.id DESC LIMIT 200`,
      values
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/production/:id/approve - DRAFT → APPROVED (أدمن بس)
router.post("/:id/approve", requireAuth, requireRole("admin"), requirePermission("production.approve"), async (req, res) => {
  try {
    const existing = await pool.query("SELECT * FROM production_orders WHERE id = $1", [req.params.id]);
    if (existing.rows.length === 0) return res.status(404).json({ error: "أمر التصنيع مش موجود" });
    if (existing.rows[0].status !== "DRAFT") return res.status(400).json({ error: "أمر التصنيع ده مش في حالة قابلة للاعتماد" });
    const result = await pool.query(
      `UPDATE production_orders SET status = 'APPROVED', approved_by = $1, approved_at = now() WHERE id = $2 RETURNING *`,
      [req.user.id, req.params.id]
    );
    await logAudit(pool, {
      branchId: existing.rows[0].branch_id, userId: req.user.id, action: "PRODUCTION_ORDER_APPROVED",
      entityType: "production_order", entityId: Number(req.params.id), req,
    });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/production/:id/start - APPROVED → IN_PROGRESS - بيخصم مكونات الوصفة (مفصولة نظريًا حسب
// الكمية المخططة) من مخزون الفرع فعليًا، واعية بالدفعات (FEFO/FIFO) زي التحويلات بالظبط
router.post("/:id/start", requireAuth, requirePermission("production.create"), async (req, res) => {
  const client = await pool.connect();
  try {
    // المرحلة 6 (6A.2): القفل (FOR UPDATE) لازم يكون أول حاجة بعد BEGIN، قبل أي فحص حالة - نفس باج
    // التزامن اللي اتكشف واتصلح فعليًا في orders.js (void) و kitchen-transfers.js (issue/receive) في
    // المرحلة 5: طلبين /start متزامنين على نفس أمر التصنيع كانوا هيعدّوا فحص الحالة (APPROVED) لحظة
    // واحدة وبعدين الاتنين يخصموا المكونات مرتين لأمر واحد
    await client.query("BEGIN");
    const existing = await client.query("SELECT * FROM production_orders WHERE id = $1 FOR UPDATE", [req.params.id]);
    if (existing.rows.length === 0) { await client.query("ROLLBACK"); return res.status(404).json({ error: "أمر التصنيع مش موجود" }); }
    const order = existing.rows[0];
    if (order.status !== "APPROVED") { await client.query("ROLLBACK"); return res.status(400).json({ error: "أمر التصنيع ده مش في حالة قابلة للبدء" }); }
    if (!assertOwnBranch(req.user, order.branch_id)) {
      await client.query("ROLLBACK");
      return res.status(403).json({ error: "معندكش صلاحية تشغّل تصنيع في الفرع ده" });
    }

    const { raw } = await explodeRecipeConsumption(client, order.recipe_version_id, order.planned_quantity, new Set());

    for (const [itemId, data] of raw) {
      const consumed = await consumeFromBatches(client, { branchId: order.branch_id, inventoryItemId: itemId, quantity: data.quantity });
      if (consumed && consumed.consumed.length > 0) {
        for (const part of consumed.consumed) {
          await postInventoryMovement(client, {
            branchId: order.branch_id, inventoryItemId: itemId, quantity: -part.quantity,
            movementType: "PRODUCTION_OUT", referenceType: "production_order", referenceId: order.id,
            unitCost: part.unitCost, batchId: part.batchId, userId: req.user.id,
            skipBatchConsumption: true, negativeStockOverrideApproved: true,
          });
          await client.query(
            `INSERT INTO production_order_batches (production_order_id, role, inventory_item_id, batch_id, quantity)
             VALUES ($1,'input',$2,$3,$4)`,
            [order.id, itemId, part.batchId, part.quantity]
          );
        }
      } else {
        await postInventoryMovement(client, {
          branchId: order.branch_id, inventoryItemId: itemId, quantity: -data.quantity,
          movementType: "PRODUCTION_OUT", referenceType: "production_order", referenceId: order.id,
          userId: req.user.id, negativeStockOverrideApproved: true,
        });
        await client.query(
          `INSERT INTO production_order_batches (production_order_id, role, inventory_item_id, batch_id, quantity)
           VALUES ($1,'input',$2,NULL,$3)`,
          [order.id, itemId, data.quantity]
        );
      }
    }

    const updated = await client.query(
      `UPDATE production_orders SET status = 'IN_PROGRESS', started_at = now() WHERE id = $1 RETURNING *`,
      [order.id]
    );
    await logAudit(client, {
      branchId: order.branch_id, userId: req.user.id, action: "PRODUCTION_ORDER_STARTED",
      entityType: "production_order", entityId: order.id, req,
    });
    await client.query("COMMIT");
    res.json(updated.rows[0]);
  } catch (err) {
    await client.query("ROLLBACK");
    if (err.code === "INSUFFICIENT_STOCK" || err.code === "NO_UNIT_CONVERSION") return res.status(400).json({ error: err.message });
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// POST /api/production/:id/complete - IN_PROGRESS → COMPLETED - {actualQuantity, varianceReason?}
// بيسجل الكمية الفعلية المنتجة في المخزون (دفعة جديدة لو محدد رقم دفعة/صلاحية)، وبيحسب فرق الإنتاج
// (Yield Variance) - لو الفرق كبير (فوق pos_settings.production_variance_alert_percent) لازم سبب
router.post("/:id/complete", requireAuth, requirePermission("production.complete"), async (req, res) => {
  const { actualQuantity, varianceReason } = req.body;
  if (!actualQuantity || actualQuantity <= 0) return res.status(400).json({ error: "لازم كمية فعلية أكبر من صفر" });

  const client = await pool.connect();
  try {
    // المرحلة 6 (6A.2): نفس إصلاح التزامن - القفل أول حاجة بعد BEGIN، قبل أي فحص حالة
    await client.query("BEGIN");
    const existing = await client.query("SELECT * FROM production_orders WHERE id = $1 FOR UPDATE", [req.params.id]);
    if (existing.rows.length === 0) { await client.query("ROLLBACK"); return res.status(404).json({ error: "أمر التصنيع مش موجود" }); }
    const order = existing.rows[0];
    if (order.status !== "IN_PROGRESS") { await client.query("ROLLBACK"); return res.status(400).json({ error: "أمر التصنيع ده مش في حالة قابلة للإكمال" }); }
    if (!assertOwnBranch(req.user, order.branch_id)) {
      await client.query("ROLLBACK");
      return res.status(403).json({ error: "معندكش صلاحية تكمّل تصنيع في الفرع ده" });
    }

    const variance = Number(actualQuantity) - Number(order.planned_quantity);
    const variancePercent = Number(order.planned_quantity) ? (variance / Number(order.planned_quantity)) * 100 : 0;
    const settings = await client.query("SELECT production_variance_alert_percent FROM pos_settings WHERE id = 1");
    const threshold = Number(settings.rows[0]?.production_variance_alert_percent ?? 10);
    if (Math.abs(variancePercent) > threshold && !varianceReason) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        error: `فرق الإنتاج ${variancePercent.toFixed(1)}% أكبر من الحد المسموح (${threshold}%) - لازم توضّح السبب`,
        code: "VARIANCE_REASON_REQUIRED",
      });
    }

    const recipeRes = await client.query("SELECT inventory_item_id FROM recipes WHERE id = $1", [order.recipe_id]);
    const outputItemId = recipeRes.rows[0]?.inventory_item_id;
    if (!outputItemId) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "الوصفة دي مش لصنف مصنّع (manufactured_item) - مينفعش تُكمَّل كتصنيع" });
    }

    const costInfo = await computeRecipeCost(pool, order.recipe_version_id, 1);
    const unitCost = costInfo.incomplete ? null : costInfo.totalCost;

    let batchId = null;
    if (order.batch_number || order.expiry_date) {
      const batch = await client.query(
        `INSERT INTO inventory_batches
          (batch_number, inventory_item_id, branch_id, received_date, expiry_date, original_quantity, remaining_quantity, unit_cost, created_by)
         VALUES ($1,$2,$3,CURRENT_DATE,$4,$5,$5,$6,$7) RETURNING id`,
        [order.batch_number, outputItemId, order.branch_id, order.expiry_date, actualQuantity, unitCost, req.user.id]
      );
      batchId = batch.rows[0].id;
    }

    await postInventoryMovement(client, {
      branchId: order.branch_id, inventoryItemId: outputItemId, quantity: Number(actualQuantity),
      movementType: "PRODUCTION_IN", referenceType: "production_order", referenceId: order.id,
      unitCost, batchId, userId: req.user.id, negativeStockOverrideApproved: true,
    });
    if (batchId) {
      await client.query(
        `INSERT INTO production_order_batches (production_order_id, role, inventory_item_id, batch_id, quantity) VALUES ($1,'output',$2,$3,$4)`,
        [order.id, outputItemId, batchId, actualQuantity]
      );
    }

    // المرحلة 4B: التصنيع بيحوّل قيمة داخل نفس حساب المخزون المشترك 1400 (خام → تام) - مدين المنتج
    // التام / دائن المكونات المستهلكة (المكونات اتخصمت فعليًا وقت /start عبر postInventoryMovement، بس
    // القيد المحاسبي بيترحّل هنا مرة واحدة عند الإكمال). أي فرق بين قيمة المستهلك والمنتج (Yield Variance)
    // بيتقفل على 5300 عشان القيد يفضل متزن دايمًا مهما كان الفرق
    const rawCostRes = await client.query(
      `SELECT COALESCE(SUM(total_cost),0) AS raw_cost, BOOL_OR(total_cost IS NULL) AS incomplete
       FROM inventory_movements WHERE reference_type = 'production_order' AND reference_id = $1 AND movement_type = 'PRODUCTION_OUT'`,
      [order.id]
    );
    const rawMaterialValue = Number(rawCostRes.rows[0].raw_cost);
    const rawIncomplete = rawCostRes.rows[0].incomplete;
    const finishedGoodsValue = unitCost != null ? Number(unitCost) * Number(actualQuantity) : 0;

    if (rawMaterialValue > 0 || finishedGoodsValue > 0) {
      const inventoryAccount = await getAccountByCode(client, "1400");
      const varianceAccount = await getAccountByCode(client, "5300");
      const incompleteNote = rawIncomplete || costInfo.incomplete ? " (تكلفة جزئية - بيانات ناقصة)" : "";
      const entryLines = [];
      if (finishedGoodsValue > 0) entryLines.push({ accountId: inventoryAccount.id, debit: finishedGoodsValue, description: "إنتاج - إضافة المنتج التام للمخزون" });
      if (rawMaterialValue > 0) entryLines.push({ accountId: inventoryAccount.id, credit: rawMaterialValue, description: "إنتاج - خصم مكونات مستهلكة" });
      const varianceAmount = finishedGoodsValue - rawMaterialValue;
      if (varianceAmount > 0.0000001) {
        entryLines.push({ accountId: varianceAccount.id, credit: varianceAmount, description: `فرق تكلفة إنتاج${incompleteNote}` });
      } else if (varianceAmount < -0.0000001) {
        entryLines.push({ accountId: varianceAccount.id, debit: -varianceAmount, description: `فرق تكلفة إنتاج${incompleteNote}` });
      }
      await postJournalEntry(client, {
        entryDate: new Date().toISOString().slice(0, 10), description: `تصنيع - أمر #${order.id}`,
        sourceType: "production_order", sourceId: order.id, branchId: order.branch_id,
        lines: entryLines, idempotencyKey: `production-complete-${order.id}`, userId: req.user.id,
      });
    }

    const updated = await client.query(
      `UPDATE production_orders
       SET status = 'COMPLETED', actual_quantity = $1, variance_reason = $2, completed_by = $3, completed_at = now()
       WHERE id = $4 RETURNING *`,
      [actualQuantity, varianceReason || null, req.user.id, order.id]
    );
    await logAudit(client, {
      branchId: order.branch_id, userId: req.user.id, action: "PRODUCTION_ORDER_COMPLETED",
      entityType: "production_order", entityId: order.id,
      newValues: { actualQuantity, variance, variancePercent }, metadata: { varianceReason }, req,
    });
    await client.query("COMMIT");
    res.json({ ...updated.rows[0], variance, variancePercent });
  } catch (err) {
    await client.query("ROLLBACK");
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// POST /api/production/:id/cancel - إلغاء أمر تصنيع - لو كان IN_PROGRESS، بيرجّع المكونات اللي كانت
// اتخصمت بالظبط (نفس منطق إرجاع المخزون وقت استرجاع البيع بالظبط) - مايُكمَّلش تصنيع مكتمل بالفعل
router.post("/:id/cancel", requireAuth, requirePermission("production.cancel"), async (req, res) => {
  const { reason } = req.body;
  const client = await pool.connect();
  try {
    // المرحلة 6 (6A.2): نفس إصلاح التزامن - القفل أول حاجة بعد BEGIN، قبل أي فحص حالة
    await client.query("BEGIN");
    const existing = await client.query("SELECT * FROM production_orders WHERE id = $1 FOR UPDATE", [req.params.id]);
    if (existing.rows.length === 0) { await client.query("ROLLBACK"); return res.status(404).json({ error: "أمر التصنيع مش موجود" }); }
    const order = existing.rows[0];
    if (order.status === "COMPLETED" || order.status === "CANCELLED") {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "أمر التصنيع ده اكتمل أو اتلغى بالفعل" });
    }
    if (!assertOwnBranch(req.user, order.branch_id)) {
      await client.query("ROLLBACK");
      return res.status(403).json({ error: "معندكش صلاحية تلغي تصنيع في الفرع ده" });
    }

    if (order.status === "IN_PROGRESS") {
      const inputs = await client.query(
        "SELECT * FROM production_order_batches WHERE production_order_id = $1 AND role = 'input'", [order.id]
      );
      for (const inp of inputs.rows) {
        if (inp.batch_id) {
          await client.query(
            `UPDATE inventory_batches SET remaining_quantity = remaining_quantity + $1, status = 'active' WHERE id = $2`,
            [inp.quantity, inp.batch_id]
          );
        }
        await postInventoryMovement(client, {
          branchId: order.branch_id, inventoryItemId: inp.inventory_item_id, quantity: Number(inp.quantity),
          movementType: "PRODUCTION_REVERSAL", referenceType: "production_order", referenceId: order.id,
          batchId: inp.batch_id, userId: req.user.id, skipBatchConsumption: true, negativeStockOverrideApproved: true,
        });
      }
    }

    const updated = await client.query(
      `UPDATE production_orders SET status = 'CANCELLED', cancelled_by = $1, cancelled_at = now(), notes = COALESCE(notes || ' - ', '') || $2 WHERE id = $3 RETURNING *`,
      [req.user.id, reason ? `إلغاء: ${reason}` : "إلغاء", order.id]
    );
    await logAudit(client, {
      branchId: order.branch_id, userId: req.user.id, action: "PRODUCTION_ORDER_CANCELLED",
      entityType: "production_order", entityId: order.id, metadata: { reason, hadConsumedInputs: order.status === "IN_PROGRESS" }, req,
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
