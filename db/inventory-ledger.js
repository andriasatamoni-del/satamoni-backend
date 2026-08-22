// المصدر الأساسي لأي تغيير في رصيد المخزون - أي كود عايز يغيّر branch_inventory_stock لازم يعدّي
// من هنا، من غير استثناء. بيضمن:
//  1) قفل الصف (SELECT ... FOR UPDATE) عشان يمنع سباق بين حركتين على نفس الصنف/الفرع في نفس اللحظة
//  2) quantity_before/quantity_after دقيقين لكل حركة (تاريخ رصيد كامل قابل للمراجعة)
//  3) idempotency_key اختياري - لو اتكرر نفس المفتاح (retry شبكة/مزامنة) بيرجّع الحركة الأصلية من غير تكرار
//  4) سياسة الرصيد السالب بمستويين (inventory_items.negative_stock_policy): STRICT ممنوع خالص، أو
//     ALLOW_WITH_APPROVAL ممنوع إلا بموافقة صريحة (negativeStockOverrideApproved)
//  5) صرف تلقائي من الدفعات (FEFO/FIFO) لو الصنف متتبّع بدفعات - بيحدد تكلفة الحركة الفعلية
//
// لازم يتنادى بـclient واحد جوه transaction شغالة بالفعل (BEGIN اتعمل قبله) - نفس نمط باقي المشروع.

// بيرجّع تفصيل كل دفعة اتصرف منها (مش بس متوسط التكلفة) - مهم للتحويلات اللي محتاجة تنقل هوية الدفعة
// (رقمها/صلاحيتها) مع الكمية المنقولة، مش تكلفة مجمّعة بس. بترجع null لو الصنف مش متتبّع بدفعات أصلًا.
async function consumeFromBatches(client, { branchId, inventoryItemId, quantity }) {
  const settings = await client.query("SELECT batch_consumption_method FROM pos_settings WHERE id = 1");
  const method = settings.rows[0]?.batch_consumption_method || "FEFO";
  const orderBy = method === "FIFO" ? "received_date ASC NULLS LAST, id ASC" : "expiry_date ASC NULLS LAST, id ASC";

  const batches = await client.query(
    `SELECT * FROM inventory_batches
     WHERE inventory_item_id = $1 AND branch_id = $2 AND status = 'active' AND remaining_quantity > 0
     ORDER BY ${orderBy}
     FOR UPDATE`,
    [inventoryItemId, branchId]
  );
  if (batches.rows.length === 0) return null; // الصنف ده مش متتبّع بدفعات - استخدم unit_cost العادي

  let remaining = quantity;
  let totalCost = 0;
  let lastBatchId = null;
  const consumed = [];
  for (const b of batches.rows) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, Number(b.remaining_quantity));
    if (take <= 0) continue;
    totalCost += take * Number(b.unit_cost || 0);
    remaining -= take;
    lastBatchId = b.id;
    consumed.push({
      batchId: b.id, quantity: take, unitCost: b.unit_cost != null ? Number(b.unit_cost) : null,
      batchNumber: b.batch_number, expiryDate: b.expiry_date, productionDate: b.production_date,
    });
    const newRemaining = Number(b.remaining_quantity) - take;
    await client.query(
      `UPDATE inventory_batches SET remaining_quantity = $2::numeric, status = CASE WHEN $2::numeric <= 0 THEN 'depleted' ELSE status END WHERE id = $1`,
      [b.id, newRemaining]
    );
  }
  // لو الكمية المطلوبة أكبر من كل الدفعات المتاحة (رصيد إجمالي أعلى من مجموع الدفعات المسجّلة لأي سبب)،
  // الباقي بياخد تكلفة آخر دفعة اتصرف منها كتقريب معقول. المرحلة 6: الباقي ده لازم يترجع كجزء من
  // consumed برضه (batchId: null) - قبل كده كان بيتحسب في totalCost/weightedUnitCost بس من غير ما
  // يترجع كجزء قابل للتسجيل، فأي Caller بيلف على consumed.consumed بس (kitchen-transfers.js،
  // production.js) كان بيسجل حركة/يخصم رصيد بقيمة الدفعات المتاحة بس ويتجاهل الباقي تمامًا - فرق
  // حقيقي بين الرصيد المتاح فعليًا والمسجّل، اتكشف بالتحقق الفعلي في اختبارات تكامل المرحلة 6 (تحويل
  // بكمية أكبر من رصيد الدفعة المتاحة). دلوقتي كل الكمية المطلوبة بترجع مغطاة داخل consumed دايمًا.
  if (remaining > 0 && batches.rows.length > 0) {
    const lastCost = Number(batches.rows[batches.rows.length - 1].unit_cost || 0);
    totalCost += remaining * lastCost;
    consumed.push({ batchId: null, quantity: remaining, unitCost: lastCost, batchNumber: null, expiryDate: null, productionDate: null });
  }
  const weightedUnitCost = quantity > 0 ? totalCost / quantity : null;
  return { weightedUnitCost, lastBatchId, consumed };
}

