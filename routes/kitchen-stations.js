// نظام الطباعة: محطات التحضير + التوجيه (Settings > الطباعة > التوجيه) - طبقة الوسيط الصريحة اللي
// المواصفة طلبتها بين "صنف/قسم المنيو" و"الطابعة الفعلية" (Menu Item/Category -> Station -> Printer)،
// عشان تغيير أي حاجة (مين بيطبع فين) يكون من الإعدادات، مش تعديل كود. التوجيه نفسه (محطة -> طابعة) هو
// عمود kitchen_stations.printer_id القابل للتعديل - مفيش جدول وسيط زيادة لأن العلاقة بسيطة (محطة واحدة
// لها طابعة واحدة في كل فرع).
const express = require("express");
const router = express.Router();
const pool = require("../db/pool");
const { requireAuth, assertOwnBranch } = require("../middleware/auth");
const { requirePermission } = require("../middleware/permissions");
const { logAudit } = require("../db/audit");

router.use(requireAuth);

// GET /api/kitchen-stations?branchId= - قايمة محطات الفرع مع اسم الطابعة المربوطة (لو موجودة)
router.get("/", requirePermission("print_routing.view", "print_routing.manage"), async (req, res) => {
  const branchId = req.query.branchId || req.user.branchId;
  if (!branchId) return res.status(400).json({ error: "لازم تحدد الفرع" });
  if (!assertOwnBranch(req.user, branchId)) {
    return res.status(403).json({ error: "معندكش صلاحية تشوف محطات فرع تاني" });
  }
  try {
    const result = await pool.query(
      `SELECT ks.*, p.name AS printer_name, p.is_enabled AS printer_enabled
       FROM kitchen_stations ks LEFT JOIN printers p ON p.id = ks.printer_id
       WHERE ks.branch_id = $1 ORDER BY ks.name`,
      [branchId]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/kitchen-stations - {branchId?, name, printerId?}
router.post("/", requirePermission("print_routing.manage"), async (req, res) => {
  const { name, printerId } = req.body;
  const branchId = req.user.role === "admin" ? (req.body.branchId || req.user.branchId) : req.user.branchId;
  if (!name) return res.status(400).json({ error: "لازم اسم المحطة" });
  if (!branchId) return res.status(400).json({ error: "لازم تحدد الفرع" });
  try {
    if (printerId) {
      const p = await pool.query("SELECT branch_id FROM printers WHERE id = $1", [printerId]);
      if (p.rows.length === 0 || p.rows[0].branch_id !== Number(branchId)) {
        return res.status(400).json({ error: "الطابعة المختارة مش تابعة لنفس الفرع" });
      }
    }
    const inserted = await pool.query(
      "INSERT INTO kitchen_stations (branch_id, name, printer_id) VALUES ($1,$2,$3) RETURNING *",
      [branchId, name, printerId || null]
    );
    await logAudit(pool, {
      branchId, userId: req.user.id, action: "KITCHEN_STATION_CREATED", entityType: "kitchen_station",
      entityId: inserted.rows[0].id, newValues: { name, printerId }, req,
    });
    res.status(201).json(inserted.rows[0]);
  } catch (err) {
    if (err.code === "23505") return res.status(409).json({ error: "فيه محطة بنفس الاسم في الفرع ده بالفعل" });
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/kitchen-stations/:id - {name?, printerId?, isActive?} - printerId: null لفك الربط
router.patch("/:id", requirePermission("print_routing.manage"), async (req, res) => {
  const { name, printerId, isActive } = req.body;
  const existing = await pool.query("SELECT * FROM kitchen_stations WHERE id = $1", [req.params.id]);
  if (existing.rows.length === 0) return res.status(404).json({ error: "المحطة مش موجودة" });
  if (!assertOwnBranch(req.user, existing.rows[0].branch_id)) {
    return res.status(403).json({ error: "معندكش صلاحية تعدّل محطة فرع تاني" });
  }
  if (printerId) {
    const p = await pool.query("SELECT branch_id FROM printers WHERE id = $1", [printerId]);
    if (p.rows.length === 0 || p.rows[0].branch_id !== existing.rows[0].branch_id) {
      return res.status(400).json({ error: "الطابعة المختارة مش تابعة لنفس الفرع" });
    }
  }
  const fields = [];
  const values = [];
  let i = 1;
  if (name !== undefined) { fields.push(`name = $${i++}`); values.push(name); }
  if (printerId !== undefined) { fields.push(`printer_id = $${i++}`); values.push(printerId || null); }
  if (isActive !== undefined) { fields.push(`is_active = $${i++}`); values.push(isActive); }
  if (fields.length === 0) return res.status(400).json({ error: "مفيش حاجة تتعدل" });
  values.push(req.params.id);
  try {
    const result = await pool.query(`UPDATE kitchen_stations SET ${fields.join(", ")} WHERE id = $${i} RETURNING *`, values);
    await logAudit(pool, {
      branchId: existing.rows[0].branch_id, userId: req.user.id, action: "KITCHEN_STATION_UPDATED",
      entityType: "kitchen_station", entityId: result.rows[0].id, oldValues: existing.rows[0], newValues: req.body, req,
    });
    res.json(result.rows[0]);
  } catch (err) {
    if (err.code === "23505") return res.status(409).json({ error: "فيه محطة بنفس الاسم في الفرع ده بالفعل" });
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/kitchen-stations/:id - الأصناف/الأقسام المربوطة بيها بترجع station_id = NULL تلقائي
router.delete("/:id", requirePermission("print_routing.manage"), async (req, res) => {
  try {
    const existing = await pool.query("SELECT * FROM kitchen_stations WHERE id = $1", [req.params.id]);
    if (existing.rows.length === 0) return res.status(404).json({ error: "المحطة مش موجودة" });
    if (!assertOwnBranch(req.user, existing.rows[0].branch_id)) {
      return res.status(403).json({ error: "معندكش صلاحية تحذف محطة فرع تاني" });
    }
    await pool.query("DELETE FROM kitchen_stations WHERE id = $1", [req.params.id]);
    await logAudit(pool, {
      branchId: existing.rows[0].branch_id, userId: req.user.id, action: "KITCHEN_STATION_DELETED",
      entityType: "kitchen_station", entityId: existing.rows[0].id, oldValues: existing.rows[0], req,
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/kitchen-stations/routing/menu-categories/:id - {stationId} (توجيه افتراضي لكل أصناف القسم)
router.patch("/routing/menu-categories/:id", requirePermission("print_routing.manage"), async (req, res) => {
  const { stationId } = req.body;
  try {
    const cat = await pool.query("SELECT * FROM menu_categories WHERE id = $1", [req.params.id]);
    if (cat.rows.length === 0) return res.status(404).json({ error: "القسم مش موجود" });
    if (stationId) {
      const st = await pool.query("SELECT id FROM kitchen_stations WHERE id = $1", [stationId]);
      if (st.rows.length === 0) return res.status(400).json({ error: "المحطة المختارة مش موجودة" });
    }
    const result = await pool.query(
      "UPDATE menu_categories SET station_id = $1 WHERE id = $2 RETURNING *",
      [stationId || null, req.params.id]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/kitchen-stations/routing/menu-items/:id - {stationId} (توجيه مستوى الصنف - بيغلب توجيه القسم؛ null = رجوع لتوجيه القسم)
router.patch("/routing/menu-items/:id", requirePermission("print_routing.manage"), async (req, res) => {
  const { stationId } = req.body;
  try {
    const item = await pool.query("SELECT * FROM menu_items WHERE id = $1", [req.params.id]);
    if (item.rows.length === 0) return res.status(404).json({ error: "الصنف مش موجود" });
    if (stationId) {
      const st = await pool.query("SELECT id FROM kitchen_stations WHERE id = $1", [stationId]);
      if (st.rows.length === 0) return res.status(400).json({ error: "المحطة المختارة مش موجودة" });
    }
    const result = await pool.query(
      "UPDATE menu_items SET station_id = $1 WHERE id = $2 RETURNING *",
      [stationId || null, req.params.id]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/kitchen-stations/routing/menu?branchId= - المنيو كله مع القسم/الصنف وأي محطة متسجلة لكل واحد -
// شاشة التوجيه محتاجاها عشان تعرض كل صنف/قسم في المنيو مع اختيار المحطة جنبه
router.get("/routing/menu", requirePermission("print_routing.view", "print_routing.manage"), async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT mc.id AS category_id, mc.name AS category_name, mc.station_id AS category_station_id,
              mi.id AS item_id, mi.name AS item_name, mi.station_id AS item_station_id
       FROM menu_categories mc
       LEFT JOIN menu_items mi ON mi.category_id = mc.id AND mi.is_active = TRUE
       ORDER BY mc.display_order, mc.name, mi.name`,
      []
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
