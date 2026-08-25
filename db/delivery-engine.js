// المرحلة 7F: دورة حياة التوصيل والسائق - نفس نمط db/shift-engine.js بالظبط: مصدر الحقيقة الوحيد
// لأي عملية على dispatch_status/driver_settlements، بيتنادى من جوه transaction شغالة بالفعل (BEGIN
// اتعمل قبله) من routes/deliveries.js أو routes/driver-settlements.js. مفيش رقم بيتراكم يدوي - كاش
// السائق المعلّق للتسوية بيتحسب lives من orders الحقيقية وقت المعاينة أو التسوية بس، مش عن طريق عدّاد.
//
// dispatch_status منفصل عمدًا عن orders.status (نفس فلسفة payment_status المنفصلة عن status) - القيمة
// دي NULL لأي طلب مش دليفري، وبتتفعّل بس لما orderType='delivery':
//   UNASSIGNED -> ASSIGNED -> OUT_FOR_DELIVERY -> DELIVERED
//                                            \-> FAILED -> (UNASSIGNED لإعادة الجدولة) أو RETURNED (عن طريق POST /:id/void الموسّع)
const { logAudit } = require("./audit");
const {
  postJournalEntry, getOrCreateBranchCashAccount, getOrCreateDriverCustodyAccount, getAccountByCode,
} = require("./accounting-engine");

const ASSIGNABLE_DRIVER_STATUSES = ["AVAILABLE", "BUSY"];
const FAILURE_REASONS = ["CUSTOMER_UNREACHABLE", "CUSTOMER_REFUSED", "WRONG_ADDRESS", "CLOSED_LOCATION", "OTHER"];

function invalidTransition(message) {
  const err = new Error(message);
  err.code = "INVALID_DELIVERY_TRANSITION";
  return err;
}

// تعيين سائق - UNASSIGNED أو FAILED (إعادة تعيين بعد فشل) بس. مقفول على فرع الطلب (نفس فرع السائق) -
// الفحص الحقيقي إن الطلب "لسه في نفس الحالة" وقت التعيين هو قفل الصف (FOR UPDATE) في الـroute قبل ما
// الدالة دي تتنادى، مش هنا - نفس فلسفة openShift بالظبط
async function assignDriver(client, { order, driver, assignedByUserId }) {
  if (order.order_type !== "delivery") {
    const err = new Error("تعيين سائق بس لطلبات الدليفري");
    err.code = "NOT_DELIVERY_ORDER";
    throw err;
  }
  if (!["UNASSIGNED", "FAILED"].includes(order.dispatch_status)) {
    throw invalidTransition("الطلب ده مش في حالة تسمح بتعيين سائق جديد");
  }
  if (String(driver.branch_id) !== String(order.branch_id)) {
    const err = new Error("السائق ده مش تابع لفرع الطلب");
    err.code = "DRIVER_BRANCH_MISMATCH";
    throw err;
  }
  if (!driver.is_active || !ASSIGNABLE_DRIVER_STATUSES.includes(driver.status)) {
    const err = new Error("السائق ده مش متاح دلوقتي (موقوف/غير نشط/إجازة)");
    err.code = "DRIVER_NOT_AVAILABLE";
    throw err;
  }
  const result = await client.query(
    `UPDATE orders SET
       driver_id = $1, driver_name = $2, assigned_by = $3, assigned_at = now(),
       dispatch_status = 'ASSIGNED', delivery_failed_at = NULL, delivery_failure_reason = NULL, synced_at = NULL
     WHERE id = $4 RETURNING *`,
    [driver.id, driver.name, assignedByUserId, order.id]
  );
  await logAudit(client, {
    branchId: order.branch_id, userId: assignedByUserId, action: "DRIVER_ASSIGNED", entityType: "order", entityId: order.id,
    oldValues: { driverId: order.driver_id, dispatchStatus: order.dispatch_status },
    newValues: { driverId: driver.id, driverName: driver.name, dispatchStatus: "ASSIGNED" },
  });
  return result.rows[0];
}

