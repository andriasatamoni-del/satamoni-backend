// المرحلة 7F: لوحة التوزيع + دورة حياة التوصيل - كل عملية تغيير حالة هنا بتقفل صف الطلب (FOR UPDATE)
// جوه transaction قبل أي تحقق، نفس نمط routes/shifts.js وroutes/orders.js بالظبط. المنطق الحسابي/انتقال
// الحالات كله في db/delivery-engine.js - الملف ده بس طبقة HTTP/صلاحيات/عزل فروع/قفل فوقه.
const express = require("express");
const router = express.Router();
const pool = require("../db/pool");
const { requireAuth, assertOwnBranch } = require("../middleware/auth");
const { requirePermission, hasPermission } = require("../middleware/permissions");
const {
  assignDriver, unassignDriver, markOutForDelivery, markDelivered, markFailed, rescheduleFailed,
} = require("../db/delivery-engine");
const { queueDeliveryHandoverPrintJobs } = require("../db/print-queue");

router.use(requireAuth);

async function loadOwnDriver(executor, userId) {
  const r = await executor.query("SELECT * FROM drivers WHERE user_id = $1", [userId]);
  return r.rows[0] || null;
}

// السائق بيتصرف في طلبه هو بس (drivers.user_id = req.user.id) - أو مدير/أدمن بصلاحية deliveries.assign
// على نفس فرع الطلب. الدالة دي بترجع {allowed, isDriverSelf} أو ترمي 403/404 مباشرة على res
async function authorizeDeliveryAction(client, req, res, order) {
  if (req.user.role === "driver") {
    const driver = await loadOwnDriver(client, req.user.id);
    if (!driver || order.driver_id !== driver.id) {
      res.status(403).json({ error: "الطلب ده مش مُسند لك" });
      return null;
    }
    return { isDriverSelf: true };
  }
  if (!hasPermission(req.user.role, "deliveries.assign")) {
    res.status(403).json({ error: "معندكش صلاحية تعمل الإجراء ده" });
    return null;
  }
  if (!assertOwnBranch(req.user, order.branch_id)) {
    res.status(403).json({ error: "معندكش صلاحية على فرع تاني" });
    return null;
  }
  return { isDriverSelf: false };
}

