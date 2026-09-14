// Payment Control & Reconciliation - كل منطق القفل/التعديل/المطابقة/نقاط المخاطر في مكان واحد
// (نفس نمط accounting-engine.js/delivery-engine.js: routes/payment-control.js وroutes/orders.js
// طبقة HTTP/صلاحيات بس فوق الملف ده). نقاط المخاطر بتتحسب لحظيًا وقت الاستعلام (مش عمود مخزّن) - نفس
// فلسفة GET /api/reports/accounting-reconciliation بالظبط: "يقارن مصدرين مستقلين، مايوحّدش تلقائي".

// أوزان نقاط المخاطر - اقتراح جديد (مش قيم أصلية مسترجعة)، قابلة للمراجعة لاحقًا بناءً على بيانات فرع حقيقية
const RISK_WEIGHTS = {
  TALABAT_POS_MISMATCH: 40,
  TALABAT_CASH_DIFF_PER_50_EGP: 10,
  TALABAT_CASH_DIFF_CAP: 50,
  CHANNEL_UNMATCHED: 30,
  VISA_SETTLEMENT_DIFF_OVER_1_PERCENT: 40,
  REPEATED_ADJUSTMENTS_IN_SHIFT: 25,
  REJECTED_HIGH_TIER_ATTEMPT: 20,
};
const REPEATED_ADJUSTMENTS_THRESHOLD = 3;
const UNMATCHED_GRACE_DAYS = 3;

function riskTier(points) {
  if (points >= 60) return "HIGH";
  if (points >= 30) return "MEDIUM";
  return "LOW";
}

// بيتنادى من routes/orders.js لحظة إنشاء الطلب (لو paymentMethodId متحدد) أو أول مرة يتحدد فيها
// وقت التعديل (لو كان NULL وقت الإنشاء) - القفل فوري فور الاختيار، مش لحظة "قفل الطلب" منفصلة
// (النظام مفيهوش مفهوم "حساب مفتوح" أصلًا - راجع docs/PRINTING-SYSTEM.md حدود معروفة #2)
async function lockPaymentForOrder(client, {
  orderId, branchId, paymentMethodId, amount, channel, talabatCashCollected = 0, userId,
}) {
  const pm = await client.query("SELECT kind, settlement_channel FROM payment_methods WHERE id = $1", [paymentMethodId]);
  if (pm.rows.length === 0) throw new Error("طريقة الدفع مش موجودة");
  const { kind, settlement_channel: settlementChannel } = pm.rows[0];

  const inserted = await client.query(
    `INSERT INTO payments
      (order_id, branch_id, payment_method_id, method_kind, settlement_channel, channel, amount,
       talabat_cash_collected, locked_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     RETURNING *`,
    [orderId, branchId, paymentMethodId, kind, settlementChannel, channel, amount, talabatCashCollected, userId]
  );
  const payment = inserted.rows[0];

  await client.query(
    `INSERT INTO payment_audit_logs (payment_id, order_id, branch_id, actor_id, action_type, after_state)
     VALUES ($1,$2,$3,$4,'LOCK',$5)`,
    [payment.id, orderId, branchId, userId, JSON.stringify(payment)]
  );
  return payment;
}