// إلغاء تعيين - قبل ما السائق يتحرك بيه بس (ASSIGNED). بعد ما يتحرك (OUT_FOR_DELIVERY) مفيش رجوع -
// لازم يوصف كفشل تسليم (markFailed) بدل ما "يتلغى" وكأنه مكانش موجود
async function unassignDriver(client, { order, actorUserId }) {
  if (order.dispatch_status !== "ASSIGNED") {
    throw invalidTransition("مينفعش تلغي تعيين طلب بعد ما السائق يتحرك بيه فعليًا");
  }
  const result = await client.query(
    `UPDATE orders SET driver_id = NULL, assigned_by = NULL, assigned_at = NULL,
       dispatch_status = 'UNASSIGNED', synced_at = NULL
     WHERE id = $1 RETURNING *`,
    [order.id]
  );
  await logAudit(client, {
    branchId: order.branch_id, userId: actorUserId, action: "DRIVER_UNASSIGNED", entityType: "order", entityId: order.id,
    oldValues: { driverId: order.driver_id }, newValues: { driverId: null },
  });
  return result.rows[0];
}

// السائق خرج فعليًا - orders.status بيتزامن هنا مع 'out_for_delivery' (نفس القيمة القديمة اللي كانت
// بتتحدد من الـprompt() قبل المرحلة دي) عشان أي كود/تقرير قديم بيقرا status العادي يفضل شغال زي ما هو
async function markOutForDelivery(client, { order, actorUserId }) {
  if (order.dispatch_status !== "ASSIGNED") {
    throw invalidTransition("الطلب لازم يكون معيّن لسائق الأول قبل ما يتحرك");
  }
  const result = await client.query(
    `UPDATE orders SET status = 'out_for_delivery', dispatch_status = 'OUT_FOR_DELIVERY', synced_at = NULL
     WHERE id = $1 RETURNING *`,
    [order.id]
  );
  await client.query(
    `INSERT INTO order_status_log (order_id, status, changed_by, notes) VALUES ($1, 'out_for_delivery', $2, 'السائق خرج للتوصيل')`,
    [order.id, actorUserId]
  );
  await logAudit(client, {
    branchId: order.branch_id, userId: actorUserId, action: "DELIVERY_OUT_FOR_DELIVERY", entityType: "order", entityId: order.id,
    oldValues: { dispatchStatus: "ASSIGNED" }, newValues: { dispatchStatus: "OUT_FOR_DELIVERY" },
  });
  return result.rows[0];
}

