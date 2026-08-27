// صلاحيات دقيقة لكل دور - إضافة فوق نظام requireRole الحالي (auth.js)، مش بديل له.
// requireRole بيتحقق من اسم الدور بس؛ requirePermission بيتحقق من إجراء محدد، عشان نقدر نوسّع
// صلاحيات دور معيّن (زي محاسب يشوف طلبات الموافقة) من غير ما نلمس أي route قديم شغال بـ requireRole.
const ROLE_PERMISSIONS = {
  admin: ["*"],
  branch_manager: [
    "orders.discount.approve", "orders.void.approve", "orders.cancel",
    "inventory.view", "inventory.adjust", "inventory.count",
    "recipes.view", "recipes.create", "recipes.edit", "recipes.submit",
    "production.view", "production.create", "production.complete", "production.cancel",
    "food_cost.view",
    "expenses.view", "purchases.view",
    // المرحلة 7K: مدير الفرع/المحاسب هما اللي بيراجعوا مصروفات/مشتريات الكاشير النقدية قبل ما تتحسب
    // رسميًا - "إصدار" (مراجعة) منفصل عن "تسجيل" (الكاشير) عمدًا، زي ما اتحدد صراحة
    "expenses.create", "expenses.review", "purchases.create", "purchases.review",
    // المرحلة 4A: مدير فرع/سنتر كيتشن يقدر ينشئ/يعدّل/يقدّم طلبات شراء وأوامر شراء لفرعه ويلغيها - بس
    // مش يعتمدها (purchasing.approve أدمن بس عمدًا، زي recipes.approve/production.approve بالظبط -
    // "الشخص اللي بينشئ PO ميقدرش يعتمدها لوحده من غير صلاحية منفصلة")
    "purchasing.view", "purchasing.create", "purchasing.edit", "purchasing.submit", "purchasing.cancel",
    "users.view",
    "approvals.create", "approvals.decide",
    "audit.view.branch",
    // المرحلة 4B: رؤية مالية تشغيلية لفرعه بس - مفيش تعديل على قيد مرحّل ولا قفل شهر خالص (زي ما اتحدد صراحة)
    "accounting.view",
    // المرحلة 7E: مدير الفرع بيقدر كمان يفتح/يقفل شيفت لنفسه (لو بيغطي الكاشير بنفسه في فروع صغيرة)،
    // وهو صاحب صلاحية مراجعة فروق الكاش (اعتماد/رفض) وقفل يوم الفرع - الاتنين دول مش متاحين للكاشير خالص
    "shifts.open_own", "shifts.view_own", "shifts.close_own",
    "shifts.view_branch", "shifts.review", "branch_day.view", "branch_day.close",
    // المرحلة 7F: مدير الفرع هو صاحب لوحة التوزيع (تعيين/إعادة تعيين سائق)، بيدير بيانات سائقي فرعه
    // (نفس نمط إدارة الموظفين HR في المرحلة 4D)، وهو صاحب صلاحية تسوية كاش السائقين ومراجعة فروقها
    "deliveries.view_branch", "deliveries.assign", "drivers.manage",
    "driver_settlements.create", "driver_settlements.review",
    // المرحلة 7G: مدير الفرع يشوف شاشة المطبخ (KDS) بتاعة فرعه ويقدر يقدّم حالة أي طلب فيها -
    // مش مقصور على الكاشير بس، لأن مدير الفرع كتير بيغطي المطبخ برضو في فروع صغيرة
    "kitchen.view", "kitchen.advance",
  ],
  accountant: [
    "inventory.view", "recipes.view",
    "production.view",
    "food_cost.view", "food_cost.export",
    "expenses.view", "purchases.view",
    // المرحلة 7K: نفس صلاحية مراجعة مصروفات/مشتريات الكاشير النقدية اللي عند مدير الفرع
    "expenses.create", "expenses.review", "purchases.create", "purchases.review",
    "purchasing.view", "purchasing.export",
    "approvals.create",
    "audit.view.branch",
    // المرحلة 4B: إنشاء/تعديل/اعتماد/ترحيل + تقارير - بدون عكس قيود (accounting.reverse) ولا قفل شهر
    // (accounting.close_period) - الاتنين دول أدمن بس عمدًا (زي ما اتحدد صراحة في المواصفات)
    "accounting.view", "accounting.create", "accounting.edit", "accounting.approve", "accounting.post", "accounting.export",
    // المرحلة 7E: المحاسب بيراجع/يحقق في فروق الكاش عبر الفروع (رؤية + مراجعة)، بس مش هو اللي بيقفل
    // يوم الفرع فعليًا (ده قرار تشغيلي لمدير الفرع، مش مالي بحت)
    "shifts.view_branch", "shifts.review", "branch_day.view",
    // المرحلة 7F: نفس منطق مراجعة فروق الشيفت بالظبط - المحاسب يراجع فروق تسليم كاش السائقين، بس
    // مش هو اللي بيبدأ التسوية نفسها (ده قرار تشغيلي لمدير الفرع لحظة استلام الكاش فعليًا)
    "deliveries.view_branch", "driver_settlements.review",
  ],
  cashier: [
    "orders.create", "orders.discount.request", "orders.void.request",
    "approvals.create",
    // المرحلة 7E: الكاشير بيفتح/يشوف/يقفل شيفته هو بس - مفيش صلاحية يشوف شيفتات زمايله ولا يراجع فروق كاش
    "shifts.open_own", "shifts.view_own", "shifts.close_own",
    // المرحلة 7K: الكاشير يقدر يسجّل مصروف/مشترى نقدي لفرعه بس واليوم بس (مقفول من جوه الراوت نفسه،
    // مش بس بالصلاحية) - لكن معندوش صلاحية "الإصدار" (expenses.review/purchases.review) خالص، ده
    // للمدير/المحاسب بس عمدًا عشان يراجعوا قبل ما تتحسب رسميًا
    "expenses.create_own_daily", "expenses.view_own_daily",
    "purchases.create_own_daily", "purchases.view_own_daily",
    // المرحلة 7G: الكاشير بيشوف شاشة المطبخ (KDS) بتاعة فرعه ويقدّم حالة الطلبات - هو أكتر حد
    // بيستخدمها فعليًا (واقف عند نقطة البيع/المطبخ في الفروع الصغيرة)
    "kitchen.view", "kitchen.advance",
  ],
  callcenter: [
    "orders.create", "orders.discount.request", "orders.void.request",
    "approvals.create",
  ],
  // المرحلة 7F: السائق أضيق دور في النظام عمدًا - طلباته المُسندة له بس (deliveries.view_own/update_own،
  // مقفولة كمان على مستوى الكود بمطابقة drivers.user_id مع req.user.id، مش الصلاحية دي بس)، وسجل
  // تسوياته الخاصة. مفيش أي وصول لمحاسبة/مخزون/رواتب/فروع تانية/عملاء خالص - غير اللي محتاجه بالظبط
  // عشان يوصّل الطلب (اسم/تليفون/عنوان العميل، ظاهرين أصلًا جوه تفاصيل الطلب المُسند له نفسه)
  driver: [
    "deliveries.view_own", "deliveries.update_own", "driver_settlements.view_own",
  ],
  // المرحلة 7T: نفس فلسفة driver بالظبط - أضيق دور، بياناته الخاصة بس (مقفولة كمان على مستوى الكود
  // بمطابقة employees.user_id مع req.user.id في routes/employee-self.js). مفيش أي وصول لبيانات موظفين
  // تانيين أو أي جزء تاني من النظام - قسائم راتبه وطلبات إجازته بس
  employee: [
    "payslips.view_own", "leave_requests.manage_own",
  ],
};

function hasPermission(role, permission) {
  const perms = ROLE_PERMISSIONS[role] || [];
  return perms.includes("*") || perms.includes(permission);
}

// يقبل أكتر من صلاحية - يكفي إن الدور يملك واحدة منهم (OR)
function requirePermission(...permissions) {
  return (req, res, next) => {
    const role = req.user?.role;
    if (!role || !permissions.some((p) => hasPermission(role, p))) {
      return res.status(403).json({ error: "معندكش صلاحية تعمل الإجراء ده" });
    }
    next();
  };
}

module.exports = { ROLE_PERMISSIONS, hasPermission, requirePermission };
