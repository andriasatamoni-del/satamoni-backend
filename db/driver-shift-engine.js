// المرحلة 8.48: حضور وأجر السائقين بالساعة (عمالة خارجية) - تسجيل دخول/خروج يدوي من الكاشير، مستقل
// تمامًا عن تسوية كاش السائق (driver_settlements/delivery-engine.js) اللي بتحصل أكتر من مرة في نفس
// الشيفت. الأجر بيتحسب أوتوماتيك وقت تسجيل الخروج بس: ساعات العمل × hourly_rate (المجمّد وقت الدخول
// من pos_settings.driver_hourly_rate_egp) + بونص كل الأوردرات اللي السائق سلّمها أثناء الشيفت ده
// بالظبط (calcDriverOrderBonus - نفس الدالة اللي driver-settlements/driver-orders بتستخدمها، بغض
// النظر عن حالة تحصيل كل أوردر لأن البونص مقابل التسليم نفسه). المجموع بيتسجل تلقائي كمصروف يومي
// (SUBMITTED - محتاج مراجعة مدير زي أي مصروف كاشير عادي) بدل ما الكاشير يحسبه ويكتبه يدوي.
const { logAudit } = require("./audit");
const { calcDriverOrderBonus } = require("./delivery-engine");
const { getCairoBusinessDate } = require("./business-date");

const WAGE_EXPENSE_CATEGORY_NAME = "أجور عمالة خارجية (سائقين)";

async function getDriverWageExpenseCategoryId(client) {
  const res = await client.query("SELECT id FROM expense_categories WHERE name = $1", [WAGE_EXPENSE_CATEGORY_NAME]);
  if (res.rows.length === 0) {
    const err = new Error(`بند مصروف "${WAGE_EXPENSE_CATEGORY_NAME}" مش موجود - محتاج migration`);
    err.code = "WAGE_EXPENSE_CATEGORY_MISSING";
    throw err;
  }
  return res.rows[0].id;
}

// فتح شيفت حضور سائق - نفس فلسفة الحماية المزدوجة بتاعة openShift (فحص مبدئي + UNIQUE INDEX جزئي على
// driver_id WHERE status='ACTIVE') عشان سباق تسجيل دخولين متزامنين لنفس السائق
async function checkInDriver(client, { driverId, branchId, checkedInByUserId, hourlyRate }) {
  const existing = await client.query("SELECT id FROM driver_shifts WHERE driver_id = $1 AND status = 'ACTIVE'", [driverId]);
  if (existing.rows.length > 0) {
    const err = new Error("السائق ده شيفته شغالة بالفعل - لازم يتسجّل له خروج الأول");
    err.code = "DRIVER_SHIFT_ALREADY_ACTIVE";
    throw err;
  }
  try {
    const result = await client.query(
      `INSERT INTO driver_shifts (driver_id, branch_id, checked_in_by, hourly_rate) VALUES ($1,$2,$3,$4) RETURNING *`,
      [driverId, branchId, checkedInByUserId, hourlyRate]
    );
    await logAudit(client, {
      branchId, userId: checkedInByUserId, action: "DRIVER_SHIFT_CHECKED_IN", entityType: "driver_shift", entityId: result.rows[0].id,
      newValues: { driverId, hourlyRate },
    });
    return result.rows[0];
  } catch (err) {
    if (err.code === "23505") {
      const dup = new Error("السائق ده شيفته شغالة بالفعل - لازم يتسجّل له خروج الأول");
      dup.code = "DRIVER_SHIFT_ALREADY_ACTIVE";
      throw dup;
    }
    throw err;
  }
}

// بونص كل الأوردرات اللي السائق سلّمها في نافذة الشيفت [from, to] - نفس نافذة الحضور بالظبط، مش يوم
// كامل زي تقرير driver-orders (المرحلة 8.47) - عشان لو السائق سجّل دخول/خروج أكتر من مرة في نفس اليوم
// كل شيفت ياخد بونص أوردراته هو بس، مش يتكرر أو يضيع بين الشيفتات
async function computeDriverShiftBonus(client, { driverId, from, to }) {
  const res = await client.query(
    `SELECT delivery_fee FROM orders
     WHERE driver_id = $1 AND dispatch_status = 'DELIVERED' AND delivered_at >= $2 AND delivered_at <= $3`,
    [driverId, from, to]
  );
  return res.rows.reduce((s, o) => s + calcDriverOrderBonus(o.delivery_fee || 0), 0);
}

