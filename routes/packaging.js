// Procurement v2 STEP J: التعبئة (Packaging) - مرحلة منفصلة عن التصنيع نفسه: بتاخد دفعة سائبة/نصف
// مصنّعة معروفة بعينها وتحوّلها لعدد وحدات معبأة قابلة للبيع/التحويل. نفس شكل production_orders/
// production_order_batches بالظبط (input/output roles) عمدًا - نفس محرك الليدجر ونفس منطق الترقيم/التتبّع
// من STEP H/I من غير اختراع مسار تاني. بتستخدم نفس نوعي حركة PRODUCTION_IN/PRODUCTION_OUT الموجودين
// بالفعل (التعبئة تحويل قيمة مخزون زي التصنيع بالظبط) - reference_type='packaging_order' هو اللي بيميّزها
// في السجل، مش نوع حركة منفصل (نفس مبدأ reference_type العام الموثّق في تعليق inventory_movements)
const express = require("express");
const router = express.Router();
const pool = require("../db/pool");
const { requireAuth, requireRole, assertOwnBranch } = require("../middleware/auth");
const { requirePermission } = require("../middleware/permissions");
const { logAudit } = require("../db/audit");
const { postInventoryMovement, consumeFromBatches } = require("../db/inventory-ledger");
const { postJournalEntry, getAccountByCode } = require("../db/accounting-engine");
const { generateBatchNumber } = require("../db/batch-numbering");