// تسليم ناجح - لو الدفع كاش ولسه تحت التحصيل، لازم مبلغ محصّل فعليًا (COD) وبيتسجل قيد محاسبي بيحوّل
// "ذمة مدينة" لـ"عهدة كاش السائق" (مش كاش الفرع مباشرة - ده هيحصل بعدين وقت التسوية، الفلوس لسه فعليًا
// في إيد السائق مش في درج الفرع). أي فرق بين المتوقع (order.total) والمحصّل بيتسجل كسطر منفصل واضح،
// مش مخفي جوه الرقمين التانيين
async function markDelivered(client, { order, actorUserId, collectedAmount }) {
  if (order.dispatch_status !== "OUT_FOR_DELIVERY") {
    throw invalidTransition("الطلب لازم يكون في الطريق الأول عشان تسجّله اتسلّم");
  }
  const pmRes = await client.query("SELECT kind FROM payment_methods WHERE id = $1", [order.payment_method_id]);
  const paymentKind = pmRes.rows[0]?.kind || null;
  const isCashCollection = paymentKind === "cash" && order.payment_status === "pending_collection";

  let collectedAmountVal = null;
  let collectionVariance = null;
  if (isCashCollection) {
    const amt = Number(collectedAmount);
    if (collectedAmount === undefined || collectedAmount === null || Number.isNaN(amt) || amt < 0) {
      const err = new Error("لازم تسجّل المبلغ اللي حصّلته فعليًا (كاش عند الاستلام)");
      err.code = "COLLECTED_AMOUNT_REQUIRED";
      throw err;
    }
    collectedAmountVal = amt;
    collectionVariance = amt - Number(order.total);
  }

  const result = await client.query(
    `UPDATE orders SET
       status = 'completed', dispatch_status = 'DELIVERED', delivered_at = now(),
       payment_status = CASE WHEN $1 THEN 'collected' ELSE payment_status END,
       collected_amount = $2, collection_variance = $3, synced_at = NULL
     WHERE id = $4 RETURNING *`,
    [isCashCollection, collectedAmountVal, collectionVariance, order.id]
  );
  const updated = result.rows[0];

  await client.query(
    `INSERT INTO order_status_log (order_id, status, changed_by, notes) VALUES ($1, 'completed', $2, 'تسليم دليفري')`,
    [order.id, actorUserId]
  );

  if (isCashCollection && order.branch_id) {
    const custodyAccount = await getOrCreateDriverCustodyAccount(client, order.driver_id);
    const receivableAccount = await getAccountByCode(client, "1300");
    const lines = [
      { accountId: custodyAccount.id, debit: collectedAmountVal, branchId: order.branch_id, referenceType: "order", referenceId: order.id },
      { accountId: receivableAccount.id, credit: Number(order.total), branchId: order.branch_id, referenceType: "order", referenceId: order.id },
    ];
    const gap = Math.round((collectedAmountVal - Number(order.total)) * 100) / 100;
    if (gap > 0) {
      const otherRevenue = await getAccountByCode(client, "4300");
      lines.push({ accountId: otherRevenue.id, credit: gap, branchId: order.branch_id, description: "زيادة كاش عند التسليم" });
    } else if (gap < 0) {
      const otherExpense = await getAccountByCode(client, "6900");
      lines.push({ accountId: otherExpense.id, debit: -gap, branchId: order.branch_id, description: "عجز كاش عند التسليم" });
    }
    await postJournalEntry(client, {
      entryDate: new Date().toISOString().slice(0, 10),
      description: `تحصيل دليفري كاش - طلب #${order.id}`,
      sourceType: "delivery_collection", sourceId: order.id, branchId: order.branch_id,
      lines, idempotencyKey: `delivery-collection-${order.id}`, userId: actorUserId,
    });
  }

  await logAudit(client, {
    branchId: order.branch_id, userId: actorUserId, action: "DELIVERY_COLLECTED", entityType: "order", entityId: order.id,
    oldValues: { dispatchStatus: "OUT_FOR_DELIVERY" },
    newValues: { dispatchStatus: "DELIVERED", collectedAmount: collectedAmountVal, collectionVariance },
  });
  return updated;
}

// فشل تسليم - الطلب برضو فعليًا "لسه شغال" (لسه معدّي في الطريق فعليًا) لحد ما حد يقرر مصيره
// (resolveFailed تحت: إعادة جدولة أو رجوع/إلغاء). مفيش افتراض تلقائي إن الفلوس اتحصّلت أو لأ هنا
async function markFailed(client, { order, actorUserId, reason }) {
  if (order.dispatch_status !== "OUT_FOR_DELIVERY") {
    throw invalidTransition("مينفعش تسجّل فشل تسليم لطلب لسه مش في الطريق");
  }
  if (!FAILURE_REASONS.includes(reason)) {
    const err = new Error("سبب الفشل غير معروف");
    err.code = "INVALID_FAILURE_REASON";
    throw err;
  }
  const result = await client.query(
    `UPDATE orders SET dispatch_status = 'FAILED', delivery_failed_at = now(), delivery_failure_reason = $1, synced_at = NULL
     WHERE id = $2 RETURNING *`,
    [reason, order.id]
  );
  await logAudit(client, {
    branchId: order.branch_id, userId: actorUserId, action: "DELIVERY_FAILED", entityType: "order", entityId: order.id,
    oldValues: { dispatchStatus: "OUT_FOR_DELIVERY" }, newValues: { dispatchStatus: "FAILED", reason },
  });
  return result.rows[0];
}