// طلب تعديل دفع - amount_delta بيحدد مين لازم يعتمده بعدين (راجع applyAdjustmentApproval):
// لو المبلغ نفسه بيتغيّر، الفرق المطلق هو الـdelta؛ لو بس طريقة الدفع بتتغيّر (تصنيف القناة) من غير
// تغيير في المبلغ، المبلغ كله بيتحسب delta (إعادة تصنيف قناة كاملة أخطر من فرق مبلغ بسيط)
async function createAdjustmentRequest(client, { paymentId, requestedByUserId, reason, proposedPaymentMethodId, proposedAmount }) {
  const paymentRes = await client.query("SELECT * FROM payments WHERE id = $1 FOR UPDATE", [paymentId]);
  if (paymentRes.rows.length === 0) throw new Error("سجل الدفع مش موجود");
  const payment = paymentRes.rows[0];

  if (!proposedPaymentMethodId && proposedAmount === undefined) {
    throw new Error("لازم تحدد طريقة دفع جديدة أو مبلغ جديد على الأقل");
  }

  let amountDelta = 0;
  if (proposedAmount !== undefined && Number(proposedAmount) !== Number(payment.amount)) {
    amountDelta = Math.abs(Number(proposedAmount) - Number(payment.amount));
  } else if (proposedPaymentMethodId && Number(proposedPaymentMethodId) !== payment.payment_method_id) {
    amountDelta = Number(payment.amount);
  }

  const inserted = await client.query(
    `INSERT INTO payment_adjustment_requests
      (payment_id, requested_by, reason, proposed_payment_method_id, proposed_amount, amount_delta)
     VALUES ($1,$2,$3,$4,$5,$6)
     RETURNING *`,
    [paymentId, requestedByUserId, reason, proposedPaymentMethodId || null, proposedAmount ?? null, amountDelta]
  );
  const request = inserted.rows[0];

  await client.query(
    `INSERT INTO payment_audit_logs (payment_id, order_id, branch_id, actor_id, action_type, before_state, after_state)
     VALUES ($1,$2,$3,$4,'ADJUSTMENT_REQUESTED',$5,$6)`,
    [paymentId, payment.order_id, payment.branch_id, requestedByUserId, JSON.stringify(payment), JSON.stringify(request)]
  );
  return request;
}

// بتتنادى بعد ما الراوت يستهلك approval_grants (actionType='PAYMENT_ADJUSTMENT') بنفس نمط
// routes/orders.js بالظبط - السقف العالي بيتحقق هنا (بعد الاستهلاك، زي requiresAdminOnly بتاع الخصم)
async function applyAdjustmentApproval(client, { requestId, approver, highThresholdEgp }) {
  const reqRes = await client.query(
    "SELECT * FROM payment_adjustment_requests WHERE id = $1 FOR UPDATE", [requestId]
  );
  if (reqRes.rows.length === 0) throw new Error("طلب التعديل مش موجود");
  const request = reqRes.rows[0];
  if (request.status !== "PENDING") {
    const err = new Error("طلب التعديل ده اتبت فيه قبل كده");
    err.code = "ADJUSTMENT_ALREADY_DECIDED";
    throw err;
  }

  const requiresHighTier = Number(request.amount_delta) >= Number(highThresholdEgp);
  if (requiresHighTier && !["accountant", "admin"].includes(approver.role)) {
    const err = new Error(
      `التعديل ده كبير (${request.amount_delta} ج.م) - محتاج اعتماد محاسب أو أدمن، مش مشرف فرع بس`
    );
    err.code = "HIGH_TIER_REQUIRED";
    throw err;
  }

  const paymentRes = await client.query("SELECT * FROM payments WHERE id = $1 FOR UPDATE", [request.payment_id]);
  const paymentBefore = paymentRes.rows[0];

  let newPaymentMethodId = paymentBefore.payment_method_id;
  let newMethodKind = paymentBefore.method_kind;
  let newSettlementChannel = paymentBefore.settlement_channel;
  if (request.proposed_payment_method_id) {
    const pm = await client.query(
      "SELECT kind, settlement_channel FROM payment_methods WHERE id = $1", [request.proposed_payment_method_id]
    );
    if (pm.rows.length === 0) throw new Error("طريقة الدفع المقترحة مش موجودة");
    newPaymentMethodId = request.proposed_payment_method_id;
    newMethodKind = pm.rows[0].kind;
    newSettlementChannel = pm.rows[0].settlement_channel;
  }
  const newAmount = request.proposed_amount !== null ? request.proposed_amount : paymentBefore.amount;

  const updatedPayment = await client.query(
    `UPDATE payments SET payment_method_id = $1, method_kind = $2, settlement_channel = $3,
       amount = $4, status = 'ADJUSTED'
     WHERE id = $5 RETURNING *`,
    [newPaymentMethodId, newMethodKind, newSettlementChannel, newAmount, paymentBefore.id]
  );

  await client.query(
    `UPDATE payment_adjustment_requests SET status = 'APPROVED', decided_by = $1, decided_at = now() WHERE id = $2`,
    [approver.id, request.id]
  );

  await client.query(
    `INSERT INTO payment_audit_logs (payment_id, order_id, branch_id, actor_id, actor_role, action_type, before_state, after_state)
     VALUES ($1,$2,$3,$4,$5,'ADJUSTMENT_APPROVED',$6,$7)`,
    [paymentBefore.id, paymentBefore.order_id, paymentBefore.branch_id, approver.id, approver.role,
     JSON.stringify(paymentBefore), JSON.stringify(updatedPayment.rows[0])]
  );

  return { payment: updatedPayment.rows[0], request: { ...request, status: "APPROVED" } };
}

