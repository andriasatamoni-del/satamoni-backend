// المرحلة 7F: تسوية/تسليم كاش السائق - نفس نمط routes/shifts.js بالظبط (قفل صفوف قبل أي تحقق، مراجعة
// فرق منفصلة عن التسوية نفسها). المنطق كله في db/delivery-engine.js.
const express = require("express");
const router = express.Router();
const pool = require("../db/pool");
const { requireAuth, assertOwnBranch } = require("../middleware/auth");
const { requirePermission, hasPermission } = require("../middleware/permissions");
const { computeDriverUnsettledSummary, createSettlement, reviewSettlement } = require("../db/delivery-engine");

router.use(requireAuth);

async function getThresholds(executor) {
  const r = await executor.query(
    "SELECT driver_settlement_variance_ack_threshold_egp, driver_settlement_variance_review_threshold_egp FROM pos_settings WHERE id = 1"
  );
  return {
    ackThreshold: Number(r.rows[0]?.driver_settlement_variance_ack_threshold_egp ?? 30),
    reviewThreshold: Number(r.rows[0]?.driver_settlement_variance_review_threshold_egp ?? 150),
  };
}

async function loadOwnDriver(executor, userId) {
  const r = await executor.query("SELECT * FROM drivers WHERE user_id = $1", [userId]);
  return r.rows[0] || null;
}