// تسجيل خروج - بيحسب الأجر والبونص ويقفل الشيفت ويسجل مصروف يومي واحد بالمجموع. المصروف بيتسجل
// SUBMITTED (زي أي مصروف كاشير يومي عادي - expenses.create_own_daily) عشان يعدّي على مراجعة مدير
// الفرع/المحاسب العادية قبل ما يترحّل محاسبيًا رسميًا، مش ترحيل فوري تلقائي بدون مراجعة
async function checkOutDriver(client, { driverShift, checkedOutByUserId, notes }) {
  if (driverShift.status !== "ACTIVE") {
    const err = new Error("الشيفت ده مقفول بالفعل");
    err.code = "DRIVER_SHIFT_NOT_ACTIVE";
    throw err;
  }
  const checkedOutAt = new Date();
  const checkedInAt = new Date(driverShift.checked_in_at);
  const hoursWorked = Math.round(((checkedOutAt.getTime() - checkedInAt.getTime()) / 3600000) * 100) / 100;
  const wageAmount = Math.round(hoursWorked * Number(driverShift.hourly_rate) * 100) / 100;
  const bonusTotal = await computeDriverShiftBonus(client, { driverId: driverShift.driver_id, from: checkedInAt, to: checkedOutAt });
  const totalPay = Math.round((wageAmount + bonusTotal) * 100) / 100;

  const driverRes = await client.query("SELECT name, driver_code FROM drivers WHERE id = $1", [driverShift.driver_id]);
  const driverName = driverRes.rows[0]?.name || `سائق #${driverShift.driver_id}`;
  const driverCode = driverRes.rows[0]?.driver_code || null;

  const cashPm = await client.query("SELECT id FROM payment_methods WHERE kind = 'cash' AND enabled = TRUE ORDER BY id LIMIT 1");
  if (cashPm.rows.length === 0) {
    const err = new Error("مفيش طريقة دفع كاش مفعّلة في النظام");
    err.code = "NO_CASH_PAYMENT_METHOD";
    throw err;
  }
  const categoryId = await getDriverWageExpenseCategoryId(client);

  const expenseRes = await client.query(
    `INSERT INTO expenses (branch_id, business_date, category_id, amount, notes, payment_method_id, status, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,'SUBMITTED',$7) RETURNING *`,
    [
      driverShift.branch_id, getCairoBusinessDate(checkedOutAt), categoryId, totalPay,
      `أجر يومية السائق ${driverName} - ${hoursWorked} ساعة × ${driverShift.hourly_rate} ج.م = ${wageAmount} ج.م + بونص ${bonusTotal} ج.م${notes ? ` - ${notes}` : ""}`,
      cashPm.rows[0].id, checkedOutByUserId,
    ]
  );
  const expense = expenseRes.rows[0];

  const updated = await client.query(
    `UPDATE driver_shifts SET
       status = 'CLOSED', checked_out_by = $1, checked_out_at = $2, hours_worked = $3,
       wage_amount = $4, bonus_total = $5, total_pay = $6, expense_id = $7, notes = $8, updated_at = now()
     WHERE id = $9
     RETURNING *`,
    [checkedOutByUserId, checkedOutAt, hoursWorked, wageAmount, bonusTotal, totalPay, expense.id, notes || null, driverShift.id]
  );

  await logAudit(client, {
    branchId: driverShift.branch_id, userId: checkedOutByUserId, action: "DRIVER_SHIFT_CHECKED_OUT",
    entityType: "driver_shift", entityId: driverShift.id,
    newValues: { driverId: driverShift.driver_id, hoursWorked, wageAmount, bonusTotal, totalPay, expenseId: expense.id },
  });

  return { shift: { ...updated.rows[0], driver_name: driverName, driver_code: driverCode }, expense };
}

module.exports = { checkInDriver, checkOutDriver, computeDriverShiftBonus, WAGE_EXPENSE_CATEGORY_NAME };
