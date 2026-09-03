// المرحلة 8.42: البنوك وحسابات البنوك - إدارة أدمن بس (banks.manage)، رؤية للمحاسب (banks.view).
// كل حساب بنكي بيتربط بخزينة (treasuries) وحساب حقيقي في شجرة الحسابات - راجع
// db/accounting-engine.js createBankAccountTreasury للتفاصيل
const express = require("express");
const router = express.Router();
const pool = require("../db/pool");
const { requireAuth } = require("../middleware/auth");
const { requirePermission } = require("../middleware/permissions");
const { createBankAccountTreasury } = require("../db/accounting-engine");
const { logAudit } = require("../db/audit");

// GET /api/banks - كل البنوك المسجّلة
router.get("/", requireAuth, requirePermission("banks.view"), async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM banks ORDER BY name");
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/banks - {name}
router.post("/", requireAuth, requirePermission("banks.manage"), async (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: "لازم اسم البنك" });
  try {
    const result = await pool.query("INSERT INTO banks (name) VALUES ($1) RETURNING *", [name.trim()]);
    await logAudit(pool, { userId: req.user.id, action: "BANK_CREATED", entityType: "bank", entityId: result.rows[0].id, newValues: { name } });
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/banks/:id - {name?, isActive?}
router.patch("/:id", requireAuth, requirePermission("banks.manage"), async (req, res) => {
  const { name, isActive } = req.body;
  if (name === undefined && isActive === undefined) return res.status(400).json({ error: "مفيش حاجة تتعدل" });
  const fields = [];
  const values = [];
  let i = 1;
  if (name !== undefined) { fields.push(`name = $${i++}`); values.push(name); }
  if (isActive !== undefined) { fields.push(`is_active = $${i++}`); values.push(!!isActive); }
  values.push(req.params.id);
  try {
    const result = await pool.query(`UPDATE banks SET ${fields.join(", ")} WHERE id = $${i} RETURNING *`, values);
    if (result.rows.length === 0) return res.status(404).json({ error: "البنك مش موجود" });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/banks/accounts - كل الحسابات البنكية (مع اسم البنك ورصيدها الحالي)
router.get("/accounts", requireAuth, requirePermission("banks.view"), async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT ba.*, bk.name AS bank_name, t.name AS treasury_name, t.account_id, a.code AS account_code,
              COALESCE((
                SELECT SUM(jel.debit) - SUM(jel.credit)
                FROM journal_entry_lines jel JOIN journal_entries je ON je.id = jel.journal_entry_id
                WHERE jel.account_id = t.account_id AND je.status <> 'DRAFT'
              ), 0) AS balance
       FROM bank_accounts ba
       JOIN banks bk ON bk.id = ba.bank_id
       JOIN treasuries t ON t.id = ba.treasury_id
       JOIN accounts a ON a.id = t.account_id
       ORDER BY bk.name, ba.account_number NULLS LAST`
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/banks/accounts - {bankId, name, accountNumber?, iban?, bankBranchName?, notes?, branchId?}
// branchId اختياري - لو الحساب البنكي خاص بفرع معيّن (مش مشترك على مستوى الشركة كلها)
router.post("/accounts", requireAuth, requirePermission("banks.manage"), async (req, res) => {
  const { bankId, name, accountNumber, iban, bankBranchName, notes, branchId } = req.body;
  if (!bankId || !name || !name.trim()) return res.status(400).json({ error: "لازم بنك واسم للحساب" });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const bank = await client.query("SELECT * FROM banks WHERE id = $1", [bankId]);
    if (bank.rows.length === 0) { await client.query("ROLLBACK"); return res.status(404).json({ error: "البنك مش موجود" }); }

    const { treasury } = await createBankAccountTreasury(client, { name: name.trim(), branchId: branchId || null });
    const inserted = await client.query(
      `INSERT INTO bank_accounts (bank_id, treasury_id, account_number, iban, bank_branch_name, notes)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [bankId, treasury.id, accountNumber || null, iban || null, bankBranchName || null, notes || null]
    );
    await logAudit(client, {
      userId: req.user.id, action: "BANK_ACCOUNT_CREATED", entityType: "bank_account", entityId: inserted.rows[0].id,
      newValues: { bankId, name, accountNumber, iban },
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

// PATCH /api/banks/accounts/:id - تعديل بيانات الحساب البنكي (مش الحساب المحاسبي نفسه - ده ثابت)
router.patch("/accounts/:id", requireAuth, requirePermission("banks.manage"), async (req, res) => {
  const { accountNumber, iban, bankBranchName, notes, isActive } = req.body;
  const fields = [];
  const values = [];
  let i = 1;
  if (accountNumber !== undefined) { fields.push(`account_number = $${i++}`); values.push(accountNumber); }
  if (iban !== undefined) { fields.push(`iban = $${i++}`); values.push(iban); }
  if (bankBranchName !== undefined) { fields.push(`bank_branch_name = $${i++}`); values.push(bankBranchName); }
  if (notes !== undefined) { fields.push(`notes = $${i++}`); values.push(notes); }
  if (isActive !== undefined) { fields.push(`is_active = $${i++}`); values.push(!!isActive); }
  if (fields.length === 0) return res.status(400).json({ error: "مفيش حاجة تتعدل" });
  values.push(req.params.id);
  try {
    const result = await pool.query(`UPDATE bank_accounts SET ${fields.join(", ")} WHERE id = $${i} RETURNING *`, values);
    if (result.rows.length === 0) return res.status(404).json({ error: "الحساب البنكي مش موجود" });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