async function rejectAdjustmentRequest(client, { requestId, decidedByUserId, decidedByRole }) {
  const reqRes = await client.query(
    "SELECT * FROM payment_adjustment_requests WHERE id = $1 FOR UPDATE", [requestId]
  );
  if (reqRes.rows.length === 0) throw new Error("طلب التعديل مش موجود");
  const request = reqRes.rows[0];
  if (request.status !== "PENDING") {
    const err = new Error("طلب التعديل ده اتبت فيه قبل كده");
    err.code = "ADJUSTMENT_ALREADY_DECIDED";
    throw err;
  }
  await client.query(
    `UPDATE payment_adjustment_requests SET status = 'REJECTED', decided_by = $1, decided_at = now() WHERE id = $2`,
    [decidedByUserId, requestId]
  );
  const paymentRes = await client.query("SELECT * FROM payments WHERE id = $1", [request.payment_id]);
  await client.query(
    `INSERT INTO payment_audit_logs (payment_id, order_id, branch_id, actor_id, actor_role, action_type, before_state)
     VALUES ($1,$2,$3,$4,$5,'ADJUSTMENT_REJECTED',$6)`,
    [request.payment_id, paymentRes.rows[0]?.order_id, paymentRes.rows[0]?.branch_id, decidedByUserId, decidedByRole, JSON.stringify(request)]
  );
  return { ...request, status: "REJECTED" };
}

// -------------------- الفحوصات الثلاثة (Phase 1) + نقاط المخاطر --------------------

// فحص 1: أوردر طلبات (channel='talabat') اتسجّل بطريقة دفع kind='card_or_wallet' - أوردرات طلبات
// المفروض تبقى آجل (مستحق من الشركة) أو كاش محصّل، مش "فيزا POS" داخلية (العميل بيدفع للشركة/الطيار مش للكاشير)
async function findTalabatPosMismatches(client, { branchId, from, to }) {
  const result = await client.query(
    `SELECT p.id AS payment_id, p.order_id, p.branch_id, p.amount, p.locked_at, p.locked_by, u.name AS locked_by_name
     FROM payments p
     LEFT JOIN users u ON u.id = p.locked_by
     WHERE p.channel = 'talabat' AND p.method_kind = 'card_or_wallet'
       AND ($1::int IS NULL OR p.branch_id = $1)
       AND (p.locked_at AT TIME ZONE 'Africa/Cairo')::date BETWEEN $2 AND $3
     ORDER BY p.locked_at DESC`,
    [branchId || null, from, to]
  );
  return result.rows.map((r) => ({
    type: "TALABAT_POS_MISMATCH", points: RISK_WEIGHTS.TALABAT_POS_MISMATCH,
    paymentId: r.payment_id, orderId: r.order_id, branchId: r.branch_id, amount: Number(r.amount),
    detectedAt: r.locked_at, actor: r.locked_by_name,
    description: `أوردر طلبات #${r.order_id} اتسجّل بفيزا POS بدل كاش/آجل طلبات`,
  }));
}

