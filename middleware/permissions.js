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
  ],
  accountant: [
    "inventory.view", "recipes.view",
    "production.view",
    "food_cost.view", "food_cost.export",
    "expenses.view", "purchases.view",
    "purchasing.view", "purchasing.export",
    "approvals.create",
    "audit.view.branch",
    // المرحلة 4B: إنشاء/تعديل/اعتماد/ترحيل + تقارير - بدون عكس قيود (accounting.reverse) ولا قفل شهر
    // (accounting.close_period) - الاتنين دول أدمن بس عمدًا (زي ما اتحدد صراحة في المواصفات)
    "accounting.view", "accounting.create", "accounting.edit", "accounting.approve", "accounting.post", "accounting.export",
    // المرحلة 7E: المحاسب بيراجع/يحقق في فروق الكاش عبر الفروع (رؤية + مراجعة)، بس مش هو اللي بيقفل
    // يوم الفرع فعليًا (ده قرار تشغيلي لمدير الفرع، مش مالي بحت)
    "shifts.view_branch", "shifts.review", "branch_day.view",
  ],
  cashier: [
    "orders.create", "orders.discount.request", "orders.void.request",
    "approvals.create",
    // المرحلة 7E: الكاشير بيفتح/يشوف/يقفل شيفته هو بس - مفيش صلاحية يشوف شيفتات زمايله ولا يراجع فروق كاش
    "shifts.open_own", "shifts.view_own", "shifts.close_own",
  ],
  callcenter: [
    "orders.create", "orders.discount.request", "orders.void.request",
    "approvals.create",
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
