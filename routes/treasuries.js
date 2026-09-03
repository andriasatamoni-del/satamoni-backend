// المرحلة 8.42: الخزائن (خزينة رئيسية لكل فرع + درج كل كاشير أثناء شيفته + حسابات بنكية) - راجع
// db/accounting-engine.js وdb/shift-engine.js للمنطق المحاسبي الكامل (إزاي الكاش بيدخل/يتحوّل).
// الراوت ده بس واجهة صديقة فوق شجرة الحسابات: عرض/تحويل، مفيش أي رصيد مخزّن هنا - كل حاجة بتتحسب
// لحظيًا من journal_entry_lines، وكشف حركة الخزينة نفسه هو GET /api/reports/general-ledger?accountId=
// الموجود بالفعل (accountId = treasuries.account_id) - مفيش داعي لتكرار نفس المنطق هنا.
const express = require("express");
const router = express.Router();
const pool = require("../db/pool");
const { requireAuth, assertOwnBranch } = require("../middleware/auth");
const { requirePermission } = require("../middleware/permissions");
const { postJournalEntry } = require("../db/accounting-engine");
const { logAudit } = require("../db/audit");

// GET /api/treasuries?branchId= - قايمة خزائن فرع معيّن (رئيسية + دروج الكاشيرية النشطة/التاريخية) +
// خزائن البنوك (مشتركة، مفيش branch_id). مدير الفرع/المحاسب لفرعهم بس، أدمن لأي فرع أو كل الفروع
router.get("/", requireAuth, requirePermission("treasuries.view"), async (req, res) => {
  const branchId = req.query.branchId ? Number(req.query.branchId) : null;
  if (branchId && !assertOwnBranch(req.user, branchId)) {
    return res.status(403).json({ error: "معندكش صلاحية تشوف خزائن فرع تاني" });
  }
  if (!branchId && req.user.role !== "admin") {
    return res.status(400).json({ error: "لازم تحدد الفرع" });
  }
  try {
    const result = await pool.query(
      `SELECT t.*, a.code AS account_code, a.name AS account_name, b.name AS branch_name,
              u.name AS cashier_name,
              COALESCE((
                SELECT SUM(jel.debit) - SUM(jel.credit)
                FROM journal_entry_lines jel JOIN journal_entries je ON je.id = jel.journal_entry_id
                WHERE jel.account_id = t.account_id AND je.status <> 'DRAFT'
              ), 0) AS balance
       FROM treasuries t
       JOIN accounts a ON a.id = t.account_id
       LEFT JOIN branches b ON b.id = t.branch_id
       LEFT JOIN users u ON u.id = t.cashier_user_id
       WHERE ($1::int IS NULL OR t.branch_id = $1 OR t.branch_id IS NULL)
       ORDER BY (t.kind = 'MAIN') DESC, (t.kind = 'BANK') DESC, t.name`,
      [branchId]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/treasuries/:id/transfer - تحويل مبلغ من خزينة لخزينة تانية (خزينة رئيسية -> بنك، أو أي
// اتجاه تاني) - {toTreasuryId, amount, notes?}. مالي بحت (treasuries.transfer)، مش متاح لمدير الفرع
router.post("/:id/transfer", requireAuth, requirePermission("treasuries.transfer"), async (req, res) => {
  const fromId = Number(req.params.id);
  const { toTreasuryId, amount, notes } = req.body;
  if (!toTreasuryId || !amount || Number(amount) <= 0) {
    return res.status(400).json({ error: "لازم خزينة وجهة ومبلغ أكبر من صفر" });
  }
  if (Number(toTreasuryId) === fromId) {
    return res.status(400).json({ error: "مينفعش تحوّل خزينة لنفسها" });
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const fromRes = await client.query("SELECT * FROM treasuries WHERE id = $1", [fromId]);
    const toRes = await client.query("SELECT * FROM treasuries WHERE id = $1", [toTreasuryId]);
    if (fromRes.rows.length === 0 || toRes.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "خزينة مش موجودة" });
    }
    const from = fromRes.rows[0];
    const to = toRes.rows[0];
    if (from.branch_id && !assertOwnBranch(req.user, from.branch_id)) {
      await client.query("ROLLBACK");
      return res.status(403).json({ error: "معندكش صلاحية على خزينة فرع تاني" });
    }

    const je = await postJournalEntry(client, {
      entryDate: new Date().toISOString().slice(0, 10),
      description: `تحويل من ${from.name} لـ${to.name}${notes ? " - " + notes : ""}`,
      sourceType: "treasury_transfer", sourceId: from.id, branchId: from.branch_id || to.branch_id,
      lines: [
        { accountId: to.account_id, debit: Number(amount) },
        { accountId: from.account_id, credit: Number(amount) },
      ],
      userId: req.user.id,
    });
    await logAudit(client, {
      branchId: from.branch_id || to.branch_id, userId: req.user.id, action: "TREASURY_TRANSFER",
      entityType: "treasury", entityId: from.id,
      newValues: { fromTreasuryId: from.id, toTreasuryId: to.id, amount: Number(amount), notes: notes || null },
    });
    await client.query("COMMIT");
    res.status(201).json({ journalEntry: je.entry });
  } catch (err) {
    await client.query("ROLLBACK");
    if (err.code === "PERIOD_CLOSED") return res.status(400).json({ error: err.message });
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

module.exports = router;