// إعادة جدولة بعد فشل - السائق برجع للفرع بالطلب وهيتوزّع تاني (نفس السائق أو غيره)، من غير ما الطلب
// يتلغي خالص. لو القرار بدل كده "رجّع/إلغي" فده مش هنا - ده POST /api/orders/:id/void الموسّع (المرحلة
// 7F مدّته يقبل حالة out_for_delivery+FAILED)، عشان يعكس مخزون/نقاط ولاء/قيد البيع بنفس المنطق المُختبر
// أصلًا بدل ما نعيد كتابته تاني هنا (توثيق القرار ده في docs/DRIVER-OPERATIONS.md)
async function rescheduleFailed(client, { order, actorUserId }) {
  if (order.dispatch_status !== "FAILED") {
    throw invalidTransition("إعادة الجدولة بس لطلب فشل تسليمه فعليًا");
  }
  const result = await client.query(
    `UPDATE orders SET driver_id = NULL, assigned_by = NULL, assigned_at = NULL, dispatch_status = 'UNASSIGNED',
       delivery_failed_at = NULL, delivery_failure_reason = NULL, synced_at = NULL
     WHERE id = $1 RETURNING *`,
    [order.id]
  );
  await logAudit(client, {
    branchId: order.branch_id, userId: actorUserId, action: "DELIVERY_RESCHEDULED", entityType: "order", entityId: order.id,
    oldValues: { dispatchStatus: "FAILED" }, newValues: { dispatchStatus: "UNASSIGNED" },
  });
  return result.rows[0];
}

// ملخص الطلبات المعلّقة تسوية لسائق معيّن - محسوب حيّ من orders الحقيقية (بس الطلبات المُسلَّمة كاش
// اللي لسه معندهاش driver_settlement_id) - نفس فلسفة computeShiftFinancials بالظبط، بيتستخدم في
// المعاينة قبل التسوية وفي التسوية نفسها (بيتجمّد وقتها)
async function computeDriverUnsettledSummary(client, driverId) {
  const res = await client.query(
    `SELECT o.id, o.total, o.collected_amount, o.delivery_fee
     FROM orders o
     JOIN payment_methods pm ON pm.id = o.payment_method_id
     WHERE o.driver_id = $1 AND o.dispatch_status = 'DELIVERED' AND o.driver_settlement_id IS NULL AND pm.kind = 'cash'`,
    [driverId]
  );
  const orders = res.rows;
  const codExpected = orders.reduce((s, o) => s + Number(o.total), 0);
  const codCollected = orders.reduce((s, o) => s + Number(o.collected_amount || 0), 0);
  const deliveryFeesTotal = orders.reduce((s, o) => s + Number(o.delivery_fee || 0), 0);
  return {
    orderIds: orders.map((o) => o.id),
    orderCount: orders.length,
    codExpected,
    codCollected,
    codVariance: Math.round((codCollected - codExpected) * 100) / 100,
    deliveryFeesTotal,
    expectedHandover: codCollected,
  };
}

function classifySettlementVariance(variance, { ackThreshold }) {
  return Math.abs(Number(variance)) <= Number(ackThreshold) ? "NONE" : "PENDING_REVIEW";
}

