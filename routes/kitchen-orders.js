const express = require("express");
const router = express.Router();
const pool = require("../db/pool");
const { requireAuth, requireRole, assertOwnBranch } = require("../middleware/auth");
const { logAudit } = require("../db/audit");
const { generateSuggestedRequisition } = require("../db/requisition-suggestion");

// GET /api/kitchen-orders?branchId=&status= - طلبيات الفروع للسنتر كيتشن
// مدير الفرع/الكاشير يشوفوا طلبيات فرعهم بس، الأدمن يشوف كل حاجة (قايمة تنفيذ السنتر كيتشن)
router.get(
  "/",
  requireAuth,
  requireRole("admin", "branch_manager", "cashier"),
  async (req, res) => {
    let { branchId, status } = req.query;
    // أدمن أو موظف السنتر كيتشن يشوفوا طلبيات كل الفروع (عشان ينفذوها) - غيرهم فرعهم بس
    if (req.user.role !== "admin" && !req.user.isCentralKitchen) {
      if (branchId && !assertOwnBranch(req.user, branchId)) {
        return res.status(403).json({ error: "معندكش صلاحية تشوف طلبيات فرع تاني" });
      }
      branchId = req.user.branchId;
    }
    try {
      const orders = await pool.query(
        `SELECT ko.*, b.name AS branch_name
         FROM kitchen_orders ko
         JOIN branches b ON b.id = ko.branch_id
         WHERE ($1::int IS NULL OR ko.branch_id = $1)
           AND ($2::text IS NULL OR ko.status = $2)
         ORDER BY ko.created_at DESC`,
        [branchId || null, status || null]
      );
      const orderIds = orders.rows.map((o) => o.id);
      const items = orderIds.length
        ? (await pool.query(
            `SELECT koi.kitchen_order_id, koi.inventory_item_id, koi.quantity_requested, ii.name, ii.unit
             FROM kitchen_order_items koi
             JOIN inventory_items ii ON ii.id = koi.inventory_item_id
             WHERE koi.kitchen_order_id = ANY($1)`,
            [orderIds]
          )).rows
        : [];
      const result = orders.rows.map((o) => ({
        ...o,
        items: items.filter((it) => it.kitchen_order_id === o.id),
      }));
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

// POST /api/kitchen-orders - فرع بيطلب أصناف من السنتر كيتشن
// {branchId, items: [{inventoryItemId, quantityRequested, quantitySuggested?}], notes, requiredDate?, status?}
// Procurement v2 STEP D: status اختياري وبيقبل بس 'pending' (افتراضي - نفس السلوك القديم بالظبط، عشان
// الشاشات الحالية اللي بتعتمد على status='pending' كطابور تنفيذ فوري تفضل شغالة زي ما هي من غير أي لمس)
// أو 'DRAFT' لو عايز تستخدم دورة الاعتماد الجديدة (submit → approve/reject → ...) - أي قيمة تانية مرفوضة
router.post(
  "/",
  requireAuth,
  requireRole("admin", "branch_manager", "cashier"),
  async (req, res) => {
    const { branchId, items, notes, requiredDate, status, isAutoSuggested } = req.body;
    if (!branchId || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "لازم فرع وأصناف مطلوبة" });
    }
    if (!assertOwnBranch(req.user, branchId)) {
      return res.status(403).json({ error: "معندكش صلاحية تطلب لفرع تاني" });
    }
    const initialStatus = status || "pending";
    if (!["pending", "DRAFT"].includes(initialStatus)) {
      return res.status(400).json({ error: "حالة الإنشاء المسموح بيها بس pending أو DRAFT" });
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const orderResult = await client.query(
        `INSERT INTO kitchen_orders (branch_id, notes, created_by, status, required_date, is_auto_suggested)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [branchId, notes || null, req.user.id, initialStatus, requiredDate || null, !!isAutoSuggested]
      );
      const orderId = orderResult.rows[0].id;
      for (const it of items) {
        await client.query(
          `INSERT INTO kitchen_order_items (kitchen_order_id, inventory_item_id, quantity_requested, quantity_suggested)
           VALUES ($1, $2, $3, $4)`,
          [orderId, it.inventoryItemId, it.quantityRequested, it.quantitySuggested ?? null]
        );
      }
      await client.query("COMMIT");
      res.status(201).json({ orderId });
    } catch (err) {
      await client.query("ROLLBACK");
      res.status(500).json({ error: err.message });
    } finally {
      client.release();
    }
  }
);

// PATCH /api/kitchen-orders/:id - إلغاء طلبية (أدمن أو مدير الفرع الطالب) - **مفيش أي تعديل هنا خالص**،
// نفس السلوك القديم بالظبط (بس من 'pending') عشان الشاشات الحالية اللي بتستخدمه تفضل شغالة زي ما هي.
// الإلغاء بتاع دورة الاعتماد الجديدة (DRAFT/SUBMITTED/APPROVED) له endpoint منفصل: POST /:id/cancel تحت
router.patch("/:id", requireAuth, requireRole("admin", "branch_manager"), async (req, res) => {
  const { status } = req.body;
  if (status !== "cancelled") return res.status(400).json({ error: "التعديل المسموح بيه هنا إلغاء بس" });
  try {
    const existing = await pool.query("SELECT branch_id, status FROM kitchen_orders WHERE id = $1", [req.params.id]);
    if (existing.rows.length === 0) return res.status(404).json({ error: "الطلبية مش موجودة" });
    if (!assertOwnBranch(req.user, existing.rows[0].branch_id)) {
      return res.status(403).json({ error: "معندكش صلاحية تلغي طلبية فرع تاني" });
    }
    if (existing.rows[0].status !== "pending") {
      return res.status(400).json({ error: "الطلبية دي اتنفذت أو اتلغت بالفعل" });
    }
    const result = await pool.query(
      "UPDATE kitchen_orders SET status = 'cancelled' WHERE id = $1 RETURNING *",
      [req.params.id]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// Procurement v2 STEP D: دورة حياة الطلبية الكاملة (Requisition Workflow) - إضافية بالكامل فوق الجدول
// القديم، مش استبدال ليه. DRAFT → SUBMITTED → APPROVED/REJECTED → PREPARING → READY → (IN_TRANSIT عن
// طريق kitchen-transfers.js /issue) → RECEIVED (عن طريق /receive). القيم القديمة (pending/fulfilled/
// cancelled) فضلت شغالة زي ما هي بالظبط لأي طلبية بتستخدمها - الطلبية بتمشي في مسار واحد بس (إما القديم
// أو الجديد) حسب الحالة اللي اتعملها بيها وقت POST / فوق
// ============================================================
const DRAFT_ONLY_STATUS = ["DRAFT"];
const CANCELLABLE_WORKFLOW_STATUSES = ["DRAFT", "SUBMITTED", "APPROVED"];
// الحالات النشطة لدورة الحياة الجديدة - أي طلبية فيها بتتزامن مع kitchen-transfers.js (issue/receive)
// بدل ما تتقفل 'fulfilled' زي الطلبيات القديمة (راجع db/kitchen-order-sync.js تحت)
const NEW_WORKFLOW_ACTIVE_STATUSES = ["DRAFT", "SUBMITTED", "APPROVED", "PREPARING", "READY", "DISPATCHED", "IN_TRANSIT"];

function isCentralKitchenActor(user) {
  return user.role === "admin" || (user.role === "branch_manager" && user.isCentralKitchen);
}

// PATCH /api/kitchen-orders/:id/items - استبدال أصناف/كميات الطلبية بالكامل - DRAFT بس (قبل التقديم)،
// الفرع الطالب أو الأدمن. {items: [{inventoryItemId, quantityRequested, quantitySuggested?}]}
router.patch("/:id/items", requireAuth, requireRole("admin", "branch_manager", "cashier"), async (req, res) => {
  const { items } = req.body;
  if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: "لازم صنف واحد على الأقل" });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const existing = await client.query("SELECT * FROM kitchen_orders WHERE id = $1 FOR UPDATE", [req.params.id]);
    if (existing.rows.length === 0) { await client.query("ROLLBACK"); return res.status(404).json({ error: "الطلبية مش موجودة" }); }
    if (!assertOwnBranch(req.user, existing.rows[0].branch_id)) {
      await client.query("ROLLBACK");
      return res.status(403).json({ error: "معندكش صلاحية تعدّل طلبية فرع تاني" });
    }
    if (!DRAFT_ONLY_STATUS.includes(existing.rows[0].status)) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "التعديل متاح بس والطلبية لسه DRAFT (قبل التقديم)" });
    }
    await client.query("DELETE FROM kitchen_order_items WHERE kitchen_order_id = $1", [req.params.id]);
    for (const it of items) {
      await client.query(
        `INSERT INTO kitchen_order_items (kitchen_order_id, inventory_item_id, quantity_requested, quantity_suggested)
         VALUES ($1, $2, $3, $4)`,
        [req.params.id, it.inventoryItemId, it.quantityRequested, it.quantitySuggested ?? null]
      );
    }
    await client.query("COMMIT");
    res.json({ ok: true });
  } catch (err) {
    await client.query("ROLLBACK");
    res.status(400).json({ error: err.message });
  } finally {
    client.release();
  }
});

// POST /api/kitchen-orders/:id/submit - DRAFT → SUBMITTED (الفرع الطالب أو الأدمن)
router.post("/:id/submit", requireAuth, requireRole("admin", "branch_manager"), async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const existing = await client.query("SELECT * FROM kitchen_orders WHERE id = $1 FOR UPDATE", [req.params.id]);
    if (existing.rows.length === 0) { await client.query("ROLLBACK"); return res.status(404).json({ error: "الطلبية مش موجودة" }); }
    if (!assertOwnBranch(req.user, existing.rows[0].branch_id)) {
      await client.query("ROLLBACK");
      return res.status(403).json({ error: "معندكش صلاحية تقدّم طلبية فرع تاني" });
    }
    if (existing.rows[0].status !== "DRAFT") {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "التقديم متاح بس من حالة DRAFT" });
    }
    const itemCount = await client.query("SELECT COUNT(*)::int AS n FROM kitchen_order_items WHERE kitchen_order_id = $1", [req.params.id]);
    if (itemCount.rows[0].n === 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "مينفعش تقدّم طلبية من غير أصناف" });
    }
    const updated = await client.query(
      `UPDATE kitchen_orders SET status = 'SUBMITTED', submitted_by = $1, submitted_at = now() WHERE id = $2 RETURNING *`,
      [req.user.id, req.params.id]
    );
    await logAudit(client, {
      branchId: existing.rows[0].branch_id, userId: req.user.id, action: "KITCHEN_ORDER_SUBMITTED",
      entityType: "kitchen_order", entityId: Number(req.params.id), req,
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

// POST /api/kitchen-orders/:id/approve - SUBMITTED → APPROVED - السنتر كيتشن (أو الأدمن) بس، مش الفرع
// الطالب نفسه (نفس فلسفة اعتماد التحويل في kitchen-transfers.js: الاعتماد من طرف مستقل)
router.post("/:id/approve", requireAuth, requireRole("admin", "branch_manager"), async (req, res) => {
  if (!isCentralKitchenActor(req.user)) return res.status(403).json({ error: "الاعتماد للسنتر كيتشن أو الأدمن بس" });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const existing = await client.query("SELECT * FROM kitchen_orders WHERE id = $1 FOR UPDATE", [req.params.id]);
    if (existing.rows.length === 0) { await client.query("ROLLBACK"); return res.status(404).json({ error: "الطلبية مش موجودة" }); }
    if (existing.rows[0].status !== "SUBMITTED") {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "الاعتماد متاح بس من حالة SUBMITTED" });
    }
    const updated = await client.query(
      `UPDATE kitchen_orders SET status = 'APPROVED', approved_by = $1, approved_at = now() WHERE id = $2 RETURNING *`,
      [req.user.id, req.params.id]
    );
    await logAudit(client, {
      branchId: existing.rows[0].branch_id, userId: req.user.id, action: "KITCHEN_ORDER_APPROVED",
      entityType: "kitchen_order", entityId: Number(req.params.id), req,
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

// POST /api/kitchen-orders/:id/reject - SUBMITTED → REJECTED - {reason} إلزامي
router.post("/:id/reject", requireAuth, requireRole("admin", "branch_manager"), async (req, res) => {
  if (!isCentralKitchenActor(req.user)) return res.status(403).json({ error: "الرفض للسنتر كيتشن أو الأدمن بس" });
  const { reason } = req.body;
  if (!reason || !String(reason).trim()) return res.status(400).json({ error: "لازم سبب رفض" });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const existing = await client.query("SELECT * FROM kitchen_orders WHERE id = $1 FOR UPDATE", [req.params.id]);
    if (existing.rows.length === 0) { await client.query("ROLLBACK"); return res.status(404).json({ error: "الطلبية مش موجودة" }); }
    if (existing.rows[0].status !== "SUBMITTED") {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "الرفض متاح بس من حالة SUBMITTED" });
    }
    const updated = await client.query(
      `UPDATE kitchen_orders SET status = 'REJECTED', rejected_by = $1, rejected_at = now(), rejection_reason = $2 WHERE id = $3 RETURNING *`,
      [req.user.id, reason, req.params.id]
    );
    await logAudit(client, {
      branchId: existing.rows[0].branch_id, userId: req.user.id, action: "KITCHEN_ORDER_REJECTED",
      entityType: "kitchen_order", entityId: Number(req.params.id), metadata: { reason }, req,
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

// POST /api/kitchen-orders/:id/cancel - DRAFT/SUBMITTED/APPROVED → 'cancelled' (نفس القيمة الطرفية
// القديمة - الفرع الطالب أو الأدمن). بعد PREPARING مفيش إلغاء بسيط (التحضير الفعلي بدأ)
router.post("/:id/cancel", requireAuth, requireRole("admin", "branch_manager"), async (req, res) => {
  const { reason } = req.body;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const existing = await client.query("SELECT * FROM kitchen_orders WHERE id = $1 FOR UPDATE", [req.params.id]);
    if (existing.rows.length === 0) { await client.query("ROLLBACK"); return res.status(404).json({ error: "الطلبية مش موجودة" }); }
    if (!assertOwnBranch(req.user, existing.rows[0].branch_id)) {
      await client.query("ROLLBACK");
      return res.status(403).json({ error: "معندكش صلاحية تلغي طلبية فرع تاني" });
    }
    if (!CANCELLABLE_WORKFLOW_STATUSES.includes(existing.rows[0].status)) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "الطلبية دي مش في حالة قابلة للإلغاء (بدأ تحضيرها أو خلصت بالفعل)" });
    }
    const updated = await client.query(
      `UPDATE kitchen_orders SET status = 'cancelled', cancelled_by = $1, cancelled_at = now(), cancellation_reason = $2 WHERE id = $3 RETURNING *`,
      [req.user.id, reason || null, req.params.id]
    );
    await logAudit(client, {
      branchId: existing.rows[0].branch_id, userId: req.user.id, action: "KITCHEN_ORDER_CANCELLED",
      entityType: "kitchen_order", entityId: Number(req.params.id), metadata: { reason }, req,
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

// POST /api/kitchen-orders/:id/start-preparing - APPROVED → PREPARING - السنتر كيتشن (أو الأدمن) بس
router.post("/:id/start-preparing", requireAuth, requireRole("admin", "branch_manager"), async (req, res) => {
  if (!isCentralKitchenActor(req.user)) return res.status(403).json({ error: "التحضير للسنتر كيتشن أو الأدمن بس" });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const existing = await client.query("SELECT * FROM kitchen_orders WHERE id = $1 FOR UPDATE", [req.params.id]);
    if (existing.rows.length === 0) { await client.query("ROLLBACK"); return res.status(404).json({ error: "الطلبية مش موجودة" }); }
    if (existing.rows[0].status !== "APPROVED") {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "بدء التحضير متاح بس من حالة APPROVED" });
    }
    const updated = await client.query(
      `UPDATE kitchen_orders SET status = 'PREPARING', preparing_started_by = $1, preparing_started_at = now() WHERE id = $2 RETURNING *`,
      [req.user.id, req.params.id]
    );
    await client.query("COMMIT");
    res.json(updated.rows[0]);
  } catch (err) {
    await client.query("ROLLBACK");
    res.status(400).json({ error: err.message });
  } finally {
    client.release();
  }
});

// POST /api/kitchen-orders/:id/ready - PREPARING → READY - جاهزة للتحويل (kitchen-transfers.js /request)
router.post("/:id/ready", requireAuth, requireRole("admin", "branch_manager"), async (req, res) => {
  if (!isCentralKitchenActor(req.user)) return res.status(403).json({ error: "التجهيز للسنتر كيتشن أو الأدمن بس" });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const existing = await client.query("SELECT * FROM kitchen_orders WHERE id = $1 FOR UPDATE", [req.params.id]);
    if (existing.rows.length === 0) { await client.query("ROLLBACK"); return res.status(404).json({ error: "الطلبية مش موجودة" }); }
    if (existing.rows[0].status !== "PREPARING") {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "التجهيز متاح بس من حالة PREPARING" });
    }
    const updated = await client.query(
      `UPDATE kitchen_orders SET status = 'READY', ready_by = $1, ready_at = now() WHERE id = $2 RETURNING *`,
      [req.user.id, req.params.id]
    );
    await client.query("COMMIT");
    res.json(updated.rows[0]);
  } catch (err) {
    await client.query("ROLLBACK");
    res.status(400).json({ error: err.message });
  } finally {
    client.release();
  }
});

// GET /api/kitchen-orders/suggested?branchId=&targetDate=&lookbackWeeks= - Procurement v2 STEP E:
// معاينة بس (مفيش أي تسجيل) لاقتراح الطلبية اليومية - واعي بيوم الأسبوع بتاع targetDate ومبني على متوسط
// الاستهلاك الفعلي في نفس يوم الأسبوع ده آخر lookbackWeeks أسبوع (افتراضي 8). مدير الفرع بعد كده بيستخدم
// النتيجة كـitems في POST / (status:'DRAFT') ويعدّل أي كمية قبل التقديم - الـendpoint ده مايُنشئش أي حاجة
router.get("/suggested", requireAuth, requireRole("admin", "branch_manager", "cashier"), async (req, res) => {
  let { branchId, targetDate, lookbackWeeks } = req.query;
  if (!assertOwnBranch(req.user, branchId) && req.user.role !== "admin") {
    return res.status(403).json({ error: "معندكش صلاحية تشوف اقتراح فرع تاني" });
  }
  if (!branchId) return res.status(400).json({ error: "لازم فرع" });
  if (!targetDate) targetDate = new Date().toISOString().slice(0, 10);
  try {
    const suggestions = await generateSuggestedRequisition(pool, {
      branchId, targetDate, lookbackWeeks: lookbackWeeks ? Number(lookbackWeeks) : 8,
    });
    res.json({ branchId: Number(branchId), targetDate, suggestions });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/kitchen-orders/:id - تفاصيل طلبية واحدة (مطلوب لشاشات دورة الاعتماد الجديدة)
router.get("/:id", requireAuth, requireRole("admin", "branch_manager", "cashier"), async (req, res) => {
  try {
    const order = await pool.query(
      `SELECT ko.*, b.name AS branch_name FROM kitchen_orders ko JOIN branches b ON b.id = ko.branch_id WHERE ko.id = $1`,
      [req.params.id]
    );
    if (order.rows.length === 0) return res.status(404).json({ error: "الطلبية مش موجودة" });
    if (req.user.role !== "admin" && !req.user.isCentralKitchen && !assertOwnBranch(req.user, order.rows[0].branch_id)) {
      return res.status(403).json({ error: "معندكش صلاحية تشوف طلبية فرع تاني" });
    }
    const items = await pool.query(
      `SELECT koi.*, ii.name, ii.unit
       FROM kitchen_order_items koi JOIN inventory_items ii ON ii.id = koi.inventory_item_id
       WHERE koi.kitchen_order_id = $1`,
      [req.params.id]
    );
    res.json({ ...order.rows[0], items: items.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
