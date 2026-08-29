// المرحلة 4A: طلب الشراء الداخلي - أول خطوة في المشتريات، قبل أي التزام مع مورد بسعر/كمية. الفرع/
// السنتر كيتشن بيطلب صنف، وبعد الاعتماد بيتحول لأمر شراء فعلي (purchase-orders.js POST / بيقبل
// purchaseRequestId ويحوّل حالته لـCONVERTED_TO_PO تلقائيًا - مفيش endpoint تحويل منفصل).
const express = require("express");
const router = express.Router();
const pool = require("../db/pool");
const { requireAuth, requireRole, assertOwnBranch } = require("../middleware/auth");
const { requirePermission } = require("../middleware/permissions");
const { logAudit } = require("../db/audit");

const EDITABLE_STATUSES = ["DRAFT"];

async function insertItems(client, purchaseRequestId, items) {
  for (const it of items) {
    if (!it.inventoryItemId || !it.requestedQuantity || Number(it.requestedQuantity) <= 0) {
      throw new Error("كل صنف لازم يكون له كمية مطلوبة أكبر من صفر");
    }
    await client.query(
      `INSERT INTO purchase_request_items (purchase_request_id, inventory_item_id, requested_quantity, unit, notes)
       VALUES ($1,$2,$3,$4,$5)`,
      [purchaseRequestId, it.inventoryItemId, it.requestedQuantity, it.unit || null, it.notes || null]
    );
  }
}

