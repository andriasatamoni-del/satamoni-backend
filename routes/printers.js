// نظام الطباعة: إدارة طابعات الفرع (Settings > الطباعة > الطابعات) - نفس نمط routes/drivers.js بالظبط
// (مقفول على فرع مدير الفرع، الأدمن بس يدير أي فرع). "اختبار طباعة" هنا بيعمل صف print_jobs عادي بس
// (نفس أي طلب طباعة تاني) - الطباعة الفعلية بتحصل عند الـAgent المحلي زي أي job تاني، من غير أي فرق في
// المسار عشان نتأكد إن التوجيه/الطابعة شغالين فعليًا بنفس الطريق اللي هيستخدمها الإنتاج.
const express = require("express");
const router = express.Router();
const pool = require("../db/pool");
const { requireAuth, assertOwnBranch } = require("../middleware/auth");
const { requirePermission } = require("../middleware/permissions");
const { logAudit } = require("../db/audit");
const { queueTestPrintJob } = require("../db/print-queue");

router.use(requireAuth);

const PRINTER_TYPES = ["CASHIER", "KITCHEN", "DELIVERY", "REPORT"];
const CONNECTION_TYPES = ["USB", "LAN"];

// GET /api/printers?branchId= - قايمة طابعات الفرع
router.get("/", requirePermission("printers.view", "printers.manage"), async (req, res) => {
  const branchId = req.query.branchId || req.user.branchId;
  if (!branchId) return res.status(400).json({ error: "لازم تحدد الفرع" });
  if (!assertOwnBranch(req.user, branchId)) {
    return res.status(403).json({ error: "معندكش صلاحية تشوف طابعات فرع تاني" });
  }
  try {
    const result = await pool.query(
      "SELECT * FROM printers WHERE branch_id = $1 ORDER BY printer_type, name",
      [branchId]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/printers - {branchId?, name, printerType, connectionType?, osPrinterName?, ipAddress?, port?, paperWidthMm?}
router.post("/", requirePermission("printers.manage"), async (req, res) => {
  const { name, printerType, connectionType, osPrinterName, ipAddress, port, paperWidthMm } = req.body;
  const branchId = req.user.role === "admin" ? (req.body.branchId || req.user.branchId) : req.user.branchId;
  if (!name) return res.status(400).json({ error: "لازم اسم الطابعة" });
  if (!branchId) return res.status(400).json({ error: "لازم تحدد الفرع" });
  if (!PRINTER_TYPES.includes(printerType)) return res.status(400).json({ error: "نوع طابعة غير معروف" });
  const conn = connectionType || "USB";
  if (!CONNECTION_TYPES.includes(conn)) return res.status(400).json({ error: "نوع اتصال غير معروف" });
  if (conn === "USB" && !osPrinterName) {
    return res.status(400).json({ error: "طابعة USB لازم لها اسم بالظبط زي ما هو مسجّل في نظام التشغيل (Windows)" });
  }
  if (conn === "LAN" && !ipAddress) {
    return res.status(400).json({ error: "طابعة الشبكة (LAN) لازم لها عنوان IP" });
  }
  try {
    const inserted = await pool.query(
      `INSERT INTO printers (branch_id, name, printer_type, connection_type, os_printer_name, ip_address, port, paper_width_mm)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [branchId, name, printerType, conn, osPrinterName || null, ipAddress || null, port || (conn === "LAN" ? 9100 : null), paperWidthMm || 80]
    );
    await logAudit(pool, {
      branchId, userId: req.user.id, action: "PRINTER_CREATED", entityType: "printer", entityId: inserted.rows[0].id,
      newValues: { name, printerType, connectionType: conn }, req,
    });
    res.status(201).json(inserted.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/printers/:id - {name?, printerType?, connectionType?, osPrinterName?, ipAddress?, port?, paperWidthMm?, isEnabled?, isDefaultForType?}
router.patch("/:id", requirePermission("printers.manage"), async (req, res) => {
  const { name, printerType, connectionType, osPrinterName, ipAddress, port, paperWidthMm, isEnabled, isDefaultForType } = req.body;
  if (printerType !== undefined && !PRINTER_TYPES.includes(printerType)) return res.status(400).json({ error: "نوع طابعة غير معروف" });
  if (connectionType !== undefined && !CONNECTION_TYPES.includes(connectionType)) return res.status(400).json({ error: "نوع اتصال غير معروف" });

  const existing = await pool.query("SELECT * FROM printers WHERE id = $1", [req.params.id]);
  if (existing.rows.length === 0) return res.status(404).json({ error: "الطابعة مش موجودة" });
  if (!assertOwnBranch(req.user, existing.rows[0].branch_id)) {
    return res.status(403).json({ error: "معندكش صلاحية تعدّل طابعة فرع تاني" });
  }

  const fields = [];
  const values = [];
  let i = 1;
  if (name !== undefined) { fields.push(`name = $${i++}`); values.push(name); }
  if (printerType !== undefined) { fields.push(`printer_type = $${i++}`); values.push(printerType); }
  if (connectionType !== undefined) { fields.push(`connection_type = $${i++}`); values.push(connectionType); }
  if (osPrinterName !== undefined) { fields.push(`os_printer_name = $${i++}`); values.push(osPrinterName || null); }
  if (ipAddress !== undefined) { fields.push(`ip_address = $${i++}`); values.push(ipAddress || null); }
  if (port !== undefined) { fields.push(`port = $${i++}`); values.push(port || null); }
  if (paperWidthMm !== undefined) { fields.push(`paper_width_mm = $${i++}`); values.push(paperWidthMm); }
  if (isEnabled !== undefined) { fields.push(`is_enabled = $${i++}`); values.push(isEnabled); }
  if (isDefaultForType !== undefined) { fields.push(`is_default_for_type = $${i++}`); values.push(isDefaultForType); }
  if (fields.length === 0) return res.status(400).json({ error: "مفيش حاجة تتعدل" });
  fields.push("updated_at = now()");
  values.push(req.params.id);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // "افتراضية للنوع" لازم تكون فريدة (زرار راديو) - لو بنفعّلها هنا، أي طابعة تانية من نفس النوع في
    // نفس الفرع لازم تترجع FALSE أوتوماتيك، غير كده حل التوجيه (resolvePrinterForType) هيفضل ياخد أقدم
    // طابعة افتراضية (id ASC) مش اللي المستخدم قصده فعليًا دلوقتي
    if (isDefaultForType === true) {
      await client.query(
        "UPDATE printers SET is_default_for_type = FALSE WHERE branch_id = $1 AND printer_type = $2 AND id <> $3",
        [existing.rows[0].branch_id, printerType || existing.rows[0].printer_type, req.params.id]
      );
    }
    const result = await client.query(`UPDATE printers SET ${fields.join(", ")} WHERE id = $${i} RETURNING *`, values);
    await client.query("COMMIT");
    await logAudit(pool, {
      branchId: existing.rows[0].branch_id, userId: req.user.id, action: "PRINTER_UPDATED",
      entityType: "printer", entityId: result.rows[0].id, oldValues: existing.rows[0], newValues: req.body, req,
    });
    res.json(result.rows[0]);
  } catch (err) {
    await client.query("ROLLBACK");
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// DELETE /api/printers/:id - حذف نهائي (التوجيه اللي بيشاور عليها بيرجع NULL تلقائي - ON DELETE SET NULL،
// مش بيتمنع). محطات/routing كانت متظبطة عليها هترجع "بدون طابعة" وتحتاج إعادة ربط - ده متوقع ومقصود
router.delete("/:id", requirePermission("printers.manage"), async (req, res) => {
  try {
    const existing = await pool.query("SELECT * FROM printers WHERE id = $1", [req.params.id]);
    if (existing.rows.length === 0) return res.status(404).json({ error: "الطابعة مش موجودة" });
    if (!assertOwnBranch(req.user, existing.rows[0].branch_id)) {
      return res.status(403).json({ error: "معندكش صلاحية تحذف طابعة فرع تاني" });
    }
    await pool.query("DELETE FROM printers WHERE id = $1", [req.params.id]);
    await logAudit(pool, {
      branchId: existing.rows[0].branch_id, userId: req.user.id, action: "PRINTER_DELETED",
      entityType: "printer", entityId: existing.rows[0].id, oldValues: existing.rows[0], req,
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/printers/:id/test-print - بينشئ print_jobs.TEST_PRINT عادي (نفس مسار أي طباعة حقيقية) -
// الـAgent المحلي هو اللي فعليًا هيطبعها زي أي job تاني، مش الـroute ده
router.post("/:id/test-print", requirePermission("printers.manage"), async (req, res) => {
  try {
    const existing = await pool.query(
      `SELECT p.*, b.name AS branch_name FROM printers p JOIN branches b ON b.id = p.branch_id WHERE p.id = $1`,
      [req.params.id]
    );
    if (existing.rows.length === 0) return res.status(404).json({ error: "الطابعة مش موجودة" });
    const printer = existing.rows[0];
    if (!assertOwnBranch(req.user, printer.branch_id)) {
      return res.status(403).json({ error: "معندكش صلاحية تختبر طابعة فرع تاني" });
    }
    if (!printer.is_enabled) return res.status(400).json({ error: "الطابعة دي معطّلة - فعّلها الأول" });
    const job = await queueTestPrintJob(pool, { printer, createdBy: req.user.id });
    res.status(201).json(job);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
