const express = require("express");
const router = express.Router();
const pool = require("../db/pool");
const { requireAuth, requireRole, assertOwnBranch } = require("../middleware/auth");

// طلبات الموقع (source=website) عامة من غير تسجيل دخول.
// طلبات الكاشير (source=pos) وطلبات طلبات (source=talabat، بتتسجل يدويًا بعد التنفيذ
// عشان تتحسب في المخزون والمحاسبة) لازم كاشير/مدير فرع/أدمن مسجل دخول، وعلى فرعه بس.
// طلبات الكول سنتر (source=callcenter) لازم موظف كول سنتر/أدمن، من غير قفل على فرع معين
// (موظف الكول سنتر بياخد طلبات لأي فرع/منطقة توصيل).
function requirePosAuthIfNeeded(req, res, next) {
  if (req.body.source === "pos" || req.body.source === "talabat") {
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
      deliveryAreaId, addressDetails, customerName, customerPhone, customerPhone2,
      distinguishingMark, paymentMethodId, items, deliveryFee = 0, discount = 0,
      discountApprovedBy,
    } = req.body;

    if ((source === "pos" || source === "talabat") && !assertOwnBranch(req.user, branchId)) {
      return res.status(403).json({ error: "معندكش صلاحية تسجل طلب على فرع تاني" });
    }

    const subtotal = items.reduce((s, it) => s + it.unitPrice * it.quantity, 0);

    // خصم فوق النسبة المسموحة للكاشير لوحده لازم يبقى معاه موافقة مدير/أدمن اتاكدنا منها بـ PIN
    // (verify-override-pin) - بنتأكد من صحتها تاني هنا من السيرفر، مش بس بنصدّق الفرونت إند
    if (discount > 0 && subtotal > 0) {
      const settings = await client.query("SELECT max_unapproved_discount_percent FROM pos_settings WHERE id = 1");
      const maxUnapproved = Number(settings.rows[0]?.max_unapproved_discount_percent ?? 0.1);
      if (discount / subtotal > maxUnapproved) {
        if (!discountApprovedBy) {
          return res.status(400).json({ error: "الخصم ده محتاج موافقة مدير الفرع أو الأدمن" });
        }
        const approver = await client.query(
          `SELECT id FROM users
           WHERE id = $1 AND is_active = TRUE
             AND (role = 'admin' OR (role = 'branch_manager' AND branch_id = $2))`,
          [discountApprovedBy, branchId]
        );
        if (approver.rows.length === 0) {
          return res.status(400).json({ error: "الموافقة على الخصم غير صالحة" });
        }
      }
    }

    await client.query("BEGIN");

    const total = subtotal + deliveryFee - discount;
    const createdBy = source === "pos" || source === "callcenter" || source === "talabat" ? req.user.id : null;

    // حالة الطلب المبدئية: طلبات الدليفري بتدخل دورة حياة (تحت التحضير -> في الطريق -> اتسلمت)،
    // أما الصالة/تيك أواي فبتتحاسب وتتسلم فورًا عند الكاشير فمفيش داعي لدورة حياة.
    const initialStatus = orderType === "delivery" ? "preparing" : "completed";

    // حالة التحصيل المبدئية: طلبات الدليفري تفضل "تحت التحصيل" لحد ما الطيار يرجع والكاشير يأكد
    // استلام الفلوس فعليًا، حتى لو الدفع كاش. غير كده بتتحدد حسب نوع وسيلة الدفع: كاش بيتحصّل
    // لحظيًا، وفيزا/محفظة/آجل بتفضل تحت التحصيل لحد ما يتأكد وصول الفلوس أو تسوية آخر الشهر.
    let paymentKind = "cash";
    if (paymentMethodId) {
      const pm = await client.query("SELECT kind FROM payment_methods WHERE id = $1", [paymentMethodId]);
      if (pm.rows.length > 0) paymentKind = pm.rows[0].kind;
    }
    const initialPaymentStatus =
      orderType === "delivery" ? "pending_collection" : (paymentKind === "cash" ? "collected" : "pending_collection");

    const orderResult = await client.query(
      `INSERT INTO orders
        (branch_id, source, order_type, table_number, delivery_area_id,
         address_details, customer_name, customer_phone, payment_method_id,
         created_by, subtotal, delivery_fee, discount, discount_approved_by, total, status, payment_status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
       RETURNING id`,
      [branchId, source || "website", orderType, tableNumber, deliveryAreaId,
       addressDetails, customerName, customerPhone, paymentMethodId,
       createdBy, subtotal, deliveryFee, discount, discountApprovedBy || null, total, initialStatus, initialPaymentStatus]
    );
    const orderId = orderResult.rows[0].id;

    await client.query(
      `INSERT INTO order_status_log (order_id, status, changed_by, notes) VALUES ($1, $2, $3, 'إنشاء الطلب')`,
      [orderId, initialStatus, createdBy]
    );

    // تسجيل/تحديث العميل في سجل CRM المركزي عشان الكول سنتر يشوف تاريخه - بيانات الدليفري
    // (رقم تليفون تاني، عنوان تفصيلي، منطقة، علامة مميزة) بتتسجل هنا لو الطلب دليفري
    if (customerPhone) {
      await client.query(
        `INSERT INTO customers (phone, name, phone2, address_details, delivery_area_id, distinguishing_mark)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (phone) DO UPDATE SET
           name = COALESCE(EXCLUDED.name, customers.name),
           phone2 = COALESCE(EXCLUDED.phone2, customers.phone2),
           address_details = COALESCE(EXCLUDED.address_details, customers.address_details),
           delivery_area_id = COALESCE(EXCLUDED.delivery_area_id, customers.delivery_area_id),
           distinguishing_mark = COALESCE(EXCLUDED.distinguishing_mark, customers.distinguishing_mark),
           updated_at = now()`,
        [
          customerPhone, customerName || null,
          orderType === "delivery" ? customerPhone2 || null : null,
          orderType === "delivery" ? addressDetails || null : null,
          orderType === "delivery" ? deliveryAreaId || null : null,
          orderType === "delivery" ? distinguishingMark || null : null,
        ]
      );
    }

    // كل صنف ممكن يبقى معاه مرفقات مختارة (إضافة موتزريلا، بدون طماطم...) - unitPrice الجاي من الواجهة
    // شامل بالفعل سعر المرفقات، وبنسجل اسم/سعر كل مرفق وقت البيع (snapshot) في order_item_modifiers
    for (const it of items) {
      const inserted = await client.query(
        `INSERT INTO order_items (order_id, item_id, variant_id, combo_id, quantity, unit_price, line_total)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [orderId, it.comboId ? null : it.itemId, it.comboId ? null : it.variantId, it.comboId || null,
         it.quantity, it.unitPrice, it.unitPrice * it.quantity]
      );
      const orderItemId = inserted.rows[0].id;
      for (const mod of it.modifiers || []) {
        await client.query(
          `INSERT INTO order_item_modifiers (order_item_id, modifier_id, name_at_sale, price_at_sale)
           VALUES ($1,$2,$3,$4)`,
          [orderItemId, mod.id, mod.name, mod.priceDelta || 0]
        );
      }
    }

    // تسجيل تكلفة الريسبي الفعلية وقت البيع (مش لحظيًا وقت التقرير) عشان قائمة الدخل التاريخية تفضل دقيقة
    // حتى لو الريسبي أو تركيبة العرض اتغيرت بعدين - كله بحساب ::numeric جوه SQL زي خصم المخزون بالظبط
    if (branchId) {
      await client.query(
        `UPDATE order_items oi
         SET cost_at_sale = sub.cost, cost_at_sale_incomplete = sub.incomplete
         FROM (
           SELECT oi2.id AS order_item_id,
                  COALESCE(SUM(mvi.quantity_per_unit::numeric * ii.unit_cost::numeric * oi2.quantity::numeric), 0) AS cost,
                  (COUNT(mvi.id) = 0 OR BOOL_OR(ii.unit_cost IS NULL)) AS incomplete
           FROM order_items oi2
           LEFT JOIN menu_item_variant_ingredients mvi ON mvi.variant_id = oi2.variant_id
           LEFT JOIN inventory_items ii ON ii.id = mvi.inventory_item_id
           WHERE oi2.order_id = $1 AND oi2.variant_id IS NOT NULL
           GROUP BY oi2.id
         ) sub
         WHERE oi.id = sub.order_item_id`,
        [orderId]
      );
      await client.query(
        `UPDATE order_items oi
         SET cost_at_sale = sub.cost, cost_at_sale_incomplete = sub.incomplete
         FROM (
           SELECT oi2.id AS order_item_id,
                  COALESCE(SUM(mvi.quantity_per_unit::numeric * ii.unit_cost::numeric * ci.quantity::numeric * oi2.quantity::numeric), 0) AS cost,
                  (COUNT(mvi.id) = 0 OR BOOL_OR(ii.unit_cost IS NULL)) AS incomplete
           FROM order_items oi2
           JOIN combo_items ci ON ci.combo_id = oi2.combo_id
           LEFT JOIN menu_item_variant_ingredients mvi ON mvi.variant_id = ci.variant_id
           LEFT JOIN inventory_items ii ON ii.id = mvi.inventory_item_id
           WHERE oi2.order_id = $1 AND oi2.combo_id IS NOT NULL
           GROUP BY oi2.id
         ) sub
         WHERE oi.id = sub.order_item_id`,
        [orderId]
      );
    }

    // خصم المخزون تلقائيًا حسب وصفة كل صنف (BOM) - لو الطلب مربوط بفرع
    // العروض (combo) مفيهاش وصفة مباشرة - بنفكّها لأصنافها الأصلية وناخد وصفة كل صنف منهم
    if (branchId) {
      for (const it of items) {
        let variantsToDeduct = [];
        if (it.comboId) {
          const comboItems = await client.query(
            "SELECT variant_id, quantity FROM combo_items WHERE combo_id = $1",
            [it.comboId]
          );
          variantsToDeduct = comboItems.rows.map((ci) => ({
            variantId: ci.variant_id,
            multiplier: ci.quantity * it.quantity,
          }));
        } else if (it.variantId) {
          variantsToDeduct = [{ variantId: it.variantId, multiplier: it.quantity }];
        }

        for (const v of variantsToDeduct) {
          const recipe = await client.query(
            "SELECT inventory_item_id, quantity_per_unit FROM menu_item_variant_ingredients WHERE variant_id = $1",
            [v.variantId]
          );
          for (const ing of recipe.rows) {
            // الضرب بيحصل جوه Postgres (NUMERIC) عشان نتجنب أخطاء دقة الأرقام العشرية في JS
            await client.query(
              `INSERT INTO branch_inventory_stock (branch_id, inventory_item_id, quantity)
               VALUES ($1, $2, -($3::numeric * $4::numeric))
               ON CONFLICT (branch_id, inventory_item_id)
               DO UPDATE SET quantity = branch_inventory_stock.quantity - ($3::numeric * $4::numeric)`,
              [branchId, ing.inventory_item_id, ing.quantity_per_unit, v.multiplier]
            );
            await client.query(
              `INSERT INTO inventory_movements
                (branch_id, inventory_item_id, movement_type, quantity, order_id, business_date)
               VALUES ($1, $2, 'sale_deduction', -($3::numeric * $4::numeric), $5, CURRENT_DATE)`,
              [branchId, ing.inventory_item_id, ing.quantity_per_unit, v.multiplier, orderId]
            );
          }
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

// GET /api/orders?branchId=&date=&status=&orderType= - عرض طلبات فرع (موظفين مسجلين دخول بس)
// status/orderType بيتفلتروا أوردرات الدليفري في شاشة متابعة دورة الحياة (تحت التحضير/في الطريق/تحصيل)
router.get(
  "/",
  requireAuth,
  requireRole("cashier", "branch_manager", "accountant", "admin", "callcenter"),
  async (req, res) => {
    let { branchId, date, status, orderType, paymentStatus } = req.query;

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
           AND ($3::text IS NULL OR status = $3)
           AND ($4::text IS NULL OR order_type = $4)
           AND ($5::text IS NULL OR payment_status = $5)
         ORDER BY created_at DESC`,
        [branchId || null, date || null, status || null, orderType || null, paymentStatus || null]
      );
      res.json(result.rows);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

// GET /api/orders/:id - تفاصيل طلب واحد + أصنافه + سجل تغيير حالته بالكامل
router.get(
  "/:id",
  requireAuth,
  requireRole("cashier", "branch_manager", "accountant", "admin", "callcenter"),
  async (req, res) => {
    try {
      const order = await pool.query("SELECT * FROM orders WHERE id = $1", [req.params.id]);
      if (order.rows.length === 0) return res.status(404).json({ error: "الطلب مش موجود" });
      const o = order.rows[0];

      if ((req.user.role === "cashier" || req.user.role === "branch_manager") && !assertOwnBranch(req.user, o.branch_id)) {
        return res.status(403).json({ error: "معندكش صلاحية تشوف طلب فرع تاني" });
      }

      const items = await pool.query(
        `SELECT oi.*, mi.name AS item_name, miv.label AS variant_label, c.name AS combo_name
         FROM order_items oi
         LEFT JOIN menu_item_variants miv ON miv.id = oi.variant_id
         LEFT JOIN menu_items mi ON mi.id = miv.item_id
         LEFT JOIN combos c ON c.id = oi.combo_id
         WHERE oi.order_id = $1`,
        [req.params.id]
      );
      const modifiers = await pool.query(
        `SELECT oim.* FROM order_item_modifiers oim
         JOIN order_items oi ON oi.id = oim.order_item_id
         WHERE oi.order_id = $1`,
        [req.params.id]
      );
      const statusLog = await pool.query(
        `SELECT l.*, u.name AS changed_by_name
         FROM order_status_log l
         LEFT JOIN users u ON u.id = l.changed_by
         WHERE l.order_id = $1 ORDER BY l.changed_at ASC`,
        [req.params.id]
      );

      const itemsWithModifiers = items.rows.map((it) => ({
        ...it,
        modifiers: modifiers.rows.filter((m) => m.order_item_id === it.id),
      }));

      res.json({ ...o, items: itemsWithModifiers, statusLog: statusLog.rows });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

const ORDER_STATUSES = ["preparing", "out_for_delivery", "completed", "cancelled"];
const TERMINAL_STATUSES = ["completed", "cancelled"];

// PATCH /api/orders/:id/status - تغيير حالة الطلب (دورة حياة الدليفري: تحت التحضير -> في الطريق -> اتسلمت)
// {status, driverName?, notes?} - لازم اسم الطيار لما ننقل الطلب "في الطريق"
router.patch(
  "/:id/status",
  requireAuth,
  requireRole("cashier", "branch_manager", "admin", "callcenter"),
  async (req, res) => {
    const { status, driverName, notes } = req.body;
    if (!ORDER_STATUSES.includes(status)) {
      return res.status(400).json({ error: "حالة غير معروفة" });
    }
    try {
      const existing = await pool.query("SELECT branch_id, status FROM orders WHERE id = $1", [req.params.id]);
      if (existing.rows.length === 0) return res.status(404).json({ error: "الطلب مش موجود" });
      const current = existing.rows[0];

      if ((req.user.role === "cashier" || req.user.role === "branch_manager") && !assertOwnBranch(req.user, current.branch_id)) {
        return res.status(403).json({ error: "معندكش صلاحية تعدّل طلب فرع تاني" });
      }
      if (TERMINAL_STATUSES.includes(current.status)) {
        return res.status(400).json({ error: "الطلب ده اتسلم أو اتلغى بالفعل، مينفعش تتعدل حالته" });
      }
      if (status === "out_for_delivery" && !driverName) {
        return res.status(400).json({ error: "لازم اسم الطيار عشان تنقل الطلب لحالة (في الطريق)" });
      }

      // synced_at بيترجع NULL عمدًا هنا - لو الطلب كان اتبعت للمركزي قبل كده (مزامنة الفروع)،
      // ده بيخلي db/sync-worker.js يلقطه تاني ويبعت الحالة الجديدة بدل ما يفضل واقف على القديمة
      const result = await pool.query(
        `UPDATE orders SET status = $1, driver_name = COALESCE($2, driver_name), synced_at = NULL WHERE id = $3 RETURNING *`,
        [status, driverName || null, req.params.id]
      );
      await pool.query(
        `INSERT INTO order_status_log (order_id, status, changed_by, notes) VALUES ($1, $2, $3, $4)`,
        [req.params.id, status, req.user.id, notes || null]
      );
      res.json(result.rows[0]);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

// PATCH /api/orders/:id/payment-status - تأكيد تحصيل الفلوس فعليًا (لما الطيار يرجع، أو تسوية آجل شهرية)
// {paymentStatus: 'collected' | 'pending_collection'}
router.patch(
  "/:id/payment-status",
  requireAuth,
  requireRole("cashier", "branch_manager", "admin", "accountant"),
  async (req, res) => {
    const { paymentStatus } = req.body;
    if (!["collected", "pending_collection"].includes(paymentStatus)) {
      return res.status(400).json({ error: "حالة تحصيل غير معروفة" });
    }
    try {
      const existing = await pool.query("SELECT branch_id, status FROM orders WHERE id = $1", [req.params.id]);
      if (existing.rows.length === 0) return res.status(404).json({ error: "الطلب مش موجود" });
      const current = existing.rows[0];

      if ((req.user.role === "cashier" || req.user.role === "branch_manager") && !assertOwnBranch(req.user, current.branch_id)) {
        return res.status(403).json({ error: "معندكش صلاحية تعدّل طلب فرع تاني" });
      }

      const result = await pool.query(
        `UPDATE orders SET payment_status = $1, synced_at = NULL WHERE id = $2 RETURNING *`,
        [paymentStatus, req.params.id]
      );
      await pool.query(
        `INSERT INTO order_status_log (order_id, status, changed_by, notes) VALUES ($1, $2, $3, $4)`,
        [req.params.id, current.status, req.user.id, paymentStatus === "collected" ? "تأكيد تحصيل الفلوس" : "رجوع لحالة تحت التحصيل"]
      );
      res.json(result.rows[0]);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

// POST /api/orders/:id/void - استرجاع طلب مكتمل اتسجل بالغلط (Void) - بيرجّعه لحالة "ملغي" (يستبعده من
// الإيرادات في التقارير زي أي إلغاء) وبيرجّع المخزون اللي كان اتخصم وقته. لازم موافقة مدير الفرع/الأدمن
// دايمًا: لو اللي بيسترجع نفسه مدير فرع/أدمن بيوافق بحسابه على طول، غيره لازم PIN معتمد (approverId من
// verify-override-pin). حالة التحصيل (اتحصّل الفلوس فعليًا ولا لأ) مبتتغيّرش أوتوماتيك هنا - لو الفلوس
// كانت اتحصّلت فعلاً، ده محتاج تسوية كاش يدوية منفصلة، مش جزء من الاسترجاع نفسه.
router.post(
  "/:id/void",
  requireAuth,
  requireRole("cashier", "branch_manager", "admin", "callcenter"),
  async (req, res) => {
    const { reason, approverId } = req.body;
    if (!reason) return res.status(400).json({ error: "لازم سبب الاسترجاع" });

    const client = await pool.connect();
    try {
      const orderRes = await client.query("SELECT * FROM orders WHERE id = $1", [req.params.id]);
      if (orderRes.rows.length === 0) return res.status(404).json({ error: "الطلب مش موجود" });
      const order = orderRes.rows[0];

      if ((req.user.role === "cashier" || req.user.role === "branch_manager") && !assertOwnBranch(req.user, order.branch_id)) {
        return res.status(403).json({ error: "معندكش صلاحية تسترجع طلب فرع تاني" });
      }
      if (order.status !== "completed" || order.voided) {
        return res.status(400).json({ error: "الاسترجاع (Void) بس للطلبات المكتملة اللي لسه ما اتسترجعتش" });
      }

      let finalApproverId;
      if (req.user.role === "admin" || req.user.role === "branch_manager") {
        finalApproverId = req.user.id;
      } else {
        if (!approverId) return res.status(400).json({ error: "استرجاع الطلب محتاج موافقة مدير الفرع أو الأدمن" });
        const approver = await client.query(
          `SELECT id FROM users
           WHERE id = $1 AND is_active = TRUE
             AND (role = 'admin' OR (role = 'branch_manager' AND branch_id = $2))`,
          [approverId, order.branch_id]
        );
        if (approver.rows.length === 0) return res.status(400).json({ error: "الموافقة على الاسترجاع غير صالحة" });
        finalApproverId = approverId;
      }

      await client.query("BEGIN");

      // synced_at بيترجع NULL عمدًا - لو الطلب ده كان اتبعت للمركزي قبل الاسترجاع، لازم يترفع تاني
      // بحالته الجديدة (ملغي/مسترجع) عشان الإيرادات المجمّعة مركزيًا متفضلش شايلة بيع اتلغى فعليًا
      await client.query(
        `UPDATE orders SET status = 'cancelled', voided = TRUE, voided_by = $1, voided_at = now(),
         void_reason = $2, synced_at = NULL
         WHERE id = $3`,
        [finalApproverId, reason, order.id]
      );
      await client.query(
        `INSERT INTO order_status_log (order_id, status, changed_by, notes) VALUES ($1, 'cancelled', $2, $3)`,
        [order.id, req.user.id, `استرجاع (Void) - ${reason}`]
      );

      // إرجاع المخزون اللي كان اتخصم وقت البيع - نفس منطق خصم الـ BOM وقت إنشاء الطلب بالظبط بس بالعكس
      if (order.branch_id) {
        const reversalIngredients = `
          SELECT mvi.inventory_item_id, mvi.quantity_per_unit::numeric * oi.quantity::numeric AS qty
          FROM order_items oi
          JOIN menu_item_variant_ingredients mvi ON mvi.variant_id = oi.variant_id
          WHERE oi.order_id = $1 AND oi.variant_id IS NOT NULL
          UNION ALL
          SELECT mvi.inventory_item_id, mvi.quantity_per_unit::numeric * ci.quantity::numeric * oi.quantity::numeric AS qty
          FROM order_items oi
          JOIN combo_items ci ON ci.combo_id = oi.combo_id
          JOIN menu_item_variant_ingredients mvi ON mvi.variant_id = ci.variant_id
          WHERE oi.order_id = $1 AND oi.combo_id IS NOT NULL`;

        await client.query(
          `INSERT INTO branch_inventory_stock (branch_id, inventory_item_id, quantity)
           SELECT $2, sub.inventory_item_id, SUM(sub.qty) FROM (${reversalIngredients}) sub
           GROUP BY sub.inventory_item_id
           ON CONFLICT (branch_id, inventory_item_id)
           DO UPDATE SET quantity = branch_inventory_stock.quantity + EXCLUDED.quantity`,
          [order.id, order.branch_id]
        );
        await client.query(
          `INSERT INTO inventory_movements (branch_id, inventory_item_id, movement_type, quantity, order_id, business_date)
           SELECT $2, sub.inventory_item_id, 'adjustment', SUM(sub.qty), $1, CURRENT_DATE FROM (${reversalIngredients}) sub
           GROUP BY sub.inventory_item_id`,
          [order.id, order.branch_id]
        );
      }

      await client.query("COMMIT");
      const updated = await pool.query("SELECT * FROM orders WHERE id = $1", [order.id]);
      res.json(updated.rows[0]);
    } catch (err) {
      await client.query("ROLLBACK");
      res.status(500).json({ error: err.message });
    } finally {
      client.release();
    }
  }
);

module.exports = router;
