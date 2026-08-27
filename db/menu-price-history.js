// المرحلة 7O: سجل تاريخ تغيير أسعار المنيو - بتتنادى من routes/menu.js في أي نقطة بيتغيّر فيها سعر
// فعليًا (السعر القديم مختلف عن الجديد) - نفس فلسفة employee_history: append-only، من غير تعديل/حذف.
async function logPriceChange(executor, { entityType, entityId, variantId = null, fieldName, oldPrice, newPrice, changedBy }) {
  if (oldPrice == null && newPrice == null) return;
  if (Number(oldPrice) === Number(newPrice)) return;
  await executor.query(
    `INSERT INTO menu_price_history (entity_type, entity_id, variant_id, field_name, old_price, new_price, changed_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [entityType, entityId, variantId, fieldName, oldPrice ?? null, newPrice ?? null, changedBy ?? null]
  );
}

module.exports = { logPriceChange };
