const express = require("express");
const router = express.Router();
const pool = require("../db/pool");
const { requireAuth, requireRole, assertOwnBranch } = require("../middleware/auth");
const { postInventoryMovement, consumeFromBatches } = require("../db/inventory-ledger");
const { postJournalEntry, getAccountByCode } = require("../db/accounting-engine");
const { logAudit } = require("../db/audit");

const stockManagers = requireRole("admin", "branch_manager");

// Procurement v2 STEP D: لو الطلبية المرتبطة (kitchen_order_id) بتستخدم دورة الحياة الجديدة (DRAFT→...→
// IN_TRANSIT)، بنكملها لنفس النمط (IN_TRANSIT وقت /issue، RECEIVED وقت /receive) بدل ما تتقفل على القيمة
// القديمة 'fulfilled' زي طلبيات pending العادية - نفس السطر بالظبط بيفرّق بين المسارين حسب حالتها الحالية
const NEW_WORKFLOW_ACTIVE_STATUSES = ["DRAFT", "SUBMITTED", "APPROVED", "PREPARING", "READY", "DISPATCHED", "IN_TRANSIT"];
async function syncLinkedKitchenOrder(client, kitchenOrderId, { newWorkflowStatus, legacyStatus }) {
  if (!kitchenOrderId) return;
  const existing = await client.query("SELECT status FROM kitchen_orders WHERE id = $1", [kitchenOrderId]);
  if (existing.rows.length === 0) return;
  const isNewWorkflow = NEW_WORKFLOW_ACTIVE_STATUSES.includes(existing.rows[0].status);
  await client.query("UPDATE kitchen_orders SET status = $1 WHERE id = $2", [
    isNewWorkflow ? newWorkflowStatus : legacyStatus, kitchenOrderId,
  ]);
}

