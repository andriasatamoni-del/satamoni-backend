// المرحلة 7E: شيفتات الكاشير - نفس نمط باقي محركات المشروع (inventory-ledger.js، accounting-engine.js):
// مصدر الحقيقة الوحيد لأي عملية على pos_shifts، بيتنادى من جوه transaction شغالة بالفعل (BEGIN اتعمل
// قبله) من routes/shifts.js. مفيش رقم بيتراكم يدوي على الشيفت وهو شغال - كل رقم (مبيعات كاش/كارت/
// استرجاعات/مصروفات نقدية) بيتحسب lives من الجداول الحقيقية (orders/expenses) وقت المعاينة أو القفل
// بس، مش عن طريق عدّادات بتتحدّث مع كل طلب (ده بيتجنّب أي سباق تحديث عداد، وبيخلي أي رقم قابل لإعادة
// الحساب والتدقيق في أي وقت من مصدره الأصلي).
const { logAudit } = require("./audit");
const {
  postJournalEntry, getOrCreateBranchCashAccount, getOrCreateEmployeeReceivableAccount, getAccountByCode,
} = require("./accounting-engine");

// المرحلة 8.6: الكاشير مايشوفش أي رقم مالي حساس عن شيفته خالص (كاش متوقع/فعلي/فرق/تفاصيل مبيعات) -
// ده بيتفرض على مستوى الـAPI response نفسه، مش إخفاء واجهة بس (لو حد شاف الـnetwork response خام
// كان لسه هيلاقي الأرقام). allowlist صريح (مش blocklist) عمدًا - أي عمود جديد يتضاف للجدول مستقبلًا
// بيتصفّى تلقائيًا لحد ما حد يضيفه هنا صراحة، مش العكس
const CASHIER_SAFE_SHIFT_FIELDS = [
  "id", "branch_id", "user_id", "status", "opened_at", "opening_cash", "opening_notes",
  "closed_at", "closed_by", "closing_notes", "order_count", "void_count", "created_at", "updated_at",
];
function sanitizeShiftForCashier(shift) {
  if (!shift) return shift;
  const out = {};
  for (const key of CASHIER_SAFE_SHIFT_FIELDS) out[key] = shift[key];
  return out;
}