// فحص 2: كاش طلبات المحصّل داخليًا (payments.talabat_cash_collected) مقابل كشف طلبات المُدخل يدويًا
// لنفس الفرع/اليوم
async function findTalabatCashDiscrepancies(client, { branchId, from, to }) {
  // ::text صريح - node-pg بيرجّع أعمدة DATE كـJS Date object افتراضيًا، واللي بيتحوّل وقت JSON.stringify
  // لـtimestamp كامل (2026-09-14T00:00:00.000Z) مش "2026-09-14" - بيبوّظ أي مقارنة نصية على "day" بعد كده
  const internal = await client.query(
    `SELECT branch_id, ((locked_at AT TIME ZONE 'Africa/Cairo')::date)::text AS day, SUM(talabat_cash_collected) AS total
     FROM payments
     WHERE channel = 'talabat' AND talabat_cash_collected > 0
       AND ($1::int IS NULL OR branch_id = $1)
       AND (locked_at AT TIME ZONE 'Africa/Cairo')::date BETWEEN $2 AND $3
     GROUP BY branch_id, day`,
    [branchId || null, from, to]
  );
  const external = await client.query(
    `SELECT branch_id, external_date::text AS day, SUM(external_amount) AS total
     FROM payment_reconciliation_records
     WHERE source = 'talabat_statement'
       AND ($1::int IS NULL OR branch_id = $1)
       AND external_date BETWEEN $2 AND $3
     GROUP BY branch_id, day`,
    [branchId || null, from, to]
  );
  const byKey = new Map();
  for (const row of internal.rows) {
    byKey.set(`${row.branch_id}|${row.day}`, { branchId: row.branch_id, day: row.day, internal: Number(row.total), external: 0 });
  }
  for (const row of external.rows) {
    const key = `${row.branch_id}|${row.day}`;
    const entry = byKey.get(key) || { branchId: row.branch_id, day: row.day, internal: 0, external: 0 };
    entry.external = Number(row.total);
    byKey.set(key, entry);
  }
  const exceptions = [];
  for (const entry of byKey.values()) {
    const diff = Math.round((entry.internal - entry.external) * 100) / 100;
    if (Math.abs(diff) < 0.01) continue;
    const points = Math.min(
      Math.ceil(Math.abs(diff) / 50) * RISK_WEIGHTS.TALABAT_CASH_DIFF_PER_50_EGP,
      RISK_WEIGHTS.TALABAT_CASH_DIFF_CAP
    );
    exceptions.push({
      type: "TALABAT_CASH_DIFF", points, branchId: entry.branchId, day: entry.day,
      internalAmount: entry.internal, externalAmount: entry.external, diff,
      description: `فرق كاش طلبات يوم ${entry.day}: داخلي ${entry.internal} مقابل كشف طلبات ${entry.external} (فرق ${diff})`,
    });
  }
  return exceptions;
}

// فحص 3: إنستاباي/أورانج كاش - دفعات داخلية من غير كشف مطابق، وكشوف من غير دفعة داخلية مطابقة،
// بعد فترة سماح (UNMATCHED_GRACE_DAYS) عشان مايتفلجش استثناء لسه في وقته الطبيعي
async function findChannelUnmatchedExceptions(client, { branchId, from, to, source, settlementChannel }) {
  const graceCutoff = `(CURRENT_DATE - INTERVAL '${UNMATCHED_GRACE_DAYS} days')`;

  const unmatchedInternal = await client.query(
    `SELECT p.id AS payment_id, p.order_id, p.branch_id, p.amount, p.locked_at
     FROM payments p
     WHERE p.settlement_channel = $1
       AND ($2::int IS NULL OR p.branch_id = $2)
       AND (p.locked_at AT TIME ZONE 'Africa/Cairo')::date BETWEEN $3 AND $4
       AND (p.locked_at AT TIME ZONE 'Africa/Cairo')::date < ${graceCutoff}
       AND NOT EXISTS (
         SELECT 1 FROM payment_reconciliation_records r
         WHERE r.matched_payment_id = p.id
       )
     ORDER BY p.locked_at DESC`,
    [settlementChannel, branchId || null, from, to]
  );
  const unmatchedExternal = await client.query(
    `SELECT id, branch_id, external_reference, external_amount, external_date
     FROM payment_reconciliation_records
     WHERE source = $1 AND match_status = 'UNMATCHED'
       AND ($2::int IS NULL OR branch_id = $2)
       AND external_date BETWEEN $3 AND $4
       AND external_date < ${graceCutoff}
     ORDER BY external_date DESC`,
    [source, branchId || null, from, to]
  );

  const exceptions = [];
  for (const r of unmatchedInternal.rows) {
    exceptions.push({
      type: `${source.toUpperCase()}_UNMATCHED_INTERNAL`, points: RISK_WEIGHTS.CHANNEL_UNMATCHED,
      paymentId: r.payment_id, orderId: r.order_id, branchId: r.branch_id, amount: Number(r.amount),
      detectedAt: r.locked_at,
      description: `دفعة ${source} (أوردر #${r.order_id}) من غير كشف حساب مطابق بعد ${UNMATCHED_GRACE_DAYS} أيام`,
    });
  }
  for (const r of unmatchedExternal.rows) {
    exceptions.push({
      type: `${source.toUpperCase()}_UNMATCHED_EXTERNAL`, points: RISK_WEIGHTS.CHANNEL_UNMATCHED,
      recordId: r.id, branchId: r.branch_id, amount: Number(r.external_amount), reference: r.external_reference,
      detectedAt: r.external_date,
      description: `سطر كشف ${source} (${r.external_reference || r.id}) من غير دفعة داخلية مطابقة بعد ${UNMATCHED_GRACE_DAYS} أيام`,
    });
  }
  return exceptions;
}

