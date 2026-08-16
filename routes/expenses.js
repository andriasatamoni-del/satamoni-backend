const express = require("express");
const router = express.Router();
const pool = require("../db/pool");
const { requireAuth, requireRole, assertOwnBranch } = require("../middleware/auth");
const { requirePermission, hasPermission } = require("../middleware/permissions");
const { logAudit } = require("../db/audit");
const { postJournalEntry, reverseJournalEntry, getOrCreateBranchCashAccount, getAccountByCode } = require("../db/accounting-engine");

const canManage = requireRole("admin", "accountant", "branch_manager");

// المرحلة 4B: بيرحّل مصروف محاسبيًا - مدين حساب البند المرتبط ببند المصروف (أو 6900 "مصروفات تشغيل
// أخرى" لو البند معندوش حساب محدد) / دائن: مورد (2100 - لو المصروف على ذمة مورد) أو بنك (1200 - لو
// طريقة الدفع مش كاش) أو كاش الفرع (افتراضي لو مفيش طريقة دفع ولا مورد محدد)
async function postExpenseJournalEntry(client, expense, userId) {
  const categoryRes = await client.query("SELECT account_id, name FROM expense_categories WHERE id = $1", [expense.category_id]);
  const category = categoryRes.rows[0];
  const debitAccount = category?.account_id
    ? (await client.query("SELECT * FROM accounts WHERE id = $1", [category.account_id])).rows[0]
    : await getAccountByCode(client, "6900");

  let creditAccount;
  let referenceType = null;
  let referenceId = null;
  if (expense.supplier_id) {
    creditAccount = await getAccountByCode(client, "2100");
    referenceType = "supplier";
    referenceId = expense.supplier_id;
  } else if (expense.payment_method_id) {
    const pm = await client.query("SELECT kind FROM payment_methods WHERE id = $1", [expense.payment_method_id]);
    creditAccount = pm.rows[0]?.kind === "cash"
      ? await getOrCreateBranchCashAccount(client, expense.branch_id)
      : await getAccountByCode(client, "1200");
  } else {
    creditAccount = await getOrCreateBranchCashAccount(client, expense.branch_id);
  }

  const je = await postJournalEntry(client, {
    entryDate: expense.business_date, description: `مصروف: ${category?.name || ""}`.trim(),
    sourceType: "expense", sourceId: expense.id, branchId: expense.branch_id,
    lines: [
      { accountId: debitAccount.id, debit: Number(expense.amount) },
      { accountId: creditAccount.id, credit: Number(expense.amount), referenceType, referenceId },
    ],
    idempotencyKey: `expense-${expense.id}`, userId,
  });
  return je.entry.id;
}

// ---------------- بنود المصروفات (تكويد) ----------------

