const express = require("express");
const router = express.Router();
const pool = require("../db/pool");
const { requireAuth, requireRole, assertOwnBranch } = require("../middleware/auth");

// طلبات الموقع (source=website) عامة من غير تسجيل دخول.
// طلبات الكاشير (source=pos) لازم كاشير/مدير فرع/أدمن مسجل دخول، وعلى فرعه بس.
// طلبات الكول سنتر (source=callcenter) لازم موظف كول سنتر/أدمن، من غير قفل على فرع معين
// (موظف الكول سنتر بياخد طلبات لأي فرع/منطقة توصيل).
function requirePosAuthIfNeeded(req, res, next) {
  if (req.body.source === "pos") {
    return requireAuth(req, res, (err) => {
      if (err) return next(err);
      requireRole("cashier", "branch_manager", "admin")(req, res, next);
    });
  }
  if (req.body.source === "callcenter") {
    return requireAuth(req, res, (err) => {
      if (err) return next(err);
      requireRole("callcenter", "admin")(req, res, next);
    });
  }
  next();
}

// POST /api/orders - إنشاء طلب جديد (من الموقع أو من شاشة الكاشير)
// ده اللي هيستبدل window.storage في ملف الموقع الحالي
router.post("/", requirePosAuthIfNeeded, async (req, res) => {
  const client = await pool.connect();
  try {
    const {
      branchId, source, orderType, tableNumber,
      deliveryAreaId, addressDetails, customerName, customerPhone,
      paymentMethodId, items, deliveryFee = 0, discount = 0,
    } = req.body;

    if (source === "pos" && !assertOwnBranch(req.user, branchId)) {
      return res.status(403).json({ error: "معندكش صلاحية تسجل طلب على فرع تاني" });
    }

    await client.query("BEGIN");

    const subtotal = items.reduce((s, it) => s + it.unitPrice * it.quantity, 0);
    const total = subtotal + deliveryFee - discount;
    const createdBy = source === "pos" || source === "callcenter" ? req.user.id : null;

    const orderResult = await client.query(
      `INSERT INTO orders
        (branch_id, source, order_type, table_number, delivery_area_id,
         address_details, customer_name, customer_phone, payment_method_id,
         created_by, subtotal, delivery_fee, discount, total, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'pending')
       RETURNING id`,
      [branchId, source || "website", orderType, tableNumber, deliveryAreaId,
       addressDetails, customerName, customerPhone, paymentMethodId,
       createdBy, subtotal, deliveryFee, discount, total]
    );
    const orderId = orderResult.rows[0].id;

    // تسجيل/تحديث العميل في سجل CRM المركزي عشان الكول سنتر يشوف تاريخه
    if (customerPhone) {
      await client.query(
        `INSERT INTO customers (phone, name)
         VALUES ($1, $2)
         ON CONFLICT (phone) DO UPDATE SET
           name = COALESCE(EXCLUDED.name, customers.name),
           updated_at = now()`,
        [customerPhone, customerName || null]
      );
    }

    for (const it of items) {
      await client.query(
        `INSERT INTO order_items (order_id, item_id, variant_id, quantity, unit_price, line_total)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [orderId, it.itemId, it.variantId, it.quantity, it.unitPrice, it.unitPrice * it.quantity]
      );
    }

    // خصم المخزون تلقائيًا حسب وصفة كل صنف (BOM) - لو الطلب مربوط بفرع
    if (branchId) {
      for (const it of items) {
        const recipe = await client.query(
          "SELECT inventory_item_id, quantity_per_unit FROM menu_item_variant_ingredients WHERE variant_id = $1",
          [it.variantId]
        );
        for (const ing of recipe.rows) {
          // الضرب بيحصل جوه Postgres (NUMERIC) عشان نتجنب أخطاء دقة الأرقام العشرية في JS
          await client.query(
            `INSERT INTO branch_inventory_stock (branch_id, inventory_item_id, quantity)
             VALUES ($1, $2, -($3::numeric * $4::numeric))
             ON CONFLICT (branch_id, inventory_item_id)
             DO UPDATE SET quantity = branch_inventory_stock.quantity - ($3::numeric * $4::numeric)`,
            [branchId, ing.inventory_item_id, ing.quantity_per_unit, it.quantity]
          );
          await client.query(
            `INSERT INTO inventory_movements
              (branch_id, inventory_item_id, movement_type, quantity, order_id, business_date)
             VALUES ($1, $2, 'sale_deduction', -($3::numeric * $4::numeric), $5, CURRENT_DATE)`,
            [branchId, ing.inventory_item_id, ing.quantity_per_unit, it.quantity, orderId]
          );
        }
      }
    }

    await client.query("COMMIT");
    res.status(201).json({ orderId, subtotal, total });
  } catch (err) {
    await client.query("ROLLBACK");
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// GET /api/orders?branchId=&date= - عرض طلبات فرع في يوم معين (موظفين مسجلين دخول بس)
router.get(
  "/",
  requireAuth,
  requireRole("cashier", "branch_manager", "accountant", "admin", "callcenter"),
  async (req, res) => {
    let { branchId, date } = req.query;

    if (req.user.role === "cashier" || req.user.role === "branch_manager") {
      if (branchId && !assertOwnBranch(req.user, branchId)) {
        return res.status(403).json({ error: "معندكش صلاحية تشوف طلبات فرع تاني" });
      }
      branchId = req.user.branchId;
    }

    try {
      const result = await pool.query(
        `SELECT * FROM orders
         WHERE ($1::int IS NULL OR branch_id = $1)
           AND ($2::date IS NULL OR created_at::date = $2)
         ORDER BY created_at DESC`,
        [branchId || null, date || null]
      );
      res.json(result.rows);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

module.exports = router;
