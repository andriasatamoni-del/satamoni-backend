// المرحلة 7M: عناوين العميل المتعددة - upsertCustomerAddress بتتنادى من routes/orders.js (إنشاء/تعديل
// طلب دليفري) عشان تراكم دفتر عناوين العميل تلقائيًا، بنفس فلسفة "تسجيل العميل ضمنيًا" الموجودة أصلًا.
async function upsertCustomerAddress(client, phone, addressDetails, deliveryAreaId, distinguishingMark) {
  if (!phone || !addressDetails) return;

  const existing = await client.query(
    `SELECT id FROM customer_addresses
     WHERE customer_phone = $1 AND address_details = $2 AND delivery_area_id IS NOT DISTINCT FROM $3
     LIMIT 1`,
    [phone, addressDetails, deliveryAreaId ?? null]
  );

  if (existing.rows.length > 0) {
    await client.query(
      `UPDATE customer_addresses SET distinguishing_mark = COALESCE($2, distinguishing_mark), updated_at = now()
       WHERE id = $1`,
      [existing.rows[0].id, distinguishingMark ?? null]
    );
    return;
  }

  const countRes = await client.query(
    `SELECT COUNT(*)::int AS n FROM customer_addresses WHERE customer_phone = $1`,
    [phone]
  );
  const isFirstAddress = countRes.rows[0].n === 0;

  await client.query(
    `INSERT INTO customer_addresses (customer_phone, address_details, delivery_area_id, distinguishing_mark, is_default)
     VALUES ($1, $2, $3, $4, $5)`,
    [phone, addressDetails, deliveryAreaId ?? null, distinguishingMark ?? null, isFirstAddress]
  );
}

module.exports = { upsertCustomerAddress };