// GET /api/deliveries?branchId=&status=&driverId=&date=&paymentMethod= - لوحة التوزيع (مدير فرع/محاسب/أدمن)
router.get("/", requirePermission("deliveries.view_branch"), async (req, res) => {
  const branchId = req.query.branchId || req.user.branchId;
  if (!branchId) return res.status(400).json({ error: "لازم تحدد الفرع" });
  if (!assertOwnBranch(req.user, branchId)) {
    return res.status(403).json({ error: "معندكش صلاحية تشوف فرع تاني" });
  }
  const conditions = ["o.branch_id = $1", "o.order_type = 'delivery'"];
  const values = [branchId];
  let i = 2;
  if (req.query.status) { conditions.push(`o.dispatch_status = $${i++}`); values.push(req.query.status); }
  if (req.query.driverId) { conditions.push(`o.driver_id = $${i++}`); values.push(req.query.driverId); }
  if (req.query.date) { conditions.push(`DATE(o.created_at) = $${i++}`); values.push(req.query.date); }
  if (req.query.paymentMethod) { conditions.push(`pm.kind = $${i++}`); values.push(req.query.paymentMethod); }
  try {
    const result = await pool.query(
      `SELECT o.id, o.customer_name, o.customer_phone, o.address_details, o.delivery_fee, o.total,
              o.payment_status, o.status, o.dispatch_status, o.driver_id, o.driver_name,
              o.assigned_at, o.delivered_at, o.delivery_failed_at, o.delivery_failure_reason,
              o.created_at, pm.name AS payment_method_name, pm.kind AS payment_kind,
              da.name AS delivery_area_name
       FROM orders o
       LEFT JOIN payment_methods pm ON pm.id = o.payment_method_id
       LEFT JOIN delivery_areas da ON da.id = o.delivery_area_id
       WHERE ${conditions.join(" AND ")}
       ORDER BY o.created_at DESC
       LIMIT 300`,
      values
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/deliveries/mine?includeCompleted= - طلبات السائق نفسه بس
router.get("/mine", requirePermission("deliveries.view_own"), async (req, res) => {
  try {
    const driver = await loadOwnDriver(pool, req.user.id);
    if (!driver) return res.status(400).json({ error: "معندكش سجل سائق مرتبط بالحساب ده" });
    const statuses = req.query.includeCompleted === "true"
      ? ["ASSIGNED", "OUT_FOR_DELIVERY", "FAILED", "DELIVERED", "RETURNED"]
      : ["ASSIGNED", "OUT_FOR_DELIVERY", "FAILED"];
    const result = await pool.query(
      `SELECT o.id, o.customer_name, o.customer_phone, o.address_details, c.distinguishing_mark,
              o.delivery_fee, o.total, o.payment_status, o.dispatch_status,
              o.assigned_at, o.delivered_at, o.delivery_failed_at, o.delivery_failure_reason,
              o.collected_amount, o.collection_variance,
              pm.name AS payment_method_name, pm.kind AS payment_kind, da.name AS delivery_area_name
       FROM orders o
       LEFT JOIN payment_methods pm ON pm.id = o.payment_method_id
       LEFT JOIN delivery_areas da ON da.id = o.delivery_area_id
       LEFT JOIN customers c ON c.phone = o.customer_phone
       WHERE o.driver_id = $1 AND o.dispatch_status = ANY($2::text[])
       ORDER BY o.assigned_at DESC NULLS LAST, o.created_at DESC
       LIMIT 100`,
      [driver.id, statuses]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/deliveries/:orderId
router.get("/:orderId", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT o.*, pm.name AS payment_method_name, pm.kind AS payment_kind, da.name AS delivery_area_name
       FROM orders o
       LEFT JOIN payment_methods pm ON pm.id = o.payment_method_id
       LEFT JOIN delivery_areas da ON da.id = o.delivery_area_id
       WHERE o.id = $1`,
      [req.params.orderId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: "الطلب مش موجود" });
    const order = result.rows[0];
    if (req.user.role === "driver") {
      const driver = await loadOwnDriver(pool, req.user.id);
      if (!driver || order.driver_id !== driver.id) {
        return res.status(403).json({ error: "الطلب ده مش مُسند لك" });
      }
    } else if (!hasPermission(req.user.role, "deliveries.view_branch")) {
      return res.status(403).json({ error: "معندكش صلاحية تشوف الطلب ده" });
    } else if (!assertOwnBranch(req.user, order.branch_id)) {
      return res.status(403).json({ error: "معندكش صلاحية على فرع تاني" });
    }
    res.json(order);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/deliveries/:orderId/assign - {driverId}
router.post("/:orderId/assign", requirePermission("deliveries.assign"), async (req, res) => {
  const { driverId } = req.body;
  if (!driverId) return res.status(400).json({ error: "لازم تحدد السائق" });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const orderRes = await client.query("SELECT * FROM orders WHERE id = $1 FOR UPDATE", [req.params.orderId]);
    if (orderRes.rows.length === 0) { await client.query("ROLLBACK"); return res.status(404).json({ error: "الطلب مش موجود" }); }
    const order = orderRes.rows[0];
    if (!assertOwnBranch(req.user, order.branch_id)) {
      await client.query("ROLLBACK");
      return res.status(403).json({ error: "معندكش صلاحية على فرع تاني" });
    }
    const driverRes = await client.query("SELECT * FROM drivers WHERE id = $1", [driverId]);
    if (driverRes.rows.length === 0) { await client.query("ROLLBACK"); return res.status(404).json({ error: "السائق مش موجود" }); }

    const updated = await assignDriver(client, { order, driver: driverRes.rows[0], assignedByUserId: req.user.id });
    await client.query("COMMIT");
    res.json(updated);
  } catch (err) {
    await client.query("ROLLBACK");
    const knownErrors = ["NOT_DELIVERY_ORDER", "INVALID_DELIVERY_TRANSITION", "DRIVER_BRANCH_MISMATCH", "DRIVER_NOT_AVAILABLE"];
    if (knownErrors.includes(err.code)) return res.status(400).json({ error: err.message });
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// POST /api/deliveries/:orderId/unassign
router.post("/:orderId/unassign", requirePermission("deliveries.assign"), async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const orderRes = await client.query("SELECT * FROM orders WHERE id = $1 FOR UPDATE", [req.params.orderId]);
    if (orderRes.rows.length === 0) { await client.query("ROLLBACK"); return res.status(404).json({ error: "الطلب مش موجود" }); }
    const order = orderRes.rows[0];
    if (!assertOwnBranch(req.user, order.branch_id)) {
      await client.query("ROLLBACK");
      return res.status(403).json({ error: "معندكش صلاحية على فرع تاني" });
    }
    const updated = await unassignDriver(client, { order, actorUserId: req.user.id });
    await client.query("COMMIT");
    res.json(updated);
  } catch (err) {
    await client.query("ROLLBACK");
    if (err.code === "INVALID_DELIVERY_TRANSITION") return res.status(400).json({ error: err.message });
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// POST /api/deliveries/:orderId/out-for-delivery - السائق نفسه أو مدير الفرع
router.post("/:orderId/out-for-delivery", async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const orderRes = await client.query("SELECT * FROM orders WHERE id = $1 FOR UPDATE", [req.params.orderId]);
    if (orderRes.rows.length === 0) { await client.query("ROLLBACK"); return res.status(404).json({ error: "الطلب مش موجود" }); }
    const order = orderRes.rows[0];
    const auth = await authorizeDeliveryAction(client, req, res, order);
    if (!auth) { await client.query("ROLLBACK"); return; }
    const updated = await markOutForDelivery(client, { order, actorUserId: req.user.id });
    // نظام الطباعة: إيصال دليفري نهائي (فيه سعر) لحظة تسليم الطلب فعليًا للسائق - هو اللي هيسلّمه للعميل
    await queueDeliveryHandoverPrintJobs(client, { orderId: order.id, createdBy: req.user.id });
    await client.query("COMMIT");
    res.json(updated);
  } catch (err) {
    await client.query("ROLLBACK");
    if (err.code === "INVALID_DELIVERY_TRANSITION") return res.status(400).json({ error: err.message });
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// POST /api/deliveries/:orderId/delivered - {collectedAmount?} - السائق نفسه أو مدير الفرع
router.post("/:orderId/delivered", async (req, res) => {
  const { collectedAmount } = req.body;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const orderRes = await client.query("SELECT * FROM orders WHERE id = $1 FOR UPDATE", [req.params.orderId]);
    if (orderRes.rows.length === 0) { await client.query("ROLLBACK"); return res.status(404).json({ error: "الطلب مش موجود" }); }
    const order = orderRes.rows[0];
    const auth = await authorizeDeliveryAction(client, req, res, order);
    if (!auth) { await client.query("ROLLBACK"); return; }
    const updated = await markDelivered(client, { order, actorUserId: req.user.id, collectedAmount });
    await client.query("COMMIT");
    res.json(updated);
  } catch (err) {
    await client.query("ROLLBACK");
    if (["INVALID_DELIVERY_TRANSITION", "COLLECTED_AMOUNT_REQUIRED"].includes(err.code)) {
      return res.status(400).json({ error: err.message });
    }
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// POST /api/deliveries/:orderId/failed - {reason} - السائق نفسه أو مدير الفرع
router.post("/:orderId/failed", async (req, res) => {
  const { reason } = req.body;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const orderRes = await client.query("SELECT * FROM orders WHERE id = $1 FOR UPDATE", [req.params.orderId]);
    if (orderRes.rows.length === 0) { await client.query("ROLLBACK"); return res.status(404).json({ error: "الطلب مش موجود" }); }
    const order = orderRes.rows[0];
    const auth = await authorizeDeliveryAction(client, req, res, order);
    if (!auth) { await client.query("ROLLBACK"); return; }
    const updated = await markFailed(client, { order, actorUserId: req.user.id, reason });
    await client.query("COMMIT");
    res.json(updated);
  } catch (err) {
    await client.query("ROLLBACK");
    if (["INVALID_DELIVERY_TRANSITION", "INVALID_FAILURE_REASON"].includes(err.code)) {
      return res.status(400).json({ error: err.message });
    }
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// POST /api/deliveries/:orderId/reschedule - إعادة جدولة بعد فشل (مدير/أدمن بس - قرار تشغيلي)
router.post("/:orderId/reschedule", requirePermission("deliveries.assign"), async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const orderRes = await client.query("SELECT * FROM orders WHERE id = $1 FOR UPDATE", [req.params.orderId]);
    if (orderRes.rows.length === 0) { await client.query("ROLLBACK"); return res.status(404).json({ error: "الطلب مش موجود" }); }
    const order = orderRes.rows[0];
    if (!assertOwnBranch(req.user, order.branch_id)) {
      await client.query("ROLLBACK");
      return res.status(403).json({ error: "معندكش صلاحية على فرع تاني" });
    }
    const updated = await rescheduleFailed(client, { order, actorUserId: req.user.id });
    await client.query("COMMIT");
    res.json(updated);
  } catch (err) {
    await client.query("ROLLBACK");
    if (err.code === "INVALID_DELIVERY_TRANSITION") return res.status(400).json({ error: err.message });
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

module.exports = router;
