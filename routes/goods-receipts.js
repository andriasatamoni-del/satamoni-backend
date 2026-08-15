// المرحلة 4A: سند استلام بضاعة (GRN) - منفصل تمامًا عن إنشاء الـPO. إنشاء GRN (DRAFT) مجرد تسجيل نية/
// مسودة استلام؛ /post هو اللحظة الوحيدة اللي بتلمس المخزون فعليًا، وبتعدّي حصريًا من db/inventory-ledger.js
// (postInventoryMovement) - زي أي حركة تانية في النظام، من غير أي استثناء أو تحديث مباشر على الرصيد.
const express = require("express");
const router = express.Router();
const pool = require("../db/pool");
const { requireAuth, requireRole, assertOwnBranch } = require("../middleware/auth");
const { requirePermission } = require("../middleware/permissions");
const { logAudit } = require("../db/audit");
const { postInventoryMovement } = require("../db/inventory-ledger");
const { convertQuantity } = require("../db/unit-conversion");

const RECEIVABLE_PO_STATUSES = ["APPROVED", "PARTIALLY_RECEIVED"];

async function insertGrnItems(client, grnId, poItemsById, items) {
  for (const it of items) {
    const poItem = poItemsById.get(Number(it.purchaseOrderItemId));
    if (!poItem) throw new Error("سطر أمر الشراء ده مش موجود في نفس الأمر");
    const received = Number(it.receivedQuantity);
    const accepted = it.acceptedQuantity !== undefined ? Number(it.acceptedQuantity) : received;
    const rejected = it.rejectedQuantity !== undefined ? Number(it.rejectedQuantity) : received - accepted;
    if (!received || received <= 0) throw new Error("كل صنف لازم كمية مستلمة أكبر من صفر");
    if (accepted < 0 || rejected < 0 || accepted + rejected > received + 0.0000001) {
      throw new Error("الكمية المقبولة + المرفوضة مينفعش تتجاوز الكمية المستلمة");
    }
    const qualityStatus = it.qualityStatus || (rejected === 0 ? "ACCEPTED" : accepted === 0 ? "REJECTED" : "PARTIAL");
    const inserted = await client.query(
      `INSERT INTO goods_receipt_items
        (goods_receipt_id, purchase_order_item_id, inventory_item_id, ordered_quantity, received_quantity,
         accepted_quantity, rejected_quantity, unit, unit_price, batch_number, expiry_date, manufacturing_date,
         quality_status, rejection_reason)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
      [grnId, poItem.id, poItem.inventory_item_id, poItem.ordered_quantity, received, accepted, rejected,
       it.unit || poItem.unit, it.unitPrice !== undefined ? it.unitPrice : poItem.unit_price,
       it.batchNumber || null, it.expiryDate || null, it.manufacturingDate || null, qualityStatus,
       rejected > 0 ? (it.rejectionReason || null) : null]
    );
    if (rejected > 0 && !inserted.rows[0].rejection_reason) {
      throw new Error(`لازم سبب رفض للصنف #${poItem.inventory_item_id} (فيه كمية مرفوضة)`);
    }
  }
}

