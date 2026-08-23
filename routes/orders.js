const express = require("express");
const router = express.Router();
const pool = require("../db/pool");
const { requireAuth, requireRole, assertOwnBranch } = require("../middleware/auth");
const { logAudit } = require("../db/audit");
const { postInventoryMovement } = require("../db/inventory-ledger");
const { postJournalEntry, reverseJournalEntry, getOrCreateBranchCashAccount, getAccountByCode } = require("../db/accounting-engine");

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

// المرحلة 6 (6G): quantity من غير أي تحقق كان ممكن يوصل بأي قيمة - صفر أو سالب كان بيعدي بهدوء ويقلب
// إجمالي الطلب سالب (subtotal/total NUMERIC بيقبلوا القيمة دي من غير مشكلة على مستوى القاعدة)، وده
// طريق ملتوي يهرّب تأثير "استرجاع" من غير ما يعدي على تدفق الاسترجاع/الإلغاء الرسمي أو يترحّل بمحاسبة
// صحيحة. NaN/Infinity كانت بتترفض بس على مستوى عمود order_items.quantity (INTEGER) بخطأ Postgres خام
// مش برسالة واضحة، وبعد ما orders (subtotal/total NUMERIC بيقبل NaN فعليًا) كان ممكن يتحفظ الأول قبل
// ما order_items يرفض ويعمل rollback - نفس النتيجة النهائية (لا حاجة تتسجل) بس بمسار مربك. التحقق ده
// بيرفض بوضوح ورسالة عربي قبل أي حساب أو استعلام
const MAX_ORDER_ITEM_QUANTITY = 10000;
function validateQuantity(quantity) {
  if (typeof quantity !== "number" || !Number.isFinite(quantity) || !Number.isInteger(quantity)) {
    throw new Error("الكمية لازم تكون رقم صحيح");
  }
  if (quantity <= 0) throw new Error("الكمية لازم تكون أكبر من صفر");
  if (quantity > MAX_ORDER_ITEM_QUANTITY) throw new Error(`الكمية أكبر من الحد المسموح (${MAX_ORDER_ITEM_QUANTITY})`);
}

// بيتأكد من سعر كل سطر في الطلب من المنيو الحقيقي في قاعدة البيانات - مش بيصدّق unitPrice/priceDelta
// الجايين من الواجهة خالص، عشان جهاز كاشير متلاعب فيه (أو نداء API مباشر) ميقدرش يبيع صنف بسعر
// مزوّر أو يهرّب "خصم" مقنّع في هيئة مرفق بسعر سالب يتخطى نظام موافقة الخصومات بالكامل.
// بيرجع {itemId, variantId, comboId, quantity, unitPrice, lineTotal, modifiers} لكل سطر، أو يرمي Error
// برسالة عربي واضحة لو الصنف/الحجم/المرفق مش موجود أو متوقف.
async function resolveOrderItems(client, items, source) {
  const useTalabatPrice = source === "talabat";
  const resolved = [];
  for (const it of items) {
    validateQuantity(it.quantity);
    if (it.comboId) {
      const combo = await client.query(
        "SELECT price FROM combos WHERE id = $1 AND is_active = TRUE",
        [it.comboId]
      );
      if (combo.rows.length === 0) throw new Error("العرض ده مش موجود أو متوقف حاليًا");
      const unitPrice = Number(combo.rows[0].price);
      resolved.push({ comboId: it.comboId, itemId: null, variantId: null, quantity: it.quantity, unitPrice, lineTotal: unitPrice * it.quantity, modifiers: [] });
      continue;
    }

    const variant = await client.query(
      `SELECT v.price, v.talabat_price, mi.is_active
       FROM menu_item_variants v JOIN menu_items mi ON mi.id = v.item_id
       WHERE v.id = $1 AND v.item_id = $2`,
      [it.variantId, it.itemId]
    );
    if (variant.rows.length === 0) throw new Error("الصنف ده مش موجود في المنيو");
    const row = variant.rows[0];
    if (!row.is_active) throw new Error("الصنف ده متوقف حاليًا");
    if (useTalabatPrice && row.talabat_price == null) throw new Error("الصنف ده مش متاح على طلبات");
    const basePrice = Number(useTalabatPrice ? row.talabat_price : row.price);

    const modifiers = [];
    let modifierTotal = 0;
    for (const mod of it.modifiers || []) {
      // سعر المرفق ممكن يكون له سعر مخصوص للحجم (variant) ده تحديدًا - لو مفيش، السعر الافتراضي بتاع المرفق
      const modRow = await client.query(
        `SELECT m.id, m.name, COALESCE(vp.price_delta, m.price_delta) AS price_delta
         FROM menu_item_modifiers m
         LEFT JOIN menu_item_modifier_variant_prices vp ON vp.modifier_id = m.id AND vp.variant_id = $3
         WHERE m.id = $1 AND m.item_id = $2 AND m.is_active = TRUE`,
        [mod.id, it.itemId, it.variantId]
      );
      if (modRow.rows.length === 0) throw new Error("مرفق مش موجود أو متوقف حاليًا");
      const delta = Number(modRow.rows[0].price_delta);
      modifiers.push({ id: modRow.rows[0].id, name: modRow.rows[0].name, priceDelta: delta });
      modifierTotal += delta;
    }

    const unitPrice = basePrice + modifierTotal;
    resolved.push({ comboId: null, itemId: it.itemId, variantId: it.variantId, quantity: it.quantity, unitPrice, lineTotal: unitPrice * it.quantity, modifiers });
  }
  return resolved;
}

