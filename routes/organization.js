// HR Foundation Hardening (HRF-6): إدارة الهيكل التنظيمي - أقسام (departments) ومسميات وظيفية
// (positions) كـentities حقيقية بدل ما كانوا free-text على employees.department/job_title مباشرة.
// مفيش DELETE أبدًا هنا (موظفين حاليين وemployee_history بيشيروا لهم) - بس تعطيل (status='inactive')
// يخفيهم من قوائم الاختيار الجديدة من غير ما يفقدوا أي سياق تاريخي.
const express = require("express");
const router = express.Router();
const pool = require("../db/pool");
const { requireAuth } = require("../middleware/auth");
const { requirePermission } = require("../middleware/permissions");
const { logAudit } = require("../db/audit");
const { validateIdParam } = require("../middleware/validate-id-param");

router.use(requireAuth);
router.param("id", validateIdParam);

// ---------------- الأقسام ----------------
router.get("/departments", requirePermission("organization.view"), async (req, res) => {
  const { status } = req.query;
  try {
    const result = await pool.query(
      `SELECT * FROM departments ${status ? "WHERE status = $1" : ""} ORDER BY name`,
      status ? [status] : []
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/departments", requirePermission("organization.manage"), async (req, res) => {
  const { code, name, description } = req.body;
  if (!code || !name) return res.status(400).json({ error: "لازم كود واسم القسم" });
  try {
    const result = await pool.query(
      `INSERT INTO departments (code, name, description) VALUES ($1,$2,$3) RETURNING *`,
      [code, name, description || null]
    );
    await logAudit(pool, {
      userId: req.user.id, action: "DEPARTMENT_CREATED", entityType: "department",
      entityId: result.rows[0].id, newValues: result.rows[0], req,
    });
    res.status(201).json(result.rows[0]);
  } catch (err) {
    if (err.code === "23505") return res.status(409).json({ error: "الكود أو الاسم ده مستخدم بالفعل" });
    res.status(500).json({ error: err.message });
  }
});

router.patch("/departments/:id", requirePermission("organization.manage"), async (req, res) => {
  const { name, description, status } = req.body;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const before = await client.query("SELECT * FROM departments WHERE id = $1 FOR UPDATE", [req.params.id]);
    if (before.rows.length === 0) { await client.query("ROLLBACK"); return res.status(404).json({ error: "القسم مش موجود" }); }

    const fields = [];
    const values = [];
    let i = 1;
    const map = { name, description, status };
    for (const [col, val] of Object.entries(map)) {
      if (val !== undefined) { fields.push(`${col} = $${i++}`); values.push(val); }
    }
    if (fields.length === 0) { await client.query("ROLLBACK"); return res.status(400).json({ error: "مفيش حاجة تتعدل" }); }
    fields.push(`updated_at = now()`);
    values.push(req.params.id);
    const result = await client.query(`UPDATE departments SET ${fields.join(", ")} WHERE id = $${i} RETURNING *`, values);

    await logAudit(client, {
      userId: req.user.id, action: "DEPARTMENT_UPDATED", entityType: "department", entityId: Number(req.params.id),
      oldValues: before.rows[0], newValues: result.rows[0], req,
    });
    await client.query("COMMIT");
    res.json(result.rows[0]);
  } catch (err) {
    await client.query("ROLLBACK");
    if (err.code === "23505") return res.status(409).json({ error: "الاسم ده مستخدم بالفعل" });
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ---------------- المسميات الوظيفية ----------------
router.get("/positions", requirePermission("organization.view"), async (req, res) => {
  const { status, departmentId } = req.query;
  const conditions = [];
  const values = [];
  let i = 1;
  if (status) { conditions.push(`status = $${i++}`); values.push(status); }
  if (departmentId) { conditions.push(`department_id = $${i++}`); values.push(departmentId); }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  try {
    const result = await pool.query(
      `SELECT p.*, d.name AS department_name FROM positions p
       LEFT JOIN departments d ON d.id = p.department_id
       ${where} ORDER BY p.name`,
      values
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/positions", requirePermission("organization.manage"), async (req, res) => {
  const { code, name, departmentId, description } = req.body;
  if (!code || !name) return res.status(400).json({ error: "لازم كود واسم المسمى الوظيفي" });
  try {
    const result = await pool.query(
      `INSERT INTO positions (code, name, department_id, description) VALUES ($1,$2,$3,$4) RETURNING *`,
      [code, name, departmentId || null, description || null]
    );
    await logAudit(pool, {
      userId: req.user.id, action: "POSITION_CREATED", entityType: "position",
      entityId: result.rows[0].id, newValues: result.rows[0], req,
    });
    res.status(201).json(result.rows[0]);
  } catch (err) {
    if (err.code === "23505") return res.status(409).json({ error: "الكود ده مستخدم بالفعل" });
    res.status(500).json({ error: err.message });
  }
});

router.patch("/positions/:id", requirePermission("organization.manage"), async (req, res) => {
  const { name, departmentId, description, status } = req.body;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const before = await client.query("SELECT * FROM positions WHERE id = $1 FOR UPDATE", [req.params.id]);
    if (before.rows.length === 0) { await client.query("ROLLBACK"); return res.status(404).json({ error: "المسمى الوظيفي مش موجود" }); }

    const fields = [];
    const values = [];
    let i = 1;
    const map = { name, department_id: departmentId, description, status };
    for (const [col, val] of Object.entries(map)) {
      if (val !== undefined) { fields.push(`${col} = $${i++}`); values.push(val); }
    }
    if (fields.length === 0) { await client.query("ROLLBACK"); return res.status(400).json({ error: "مفيش حاجة تتعدل" }); }
    fields.push(`updated_at = now()`);
    values.push(req.params.id);
    const result = await client.query(`UPDATE positions SET ${fields.join(", ")} WHERE id = $${i} RETURNING *`, values);

    await logAudit(client, {
      userId: req.user.id, action: "POSITION_UPDATED", entityType: "position", entityId: Number(req.params.id),
      oldValues: before.rows[0], newValues: result.rows[0], req,
    });
    await client.query("COMMIT");
    res.json(result.rows[0]);
  } catch (err) {
    await client.query("ROLLBACK");
    if (err.code === "23505") return res.status(409).json({ error: "الكود ده مستخدم بالفعل" });
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

module.exports = router;