// حساب أرقام الشيفت المالية لحظيًا من orders/expenses الحقيقية - بيتستخدم في المعاينة (قبل القفل) وفي
// القفل نفسه (بيتجمّد وقتها). toTs بيبقى وقت القفل الفعلي أو "دلوقتي" لو لسه معاينة/الشيفت شغال
async function computeShiftFinancials(client, { shiftId, branchId, openedAt, toTs }) {
  // مبيعات الكاش/الكارت/الأخرى بتتحسب من الطلبات "المحصّلة فعليًا" بس (payment_status='collected') -
  // مش أي طلب مرتبط بالشيفت. ده فارق جوهري لطلبات الدليفري اللي بتتسجل من الكاشير (source=pos) وهي لسه
  // "تحت التحصيل" (الطيار لسه ما رجعش/ما أكدش): فلوسها لسه مش في الدرج فعليًا وقت البيع، فمينفعش تتحسب
  // كاش موجود دلوقتي - لو اتحسبت هيبقى فيه فرق كاش وهمي وقت القفل مالوش أي علاقة بغلط الكاشير الفعلي.
  // order_count بيفضل بيعدّ كل الطلبات المرتبطة بالشيفت (المحصّلة وغيرها) لأنه رقم تشغيلي (كام طلب
  // اتسجل) مش رقم تسوية كاش - مش بيدخل في معادلة الكاش المتوقع أصلًا (calcExpectedCash تحت)
  // المرحلة 8.16: أوردرات طلبات (source='talabat') مستبعدة من فلتر "pm.kind = 'cash'" هنا عمدًا -
  // الطلب كله دايمًا بيترحّل محاسبيًا على حساب 1350 (مستحق من طلبات) بغض النظر عن طريقة الدفع
  // المختارة، إلا الجزء المحصّل كاش فعليًا في الفرع (talabat_cash_collected) اللي بيتضاف صراحة تحت -
  // ده هو اللي فعلاً دخل الدرج، مش إجمالي الطلب كله
  const salesRes = await client.query(
    `SELECT
       COALESCE(SUM(o.total) FILTER (WHERE pm.kind = 'cash' AND o.source <> 'talabat' AND o.status <> 'cancelled' AND o.payment_status = 'collected'), 0)
         + COALESCE(SUM(o.talabat_cash_collected) FILTER (WHERE o.source = 'talabat' AND o.status <> 'cancelled'), 0) AS cash_sales,
       COALESCE(SUM(o.total) FILTER (WHERE pm.kind = 'card_or_wallet' AND o.status <> 'cancelled' AND o.payment_status = 'collected'), 0) AS card_sales,
       COALESCE(SUM(o.total) FILTER (WHERE (pm.kind IS NULL OR pm.kind NOT IN ('cash','card_or_wallet')) AND o.status <> 'cancelled' AND o.payment_status = 'collected'), 0) AS other_sales,
       COALESCE(SUM(o.discount) FILTER (WHERE o.status <> 'cancelled'), 0) AS discounts_total,
       COUNT(*) FILTER (WHERE o.status <> 'cancelled') AS order_count
     FROM orders o
     LEFT JOIN payment_methods pm ON pm.id = o.payment_method_id
     WHERE o.shift_id = $1`,
    [shiftId]
  );

  // استرجاعات نقدية أثناء الفترة دي - لأي طلب اتباع كاش (في نفس الشيفت أو قبله) واتسترجع أثناء الشيفت
  // ده. لو الطلب الأصلي نفسه من نفس الشيفت، هو أصلًا مستبعد من cash_sales فوق (status='cancelled')،
  // فمينفعش يتخصم تاني هنا - كان هيبقى خصم مضاعف لكاش ما دخلش الدرج أصلًا وقت الشيفت ده من الأساس
  const refundsRes = await client.query(
    `SELECT
       COALESCE(SUM(o.total) FILTER (WHERE pm.kind = 'cash' AND (o.shift_id IS DISTINCT FROM $1)), 0) AS cash_refunds,
       COUNT(*) AS void_count
     FROM orders o
     LEFT JOIN payment_methods pm ON pm.id = o.payment_method_id
     WHERE o.voided = TRUE AND o.branch_id = $2
       AND o.voided_at >= $3 AND o.voided_at <= $4`,
    [shiftId, branchId, openedAt, toTs]
  );

  // المرحلة 7K: الحالات هنا اتوسّعت من POSTED بس لـSUBMITTED/APPROVED/POSTED - مصروف الكاشير النقدي
  // بيتسجل SUBMITTED (لسه محتاج مراجعة مدير/محاسب عبر /:id/review)، لكن الفلوس بتكون خرجت من الدرج
  // فعليًا وقت التسجيل نفسه، مش وقت المراجعة - فمينفعش ننتظر الترحيل المحاسبي عشان نحسبها هنا. توقيت
  // النافذة بقى COALESCE(posted_at, created_at) عشان لسه المصروف مش مرحّل (posted_at لسه NULL) وقتها
  // بيتحسب بتوقيت التسجيل الفعلي created_at بدل ما يتستبعد بالغلط
  const expensesRes = await client.query(
    `SELECT COALESCE(SUM(e.amount), 0) AS cash_expenses_total
     FROM expenses e
     JOIN payment_methods pm ON pm.id = e.payment_method_id
     WHERE e.branch_id = $1 AND e.status IN ('SUBMITTED', 'APPROVED', 'POSTED') AND pm.kind = 'cash'
       AND COALESCE(e.posted_at, e.created_at) >= $2 AND COALESCE(e.posted_at, e.created_at) <= $3`,
    [branchId, openedAt, toTs]
  );

  // المرحلة 7K: مشتريات نقدية اتسجلت من الكاشير أثناء الشيفت - جدول purchases مالوش مفهوم "طريقة دفع"
  // خالص (كل سطر فيه أصلًا كاش نقدي بالتعريف)، وأي حالة عدا REJECTED بتتحسب هنا (حتى PENDING لسه
  // منتظرة مراجعة) لأن الفلوس خرجت من الدرج فعليًا وقت التسجيل بغض النظر عن مراجعة المدير/المحاسب اللاحقة
  const purchasesRes = await client.query(
    `SELECT COALESCE(SUM(p.amount), 0) AS cash_purchases_total
     FROM purchases p
     WHERE p.branch_id = $1 AND p.status <> 'REJECTED'
       AND p.created_at >= $2 AND p.created_at <= $3`,
    [branchId, openedAt, toTs]
  );

  return {
    cashSales: Number(salesRes.rows[0].cash_sales),
    cardSales: Number(salesRes.rows[0].card_sales),
    otherSales: Number(salesRes.rows[0].other_sales),
    discountsTotal: Number(salesRes.rows[0].discounts_total),
    orderCount: Number(salesRes.rows[0].order_count),
    cashRefunds: Number(refundsRes.rows[0].cash_refunds),
    voidCount: Number(refundsRes.rows[0].void_count),
    cashExpensesTotal: Number(expensesRes.rows[0].cash_expenses_total),
    cashPurchasesTotal: Number(purchasesRes.rows[0].cash_purchases_total),
  };
}

