// المرحلة 8.48: حضور وأجر السائقين بالساعة - تسجيل دخول/خروج يدوي من الكاشير. المنطق كله في
// db/driver-shift-engine.js - الملف ده بس طبقة HTTP/صلاحيات/قفل فوقه، نفس نمط routes/shifts.js
// وroutes/driver-settlements.js بالظبط.
const express = require("express");
const router = express.Router();
const pool = require("../db/pool");
const { requireAuth, assertOwnBranch } = require("../middleware/auth");
const { requirePermission } = require("../middleware/permissions");
const { checkInDriver, checkOutDriver } = require("../db/driver-shift-engine");
const { validateIdParam } = require("../middleware/validate-id-param");

router.use(requireAuth);
router.param("id", validateIdParam);

async function getHourlyRate(executor) {
  const r = await executor.query("SELECT driver_hourly_rate_egp FROM pos_settings WHERE id = 1");
  return Number(r.rows[0]?.driver_hourly_rate_egp ?? 33);
}

// GET /api/driver-shifts/active?branchId= - السائقين اللي شيفتهم شغالة دلوقتي في الفرع
router.get("/active", requirePermission("driver_shifts.manage"), async (req, res) => {
  const branchId = req.query.branchId || req.user.branchId;
  if (!branchId) return res.status(400).json({ error: "لازم تحدد الفرع" });
  if (!assertOwnBranch(req.user, branchId)) return res.status(403).json({ error: "معندكش صلاحية على فرع تاني" });
  try {
    const result = await pool.query(
      `SELECT ds.*, d.name AS driver_name, d.driver_code
       FROM driver_shifts ds JOIN drivers d ON d.id = ds.driver_id
       WHERE ds.branch_id = $1 AND ds.status = 'ACTIVE'
       ORDER BY ds.checked_in_at`,
      [branchId]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/driver-shifts/check-in - {driverId}
router.post("/check-in", requirePermission("driver_shifts.manage"), async (req, res) => {
  const { driverId } = req.body;
  if (!driverId) return res.status(400).json({ error: "لازم تحدد السائق" });
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
    const hourlyRate = await getHourlyRate(client);
    const shift = await checkInDriver(client, {
      driverId, branchId: driver.branch_id, checkedInByUserId: req.user.id, hourlyRate,
    });
    await client.query("COMMIT");
    res.status(201).json(shift);
  } catch (err) {
    await client.query("ROLLBACK");
    if (err.code === "DRIVER_SHIFT_ALREADY_ACTIVE") return res.status(409).json({ error: err.message });
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// POST /api/driver-shifts/:id/check-out - {notes?}
router.post("/:id/check-out", requirePermission("driver_shifts.manage"), async (req, res) => {
  const { notes } = req.body;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const shiftRes = await client.query("SELECT * FROM driver_shifts WHERE id = $1 FOR UPDATE", [req.params.id]);
    if (shiftRes.rows.length === 0) { await client.query("ROLLBACK"); return res.status(404).json({ error: "الشيفت مش موجود" }); }
    const driverShift = shiftRes.rows[0];
    if (!assertOwnBranch(req.user, driverShift.branch_id)) {
      await client.query("ROLLBACK");
      return res.status(403).json({ error: "معندكش صلاحية على فرع تاني" });
    }
    const result = await checkOutDriver(client, { driverShift, checkedOutByUserId: req.user.id, notes });
    await client.query("COMMIT");
    res.json(result.shift);
  } catch (err) {
    await client.query("ROLLBACK");
    if (["DRIVER_SHIFT_NOT_ACTIVE", "NO_CASH_PAYMENT_METHOD", "WAGE_EXPENSE_CATEGORY_MISSING"].includes(err.code)) {
      return res.status(400).json({ error: err.message, code: err.code });
    }
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// GET /api/driver-shifts?branchId=&driverId=&status= - سجل شيفتات الحضور (تاريخي)
router.get("/", requirePermission("driver_shifts.manage"), async (req, res) => {
  const branchId = req.query.branchId || req.user.branchId;
  if (!branchId) return res.status(400).json({ error: "لازم تحدد الفرع" });
  if (!assertOwnBranch(req.user, branchId)) return res.status(403).json({ error: "معندكش صلاحية على فرع تاني" });
  const conditions = ["ds.branch_id = $1"];
  const values = [branchId];
  let i = 2;
  if (req.query.driverId) { conditions.push(`ds.driver_id = $${i++}`); values.push(req.query.driverId); }
  if (req.query.status) { conditions.push(`ds.status = $${i++}`); values.push(req.query.status); }
  try {
    const result = await pool.query(
      `SELECT ds.*, d.name AS driver_name, d.driver_code
       FROM driver_shifts ds JOIN drivers d ON d.id = ds.driver_id
       WHERE ${conditions.join(" AND ")}
       ORDER BY ds.checked_in_at DESC
       LIMIT 200`,
      values
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/driver-shifts/:id
router.get("/:id", requirePermission("driver_shifts.manage"), async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT ds.*, d.name AS driver_name, d.driver_code
       FROM driver_shifts ds JOIN drivers d ON d.id = ds.driver_id WHERE ds.id = $1`,
      [req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: "الشيفت مش موجود" });
    const shift = result.rows[0];
    if (!assertOwnBranch(req.user, shift.branch_id)) return res.status(403).json({ error: "معندكش صلاحية على فرع تاني" });
    res.json(shift);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