// فحص 4: تسوية فيزا - إجمالي payments بقناة visa_pos مقابل إجمالي كشف التسوية المُدخل يدويًا لنفس الفترة
async function findVisaSettlementDiscrepancy(client, { branchId, from, to }) {
  const internal = await client.query(
    `SELECT branch_id, SUM(amount) AS total
     FROM payments
     WHERE settlement_channel = 'visa_pos'
       AND ($1::int IS NULL OR branch_id = $1)
       AND (locked_at AT TIME ZONE 'Africa/Cairo')::date BETWEEN $2 AND $3
     GROUP BY branch_id`,
    [branchId || null, from, to]
  );
  const external = await client.query(
    `SELECT branch_id, SUM(external_amount) AS total
     FROM payment_reconciliation_records
     WHERE source = 'visa_settlement'
       AND ($1::int IS NULL OR branch_id = $1)
       AND external_date BETWEEN $2 AND $3
     GROUP BY branch_id`,
    [branchId || null, from, to]
  );
  const byBranch = new Map();
  for (const row of internal.rows) byBranch.set(row.branch_id, { branchId: row.branch_id, internal: Number(row.total), external: 0 });
  for (const row of external.rows) {
    const entry = byBranch.get(row.branch_id) || { branchId: row.branch_id, internal: 0, external: 0 };
    entry.external = Number(row.total);
    byBranch.set(row.branch_id, entry);
  }
  const exceptions = [];
  for (const entry of byBranch.values()) {
    if (entry.internal === 0 && entry.external === 0) continue;
    const diff = Math.round((entry.internal - entry.external) * 100) / 100;
    const diffPercent = entry.internal > 0 ? Math.abs(diff) / entry.internal : (entry.external > 0 ? 1 : 0);
    if (diffPercent <= 0.01) continue;
    exceptions.push({
      type: "VISA_SETTLEMENT_DIFF", points: RISK_WEIGHTS.VISA_SETTLEMENT_DIFF_OVER_1_PERCENT,
      branchId: entry.branchId, internalAmount: entry.internal, externalAmount: entry.external, diff,
      description: `فرق تسوية فيزا: داخلي ${entry.internal} مقابل كشف تسوية ${entry.external} (فرق ${diff}، ${(diffPercent * 100).toFixed(1)}%)`,
    });
  }
  return exceptions;
}