// POST /api/orders - إنشاء طلب جديد (من الموقع أو من شاشة الكاشير)
// ده اللي هيستبدل window.storage في ملف الموقع الحالي
router.post("/", requirePosAuthIfNeeded, async (req, res) => {
  const client = await pool.connect();
  try {
    const {
      branchId, source, orderType, tableNumber,
      deliveryAreaId, addressDetails, customerName, customerPhone, customerPhone2,
      distinguishingMark, paymentMethodId, items: rawItems, deliveryFee = 0, discount = 0,
      discountApprovedBy, idempotencyKey, inventoryOverrideApprovedBy,
      loyaltyPointsRedeemed = 0,
    } = req.body;

    if ((source === "pos" || source === "talabat") && !assertOwnBranch(req.user, branchId)) {
      return res.status(403).json({ error: "معندكش صلاحية تسجل طلب على فرع تاني" });
    }

    if (loyaltyPointsRedeemed) {
      if (!Number.isInteger(loyaltyPointsRedeemed) || loyaltyPointsRedeemed < 0) {
        return res.status(400).json({ error: "عدد نقاط الولاء المستخدمة غير صالح" });
      }
      if (!customerPhone) {
        return res.status(400).json({ error: "استخدام نقاط الولاء محتاج رقم تليفون العميل" });
      }
    }

    // Idempotency: لو نفس مفتاح الطلب اتبعت قبل كده، رجّع نفس نتيجة الطلب الأصلي من غير ما تعمل أي حاجة
    // تانية (مش أوردر جديد، مش خصم مخزون تاني). الفحص ده تحسين أداء للحالة الشائعة (retry عادي) بس -
    // الحماية الحقيقية ضد سباق طلبين متزامنين بنفس المفتاح بالظبط هي الـUNIQUE INDEX على
    // orders.idempotency_key، والتعامل مع تعارضه في catch تحت (atomic على مستوى القاعدة نفسها)
    if (idempotencyKey) {
      const existing = await client.query(
        "SELECT id, subtotal, total FROM orders WHERE idempotency_key = $1", [idempotencyKey]
      );
      if (existing.rows.length > 0) {
        return res.status(200).json({
          orderId: existing.rows[0].id, subtotal: Number(existing.rows[0].subtotal),
          total: Number(existing.rows[0].total), duplicate: true,
        });
      }
    }

    let items;
    try {
      items = await resolveOrderItems(client, rawItems, source || "website");
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }

    const subtotal = items.reduce((s, it) => s + it.lineTotal, 0);

    // خصم فوق النسبة المسموحة للكاشير لوحده لازم يبقى معاه موافقة مدير/أدمن اتاكدنا منها بـ PIN
    // (verify-override-pin) - بنتأكد من صحتها تاني هنا من السيرفر، مش بس بنصدّق الفرونت إند.
    // فوق حد تاني (discount_manager_max_percent) الموافقة لازم تبقى أدمن بس، مدير الفرع مبيكفيش.
    let discountApprover = null;
    if (discount > 0 && subtotal > 0) {
      const settings = await client.query(
        "SELECT max_unapproved_discount_percent, discount_manager_max_percent FROM pos_settings WHERE id = 1"
      );
      const maxUnapproved = Number(settings.rows[0]?.max_unapproved_discount_percent ?? 0.1);
      const managerMax = Number(settings.rows[0]?.discount_manager_max_percent ?? 0.15);
      const discountRatio = discount / subtotal;
      if (discountRatio > maxUnapproved) {
        if (!discountApprovedBy) {
          return res.status(400).json({ error: "الخصم ده محتاج موافقة مدير الفرع أو الأدمن" });
        }
        const requiresAdminOnly = discountRatio > managerMax;
        const approver = await client.query(
          `SELECT id, name, role FROM users
           WHERE id = $1 AND is_active = TRUE
             AND (role = 'admin' OR (role = 'branch_manager' AND branch_id = $2 AND NOT $3))`,
          [discountApprovedBy, branchId, requiresAdminOnly]
        );
        if (approver.rows.length === 0) {
          return res.status(400).json({
            error: requiresAdminOnly
              ? "الخصم ده كبير جدًا، محتاج موافقة الأدمن بس"
              : "الموافقة على الخصم غير صالحة",
          });
        }
        discountApprover = approver.rows[0];
      }
    }

    // موافقة تجاوز نقص المخزون (لأصناف سياستها ALLOW_WITH_APPROVAL بس) - نفس نمط موافقة الخصم بالظبط:
    // اتاكدنا منها هنا كمان (مش بس صدّقنا approverId من الفرونت إند). لو مش موجودة، الطلب لسه ممكن ينجح
    // عادي طالما مفيش صنف فيه هينزل تحت صفر - هنعرف ده بس لما نحاول الخصم فعليًا تحت
    let inventoryOverrideApprover = null;
    if (inventoryOverrideApprovedBy) {
      const overrideApprover = await client.query(
        `SELECT id, name FROM users
         WHERE id = $1 AND is_active = TRUE
           AND (role = 'admin' OR (role = 'branch_manager' AND branch_id = $2))`,
        [inventoryOverrideApprovedBy, branchId]
      );
      if (overrideApprover.rows.length === 0) {
        return res.status(400).json({ error: "الموافقة على تجاوز نقص المخزون غير صالحة" });
      }
      inventoryOverrideApprover = overrideApprover.rows[0];
    }

    await client.query("BEGIN");

    // خصم نقاط الولاء - قيمته بالجنيه بتتجمّد هنا وقت الاستخدام (نقاط × السعر الحالي)، منفصل عن discount
    // العادي عمدًا: ده رصيد العميل الفعلي هو نفسه اللي بيحد الاستخدام (مش قرار تقديري من الموظف)، فمش
    // محتاج نفس نظام موافقة الخصومات الكبيرة (PIN مدير/أدمن). القفل (FOR UPDATE) هنا يمنع استخدام نفس
    // الرصيد مرتين في نفس اللحظة لو اتسجل طلبين للعميل ده بالتوازي
    let loyaltyRedeemValue = 0;
    if (loyaltyPointsRedeemed > 0) {
      const custRow = await client.query("SELECT loyalty_points FROM customers WHERE phone = $1 FOR UPDATE", [customerPhone]);
      const currentPoints = custRow.rows[0]?.loyalty_points || 0;
      if (loyaltyPointsRedeemed > currentPoints) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: `العميل معاه ${currentPoints} نقطة بس` });
      }
      const redeemSettings = await client.query("SELECT loyalty_redeem_value_egp FROM pos_settings WHERE id = 1");
      const redeemRate = Number(redeemSettings.rows[0]?.loyalty_redeem_value_egp ?? 0);
      loyaltyRedeemValue = Math.round(loyaltyPointsRedeemed * redeemRate * 100) / 100;
    }

    const total = subtotal + deliveryFee - discount - loyaltyRedeemValue;
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

    // نقاط الولاء بتتحسب على إجمالي الطلب الفعلي (بعد الخصم) وقت الإنشاء، وبتتسجل على الطلب نفسه
    // عشان لو اتلغى/اتسترجع بعد كده نقدر نرجّع نفس الكمية بالظبط من رصيد العميل (مش نعيد حسابها)
    let loyaltyPointsEarned = 0;
    if (customerPhone && total > 0) {
      const loyaltySettings = await client.query("SELECT loyalty_points_per_egp FROM pos_settings WHERE id = 1");
      const rate = Number(loyaltySettings.rows[0]?.loyalty_points_per_egp ?? 0);
      loyaltyPointsEarned = Math.floor(total * rate);
    }

    const orderResult = await client.query(
      `INSERT INTO orders
        (branch_id, source, order_type, table_number, delivery_area_id,
         address_details, customer_name, customer_phone, payment_method_id,
         created_by, subtotal, delivery_fee, discount, discount_approved_by, total, status, payment_status,
         loyalty_points_earned, loyalty_points_redeemed, loyalty_redeem_value, idempotency_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
       RETURNING id`,
      [branchId, source || "website", orderType, tableNumber, deliveryAreaId,
       addressDetails, customerName, customerPhone, paymentMethodId,
       createdBy, subtotal, deliveryFee, discount, discountApprovedBy || null, total, initialStatus, initialPaymentStatus,
       loyaltyPointsEarned, loyaltyPointsRedeemed, loyaltyRedeemValue, idempotencyKey || null]
    );
    const orderId = orderResult.rows[0].id;

    await client.query(
      `INSERT INTO order_status_log (order_id, status, changed_by, notes) VALUES ($1, $2, $3, 'إنشاء الطلب')`,
      [orderId, initialStatus, createdBy]
    );

    if (discountApprover) {
      await logAudit(client, {
        branchId, userId: createdBy, action: "ORDER_DISCOUNT_APPROVED", entityType: "order", entityId: orderId,
        newValues: { discount, subtotal }, metadata: { approverId: discountApprover.id, approverName: discountApprover.name }, req,
      });
    }

    // تسجيل/تحديث العميل في سجل CRM المركزي عشان الكول سنتر يشوف تاريخه - بيانات الدليفري
    // (رقم تليفون تاني، عنوان تفصيلي، منطقة، علامة مميزة) بتتسجل هنا لو الطلب دليفري
    // ونقاط الولاء اللي اتحسبت فوق بتتضاف لرصيد العميل في نفس الخطوة (upsert واحد)
    if (customerPhone) {
      await client.query(
        `INSERT INTO customers (phone, name, phone2, address_details, delivery_area_id, distinguishing_mark, loyalty_points)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (phone) DO UPDATE SET
           name = COALESCE(EXCLUDED.name, customers.name),
           phone2 = COALESCE(EXCLUDED.phone2, customers.phone2),
           address_details = COALESCE(EXCLUDED.address_details, customers.address_details),
           delivery_area_id = COALESCE(EXCLUDED.delivery_area_id, customers.delivery_area_id),
           distinguishing_mark = COALESCE(EXCLUDED.distinguishing_mark, customers.distinguishing_mark),
           loyalty_points = GREATEST(customers.loyalty_points + $7 - $8, 0),
           updated_at = now()`,
        [
          customerPhone, customerName || null,
          orderType === "delivery" ? customerPhone2 || null : null,
          orderType === "delivery" ? addressDetails || null : null,
          orderType === "delivery" ? deliveryAreaId || null : null,
          orderType === "delivery" ? distinguishingMark || null : null,
          loyaltyPointsEarned, loyaltyPointsRedeemed,
        ]
      );
    }

    // كل صنف ممكن يبقى معاه مرفقات مختارة (إضافة موتزريلا، بدون طماطم...) - unitPrice/lineTotal ومرفقات
    // it.modifiers هنا كلها متأكد منها من المنيو الحقيقي (resolveOrderItems فوق)، مش من الواجهة مباشرة
    for (const it of items) {
      const inserted = await client.query(
        `INSERT INTO order_items (order_id, item_id, variant_id, combo_id, quantity, unit_price, line_total)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [orderId, it.comboId ? null : it.itemId, it.comboId ? null : it.variantId, it.comboId || null,
         it.quantity, it.unitPrice, it.lineTotal]
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

    // المرحلة 3: تسجيل نسخة الوصفة اللي كانت ACTIVE وقت البيع ده بالظبط لكل سطر مرتبط بحجم/صنف مباشر
    // (مش عرض/كومبو) - رابط تتبّع تاريخي صريح، منفصل عن cost_at_sale نفسها. NULL لو الصنف ده لسه معندوش
    // وصفة مسجّلة في محرك الوصفات (المرحلة 3) - سلوك متوقّع ومتوافق مع الأصناف القديمة
    await client.query(
      `UPDATE order_items oi
       SET recipe_version_id = rv.id
       FROM recipes r JOIN recipe_versions rv ON rv.recipe_id = r.id AND rv.status = 'ACTIVE'
       WHERE r.recipe_type = 'sellable_variant' AND r.variant_id = oi.variant_id
         AND oi.order_id = $1 AND oi.variant_id IS NOT NULL`,
      [orderId]
    );

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

      // المرحلة 3.1: تجميد التكلفة النظرية **لكل مكوّن على حدة** (مش إجمالي بس زي cost_at_sale) وقت
      // البيع بالظبط - نفس المصدر ونفس الـtransaction بالظبط اللي حسب cost_at_sale فوق (الجدول المسطّح +
      // unit_cost لحظة البيع)، مش حساب مستقل، عشان الاتنين يفضلوا متطابقين رياضيًا للأبد ومينفعش يختلفوا
      // بصمت. التقارير بعدين بتقرا من هنا بدل ما تعيد الحساب بسعر النهارده الحالي (كان الباج قبل كده)
      await client.query(
        `INSERT INTO order_item_ingredient_costs (order_item_id, ingredient_item_id, quantity, unit_cost, total_cost)
         SELECT oi2.id, mvi.inventory_item_id, mvi.quantity_per_unit::numeric * oi2.quantity::numeric,
                ii.unit_cost, mvi.quantity_per_unit::numeric * oi2.quantity::numeric * ii.unit_cost::numeric
         FROM order_items oi2
         JOIN menu_item_variant_ingredients mvi ON mvi.variant_id = oi2.variant_id
         JOIN inventory_items ii ON ii.id = mvi.inventory_item_id
         WHERE oi2.order_id = $1 AND oi2.variant_id IS NOT NULL`,
        [orderId]
      );
      await client.query(
        `INSERT INTO order_item_ingredient_costs (order_item_id, ingredient_item_id, quantity, unit_cost, total_cost)
         SELECT oi2.id, mvi.inventory_item_id, mvi.quantity_per_unit::numeric * ci.quantity::numeric * oi2.quantity::numeric,
                ii.unit_cost, mvi.quantity_per_unit::numeric * ci.quantity::numeric * oi2.quantity::numeric * ii.unit_cost::numeric
         FROM order_items oi2
         JOIN combo_items ci ON ci.combo_id = oi2.combo_id
         JOIN menu_item_variant_ingredients mvi ON mvi.variant_id = ci.variant_id
         JOIN inventory_items ii ON ii.id = mvi.inventory_item_id
         WHERE oi2.order_id = $1 AND oi2.combo_id IS NOT NULL`,
        [orderId]
      );
    }

    // خصم المخزون تلقائيًا حسب وصفة كل صنف (BOM) - لو الطلب مربوط بفرع
    // العروض (combo) مفيهاش وصفة مباشرة - بنفكّها لأصنافها الأصلية وناخد وصفة كل صنف منهم
    const negativeStockOverrides = [];
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
            const deduction = await client.query(
              "SELECT ($1::numeric * $2::numeric) AS qty", [ing.quantity_per_unit, v.multiplier]
            );
            const { movement: saleMovement, negativeOverrideUsed } = await postInventoryMovement(client, {
              branchId, inventoryItemId: ing.inventory_item_id, quantity: -Number(deduction.rows[0].qty),
              movementType: "SALE", referenceType: "order", referenceId: orderId,
              userId: createdBy, negativeStockOverrideApproved: !!inventoryOverrideApprover,
            });
            if (negativeOverrideUsed) {
              negativeStockOverrides.push({
                inventoryItemId: ing.inventory_item_id, quantityBefore: saleMovement.quantity_before,
                quantityRequested: Number(deduction.rows[0].qty),
              });
            }
          }
        }
      }
    }

    if (negativeStockOverrides.length > 0) {
      await logAudit(client, {
        branchId, userId: req.user.id, action: "NEGATIVE_STOCK_OVERRIDE", entityType: "order", entityId: orderId,
        newValues: { items: negativeStockOverrides },
        metadata: { approverId: inventoryOverrideApprover.id, approverName: inventoryOverrideApprover.name }, req,
      });
    }

    // المرحلة 4B: ترحيل قيد البيع محاسبيًا - في نفس transaction إنشاء الأوردر بالظبط (ذرّي: يا كله ينجح
    // يا كله يترجع)، مش خطوة منفصلة بعد كده. التكلفة (COGS) بتتاخد من cost_at_sale اللي اتجمّد فوق -
    // مفيش إعادة حساب مستقلة. total = subtotal + deliveryFee - discount بالظبط، فالقيد متزن تلقائيًا
    // من غير أي تسوية يدوية: مدين (كاش/عميل/مستحقات تطبيق) = دائن (مبيعات طعام + توصيل) - مدين خصومات
    if (branchId && total > 0) {
      const costRes = await client.query(
        `SELECT COALESCE(SUM(cost_at_sale), 0) AS total_cost, BOOL_OR(cost_at_sale_incomplete) AS incomplete
         FROM order_items WHERE order_id = $1`,
        [orderId]
      );
      const costTotal = Number(costRes.rows[0].total_cost);
      const costIncomplete = costRes.rows[0].incomplete;

      let debitAccount;
      if (source === "talabat") {
        debitAccount = await getAccountByCode(client, "1350");
      } else if (paymentKind === "cash" && initialPaymentStatus === "collected") {
        debitAccount = await getOrCreateBranchCashAccount(client, branchId);
      } else if (initialPaymentStatus === "pending_collection") {
        debitAccount = await getAccountByCode(client, "1300");
      } else {
        debitAccount = await getAccountByCode(client, "1200");
      }

      const revenueLines = [{ accountId: debitAccount.id, debit: total, description: "قيمة الطلب" }];
      if (subtotal > 0) revenueLines.push({ accountId: (await getAccountByCode(client, "4100")).id, credit: subtotal });
      if (deliveryFee > 0) revenueLines.push({ accountId: (await getAccountByCode(client, "4200")).id, credit: deliveryFee });
      if (discount > 0) revenueLines.push({ accountId: (await getAccountByCode(client, "4900")).id, debit: discount });
      if (loyaltyRedeemValue > 0) revenueLines.push({ accountId: (await getAccountByCode(client, "4900")).id, debit: loyaltyRedeemValue, description: "خصم نقاط ولاء" });

      if (costTotal > 0) {
        revenueLines.push({ accountId: (await getAccountByCode(client, "5100")).id, debit: costTotal, description: costIncomplete ? "تكلفة جزئية (بيانات تكلفة ناقصة لبعض الأصناف)" : null });
        revenueLines.push({ accountId: (await getAccountByCode(client, "1400")).id, credit: costTotal });
      }

      await postJournalEntry(client, {
        entryDate: new Date().toISOString().slice(0, 10), description: `بيع - طلب #${orderId}`,
        sourceType: "order_sale", sourceId: orderId, branchId,
        lines: revenueLines, idempotencyKey: `order-sale-${orderId}`, userId: createdBy,
      });
    }

    await client.query("COMMIT");
    res.status(201).json({ orderId, subtotal, total });
  } catch (err) {
    await client.query("ROLLBACK");
    // طلبين متزامنين بنفس idempotency_key بالظبط - واحد بس فاز بالـINSERT، التاني بيرجّع نتيجة الفايز
    // بدل ما يفشل أو يسجّل أوردر تاني. ده الحماية الحقيقية (على مستوى القاعدة) مش بس الفحص المبدئي فوق.
    // بنستخدم req.body مباشرة هنا (مش المتغيّر المحلي) لأن const جوه try{} مش شايفها catch{} - نطاقات منفصلة
    if (err.code === "23505" && req.body.idempotencyKey) {
      const existing = await pool.query(
        "SELECT id, subtotal, total FROM orders WHERE idempotency_key = $1", [req.body.idempotencyKey]
      );
      if (existing.rows.length > 0) {
        return res.status(200).json({
          orderId: existing.rows[0].id, subtotal: Number(existing.rows[0].subtotal),
          total: Number(existing.rows[0].total), duplicate: true,
        });
      }
    }
    if (err.code === "INSUFFICIENT_STOCK") {
      return res.status(400).json({ error: err.message, code: "INSUFFICIENT_STOCK" });
    }
    if (err.code === "INSUFFICIENT_STOCK_NEEDS_APPROVAL") {
      return res.status(400).json({ error: err.message, code: "INSUFFICIENT_STOCK_NEEDS_APPROVAL" });
    }
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
    // المرحلة 6 (6A.4): القفل والقراءة لازم يبقوا جوه transaction واحدة قبل أي فحص حالة - نفس نمط باج
    // التزامن اللي اتصلح قبل كده في المرحلة 5/6A - قبل الإصلاح، طلبين "cancelled" متزامنين على نفس
    // الطلب كانوا هيعدّوا فحص "مش terminal بالفعل" مع بعض، والاتنين هيخصموا نقاط الولاء اللي كانت
    // اتضافت وقت الإنشاء مرتين بدل مرة واحدة (كل واحد بيستخدم نفس current.loyalty_points_earned
    // القديم، مش قيمة محدّثة بعد أول خصم)
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const existing = await client.query(
        "SELECT branch_id, status, customer_phone, loyalty_points_earned, loyalty_points_redeemed FROM orders WHERE id = $1 FOR UPDATE",
        [req.params.id]
      );
      if (existing.rows.length === 0) { await client.query("ROLLBACK"); return res.status(404).json({ error: "الطلب مش موجود" }); }
      const current = existing.rows[0];

      if ((req.user.role === "cashier" || req.user.role === "branch_manager") && !assertOwnBranch(req.user, current.branch_id)) {
        await client.query("ROLLBACK");
        return res.status(403).json({ error: "معندكش صلاحية تعدّل طلب فرع تاني" });
      }
      if (TERMINAL_STATUSES.includes(current.status)) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "الطلب ده اتسلم أو اتلغى بالفعل، مينفعش تتعدل حالته" });
      }
      if (status === "out_for_delivery" && !driverName) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "لازم اسم الطيار عشان تنقل الطلب لحالة (في الطريق)" });
      }

      // synced_at بيترجع NULL عمدًا هنا - لو الطلب كان اتبعت للمركزي قبل كده (مزامنة الفروع)،
      // ده بيخلي db/sync-worker.js يلقطه تاني ويبعت الحالة الجديدة بدل ما يفضل واقف على القديمة
      const result = await client.query(
        `UPDATE orders SET status = $1, driver_name = COALESCE($2, driver_name), synced_at = NULL WHERE id = $3 RETURNING *`,
        [status, driverName || null, req.params.id]
      );
      await client.query(
        `INSERT INTO order_status_log (order_id, status, changed_by, notes) VALUES ($1, $2, $3, $4)`,
        [req.params.id, status, req.user.id, notes || null]
      );

      // لو الطلب اتلغى قبل ما يكتمل، لازم نرجّع نقاط الولاء اللي كانت اتضافت للعميل وقت الإنشاء، ونرجّع
      // له كمان أي نقاط كان استخدمها كخصم على نفس الطلب (الطلب اتلغى، فمن حقه ياخد نقاطه اللي دفعها تاني)
      if (status === "cancelled" && current.customer_phone) {
        const netPoints = Number(current.loyalty_points_earned || 0) - Number(current.loyalty_points_redeemed || 0);
        if (netPoints !== 0) {
          await client.query(
            `UPDATE customers SET loyalty_points = GREATEST(loyalty_points - $1, 0) WHERE phone = $2`,
            [netPoints, current.customer_phone]
          );
        }
      }

      if (status === "cancelled") {
        await logAudit(client, {
          branchId: current.branch_id, userId: req.user.id, action: "ORDER_CANCELLED",
          entityType: "order", entityId: Number(req.params.id),
          oldValues: { status: current.status }, newValues: { status }, metadata: { notes }, req,
        });
      }

      await client.query("COMMIT");
      res.json(result.rows[0]);
    } catch (err) {
      await client.query("ROLLBACK");
      res.status(500).json({ error: err.message });
    } finally {
      client.release();
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
      // المرحلة 5: BEGIN + FOR UPDATE هنا (مش بعد التحقق زي قبل كده) - عشان نقفل صف الطلب من أول لحظة
      // قبل أي تحقق، لا بعده. قبل كده كان التحقق بيحصل من غير قفل خالص، فطلبات void متزامنة لنفس
      // الطلب كانت كلها بتعدّي شرط status==='completed' قبل ما أي واحد يعمل commit - نتيجته المخزون
      // بيترجع أكتر من مرة (اتأكد فعليًا بـ3 طلبات متزامنة في tests/phase5-integration.test.js)
      await client.query("BEGIN");
      const orderRes = await client.query("SELECT * FROM orders WHERE id = $1 FOR UPDATE", [req.params.id]);
      if (orderRes.rows.length === 0) { await client.query("ROLLBACK"); return res.status(404).json({ error: "الطلب مش موجود" }); }
      const order = orderRes.rows[0];

      if ((req.user.role === "cashier" || req.user.role === "branch_manager") && !assertOwnBranch(req.user, order.branch_id)) {
        await client.query("ROLLBACK");
        return res.status(403).json({ error: "معندكش صلاحية تسترجع طلب فرع تاني" });
      }
      if (order.status !== "completed" || order.voided) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "الاسترجاع (Void) بس للطلبات المكتملة اللي لسه ما اتسترجعتش" });
      }

      let finalApproverId;
      if (req.user.role === "admin" || req.user.role === "branch_manager") {
        finalApproverId = req.user.id;
      } else {
        if (!approverId) { await client.query("ROLLBACK"); return res.status(400).json({ error: "استرجاع الطلب محتاج موافقة مدير الفرع أو الأدمن" }); }
        const approver = await client.query(
          `SELECT id FROM users
           WHERE id = $1 AND is_active = TRUE
             AND (role = 'admin' OR (role = 'branch_manager' AND branch_id = $2))`,
          [approverId, order.branch_id]
        );
        if (approver.rows.length === 0) { await client.query("ROLLBACK"); return res.status(400).json({ error: "الموافقة على الاسترجاع غير صالحة" }); }
        finalApproverId = approverId;
      }

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

        const grouped = await client.query(
          `SELECT sub.inventory_item_id, SUM(sub.qty) AS qty FROM (${reversalIngredients}) sub GROUP BY sub.inventory_item_id`,
          [order.id]
        );
        for (const row of grouped.rows) {
          await postInventoryMovement(client, {
            branchId: order.branch_id, inventoryItemId: row.inventory_item_id, quantity: Number(row.qty),
            movementType: "SALE_REVERSAL", referenceType: "order", referenceId: order.id,
            userId: req.user.id,
          });
        }
      }

      // إرجاع نقاط الولاء اللي كانت اتضافت للعميل وقت البيع، ورجّع له أي نقاط كان استخدمها كخصم على
      // نفس الطلب (اتسترجع، فمن حقه ياخد نقاطه اللي دفعها تاني) - نفس منطق إرجاع المخزون بالظبط
      if (order.customer_phone) {
        const netPoints = Number(order.loyalty_points_earned || 0) - Number(order.loyalty_points_redeemed || 0);
        if (netPoints !== 0) {
          await client.query(
            `UPDATE customers SET loyalty_points = GREATEST(loyalty_points - $1, 0) WHERE phone = $2`,
            [netPoints, order.customer_phone]
          );
        }
      }

      // المرحلة 4B: عكس قيد البيع الأصلي محاسبيًا (لو كان موجود أصلًا - طلبات قبل تفعيل المرحلة 4B أو
      // بدون فرع مفيهاش قيد خالص، عادي نتجاهله). عكس حقيقي (قيد جديد بمدين/دائن معكوسين)، مش تعديل أو
      // مسح للقيد الأصلي - هو نفسه بيفضل موجود للأبد بعلامة REVERSED بس
      const originalEntry = await client.query(
        "SELECT id FROM journal_entries WHERE source_type = 'order_sale' AND source_id = $1 AND status = 'POSTED'",
        [order.id]
      );
      if (originalEntry.rows.length > 0) {
        await reverseJournalEntry(client, {
          originalEntryId: originalEntry.rows[0].id, entryDate: new Date().toISOString().slice(0, 10),
          reason: `استرجاع (Void) - ${reason}`, userId: req.user.id, idempotencyKey: `order-void-${order.id}`,
        });
      }

      await logAudit(client, {
        branchId: order.branch_id, userId: req.user.id, action: "ORDER_VOID",
        entityType: "order", entityId: order.id,
        oldValues: { status: order.status }, newValues: { status: "cancelled", voided: true },
        metadata: { reason, approverId: finalApproverId }, req,
      });

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