// تسوية/تسليم كاش السائق - دفعة واحدة من كل طلباته المعلّقة. الحماية ضد سباق تسوية مزدوجة هي قفل
// صفوف الطلبات المرشحة (FOR UPDATE OF o) قبل إعادة حساب الملخص - لو تسوية تانية بدأت في نفس اللحظة
// هتستنى القفل ده، وبعد ما الأولى تعمل commit (وتحدد driver_settlement_id للطلبات) هتلاقي مفيش طلبات
// معلّقة خالص فتاخد NOTHING_TO_SETTLE بدل ما تمسك نفس الطلبات تاني
async function createSettlement(client, { driverId, branchId, settledByUserId, actualHandover, notes, thresholds }) {
  const lockRes = await client.query(
    `SELECT o.id FROM orders o JOIN payment_methods pm ON pm.id = o.payment_method_id
     WHERE o.driver_id = $1 AND o.dispatch_status = 'DELIVERED' AND o.driver_settlement_id IS NULL AND pm.kind = 'cash'
     FOR UPDATE OF o`,
    [driverId]
  );
  if (lockRes.rows.length === 0) {
    const err = new Error("مفيش طلبات معلّقة تسوية للسائق ده دلوقتي");
    err.code = "NOTHING_TO_SETTLE";
    throw err;
  }

  const summary = await computeDriverUnsettledSummary(client, driverId);
  const actualHandoverVal = Number(actualHandover);
  const handoverVariance = Math.round((actualHandoverVal - summary.expectedHandover) * 100) / 100;
  const varianceStatus = classifySettlementVariance(handoverVariance, thresholds);

  const inserted = await client.query(
    `INSERT INTO driver_settlements
      (driver_id, branch_id, settled_by, order_count, cod_expected, cod_collected, cod_variance,
       delivery_fees_total, expected_handover, actual_handover, handover_variance, variance_status, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     RETURNING *`,
    [driverId, branchId, settledByUserId, summary.orderCount, summary.codExpected, summary.codCollected,
     summary.codVariance, summary.deliveryFeesTotal, summary.expectedHandover, actualHandoverVal,
     handoverVariance, varianceStatus, notes || null]
  );
  const settlement = inserted.rows[0];

  await client.query(
    `UPDATE orders SET driver_settlement_id = $1 WHERE id = ANY($2::int[])`,
    [settlement.id, summary.orderIds]
  );

  const custodyAccount = await getOrCreateDriverCustodyAccount(client, driverId);
  const branchCashAccount = await getOrCreateBranchCashAccount(client, branchId);
  const lines = [
    { accountId: branchCashAccount.id, debit: actualHandoverVal, branchId },
    { accountId: custodyAccount.id, credit: summary.codCollected, branchId },
  ];
  if (handoverVariance > 0) {
    const otherRevenue = await getAccountByCode(client, "4300");
    lines.push({ accountId: otherRevenue.id, credit: handoverVariance, branchId, description: "زيادة كاش عند تسليم السائق" });
  } else if (handoverVariance < 0) {
    const otherExpense = await getAccountByCode(client, "6900");
    lines.push({ accountId: otherExpense.id, debit: -handoverVariance, branchId, description: "عجز كاش عند تسليم السائق" });
  }
  await postJournalEntry(client, {
    entryDate: new Date().toISOString().slice(0, 10),
    description: `تسوية كاش سائق - ${summary.orderCount} طلب`,
    sourceType: "driver_settlement", sourceId: settlement.id, branchId,
    lines, idempotencyKey: `driver-settlement-${settlement.id}`, userId: settledByUserId,
  });

  await logAudit(client, {
    branchId, userId: settledByUserId, action: "DRIVER_SETTLED", entityType: "driver_settlement", entityId: settlement.id,
    newValues: {
      driverId, orderCount: summary.orderCount, expectedHandover: summary.expectedHandover,
      actualHandover: actualHandoverVal, handoverVariance, varianceStatus,
    },
  });
  return settlement;
}

// مراجعة فرق تسليم كاش السائق - نفس منطق reviewShiftVariance بالظبط (اعتماد = إجراء فعلي اتاخد،
// إقرار = اطّلع واقتنع من غير إجراء إضافي)
async function reviewSettlement(client, { settlement, reviewerId, decision, notes }) {
  if (settlement.variance_status !== "PENDING_REVIEW") {
    const err = new Error("التسوية دي مش في حالة انتظار مراجعة");
    err.code = "SETTLEMENT_NOT_PENDING_REVIEW";
    throw err;
  }
  const newStatus = decision === "approve" ? "APPROVED" : "ACKNOWLEDGED";
  const result = await client.query(
    `UPDATE driver_settlements SET variance_status = $1, variance_reviewed_by = $2, variance_reviewed_at = now(), variance_review_notes = $3
     WHERE id = $4 AND variance_status = 'PENDING_REVIEW' RETURNING *`,
    [newStatus, reviewerId, notes || null, settlement.id]
  );
  if (result.rows.length === 0) {
    const err = new Error("التسوية دي مش في حالة انتظار مراجعة");
    err.code = "SETTLEMENT_NOT_PENDING_REVIEW";
    throw err;
  }
  await logAudit(client, {
    branchId: settlement.branch_id, userId: reviewerId, action: "DRIVER_SETTLEMENT_REVIEWED",
    entityType: "driver_settlement", entityId: settlement.id,
    oldValues: { varianceStatus: "PENDING_REVIEW" }, newValues: { varianceStatus: newStatus, notes: notes || null },
  });
  return result.rows[0];
}

module.exports = {
  FAILURE_REASONS,
  assignDriver, unassignDriver, markOutForDelivery, markDelivered, markFailed, rescheduleFailed,
  computeDriverUnsettledSummary, createSettlement, reviewSettlement,
};