// المعادلة الرسمية الوحيدة لحساب الكاش المتوقع - نفس الصيغة في كل مكان (معاينة، قفل، تقرير)
// ملحوظة: "سحوبات كاش" و"حركات كاش معتمدة تانية" مذكورة في مواصفة المرحلة دي بس معندهاش أي تمثيل
// في نموذج بيانات ستاموني الحالي (مفيش جدول/مفهوم "سحب كاش" مستقل) - اتسجّلت كقيد معروف في التقرير
// النهائي بدل ما تتخترع كيانات جديدة من غير أساس حقيقي في النظام
function calcExpectedCash({ openingCash, cashSales, cashRefunds, cashExpensesTotal, cashPurchasesTotal = 0 }) {
  return Number(openingCash) + cashSales - cashRefunds - cashExpensesTotal - cashPurchasesTotal;
}

function classifyVariance(variance, { ackThreshold, reviewThreshold }) {
  const abs = Math.abs(Number(variance));
  if (abs <= Number(ackThreshold)) return "NONE";
  return "PENDING_REVIEW"; // reviewThreshold بس إشارة بصرية لحدة الفرق في الواجهة، مش حالة تالتة منفصلة
}

// فتح شيفت - الحماية الحقيقية ضد سباق فتحين متزامنين هي partial UNIQUE INDEX على pos_shifts(user_id)
// WHERE status='ACTIVE' (زي orders.idempotency_key بالظبط) - الفحص المبدئي هنا تحسين أداء للحالة
// الشائعة بس، مش الحماية الفعلية
async function openShift(client, { branchId, userId, openingCash, openingNotes }) {
  const existing = await client.query(
    "SELECT id FROM pos_shifts WHERE user_id = $1 AND status = 'ACTIVE'",
    [userId]
  );
  if (existing.rows.length > 0) {
    const err = new Error("عندك شيفت شغال بالفعل - لازم تقفله الأول");
    err.code = "SHIFT_ALREADY_ACTIVE";
    throw err;
  }
  try {
    const result = await client.query(
      `INSERT INTO pos_shifts (branch_id, user_id, opening_cash, opening_notes)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [branchId, userId, openingCash, openingNotes || null]
    );
    await logAudit(client, {
      branchId, userId, action: "SHIFT_OPENED", entityType: "pos_shift", entityId: result.rows[0].id,
      newValues: { openingCash },
    });
    return result.rows[0];
  } catch (err) {
    if (err.code === "23505") {
      const dup = new Error("عندك شيفت شغال بالفعل - لازم تقفله الأول");
      dup.code = "SHIFT_ALREADY_ACTIVE";
      throw dup;
    }
    throw err;
  }
}

// معاينة الكاش المتوقع من غير أي تسجيل - الكاشير يشوفها قبل ما يعدّ الدرج فعليًا
async function previewExpectedCash(client, shift) {
  const financials = await computeShiftFinancials(client, {
    shiftId: shift.id, branchId: shift.branch_id, openedAt: shift.opened_at, toTs: new Date(),
  });
  const expectedCash = calcExpectedCash({
    openingCash: shift.opening_cash, cashSales: financials.cashSales,
    cashRefunds: financials.cashRefunds, cashExpensesTotal: financials.cashExpensesTotal,
    cashPurchasesTotal: financials.cashPurchasesTotal,
  });
  return { ...financials, openingCash: Number(shift.opening_cash), expectedCash };
}

// قفل الشيفت - الحساب بيتجمّد هنا بالظبط (مش هيتغيّر بعد كده حتى لو طلب جديد اتربط غلط أو استرجاع
// حصل بعدين لطلب من الشيفت ده) عشان تقرير الشيفت يفضل ثابت تاريخيًا زي ما اتقفل بالظبط
async function closeShift(client, { shift, actualCash, closingNotes, closedBy, thresholds }) {
  const closedAt = new Date();
  const financials = await computeShiftFinancials(client, {
    shiftId: shift.id, branchId: shift.branch_id, openedAt: shift.opened_at, toTs: closedAt,
  });
  const expectedCash = calcExpectedCash({
    openingCash: shift.opening_cash, cashSales: financials.cashSales,
    cashRefunds: financials.cashRefunds, cashExpensesTotal: financials.cashExpensesTotal,
    cashPurchasesTotal: financials.cashPurchasesTotal,
  });
  const cashVariance = Number(actualCash) - expectedCash;
  const varianceStatus = classifyVariance(cashVariance, thresholds);
  const shiftStatus = varianceStatus === "NONE" ? "CLOSED" : "PENDING_REVIEW";

  const result = await client.query(
    `UPDATE pos_shifts SET
       status = $1, closed_at = $2, closed_by = $3, actual_cash = $4, expected_cash = $5,
       cash_variance = $6, closing_notes = $7,
       cash_sales = $8, card_sales = $9, other_sales = $10, cash_refunds = $11,
       discounts_total = $12, cash_expenses_total = $13, order_count = $14, void_count = $15,
       variance_status = $16, cash_purchases_total = $17, updated_at = now()
     WHERE id = $18
     RETURNING *`,
    [
      shiftStatus, closedAt, closedBy, actualCash, expectedCash, cashVariance, closingNotes || null,
      financials.cashSales, financials.cardSales, financials.otherSales, financials.cashRefunds,
      financials.discountsTotal, financials.cashExpensesTotal, financials.orderCount, financials.voidCount,
      varianceStatus, financials.cashPurchasesTotal, shift.id,
    ]
  );
  await logAudit(client, {
    branchId: shift.branch_id, userId: closedBy, action: "SHIFT_CLOSED", entityType: "pos_shift", entityId: shift.id,
    oldValues: { status: shift.status },
    newValues: { status: shiftStatus, expectedCash, actualCash: Number(actualCash), cashVariance, varianceStatus },
  });
  return result.rows[0];
}

// مراجعة المدير على فرق كاش معلّق (PENDING_REVIEW) - "اعتماد" (ACKNOWLEDGED) يعني المدير قرأ السبب
// واقتنع بيه من غير ما يعتبره مشكلة تحتاج تصعيد؛ "موافقة" (APPROVED) يعني اتعمل تحقيق/إجراء فعلي.
// في الحالتين الشيفت نفسه بيتقفل نهائيًا (status='CLOSED') لأنه المراجعة خلصت واتخذ قرار بشأنه -
// الفرق الوحيد بينهم هو variance_status اللي بيفضل يبين في التقارير إن ده كان محتاج نظر إضافي
async function reviewShiftVariance(client, { shift, reviewerId, decision, notes }) {
  if (shift.status !== "PENDING_REVIEW") {
    const err = new Error("الشيفت ده مش في حالة انتظار مراجعة");
    err.code = "SHIFT_NOT_PENDING_REVIEW";
    throw err;
  }
  const varianceStatus = decision === "approve" ? "APPROVED" : "ACKNOWLEDGED";
  const result = await client.query(
    `UPDATE pos_shifts SET
       status = 'CLOSED', variance_status = $1, variance_reviewed_by = $2,
       variance_reviewed_at = now(), variance_review_notes = $3, updated_at = now()
     WHERE id = $4 AND status = 'PENDING_REVIEW'
     RETURNING *`,
    [varianceStatus, reviewerId, notes || null, shift.id]
  );
  if (result.rows.length === 0) {
    const err = new Error("الشيفت ده مش في حالة انتظار مراجعة");
    err.code = "SHIFT_NOT_PENDING_REVIEW";
    throw err;
  }
  const closedShift = result.rows[0];
  const cashVariance = Number(closedShift.cash_variance);

  // المرحلة 8.6: "موافقة" (approve) يعني المدير/المحاسب أكّد إن الفرق حقيقي ومحتاج إجراء فعلي - ده
  // بالظبط نقطة القرار اللي المهمة طلبتها ("لو محتاج قرار قابل للتهيئة، اعمل workflow مش تخترع سياسة")؛
  // approve/acknowledge الموجودين أصلًا هما القرار ده. "إقرار" (acknowledge) يعني اطّلع واقتنع (خطأ POS،
  // إلخ) من غير ما يحمّل الكاشير أي مسؤولية مالية - مفيش سلفة ولا قيد.
  // عجز (variance سالب) مؤكّد -> سلفة على الكاشير (payroll_adjustments نوع 'advance'، مربوطة فعليًا
  // بحساب صافي الراتب في services/payroll-engine.js - الخصم من الراتب هو "التسوية" نفسها، مفيش داعي
  // لآلية تسوية منفصلة). زيادة مؤكّدة (variance موجب) -> بتترحّل كإيراد آخر (4300)، نفس السياسة
  // المستخدمة أصلًا لفرق تسليم كاش السائق في db/delivery-engine.js (settleDriverCash) - مش سياسة مخترعة.
  let debtCreated = null;
  if (decision === "approve" && cashVariance !== 0) {
    const employeeRes = await client.query(
      "SELECT id, name FROM employees WHERE user_id = $1 LIMIT 1",
      [shift.user_id]
    );
    const branchCashAccount = await getOrCreateBranchCashAccount(client, shift.branch_id);

    if (cashVariance < 0) {
      if (employeeRes.rows.length === 0) {
        // مفيش ملف موظف مربوط بحساب الكاشير ده - مينفعش نسجّل سلفة من غير موظف حقيقي نربطها بيه.
        // مش هيقفل الشيفت أو يفشل المراجعة (ده مش ذنب الكاشير)، بس هيتسجل صراحة في الـaudit عشان
        // متابعة يدوية (لازم حد يربط حساب الكاشير ده بملف موظف قبل أي مراجعة تانية)
        await logAudit(client, {
          branchId: shift.branch_id, userId: reviewerId, action: "SHIFT_VARIANCE_DEBT_SKIPPED_NO_EMPLOYEE",
          entityType: "pos_shift", entityId: shift.id,
          newValues: { userId: shift.user_id, shortage: Math.abs(cashVariance) },
        });
      } else {
        const employee = employeeRes.rows[0];
        const receivableAccount = await getOrCreateEmployeeReceivableAccount(client, employee.id);
        const shortage = Math.round(Math.abs(cashVariance) * 100) / 100;
        await postJournalEntry(client, {
          entryDate: new Date().toISOString().slice(0, 10),
          description: `عجز كاش شيفت #${shift.id} - ${employee.name}`,
          sourceType: "shift_variance_debt", sourceId: shift.id, branchId: shift.branch_id,
          lines: [
            { accountId: receivableAccount.id, debit: shortage, branchId: shift.branch_id },
            { accountId: branchCashAccount.id, credit: shortage, branchId: shift.branch_id },
          ],
          idempotencyKey: `shift-variance-debt-${shift.id}`, userId: reviewerId,
        });
        const adjustment = await client.query(
          `INSERT INTO payroll_adjustments (employee_id, entry_date, adjustment_type, amount, notes, created_by, shift_id)
           VALUES ($1, CURRENT_DATE, 'advance', $2, $3, $4, $5) RETURNING *`,
          [employee.id, shortage, `عجز كاش شيفت #${shift.id} بتاريخ ${shift.opened_at}`, reviewerId, shift.id]
        );
        debtCreated = adjustment.rows[0];
        await logAudit(client, {
          branchId: shift.branch_id, userId: reviewerId, action: "SHIFT_VARIANCE_DEBT_CREATED",
          entityType: "payroll_adjustment", entityId: debtCreated.id,
          newValues: { shiftId: shift.id, employeeId: employee.id, amount: shortage },
        });
      }
    } else {
      const otherRevenue = await getAccountByCode(client, "4300");
      const surplus = Math.round(cashVariance * 100) / 100;
      await postJournalEntry(client, {
        entryDate: new Date().toISOString().slice(0, 10),
        description: `زيادة كاش شيفت #${shift.id}`,
        sourceType: "shift_variance_surplus", sourceId: shift.id, branchId: shift.branch_id,
        lines: [
          { accountId: branchCashAccount.id, debit: surplus, branchId: shift.branch_id },
          { accountId: otherRevenue.id, credit: surplus, branchId: shift.branch_id },
        ],
        idempotencyKey: `shift-variance-surplus-${shift.id}`, userId: reviewerId,
      });
      await logAudit(client, {
        branchId: shift.branch_id, userId: reviewerId, action: "SHIFT_VARIANCE_SURPLUS_POSTED",
        entityType: "pos_shift", entityId: shift.id,
        newValues: { shiftId: shift.id, amount: surplus },
      });
    }
  }

  await logAudit(client, {
    branchId: shift.branch_id, userId: reviewerId, action: "SHIFT_VARIANCE_REVIEWED",
    entityType: "pos_shift", entityId: shift.id,
    oldValues: { status: shift.status, varianceStatus: shift.variance_status },
    newValues: { status: "CLOSED", varianceStatus, notes: notes || null },
  });
  return { ...closedShift, debtCreated };
}