// GET /api/expenses/categories - كل البنود (نشطة وغير نشطة) - أي حد يقدر يسجل مصروف محتاج يشوفها في الفورم
router.get("/categories", requireAuth, canManage, async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM expense_categories ORDER BY name");
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/expenses/categories - إضافة بند جديد (أدمن بس - عشان محدش يضيف بنود عشوائية)
router.post("/categories", requireAuth, requireRole("admin"), async (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: "لازم اسم البند" });
  try {
    const result = await pool.query(
      "INSERT INTO expense_categories (name) VALUES ($1) RETURNING *",
      [name]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    if (err.code === "23505") return res.status(409).json({ error: "البند ده موجود بالفعل" });
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/expenses/categories/:id - تعطيل/تفعيل، تعديل اسم بند، حد التنبيه، أو الحساب المحاسبي المرتبط (أدمن بس)
// alertThreshold: لو مصروف من البند ده تجاوز المبلغ ده، يتعلّم "غريب" في تقرير المصروفات - ابعت null لإلغائه
// accountId: الحساب في شجرة الحسابات اللي البند ده بيترحّل عليه - ابعت null عشان يرجع للافتراضي (6900)
router.patch("/categories/:id", requireAuth, requireRole("admin"), async (req, res) => {
  const { id } = req.params;
  const { name, isActive, alertThreshold, accountId } = req.body;
  const fields = [];
  const values = [];
  let i = 1;
  if (name !== undefined) { fields.push(`name = $${i++}`); values.push(name); }
  if (isActive !== undefined) { fields.push(`is_active = $${i++}`); values.push(isActive); }
  if (alertThreshold !== undefined) { fields.push(`alert_threshold = $${i++}`); values.push(alertThreshold); }
  if (accountId !== undefined) { fields.push(`account_id = $${i++}`); values.push(accountId); }
  if (fields.length === 0) return res.status(400).json({ error: "مفيش حاجة تتعدل" });

  values.push(id);
  try {
    const result = await pool.query(
      `UPDATE expense_categories SET ${fields.join(", ")} WHERE id = $${i} RETURNING *`,
      values
    );
    if (result.rows.length === 0) return res.status(404).json({ error: "البند مش موجود" });
    res.json(result.rows[0]);
  } catch (err) {
    if (err.code === "23503") return res.status(400).json({ error: "الحساب المحاسبي ده مش موجود" });
    res.status(500).json({ error: err.message });
  }
});

// GET /api/expenses?branchId=&date=&status=
router.get("/", requireAuth, canManage, async (req, res) => {
  let { branchId, date, status } = req.query;
  if (req.user.role === "branch_manager") {
    if (branchId && !assertOwnBranch(req.user, branchId)) {
      return res.status(403).json({ error: "معندكش صلاحية تشوف مصروفات فرع تاني" });
    }
    branchId = req.user.branchId;
  }
  try {
    const result = await pool.query(
      `SELECT e.*, ec.name AS category
       FROM expenses e
       JOIN expense_categories ec ON ec.id = e.category_id
       WHERE ($1::int IS NULL OR e.branch_id = $1)
         AND ($2::date IS NULL OR e.business_date = $2)
         AND ($3::text IS NULL OR e.status = $3)
       ORDER BY e.business_date DESC, e.id DESC`,
      [branchId || null, date || null, status || null]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/expenses/:id - تفاصيل مصروف واحد
router.get("/:id", requireAuth, canManage, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT e.*, ec.name AS category FROM expenses e JOIN expense_categories ec ON ec.id = e.category_id WHERE e.id = $1`,
      [req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: "المصروف مش موجود" });
    if (req.user.role === "branch_manager" && !assertOwnBranch(req.user, result.rows[0].branch_id)) {
      return res.status(403).json({ error: "معندكش صلاحية تشوف مصروف فرع تاني" });
    }
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/expenses - تسجيل مصروف يومي - لازم يختار بند من الليستة الثابتة (categoryId)، مش نص حر
// status (اختياري): 'DRAFT' أو 'SUBMITTED' لو عايز تستخدم مسار الاعتماد قبل الترحيل - لو متبعتش status
// خالص (السلوك الافتراضي والقديم) المصروف بيترحّل فورًا زي ما كان دايمًا (POSTED + قيد محاسبي تلقائي)
// {branchId, businessDate, categoryId, amount, notes, paymentMethodId?, supplierId?, status?, idempotencyKey?}
router.post("/", requireAuth, canManage, async (req, res) => {
  const { branchId, businessDate, categoryId, amount, notes, paymentMethodId, supplierId, status, idempotencyKey } = req.body;
  if (!branchId || !businessDate || !categoryId || !amount || Number(amount) <= 0) {
    return res.status(400).json({ error: "بيانات ناقصة أو المبلغ لازم يكون أكبر من صفر" });
  }
  if (req.user.role === "branch_manager" && !assertOwnBranch(req.user, branchId)) {
    return res.status(403).json({ error: "معندكش صلاحية تسجل مصروف على فرع تاني" });
  }
  const requestedStatus = status && ["DRAFT", "SUBMITTED"].includes(status) ? status : "POSTED";

  const client = await pool.connect();
  try {
    if (idempotencyKey) {
      const existing = await client.query("SELECT * FROM expenses WHERE idempotency_key = $1", [idempotencyKey]);
      if (existing.rows.length > 0) return res.status(200).json({ ...existing.rows[0], duplicate: true });
    }

    await client.query("BEGIN");
    let expense;
    try {
      expense = await client.query(
        `INSERT INTO expenses (branch_id, business_date, category_id, amount, notes, payment_method_id, supplier_id, status, created_by, idempotency_key)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [branchId, businessDate, categoryId, amount, notes || null, paymentMethodId || null, supplierId || null, requestedStatus, req.user.id, idempotencyKey || null]
      );
    } catch (err) {
      if (err.code === "23505" && idempotencyKey) {
        await client.query("ROLLBACK");
        const existing = await client.query("SELECT * FROM expenses WHERE idempotency_key = $1", [idempotencyKey]);
        return res.status(200).json({ ...existing.rows[0], duplicate: true });
      }
      if (err.code === "23503") {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "بند المصروف أو المورد ده مش موجود" });
      }
      throw err;
    }

    let journalEntryId = null;
    if (requestedStatus === "POSTED") {
      journalEntryId = await postExpenseJournalEntry(client, expense.rows[0], req.user.id);
      await client.query(
        "UPDATE expenses SET journal_entry_id = $1, posted_by = $2, posted_at = now() WHERE id = $3",
        [journalEntryId, req.user.id, expense.rows[0].id]
      );
    }

    await logAudit(client, {
      branchId, userId: req.user.id, action: "EXPENSE_CREATED", entityType: "expense", entityId: expense.rows[0].id,
      newValues: { categoryId, amount, status: requestedStatus }, req,
    });
    await client.query("COMMIT");
    res.status(201).json({ ...expense.rows[0], status: requestedStatus, journal_entry_id: journalEntryId, duplicate: false });
  } catch (err) {
    await client.query("ROLLBACK");
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// POST /api/expenses/:id/submit - DRAFT → SUBMITTED
router.post("/:id/submit", requireAuth, canManage, async (req, res) => {
  try {
    const existing = await pool.query("SELECT * FROM expenses WHERE id = $1", [req.params.id]);
    if (existing.rows.length === 0) return res.status(404).json({ error: "المصروف مش موجود" });
    const expense = existing.rows[0];
    if (expense.status !== "DRAFT") return res.status(400).json({ error: "المصروف ده مش في حالة مسودة" });
    if (!assertOwnBranch(req.user, expense.branch_id)) return res.status(403).json({ error: "معندكش صلاحية على فرع تاني" });

    const result = await pool.query("UPDATE expenses SET status = 'SUBMITTED' WHERE id = $1 RETURNING *", [req.params.id]);
    await logAudit(pool, {
      branchId: expense.branch_id, userId: req.user.id, action: "EXPENSE_SUBMITTED", entityType: "expense", entityId: expense.id, req,
    });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/expenses/:id/approve - SUBMITTED → APPROVED (اعتماد منفصل عن الترحيل، زي ما اتحدد صراحة)
router.post("/:id/approve", requireAuth, requirePermission("accounting.approve"), async (req, res) => {
  try {
    const existing = await pool.query("SELECT * FROM expenses WHERE id = $1", [req.params.id]);
    if (existing.rows.length === 0) return res.status(404).json({ error: "المصروف مش موجود" });
    const expense = existing.rows[0];
    if (expense.status !== "SUBMITTED") return res.status(400).json({ error: "المصروف ده مش في حالة مقدّم للاعتماد" });

    const result = await pool.query(
      "UPDATE expenses SET status = 'APPROVED', approved_by = $1 WHERE id = $2 RETURNING *", [req.user.id, req.params.id]
    );
    await logAudit(pool, {
      branchId: expense.branch_id, userId: req.user.id, action: "EXPENSE_APPROVED", entityType: "expense", entityId: expense.id, req,
    });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/expenses/:id/post - APPROVED → POSTED - بيترحّل القيد المحاسبي هنا بالظبط
router.post("/:id/post", requireAuth, requirePermission("accounting.post"), async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const existing = await client.query("SELECT * FROM expenses WHERE id = $1 FOR UPDATE", [req.params.id]);
    if (existing.rows.length === 0) { await client.query("ROLLBACK"); return res.status(404).json({ error: "المصروف مش موجود" }); }
    const expense = existing.rows[0];
    if (expense.status !== "APPROVED") {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "المصروف ده لازم يتاعتمد الأول قبل الترحيل" });
    }

    const journalEntryId = await postExpenseJournalEntry(client, expense, req.user.id);
    const result = await client.query(
      "UPDATE expenses SET status = 'POSTED', posted_by = $1, posted_at = now(), journal_entry_id = $2 WHERE id = $3 RETURNING *",
      [req.user.id, journalEntryId, req.params.id]
    );
    await logAudit(client, {
      branchId: expense.branch_id, userId: req.user.id, action: "EXPENSE_POSTED", entityType: "expense", entityId: expense.id,
      newValues: { journalEntryId }, req,
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

// POST /api/expenses/:id/cancel - إلغاء مصروف - قبل الترحيل مفتوح لأي حد له صلاحية إدارة مصروفات فرعه،
// بعد الترحيل محتاج صلاحية عكس قيود (أدمن بس زي ما اتحدد صراحة) وبيعكس القيد المحاسبي عكس - مش مسح
router.post("/:id/cancel", requireAuth, canManage, async (req, res) => {
  const { reason } = req.body;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const existing = await client.query("SELECT * FROM expenses WHERE id = $1 FOR UPDATE", [req.params.id]);
    if (existing.rows.length === 0) { await client.query("ROLLBACK"); return res.status(404).json({ error: "المصروف مش موجود" }); }
    const expense = existing.rows[0];
    if (expense.status === "CANCELLED") { await client.query("ROLLBACK"); return res.status(400).json({ error: "المصروف ده ملغي بالفعل" }); }
    if (!assertOwnBranch(req.user, expense.branch_id)) {
      await client.query("ROLLBACK");
      return res.status(403).json({ error: "معندكش صلاحية على فرع تاني" });
    }

    if (expense.status === "POSTED") {
      if (!hasPermission(req.user.role, "accounting.reverse")) {
        await client.query("ROLLBACK");
        return res.status(403).json({ error: "إلغاء مصروف مرحّل يحتاج صلاحية عكس قيود (أدمن بس)" });
      }
      if (expense.journal_entry_id) {
        await reverseJournalEntry(client, {
          originalEntryId: expense.journal_entry_id, entryDate: new Date().toISOString().slice(0, 10),
          reason: reason || "إلغاء مصروف", userId: req.user.id, idempotencyKey: `expense-cancel-${expense.id}`,
        });
      }
    }

    const result = await client.query(
      "UPDATE expenses SET status = 'CANCELLED', cancelled_by = $1, cancelled_at = now() WHERE id = $2 RETURNING *",
      [req.user.id, req.params.id]
    );
    await logAudit(client, {
      branchId: expense.branch_id, userId: req.user.id, action: "EXPENSE_CANCELLED", entityType: "expense", entityId: expense.id,
      metadata: { reason, hadPostedEntry: expense.status === "POSTED" }, req,
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