// إشارة سلوكية: نفس الكاشير طلب ≥3 تعديلات دفع في نفس الشيفت - مش دليل تلاعب بحد ذاته، بس نمط يستاهل مراجعة
async function findRepeatedAdjustmentsInShift(client, { branchId, from, to }) {
  const result = await client.query(
    `SELECT o.shift_id, par.requested_by, u.name AS requester_name, o.branch_id, COUNT(*) AS cnt,
       array_agg(par.id) AS request_ids
     FROM payment_adjustment_requests par
     JOIN payments p ON p.id = par.payment_id
     JOIN orders o ON o.id = p.order_id
     LEFT JOIN users u ON u.id = par.requested_by
     WHERE o.shift_id IS NOT NULL
       AND ($1::int IS NULL OR o.branch_id = $1)
       AND (par.requested_at AT TIME ZONE 'Africa/Cairo')::date BETWEEN $2 AND $3
     GROUP BY o.shift_id, par.requested_by, u.name, o.branch_id
     HAVING COUNT(*) >= $4`,
    [branchId || null, from, to, REPEATED_ADJUSTMENTS_THRESHOLD]
  );
  return result.rows.map((r) => ({
    type: "REPEATED_ADJUSTMENTS_IN_SHIFT", points: RISK_WEIGHTS.REPEATED_ADJUSTMENTS_IN_SHIFT,
    shiftId: r.shift_id, branchId: r.branch_id, actor: r.requester_name, count: Number(r.cnt),
    description: `${r.requester_name || "مستخدم"} قدّم ${r.cnt} طلبات تعديل دفع في نفس الشيفت`,
  }));
}

// كل الفحوصات مع بعض، مرتبة تنازليًا بالنقاط - ده اللي بيغذّي تبويب "الاستثناءات والمخاطر" والتقرير اليومي
async function computeExceptions(client, { branchId = null, from, to }) {
  const [talabatMismatch, talabatCashDiff, instapayUnmatched, orangeUnmatched, visaDiff, repeatedAdjustments] = await Promise.all([
    findTalabatPosMismatches(client, { branchId, from, to }),
    findTalabatCashDiscrepancies(client, { branchId, from, to }),
    findChannelUnmatchedExceptions(client, { branchId, from, to, source: "instapay", settlementChannel: "instapay" }),
    findChannelUnmatchedExceptions(client, { branchId, from, to, source: "orange_cash", settlementChannel: "orange_cash" }),
    findVisaSettlementDiscrepancy(client, { branchId, from, to }),
    findRepeatedAdjustmentsInShift(client, { branchId, from, to }),
  ]);
  const exceptions = [
    ...talabatMismatch, ...talabatCashDiff, ...instapayUnmatched, ...orangeUnmatched, ...visaDiff, ...repeatedAdjustments,
  ].sort((a, b) => b.points - a.points);
  const totalPoints = exceptions.reduce((sum, e) => sum + e.points, 0);
  return { exceptions, totalPoints, tier: riskTier(totalPoints) };
}

// نص مختصر (لرسالة واتساب/SMS) - نفس روح تقارير الطباعة الحالية بس نص عادي مش HTML
function formatOwnerReportMessage({ businessDate, exceptions, totalPoints, tier }) {
  const tierLabel = { HIGH: "خطر عالي", MEDIUM: "خطر متوسط", LOW: "خطر منخفض" }[tier];
  if (exceptions.length === 0) {
    return `ستاموني - تقرير استثناءات المدفوعات ${businessDate}: مفيش استثناءات النهاردة. تمام.`;
  }
  const byType = {};
  for (const e of exceptions) byType[e.type] = (byType[e.type] || 0) + 1;
  const summaryLines = Object.entries(byType).map(([type, count]) => `- ${type}: ${count}`).join("\n");
  return (
    `ستاموني - تقرير استثناءات المدفوعات ${businessDate}\n` +
    `إجمالي نقاط المخاطر: ${totalPoints} (${tierLabel})\n` +
    `عدد الاستثناءات: ${exceptions.length}\n${summaryLines}\n` +
    `التفاصيل الكاملة: لوحة التحكم في المدفوعات > الاستثناءات والمخاطر`
  );
}

module.exports = {
  RISK_WEIGHTS, riskTier,
  lockPaymentForOrder, createAdjustmentRequest, applyAdjustmentApproval, rejectAdjustmentRequest,
  findTalabatPosMismatches, findTalabatCashDiscrepancies, findChannelUnmatchedExceptions, findVisaSettlementDiscrepancy,
  findRepeatedAdjustmentsInShift, computeExceptions, formatOwnerReportMessage,
};
