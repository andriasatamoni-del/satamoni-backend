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
    "users.view",
    "approvals.create", "approvals.decide",
    "audit.view.branch",
  ],
  accountant: [
    "inventory.view", "recipes.view",
    "production.view",
    "food_cost.view", "food_cost.export",
    "expenses.view", "purchases.view",
    "approvals.create",
    "audit.view.branch",
  ],
  cashier: [
    "orders.create", "orders.discount.request", "orders.void.request",
    "approvals.create",
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
