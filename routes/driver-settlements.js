// المرحلة 7F: تسوية/تسليم كاش السائق - نفس نمط routes/shifts.js بالظبط (قفل صفوف قبل أي تحقق، مراجعة
// فرق منفصلة عن التسوية نفسها). المنطق كله في db/delivery-engine.js.
const express = require("express");
const router = express.Router();
const pool = require("../db/pool");
const { requireAuth, assertOwnBranch } = require("../middleware/auth");
const { requirePermission, hasPermission } = require("../middleware/permissions");
const { computeDriverUnsettledSummary, createSettlement, reviewSettlement, calcDriverOrderBonus } = require("../db/delivery-engine");

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
    } else if (!hasPermission(req.user, "driver_settlements.create") && !hasPermission(req.user, "driver_settlements.review")) {
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

// المرحلة 8.46: GET /api/driver-settlements/pending-drivers?branchId= - السائقين اللي عندهم كاش معلّق
// تسوية دلوقتي في الفرع بس (مش كل سائقي الفرع) - عشان شاشة "تحصيل مجمع" عند الكاشير تعرض قايمة قصيرة
// ذات صلة بدل ما تسرد كل السائقين وتخليه يدور. نفس صلاحيات المعاينة بالظبط (driver_settlements.create
// أو .review) - الكاشير هيبقى عنده create بس، وده كافي
router.get("/pending-drivers", async (req, res) => {
  const branchId = req.query.branchId || req.user.branchId;
  if (!branchId) return res.status(400).json({ error: "لازم تحدد الفرع" });
  if (!hasPermission(req.user, "driver_settlements.create") && !hasPermission(req.user, "driver_settlements.review")) {
    return res.status(403).json({ error: "معندكش صلاحية تشوف تسويات السائقين" });
  }
  if (!assertOwnBranch(req.user, branchId)) return res.status(403).json({ error: "معندكش صلاحية على فرع تاني" });
  try {
    // المرحلة 8.51: شالت شرط pm.kind = 'cash' من الـ WHERE عشان سائق عنده أوردرات دفع إلكتروني بس (فيزا/
    // محفظة/آجل) معلّقة بونص يظهر في القايمة برضه (مش بس اللي عنده كاش معلّق) - pending_cash فضل محسوب
    // كاش بس (FILTER) عشان الرقم المعروض للكاشير يفضل دقيق (0 للسائق اللي معندوش كاش أصلًا)
    const result = await pool.query(
      `SELECT d.id, d.name, d.driver_code, COUNT(o.id)::int AS pending_order_count,
              COALESCE(SUM(o.collected_amount) FILTER (WHERE pm.kind = 'cash'), 0) AS pending_cash
       FROM drivers d
       JOIN orders o ON o.driver_id = d.id
       JOIN payment_methods pm ON pm.id = o.payment_method_id
       WHERE d.branch_id = $1 AND o.dispatch_status = 'DELIVERED' AND o.driver_settlement_id IS NULL
       GROUP BY d.id, d.name, d.driver_code
       ORDER BY d.name`,
      [branchId]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// المرحلة 8.47: GET /api/driver-settlements/branch-drivers?branchId= - كل سائقي الفرع النشطين (بغض
// النظر لو عندهم كاش معلّق دلوقتي أو لأ) - عكس /pending-drivers عمدًا. لازمة عشان تقرير "كل أوردرات
// السائق" (/driver-orders تحت) لازم يشتغل حتى لو الكاشير حصّل كل كاش السائق بالفعل أثناء اليوم - يعني
// السائق مش هيظهر في /pending-drivers خالص، لكن لسه محتاج تقرير مراجعة شيفته الكامل آخر اليوم
router.get("/branch-drivers", async (req, res) => {
  const branchId = req.query.branchId || req.user.branchId;
  if (!branchId) return res.status(400).json({ error: "لازم تحدد الفرع" });
  if (!hasPermission(req.user, "driver_settlements.create") && !hasPermission(req.user, "driver_settlements.review")) {
    return res.status(403).json({ error: "معندكش صلاحية تشوف السائقين" });
  }
  if (!assertOwnBranch(req.user, branchId)) return res.status(403).json({ error: "معندكش صلاحية على فرع تاني" });
  try {
    const result = await pool.query(
      `SELECT id, name, driver_code FROM drivers WHERE branch_id = $1 AND is_active = TRUE ORDER BY name`,
      [branchId]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// المرحلة 8.47: GET /api/driver-settlements/driver-orders?driverId=&date= - كل أوردرات السائق المُسلَّمة
// في يوم معيّن (النهاردة افتراضيًا) - بغض النظر عن طريقة الدفع أو حالة التحصيل (متحصّلة بالفعل أو لسه
// معلّقة). عكس /preview و/pending-drivers عمدًا (اللي بيوريوا الأوردرات المعلّقة بس عشان التحصيل
// نفسه) - الشاشة دي تقرير مراجعة كامل لشيفت السائق كله، لأن قفل شيفت السائق وحساب/دفع بونصه بيحصل
// مرة واحدة آخر الشيفت مش مع كل تحصيل جزئي حصل أثناء اليوم. delivered_at::date هو مرجع "اليوم" هنا
// (مش created_at) - وقت التسليم الفعلي هو اللي بيحدد شيفت السائق، مش وقت إنشاء الطلب
router.get("/driver-orders", async (req, res) => {
  const { driverId, date } = req.query;
  if (!driverId) return res.status(400).json({ error: "لازم تحدد السائق" });
  try {
    const driverRes = await pool.query("SELECT * FROM drivers WHERE id = $1", [driverId]);
    if (driverRes.rows.length === 0) return res.status(404).json({ error: "السائق مش موجود" });
    const driver = driverRes.rows[0];

    if (req.user.role === "driver") {
      const own = await loadOwnDriver(pool, req.user.id);
      if (!own || own.id !== driver.id) return res.status(403).json({ error: "معندكش صلاحية تشوف أوردرات سائق تاني" });
    } else if (!hasPermission(req.user, "driver_settlements.create") && !hasPermission(req.user, "driver_settlements.review")) {
      return res.status(403).json({ error: "معندكش صلاحية تشوف أوردرات السائقين" });
    } else if (!assertOwnBranch(req.user, driver.branch_id)) {
      return res.status(403).json({ error: "معندكش صلاحية على فرع تاني" });
    }

    const result = await pool.query(
      `SELECT o.id, o.total, o.delivery_fee, o.collected_amount, o.collection_variance, o.delivered_at,
              o.order_type, o.driver_settlement_id, pm.kind AS payment_kind, pm.name AS payment_method_name
       FROM orders o
       LEFT JOIN payment_methods pm ON pm.id = o.payment_method_id
       WHERE o.driver_id = $1 AND o.dispatch_status = 'DELIVERED'
         AND o.delivered_at::date = COALESCE($2::date, CURRENT_DATE)
       ORDER BY o.delivered_at`,
      [driverId, date || null]
    );
    // المرحلة 8.51: collected بقى بيتحسب من driver_settlement_id مباشرة (مش مقصور على الكاش) عشان
    // بونص الأوردرات غير الكاش يدخل صح في collectedBonusTotal/pendingBonusTotal تحت - التسوية نفسها
    // بقت بتقفل كل الأوردرات المُسلَّمة (delivery-engine.js createSettlement)، مش الكاش بس
    const orders = result.rows.map((o) => ({
      ...o,
      bonus: calcDriverOrderBonus(o.delivery_fee || 0),
      collected: o.driver_settlement_id !== null,
    }));
    const bonusTotal = orders.reduce((s, o) => s + o.bonus, 0);
    const cashOrders = orders.filter((o) => o.payment_kind === "cash");
    res.json({
      driverId: Number(driverId), driverName: driver.name, driverCode: driver.driver_code,
      date: date || new Date().toISOString().slice(0, 10),
      orders,
      orderCount: orders.length,
      deliveryFeesTotal: orders.reduce((s, o) => s + Number(o.delivery_fee || 0), 0),
      bonusTotal,
      collectedBonusTotal: orders.filter((o) => o.collected === true).reduce((s, o) => s + o.bonus, 0),
      pendingBonusTotal: orders.filter((o) => o.collected === false).reduce((s, o) => s + o.bonus, 0),
      cashPendingCount: cashOrders.filter((o) => o.collected === false).length,
      cashCollectedCount: cashOrders.filter((o) => o.collected === true).length,
    });
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
      actualHandover: Number(actualHandover), notes, thresholds, driverEmployeeId: driver.employee_id,
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
  } else if (hasPermission(req.user, "driver_settlements.create") || hasPermission(req.user, "driver_settlements.review")) {
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
    } else if (!hasPermission(req.user, "driver_settlements.create") && !hasPermission(req.user, "driver_settlements.review")) {
      return res.status(403).json({ error: "معندكش صلاحية تشوف تسويات السائقين" });
    } else if (!assertOwnBranch(req.user, settlement.branch_id)) {
      return res.status(403).json({ error: "معندكش صلاحية على فرع تاني" });
    }
    // المرحلة 8.46: delivery_fee لكل طلب اتضافت هنا عشان الإيصال/التقرير يقدر يعرض البونص المحسوب لكل
    // طلب (calcDriverOrderBonus) - نفس منطق التسوية بالظبط، محسوب لايف من delivery_fee مش مخزّن مكرر
    const orders = await pool.query(
      `SELECT id, total, collected_amount, collection_variance, delivery_fee, delivered_at
       FROM orders WHERE driver_settlement_id = $1 ORDER BY delivered_at`,
      [req.params.id]
    );
    const ordersWithBonus = orders.rows.map((o) => ({ ...o, bonus: calcDriverOrderBonus(o.delivery_fee || 0) }));
    res.json({ ...settlement, orders: ordersWithBonus });
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