// POST /api/purchase-requests - {branchId, requiredDate?, reason?, items:[{inventoryItemId, requestedQuantity, unit?, notes?}]}
router.post("/", requireAuth, requirePermission("purchasing.create"), async (req, res) => {
  const { branchId, requiredDate, reason, items } = req.body;
  if (!branchId) return res.status(400).json({ error: "لازم تحدد الفرع" });
  if (!assertOwnBranch(req.user, branchId)) return res.status(403).json({ error: "معندكش صلاحية تنشئ طلب شراء لفرع تاني" });
  if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: "لازم صنف واحد على الأقل" });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const pr = await client.query(
      `INSERT INTO purchase_requests (branch_id, requested_by, required_date, reason)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [branchId, req.user.id, requiredDate || null, reason || null]
    );
    await insertItems(client, pr.rows[0].id, items);
    await logAudit(client, {
      branchId, userId: req.user.id, action: "PURCHASE_REQUEST_CREATED", entityType: "purchase_request",
      entityId: pr.rows[0].id, newValues: { items }, req,
    });
    await client.query("COMMIT");
    res.status(201).json(pr.rows[0]);
  } catch (err) {
    await client.query("ROLLBACK");
    res.status(400).json({ error: err.message });
  } finally {
    client.release();
  }
});

// GET /api/purchase-requests?branchId=&status=
router.get("/", requireAuth, requirePermission("purchasing.view"), async (req, res) => {
  let { branchId, status } = req.query;
  if (req.user.role === "branch_manager") branchId = req.user.branchId;
  const conditions = [];
  const values = [];
  let i = 1;
  if (branchId) { conditions.push(`pr.branch_id = $${i++}`); values.push(branchId); }
  if (status) { conditions.push(`pr.status = $${i++}`); values.push(status); }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  try {
    const result = await pool.query(
      `SELECT pr.*, b.name AS branch_name, u.name AS requested_by_name
       FROM purchase_requests pr
       JOIN branches b ON b.id = pr.branch_id
       LEFT JOIN users u ON u.id = pr.requested_by
       ${where}
       ORDER BY pr.id DESC LIMIT 200`,
      values
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/purchase-requests/:id
router.get("/:id", requireAuth, requirePermission("purchasing.view"), async (req, res) => {
  try {
    // UI-2D: تفاصيل الطلب لازم تعرض "مقدّم الطلب" بالاسم - كانت موجودة في القايمة بس، مش هنا (نفس
    // فجوة created_by_name اللي اتصلحت قبل كده في kitchen-orders.js) - جوين إضافي بس، مفيش حقل اتشال
    const pr = await pool.query(
      `SELECT pr.*, b.name AS branch_name, u.name AS requested_by_name
       FROM purchase_requests pr JOIN branches b ON b.id = pr.branch_id
       LEFT JOIN users u ON u.id = pr.requested_by
       WHERE pr.id = $1`,
      [req.params.id]
    );
    if (pr.rows.length === 0) return res.status(404).json({ error: "طلب الشراء مش موجود" });
    if (req.user.role === "branch_manager" && !assertOwnBranch(req.user, pr.rows[0].branch_id)) {
      return res.status(403).json({ error: "معندكش صلاحية تشوف طلب شراء فرع تاني" });
    }
    const items = await pool.query(
      `SELECT pri.*, ii.name AS item_name, ii.unit AS item_unit
       FROM purchase_request_items pri JOIN inventory_items ii ON ii.id = pri.inventory_item_id
       WHERE pri.purchase_request_id = $1`,
      [req.params.id]
    );
    res.json({ purchaseRequest: pr.rows[0], items: items.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/purchase-requests/:id - تعديل لسه DRAFT بس
router.patch("/:id", requireAuth, requirePermission("purchasing.edit"), async (req, res) => {
  const { requiredDate, reason, items } = req.body;
  const client = await pool.connect();
  try {
    const before = await client.query("SELECT * FROM purchase_requests WHERE id = $1", [req.params.id]);
    if (before.rows.length === 0) return res.status(404).json({ error: "طلب الشراء مش موجود" });
    if (!assertOwnBranch(req.user, before.rows[0].branch_id)) return res.status(403).json({ error: "معندكش صلاحية تعدّل طلب شراء فرع تاني" });
    if (!EDITABLE_STATUSES.includes(before.rows[0].status)) {
      return res.status(400).json({ error: "طلب الشراء ده مش في حالة قابلة للتعديل (DRAFT بس)" });
    }

    const fields = [];
    const values = [];
    let i = 1;
    if (requiredDate !== undefined) { fields.push(`required_date = $${i++}`); values.push(requiredDate); }
    if (reason !== undefined) { fields.push(`reason = $${i++}`); values.push(reason); }
    fields.push("updated_at = now()");

    await client.query("BEGIN");
    values.push(req.params.id);
    await client.query(`UPDATE purchase_requests SET ${fields.join(", ")} WHERE id = $${i}`, values);
    if (Array.isArray(items)) {
      await client.query("DELETE FROM purchase_request_items WHERE purchase_request_id = $1", [req.params.id]);
      await insertItems(client, req.params.id, items);
    }
    await logAudit(client, {
      branchId: before.rows[0].branch_id, userId: req.user.id, action: "PURCHASE_REQUEST_EDITED",
      entityType: "purchase_request", entityId: Number(req.params.id), oldValues: before.rows[0], newValues: req.body, req,
    });
    await client.query("COMMIT");
    const updated = await pool.query("SELECT * FROM purchase_requests WHERE id = $1", [req.params.id]);
    res.json(updated.rows[0]);
  } catch (err) {
    await client.query("ROLLBACK");
    res.status(400).json({ error: err.message });
  } finally {
    client.release();
  }
});

// POST /api/purchase-requests/:id/submit - DRAFT → SUBMITTED
router.post("/:id/submit", requireAuth, requirePermission("purchasing.submit"), async (req, res) => {
  try {
    const pr = await pool.query("SELECT * FROM purchase_requests WHERE id = $1", [req.params.id]);
    if (pr.rows.length === 0) return res.status(404).json({ error: "طلب الشراء مش موجود" });
    if (!assertOwnBranch(req.user, pr.rows[0].branch_id)) return res.status(403).json({ error: "معندكش صلاحية تقدّم طلب شراء فرع تاني" });
    if (pr.rows[0].status !== "DRAFT") return res.status(400).json({ error: "طلب الشراء ده مش في حالة قابلة للتقديم" });
    const result = await pool.query(
      `UPDATE purchase_requests SET status = 'SUBMITTED', updated_at = now() WHERE id = $1 RETURNING *`, [req.params.id]
    );
    await logAudit(pool, {
      branchId: pr.rows[0].branch_id, userId: req.user.id, action: "PURCHASE_REQUEST_SUBMITTED",
      entityType: "purchase_request", entityId: Number(req.params.id), req,
    });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/purchase-requests/:id/approve - SUBMITTED → APPROVED (أدمن بس - نفس نمط اعتماد الوصفات/التصنيع)
router.post("/:id/approve", requireAuth, requireRole("admin"), requirePermission("purchasing.approve"), async (req, res) => {
  try {
    const pr = await pool.query("SELECT * FROM purchase_requests WHERE id = $1", [req.params.id]);
    if (pr.rows.length === 0) return res.status(404).json({ error: "طلب الشراء مش موجود" });
    if (pr.rows[0].status !== "SUBMITTED") return res.status(400).json({ error: "طلب الشراء ده مش في انتظار اعتماد" });
    const result = await pool.query(
      `UPDATE purchase_requests SET status = 'APPROVED', approved_by = $1, approved_at = now(), updated_at = now() WHERE id = $2 RETURNING *`,
      [req.user.id, req.params.id]
    );
    await logAudit(pool, {
      branchId: pr.rows[0].branch_id, userId: req.user.id, action: "PURCHASE_REQUEST_APPROVED",
      entityType: "purchase_request", entityId: Number(req.params.id), req,
    });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/purchase-requests/:id/reject - SUBMITTED → REJECTED (أدمن بس) - {rejectionReason}
router.post("/:id/reject", requireAuth, requireRole("admin"), requirePermission("purchasing.approve"), async (req, res) => {
  const { rejectionReason } = req.body;
  if (!rejectionReason) return res.status(400).json({ error: "لازم سبب الرفض" });
  try {
    const pr = await pool.query("SELECT * FROM purchase_requests WHERE id = $1", [req.params.id]);
    if (pr.rows.length === 0) return res.status(404).json({ error: "طلب الشراء مش موجود" });
    if (pr.rows[0].status !== "SUBMITTED") return res.status(400).json({ error: "طلب الشراء ده مش في انتظار اعتماد" });
    const result = await pool.query(
      `UPDATE purchase_requests SET status = 'REJECTED', rejected_by = $1, rejection_reason = $2, updated_at = now() WHERE id = $3 RETURNING *`,
      [req.user.id, rejectionReason, req.params.id]
    );
    await logAudit(pool, {
      branchId: pr.rows[0].branch_id, userId: req.user.id, action: "PURCHASE_REQUEST_REJECTED",
      entityType: "purchase_request", entityId: Number(req.params.id), metadata: { rejectionReason }, req,
    });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/purchase-requests/:id/cancel
router.post("/:id/cancel", requireAuth, requirePermission("purchasing.cancel"), async (req, res) => {
  const { reason } = req.body;
  try {
    const pr = await pool.query("SELECT * FROM purchase_requests WHERE id = $1", [req.params.id]);
    if (pr.rows.length === 0) return res.status(404).json({ error: "طلب الشراء مش موجود" });
    if (!assertOwnBranch(req.user, pr.rows[0].branch_id)) return res.status(403).json({ error: "معندكش صلاحية تلغي طلب شراء فرع تاني" });
    if (["CONVERTED_TO_PO", "CANCELLED", "REJECTED"].includes(pr.rows[0].status)) {
      return res.status(400).json({ error: "طلب الشراء ده مش قابل للإلغاء في حالته الحالية" });
    }
    const result = await pool.query(
      `UPDATE purchase_requests SET status = 'CANCELLED', cancelled_by = $1, cancelled_at = now(), updated_at = now() WHERE id = $2 RETURNING *`,
      [req.user.id, req.params.id]
    );
    await logAudit(pool, {
      branchId: pr.rows[0].branch_id, userId: req.user.id, action: "PURCHASE_REQUEST_CANCELLED",
      entityType: "purchase_request", entityId: Number(req.params.id), metadata: { reason }, req,
    });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