// GET /api/driver-settlements/preview?driverId= - معاينة الدفعة المعلّقة قبل التسوية الفعلية
router.get("/preview", async (req, res) => {
  const { driverId } = req.query;
  if (!driverId) return res.status(400).json({ error: "لازم تحدد السائق" });
  try {
    const driverRes = await pool.query("SELECT * FROM drivers WHERE id = $1", [driverId]);
    if (driverRes.rows.length === 0) return res.status(404).json({ error: "السائق مش موجود" });
    const driver = driverRes.rows[0];

    if (req.user.role === "driver") {
      const own = await loadOwnDriver(pool, req.user.id);
      if (!own || own.id !== driver.id) return res.status(403).json({ error: "معندكش صلاحية تشوف تسوية سائق تاني" });
    } else if (!hasPermission(req.user.role, "driver_settlements.create") && !hasPermission(req.user.role, "driver_settlements.review")) {
      return res.status(403).json({ error: "معندكش صلاحية تشوف تسويات السائقين" });
    } else if (!assertOwnBranch(req.user, driver.branch_id)) {
      return res.status(403).json({ error: "معندكش صلاحية على فرع تاني" });
    }

    const summary = await computeDriverUnsettledSummary(pool, driverId);
    res.json(summary);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/driver-settlements - {driverId, actualHandover, notes?}
router.post("/", requirePermission("driver_settlements.create"), async (req, res) => {
  const { driverId, actualHandover, notes } = req.body;
  if (!driverId) return res.status(400).json({ error: "لازم تحدد السائق" });
  if (actualHandover === undefined || actualHandover === null || Number(actualHandover) < 0 || Number.isNaN(Number(actualHandover))) {
    return res.status(400).json({ error: "قيمة الكاش المُسلَّم غير صالحة" });
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const driverRes = await client.query("SELECT * FROM drivers WHERE id = $1", [driverId]);
    if (driverRes.rows.length === 0) { await client.query("ROLLBACK"); return res.status(404).json({ error: "السائق مش موجود" }); }
    const driver = driverRes.rows[0];
    if (!assertOwnBranch(req.user, driver.branch_id)) {
      await client.query("ROLLBACK");
      return res.status(403).json({ error: "معندكش صلاحية على فرع تاني" });
    }
    const thresholds = await getThresholds(client);
    const settlement = await createSettlement(client, {
      driverId, branchId: driver.branch_id, settledByUserId: req.user.id,
      actualHandover: Number(actualHandover), notes, thresholds,
    });
    await client.query("COMMIT");
    res.status(201).json(settlement);
  } catch (err) {
    await client.query("ROLLBACK");
    if (err.code === "NOTHING_TO_SETTLE") return res.status(400).json({ error: err.message });
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// GET /api/driver-settlements?driverId=&branchId=&status=
router.get("/", async (req, res) => {
  const conditions = [];
  const values = [];
  let i = 1;

  if (req.user.role === "driver") {
    const own = await loadOwnDriver(pool, req.user.id);
    if (!own) return res.status(400).json({ error: "معندكش سجل سائق مرتبط بالحساب ده" });
    conditions.push(`ds.driver_id = $${i++}`); values.push(own.id);
  } else if (hasPermission(req.user.role, "driver_settlements.create") || hasPermission(req.user.role, "driver_settlements.review")) {
    const branchId = req.query.branchId || req.user.branchId;
    if (!branchId) return res.status(400).json({ error: "لازم تحدد الفرع" });
    if (!assertOwnBranch(req.user, branchId)) return res.status(403).json({ error: "معندكش صلاحية على فرع تاني" });
    conditions.push(`ds.branch_id = $${i++}`); values.push(branchId);
    if (req.query.driverId) { conditions.push(`ds.driver_id = $${i++}`); values.push(req.query.driverId); }
  } else {
    return res.status(403).json({ error: "معندكش صلاحية تشوف تسويات السائقين" });
  }
  if (req.query.status) { conditions.push(`ds.variance_status = $${i++}`); values.push(req.query.status); }

  try {
    const result = await pool.query(
      `SELECT ds.*, d.name AS driver_name, d.driver_code
       FROM driver_settlements ds JOIN drivers d ON d.id = ds.driver_id
       WHERE ${conditions.join(" AND ")}
       ORDER BY ds.settled_at DESC
       LIMIT 200`,
      values
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/driver-settlements/:id
router.get("/:id", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT ds.*, d.name AS driver_name, d.driver_code
       FROM driver_settlements ds JOIN drivers d ON d.id = ds.driver_id WHERE ds.id = $1`,
      [req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: "التسوية مش موجودة" });
    const settlement = result.rows[0];
    if (req.user.role === "driver") {
      const own = await loadOwnDriver(pool, req.user.id);
      if (!own || own.id !== settlement.driver_id) return res.status(403).json({ error: "التسوية دي مش بتاعتك" });
    } else if (!hasPermission(req.user.role, "driver_settlements.create") && !hasPermission(req.user.role, "driver_settlements.review")) {
      return res.status(403).json({ error: "معندكش صلاحية تشوف تسويات السائقين" });
    } else if (!assertOwnBranch(req.user, settlement.branch_id)) {
      return res.status(403).json({ error: "معندكش صلاحية على فرع تاني" });
    }
    const orders = await pool.query(
      `SELECT id, total, collected_amount, collection_variance, delivered_at FROM orders WHERE driver_settlement_id = $1 ORDER BY delivered_at`,
      [req.params.id]
    );
    res.json({ ...settlement, orders: orders.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/driver-settlements/:id/review - {decision, notes?}
router.post("/:id/review", requirePermission("driver_settlements.review"), async (req, res) => {
  const { decision, notes } = req.body;
  if (!["approve", "acknowledge"].includes(decision)) {
    return res.status(400).json({ error: "القرار لازم يكون approve أو acknowledge" });
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const settlementRes = await client.query("SELECT * FROM driver_settlements WHERE id = $1 FOR UPDATE", [req.params.id]);
    if (settlementRes.rows.length === 0) { await client.query("ROLLBACK"); return res.status(404).json({ error: "التسوية مش موجودة" }); }
    const settlement = settlementRes.rows[0];
    if (!assertOwnBranch(req.user, settlement.branch_id)) {
      await client.query("ROLLBACK");
      return res.status(403).json({ error: "معندكش صلاحية على فرع تاني" });
    }
    const reviewed = await reviewSettlement(client, { settlement, reviewerId: req.user.id, decision, notes });
    await client.query("COMMIT");
    res.json(reviewed);
  } catch (err) {
    await client.query("ROLLBACK");
    if (err.code === "SETTLEMENT_NOT_PENDING_REVIEW") return res.status(400).json({ error: err.message });
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

module.exports = router;