// POST /api/goods-receipts - {purchaseOrderId, supplierDocumentNumber?, notes?, idempotencyKey?,
//  items:[{purchaseOrderItemId, receivedQuantity, acceptedQuantity?, rejectedQuantity?, unit?, unitPrice?,
//          batchNumber?, expiryDate?, manufacturingDate?, qualityStatus?, rejectionReason?}],
//  overReceiveApprovedBy?}
router.post("/", requireAuth, requirePermission("purchasing.create"), async (req, res) => {
  const { purchaseOrderId, supplierDocumentNumber, notes, idempotencyKey, items, overReceiveApprovedBy } = req.body;
  if (!purchaseOrderId) return res.status(400).json({ error: "لازم تحدد أمر الشراء" });
  if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: "لازم صنف واحد على الأقل" });

  const client = await pool.connect();
  try {
    const po = await client.query("SELECT * FROM purchase_orders WHERE id = $1", [purchaseOrderId]);
    if (po.rows.length === 0) return res.status(404).json({ error: "أمر الشراء مش موجود" });
    if (!assertOwnBranch(req.user, po.rows[0].branch_id)) return res.status(403).json({ error: "معندكش صلاحية تستلم بضاعة لفرع تاني" });
    if (!RECEIVABLE_PO_STATUSES.includes(po.rows[0].status)) {
      return res.status(400).json({ error: "أمر الشراء ده لازم يكون معتمد (APPROVED) الأول قبل أي استلام" });
    }

    const poItemsRes = await client.query("SELECT * FROM purchase_order_items WHERE purchase_order_id = $1", [purchaseOrderId]);
    const poItemsById = new Map(poItemsRes.rows.map((r) => [r.id, r]));

    // فحص الاستلام الزائد (over-receiving) - لازم موافقة صريحة (نفس نمط الخصم/الرصيد السالب بالـPIN)
    let overReceiveDetected = false;
    for (const it of items) {
      const poItem = poItemsById.get(Number(it.purchaseOrderItemId));
      if (!poItem) continue;
      const remaining = Number(poItem.ordered_quantity) - Number(poItem.received_quantity);
      if (Number(it.receivedQuantity) > remaining + 0.0000001) overReceiveDetected = true;
    }
    if (overReceiveDetected) {
      let approverOk = false;
      if (overReceiveApprovedBy) {
        const approver = await client.query("SELECT role, branch_id FROM users WHERE id = $1", [overReceiveApprovedBy]);
        if (approver.rows.length > 0) {
          const a = approver.rows[0];
          approverOk = a.role === "admin" || (a.role === "branch_manager" && String(a.branch_id) === String(po.rows[0].branch_id));
        }
      }
      if (!approverOk) {
        return res.status(400).json({
          error: "الكمية المستلمة أكبر من المتبقي في أمر الشراء - محتاج موافقة مدير الفرع أو الأدمن (overReceiveApprovedBy)",
          code: "OVER_RECEIVE_NEEDS_APPROVAL",
        });
      }
    }

    await client.query("BEGIN");
    let grn;
    try {
      grn = await client.query(
        `INSERT INTO goods_receipts (purchase_order_id, supplier_id, branch_id, received_by, supplier_document_number, notes, idempotency_key, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [purchaseOrderId, po.rows[0].supplier_id, po.rows[0].branch_id, req.user.id,
         supplierDocumentNumber || null, notes || null, idempotencyKey || null, req.user.id]
      );
    } catch (err) {
      if (err.code === "23505" && idempotencyKey) {
        // لازم ROLLBACK الأول - نفس باج purchase-orders.js اللي اتصلح فوق بالظبط
        await client.query("ROLLBACK");
        const existing = await client.query("SELECT * FROM goods_receipts WHERE idempotency_key = $1", [idempotencyKey]);
        return res.status(200).json({ ...existing.rows[0], duplicate: true });
      }
      throw err;
    }
    await insertGrnItems(client, grn.rows[0].id, poItemsById, items);

    if (overReceiveDetected) {
      await logAudit(client, {
        branchId: po.rows[0].branch_id, userId: req.user.id, action: "GOODS_RECEIPT_OVER_RECEIVE_APPROVED",
        entityType: "goods_receipt", entityId: grn.rows[0].id, metadata: { overReceiveApprovedBy }, req,
      });
    }
    await logAudit(client, {
      branchId: po.rows[0].branch_id, userId: req.user.id, action: "GOODS_RECEIPT_CREATED",
      entityType: "goods_receipt", entityId: grn.rows[0].id, metadata: { purchaseOrderId }, newValues: { items }, req,
    });
    await client.query("COMMIT");
    res.status(201).json({ ...grn.rows[0], duplicate: false });
  } catch (err) {
    await client.query("ROLLBACK");
    res.status(400).json({ error: err.message });
  } finally {
    client.release();
  }
});

// GET /api/goods-receipts?branchId=&status=&purchaseOrderId=
router.get("/", requireAuth, requirePermission("purchasing.view"), async (req, res) => {
  let { branchId, status, purchaseOrderId } = req.query;
  if (req.user.role === "branch_manager") branchId = req.user.branchId;
  const conditions = [];
  const values = [];
  let i = 1;
  if (branchId) { conditions.push(`gr.branch_id = $${i++}`); values.push(branchId); }
  if (status) { conditions.push(`gr.status = $${i++}`); values.push(status); }
  if (purchaseOrderId) { conditions.push(`gr.purchase_order_id = $${i++}`); values.push(purchaseOrderId); }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  try {
    const result = await pool.query(
      `SELECT gr.*, s.name AS supplier_name, b.name AS branch_name
       FROM goods_receipts gr JOIN suppliers s ON s.id = gr.supplier_id JOIN branches b ON b.id = gr.branch_id
       ${where}
       ORDER BY gr.id DESC LIMIT 200`,
      values
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/goods-receipts/:id
router.get("/:id", requireAuth, requirePermission("purchasing.view"), async (req, res) => {
  try {
    const grn = await pool.query(
      `SELECT gr.*, s.name AS supplier_name, b.name AS branch_name
       FROM goods_receipts gr JOIN suppliers s ON s.id = gr.supplier_id JOIN branches b ON b.id = gr.branch_id
       WHERE gr.id = $1`,
      [req.params.id]
    );
    if (grn.rows.length === 0) return res.status(404).json({ error: "سند الاستلام مش موجود" });
    if (req.user.role === "branch_manager" && !assertOwnBranch(req.user, grn.rows[0].branch_id)) {
      return res.status(403).json({ error: "معندكش صلاحية تشوف سند استلام فرع تاني" });
    }
    const items = await pool.query(
      `SELECT gri.*, ii.name AS item_name, ii.unit AS stock_unit
       FROM goods_receipt_items gri JOIN inventory_items ii ON ii.id = gri.inventory_item_id
       WHERE gri.goods_receipt_id = $1`,
      [req.params.id]
    );
    res.json({ goodsReceipt: grn.rows[0], items: items.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/goods-receipts/:id/post - اللحظة الوحيدة اللي بتلمس المخزون فعليًا - كل صنف مقبول (accepted_quantity)
// بيتحول لحركة PURCHASE_RECEIPT حقيقية في الليدجر (batch جديد لو فيه رقم دفعة/صلاحية)، المرفوض ميدخلش
// الرصيد خالص. آمن يتكرر (retry) - لو GRN بالفعل POSTED بيرجّع نفس النتيجة من غير ما يكرر أي حركة
router.post("/:id/post", requireAuth, requirePermission("purchasing.create", "purchasing.approve"), async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // SELECT ... FOR UPDATE من جوه الـtransaction من أول حاجة - لازم عشان retry متزامن حقيقي (مش بس
    // متتابع) ميعملش double-post: طلبين POST /post بالظبط في نفس اللحظة، التاني بيستنى لحد ما الأول
    // يخلّص COMMIT (يبقى الحالة POSTED) قبل ما يقرا الصف، مش بيقروا الحالة "DRAFT" مع بعض زي بعض
    const grn = await client.query("SELECT * FROM goods_receipts WHERE id = $1 FOR UPDATE", [req.params.id]);
    if (grn.rows.length === 0) { await client.query("ROLLBACK"); return res.status(404).json({ error: "سند الاستلام مش موجود" }); }
    if (!assertOwnBranch(req.user, grn.rows[0].branch_id)) {
      await client.query("ROLLBACK");
      return res.status(403).json({ error: "معندكش صلاحية ترحّل سند استلام فرع تاني" });
    }
    if (grn.rows[0].status === "POSTED") {
      await client.query("ROLLBACK");
      return res.status(200).json({ ...grn.rows[0], duplicate: true }); // idempotent - مسبوق بالفعل
    }
    if (grn.rows[0].status !== "DRAFT") {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "سند الاستلام ده مش في حالة قابلة للترحيل" });
    }

    const itemsRes = await client.query(
      `SELECT gri.*, ii.unit AS stock_unit FROM goods_receipt_items gri JOIN inventory_items ii ON ii.id = gri.inventory_item_id
       WHERE gri.goods_receipt_id = $1`,
      [req.params.id]
    );

    for (const item of itemsRes.rows) {
      if (Number(item.accepted_quantity) <= 0) continue; // مفيش حركة مخزون للمرفوض خالص

      const stockUnit = item.stock_unit;
      const itemUnit = item.unit || stockUnit;
      const convertedQuantity = await convertQuantity(client, item.accepted_quantity, itemUnit, stockUnit);
      const conversionFactor = Number(item.accepted_quantity) > 0 ? convertedQuantity / Number(item.accepted_quantity) : 1;
      const unitCostInStockUnit = item.unit_price != null ? Number(item.unit_price) / conversionFactor : null;

      let batchId = null;
      if (item.batch_number || item.expiry_date) {
        const batch = await client.query(
          `INSERT INTO inventory_batches
            (batch_number, inventory_item_id, branch_id, supplier_id, received_date, production_date,
             expiry_date, original_quantity, remaining_quantity, unit_cost, created_by)
           VALUES ($1,$2,$3,$4,CURRENT_DATE,$5,$6,$7,$7,$8,$9) RETURNING id`,
          [item.batch_number || null, item.inventory_item_id, grn.rows[0].branch_id, grn.rows[0].supplier_id,
           item.manufacturing_date || null, item.expiry_date || null, convertedQuantity, unitCostInStockUnit, req.user.id]
        );
        batchId = batch.rows[0].id;
      }

      const { movement } = await postInventoryMovement(client, {
        branchId: grn.rows[0].branch_id, inventoryItemId: item.inventory_item_id, quantity: convertedQuantity,
        movementType: "PURCHASE_RECEIPT", referenceType: "goods_receipt", referenceId: grn.rows[0].id,
        unit: stockUnit, unitCost: unitCostInStockUnit, batchId, userId: req.user.id,
        idempotencyKey: `grn-item-${item.id}`,
      });
      void movement;

      if (batchId) {
        await client.query("UPDATE goods_receipt_items SET batch_id = $1 WHERE id = $2", [batchId, item.id]);
      }
      await client.query(
        "UPDATE purchase_order_items SET received_quantity = received_quantity + $1 WHERE id = $2",
        [item.accepted_quantity, item.purchase_order_item_id]
      );

      if (Number(item.rejected_quantity) > 0) {
        await logAudit(client, {
          branchId: grn.rows[0].branch_id, userId: req.user.id, action: "GOODS_RECEIPT_QUANTITY_REJECTED",
          entityType: "goods_receipt_item", entityId: item.id,
          metadata: { inventoryItemId: item.inventory_item_id, rejectedQuantity: item.rejected_quantity, reason: item.rejection_reason }, req,
        });
      }
    }

    const posted = await client.query(
      `UPDATE goods_receipts SET status = 'POSTED', posted_by = $1, posted_at = now() WHERE id = $2 RETURNING *`,
      [req.user.id, req.params.id]
    );

    const poStatusRes = await client.query(
      `SELECT bool_and(received_quantity >= ordered_quantity - 0.0000001) AS fully_received,
              bool_or(received_quantity > 0) AS any_received
       FROM purchase_order_items WHERE purchase_order_id = $1`,
      [grn.rows[0].purchase_order_id]
    );
    const newPoStatus = poStatusRes.rows[0].fully_received ? "FULLY_RECEIVED"
      : poStatusRes.rows[0].any_received ? "PARTIALLY_RECEIVED" : null;
    if (newPoStatus) {
      await client.query(
        `UPDATE purchase_orders SET status = $1, updated_at = now() WHERE id = $2 AND status NOT IN ('CLOSED', 'CANCELLED')`,
        [newPoStatus, grn.rows[0].purchase_order_id]
      );
    }

    await logAudit(client, {
      branchId: grn.rows[0].branch_id, userId: req.user.id, action: "GOODS_RECEIPT_POSTED",
      entityType: "goods_receipt", entityId: grn.rows[0].id, req,
    });
    await client.query("COMMIT");
    res.json({ ...posted.rows[0], duplicate: false });
  } catch (err) {
    await client.query("ROLLBACK");
    if (err.code === "NO_UNIT_CONVERSION") return res.status(400).json({ error: err.message });
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// POST /api/goods-receipts/:id/cancel - DRAFT بيتلغي من غير أي أثر. POSTED بيتلغي بس لو الدفعات المتأثرة
// لسه كاملة (متستهلكتش) - بيرجّع بالظبط نفس الكميات (نفس نمط إلغاء أمر التصنيع بالضبط - عكس متماثل)
router.post("/:id/cancel", requireAuth, requirePermission("purchasing.cancel"), async (req, res) => {
  const { reason } = req.body;
  const client = await pool.connect();
  try {
    const grn = await client.query("SELECT * FROM goods_receipts WHERE id = $1", [req.params.id]);
    if (grn.rows.length === 0) return res.status(404).json({ error: "سند الاستلام مش موجود" });
    if (!assertOwnBranch(req.user, grn.rows[0].branch_id)) return res.status(403).json({ error: "معندكش صلاحية تلغي سند استلام فرع تاني" });
    if (grn.rows[0].status === "CANCELLED") return res.status(400).json({ error: "سند الاستلام ده اتلغى بالفعل" });

    await client.query("BEGIN");
    if (grn.rows[0].status === "POSTED") {
      const items = await client.query(
        "SELECT * FROM goods_receipt_items WHERE goods_receipt_id = $1 AND accepted_quantity > 0", [req.params.id]
      );
      for (const item of items.rows) {
        if (item.batch_id) {
          const batch = await client.query("SELECT remaining_quantity, original_quantity FROM inventory_batches WHERE id = $1 FOR UPDATE", [item.batch_id]);
          const consumedAlready = Number(batch.rows[0].original_quantity) - Number(batch.rows[0].remaining_quantity);
          if (consumedAlready > 0.0000001) {
            throw Object.assign(new Error("مينفعش تلغي الاستلام ده - جزء من الدفعة اتصرف بالفعل (بيع/تحويل/تصنيع)"), { code: "BATCH_ALREADY_CONSUMED" });
          }
          await client.query("UPDATE inventory_batches SET remaining_quantity = 0, status = 'depleted' WHERE id = $1", [item.batch_id]);
        }
        const movement = await client.query(
          "SELECT quantity, unit, unit_cost FROM inventory_movements WHERE reference_type = 'goods_receipt' AND reference_id = $1 AND inventory_item_id = $2 AND idempotency_key = $3",
          [grn.rows[0].id, item.inventory_item_id, `grn-item-${item.id}`]
        );
        const qty = movement.rows[0] ? Number(movement.rows[0].quantity) : Number(item.accepted_quantity);
        const originalUnitCost = movement.rows[0]?.unit_cost != null ? Number(movement.rows[0].unit_cost) : null;
        await postInventoryMovement(client, {
          branchId: grn.rows[0].branch_id, inventoryItemId: item.inventory_item_id, quantity: -qty,
          movementType: "RETURN_TO_SUPPLIER", referenceType: "goods_receipt", referenceId: grn.rows[0].id,
          unitCost: originalUnitCost, batchId: item.batch_id, userId: req.user.id,
          skipBatchConsumption: true, negativeStockOverrideApproved: true,
        });
        await client.query(
          "UPDATE purchase_order_items SET received_quantity = GREATEST(0, received_quantity - $1) WHERE id = $2",
          [item.accepted_quantity, item.purchase_order_item_id]
        );
      }
      // بعد الإلغاء ممكن الـPO يرجع لحالة أقل (FULLY_RECEIVED → PARTIALLY_RECEIVED أو لا استلام خالص)
      const poStatusRes = await client.query(
        `SELECT bool_and(received_quantity >= ordered_quantity - 0.0000001) AS fully_received,
                bool_or(received_quantity > 0) AS any_received
         FROM purchase_order_items WHERE purchase_order_id = $1`,
        [grn.rows[0].purchase_order_id]
      );
      const recomputedStatus = poStatusRes.rows[0].fully_received ? "FULLY_RECEIVED"
        : poStatusRes.rows[0].any_received ? "PARTIALLY_RECEIVED" : "APPROVED";
      await client.query(
        `UPDATE purchase_orders SET status = $1, updated_at = now() WHERE id = $2 AND status NOT IN ('CLOSED', 'CANCELLED')`,
        [recomputedStatus, grn.rows[0].purchase_order_id]
      );
    }

    const result = await client.query(
      `UPDATE goods_receipts SET status = 'CANCELLED', cancelled_by = $1, cancelled_at = now() WHERE id = $2 RETURNING *`,
      [req.user.id, req.params.id]
    );
    await logAudit(client, {
      branchId: grn.rows[0].branch_id, userId: req.user.id, action: "GOODS_RECEIPT_CANCELLED",
      entityType: "goods_receipt", entityId: grn.rows[0].id, metadata: { reason, wasPosted: grn.rows[0].status === "POSTED" }, req,
    });
    await client.query("COMMIT");
    res.json(result.rows[0]);
  } catch (err) {
    await client.query("ROLLBACK");
    if (err.code === "BATCH_ALREADY_CONSUMED") return res.status(400).json({ error: err.message });
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

module.exports = router;