// قفل قسري (أدمن بس) - لحالات استثنائية زي كاشير سايب الشيفت شغال ومش موجود (نسي يقفل، انتهت
// الوردية، الخ). بيتحسب بنفس معادلة closeShift بالظبط، لكن بيتسجل FORCE_CLOSED مش CLOSED عشان
// يفضل واضح في أي تقرير إن القفل ده مكانش من الكاشير نفسه - وبيتطلب سبب إجباري في audit trail
async function forceCloseShift(client, { shift, actualCash, closingNotes, closedBy, thresholds, reason }) {
  if (!reason || !String(reason).trim()) {
    const err = new Error("لازم تكتب سبب القفل القسري");
    err.code = "FORCE_CLOSE_REASON_REQUIRED";
    throw err;
  }
  const closedAt = new Date();
  const financials = await computeShiftFinancials(client, {
    shiftId: shift.id, branchId: shift.branch_id, openedAt: shift.opened_at, toTs: closedAt,
  });
  const expectedCash = calcExpectedCash({
    openingCash: shift.opening_cash, cashSales: financials.cashSales,
    cashRefunds: financials.cashRefunds, cashExpensesTotal: financials.cashExpensesTotal,
    cashPurchasesTotal: financials.cashPurchasesTotal,
  });
  const actualCashVal = actualCash === null || actualCash === undefined ? null : Number(actualCash);
  const cashVariance = actualCashVal === null ? null : actualCashVal - expectedCash;
  const varianceStatus = cashVariance === null ? "NONE" : classifyVariance(cashVariance, thresholds);

  const result = await client.query(
    `UPDATE pos_shifts SET
       status = 'FORCE_CLOSED', closed_at = $1, closed_by = $2, actual_cash = $3, expected_cash = $4,
       cash_variance = $5, closing_notes = $6,
       cash_sales = $7, card_sales = $8, other_sales = $9, cash_refunds = $10,
       discounts_total = $11, cash_expenses_total = $12, order_count = $13, void_count = $14,
       variance_status = $15, cash_purchases_total = $16, updated_at = now()
     WHERE id = $17
     RETURNING *`,
    [
      closedAt, closedBy, actualCashVal, expectedCash, cashVariance, closingNotes || null,
      financials.cashSales, financials.cardSales, financials.otherSales, financials.cashRefunds,
      financials.discountsTotal, financials.cashExpensesTotal, financials.orderCount, financials.voidCount,
      varianceStatus, financials.cashPurchasesTotal, shift.id,
    ]
  );
  await logAudit(client, {
    branchId: shift.branch_id, userId: closedBy, action: "SHIFT_FORCE_CLOSED", entityType: "pos_shift", entityId: shift.id,
    oldValues: { status: shift.status },
    newValues: { status: "FORCE_CLOSED", expectedCash, actualCash: actualCashVal, cashVariance, varianceStatus },
    metadata: { reason },
  });
  return result.rows[0];
}

module.exports = {
  computeShiftFinancials, calcExpectedCash, classifyVariance,
  openShift, previewExpectedCash, closeShift, reviewShiftVariance, forceCloseShift,
  sanitizeShiftForCashier,
};