async function postInventoryMovement(client, {
  branchId, inventoryItemId, movementType, quantity,
  referenceType = null, referenceId = null, unit = null, unitCost = null,
  batchId = null, reason = null, notes = null, userId = null, idempotencyKey = null,
  businessDate = null,
  // ALLOW_WITH_APPROVAL بس هو اللي بيحتاج الـflag ده عشان يعدّي - لازم يبقى معتمد صراحة (موافقة PIN
  // وقت البيع، أو الدور نفسه مخوّل زي مدير فرع/أدمن بيستخدم /stock/adjust مباشرة - دوره هو الموافقة).
  // STRICT ممنوع خالص مهما كانت قيمة الـflag دي - مفيش تجاوز ليها إطلاقًا
  negativeStockOverrideApproved = false,
  // التحويلات بين الفروع بتحل هوية الدفعة (batch) بنفسها مقدمًا عشان تنقلها زي ما هي للفرع المستلم -
  // لو true، الدالة مش بتنادي consumeFromBatches تاني (كانت هتستهلك من دفعة تانية غلط) وبتستخدم
  // unitCost/batchId المُمرَّرين زي ما هما
  skipBatchConsumption = false,
}) {
  if (!branchId || !inventoryItemId || !movementType || quantity === undefined || quantity === null) {
    throw new Error("بيانات حركة المخزون ناقصة");
  }
  if (Number(quantity) === 0) {
    throw new Error("كمية الحركة لازم تكون مختلفة عن صفر");
  }

  if (idempotencyKey) {
    const existing = await client.query(
      "SELECT * FROM inventory_movements WHERE idempotency_key = $1", [idempotencyKey]
    );
    if (existing.rows.length > 0) return { movement: existing.rows[0], duplicate: true, negativeOverrideUsed: false };
  }

  // نضمن وجود صف الرصيد الأول (لو أول حركة على الصنف ده في الفرع ده) وبعدين نقفله - القفل هنا هو
  // اللي بيمنع أي سباق: أي حركة تانية على نفس (branch_id, inventory_item_id) هتستنى لحد ما الـtransaction
  // دي تخلص COMMIT/ROLLBACK قبل ما تكمل، فمينفعش يحصل خصم مزدوج من نفس الرصيد في نفس اللحظة
  await client.query(
    `INSERT INTO branch_inventory_stock (branch_id, inventory_item_id, quantity)
     VALUES ($1, $2, 0)
     ON CONFLICT (branch_id, inventory_item_id) DO NOTHING`,
    [branchId, inventoryItemId]
  );
  const locked = await client.query(
    `SELECT quantity FROM branch_inventory_stock WHERE branch_id = $1 AND inventory_item_id = $2 FOR UPDATE`,
    [branchId, inventoryItemId]
  );
  const quantityBefore = Number(locked.rows[0].quantity);
  const quantityAfter = quantityBefore + Number(quantity);

  const itemRes = await client.query(
    "SELECT unit, unit_cost, negative_stock_policy FROM inventory_items WHERE id = $1", [inventoryItemId]
  );
  const item = itemRes.rows[0];
  if (!item) throw new Error("الصنف مش موجود");

  let negativeOverrideUsed = false;
  if (quantityAfter < 0) {
    if (item.negative_stock_policy === "STRICT") {
      const err = new Error(`الرصيد الحالي مش كافي (متاح ${quantityBefore}، مطلوب ${Math.abs(Number(quantity))}) - الصنف ده سياسته STRICT ومفيش تجاوز ليها`);
      err.code = "INSUFFICIENT_STOCK";
      throw err;
    }
    // ALLOW_WITH_APPROVAL: لازم موافقة صريحة، وإلا نفس المنع
    if (!negativeStockOverrideApproved) {
      const err = new Error(`الرصيد الحالي مش كافي (متاح ${quantityBefore}، مطلوب ${Math.abs(Number(quantity))}) - محتاج موافقة مدير الفرع أو الأدمن`);
      err.code = "INSUFFICIENT_STOCK_NEEDS_APPROVAL";
      throw err;
    }
    negativeOverrideUsed = true;
  }

  let resolvedUnitCost = unitCost != null ? Number(unitCost) : (item.unit_cost != null ? Number(item.unit_cost) : null);
  let resolvedBatchId = batchId;
  if (!skipBatchConsumption && Number(quantity) < 0) {
    const consumed = await consumeFromBatches(client, {
      branchId, inventoryItemId, quantity: Math.abs(Number(quantity)),
    });
    if (consumed) {
      resolvedUnitCost = consumed.weightedUnitCost;
      resolvedBatchId = consumed.lastBatchId;
    }
  }
  const totalCost = resolvedUnitCost != null ? resolvedUnitCost * Math.abs(Number(quantity)) : null;

  await client.query(
    `UPDATE branch_inventory_stock SET quantity = $3 WHERE branch_id = $1 AND inventory_item_id = $2`,
    [branchId, inventoryItemId, quantityAfter]
  );

  const inserted = await client.query(
    `INSERT INTO inventory_movements
      (branch_id, inventory_item_id, movement_type, quantity, unit, unit_cost, total_cost,
       quantity_before, quantity_after, reference_type, reference_id, batch_id, reason, notes,
       created_by, idempotency_key, business_date)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16, COALESCE($17, CURRENT_DATE))
     RETURNING *`,
    [branchId, inventoryItemId, movementType, quantity, unit || item.unit, resolvedUnitCost, totalCost,
     quantityBefore, quantityAfter, referenceType, referenceId, resolvedBatchId, reason, notes,
     userId, idempotencyKey, businessDate]
  );

  return { movement: inserted.rows[0], duplicate: false, negativeOverrideUsed };
}

module.exports = { postInventoryMovement, consumeFromBatches };
