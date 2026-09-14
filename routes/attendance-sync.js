// HR-5: مزامنة بصمة الفرع من جهاز ZK متصل بالشبكة - الـAgent المحلي (attendance-agent/) بيسحب البصمات
// الخام من الجهاز نفسه (TCP/IP، بروتوكول ZKTeco) ويبعتها هنا، بنفس فلسفة print-agent بالظبط (HTTP فقط،
// بحساب مستخدم حقيقي عادي مدير فرع، مفيش وصول مباشر لقاعدة البيانات من الـAgent خالص). نفس منطق الـupsert
// المستخدم بالفعل في استيراد بصمة الفرع اليدوي (routes/payroll.js POST /attendance-punches/import) - هنا
// بس مصدر البيانات مختلف (جهاز حقيقي بدل لصق يدوي) والوصول مقفول بصلاحية مخصصة (attendance.sync_device)
// بدل صلاحية الرواتب الكاملة (أدمن/محاسب) عشان حساب الـAgent يفضل أضيق صلاحية ممكنة.
const express = require("express");
const router = express.Router();
const pool = require("../db/pool");
const { requireAuth } = require("../middleware/auth");
const { requirePermission } = require("../middleware/permissions");

router.use(requireAuth);

// POST /api/attendance-sync/punches - {branchId? (أدمن بس لازم يحدده - مدير الفرع بيتحدد أوتوماتيك من
// حسابه ومفيش استثناء), punches: [{deviceCode, date:'YYYY-MM-DD', clockIn:'HH:MM'|null, clockOut:'HH:MM'|null}]}
router.post("/punches", requirePermission("attendance.sync_device"), async (req, res) => {
  let branchId = req.body.branchId ? Number(req.body.branchId) : null;
  const punches = req.body.punches;

  if (req.user.role !== "admin") {
    // نفس فلسفة auto-derive الفرع في print-agent/api-client.js - مدير الفرع مايقدرش يزامن بصمة فرع تاني
    // حتى لو حاول يبعت branchId مختلف صراحة في الجسم
    branchId = req.user.branchId;
  } else if (!branchId) {
    return res.status(400).json({ error: "حساب أدمن - لازم تحدد branchId صراحة" });
  }
  if (!branchId) return res.status(400).json({ error: "الحساب ده مش مربوط بفرع واحد بس" });
  if (!Array.isArray(punches) || punches.length === 0) return res.status(400).json({ error: "لازم قائمة بصمات" });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    let imported = 0;
    let skipped = 0;
    for (const p of punches) {
      if (!p || !p.deviceCode || !p.date) { skipped++; continue; }
      await client.query(
        `INSERT INTO attendance_punches (branch_id, device_code, punch_date, clock_in, clock_out)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (branch_id, device_code, punch_date)
         DO UPDATE SET clock_in = EXCLUDED.clock_in, clock_out = EXCLUDED.clock_out`,
        [branchId, String(p.deviceCode).trim(), p.date, p.clockIn || null, p.clockOut || null]
      );
      imported++;
    }
    await client.query("COMMIT");
    res.status(201).json({ branchId, imported, skipped });
  } catch (err) {
    await client.query("ROLLBACK");
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

module.exports = router;
