// المرحلة 4B: المصدر الوحيد لترحيل أي قيد محاسبي - أي كود عايز يسجل حدث مالي لازم يعدّي من هنا، من غير
// استثناء (زي db/inventory-ledger.js بالظبط لحركات المخزون). بيضمن:
//  1) اتزان القيد (مجموع مدين = مجموع دائن) - متحقق منه هنا وكمان بـtrigger على مستوى القاعدة (دفاع مزدوج)
//  2) الشهر المحاسبي مفتوح (accounting_periods) قبل أي ترحيل
//  3) idempotency اختياري - نفس نمط orders.js/purchase-orders.js/goods-receipts.js بالظبط (SAVEPOINT
//     بدل ROLLBACK كامل، لأن الدالة دي بتتنادى من جوه transaction أكبر (إنشاء أوردر، ترحيل GRN...) -
//     ROLLBACK عادي كان هيمسح شغل الـtransaction الأكبر كله مش بس محاولة الإدخال الفاشلة)
//
// لازم يتنادى بـclient واحد جوه transaction شغالة بالفعل (BEGIN اتعمل قبله) - نفس نمط باقي المشروع.

async function ensurePeriodOpen(client, entryDate) {
  const d = new Date(entryDate);
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth() + 1;
  const existing = await client.query(
    "SELECT status FROM accounting_periods WHERE year = $1 AND month = $2", [year, month]
  );
  if (existing.rows.length === 0) {
    await client.query(
      "INSERT INTO accounting_periods (year, month, status) VALUES ($1,$2,'OPEN') ON CONFLICT (year, month) DO NOTHING",
      [year, month]
    );
    return;
  }
  if (existing.rows[0].status === "CLOSED") {
    const err = new Error(`الشهر المحاسبي ${year}-${String(month).padStart(2, "0")} مقفول - مينفعش يترحّل عليه أي قيد جديد`);
    err.code = "PERIOD_CLOSED";
    throw err;
  }
}

