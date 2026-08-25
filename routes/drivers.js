// المرحلة 7F: بيانات السائق الأساسية - مقفول على فرع مدير الفرع (زي نمط routes/users.js وHR المرحلة
// 4D بالظبط)، الأدمن بس يشوف/يدير أي فرع. تسجيل دخول السائق (users.role='driver') اختياري ومنفصل عن
// إنشاء السائق نفسه - راجع docs/DRIVER-OPERATIONS.md للقرار الكامل ليه السائق محتاج دخول فعلي.
const express = require("express");
const router = express.Router();
const bcrypt = require("bcryptjs");
const pool = require("../db/pool");
const { requireAuth, assertOwnBranch } = require("../middleware/auth");
const { requirePermission } = require("../middleware/permissions");
const { logAudit } = require("../db/audit");

router.use(requireAuth);

// GET /api/drivers?branchId=&status= - قايمة سائقين الفرع
router.get("/", requirePermission("drivers.manage", "deliveries.view_branch", "deliveries.assign"), async (req, res) => {
  const branchId = req.query.branchId || req.user.branchId;
  if (!branchId) return res.status(400).json({ error: "لازم تحدد الفرع" });
  if (!assertOwnBranch(req.user, branchId)) {
    return res.status(403).json({ error: "معندكش صلاحية تشوف سائقين فرع تاني" });
  }
  const conditions = ["d.branch_id = $1"];
  const values = [branchId];
  if (req.query.status) { conditions.push("d.status = $2"); values.push(req.query.status); }
  try {
    const result = await pool.query(
      `SELECT d.*, u.email AS login_email
       FROM drivers d LEFT JOIN users u ON u.id = d.user_id
       WHERE ${conditions.join(" AND ")}
       ORDER BY d.name`,
      values
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/drivers/:id
router.get("/:id", requirePermission("drivers.manage", "deliveries.view_branch", "deliveries.assign"), async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT d.*, u.email AS login_email FROM drivers d LEFT JOIN users u ON u.id = d.user_id WHERE d.id = $1`,
      [req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: "السائق مش موجود" });
    if (!assertOwnBranch(req.user, result.rows[0].branch_id)) {
      return res.status(403).json({ error: "معندكش صلاحية تشوف سائق فرع تاني" });
    }
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/drivers - {branchId?, name, phone?, employeeId?, createLogin?: {email, password}}
// createLogin اختياري - لو مبعوت، بينشئ حساب دخول (role='driver') ويربطه بالسائق في نفس الـtransaction
router.post("/", requirePermission("drivers.manage"), async (req, res) => {
  const { name, phone, employeeId, createLogin } = req.body;
  const branchId = req.user.role === "admin" ? (req.body.branchId || req.user.branchId) : req.user.branchId;
  if (!name) return res.status(400).json({ error: "لازم اسم السائق" });
  if (!branchId) return res.status(400).json({ error: "لازم تحدد الفرع" });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    let userId = null;
    if (createLogin) {
      const { email, password } = createLogin;
      if (!email || !password) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "تسجيل دخول السائق محتاج بريد إلكتروني وكلمة مرور" });
      }
      const passwordHash = await bcrypt.hash(password, 10);
      try {
        const userRes = await client.query(
          `INSERT INTO users (name, email, password_hash, role, branch_id) VALUES ($1,$2,$3,'driver',$4) RETURNING id`,
          [name, email, passwordHash, branchId]
        );
        userId = userRes.rows[0].id;
      } catch (err) {
        if (err.code === "23505") {
          await client.query("ROLLBACK");
          return res.status(409).json({ error: "البريد الإلكتروني ده مستخدم بالفعل" });
        }
        throw err;
      }
    }

    const seq = await client.query("SELECT nextval('driver_code_seq') AS n");
    const driverCode = `DRV-${String(seq.rows[0].n).padStart(6, "0")}`;

    const inserted = await client.query(
      `INSERT INTO drivers (user_id, employee_id, branch_id, driver_code, name, phone)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [userId, employeeId || null, branchId, driverCode, name, phone || null]
    );

    await logAudit(client, {
      branchId, userId: req.user.id, action: "DRIVER_CREATED", entityType: "driver", entityId: inserted.rows[0].id,
      newValues: { name, phone, driverCode, hasLogin: !!userId }, req,
    });

    await client.query("COMMIT");
    res.status(201).json(inserted.rows[0]);
  } catch (err) {
    await client.query("ROLLBACK");
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// PATCH /api/drivers/:id - {name?, phone?, status?, isActive?}
router.patch("/:id", requirePermission("drivers.manage"), async (req, res) => {
  const { name, phone, status, isActive } = req.body;
  const VALID_STATUSES = ["AVAILABLE", "BUSY", "OFF_DUTY", "SUSPENDED", "INACTIVE"];
  if (status !== undefined && !VALID_STATUSES.includes(status)) {
    return res.status(400).json({ error: "حالة السائق غير معروفة" });
  }
  const fields = [];
  const values = [];
  let i = 1;
  if (name !== undefined) { fields.push(`name = $${i++}`); values.push(name); }
  if (phone !== undefined) { fields.push(`phone = $${i++}`); values.push(phone); }
  if (status !== undefined) { fields.push(`status = $${i++}`); values.push(status); }
  if (isActive !== undefined) { fields.push(`is_active = $${i++}`); values.push(isActive); }
  if (fields.length === 0) return res.status(400).json({ error: "مفيش حاجة تتعدل" });
  fields.push(`updated_at = now()`);
  values.push(req.params.id);

  try {
    const existing = await pool.query("SELECT * FROM drivers WHERE id = $1", [req.params.id]);
    if (existing.rows.length === 0) return res.status(404).json({ error: "السائق مش موجود" });
    if (!assertOwnBranch(req.user, existing.rows[0].branch_id)) {
      return res.status(403).json({ error: "معندكش صلاحية تعدّل سائق فرع تاني" });
    }
    const result = await pool.query(
      `UPDATE drivers SET ${fields.join(", ")} WHERE id = $${i} RETURNING *`,
      values
    );
    await logAudit(pool, {
      branchId: existing.rows[0].branch_id, userId: req.user.id, action: "DRIVER_UPDATED",
      entityType: "driver", entityId: result.rows[0].id,
      oldValues: { name: existing.rows[0].name, phone: existing.rows[0].phone, status: existing.rows[0].status, isActive: existing.rows[0].is_active },
      newValues: { name, phone, status, isActive }, req,
    });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