// POST /api/packaging - أمر تعبئة جديد (DRAFT)
// {branchId, inputItemId, inputBatchId?, plannedInputQuantity, outputItemId, plannedOutputQuantity, packagingDate?, batchNumber?, expiryDate?, notes?}
router.post("/", requireAuth, requirePermission("production.create"), async (req, res) => {
  const {
    branchId, inputItemId, inputBatchId, plannedInputQuantity, outputItemId, plannedOutputQuantity,
    packagingDate, batchNumber, expiryDate, notes,
  } = req.body;
  if (!branchId || !inputItemId || !outputItemId || !plannedInputQuantity || !plannedOutputQuantity
      || plannedInputQuantity <= 0 || plannedOutputQuantity <= 0) {
    return res.status(400).json({ error: "بيانات ناقصة أو كمية غير صحيحة" });
  }
  if (!assertOwnBranch(req.user, branchId)) return res.status(403).json({ error: "معندكش صلاحية تعبّي لفرع تاني" });

  try {
    if (inputBatchId) {
      const batchCheck = await pool.query(
        "SELECT id FROM inventory_batches WHERE id = $1 AND inventory_item_id = $2 AND branch_id = $3 AND status = 'active'",
        [inputBatchId, inputItemId, branchId]
      );
      if (batchCheck.rows.length === 0) return res.status(400).json({ error: "الدفعة المحددة مش موجودة/مش نشطة/مش لنفس الصنف والفرع" });
    }
    const result = await pool.query(
      `INSERT INTO packaging_orders
        (branch_id, input_item_id, input_batch_id, output_item_id, planned_input_quantity, planned_output_quantity,
         packaging_date, batch_number, expiry_date, notes, operator_id)
       VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7,CURRENT_DATE),$8,$9,$10,$11) RETURNING *`,
      [branchId, inputItemId, inputBatchId || null, outputItemId, plannedInputQuantity, plannedOutputQuantity,
       packagingDate || null, batchNumber || null, expiryDate || null, notes || null, req.user.id]
    );
    await logAudit(pool, {
      branchId, userId: req.user.id, action: "PACKAGING_ORDER_CREATED", entityType: "packaging_order", entityId: result.rows[0].id,
      newValues: { inputItemId, outputItemId, plannedInputQuantity, plannedOutputQuantity }, req,
    });
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/packaging?branchId=&status=
router.get("/", requireAuth, requirePermission("production.view"), async (req, res) => {
  let { branchId, status } = req.query;
  if (req.user.role === "branch_manager") branchId = req.user.branchId;
  const conditions = [];
  const values = [];
  let i = 1;
  if (branchId) { conditions.push(`p.branch_id = $${i++}`); values.push(branchId); }
  if (status) { conditions.push(`p.status = $${i++}`); values.push(status); }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  try {
    const result = await pool.query(
      `SELECT p.*, b.name AS branch_name, ii.name AS input_item_name, oi.name AS output_item_name
       FROM packaging_orders p
       JOIN branches b ON b.id = p.branch_id
       JOIN inventory_items ii ON ii.id = p.input_item_id
       JOIN inventory_items oi ON oi.id = p.output_item_id
       ${where} ORDER BY p.id DESC LIMIT 200`,
      values
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/packaging/:id
router.get("/:id", requireAuth, requirePermission("production.view"), async (req, res) => {
  try {
    const order = await pool.query(
      `SELECT p.*, b.name AS branch_name, ii.name AS input_item_name, oi.name AS output_item_name
       FROM packaging_orders p
       JOIN branches b ON b.id = p.branch_id
       JOIN inventory_items ii ON ii.id = p.input_item_id
       JOIN inventory_items oi ON oi.id = p.output_item_id
       WHERE p.id = $1`,
      [req.params.id]
    );
    if (order.rows.length === 0) return res.status(404).json({ error: "أمر التعبئة مش موجود" });
    if (req.user.role === "branch_manager" && !assertOwnBranch(req.user, order.rows[0].branch_id)) {
      return res.status(403).json({ error: "معندكش صلاحية تشوف أمر تعبئة فرع تاني" });
    }
    const batches = await pool.query(
      `SELECT pob.*, ii.name AS item_name FROM packaging_order_batches pob
       JOIN inventory_items ii ON ii.id = pob.inventory_item_id WHERE pob.packaging_order_id = $1`,
      [req.params.id]
    );
    res.json({ ...order.rows[0], batches: batches.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/packaging/:id/approve - DRAFT → APPROVED (أدمن بس، زي اعتماد أمر التصنيع بالظبط)
router.post("/:id/approve", requireAuth, requireRole("admin"), requirePermission("production.approve"), async (req, res) => {
  try {
    const existing = await pool.query("SELECT * FROM packaging_orders WHERE id = $1", [req.params.id]);
    if (existing.rows.length === 0) return res.status(404).json({ error: "أمر التعبئة مش موجود" });
    if (existing.rows[0].status !== "DRAFT") return res.status(400).json({ error: "أمر التعبئة ده مش في حالة قابلة للاعتماد" });
    const result = await pool.query(
      `UPDATE packaging_orders SET status = 'APPROVED', approved_by = $1, approved_at = now() WHERE id = $2 RETURNING *`,
      [req.user.id, req.params.id]
    );
    await logAudit(pool, {
      branchId: existing.rows[0].branch_id, userId: req.user.id, action: "PACKAGING_ORDER_APPROVED",
      entityType: "packaging_order", entityId: Number(req.params.id), req,
    });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/packaging/:id/start - APPROVED → IN_PROGRESS - بيخصم الكمية المخططة من input_item_id فعليًا
// (من input_batch_id المحدد لو موجود، وإلا FEFO/FIFO زي التصنيع بالظبط) - {actualInputQuantity?}
router.post("/:id/start", requireAuth, requirePermission("production.create"), async (req, res) => {
  const { actualInputQuantity } = req.body;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const existing = await client.query("SELECT * FROM packaging_orders WHERE id = $1 FOR UPDATE", [req.params.id]);
    if (existing.rows.length === 0) { await client.query("ROLLBACK"); return res.status(404).json({ error: "أمر التعبئة مش موجود" }); }
    const order = existing.rows[0];
    if (order.status !== "APPROVED") { await client.query("ROLLBACK"); return res.status(400).json({ error: "أمر التعبئة ده مش في حالة قابلة للبدء" }); }
    if (!assertOwnBranch(req.user, order.branch_id)) {
      await client.query("ROLLBACK");
      return res.status(403).json({ error: "معندكش صلاحية تشغّل تعبئة في الفرع ده" });
    }

    const plannedQuantity = Number(order.planned_input_quantity);
    const totalActual = actualInputQuantity != null ? Number(actualInputQuantity) : plannedQuantity;
    if (!totalActual || totalActual < 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "الكمية الفعلية المستهلكة لازم تكون رقم صحيح أكبر من صفر" });
    }

    let inputUnitCost = null;
    if (order.input_batch_id) {
      // دفعة محددة صراحة - استهلاك مباشر منها بس (مش FEFO/FIFO عام) - ده أصل فكرة التعبئة: تعرف بالظبط
      // بتعبّي من إيه
      const batch = await client.query("SELECT * FROM inventory_batches WHERE id = $1 FOR UPDATE", [order.input_batch_id]);
      if (batch.rows.length === 0 || Number(batch.rows[0].remaining_quantity) < totalActual - 0.0000001) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "الدفعة المحددة رصيدها المتبقي مش كافي" });
      }
      inputUnitCost = batch.rows[0].unit_cost != null ? Number(batch.rows[0].unit_cost) : null;
      await client.query(
        `UPDATE inventory_batches SET remaining_quantity = remaining_quantity - $1,
                status = CASE WHEN remaining_quantity - $1 <= 0 THEN 'depleted' ELSE status END WHERE id = $2`,
        [totalActual, order.input_batch_id]
      );
      await postInventoryMovement(client, {
        branchId: order.branch_id, inventoryItemId: order.input_item_id, quantity: -totalActual,
        movementType: "PRODUCTION_OUT", referenceType: "packaging_order", referenceId: order.id,
        unitCost: inputUnitCost, batchId: order.input_batch_id, userId: req.user.id,
        skipBatchConsumption: true, negativeStockOverrideApproved: true,
      });
      await client.query(
        `INSERT INTO packaging_order_batches (packaging_order_id, role, inventory_item_id, batch_id, quantity) VALUES ($1,'input',$2,$3,$4)`,
        [order.id, order.input_item_id, order.input_batch_id, totalActual]
      );
    } else {
      const consumed = await consumeFromBatches(client, { branchId: order.branch_id, inventoryItemId: order.input_item_id, quantity: totalActual });
      if (consumed && consumed.consumed.length > 0) {
        for (const part of consumed.consumed) {
          await postInventoryMovement(client, {
            branchId: order.branch_id, inventoryItemId: order.input_item_id, quantity: -part.quantity,
            movementType: "PRODUCTION_OUT", referenceType: "packaging_order", referenceId: order.id,
            unitCost: part.unitCost, batchId: part.batchId, userId: req.user.id,
            skipBatchConsumption: true, negativeStockOverrideApproved: true,
          });
          await client.query(
            `INSERT INTO packaging_order_batches (packaging_order_id, role, inventory_item_id, batch_id, quantity) VALUES ($1,'input',$2,$3,$4)`,
            [order.id, order.input_item_id, part.batchId, part.quantity]
          );
          inputUnitCost = part.unitCost;
        }
      } else {
        const itemRes = await client.query("SELECT unit_cost FROM inventory_items WHERE id = $1", [order.input_item_id]);
        inputUnitCost = itemRes.rows[0]?.unit_cost != null ? Number(itemRes.rows[0].unit_cost) : null;
        await postInventoryMovement(client, {
          branchId: order.branch_id, inventoryItemId: order.input_item_id, quantity: -totalActual,
          movementType: "PRODUCTION_OUT", referenceType: "packaging_order", referenceId: order.id,
          userId: req.user.id, negativeStockOverrideApproved: true,
        });
        await client.query(
          `INSERT INTO packaging_order_batches (packaging_order_id, role, inventory_item_id, batch_id, quantity) VALUES ($1,'input',$2,NULL,$3)`,
          [order.id, order.input_item_id, totalActual]
        );
      }
    }

    const updated = await client.query(
      `UPDATE packaging_orders SET status = 'IN_PROGRESS', actual_input_quantity = $1, started_at = now() WHERE id = $2 RETURNING *`,
      [totalActual, order.id]
    );
    await logAudit(client, {
      branchId: order.branch_id, userId: req.user.id, action: "PACKAGING_ORDER_STARTED",
      entityType: "packaging_order", entityId: order.id, req,
    });
    await client.query("COMMIT");
    res.json(updated.rows[0]);
  } catch (err) {
    await client.query("ROLLBACK");
    if (["INSUFFICIENT_STOCK", "NO_UNIT_CONVERSION"].includes(err.code)) return res.status(400).json({ error: err.message });
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// POST /api/packaging/:id/complete - IN_PROGRESS → COMPLETED - {actualOutputQuantity, varianceReason?}
// بيتنشئ دفعة ناتج جديدة (رقم مولّد نظاميًا لو معملش batch_number يدوي) بتكلفة وحدة محسوبة من التكلفة
// الفعلية للمدخل المستهلك (مش تقدير مستقل) - parent_batch_id بيتحدد مباشرة من input_batch_id (لو موجود)
// عشان التعبئة بتاخد دفعة واحدة معروفة بعينها دايمًا (مفيش غموض تعدد المصادر زي التصنيع)
router.post("/:id/complete", requireAuth, requirePermission("production.complete"), async (req, res) => {
  const { actualOutputQuantity, varianceReason } = req.body;
  if (!actualOutputQuantity || actualOutputQuantity <= 0) return res.status(400).json({ error: "لازم كمية ناتج فعلية أكبر من صفر" });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const existing = await client.query("SELECT * FROM packaging_orders WHERE id = $1 FOR UPDATE", [req.params.id]);
    if (existing.rows.length === 0) { await client.query("ROLLBACK"); return res.status(404).json({ error: "أمر التعبئة مش موجود" }); }
    const order = existing.rows[0];
    if (order.status !== "IN_PROGRESS") { await client.query("ROLLBACK"); return res.status(400).json({ error: "أمر التعبئة ده مش في حالة قابلة للإكمال" }); }
    if (!assertOwnBranch(req.user, order.branch_id)) {
      await client.query("ROLLBACK");
      return res.status(403).json({ error: "معندكش صلاحية تكمّل تعبئة في الفرع ده" });
    }

    const inputCostRes = await client.query(
      `SELECT COALESCE(SUM(total_cost),0) AS input_cost, BOOL_OR(total_cost IS NULL) AS incomplete
       FROM inventory_movements WHERE reference_type = 'packaging_order' AND reference_id = $1 AND movement_type = 'PRODUCTION_OUT'`,
      [order.id]
    );
    // UI-3 E2E discovery: نفس باج الفاصلة العشرية اللي اتصلح في routes/production.js - inputValue/quantity
    // بيرجّع كسر عشري متكرر في binary floating point غالبًا (زي 1040/94)، فلو ضربناه تاني في نفس الكمية
    // مش هيرجّع نفس الرقم بالظبط - القيد كان بيفشل check_journal_entry_balanced trigger الصارم في القاعدة.
    // round2 نفس helper المستخدم فعليًا في routes/reports.js للمطابقة المحاسبية - تقريب لأقرب قرش
    const round2 = (n) => Math.round(n * 100) / 100;
    const inputValue = round2(Number(inputCostRes.rows[0].input_cost));
    const inputIncomplete = inputCostRes.rows[0].incomplete;
    const outputUnitCost = inputValue > 0 ? inputValue / Number(actualOutputQuantity) : null;

    const inputBatchesRes = await client.query(
      "SELECT DISTINCT batch_id FROM packaging_order_batches WHERE packaging_order_id = $1 AND role = 'input' AND batch_id IS NOT NULL",
      [order.id]
    );
    const parentBatchId = order.input_batch_id || (inputBatchesRes.rows.length === 1 ? inputBatchesRes.rows[0].batch_id : null);

    const batchNumber = order.batch_number || (await generateBatchNumber(client, { inventoryItemId: order.output_item_id }));
    const batch = await client.query(
      `INSERT INTO inventory_batches
        (batch_number, inventory_item_id, branch_id, received_date, expiry_date, original_quantity, remaining_quantity,
         unit_cost, created_by, parent_batch_id)
       VALUES ($1,$2,$3,CURRENT_DATE,$4,$5,$5,$6,$7,$8) RETURNING id`,
      [batchNumber, order.output_item_id, order.branch_id, order.expiry_date, actualOutputQuantity, outputUnitCost, req.user.id, parentBatchId]
    );
    const batchId = batch.rows[0].id;

    await postInventoryMovement(client, {
      branchId: order.branch_id, inventoryItemId: order.output_item_id, quantity: Number(actualOutputQuantity),
      movementType: "PRODUCTION_IN", referenceType: "packaging_order", referenceId: order.id,
      unitCost: outputUnitCost, batchId, userId: req.user.id, negativeStockOverrideApproved: true,
    });
    await client.query(
      `INSERT INTO packaging_order_batches (packaging_order_id, role, inventory_item_id, batch_id, quantity) VALUES ($1,'output',$2,$3,$4)`,
      [order.id, order.output_item_id, batchId, actualOutputQuantity]
    );

    // نفس فلسفة قيد التصنيع بالظبط (routes/production.js) - القيمة بتتحوّل داخل نفس حساب المخزون
    // المشترك 1400 (سائب → معبّأ)، وأي فرق (تسرّب أثناء التعبئة مثلًا) بيتقفل على 5300
    const outputValue = outputUnitCost != null ? round2(outputUnitCost * Number(actualOutputQuantity)) : 0;
    if (inputValue > 0 || outputValue > 0) {
      const inventoryAccount = await getAccountByCode(client, "1400");
      const varianceAccount = await getAccountByCode(client, "5300");
      const incompleteNote = inputIncomplete ? " (تكلفة جزئية - بيانات ناقصة)" : "";
      const entryLines = [];
      if (outputValue > 0) entryLines.push({ accountId: inventoryAccount.id, debit: outputValue, description: "تعبئة - إضافة المنتج المعبأ للمخزون" });
      if (inputValue > 0) entryLines.push({ accountId: inventoryAccount.id, credit: inputValue, description: "تعبئة - خصم المدخل السائب المستهلك" });
      const varianceAmount = round2(outputValue - inputValue);
      if (varianceAmount > 0.0000001) {
        entryLines.push({ accountId: varianceAccount.id, credit: varianceAmount, description: `فرق تعبئة${incompleteNote}` });
      } else if (varianceAmount < -0.0000001) {
        entryLines.push({ accountId: varianceAccount.id, debit: -varianceAmount, description: `فرق تعبئة${incompleteNote}` });
      }
      await postJournalEntry(client, {
        entryDate: new Date().toISOString().slice(0, 10), description: `تعبئة - أمر #${order.id}`,
        sourceType: "packaging_order", sourceId: order.id, branchId: order.branch_id,
        lines: entryLines, idempotencyKey: `packaging-complete-${order.id}`, userId: req.user.id,
      });
    }

    const updated = await client.query(
      `UPDATE packaging_orders
       SET status = 'COMPLETED', actual_output_quantity = $1, variance_reason = $2, completed_by = $3, completed_at = now()
       WHERE id = $4 RETURNING *`,
      [actualOutputQuantity, varianceReason || null, req.user.id, order.id]
    );
    await logAudit(client, {
      branchId: order.branch_id, userId: req.user.id, action: "PACKAGING_ORDER_COMPLETED",
      entityType: "packaging_order", entityId: order.id, newValues: { actualOutputQuantity }, metadata: { varianceReason }, req,
    });
    await client.query("COMMIT");
    res.json({ ...updated.rows[0], batchId, generatedBatchNumber: batchNumber, parentBatchId });
  } catch (err) {
    await client.query("ROLLBACK");
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// POST /api/packaging/:id/cancel - لو IN_PROGRESS، بيرجّع المدخل المستهلك بالظبط (نفس منطق إلغاء التصنيع)
router.post("/:id/cancel", requireAuth, requirePermission("production.cancel"), async (req, res) => {
  const { reason } = req.body;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const existing = await client.query("SELECT * FROM packaging_orders WHERE id = $1 FOR UPDATE", [req.params.id]);
    if (existing.rows.length === 0) { await client.query("ROLLBACK"); return res.status(404).json({ error: "أمر التعبئة مش موجود" }); }
    const order = existing.rows[0];
    if (order.status === "COMPLETED" || order.status === "CANCELLED") {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "أمر التعبئة ده اكتمل أو اتلغى بالفعل" });
    }
    if (!assertOwnBranch(req.user, order.branch_id)) {
      await client.query("ROLLBACK");
      return res.status(403).json({ error: "معندكش صلاحية تلغي تعبئة في الفرع ده" });
    }

    if (order.status === "IN_PROGRESS") {
      const inputs = await client.query(
        "SELECT * FROM packaging_order_batches WHERE packaging_order_id = $1 AND role = 'input'", [order.id]
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
          movementType: "PRODUCTION_REVERSAL", referenceType: "packaging_order", referenceId: order.id,
          batchId: inp.batch_id, userId: req.user.id, skipBatchConsumption: true, negativeStockOverrideApproved: true,
        });
      }
    }

    const updated = await client.query(
      `UPDATE packaging_orders SET status = 'CANCELLED', cancelled_by = $1, cancelled_at = now(), notes = COALESCE(notes || ' - ', '') || $2 WHERE id = $3 RETURNING *`,
      [req.user.id, reason ? `إلغاء: ${reason}` : "إلغاء", order.id]
    );
    await logAudit(client, {
      branchId: order.branch_id, userId: req.user.id, action: "PACKAGING_ORDER_CANCELLED",
      entityType: "packaging_order", entityId: order.id, metadata: { reason, hadConsumedInputs: order.status === "IN_PROGRESS" }, req,
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
