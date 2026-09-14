// CRM-1: متابعة أوردرات الدليفري بعد التسليم (مكالمة تأكيد جودة/خدمة) + شكاوى العملاء الناتجة عنها.
const express = require("express");
const router = express.Router();
const pool = require("../db/pool");
const { requireAuth } = require("../middleware/auth");
const { requirePermission } = require("../middleware/permissions");
const { logAudit } = require("../db/audit");

const CALL_RESULTS = ["answered", "no_answer", "no_answer_after_3_tries"];
const SATISFACTION_RATINGS = ["excellent", "good", "average", "bad"];
const COMPLAINT_CATEGORIES = ["late_order", "wrong_item", "quality", "other"];
const COMPLAINT_STATUSES = ["open", "in_progress", "resolved"];

// GET /api/crm/followup-queue?branchId= - أوردرات الدليفري اللي اتسلمت ولسه محتاجة مكالمة متابعة: إما
// لسه ما اتصلناش بيها خالص، أو اتصلنا وماردّوش (no_answer) فلسه تستاهل محاولة تانية. "مش راد بعد 3
// محاولات" اعتباره نهائي (بنوقف نحاول) فبيخرج من الطابور - مش بيتعرض هنا تاني
router.get("/followup-queue", requireAuth, requirePermission("crm.followups.view"), async (req, res) => {
  const { branchId } = req.query;
  try {
    const result = await pool.query(
      `SELECT o.id AS order_id, o.branch_id, b.name AS branch_name, o.customer_name, o.customer_phone,
              o.address_details, o.distinguishing_mark, o.total, o.delivered_at,
              f.call_result AS last_call_result, f.notes AS last_notes, f.called_at AS last_called_at
       FROM orders o
       JOIN branches b ON b.id = o.branch_id
       LEFT JOIN customer_followups f ON f.order_id = o.id
       WHERE o.dispatch_status = 'DELIVERED'
         AND (f.id IS NULL OR f.call_result = 'no_answer')
         AND ($1::int IS NULL OR o.branch_id = $1)
       ORDER BY o.delivered_at ASC`,
      [branchId || null]
    );
    res.json(result.rows.map((r) => ({
      orderId: r.order_id, branchId: r.branch_id, branchName: r.branch_name,
      customerName: r.customer_name, customerPhone: r.customer_phone,
      addressDetails: r.address_details, distinguishingMark: r.distinguishing_mark,
      total: Number(r.total), deliveredAt: r.delivered_at,
      lastCallResult: r.last_call_result, lastNotes: r.last_notes, lastCalledAt: r.last_called_at,
    })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/crm/followups - {orderId, callResult, satisfactionRating?, notes?, hasComplaint?, complaint?:
// {category, description, status?, resolutionNotes?}} - صف واحد بس لكل أوردر (upsert بـorder_id) - محاولة
// تانية على نفس الأوردر بتحدّث نفس الصف، مش بتضيف صف جديد
router.post("/followups", requireAuth, requirePermission("crm.followups.record"), async (req, res) => {
  const { orderId, callResult, satisfactionRating, notes, hasComplaint, complaint } = req.body;
  if (!orderId) return res.status(400).json({ error: "orderId مطلوب" });
  if (!CALL_RESULTS.includes(callResult)) return res.status(400).json({ error: "نتيجة الاتصال غير معروفة" });
  if (satisfactionRating !== undefined && satisfactionRating !== null && !SATISFACTION_RATINGS.includes(satisfactionRating)) {
    return res.status(400).json({ error: "تقييم الرضا غير معروف" });
  }
  if (hasComplaint) {
    if (!complaint?.category || !COMPLAINT_CATEGORIES.includes(complaint.category)) {
      return res.status(400).json({ error: "نوع الشكوى مطلوب ولازم يكون من الأنواع المعروفة" });
    }
    if (complaint.status !== undefined && !COMPLAINT_STATUSES.includes(complaint.status)) {
      return res.status(400).json({ error: "حالة الشكوى غير معروفة" });
    }
  }

  try {
    const order = await pool.query("SELECT id, branch_id, customer_phone FROM orders WHERE id = $1", [orderId]);
    if (order.rows.length === 0) return res.status(404).json({ error: "الأوردر مش موجود" });
    const { branch_id: branchId, customer_phone: customerPhone } = order.rows[0];

    const followupResult = await pool.query(
      `INSERT INTO customer_followups (order_id, branch_id, customer_phone, call_result, satisfaction_rating, notes, has_complaint, called_by, called_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now())
       ON CONFLICT (order_id) DO UPDATE SET
         call_result = $4, satisfaction_rating = $5, notes = $6, has_complaint = $7, called_by = $8, called_at = now()
       RETURNING *`,
      [orderId, branchId, customerPhone, callResult, satisfactionRating || null, notes || null, !!hasComplaint, req.user.id]
    );
    const followup = followupResult.rows[0];

    let createdComplaint = null;
    if (hasComplaint) {
      const status = complaint.status || "open";
      const complaintResult = await pool.query(
        `INSERT INTO customer_complaints (order_id, branch_id, customer_phone, followup_id, category, description, status, resolution_notes, created_by, resolved_by, resolved_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
        [orderId, branchId, customerPhone, followup.id, complaint.category, complaint.description || null, status,
         complaint.resolutionNotes || null, req.user.id, status === "resolved" ? req.user.id : null, status === "resolved" ? new Date() : null]
      );
      createdComplaint = complaintResult.rows[0];
    }

    await logAudit(pool, {
      branchId, userId: req.user.id, action: "CRM_FOLLOWUP_RECORDED", entityType: "order", entityId: Number(orderId),
      newValues: { callResult, satisfactionRating, hasComplaint: !!hasComplaint }, req,
    });

    res.status(201).json({ followup, complaint: createdComplaint });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/crm/complaints?status=&branchId= - لوحة الشكاوى (فيها ديتيل الأوردر عشان السياق)
router.get("/complaints", requireAuth, requirePermission("crm.complaints.view"), async (req, res) => {
  const { status, branchId } = req.query;
  if (status !== undefined && !COMPLAINT_STATUSES.includes(status)) {
    return res.status(400).json({ error: "حالة الشكوى غير معروفة" });
  }
  try {
    const result = await pool.query(
      `SELECT c.*, o.customer_name, o.delivered_at, b.name AS branch_name
       FROM customer_complaints c
       JOIN orders o ON o.id = c.order_id
       LEFT JOIN branches b ON b.id = c.branch_id
       WHERE ($1::text IS NULL OR c.status = $1)
         AND ($2::int IS NULL OR c.branch_id = $2)
       ORDER BY c.created_at DESC`,
      [status || null, branchId || null]
    );
    res.json(result.rows.map((r) => ({
      id: r.id, orderId: r.order_id, branchId: r.branch_id, branchName: r.branch_name,
      customerPhone: r.customer_phone, customerName: r.customer_name, deliveredAt: r.delivered_at,
      category: r.category, description: r.description, status: r.status, resolutionNotes: r.resolution_notes,
      createdAt: r.created_at, resolvedAt: r.resolved_at,
    })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/crm/complaints/:id - {status?, resolutionNotes?} - تحديث حالة شكوى/إضافة ملاحظة الحل
router.patch("/complaints/:id", requireAuth, requirePermission("crm.complaints.manage"), async (req, res) => {
  const { status, resolutionNotes } = req.body;
  if (status !== undefined && !COMPLAINT_STATUSES.includes(status)) {
    return res.status(400).json({ error: "حالة الشكوى غير معروفة" });
  }
  if (status === undefined && resolutionNotes === undefined) return res.status(400).json({ error: "مفيش حاجة تتعدل" });
  try {
    const before = await pool.query("SELECT * FROM customer_complaints WHERE id = $1", [req.params.id]);
    if (before.rows.length === 0) return res.status(404).json({ error: "الشكوى مش موجودة" });
    const resolvingNow = status === "resolved" && before.rows[0].status !== "resolved";
    const result = await pool.query(
      `UPDATE customer_complaints SET
         status = COALESCE($2, status),
         resolution_notes = COALESCE($3, resolution_notes),
         resolved_by = CASE WHEN $4 THEN $5 ELSE resolved_by END,
         resolved_at = CASE WHEN $4 THEN now() ELSE resolved_at END
       WHERE id = $1 RETURNING *`,
      [req.params.id, status || null, resolutionNotes ?? null, resolvingNow, req.user.id]
    );
    await logAudit(pool, {
      branchId: before.rows[0].branch_id, userId: req.user.id, action: "CRM_COMPLAINT_UPDATED",
      entityType: "customer_complaint", entityId: Number(req.params.id),
      oldValues: { status: before.rows[0].status }, newValues: { status, resolutionNotes }, req,
    });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/crm/customers/:phone/complaints/latest - آخر شكوى مسجّلة لرقم العميل ده (لو فيه) - مستخدمة في
// شاشة الكول سنتر وقت تحميل بروفايل عميل، عشان الموظف ياخد باله إن العميل ده كان عنده شكوى قبل كده
router.get("/customers/:phone/complaints/latest", requireAuth, requirePermission("crm.complaints.view"), async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, order_id, category, description, status, created_at
       FROM customer_complaints WHERE customer_phone = $1
       ORDER BY created_at DESC LIMIT 1`,
      [req.params.phone]
    );
    res.json(result.rows[0] || null);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
