const express = require("express");
const router = express.Router();
const pool = require("../db/pool");
const { requireAuth, requireRole, assertOwnBranch } = require("../middleware/auth");
const { requirePermission } = require("../middleware/permissions");
const { logAudit } = require("../db/audit");
const { postInventoryMovement } = require("../db/inventory-ledger");

// أنواع الطلبات المدعومة حاليًا - قابلة للتوسيع لاحقًا (مصروفات، مشتريات...) بإضافة حالة جديدة
// في switch التنفيذ تحت (POST /:id/approve)
const VALID_TYPES = ["inventory_adjustment"];

// POST /api/approvals - طلب موافقة جديد (أي موظف مسجل دخول) - مش بينفّذ حاجة فورًا، بس بيسجل الطلب
// عشان مدير الفرع/الأدمن يراجعه ويوافق أو يرفض. بيكمّل نظام الـPIN اللحظي (للحالات اللي مش مستعجلة)
// body: {type, entityType?, entityId?, branchId?, amount?, reason, payload?}
router.post("/", requireAuth, requirePermission("approvals.create", "approvals.decide"), async (req, res) => {
  const { type, entityType, entityId, amount, reason, payload } = req.body;
  let branchId = req.body.branchId;
  if (!type || !VALID_TYPES.includes(type)) {
    return res.status(400).json({ error: "نوع الطلب غير معروف" });
  }
  if (!reason) return res.status(400).json({ error: "لازم سبب الطلب" });
  if (req.user.role !== "admin") branchId = req.user.branchId;
  if (!branchId) return res.status(400).json({ error: "لازم تحدد الفرع" });

  try {
    const result = await pool.query(
      `INSERT INTO approval_requests
        (type, entity_type, entity_id, requested_by, branch_id, amount, reason, payload)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [type, entityType || null, entityId || null, req.user.id, branchId,
       amount ?? null, reason, payload ? JSON.stringify(payload) : null]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/approvals?status=&type=&branchId= - قايمة طلبات الموافقة
// أدمن: كل الطلبات (وممكن يفلتر بفرع). مدير فرع/محاسب: طلبات فرعه بس. غيرهم: الطلبات اللي هو نفسه طلبها بس.
router.get("/", requireAuth, async (req, res) => {
  const { status, type } = req.query;
  const conditions = [];
  const values = [];
  let i = 1;

  if (req.user.role === "admin") {
    if (req.query.branchId) { conditions.push(`ar.branch_id = $${i++}`); values.push(req.query.branchId); }
  } else if (["branch_manager", "accountant"].includes(req.user.role)) {
    conditions.push(`ar.branch_id = $${i++}`); values.push(req.user.branchId);
  } else {
    conditions.push(`ar.requested_by = $${i++}`); values.push(req.user.id);
  }
  if (status) { conditions.push(`ar.status = $${i++}`); values.push(status); }
  if (type) { conditions.push(`ar.type = $${i++}`); values.push(type); }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

  try {
    const result = await pool.query(
      `SELECT ar.*, ru.name AS requested_by_name, au.name AS approved_by_name, rj.name AS rejected_by_name,
              b.name AS branch_name
       FROM approval_requests ar
       LEFT JOIN users ru ON ru.id = ar.requested_by
       LEFT JOIN users au ON au.id = ar.approved_by
       LEFT JOIN users rj ON rj.id = ar.rejected_by
       LEFT JOIN branches b ON b.id = ar.branch_id
       ${where}
       ORDER BY ar.created_at DESC
       LIMIT 200`,
      values
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/approvals/:id/approve - اعتماد الطلب (مدير فرع/أدمن بس) - بينفّذ الإجراء فعليًا حسب النوع
router.post(
  "/:id/approve",
  requireAuth,
  requireRole("admin", "branch_manager"),
  requirePermission("approvals.decide"),
  async (req, res) => {
    const client = await pool.connect();
    try {
      const existing = await client.query("SELECT * FROM approval_requests WHERE id = $1", [req.params.id]);
      if (existing.rows.length === 0) return res.status(404).json({ error: "الطلب مش موجود" });
      const request = existing.rows[0];
      if (request.status !== "pending") return res.status(400).json({ error: "الطلب ده اتحسم بالفعل" });
      if (!assertOwnBranch(req.user, request.branch_id)) {
        return res.status(403).json({ error: "معندكش صلاحية تعتمد طلب فرع تاني" });
      }

      await client.query("BEGIN");

      if (request.type === "inventory_adjustment") {
        const { inventoryItemId, quantity, notes } = request.payload || {};
        if (!inventoryItemId || !quantity) {
          throw new Error("بيانات طلب التسوية ناقصة");
        }
        await postInventoryMovement(client, {
          branchId: request.branch_id, inventoryItemId, quantity: Number(quantity), movementType: "ADJUSTMENT",
          referenceType: "approval_request", referenceId: request.id,
          notes: notes || request.reason, userId: request.requested_by,
        });
      }

      const updated = await client.query(
        `UPDATE approval_requests SET status = 'approved', approved_by = $1, approved_at = now()
         WHERE id = $2 RETURNING *`,
        [req.user.id, request.id]
      );

      await logAudit(client, {
        branchId: request.branch_id, userId: req.user.id, action: "APPROVAL_GRANTED",
        entityType: "approval_request", entityId: request.id,
        newValues: { type: request.type, payload: request.payload },
        metadata: { requestedBy: request.requested_by, reason: request.reason }, req,
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
  }
);

// POST /api/approvals/:id/reject - رفض الطلب (مدير فرع/أدمن بس) - {rejectionReason}
router.post(
  "/:id/reject",
  requireAuth,
  requireRole("admin", "branch_manager"),
  requirePermission("approvals.decide"),
  async (req, res) => {
    const { rejectionReason } = req.body;
    if (!rejectionReason) return res.status(400).json({ error: "لازم سبب الرفض" });
    try {
      const existing = await pool.query("SELECT * FROM approval_requests WHERE id = $1", [req.params.id]);
      if (existing.rows.length === 0) return res.status(404).json({ error: "الطلب مش موجود" });
      const request = existing.rows[0];
      if (request.status !== "pending") return res.status(400).json({ error: "الطلب ده اتحسم بالفعل" });
      if (!assertOwnBranch(req.user, request.branch_id)) {
        return res.status(403).json({ error: "معندكش صلاحية ترفض طلب فرع تاني" });
      }
      const result = await pool.query(
        `UPDATE approval_requests SET status = 'rejected', rejected_by = $1, rejected_at = now(), rejection_reason = $2
         WHERE id = $3 RETURNING *`,
        [req.user.id, rejectionReason, request.id]
      );
      await logAudit(pool, {
        branchId: request.branch_id, userId: req.user.id, action: "APPROVAL_REJECTED",
        entityType: "approval_request", entityId: request.id,
        metadata: { rejectionReason, requestedBy: request.requested_by, reason: request.reason }, req,
      });
      res.json(result.rows[0]);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

module.exports = router;
