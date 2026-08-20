// المرحلة 4B: شجرة الحسابات + القيود اليدوية + الفترات المحاسبية. القيود التلقائية (بيع/استلام بضاعة/
// مصروف/هالك/تصنيع...) بتترحّل من نفس الـroutes التشغيلية بتاعتها مباشرة (routes/orders.js،
// routes/goods-receipts.js...) عن طريق db/accounting-engine.js، مش من هنا - الملف ده لإدارة شجرة
// الحسابات والقيود اليدوية بس (تعديلات محاسب مباشرة مش ناتجة عن حدث تشغيلي).
const express = require("express");
const router = express.Router();
const pool = require("../db/pool");
const { requireAuth, requireRole, assertOwnBranch } = require("../middleware/auth");
const { requirePermission } = require("../middleware/permissions");
const { logAudit } = require("../db/audit");
const { postJournalEntry, reverseJournalEntry, ensurePeriodOpen, getAccountByCode } = require("../db/accounting-engine");
const { toCents } = require("../services/payroll-engine");

// ---------------- شجرة الحسابات ----------------

// GET /api/accounting/accounts?type=&branchId=&activeOnly=
router.get("/accounts", requireAuth, requirePermission("accounting.view"), async (req, res) => {
  const { type, branchId, activeOnly } = req.query;
  const conditions = [];
  const values = [];
  let i = 1;
  if (type) { conditions.push(`account_type = $${i++}`); values.push(type); }
  if (branchId) { conditions.push(`(branch_id = $${i++} OR branch_id IS NULL)`); values.push(branchId); }
  if (activeOnly === "true") { conditions.push(`is_active = TRUE`); }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  try {
    const result = await pool.query(
      `SELECT a.*, p.code AS parent_code, p.name AS parent_name, b.name AS branch_name
       FROM accounts a
       LEFT JOIN accounts p ON p.id = a.parent_account_id
       LEFT JOIN branches b ON b.id = a.branch_id
       ${where} ORDER BY a.code`,
      values
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/accounting/accounts - حساب مخصّص جديد (مش نظامي أبدًا - is_system_account محمي، بيتحدد من
// سكريبت الشجرة الافتراضية بس)
router.post("/accounts", requireAuth, requirePermission("accounting.create"), async (req, res) => {
  const { code, name, accountType, parentAccountId, branchId } = req.body;
  if (!code || !name || !accountType) return res.status(400).json({ error: "لازم كود واسم ونوع الحساب" });
  if (!["ASSET", "LIABILITY", "EQUITY", "REVENUE", "COGS", "EXPENSE"].includes(accountType)) {
    return res.status(400).json({ error: "نوع الحساب غير معروف" });
  }
  try {
    const result = await pool.query(
      `INSERT INTO accounts (code, name, account_type, parent_account_id, branch_id, is_system_account)
       VALUES ($1,$2,$3,$4,$5,FALSE) RETURNING *`,
      [code, name, accountType, parentAccountId || null, branchId || null]
    );
    await logAudit(pool, {
      userId: req.user.id, action: "ACCOUNT_CREATED", entityType: "account", entityId: result.rows[0].id, newValues: result.rows[0], req,
    });
    res.status(201).json(result.rows[0]);
  } catch (err) {
    if (err.code === "23505") return res.status(409).json({ error: "كود الحساب ده مستخدم بالفعل" });
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/accounting/accounts/:id - تعديل اسم/حالة نشاط - كود ونوع حساب نظامي محميين من التغيير
router.patch("/accounts/:id", requireAuth, requirePermission("accounting.edit"), async (req, res) => {
  const { name, isActive } = req.body;
  try {
    const before = await pool.query("SELECT * FROM accounts WHERE id = $1", [req.params.id]);
    if (before.rows.length === 0) return res.status(404).json({ error: "الحساب مش موجود" });
    if (before.rows[0].is_system_account && isActive === false) {
      return res.status(400).json({ error: "حساب نظامي أساسي - مينفعش يتعطّل" });
    }
    const fields = [];
    const values = [];
    let i = 1;
    if (name !== undefined) { fields.push(`name = $${i++}`); values.push(name); }
    if (isActive !== undefined) { fields.push(`is_active = $${i++}`); values.push(isActive); }
    if (fields.length === 0) return res.status(400).json({ error: "مفيش حاجة تتعدل" });
    values.push(req.params.id);
    const result = await pool.query(`UPDATE accounts SET ${fields.join(", ")} WHERE id = $${i} RETURNING *`, values);
    await logAudit(pool, {
      userId: req.user.id, action: "ACCOUNT_EDITED", entityType: "account", entityId: Number(req.params.id),
      oldValues: before.rows[0], newValues: result.rows[0], req,
    });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------- القيود ----------------

// GET /api/accounting/journal-entries?branchId=&sourceType=&status=&from=&to=
router.get("/journal-entries", requireAuth, requirePermission("accounting.view"), async (req, res) => {
  let { branchId, sourceType, status, from, to } = req.query;
  if (req.user.role === "branch_manager") branchId = req.user.branchId;
  const conditions = [];
  const values = [];
  let i = 1;
  if (branchId) { conditions.push(`je.branch_id = $${i++}`); values.push(branchId); }
  if (sourceType) { conditions.push(`je.source_type = $${i++}`); values.push(sourceType); }
  if (status) { conditions.push(`je.status = $${i++}`); values.push(status); }
  if (from) { conditions.push(`je.entry_date >= $${i++}`); values.push(from); }
  if (to) { conditions.push(`je.entry_date <= $${i++}`); values.push(to); }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  try {
    const result = await pool.query(
      `SELECT je.*, b.name AS branch_name,
              COALESCE((SELECT SUM(debit) FROM journal_entry_lines WHERE journal_entry_id = je.id), 0) AS total_amount
       FROM journal_entries je LEFT JOIN branches b ON b.id = je.branch_id
       ${where} ORDER BY je.id DESC LIMIT 500`,
      values
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/accounting/journal-entries/:id
router.get("/journal-entries/:id", requireAuth, requirePermission("accounting.view"), async (req, res) => {
  try {
    const entry = await pool.query(
      `SELECT je.*, b.name AS branch_name FROM journal_entries je LEFT JOIN branches b ON b.id = je.branch_id WHERE je.id = $1`,
      [req.params.id]
    );
    if (entry.rows.length === 0) return res.status(404).json({ error: "القيد مش موجود" });
    if (req.user.role === "branch_manager" && entry.rows[0].branch_id && !assertOwnBranch(req.user, entry.rows[0].branch_id)) {
      return res.status(403).json({ error: "معندكش صلاحية تشوف قيد فرع تاني" });
    }
    const lines = await pool.query(
      `SELECT jel.*, a.code AS account_code, a.name AS account_name
       FROM journal_entry_lines jel JOIN accounts a ON a.id = jel.account_id
       WHERE jel.journal_entry_id = $1 ORDER BY jel.id`,
      [req.params.id]
    );
    res.json({ entry: entry.rows[0], lines: lines.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/accounting/journal-entries - قيد يدوي جديد (DRAFT دايمًا - محتاج /post منفصل، مفيش ترحيل
// تلقائي للقيود اليدوية). {entryDate, description?, branchId?, lines:[{accountId, debit?, credit?, description?, referenceType?, referenceId?}]}
router.post("/journal-entries", requireAuth, requirePermission("accounting.create"), async (req, res) => {
  const { entryDate, description, branchId, lines } = req.body;
  if (!entryDate) return res.status(400).json({ error: "لازم تاريخ القيد" });
  if (!Array.isArray(lines) || lines.length === 0) return res.status(400).json({ error: "لازم سطر واحد على الأقل" });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await postJournalEntry(client, {
      entryDate, description, sourceType: "manual", branchId: branchId || null,
      lines, userId: req.user.id, autoPost: false,
    });
    await logAudit(client, {
      branchId: branchId || null, userId: req.user.id, action: "JOURNAL_ENTRY_CREATED",
      entityType: "journal_entry", entityId: result.entry.id, newValues: { lines }, req,
    });
    await client.query("COMMIT");
    res.status(201).json(result);
  } catch (err) {
    await client.query("ROLLBACK");
    if (err.code === "JOURNAL_ENTRY_UNBALANCED" || err.code === "JOURNAL_ENTRY_EMPTY") return res.status(400).json({ error: err.message });
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// POST /api/accounting/journal-entries/:id/post - DRAFT → POSTED (قيد يدوي بس - القيود التلقائية أصلًا POSTED)
router.post("/journal-entries/:id/post", requireAuth, requirePermission("accounting.post"), async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const entry = await client.query("SELECT * FROM journal_entries WHERE id = $1 FOR UPDATE", [req.params.id]);
    if (entry.rows.length === 0) { await client.query("ROLLBACK"); return res.status(404).json({ error: "القيد مش موجود" }); }
    if (entry.rows[0].status !== "DRAFT") {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "القيد ده مش في حالة قابلة للترحيل (DRAFT بس)" });
    }
    await ensurePeriodOpen(client, entry.rows[0].entry_date);
    const posted = await client.query(
      `UPDATE journal_entries SET status = 'POSTED', posted_by = $1, posted_at = now() WHERE id = $2 RETURNING *`,
      [req.user.id, req.params.id]
    );
    await logAudit(client, {
      branchId: entry.rows[0].branch_id, userId: req.user.id, action: "JOURNAL_ENTRY_POSTED",
      entityType: "journal_entry", entityId: Number(req.params.id), req,
    });
    await client.query("COMMIT");
    res.json(posted.rows[0]);
  } catch (err) {
    await client.query("ROLLBACK");
    if (err.code === "PERIOD_CLOSED") return res.status(400).json({ error: err.message });
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// POST /api/accounting/journal-entries/:id/reverse - أدمن بس (accounting.reverse) - {reason}
router.post("/journal-entries/:id/reverse", requireAuth, requireRole("admin"), requirePermission("accounting.reverse"), async (req, res) => {
  const { reason } = req.body;
  if (!reason) return res.status(400).json({ error: "لازم سبب العكس" });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await reverseJournalEntry(client, {
      originalEntryId: Number(req.params.id), entryDate: req.body.entryDate, reason, userId: req.user.id,
      idempotencyKey: `reversal-${req.params.id}`,
    });
    if (!result.duplicate) {
      await logAudit(client, {
        branchId: result.entry.branch_id, userId: req.user.id, action: "JOURNAL_ENTRY_REVERSED",
        entityType: "journal_entry", entityId: Number(req.params.id), metadata: { reason, reversalEntryId: result.entry.id }, req,
      });
    }
    await client.query("COMMIT");
    res.json(result);
  } catch (err) {
    await client.query("ROLLBACK");
    if (["ENTRY_NOT_POSTED", "ALREADY_REVERSED"].includes(err.code)) return res.status(400).json({ error: err.message });
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ---------------- الفترات المحاسبية ----------------

// GET /api/accounting/periods
router.get("/periods", requireAuth, requirePermission("accounting.view"), async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM accounting_periods ORDER BY year DESC, month DESC");
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/accounting/periods/:year/:month/close - أدمن بس - بعد القفل، مفيش أي قيد جديد أو عكسي
// عليه، التصحيحات لازم تتسجل في الشهر المفتوح الحالي بقيد واضح السبب
router.post("/periods/:year/:month/close", requireAuth, requireRole("admin"), requirePermission("accounting.close_period"), async (req, res) => {
  const year = Number(req.params.year);
  const month = Number(req.params.month);
  if (!year || month < 1 || month > 12) return res.status(400).json({ error: "سنة/شهر غير صحيحين" });
  try {
    const result = await pool.query(
      `INSERT INTO accounting_periods (year, month, status, closed_by, closed_at) VALUES ($1,$2,'CLOSED',$3,now())
       ON CONFLICT (year, month) DO UPDATE SET status = 'CLOSED', closed_by = $3, closed_at = now()
       RETURNING *`,
      [year, month, req.user.id]
    );
    await logAudit(pool, {
      userId: req.user.id, action: "ACCOUNTING_PERIOD_CLOSED", entityType: "accounting_period", entityId: result.rows[0].id,
      metadata: { year, month }, req,
    });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------- الميزانية العمومية وقفل السنة المالية ----------------

// GET /api/accounting/fiscal-year-closings
router.get("/fiscal-year-closings", requireAuth, requirePermission("accounting.view"), async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM fiscal_year_closings ORDER BY year DESC");
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/accounting/fiscal-year-closings - أدمن بس - {year}. بيتطلب كل شهور السنة CLOSED الأول،
// بيحسب صافي الربح (كل حسابات REVENUE/COGS/EXPENSE المتحركة في السنة) وبيقفلها بقيد واحد يصفّر كل حساب
// من دول على 3200 (أرباح مرحّلة). القيد بيتسجل بتاريخ أول يوم في السنة الجاية (مش آخر يوم في السنة
// المقفولة) عشان ديسمبر المقفول أصلًا هيرفض أي قيد جديد عليه (ensurePeriodOpen) - نفس فلسفة "تصحيح بعد
// القفل بيتسجل في الشهر المفتوح الحالي، مش بإعادة فتح القديم". مفيش endpoint مخصّص لعكس قفل سنة (زي
// إعادة فتح شهر) عمدًا - القيد نفسه يقدر يتعكس بالطريقة العامة (journal-entries/:id/reverse، أدمن بس)
// في حالة نادرة جدًا (قفل غلط)، لكن ده مش الطريق المتوقع - التصحيح الطبيعي بعد القفل قيد جديد في السنة
// المفتوحة الحالية، مش عكس القفل نفسه
router.post("/fiscal-year-closings", requireAuth, requireRole("admin"), requirePermission("accounting.close_year"), async (req, res) => {
  const year = Number(req.body.year);
  if (!year) return res.status(400).json({ error: "لازم تحدد السنة" });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const already = await client.query("SELECT id FROM fiscal_year_closings WHERE year = $1 FOR UPDATE", [year]);
    if (already.rows.length > 0) {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: `السنة ${year} مقفولة بالفعل` });
    }

    const periods = await client.query("SELECT month, status FROM accounting_periods WHERE year = $1", [year]);
    const closedMonths = new Set(periods.rows.filter((p) => p.status === "CLOSED").map((p) => p.month));
    const missing = [];
    for (let m = 1; m <= 12; m++) if (!closedMonths.has(m)) missing.push(m);
    if (missing.length > 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: `لازم كل شهور سنة ${year} تكون مقفولة الأول - الشهور [${missing.join(", ")}] لسه مفتوحة` });
    }

    const linesRes = await client.query(
      `SELECT a.id, a.code, a.name, a.account_type,
              COALESCE(SUM(jel.debit),0) AS total_debit, COALESCE(SUM(jel.credit),0) AS total_credit
       FROM journal_entry_lines jel
       JOIN journal_entries je ON je.id = jel.journal_entry_id
       JOIN accounts a ON a.id = jel.account_id
       WHERE je.status <> 'DRAFT' AND je.source_type <> 'year_end_closing'
         AND EXTRACT(YEAR FROM je.entry_date) = $1
         AND a.account_type IN ('REVENUE', 'COGS', 'EXPENSE')
       GROUP BY a.id, a.code, a.name, a.account_type`,
      [year]
    );

    const retainedEarnings = await getAccountByCode(client, "3200");

    // كل مبلغ بيتحسب بوحدة قروش صحيحة (toCents) مرة واحدة بس لكل حساب - نفس أسلوب المرحلة 4C اللي
    // اتحل بيه باج فارق كسور عشري كان بيرفض القيد كـ"غير متزن" - جمع أرقام عشرية JS خام في حلقة بيراكم
    // خطأ تمثيل ثنائي بسيط لكن كافي إن مجموع المدين ميساويش مجموع الدائن بالظبط وقت التحقق في القاعدة
    const closingLines = [];
    let netIncomeCents = 0;
    for (const r of linesRes.rows) {
      const debit = Number(r.total_debit);
      const credit = Number(r.total_credit);
      const rawBalance = r.account_type === "REVENUE" ? credit - debit : debit - credit;
      const balanceCents = toCents(rawBalance);
      if (balanceCents === 0) continue;
      const balance = balanceCents / 100;
      const desc = `إقفال ${r.name} - سنة ${year}`;
      if (r.account_type === "REVENUE") {
        netIncomeCents += balanceCents;
        if (balanceCents > 0) closingLines.push({ accountId: r.id, debit: balance, credit: 0, description: desc });
        else closingLines.push({ accountId: r.id, debit: 0, credit: -balance, description: desc });
      } else {
        netIncomeCents -= balanceCents;
        if (balanceCents > 0) closingLines.push({ accountId: r.id, debit: 0, credit: balance, description: desc });
        else closingLines.push({ accountId: r.id, debit: -balance, credit: 0, description: desc });
      }
    }

    if (closingLines.length === 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: `مفيش حركة محاسبية مسجّلة على سنة ${year} أصلًا - مفيش حاجة تتقفل` });
    }

    const netIncome = netIncomeCents / 100;
    if (netIncomeCents > 0) {
      closingLines.push({ accountId: retainedEarnings.id, debit: 0, credit: netIncome, description: `صافي ربح سنة ${year} → أرباح مرحّلة` });
    } else if (netIncomeCents < 0) {
      closingLines.push({ accountId: retainedEarnings.id, debit: -netIncome, credit: 0, description: `صافي خسارة سنة ${year} → أرباح مرحّلة` });
    }

    const entryDate = `${year + 1}-01-01`;
    const result = await postJournalEntry(client, {
      entryDate, description: `قيد إقفال سنة مالية ${year}`, sourceType: "year_end_closing",
      lines: closingLines, userId: req.user.id, autoPost: true, idempotencyKey: `year-end-closing-${year}`,
    });

    const closing = await client.query(
      `INSERT INTO fiscal_year_closings (year, net_income, closed_by, journal_entry_id) VALUES ($1,$2,$3,$4) RETURNING *`,
      [year, netIncome, req.user.id, result.entry.id]
    );

    await logAudit(client, {
      userId: req.user.id, action: "FISCAL_YEAR_CLOSED", entityType: "fiscal_year_closing", entityId: closing.rows[0].id,
      metadata: { year, netIncome, journalEntryId: result.entry.id }, req,
    });

    await client.query("COMMIT");
    res.status(201).json({ ...closing.rows[0], journalEntry: result.entry });
  } catch (err) {
    await client.query("ROLLBACK");
    if (err.code === "23505") return res.status(409).json({ error: `السنة ${year} مقفولة بالفعل` });
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

module.exports = router;
