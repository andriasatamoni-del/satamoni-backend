const express = require("express");
const router = express.Router();
const pool = require("../db/pool");
const { requireAuth, requireRole } = require("../middleware/auth");
const { requirePermission } = require("../middleware/permissions");

// GET /api/audit-logs?branchId=&userId=&action=&entityType=&from=&to=&limit=&offset=
// أدمن: كل السجلات وممكن يفلتر بفرع معيّن. مدير فرع/محاسب: سجلات فرعه بس تلقائيًا.
router.get(
  "/",
  requireAuth,
  requireRole("admin", "branch_manager", "accountant"),
  requirePermission("audit.view.branch"),
  async (req, res) => {
    const { userId, action, entityType, from, to } = req.query;
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    const offset = Number(req.query.offset) || 0;

    let branchId = req.query.branchId || null;
    if (req.user.role !== "admin") {
      branchId = req.user.branchId;
    }

    const conditions = [];
    const values = [];
    let i = 1;
    if (branchId) { conditions.push(`al.branch_id = $${i++}`); values.push(branchId); }
    if (userId) { conditions.push(`al.user_id = $${i++}`); values.push(userId); }
    if (action) { conditions.push(`al.action = $${i++}`); values.push(action); }
    if (entityType) { conditions.push(`al.entity_type = $${i++}`); values.push(entityType); }
    if (from) { conditions.push(`al.created_at >= $${i++}`); values.push(from); }
    if (to) { conditions.push(`al.created_at <= $${i++}`); values.push(to); }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

    try {
      const result = await pool.query(
        `SELECT al.*, u.name AS user_name, b.name AS branch_name
         FROM audit_logs al
         LEFT JOIN users u ON u.id = al.user_id
         LEFT JOIN branches b ON b.id = al.branch_id
         ${where}
         ORDER BY al.created_at DESC
         LIMIT $${i++} OFFSET $${i++}`,
        [...values, limit, offset]
      );
      res.json(result.rows);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

// GET /api/audit-logs/actions - قايمة أنواع الأحداث المسجلة فعليًا (لملء فلتر الشاشة)
router.get(
  "/actions",
  requireAuth,
  requireRole("admin", "branch_manager", "accountant"),
  requirePermission("audit.view.branch"),
  async (req, res) => {
    try {
      const result = await pool.query("SELECT DISTINCT action FROM audit_logs ORDER BY action");
      res.json(result.rows.map((r) => r.action));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

module.exports = router;
