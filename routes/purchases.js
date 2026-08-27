const express = require("express");
const router = express.Router();
const pool = require("../db/pool");
const { requireAuth, requireRole, assertOwnBranch } = require("../middleware/auth");
const { requirePermission } = require("../middleware/permissions");
const { logAudit } = require("../db/audit");

const canManage = requireRole("admin", "accountant", "branch_manager");

// GET /api/purchases?branchId=&date=&status= - الكاشير (المرحلة 7K) يشوف مشتريات فرعه بس، زي مدير الفرع بالظبط
router.get(
  "/",
  requireAuth,
  requirePermission("purchases.view", "purchases.view_own_daily"),
  async (req, res) => {
    let { branchId, date, status } = req.query;
    if (req.user.role === "branch_manager" || req.user.role === "cashier") {
      if (branchId && !assertOwnBranch(req.user, branchId)) {
        return res.status(403).json({ error: "معندكش صلاحية تشوف مشتريات فرع تاني" });
      }
      branchId = req.user.branchId;
    }
    try {
      const result = await pool.query(
        `SELECT * FROM purchases
         WHERE ($1::int IS NULL OR branch_id = $1)
           AND ($2::date IS NULL OR business_date = $2)
           AND ($3::text IS NULL OR status = $3)
         ORDER BY business_date DESC, id DESC`,
        [branchId || null, date || null, status || null]
      );
      res.json(result.rows);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

// POST /api/purchases - تسجيل مشترى (فرع أو سنتر كيتشن)
//
// المرحلة 7K: الكاشير (purchases.create_own_daily بس) بيقدر يسجل مشترى نقدي - مقفول بالكامل على
// فرعه/النهاردة بس (مفروضة من السيرفر، مش من العميل)، وحالته دايمًا PENDING (محتاج مراجعة مدير/محاسب
// عبر /:id/confirm أو /:id/reject قبل ما يتحسب رسميًا في التقارير المالية). المدير/المحاسب لسه بيسجلوا
// مباشرة CONFIRMED زي الأول بالظبط - مفيش تغيير في سلوكهم
router.post(
  "/",
  requireAuth,
  requirePermission("purchases.create", "purchases.create_own_daily"),
  async (req, res) => {
    const isCashierDaily = req.user.role === "cashier";
    let { branchId, businessDate, category, amount, fromKitchen = false, notes } = req.body;

    if (isCashierDaily) {
      branchId = req.user.branchId;
      businessDate = new Date().toISOString().slice(0, 10);
      fromKitchen = false;
    }
    if (!branchId || !businessDate || !amount) {
      return res.status(400).json({ error: "بيانات ناقصة" });
    }
    if (req.user.role === "branch_manager" && !assertOwnBranch(req.user, branchId)) {
      return res.status(403).json({ error: "معندكش صلاحية تسجل مشترى على فرع تاني" });
    }
    const status = isCashierDaily ? "PENDING" : "CONFIRMED";

    try {
      const result = await pool.query(
        `INSERT INTO purchases (branch_id, business_date, category, amount, from_kitchen, notes, status, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
        [branchId, businessDate, category || null, amount, fromKitchen, notes || null, status, req.user.id]
      );
      await logAudit(pool, {
        branchId, userId: req.user.id, action: "PURCHASE_CREATED", entityType: "purchase", entityId: result.rows[0].id,
        newValues: { amount, category, status }, req,
      });
      res.status(201).json(result.rows[0]);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

// المرحلة 7K: POST /api/purchases/:id/confirm - PENDING → CONFIRMED - مدير الفرع/المحاسب بيراجع
// مشترى الكاشير النقدي ويأكّده - بعدها بس بيتحسب رسميًا في تقارير المشتريات/تحليل التكلفة
//
// المرحلة 7U: قبل كده كانت القراءة والتحديث في نداءين منفصلين من غير أي قفل (زي purchase_returns.js/
// expenses.js/driver_settlements.js بالظبط اللي بيستخدموا BEGIN + SELECT...FOR UPDATE) - يعني نافذة
// سباق حقيقية: confirm وreject متزامنين (أو confirm مرتين) كانوا يقدروا الاتنين يعدّوا فحص "لسه PENDING"
// قبل ما أي حد يكتب، فالاتنين ينجحوا (200) والنتيجة النهائية تبقى عشوائية حسب مين كتب أخيرًا - اتكشفت
// وثبتت بتدقيق 7U (tests/phase7u-audit.test.js)، مصلّحة هنا بنفس نمط الأقفال المستخدم في كل مكان تاني
router.post("/:id/confirm", requireAuth, requirePermission("purchases.review"), async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const existing = await client.query("SELECT * FROM purchases WHERE id = $1 FOR UPDATE", [req.params.id]);
    if (existing.rows.length === 0) { await client.query("ROLLBACK"); return res.status(404).json({ error: "المشترى مش موجود" }); }
    const purchase = existing.rows[0];
    if (purchase.status !== "PENDING") { await client.query("ROLLBACK"); return res.status(400).json({ error: "المشترى ده مش في حالة انتظار مراجعة" }); }
    if (req.user.role === "branch_manager" && !assertOwnBranch(req.user, purchase.branch_id)) {
      await client.query("ROLLBACK");
      return res.status(403).json({ error: "معندكش صلاحية على فرع تاني" });
    }

    const result = await client.query(
      "UPDATE purchases SET status = 'CONFIRMED', reviewed_by = $1, reviewed_at = now() WHERE id = $2 RETURNING *",
      [req.user.id, req.params.id]
    );
    await logAudit(client, {
      branchId: purchase.branch_id, userId: req.user.id, action: "PURCHASE_CONFIRMED", entityType: "purchase", entityId: purchase.id, req,
    });
    await client.query("COMMIT");
    res.json(result.rows[0]);
  } catch (err) {
    await client.query("ROLLBACK");
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// POST /api/purchases/:id/reject - PENDING → REJECTED - نفس صلاحية التأكيد، مع سبب اختياري
router.post("/:id/reject", requireAuth, requirePermission("purchases.review"), async (req, res) => {
  const { reason } = req.body;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const existing = await client.query("SELECT * FROM purchases WHERE id = $1 FOR UPDATE", [req.params.id]);
    if (existing.rows.length === 0) { await client.query("ROLLBACK"); return res.status(404).json({ error: "المشترى مش موجود" }); }
    const purchase = existing.rows[0];
    if (purchase.status !== "PENDING") { await client.query("ROLLBACK"); return res.status(400).json({ error: "المشترى ده مش في حالة انتظار مراجعة" }); }
    if (req.user.role === "branch_manager" && !assertOwnBranch(req.user, purchase.branch_id)) {
      await client.query("ROLLBACK");
      return res.status(403).json({ error: "معندكش صلاحية على فرع تاني" });
    }

    const result = await client.query(
      "UPDATE purchases SET status = 'REJECTED', reviewed_by = $1, reviewed_at = now(), rejection_reason = $2 WHERE id = $3 RETURNING *",
      [req.user.id, reason || null, req.params.id]
    );
    await logAudit(client, {
      branchId: purchase.branch_id, userId: req.user.id, action: "PURCHASE_REJECTED", entityType: "purchase", entityId: purchase.id,
      metadata: { reason }, req,
    });
    await client.query("COMMIT");
    res.json(result.rows[0]);
  } catch (err) {
    await client.query("ROLLBACK");
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

module.exports = router;
