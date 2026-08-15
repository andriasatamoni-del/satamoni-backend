const express = require("express");
const router = express.Router();
const pool = require("../db/pool");
const { requireAuth, requireRole, assertOwnBranch } = require("../middleware/auth");
const { postInventoryMovement } = require("../db/inventory-ledger");
const { logAudit } = require("../db/audit");

const stockManagers = requireRole("admin", "branch_manager");

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

// POST /api/kitchen-transfers/itemized - تحويل فعلي بأصناف وكميات محددة (بينزل من مخزون السنتر كيتشن
// ويزود مخزون الفرع المستقبِل تلقائيًا)، ولو مربوط بطلبية فرع بيقفلها "fulfilled"
// {fromBranchId, toBranchId, businessDate, items: [{inventoryItemId, quantity}], kitchenOrderId, notes}
router.post("/itemized", requireAuth, requireRole("admin", "branch_manager"), async (req, res) => {
  const { fromBranchId, toBranchId, businessDate, items, kitchenOrderId, notes } = req.body;
  if (!fromBranchId || !toBranchId || !businessDate || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: "بيانات ناقصة" });
  }
  if (!assertOwnBranch(req.user, fromBranchId)) {
    return res.status(403).json({ error: "معندكش صلاحية تحوّل من الفرع/السنتر كيتشن ده" });
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

    // التحويل الفوري ده (زي ما كان دايمًا) بيسجل بحالة completed على طول - إصدار واستلام في نفس اللحظة،
    // من غير مراحل وسيطة. لو حابب مراحل حقيقية (طلب→اعتماد→إصدار→استلام مع استلام جزئي) استخدم
    // /request و/:id/issue و/:id/receive تحت
    const transferResult = await client.query(
      `INSERT INTO kitchen_transfers (from_branch_id, to_branch_id, business_date, amount_at_cost, notes, kitchen_order_id, status, issued_by, received_by, issued_at, received_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'completed', $7, $7, now(), now()) RETURNING id`,
      [fromBranchId, toBranchId, businessDate, amountAtCost, notes || null, kitchenOrderId || null, req.user.id]
    );
    const transferId = transferResult.rows[0].id;

    for (const it of items) {
      await client.query(
        `INSERT INTO kitchen_transfer_items (kitchen_transfer_id, inventory_item_id, quantity, quantity_sent, quantity_received)
         VALUES ($1, $2, $3, $3, $3)`,
        [transferId, it.inventoryItemId, it.quantity]
      );

      // ينزل من مخزون السنتر كيتشن
      await postInventoryMovement(client, {
        branchId: fromBranchId, inventoryItemId: it.inventoryItemId, quantity: -Number(it.quantity),
        movementType: "TRANSFER_OUT", referenceType: "kitchen_transfer", referenceId: transferId,
        notes: notes || null, userId: req.user.id, businessDate,
      });
      // بيزود مخزون الفرع المستقبِل
      await postInventoryMovement(client, {
        branchId: toBranchId, inventoryItemId: it.inventoryItemId, quantity: Number(it.quantity),
        movementType: "TRANSFER_IN", referenceType: "kitchen_transfer", referenceId: transferId,
        notes: notes || null, userId: req.user.id, businessDate,
      });
    }

    if (kitchenOrderId) {
      await client.query("UPDATE kitchen_orders SET status = 'fulfilled' WHERE id = $1", [kitchenOrderId]);
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

// ================= التحويل المرحلي (Staged Transfer Workflow) - إضافة اختيارية جديدة =================
// إضافي فوق /itemized اللي فوق (لسه شغال زي ما هو للتحويل الفوري) - ده لمن يحتاج دورة حياة حقيقية:
// requested → approved → issued (بينزل من مخزون المصدر) → partially_received/received (بيزود مخزون
// الوجهة على قد اللي وصل فعلًا، مش المُرسل بالضرورة - الفرق (variance) بيتسجل صراحة، مايتفقدش)

// POST /api/kitchen-transfers/request - طلب تحويل (بيسجل بس، لسه ملوش أي أثر على المخزون)
router.post("/request", requireAuth, requireRole("admin", "branch_manager"), async (req, res) => {
  const { fromBranchId, toBranchId, businessDate, items, notes } = req.body;
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
      `INSERT INTO kitchen_transfers (from_branch_id, to_branch_id, business_date, amount_at_cost, notes, status, requested_by)
       VALUES ($1,$2,$3,0,$4,'requested',$5) RETURNING *`,
      [fromBranchId, toBranchId, businessDate, notes || null, req.user.id]
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

// POST /api/kitchen-transfers/:id/approve
router.post("/:id/approve", requireAuth, stockManagers, async (req, res) => {
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
router.post("/:id/issue", requireAuth, stockManagers, async (req, res) => {
  const client = await pool.connect();
  try {
    const existing = await client.query("SELECT * FROM kitchen_transfers WHERE id = $1", [req.params.id]);
    if (existing.rows.length === 0) return res.status(404).json({ error: "التحويل مش موجود" });
    const t = existing.rows[0];
    if (t.status !== "approved") return res.status(400).json({ error: "التحويل ده مش في حالة قابلة للإصدار" });
    if (!assertOwnBranch(req.user, t.from_branch_id)) {
      return res.status(403).json({ error: "معندكش صلاحية تصدّر من الفرع ده" });
    }
    const items = await client.query("SELECT * FROM kitchen_transfer_items WHERE kitchen_transfer_id = $1", [t.id]);

    await client.query("BEGIN");
    for (const it of items.rows) {
      await postInventoryMovement(client, {
        branchId: t.from_branch_id, inventoryItemId: it.inventory_item_id, quantity: -Number(it.quantity),
        movementType: "TRANSFER_OUT", referenceType: "kitchen_transfer", referenceId: t.id,
        userId: req.user.id, businessDate: t.business_date,
      });
      await client.query("UPDATE kitchen_transfer_items SET quantity_sent = $1 WHERE id = $2", [it.quantity, it.id]);
    }
    const updated = await client.query(
      `UPDATE kitchen_transfers SET status = 'in_transit', issued_by = $1, issued_at = now() WHERE id = $2 RETURNING *`,
      [req.user.id, t.id]
    );
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

// POST /api/kitchen-transfers/:id/receive - بيزود مخزون فرع الوجهة على قد اللي فعلًا وصل (مش المُرسل بالضرورة)
// {items: [{inventoryItemId, quantityReceived}]} - أي فرق عن quantity_sent بيتسجل كـvariance صراحة، مايختفيش
router.post("/:id/receive", requireAuth, stockManagers, async (req, res) => {
  const { items: receivedItems } = req.body;
  if (!Array.isArray(receivedItems) || receivedItems.length === 0) {
    return res.status(400).json({ error: "لازم تحدد الكميات المستلمة" });
  }
  const client = await pool.connect();
  try {
    const existing = await client.query("SELECT * FROM kitchen_transfers WHERE id = $1", [req.params.id]);
    if (existing.rows.length === 0) return res.status(404).json({ error: "التحويل مش موجود" });
    const t = existing.rows[0];
    if (t.status !== "in_transit") return res.status(400).json({ error: "التحويل ده مش في حالة قابلة للاستلام" });
    if (!assertOwnBranch(req.user, t.to_branch_id)) {
      return res.status(403).json({ error: "معندكش صلاحية تستلم في الفرع ده" });
    }
    const items = await client.query("SELECT * FROM kitchen_transfer_items WHERE kitchen_transfer_id = $1", [t.id]);
    const receivedByItem = new Map(receivedItems.map((r) => [r.inventoryItemId, Number(r.quantityReceived)]));

    await client.query("BEGIN");
    let anyVariance = false;
    for (const it of items.rows) {
      const qtyReceived = receivedByItem.get(it.inventory_item_id) ?? Number(it.quantity_sent ?? it.quantity);
      if (qtyReceived !== Number(it.quantity_sent ?? it.quantity)) anyVariance = true;
      if (qtyReceived > 0) {
        await postInventoryMovement(client, {
          branchId: t.to_branch_id, inventoryItemId: it.inventory_item_id, quantity: qtyReceived,
          movementType: "TRANSFER_IN", referenceType: "kitchen_transfer", referenceId: t.id,
          userId: req.user.id, businessDate: t.business_date,
        });
      }
      await client.query("UPDATE kitchen_transfer_items SET quantity_received = $1 WHERE id = $2", [qtyReceived, it.id]);
    }
    const newStatus = anyVariance ? "partially_received" : "received";
    const updated = await client.query(
      `UPDATE kitchen_transfers SET status = $1, received_by = $2, received_at = now() WHERE id = $3 RETURNING *`,
      [newStatus, req.user.id, t.id]
    );
    if (t.kitchen_order_id) {
      await client.query("UPDATE kitchen_orders SET status = 'fulfilled' WHERE id = $1", [t.kitchen_order_id]);
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

module.exports = router;