// القيد الأساسي - lines: [{accountId, debit?, credit?, description?, branchId?, referenceType?, referenceId?}]
// autoPost=true (افتراضي) بيرحّل القيد POSTED فورًا (الأحداث التلقائية كلها معتمدة أصلًا وقت وصولها هنا)؛
// autoPost=false بيسيبه DRAFT (للقيود اليدوية اللي محتاجة اعتماد/ترحيل منفصل - routes/accounting.js)
async function postJournalEntry(client, {
  entryDate, description = null, sourceType, sourceId = null, branchId = null,
  lines, idempotencyKey = null, userId = null, autoPost = true,
}) {
  if (idempotencyKey) {
    const existing = await client.query("SELECT * FROM journal_entries WHERE idempotency_key = $1", [idempotencyKey]);
    if (existing.rows.length > 0) {
      const existingLines = await client.query("SELECT * FROM journal_entry_lines WHERE journal_entry_id = $1", [existing.rows[0].id]);
      return { entry: existing.rows[0], lines: existingLines.rows, duplicate: true };
    }
  }
  if (!Array.isArray(lines) || lines.length === 0) {
    const err = new Error("القيد لازم يكون له سطر واحد على الأقل");
    err.code = "JOURNAL_ENTRY_EMPTY";
    throw err;
  }
  const totalDebit = lines.reduce((s, l) => s + (Number(l.debit) || 0), 0);
  const totalCredit = lines.reduce((s, l) => s + (Number(l.credit) || 0), 0);
  if (Math.abs(totalDebit - totalCredit) > 0.0000001) {
    const err = new Error(`القيد غير متزن: مدين ${totalDebit} ≠ دائن ${totalCredit} - لازم يتساووا بالظبط`);
    err.code = "JOURNAL_ENTRY_UNBALANCED";
    throw err;
  }
  if (autoPost) await ensurePeriodOpen(client, entryDate);

  if (idempotencyKey) await client.query("SAVEPOINT sp_journal_entry");
  const seq = await client.query("SELECT nextval('journal_entry_number_seq') AS n");
  const entryNumber = `JE-${String(seq.rows[0].n).padStart(6, "0")}`;

  let entryId;
  try {
    const inserted = await client.query(
      `INSERT INTO journal_entries (entry_number, entry_date, description, source_type, source_id, branch_id, status, created_by, idempotency_key)
       VALUES ($1,$2,$3,$4,$5,$6,'DRAFT',$7,$8) RETURNING id`,
      [entryNumber, entryDate, description, sourceType, sourceId, branchId, userId, idempotencyKey]
    );
    entryId = inserted.rows[0].id;
  } catch (err) {
    if (err.code === "23505" && idempotencyKey) {
      await client.query("ROLLBACK TO SAVEPOINT sp_journal_entry");
      const existing = await client.query("SELECT * FROM journal_entries WHERE idempotency_key = $1", [idempotencyKey]);
      const existingLines = await client.query("SELECT * FROM journal_entry_lines WHERE journal_entry_id = $1", [existing.rows[0].id]);
      return { entry: existing.rows[0], lines: existingLines.rows, duplicate: true };
    }
    throw err;
  }

  for (const line of lines) {
    if (!line.accountId) throw new Error("كل سطر قيد لازم يكون له حساب (accountId)");
    await client.query(
      `INSERT INTO journal_entry_lines (journal_entry_id, account_id, debit, credit, description, branch_id, reference_type, reference_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [entryId, line.accountId, line.debit || 0, line.credit || 0, line.description || null,
       line.branchId || branchId, line.referenceType || null, line.referenceId || null]
    );
  }

  const updated = await client.query(
    autoPost
      ? `UPDATE journal_entries SET status = 'POSTED', posted_by = $1, posted_at = now() WHERE id = $2 RETURNING *`
      : `SELECT * FROM journal_entries WHERE id = $1`,
    autoPost ? [userId, entryId] : [entryId]
  );
  const insertedLines = await client.query("SELECT * FROM journal_entry_lines WHERE journal_entry_id = $1", [entryId]);
  return { entry: updated.rows[0], lines: insertedLines.rows, duplicate: false };
}

// قيد عكسي - بيعكس كل سطر (مدين↔دائن) لقيد POSTED موجود، من غير ما يلمسه أو يعدّله خالص. reversal_of_entry_id
// بيربطه بالأصلي، والأصلي نفسه بيتعلّم status='REVERSED' (لسه POSTED فعليًا، بس معلّم إنه اتعكس)
async function reverseJournalEntry(client, { originalEntryId, entryDate, reason, userId, idempotencyKey = null }) {
  const original = await client.query("SELECT * FROM journal_entries WHERE id = $1", [originalEntryId]);
  if (original.rows.length === 0) throw new Error("القيد الأصلي مش موجود");
  if (original.rows[0].status !== "POSTED") {
    const err = new Error("مينفعش تعكس قيد لسه مش POSTED");
    err.code = "ENTRY_NOT_POSTED";
    throw err;
  }
  if (original.rows[0].status === "REVERSED") {
    const err = new Error("القيد ده اتعكس بالفعل");
    err.code = "ALREADY_REVERSED";
    throw err;
  }

  const originalLines = await client.query("SELECT * FROM journal_entry_lines WHERE journal_entry_id = $1", [originalEntryId]);
  const reversedLines = originalLines.rows.map((l) => ({
    accountId: l.account_id, debit: Number(l.credit), credit: Number(l.debit),
    description: `عكس: ${l.description || ""}`.trim(), branchId: l.branch_id,
    referenceType: l.reference_type, referenceId: l.reference_id,
  }));

  const result = await postJournalEntry(client, {
    entryDate: entryDate || original.rows[0].entry_date, description: `عكس القيد ${original.rows[0].entry_number} - ${reason || ""}`.trim(),
    sourceType: "reversal", sourceId: originalEntryId, branchId: original.rows[0].branch_id,
    lines: reversedLines, idempotencyKey, userId, autoPost: true,
  });

  if (!result.duplicate) {
    await client.query(
      `UPDATE journal_entries SET status = 'REVERSED', reversed_by = $1, reversed_at = now() WHERE id = $2`,
      [userId, originalEntryId]
    );
  }
  return result;
}

// حساب كاش خاص بفرع معيّن - بيتنشئ تلقائيًا أول مرة (زي branch_inventory_stock بالظبط) لأن الفروع
// ديناميكية (بتتعمل بعد التثبيت) فمينفعش تتحط في شجرة الحسابات الافتراضية الثابتة في schema.sql
async function getOrCreateBranchCashAccount(client, branchId) {
  const code = `1100-${branchId}`;
  const existing = await client.query("SELECT * FROM accounts WHERE code = $1", [code]);
  if (existing.rows.length > 0) return existing.rows[0];

  const parent = await client.query("SELECT id FROM accounts WHERE code = '1100'");
  const branch = await client.query("SELECT name FROM branches WHERE id = $1", [branchId]);
  const inserted = await client.query(
    `INSERT INTO accounts (code, name, account_type, parent_account_id, branch_id, is_system_account)
     VALUES ($1,$2,'ASSET',$3,$4,TRUE)
     ON CONFLICT (code) DO UPDATE SET code = EXCLUDED.code
     RETURNING *`,
    [code, `الكاش - ${branch.rows[0]?.name || "فرع " + branchId}`, parent.rows[0]?.id || null, branchId]
  );
  return inserted.rows[0];
}

// المرحلة 7F: حساب عهدة كاش خاص بسائق معيّن - نفس نمط getOrCreateBranchCashAccount بالظبط (بيتنشئ
// تلقائيًا أول مرة، لأن السائقين ديناميكيين زي الفروع). بيمثّل "كاش لسه في إيد السائق" كأصل منفصل عن
// كاش الفرع نفسه - بيتحمّل وقت التسليم (استلم كاش من العميل) وبيتصفّى وقت التسوية (سلّم الكاش للفرع)
async function getOrCreateDriverCustodyAccount(client, driverId) {
  const code = `1150-${driverId}`;
  const existing = await client.query("SELECT * FROM accounts WHERE code = $1", [code]);
  if (existing.rows.length > 0) return existing.rows[0];

  const parent = await client.query("SELECT id FROM accounts WHERE code = '1100'");
  const driver = await client.query("SELECT name FROM drivers WHERE id = $1", [driverId]);
  const inserted = await client.query(
    `INSERT INTO accounts (code, name, account_type, parent_account_id, is_system_account)
     VALUES ($1,$2,'ASSET',$3,TRUE)
     ON CONFLICT (code) DO UPDATE SET code = EXCLUDED.code
     RETURNING *`,
    [code, `عهدة كاش - ${driver.rows[0]?.name || "سائق " + driverId}`, parent.rows[0]?.id || null]
  );
  return inserted.rows[0];
}

async function getAccountByCode(client, code) {
  const result = await client.query("SELECT * FROM accounts WHERE code = $1", [code]);
  if (result.rows.length === 0) throw new Error(`الحساب بالكود ${code} مش موجود - شجرة الحسابات الافتراضية ناقصة`);
  return result.rows[0];
}

module.exports = {
  postJournalEntry, reverseJournalEntry, ensurePeriodOpen,
  getOrCreateBranchCashAccount, getOrCreateDriverCustodyAccount, getAccountByCode,
};
