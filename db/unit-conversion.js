// تحويل كمية من وحدة لوحدة تانية باستخدام unit_conversions - لو الوحدتين زي بعض بيرجع نفس الكمية
// من غير أي بحث. بيرمي error واضح لو مفيش تحويل مسجّل بين الوحدتين. مشترك بين routes/inventory.js
// (استلام مشتريات بوحدة مختلفة) ومحرك الوصفات (db/recipe-engine.js).
async function convertQuantity(client, quantity, fromUnit, toUnit) {
  if (!fromUnit || !toUnit || fromUnit === toUnit) return Number(quantity);
  const direct = await client.query(
    "SELECT factor FROM unit_conversions WHERE from_unit = $1 AND to_unit = $2", [fromUnit, toUnit]
  );
  if (direct.rows.length > 0) return Number(quantity) * Number(direct.rows[0].factor);
  const inverse = await client.query(
    "SELECT factor FROM unit_conversions WHERE from_unit = $1 AND to_unit = $2", [toUnit, fromUnit]
  );
  if (inverse.rows.length > 0) return Number(quantity) / Number(inverse.rows[0].factor);
  const err = new Error(`مفيش تحويل مسجّل بين وحدة "${fromUnit}" ووحدة "${toUnit}"`);
  err.code = "NO_UNIT_CONVERSION";
  throw err;
}

module.exports = { convertQuantity };
