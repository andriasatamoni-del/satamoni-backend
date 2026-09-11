// المرحلة 9A-3: مسار مشترى الكاشير الطارئ (routes/purchases.js) ومسار GRN الرسمي (routes/goods-receipts.js)
// كانوا شغالين من غير أي رابط بينهم خالص - نفس فاتورة توريد حقيقية من نفس المورد ممكن تتسجل مرتين: مرة
// مشترى نقدي سريع من الكاشير، ومرة تانية GRN رسمي من مسؤول المشتريات - كل واحد فيهم بيرحّل مخزون + قيد
// محاسبي منفصل بالكامل (postPurchaseToInventory وpostInventoryMovement/postJournalEntry جوه /:id/post
// بالترتيب)، فالنتيجة ضعف الكمية في المخزون وضعف القيمة في الحسابات، من غير أي تنبيه لأي حد.
//
// الحل: ربط اختياري (مش إجباري - مشترى نقدي بسيط من غير مورد محدد لسه شغال زي الأول بالظبط) بين أي
// مشترى/GRN ومورد + رقم مستند المورد (فاتورة/إذن تسليم). لو حد حاول يسجل نفس المورد + نفس رقم المستند
// مرتين (في أي مزيج من الجدولين، وفي نفس الفرع - نفس التوريدة لازم تكون لنفس الفرع)، بيتعرض عليه صراحة
// (مش بيتمنع تلقائيًا - ممكن يكون سبب حقيقي زي فاتورة مقسّمة على دفعتين) ولازم يأكّد صراحة
// (acknowledgeDuplicate) قبل ما يكمل، نفس فلسفة blockers بتاعة إنهاء خدمة الموظف (9A-4) بالظبط
async function findDuplicatePurchaseReferences(client, { supplierId, supplierDocumentNumber, branchId, excludePurchaseId, excludeGoodsReceiptId }) {
  if (!supplierId || !supplierDocumentNumber || !String(supplierDocumentNumber).trim()) return [];
  const normalizedDoc = String(supplierDocumentNumber).trim();

  const purchaseMatches = await client.query(
    `SELECT id, branch_id, business_date, amount, status, created_at FROM purchases
     WHERE supplier_id = $1 AND TRIM(supplier_document_number) = $2 AND branch_id = $3 AND status <> 'REJECTED'
       AND ($4::int IS NULL OR id <> $4)`,
    [supplierId, normalizedDoc, branchId, excludePurchaseId || null]
  );
  const grnMatches = await client.query(
    `SELECT id, branch_id, received_at, status, created_at FROM goods_receipts
     WHERE supplier_id = $1 AND TRIM(supplier_document_number) = $2 AND branch_id = $3 AND status <> 'CANCELLED'
       AND ($4::int IS NULL OR id <> $4)`,
    [supplierId, normalizedDoc, branchId, excludeGoodsReceiptId || null]
  );

  const matches = [];
  for (const r of purchaseMatches.rows) {
    matches.push({ source: "purchase", id: r.id, date: r.business_date, amount: Number(r.amount), status: r.status });
  }
  for (const r of grnMatches.rows) {
    matches.push({ source: "goods_receipt", id: r.id, date: r.received_at, status: r.status });
  }
  return matches;
}

module.exports = { findDuplicatePurchaseReferences };
