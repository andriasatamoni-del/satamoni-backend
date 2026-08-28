// نظام الطباعة: الـAPI اللي الـAgent المحلي (print-agent/ - Node منفصل شغال على جهاز الفرع) بيتعامل معاه
// بس - مفيش وصول مباشر لقاعدة البيانات من الـAgent خالص (زي ما اتطلب صراحة في المواصفة)، كل حاجة عن
// طريق الـHTTP API ده بحساب مستخدم حقيقي عادي (مدير فرع/أدمن، نفس نظام تسجيل الدخول الموجود - مفيش نوع
// حساب "خدمة" منفصل في النظام).
// دورة حياة الصف: PENDING -> (claim) -> PRINTING -> (printed/failed) -> PRINTED/FAILED.
// claim بيستخدم UPDATE ... WHERE status='PENDING' ذرّي (نفس فلسفة "قفل الصف" في كل route تاني في
// المشروع - orders.js/shifts.js/deliveries.js) عشان لو أكتر من Agent (أو نفس الـAgent بعد إعادة تشغيل)
// حاولوا ياخدوا نفس الـjob مش هيحصل تكرار طباعة أبدًا.
const express = require("express");
const router = express.Router();
const pool = require("../db/pool");
const { requireAuth, assertOwnBranch } = require("../middleware/auth");
const { requirePermission } = require("../middleware/permissions");

router.use(requireAuth);

// GET /api/print-jobs?branchId=&status=&limit= - الـAgent بيسحب PENDING بس عادةً (status=PENDING)،
// شاشة الإدارة بتسحب الكل للمراجعة/التاريخ
router.get("/", requirePermission("print_jobs.view", "print_jobs.manage_queue"), async (req, res) => {
  const branchId = req.query.branchId || req.user.branchId;
  if (!branchId) return res.status(400).json({ error: "لازم تحدد الفرع" });
  if (!assertOwnBranch(req.user, branchId)) {
    return res.status(403).json({ error: "معندكش صلاحية تشوف طابور طباعة فرع تاني" });
  }
  const conditions = ["branch_id = $1"];
  const values = [branchId];
  let i = 2;
  if (req.query.status) { conditions.push(`status = $${i++}`); values.push(req.query.status); }
  if (req.query.orderId) { conditions.push(`order_id = $${i++}`); values.push(req.query.orderId); }
  const limit = Math.min(Number(req.query.limit) || 100, 300);
  try {
    const result = await pool.query(
      `SELECT * FROM print_jobs WHERE ${conditions.join(" AND ")} ORDER BY created_at ASC LIMIT ${limit}`,
      values
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/print-jobs/:id
router.get("/:id", requirePermission("print_jobs.view", "print_jobs.manage_queue"), async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM print_jobs WHERE id = $1", [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: "أمر الطباعة مش موجود" });
    if (!assertOwnBranch(req.user, result.rows[0].branch_id)) {
      return res.status(403).json({ error: "معندكش صلاحية تشوف أمر طباعة فرع تاني" });
    }
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/print-jobs/:id/claim - الـAgent بيحجز الـjob لنفسه قبل ما يطبعها فعليًا (PENDING -> PRINTING)
router.post("/:id/claim", requirePermission("print_jobs.manage_queue"), async (req, res) => {
  try {
    const existing = await pool.query("SELECT branch_id FROM print_jobs WHERE id = $1", [req.params.id]);
    if (existing.rows.length === 0) return res.status(404).json({ error: "أمر الطباعة مش موجود" });
    if (!assertOwnBranch(req.user, existing.rows[0].branch_id)) {
      return res.status(403).json({ error: "معندكش صلاحية على طابور فرع تاني" });
    }
    const result = await pool.query(
      `UPDATE print_jobs SET status = 'PRINTING', printing_started_at = now(), attempts = attempts + 1
       WHERE id = $1 AND status = 'PENDING' RETURNING *`,
      [req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(409).json({ error: "أمر الطباعة ده مش PENDING (اتحجز أو اتطبع بالفعل)" });
    }
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/print-jobs/:id/printed - الـAgent بيأكد إن الطباعة الفعلية نجحت
router.post("/:id/printed", requirePermission("print_jobs.manage_queue"), async (req, res) => {
  try {
    const existing = await pool.query("SELECT branch_id FROM print_jobs WHERE id = $1", [req.params.id]);
    if (existing.rows.length === 0) return res.status(404).json({ error: "أمر الطباعة مش موجود" });
    if (!assertOwnBranch(req.user, existing.rows[0].branch_id)) {
      return res.status(403).json({ error: "معندكش صلاحية على طابور فرع تاني" });
    }
    const result = await pool.query(
      `UPDATE print_jobs SET status = 'PRINTED', printed_at = now()
       WHERE id = $1 AND status = 'PRINTING' RETURNING *`,
      [req.params.id]
    );
    if (result.rows.length === 0) return res.status(409).json({ error: "أمر الطباعة ده مش PRINTING دلوقتي" });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/print-jobs/:id/failed - {error} - الـAgent بيبلّغ إن الطباعة فشلت فعليًا (طابعة قاطعة/ورق خلص...)
router.post("/:id/failed", requirePermission("print_jobs.manage_queue"), async (req, res) => {
  const { error } = req.body;
  try {
    const existing = await pool.query("SELECT branch_id FROM print_jobs WHERE id = $1", [req.params.id]);
    if (existing.rows.length === 0) return res.status(404).json({ error: "أمر الطباعة مش موجود" });
    if (!assertOwnBranch(req.user, existing.rows[0].branch_id)) {
      return res.status(403).json({ error: "معندكش صلاحية على طابور فرع تاني" });
    }
    const result = await pool.query(
      `UPDATE print_jobs SET status = 'FAILED', failed_at = now(), last_error = $2
       WHERE id = $1 AND status = 'PRINTING' RETURNING *`,
      [req.params.id, error || "فشلت الطباعة"]
    );
    if (result.rows.length === 0) return res.status(409).json({ error: "أمر الطباعة ده مش PRINTING دلوقتي" });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/print-jobs/:id/retry - إعادة أمر طباعة فاشل للطابور (FAILED -> PENDING) - إجراء يدوي بس (من
// شاشة الإدارة) عمدًا، مفيش إعادة محاولة تلقائية بتحصل من غير حد يشوفها ويقرر، عشان منمنعش تكرار طباعة
// حقيقي لو المشكلة كانت "الورقة خرجت فعلاً بس الشبكة قطعت قبل ما الـAgent يبلّغ"
router.post("/:id/retry", requirePermission("print_jobs.manage_queue"), async (req, res) => {
  try {
    const existing = await pool.query("SELECT branch_id FROM print_jobs WHERE id = $1", [req.params.id]);
    if (existing.rows.length === 0) return res.status(404).json({ error: "أمر الطباعة مش موجود" });
    if (!assertOwnBranch(req.user, existing.rows[0].branch_id)) {
      return res.status(403).json({ error: "معندكش صلاحية على طابور فرع تاني" });
    }
    const result = await pool.query(
      `UPDATE print_jobs SET status = 'PENDING', last_error = NULL, failed_at = NULL
       WHERE id = $1 AND status = 'FAILED' RETURNING *`,
      [req.params.id]
    );
    if (result.rows.length === 0) return res.status(409).json({ error: "أمر الطباعة ده مش FAILED" });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