// بيستهلك من دفعات فرع المصدر (لو الصنف متتبّع بدفعات) وبيسجل تفصيل كل دفعة اتصرف منها في
// kitchen_transfer_item_batches عشان هويتها (رقم/صلاحية/إنتاج/تكلفة) تتنقل مع الكمية لفرع الاستلام
// بعدين - لو الصنف عادي (مفيش دفعات نشطة)، بيرجع لحركة واحدة عادية زي أي تحويل قبل هذه المرحلة
async function issueTransferItem(client, { kitchenTransferItemId, fromBranchId, inventoryItemId, quantity, transferId, userId, businessDate, notes }) {
  const consumed = await consumeFromBatches(client, { branchId: fromBranchId, inventoryItemId, quantity: Number(quantity) });
  if (consumed && consumed.consumed.length > 0) {
    for (const part of consumed.consumed) {
      await postInventoryMovement(client, {
        branchId: fromBranchId, inventoryItemId, quantity: -part.quantity,
        movementType: "TRANSFER_OUT", referenceType: "kitchen_transfer", referenceId: transferId,
        unitCost: part.unitCost, batchId: part.batchId, notes: notes || null, userId, businessDate,
        skipBatchConsumption: true, negativeStockOverrideApproved: true,
      });
      await client.query(
        `INSERT INTO kitchen_transfer_item_batches
          (kitchen_transfer_item_id, source_batch_id, quantity, batch_number, expiry_date, production_date, unit_cost)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [kitchenTransferItemId, part.batchId, part.quantity, part.batchNumber, part.expiryDate, part.productionDate, part.unitCost]
      );
    }
  } else {
    await postInventoryMovement(client, {
      branchId: fromBranchId, inventoryItemId, quantity: -Number(quantity),
      movementType: "TRANSFER_OUT", referenceType: "kitchen_transfer", referenceId: transferId,
      notes: notes || null, userId, businessDate, negativeStockOverrideApproved: true,
    });
  }
}

// بيوزّع الكمية المستلمة فعليًا (ممكن تقل عن المُصدَر) على الدفعات المُصدَرة بالترتيب اللي خرجت بيه
// (نفس ترتيب FEFO/FIFO المحفوظ من وقت الإصدار)، وبيفتح/يزوّد **نفس هوية الدفعة بالظبط** (رقم/صلاحية/
// إنتاج/تكلفة) في فرع الاستلام - مش دفعة جديدة مجهولة. لو الصنف عادي (مفيش دفعات)، حركة واحدة عادية.
async function receiveTransferItem(client, { kitchenTransferItemId, toBranchId, inventoryItemId, quantityReceived, transferId, userId, businessDate }) {
  const batchPortions = await client.query(
    `SELECT * FROM kitchen_transfer_item_batches WHERE kitchen_transfer_item_id = $1 ORDER BY id`,
    [kitchenTransferItemId]
  );
  if (batchPortions.rows.length === 0) {
    if (Number(quantityReceived) > 0) {
      await postInventoryMovement(client, {
        branchId: toBranchId, inventoryItemId, quantity: Number(quantityReceived),
        movementType: "TRANSFER_IN", referenceType: "kitchen_transfer", referenceId: transferId,
        userId, businessDate, negativeStockOverrideApproved: true,
      });
    }
    return;
  }

  let remaining = Number(quantityReceived);
  for (const portion of batchPortions.rows) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, Number(portion.quantity));
    if (take <= 0) continue;
    remaining -= take;

    const existingBatch = await client.query(
      `SELECT id FROM inventory_batches
       WHERE inventory_item_id = $1 AND branch_id = $2 AND status = 'active'
         AND COALESCE(batch_number,'') = COALESCE($3,'')
         AND COALESCE(expiry_date, '0001-01-01'::date) = COALESCE($4::date, '0001-01-01'::date)
       FOR UPDATE`,
      [inventoryItemId, toBranchId, portion.batch_number, portion.expiry_date]
    );
    let destBatchId;
    if (existingBatch.rows.length > 0) {
      destBatchId = existingBatch.rows[0].id;
      await client.query(
        `UPDATE inventory_batches SET remaining_quantity = remaining_quantity + $1, original_quantity = original_quantity + $1 WHERE id = $2`,
        [take, destBatchId]
      );
    } else {
      const created = await client.query(
        `INSERT INTO inventory_batches
          (batch_number, inventory_item_id, branch_id, received_date, production_date, expiry_date,
           original_quantity, remaining_quantity, unit_cost, created_by)
         VALUES ($1,$2,$3,CURRENT_DATE,$4,$5,$6,$6,$7,$8) RETURNING id`,
        [portion.batch_number, inventoryItemId, toBranchId, portion.production_date, portion.expiry_date,
         take, portion.unit_cost, userId]
      );
      destBatchId = created.rows[0].id;
    }

    await postInventoryMovement(client, {
      branchId: toBranchId, inventoryItemId, quantity: take,
      movementType: "TRANSFER_IN", referenceType: "kitchen_transfer", referenceId: transferId,
      unitCost: portion.unit_cost, batchId: destBatchId, userId, businessDate,
      skipBatchConsumption: true, negativeStockOverrideApproved: true,
    });
  }
  // لو وصل أكتر من إجمالي اللي كان مسجّل بالدفعات (نادر، خطأ إدخال مثلًا) - الباقي بيتسجل كحركة عادية
  // من غير دفعة محددة، عشان مفيش كمية "تختفي" من السجل
  if (remaining > 0) {
    await postInventoryMovement(client, {
      branchId: toBranchId, inventoryItemId, quantity: remaining,
      movementType: "TRANSFER_IN", referenceType: "kitchen_transfer", referenceId: transferId,
      userId, businessDate, negativeStockOverrideApproved: true,
    });
  }
}

// المرحلة 6 (تدقيق الجاهزية للإنتاج - قرار معماري): التحويل بين الفروع كان قبل كده بيحرّك المخزون الفعلي
// من غير أي قيد محاسبي خالص - رصيد المخزون (1400) في دفتر الأستاذ لفرع المصدر ميقلّش ولفرع الوجهة
// ميزيدش، فالتسوية على مستوى الفرع الواحد بعد أي تحويل كانت بتظهر فرق حقيقي غير مبرر (اتأكد فعليًا في
// تدقيق المرحلة 5). القرار: قيد واحد بيترحّل وقت الاستلام (/receive) مش وقت الإصدار (/issue) - عشان
// الاستلام هو أول لحظة الكمية اللي وصلت فعليًا بقت معروفة بالتأكيد (زي استلام البضاعة GRN بالظبط -
// القيد بيترحّل وقت /post مش وقت إنشاء الطلب). القيد: دائن 1400 فرع المصدر بقيمة اللي *خرج فعليًا*
// (TRANSFER_OUT، بتكلفته التاريخية من الدفعة) / مدين 1400 فرع الوجهة بقيمة اللي *وصل فعليًا*
// (TRANSFER_IN) / أي فرق بينهم (عجز/زيادة نقل) بيتحمّل كخسارة على 5300 (هالك) بفرع المصدر - بالظبط
// زي فلسفة الهالك الموجودة بالفعل، مش حساب جديد مخترع. صافي الأثر على الشركة كلها صفر دايمًا - القيد
// بيوزّع نفس القيمة بين فرعين، مش بيخلق ربح أو خسارة من نقل داخلي (إلا عجز النقل الفعلي لو حصل)
async function postTransferAccounting(client, { transferId, fromBranchId, toBranchId, userId, businessDate }) {
  const totals = await client.query(
    `SELECT branch_id, movement_type, COALESCE(SUM(total_cost), 0) AS value
     FROM inventory_movements
     WHERE reference_type = 'kitchen_transfer' AND reference_id = $1
       AND movement_type IN ('TRANSFER_OUT', 'TRANSFER_IN')
     GROUP BY branch_id, movement_type`,
    [transferId]
  );
  const issuedValue = totals.rows.filter((r) => r.movement_type === "TRANSFER_OUT")
    .reduce((s, r) => s + Number(r.value), 0);
  const receivedValue = totals.rows.filter((r) => r.movement_type === "TRANSFER_IN")
    .reduce((s, r) => s + Number(r.value), 0);

  const issuedCents = Math.round(issuedValue * 100);
  const receivedCents = Math.round(receivedValue * 100);
  if (issuedCents === 0 && receivedCents === 0) return null; // مفيش قيمة تكلفة أصلًا - مفيش قيد يتسجل

  const inv1400 = await getAccountByCode(client, "1400");
  const waste5300 = await getAccountByCode(client, "5300");
  const lines = [
    { accountId: inv1400.id, branchId: fromBranchId, credit: issuedCents / 100, description: `تحويل مخزون خارج - تحويل #${transferId}` },
    { accountId: inv1400.id, branchId: toBranchId, debit: receivedCents / 100, description: `تحويل مخزون وارد - تحويل #${transferId}` },
  ];
  const varianceCents = issuedCents - receivedCents;
  if (varianceCents > 0) {
    lines.push({ accountId: waste5300.id, branchId: fromBranchId, debit: varianceCents / 100, description: `عجز نقل - تحويل #${transferId}` });
  } else if (varianceCents < 0) {
    lines.push({ accountId: waste5300.id, branchId: toBranchId, credit: (-varianceCents) / 100, description: `زيادة نقل غير مفسّرة - تحويل #${transferId}` });
  }

  const result = await postJournalEntry(client, {
    entryDate: businessDate, description: `تحويل مخزون بين الفروع - تحويل #${transferId}`,
    sourceType: "kitchen_transfer", sourceId: transferId, lines, userId, autoPost: true,
    idempotencyKey: `kitchen-transfer-${transferId}`,
  });
  return result;
}

// GET /api/kitchen-transfers?branchId=&date= - تحويلات سنتر كيتشن للفروع (مع تفاصيل الأصناف)
router.get(
  "/",
  requireAuth,
  requireRole("admin", "accountant", "branch_manager"),
  async (req, res) => {
    let { branchId, date } = req.query;
    if (req.user.role === "branch_manager") {
      if (branchId && !assertOwnBranch(req.user, branchId)) {
        return res.status(403).json({ error: "معندكش صلاحية تشوف تحويلات فرع تاني" });
      }
      branchId = req.user.branchId;
    }
    try {
      const transfers = await pool.query(
        `SELECT kt.*, b.name AS to_branch_name
         FROM kitchen_transfers kt
         JOIN branches b ON b.id = kt.to_branch_id
         WHERE ($1::int IS NULL OR kt.to_branch_id = $1)
           AND ($2::date IS NULL OR kt.business_date = $2)
         ORDER BY kt.business_date DESC, kt.id DESC`,
        [branchId || null, date || null]
      );
      const transferIds = transfers.rows.map((t) => t.id);
      const items = transferIds.length
        ? (await pool.query(
            `SELECT kti.kitchen_transfer_id, kti.inventory_item_id, kti.quantity, ii.name, ii.unit
             FROM kitchen_transfer_items kti
             JOIN inventory_items ii ON ii.id = kti.inventory_item_id
             WHERE kti.kitchen_transfer_id = ANY($1)`,
            [transferIds]
          )).rows
        : [];
      const result = transfers.rows.map((t) => ({
        ...t,
        items: items.filter((it) => it.kitchen_transfer_id === t.id),
      }));
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

// POST /api/kitchen-transfers - سنتر كيتشن بيبعت بضاعة بالتكلفة لفرع (مبلغ إجمالي بس، من غير تفصيل أصناف) - أدمن بس
router.post("/", requireAuth, requireRole("admin"), async (req, res) => {
  const { toBranchId, businessDate, amountAtCost, notes } = req.body;
  if (!toBranchId || !businessDate || !amountAtCost) {
    return res.status(400).json({ error: "بيانات ناقصة" });
  }
  try {
    const result = await pool.query(
      `INSERT INTO kitchen_transfers (to_branch_id, business_date, amount_at_cost, notes)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [toBranchId, businessDate, amountAtCost, notes || null]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/kitchen-transfers/itemized - تحويل فوري بأصناف وكميات محددة (إصدار واستلام في نفس اللحظة،
// من غير مراحل وسيطة). **أدمن بس** - ده استثناء يتخطى دورة الاعتماد الكاملة (request→approve→issue→
// receive) بالكامل، فمقفول على الأدمن عشان مفيش موظف تشغيلي (مدير فرع/كاشير) يقدر يستخدمه يتخطى بيه
// الموافقة. أي حد تاني (مدير فرع بما فيهم مدير السنتر كيتشن) لازم يستخدم /request → /approve → /issue
// → /receive تحت. لو مربوط بطلبية فرع بيقفلها "fulfilled"
// {fromBranchId, toBranchId, businessDate, items: [{inventoryItemId, quantity}], kitchenOrderId, notes}
router.post("/itemized", requireAuth, requireRole("admin"), async (req, res) => {
  const { fromBranchId, toBranchId, businessDate, items, kitchenOrderId, notes } = req.body;
  if (!fromBranchId || !toBranchId || !businessDate || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: "بيانات ناقصة" });
  }

  const client = await pool.connect();
  try {
    const branchCheck = await client.query("SELECT is_central_kitchen FROM branches WHERE id = $1", [fromBranchId]);
    if (branchCheck.rows.length === 0 || !branchCheck.rows[0].is_central_kitchen) {
      return res.status(400).json({ error: "التحويل المفصّل ده بيتم بس من فرع السنتر كيتشن" });
    }

    const itemIds = items.map((it) => it.inventoryItemId);
    const costRows = await client.query(
      "SELECT id, COALESCE(unit_cost, 0) AS unit_cost FROM inventory_items WHERE id = ANY($1)",
      [itemIds]
    );
    const costByItem = new Map(costRows.rows.map((r) => [r.id, Number(r.unit_cost)]));
    const amountAtCost = items.reduce(
      (sum, it) => sum + (costByItem.get(it.inventoryItemId) || 0) * it.quantity,
      0
    );

    await client.query("BEGIN");

    const transferResult = await client.query(
      `INSERT INTO kitchen_transfers (from_branch_id, to_branch_id, business_date, amount_at_cost, notes, kitchen_order_id, status, issued_by, received_by, issued_at, received_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'completed', $7, $7, now(), now()) RETURNING id`,
      [fromBranchId, toBranchId, businessDate, amountAtCost, notes || null, kitchenOrderId || null, req.user.id]
    );
    const transferId = transferResult.rows[0].id;

    for (const it of items) {
      const inserted = await client.query(
        `INSERT INTO kitchen_transfer_items (kitchen_transfer_id, inventory_item_id, quantity, quantity_sent, quantity_received)
         VALUES ($1, $2, $3, $3, $3) RETURNING id`,
        [transferId, it.inventoryItemId, it.quantity]
      );
      const kitchenTransferItemId = inserted.rows[0].id;
      await issueTransferItem(client, {
        kitchenTransferItemId, fromBranchId, inventoryItemId: it.inventoryItemId, quantity: it.quantity,
        transferId, userId: req.user.id, businessDate, notes,
      });
      await receiveTransferItem(client, {
        kitchenTransferItemId, toBranchId, inventoryItemId: it.inventoryItemId, quantityReceived: it.quantity,
        transferId, userId: req.user.id, businessDate,
      });
    }

    if (kitchenOrderId) {
      await syncLinkedKitchenOrder(client, kitchenOrderId, { newWorkflowStatus: "RECEIVED", legacyStatus: "fulfilled" });
    }

    await logAudit(client, {
      branchId: toBranchId, userId: req.user.id, action: "TRANSFER_COMPLETED", entityType: "kitchen_transfer", entityId: transferId,
      newValues: { fromBranchId, toBranchId, items }, req,
    });

    await client.query("COMMIT");
    res.status(201).json({ transferId, amountAtCost });
  } catch (err) {
    await client.query("ROLLBACK");
    if (err.code === "INSUFFICIENT_STOCK") return res.status(400).json({ error: err.message });
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ================= التحويل المرحلي (Staged Transfer Workflow) - المسار التشغيلي الأساسي =================
// requested → approved → issued (بينزل من مخزون المصدر) → in_transit → partially_received/received
// (بيزود مخزون الوجهة على قد اللي وصل فعلًا، مش المُرسل بالضرورة - الفرق (variance) بيتسجل صراحة)

// POST /api/kitchen-transfers/request - طلب تحويل (بيسجل بس، لسه ملوش أي أثر على المخزون)
// kitchenOrderId اختياري - لو التحويل ده تنفيذ لطلبية فرع، بتتقفل "fulfilled" تلقائيًا وقت الاستلام
// (مش وقت الطلب - الطلبية تفضل pending لحد ما البضاعة توصل فعليًا للفرع الطالب)
router.post("/request", requireAuth, requireRole("admin", "branch_manager"), async (req, res) => {
  const { fromBranchId, toBranchId, businessDate, items, notes, kitchenOrderId } = req.body;
  if (!fromBranchId || !toBranchId || !businessDate || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: "بيانات ناقصة" });
  }
  if (!assertOwnBranch(req.user, toBranchId) && !assertOwnBranch(req.user, fromBranchId)) {
    return res.status(403).json({ error: "معندكش صلاحية تطلب تحويل بين الفروع دي" });
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const transferResult = await client.query(
      `INSERT INTO kitchen_transfers (from_branch_id, to_branch_id, business_date, amount_at_cost, notes, status, requested_by, kitchen_order_id)
       VALUES ($1,$2,$3,0,$4,'requested',$5,$6) RETURNING *`,
      [fromBranchId, toBranchId, businessDate, notes || null, req.user.id, kitchenOrderId || null]
    );
    const transferId = transferResult.rows[0].id;
    for (const it of items) {
      await client.query(
        `INSERT INTO kitchen_transfer_items (kitchen_transfer_id, inventory_item_id, quantity) VALUES ($1,$2,$3)`,
        [transferId, it.inventoryItemId, it.quantity]
      );
    }
    await logAudit(client, {
      branchId: fromBranchId, userId: req.user.id, action: "TRANSFER_REQUESTED", entityType: "kitchen_transfer", entityId: transferId,
      newValues: { fromBranchId, toBranchId, items }, req,
    });
    await client.query("COMMIT");
    res.status(201).json(transferResult.rows[0]);
  } catch (err) {
    await client.query("ROLLBACK");
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// POST /api/kitchen-transfers/:id/approve - **أدمن بس**. مش مدير فرع، حتى لو مدير فرع مالك الطلب نفسه -
// الاعتماد لازم يكون من طرف مستقل (أدمن) عشان مايبقاش نفس الشخص طالب ومعتمد لنفس التحويل
router.post("/:id/approve", requireAuth, requireRole("admin"), async (req, res) => {
  try {
    const existing = await pool.query("SELECT * FROM kitchen_transfers WHERE id = $1", [req.params.id]);
    if (existing.rows.length === 0) return res.status(404).json({ error: "التحويل مش موجود" });
    const t = existing.rows[0];
    if (t.status !== "requested") return res.status(400).json({ error: "التحويل ده مش في حالة قابلة للاعتماد" });
    const result = await pool.query(
      `UPDATE kitchen_transfers SET status = 'approved', approved_by = $1, approved_at = now() WHERE id = $2 RETURNING *`,
      [req.user.id, t.id]
    );
    await logAudit(pool, {
      branchId: t.from_branch_id, userId: req.user.id, action: "TRANSFER_APPROVED", entityType: "kitchen_transfer", entityId: t.id, req,
    });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/kitchen-transfers/:id/issue - بينزل الكمية فعليًا من مخزون فرع المصدر (لسه معدلش مخزون الوجهة)
// - بيحافظ على هوية الدفعة (لو الصنف متتبّع بدفعات) عشان تتنقل صح وقت الاستلام
// المرحلة 5: BEGIN + FOR UPDATE من أول السطر (مش بعد التحقق) - عشان طلبات /issue متزامنة لنفس التحويل
// متعدّيش شرط status==='approved' مع بعض قبل أي واحد يعمل commit (اتأكد فعليًا إن ده كان بيحصل، بيسبب
// خصم مضاعف من مخزون فرع المصدر، في tests/phase5-integration.test.js)
router.post("/:id/issue", requireAuth, stockManagers, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const existing = await client.query("SELECT * FROM kitchen_transfers WHERE id = $1 FOR UPDATE", [req.params.id]);
    if (existing.rows.length === 0) { await client.query("ROLLBACK"); return res.status(404).json({ error: "التحويل مش موجود" }); }
    const t = existing.rows[0];
    if (t.status !== "approved") { await client.query("ROLLBACK"); return res.status(400).json({ error: "التحويل ده مش في حالة قابلة للإصدار" }); }
    if (!assertOwnBranch(req.user, t.from_branch_id)) {
      await client.query("ROLLBACK");
      return res.status(403).json({ error: "معندكش صلاحية تصدّر من الفرع ده" });
    }
    const items = await client.query("SELECT * FROM kitchen_transfer_items WHERE kitchen_transfer_id = $1", [t.id]);

    for (const it of items.rows) {
      await issueTransferItem(client, {
        kitchenTransferItemId: it.id, fromBranchId: t.from_branch_id, inventoryItemId: it.inventory_item_id,
        quantity: it.quantity, transferId: t.id, userId: req.user.id, businessDate: t.business_date,
      });
      await client.query("UPDATE kitchen_transfer_items SET quantity_sent = $1 WHERE id = $2", [it.quantity, it.id]);
    }
    const updated = await client.query(
      `UPDATE kitchen_transfers SET status = 'in_transit', issued_by = $1, issued_at = now() WHERE id = $2 RETURNING *`,
      [req.user.id, t.id]
    );
    if (t.kitchen_order_id) {
      await syncLinkedKitchenOrder(client, t.kitchen_order_id, { newWorkflowStatus: "IN_TRANSIT", legacyStatus: "pending" });
    }
    await logAudit(client, {
      branchId: t.from_branch_id, userId: req.user.id, action: "TRANSFER_ISSUED", entityType: "kitchen_transfer", entityId: t.id, req,
    });
    await client.query("COMMIT");
    res.json(updated.rows[0]);
  } catch (err) {
    await client.query("ROLLBACK");
    if (err.code === "INSUFFICIENT_STOCK") return res.status(400).json({ error: err.message });
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// POST /api/kitchen-transfers/:id/receive - بيزود مخزون فرع الوجهة على قد اللي فعلًا وصل (مش المُرسل
// بالضرورة) - بنفس هوية الدفعة (لو موجودة) بدل ما تتحول لرصيد عام مجهول المصدر
// {items: [{inventoryItemId, quantityReceived}]} - أي فرق عن quantity_sent بيتسجل كـvariance صراحة، مايختفيش
router.post("/:id/receive", requireAuth, stockManagers, async (req, res) => {
  const { items: receivedItems } = req.body;
  if (!Array.isArray(receivedItems) || receivedItems.length === 0) {
    return res.status(400).json({ error: "لازم تحدد الكميات المستلمة" });
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const existing = await client.query("SELECT * FROM kitchen_transfers WHERE id = $1 FOR UPDATE", [req.params.id]);
    if (existing.rows.length === 0) { await client.query("ROLLBACK"); return res.status(404).json({ error: "التحويل مش موجود" }); }
    const t = existing.rows[0];
    if (t.status !== "in_transit") { await client.query("ROLLBACK"); return res.status(400).json({ error: "التحويل ده مش في حالة قابلة للاستلام" }); }
    if (!assertOwnBranch(req.user, t.to_branch_id)) {
      await client.query("ROLLBACK");
      return res.status(403).json({ error: "معندكش صلاحية تستلم في الفرع ده" });
    }
    const items = await client.query("SELECT * FROM kitchen_transfer_items WHERE kitchen_transfer_id = $1", [t.id]);
    const receivedByItem = new Map(receivedItems.map((r) => [r.inventoryItemId, Number(r.quantityReceived)]));

    let anyVariance = false;
    for (const it of items.rows) {
      const qtyReceived = receivedByItem.get(it.inventory_item_id) ?? Number(it.quantity_sent ?? it.quantity);
      if (qtyReceived !== Number(it.quantity_sent ?? it.quantity)) anyVariance = true;
      await receiveTransferItem(client, {
        kitchenTransferItemId: it.id, toBranchId: t.to_branch_id, inventoryItemId: it.inventory_item_id,
        quantityReceived: qtyReceived, transferId: t.id, userId: req.user.id, businessDate: t.business_date,
      });
      await client.query("UPDATE kitchen_transfer_items SET quantity_received = $1 WHERE id = $2", [qtyReceived, it.id]);
    }
    const newStatus = anyVariance ? "partially_received" : "received";
    const accountingResult = await postTransferAccounting(client, {
      transferId: t.id, fromBranchId: t.from_branch_id, toBranchId: t.to_branch_id,
      userId: req.user.id, businessDate: t.business_date,
    });
    const updated = await client.query(
      `UPDATE kitchen_transfers SET status = $1, received_by = $2, received_at = now(), journal_entry_id = $3 WHERE id = $4 RETURNING *`,
      [newStatus, req.user.id, accountingResult ? accountingResult.entry.id : null, t.id]
    );
    if (t.kitchen_order_id) {
      await syncLinkedKitchenOrder(client, t.kitchen_order_id, { newWorkflowStatus: "RECEIVED", legacyStatus: "fulfilled" });
    }
    await logAudit(client, {
      branchId: t.to_branch_id, userId: req.user.id, action: "TRANSFER_RECEIVED", entityType: "kitchen_transfer", entityId: t.id,
      metadata: { variance: anyVariance }, req,
    });
    await client.query("COMMIT");
    res.json(updated.rows[0]);
  } catch (err) {
    await client.query("ROLLBACK");
    if (err.code === "INSUFFICIENT_STOCK") return res.status(400).json({ error: err.message });
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ================= Procurement v2 STEP G: فروقات الاستلام (Transfer Discrepancies) =================
// بعد ما التحويل يتستلم (received/partially_received)، السجل الأصلي (kitchen_transfer_items.quantity_received)
// بيفضل ثابت للأبد - أي فرق يتكتشف بعدين (نقص/تلف/صنف غلط/كمية غلط/منتهي/تاني) بيتسجل هنا كسطر مستقل
// بنوعه، وأي تصحيح فعلي للمخزون/المحاسبة بيعدّي من هنا بس (POST .../resolve) - مش UPDATE مباشر على
// كمية الاستلام التاريخية أبدًا
const DISCREPANCY_TYPE_TO_MOVEMENT = {
  SHORTAGE: "ADJUSTMENT", WRONG_ITEM: "ADJUSTMENT", WRONG_QUANTITY: "ADJUSTMENT", OTHER: "ADJUSTMENT",
  DAMAGED: "WASTE", EXPIRED: "EXPIRY",
};

// POST /api/kitchen-transfers/:id/discrepancies - الفرع المستلم (أو الأدمن) بيسجّل فرق/أكتر - التحويل
// لازم يكون received أو partially_received بالفعل (بعد الاستلام بس، مش قبله)
// {items: [{kitchenTransferItemId, inventoryItemId, discrepancyType, quantity, unit?, notes?, evidenceUrls?}]}
router.post("/:id/discrepancies", requireAuth, stockManagers, async (req, res) => {
  const { items } = req.body;
  if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: "لازم فرق واحد على الأقل" });
  try {
    const existing = await pool.query("SELECT * FROM kitchen_transfers WHERE id = $1", [req.params.id]);
    if (existing.rows.length === 0) return res.status(404).json({ error: "التحويل مش موجود" });
    const t = existing.rows[0];
    if (!["received", "partially_received"].includes(t.status)) {
      return res.status(400).json({ error: "تسجيل الفروقات متاح بس بعد استلام التحويل" });
    }
    if (!assertOwnBranch(req.user, t.to_branch_id)) {
      return res.status(403).json({ error: "معندكش صلاحية تسجل فروقات على استلام فرع تاني" });
    }
    const inserted = [];
    for (const it of items) {
      if (!DISCREPANCY_TYPE_TO_MOVEMENT[it.discrepancyType]) {
        return res.status(400).json({ error: `نوع فرق غير معروف: ${it.discrepancyType}` });
      }
      if (!it.quantity || Number(it.quantity) <= 0) {
        return res.status(400).json({ error: "كمية الفرق لازم تكون أكبر من صفر" });
      }
      const row = await pool.query(
        `INSERT INTO transfer_discrepancies
          (kitchen_transfer_id, kitchen_transfer_item_id, inventory_item_id, discrepancy_type, quantity, unit,
           notes, evidence_urls, reported_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [t.id, it.kitchenTransferItemId || null, it.inventoryItemId, it.discrepancyType, it.quantity,
         it.unit || null, it.notes || null, it.evidenceUrls || null, req.user.id]
      );
      inserted.push(row.rows[0]);
    }
    await logAudit(pool, {
      branchId: t.to_branch_id, userId: req.user.id, action: "TRANSFER_DISCREPANCY_REPORTED",
      entityType: "kitchen_transfer", entityId: t.id, metadata: { count: inserted.length }, req,
    });
    res.status(201).json(inserted);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// GET /api/kitchen-transfers/:id/discrepancies - الفرعين المعنيين (مصدر/وجهة) أو الأدمن
router.get("/:id/discrepancies", requireAuth, stockManagers, async (req, res) => {
  try {
    const existing = await pool.query("SELECT from_branch_id, to_branch_id FROM kitchen_transfers WHERE id = $1", [req.params.id]);
    if (existing.rows.length === 0) return res.status(404).json({ error: "التحويل مش موجود" });
    const t = existing.rows[0];
    if (!assertOwnBranch(req.user, t.to_branch_id) && !assertOwnBranch(req.user, t.from_branch_id)) {
      return res.status(403).json({ error: "معندكش صلاحية تشوف فروقات التحويل ده" });
    }
    const result = await pool.query(
      `SELECT td.*, ii.name AS item_name
       FROM transfer_discrepancies td JOIN inventory_items ii ON ii.id = td.inventory_item_id
       WHERE td.kitchen_transfer_id = $1 ORDER BY td.id`,
      [req.params.id]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/kitchen-transfers/:id/discrepancies/:discrepancyId/resolve - مراجعة الفرق - {action: 'ACKNOWLEDGE'
// | 'RESOLVE' | 'REJECT', resolutionNotes?, postAdjustment?} - RESOLVE بس (postAdjustment !== false) هي
// اللحظة اللي بتصحح المخزون فعليًا: حركة سالبة بالكمية المتنازع عليها (كانت اتسجلت زيادة وقت /receive)
// + قيد هالك/تسوية (5300/1400) بنفس تكلفة الحركة الحقيقية - آمنة التكرار (idempotencyKey)
router.post("/:id/discrepancies/:discrepancyId/resolve", requireAuth, requireRole("admin", "branch_manager", "accountant"), async (req, res) => {
  const { action, resolutionNotes, postAdjustment } = req.body;
  if (!["ACKNOWLEDGE", "RESOLVE", "REJECT"].includes(action)) {
    return res.status(400).json({ error: "action لازم يكون ACKNOWLEDGE أو RESOLVE أو REJECT" });
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const discRes = await client.query(
      "SELECT * FROM transfer_discrepancies WHERE id = $1 AND kitchen_transfer_id = $2 FOR UPDATE",
      [req.params.discrepancyId, req.params.id]
    );
    if (discRes.rows.length === 0) { await client.query("ROLLBACK"); return res.status(404).json({ error: "الفرق مش موجود" }); }
    const disc = discRes.rows[0];
    if (disc.status !== "OPEN" && disc.status !== "ACKNOWLEDGED") {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "الفرق ده اتراجع بالفعل (RESOLVED أو REJECTED)" });
    }
    const transferRes = await client.query("SELECT to_branch_id, business_date FROM kitchen_transfers WHERE id = $1", [req.params.id]);
    const toBranchId = transferRes.rows[0].to_branch_id;
    if (req.user.role === "branch_manager" && !assertOwnBranch(req.user, toBranchId)) {
      await client.query("ROLLBACK");
      return res.status(403).json({ error: "معندكش صلاحية تراجع فروقات فرع تاني" });
    }

    let journalEntryId = null;
    if (action === "RESOLVE" && postAdjustment !== false) {
      const { movement, duplicate } = await postInventoryMovement(client, {
        branchId: toBranchId, inventoryItemId: disc.inventory_item_id, quantity: -Number(disc.quantity),
        movementType: DISCREPANCY_TYPE_TO_MOVEMENT[disc.discrepancy_type],
        reason: disc.discrepancy_type, referenceType: "discrepancy", referenceId: disc.id,
        notes: disc.notes, businessDate: transferRes.rows[0].business_date, userId: req.user.id,
        idempotencyKey: `discrepancy-adjustment-${disc.id}`, negativeStockOverrideApproved: true,
      });
      if (!duplicate && movement.total_cost != null && Number(movement.total_cost) > 0) {
        const wasteAccount = await getAccountByCode(client, "5300");
        const inventoryAccount = await getAccountByCode(client, "1400");
        const je = await postJournalEntry(client, {
          entryDate: new Date().toISOString().slice(0, 10),
          description: `فرق استلام #${disc.id} (${disc.discrepancy_type}) - تحويل #${req.params.id}`,
          sourceType: "transfer_discrepancy", sourceId: disc.id, branchId: toBranchId,
          lines: [
            { accountId: wasteAccount.id, debit: Number(movement.total_cost) },
            { accountId: inventoryAccount.id, credit: Number(movement.total_cost) },
          ],
          idempotencyKey: `discrepancy-adjustment-${disc.id}`, userId: req.user.id,
        });
        journalEntryId = je.entry.id;
      }
    }

    const newStatus = action === "RESOLVE" ? "RESOLVED" : action === "REJECT" ? "REJECTED" : "ACKNOWLEDGED";
    const updated = await client.query(
      `UPDATE transfer_discrepancies SET status = $1, resolution_notes = $2, adjustment_journal_entry_id = COALESCE($3, adjustment_journal_entry_id),
              resolved_by = $4, resolved_at = now()
       WHERE id = $5 RETURNING *`,
      [newStatus, resolutionNotes || null, journalEntryId, req.user.id, disc.id]
    );
    await logAudit(client, {
      branchId: toBranchId, userId: req.user.id, action: "TRANSFER_DISCREPANCY_" + newStatus,
      entityType: "transfer_discrepancy", entityId: disc.id, metadata: { journalEntryId }, req,
    });
    await client.query("COMMIT");
    res.json(updated.rows[0]);
  } catch (err) {
    await client.query("ROLLBACK");
    res.status(400).json({ error: err.message });
  } finally {
    client.release();
  }
});

module.exports = router;
