// المرحلة 7G: شاشة المطبخ الحقيقية (KDS) - استعلام واحد بيرجّع كل الطلبات الشغالة للفرع مع أصنافها
// ومرفقاتها مجمّعة (json_agg) عشان اللوحة تعرض كل حاجة من غير N+1 fetch لكل طلب على حدة. الاسم "kds"
// عمدًا مختلف عن "/api/kitchen-orders" الموجود أصلًا (مفهوم تاني تمامًا - طلبات الفرع من المطبخ
// المركزي لمخزون خام، مش شاشة تتبّع تحضير طلبات العملاء) عشان مفيش أي لبس بين الاتنين.
const express = require("express");
const router = express.Router();
const pool = require("../db/pool");
const { requireAuth, assertOwnBranch } = require("../middleware/auth");
const { requirePermission } = require("../middleware/permissions");

router.use(requireAuth);

// GET /api/kds/orders?branchId= - كل الطلبات الشغالة (مش ملغاة) + آخر READY من نص ساعة كحد أقصى
// (عشان الطلبات الجاهزة تفضل ظاهرة شوية بعد التسليم للمراجعة، مش تختفي فورًا ولا تتراكم للأبد)
router.get("/orders", requirePermission("kitchen.view"), async (req, res) => {
  const branchId = req.query.branchId || req.user.branchId;
  if (!branchId) return res.status(400).json({ error: "لازم تحدد الفرع" });
  if (!assertOwnBranch(req.user, branchId)) {
    return res.status(403).json({ error: "معندكش صلاحية تشوف فرع تاني" });
  }
  try {
    const result = await pool.query(
      `SELECT o.id, o.order_type, o.table_number, o.customer_name, o.customer_phone,
              o.kitchen_status, o.kitchen_accepted_at, o.kitchen_ready_at, o.created_at, o.status,
              COALESCE(
                (SELECT json_agg(json_build_object(
                   'name', COALESCE(mi.name, c.name, 'صنف'),
                   'variant', v.label,
                   'quantity', oi.quantity,
                   'isCombo', oi.combo_id IS NOT NULL,
                   -- المرحلة 8.6: عرض/كومبو كان بيظهر للمطبخ كسطر واحد مبهم ("عرض العيلة") من غير
                   -- تفاصيل الأصناف الفعلية اللي المطبخ محتاج يحضّرها. نفس نمط الـjoin اللي المحاسبة/
                   -- خصم المخزون بيستخدموه أصلًا (combo_items -> menu_item_variants -> menu_items)
                   -- عشان مفيش تكرار لمنطق تفكيك العرض - نفس مصدر الحقيقة
                   'components', CASE WHEN oi.combo_id IS NOT NULL THEN (
                     SELECT json_agg(json_build_object(
                       'name', cmi.name, 'variant', cv.label, 'quantity', ci.quantity * oi.quantity
                     ) ORDER BY ci.id)
                     FROM combo_items ci
                     JOIN menu_item_variants cv ON cv.id = ci.variant_id
                     JOIN menu_items cmi ON cmi.id = cv.item_id
                     WHERE ci.combo_id = oi.combo_id
                   ) ELSE NULL END,
                   'modifiers', COALESCE((
                     SELECT json_agg(oim.name_at_sale ORDER BY oim.id)
                     FROM order_item_modifiers oim WHERE oim.order_item_id = oi.id
                   ), '[]'::json),
                   -- المرحلة 8.10: ملاحظة حرة على السطر + أسماء المكوّنات المستبعدة مباشرة من ريسبي الصنف
                   'notes', oi.notes,
                   'excludedIngredients', COALESCE((
                     SELECT json_agg(ii.name ORDER BY ii.id)
                     FROM order_item_excluded_ingredients oiei
                     JOIN inventory_items ii ON ii.id = oiei.inventory_item_id
                     WHERE oiei.order_item_id = oi.id
                   ), '[]'::json)
                 ) ORDER BY oi.id)
                 FROM order_items oi
                 LEFT JOIN menu_items mi ON mi.id = oi.item_id
                 LEFT JOIN menu_item_variants v ON v.id = oi.variant_id
                 LEFT JOIN combos c ON c.id = oi.combo_id
                 WHERE oi.order_id = o.id),
                '[]'::json
              ) AS items
       FROM orders o
       WHERE o.branch_id = $1 AND o.status <> 'cancelled'
         AND (o.kitchen_status <> 'READY' OR o.kitchen_ready_at >= now() - interval '30 minutes')
       ORDER BY o.created_at ASC
       LIMIT 200`,
      [branchId]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