// PUT /api/orders/:id - تعديل طلب لسه "تحت التحضير" بس (قبل ما ينتقل لحالة "في الطريق" أو يتسلم أو يتلغي).
// بيسمح بتغيير الأصناف/العنوان/بيانات العميل/الخصم، وبيعيد بناء كل أثر الطلب من الصفر (المخزون، تكلفة
// الوصفة المجمّدة، القيد المحاسبي، نقاط الولاء) - رجوع الأثر القديم بالكامل (نفس منطق POST /:id/void
// بالظبط) ثم تطبيق الجديد (نفس منطق POST / بالظبط)، كله جوه transaction واحدة ذرّية مقفولة بـFOR UPDATE
// من أول لحظة. الفحص status==='preparing' هو نفسه الضمانة إن محدش يعدّل طلب اتحرك أو اتسلم أو اتلغى بالفعل.
router.put(
  "/:id",
  requireAuth,
  requireRole("cashier", "branch_manager", "admin", "callcenter"),
  async (req, res) => {
    const {
      deliveryAreaId, addressDetails, distinguishingMark,
      customerName, customerPhone, customerPhone2,
      paymentMethodId, items: rawItems,
      discountApprovedBy, inventoryOverrideApprovedBy, tableNumber,
    } = req.body;

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const orderRes = await client.query("SELECT * FROM orders WHERE id = $1 FOR UPDATE", [req.params.id]);
      if (orderRes.rows.length === 0) { await client.query("ROLLBACK"); return res.status(404).json({ error: "الطلب مش موجود" }); }
      const order = orderRes.rows[0];

      if ((req.user.role === "cashier" || req.user.role === "branch_manager") && !assertOwnBranch(req.user, order.branch_id)) {
        await client.query("ROLLBACK");
        return res.status(403).json({ error: "معندكش صلاحية تعدّل طلب فرع تاني" });
      }
      if (order.status !== "preparing" || order.voided) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "التعديل متاح بس للطلبات تحت التحضير" });
      }

      // مفيش قيمة افتراضية صفر لـdeliveryFee/discount/loyaltyPointsRedeemed هنا عمدًا (زي POST /) - ده
      // PATCH-style، لو الفرونت إند مبعتش الحقل ده أصلًا لازم تفضل قيمته الأصلية زي ما هي، مش تتصفّر بهدوء
      const deliveryFee = req.body.deliveryFee !== undefined ? req.body.deliveryFee : Number(order.delivery_fee);
      const discount = req.body.discount !== undefined ? req.body.discount : Number(order.discount);
      const loyaltyPointsRedeemed = req.body.loyaltyPointsRedeemed !== undefined
        ? req.body.loyaltyPointsRedeemed : Number(order.loyalty_points_redeemed || 0);
      if (loyaltyPointsRedeemed) {
        if (!Number.isInteger(loyaltyPointsRedeemed) || loyaltyPointsRedeemed < 0) {
          await client.query("ROLLBACK");
          return res.status(400).json({ error: "عدد نقاط الولاء المستخدمة غير صالح" });
        }
        const finalPhoneCheck = customerPhone !== undefined ? customerPhone : order.customer_phone;
        if (!finalPhoneCheck) {
          await client.query("ROLLBACK");
          return res.status(400).json({ error: "استخدام نقاط الولاء محتاج رقم تليفون العميل" });
        }
      }

      if (!Array.isArray(rawItems) || rawItems.length === 0) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "لازم صنف واحد على الأقل في الطلب" });
      }
      let items;
      try {
        items = await resolveOrderItems(client, rawItems, order.source);
      } catch (err) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: err.message });
      }

      const subtotal = items.reduce((s, it) => s + it.lineTotal, 0);

      // نفس فحص موافقة الخصم بالظبط زي POST / - مبني على القيم الجديدة بعد التعديل
      let discountApprover = null;
      if (discount > 0 && subtotal > 0) {
        const settings = await client.query(
          "SELECT max_unapproved_discount_percent, discount_manager_max_percent FROM pos_settings WHERE id = 1"
        );
        const maxUnapproved = Number(settings.rows[0]?.max_unapproved_discount_percent ?? 0.1);
        const managerMax = Number(settings.rows[0]?.discount_manager_max_percent ?? 0.15);
        const discountRatio = discount / subtotal;
        if (discountRatio > maxUnapproved) {
          if (!discountApprovedBy) {
            await client.query("ROLLBACK");
            return res.status(400).json({ error: "الخصم ده محتاج موافقة مدير الفرع أو الأدمن" });
          }
          const requiresAdminOnly = discountRatio > managerMax;
          const approver = await client.query(
            `SELECT id, name, role FROM users
             WHERE id = $1 AND is_active = TRUE
               AND (role = 'admin' OR (role = 'branch_manager' AND branch_id = $2 AND NOT $3))`,
            [discountApprovedBy, order.branch_id, requiresAdminOnly]
          );
          if (approver.rows.length === 0) {
            await client.query("ROLLBACK");
            return res.status(400).json({
              error: requiresAdminOnly ? "الخصم ده كبير جدًا، محتاج موافقة الأدمن بس" : "الموافقة على الخصم غير صالحة",
            });
          }
          discountApprover = approver.rows[0];
        }
      }

      let inventoryOverrideApprover = null;
      if (inventoryOverrideApprovedBy) {
        const overrideApprover = await client.query(
          `SELECT id, name FROM users
           WHERE id = $1 AND is_active = TRUE
             AND (role = 'admin' OR (role = 'branch_manager' AND branch_id = $2))`,
          [inventoryOverrideApprovedBy, order.branch_id]
        );
        if (overrideApprover.rows.length === 0) {
          await client.query("ROLLBACK");
          return res.status(400).json({ error: "الموافقة على تجاوز نقص المخزون غير صالحة" });
        }
        inventoryOverrideApprover = overrideApprover.rows[0];
      }

      // ---- رجوع أثر الطلب القديم بالكامل (مخزون + نقاط ولاء + قيد محاسبي) - نفس منطق POST /:id/void ----
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
        const grouped = await client.query(
          `SELECT sub.inventory_item_id, SUM(sub.qty) AS qty FROM (${reversalIngredients}) sub GROUP BY sub.inventory_item_id`,
          [order.id]
        );
        for (const row of grouped.rows) {
          await postInventoryMovement(client, {
            branchId: order.branch_id, inventoryItemId: row.inventory_item_id, quantity: Number(row.qty),
            movementType: "SALE_REVERSAL", referenceType: "order", referenceId: order.id,
            userId: req.user.id,
          });
        }
      }

      // رجوع صافي أثر نقاط الولاء القديم (المكتسبة ناقص المستخدمة) على رصيد العميل الأصلي - قبل أي تطبيق
      // لنقاط جديدة تحت، عشان لو التعديل مغيّرش رقم تليفون العميل يفضل الرصيد صحيح 100% في كل لحظة
      if (order.customer_phone) {
        const netOldPoints = Number(order.loyalty_points_earned || 0) - Number(order.loyalty_points_redeemed || 0);
        if (netOldPoints !== 0) {
          await client.query(
            `UPDATE customers SET loyalty_points = GREATEST(loyalty_points - $1, 0) WHERE phone = $2`,
            [netOldPoints, order.customer_phone]
          );
        }
      }

      const originalEntry = await client.query(
        "SELECT id FROM journal_entries WHERE source_type = 'order_sale' AND source_id = $1 AND status = 'POSTED'",
        [order.id]
      );
      if (originalEntry.rows.length > 0) {
        await reverseJournalEntry(client, {
          originalEntryId: originalEntry.rows[0].id, entryDate: new Date().toISOString().slice(0, 10),
          reason: "تعديل الطلب", userId: req.user.id,
        });
      }

      // مسح الأصناف القديمة - order_item_modifiers وorder_item_ingredient_costs بيتشالوا معاهم أوتوماتيك (ON DELETE CASCADE)
      await client.query("DELETE FROM order_items WHERE order_id = $1", [order.id]);

      // ---- تطبيق الأصناف الجديدة - نفس منطق POST / بالظبط ----
      for (const it of items) {
        const inserted = await client.query(
          `INSERT INTO order_items (order_id, item_id, variant_id, combo_id, quantity, unit_price, line_total)
           VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
          [order.id, it.comboId ? null : it.itemId, it.comboId ? null : it.variantId, it.comboId || null,
           it.quantity, it.unitPrice, it.lineTotal]
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

      await client.query(
        `UPDATE order_items oi
         SET recipe_version_id = rv.id
         FROM recipes r JOIN recipe_versions rv ON rv.recipe_id = r.id AND rv.status = 'ACTIVE'
         WHERE r.recipe_type = 'sellable_variant' AND r.variant_id = oi.variant_id
           AND oi.order_id = $1 AND oi.variant_id IS NOT NULL`,
        [order.id]
      );

      if (order.branch_id) {
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
          [order.id]
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
          [order.id]
        );
        await client.query(
          `INSERT INTO order_item_ingredient_costs (order_item_id, ingredient_item_id, quantity, unit_cost, total_cost)
           SELECT oi2.id, mvi.inventory_item_id, mvi.quantity_per_unit::numeric * oi2.quantity::numeric,
                  ii.unit_cost, mvi.quantity_per_unit::numeric * oi2.quantity::numeric * ii.unit_cost::numeric
           FROM order_items oi2
           JOIN menu_item_variant_ingredients mvi ON mvi.variant_id = oi2.variant_id
           JOIN inventory_items ii ON ii.id = mvi.inventory_item_id
           WHERE oi2.order_id = $1 AND oi2.variant_id IS NOT NULL`,
          [order.id]
        );
        await client.query(
          `INSERT INTO order_item_ingredient_costs (order_item_id, ingredient_item_id, quantity, unit_cost, total_cost)
           SELECT oi2.id, mvi.inventory_item_id, mvi.quantity_per_unit::numeric * ci.quantity::numeric * oi2.quantity::numeric,
                  ii.unit_cost, mvi.quantity_per_unit::numeric * ci.quantity::numeric * oi2.quantity::numeric * ii.unit_cost::numeric
           FROM order_items oi2
           JOIN combo_items ci ON ci.combo_id = oi2.combo_id
           JOIN menu_item_variant_ingredients mvi ON mvi.variant_id = ci.variant_id
           JOIN inventory_items ii ON ii.id = mvi.inventory_item_id
           WHERE oi2.order_id = $1 AND oi2.combo_id IS NOT NULL`,
          [order.id]
        );
      }

      const negativeStockOverrides = [];
      if (order.branch_id) {
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
              const deduction = await client.query(
                "SELECT ($1::numeric * $2::numeric) AS qty", [ing.quantity_per_unit, v.multiplier]
              );
              const { movement: saleMovement, negativeOverrideUsed } = await postInventoryMovement(client, {
                branchId: order.branch_id, inventoryItemId: ing.inventory_item_id, quantity: -Number(deduction.rows[0].qty),
                movementType: "SALE", referenceType: "order", referenceId: order.id,
                userId: req.user.id, negativeStockOverrideApproved: !!inventoryOverrideApprover,
              });
              if (negativeOverrideUsed) {
                negativeStockOverrides.push({
                  inventoryItemId: ing.inventory_item_id, quantityBefore: saleMovement.quantity_before,
                  quantityRequested: Number(deduction.rows[0].qty),
                });
              }
            }
          }
        }
      }

      if (negativeStockOverrides.length > 0) {
        await logAudit(client, {
          branchId: order.branch_id, userId: req.user.id, action: "NEGATIVE_STOCK_OVERRIDE", entityType: "order", entityId: order.id,
          newValues: { items: negativeStockOverrides },
          metadata: { approverId: inventoryOverrideApprover.id, approverName: inventoryOverrideApprover.name }, req,
        });
      }

      const finalCustomerPhone = customerPhone !== undefined ? customerPhone : order.customer_phone;
      const finalCustomerName = customerName !== undefined ? customerName : order.customer_name;
      const finalAddressDetails = addressDetails !== undefined ? addressDetails : order.address_details;
      const finalDeliveryAreaId = deliveryAreaId !== undefined ? deliveryAreaId : order.delivery_area_id;
      const finalPaymentMethodId = paymentMethodId !== undefined ? paymentMethodId : order.payment_method_id;
      const finalTableNumber = tableNumber !== undefined ? tableNumber : order.table_number;

      // إعادة حساب خصم نقاط الولاء على رصيد العميل الحالي - بعد ما رجّعنا صافي أثر الطلب القديم فوق،
      // الرصيد ده بقى معبّر عن الحقيقة (مش شايل رصيد الطلب اللي بنعدّله ده تحديدًا)
      let loyaltyRedeemValue = 0;
      if (loyaltyPointsRedeemed > 0) {
        const custRow = await client.query("SELECT loyalty_points FROM customers WHERE phone = $1 FOR UPDATE", [finalCustomerPhone]);
        const currentPoints = custRow.rows[0]?.loyalty_points || 0;
        if (loyaltyPointsRedeemed > currentPoints) {
          await client.query("ROLLBACK");
          return res.status(400).json({ error: `العميل معاه ${currentPoints} نقطة بس` });
        }
        const redeemSettings = await client.query("SELECT loyalty_redeem_value_egp FROM pos_settings WHERE id = 1");
        const redeemRate = Number(redeemSettings.rows[0]?.loyalty_redeem_value_egp ?? 0);
        loyaltyRedeemValue = Math.round(loyaltyPointsRedeemed * redeemRate * 100) / 100;
      }

      const total = subtotal + deliveryFee - discount - loyaltyRedeemValue;

      let loyaltyPointsEarned = 0;
      if (finalCustomerPhone && total > 0) {
        const loyaltySettings = await client.query("SELECT loyalty_points_per_egp FROM pos_settings WHERE id = 1");
        const rate = Number(loyaltySettings.rows[0]?.loyalty_points_per_egp ?? 0);
        loyaltyPointsEarned = Math.floor(total * rate);
      }

      await client.query(
        `UPDATE orders SET
           table_number = $1, delivery_area_id = $2, address_details = $3,
           customer_name = $4, customer_phone = $5, payment_method_id = $6,
           subtotal = $7, delivery_fee = $8, discount = $9, discount_approved_by = $10,
           total = $11, loyalty_points_earned = $12, loyalty_points_redeemed = $13, loyalty_redeem_value = $14,
           synced_at = NULL
         WHERE id = $15`,
        [
          finalTableNumber, finalDeliveryAreaId, finalAddressDetails, finalCustomerName, finalCustomerPhone,
          finalPaymentMethodId, subtotal, deliveryFee, discount, discountApprovedBy || null,
          total, loyaltyPointsEarned, loyaltyPointsRedeemed, loyaltyRedeemValue, order.id,
        ]
      );

      if (discountApprover) {
        await logAudit(client, {
          branchId: order.branch_id, userId: req.user.id, action: "ORDER_DISCOUNT_APPROVED", entityType: "order", entityId: order.id,
          newValues: { discount, subtotal }, metadata: { approverId: discountApprover.id, approverName: discountApprover.name }, req,
        });
      }

      // نفس منطق upsert بيانات العميل بتاع POST / بالظبط - بيانات الدليفري (تليفون تاني، عنوان، منطقة،
      // علامة مميزة) بتتحدّث هنا كمان لو الطلب دليفري، ونقاط الولاء الجديدة بتتضاف لرصيد العميل
      if (finalCustomerPhone) {
        await client.query(
          `INSERT INTO customers (phone, name, phone2, address_details, delivery_area_id, distinguishing_mark, loyalty_points)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (phone) DO UPDATE SET
             name = COALESCE(EXCLUDED.name, customers.name),
             phone2 = COALESCE(EXCLUDED.phone2, customers.phone2),
             address_details = COALESCE(EXCLUDED.address_details, customers.address_details),
             delivery_area_id = COALESCE(EXCLUDED.delivery_area_id, customers.delivery_area_id),
             distinguishing_mark = COALESCE(EXCLUDED.distinguishing_mark, customers.distinguishing_mark),
             loyalty_points = GREATEST(customers.loyalty_points + $7 - $8, 0),
             updated_at = now()`,
          [
            finalCustomerPhone, finalCustomerName,
            order.order_type === "delivery" ? customerPhone2 || null : null,
            order.order_type === "delivery" ? finalAddressDetails || null : null,
            order.order_type === "delivery" ? finalDeliveryAreaId || null : null,
            order.order_type === "delivery" ? distinguishingMark || null : null,
            loyaltyPointsEarned, loyaltyPointsRedeemed,
          ]
        );
      }

      // ---- إعادة ترحيل قيد البيع محاسبيًا بالإجمالي الجديد - نفس منطق اختيار الحساب المدين بتاع POST / بالظبط ----
      if (order.branch_id && total > 0) {
        let paymentKind = "cash";
        if (finalPaymentMethodId) {
          const pm = await client.query("SELECT kind FROM payment_methods WHERE id = $1", [finalPaymentMethodId]);
          if (pm.rows.length > 0) paymentKind = pm.rows[0].kind;
        }

        const costRes = await client.query(
          `SELECT COALESCE(SUM(cost_at_sale), 0) AS total_cost, BOOL_OR(cost_at_sale_incomplete) AS incomplete
           FROM order_items WHERE order_id = $1`,
          [order.id]
        );
        const costTotal = Number(costRes.rows[0].total_cost);
        const costIncomplete = costRes.rows[0].incomplete;

        let debitAccount;
        if (order.source === "talabat") {
          debitAccount = await getAccountByCode(client, "1350");
        } else if (paymentKind === "cash" && order.payment_status === "collected") {
          debitAccount = await getOrCreateBranchCashAccount(client, order.branch_id);
        } else if (order.payment_status === "pending_collection") {
          debitAccount = await getAccountByCode(client, "1300");
        } else {
          debitAccount = await getAccountByCode(client, "1200");
        }

        const revenueLines = [{ accountId: debitAccount.id, debit: total, description: "قيمة الطلب (بعد التعديل)" }];
        if (subtotal > 0) revenueLines.push({ accountId: (await getAccountByCode(client, "4100")).id, credit: subtotal });
        if (deliveryFee > 0) revenueLines.push({ accountId: (await getAccountByCode(client, "4200")).id, credit: deliveryFee });
        if (discount > 0) revenueLines.push({ accountId: (await getAccountByCode(client, "4900")).id, debit: discount });
        if (loyaltyRedeemValue > 0) revenueLines.push({ accountId: (await getAccountByCode(client, "4900")).id, debit: loyaltyRedeemValue, description: "خصم نقاط ولاء" });

        if (costTotal > 0) {
          revenueLines.push({ accountId: (await getAccountByCode(client, "5100")).id, debit: costTotal, description: costIncomplete ? "تكلفة جزئية (بيانات تكلفة ناقصة لبعض الأصناف)" : null });
          revenueLines.push({ accountId: (await getAccountByCode(client, "1400")).id, credit: costTotal });
        }

        await postJournalEntry(client, {
          entryDate: new Date().toISOString().slice(0, 10), description: `بيع (بعد تعديل) - طلب #${order.id}`,
          sourceType: "order_sale", sourceId: order.id, branchId: order.branch_id,
          lines: revenueLines, userId: req.user.id,
        });
      }

      await client.query(
        `INSERT INTO order_status_log (order_id, status, changed_by, notes) VALUES ($1, $2, $3, 'تعديل الطلب')`,
        [order.id, order.status, req.user.id]
      );

      await logAudit(client, {
        branchId: order.branch_id, userId: req.user.id, action: "ORDER_EDITED", entityType: "order", entityId: order.id,
        oldValues: { subtotal: Number(order.subtotal), total: Number(order.total) },
        newValues: { subtotal, total }, req,
      });

      await client.query("COMMIT");
      const updated = await pool.query("SELECT * FROM orders WHERE id = $1", [order.id]);
      res.json(updated.rows[0]);
    } catch (err) {
      await client.query("ROLLBACK");
      if (err.code === "INSUFFICIENT_STOCK") return res.status(400).json({ error: err.message, code: "INSUFFICIENT_STOCK" });
      if (err.code === "INSUFFICIENT_STOCK_NEEDS_APPROVAL") return res.status(400).json({ error: err.message, code: "INSUFFICIENT_STOCK_NEEDS_APPROVAL" });
      res.status(500).json({ error: err.message });
    } finally {
      client.release();
    }
  }
);

module.exports = router;
