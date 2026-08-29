// MASTER MISSION - PART 1: تخطيط تصنيع السنتر كيتشن - راوت قراءة بحت (read-model). مفيش أي endpoint هنا
// بيكتب على المخزون أو المحاسبة أو حتى ينشئ أمر تصنيع - إنشاء الأمر الفعلي بيتم حصريًا عن طريق
// POST /api/production الموجود بالفعل (routes/production.js)، بعد ما الواجهة تعيد استدعاء GET .../plan
// هنا فورًا قبل الإنشاء عشان تتأكد من الرقم لحظة الإرسال (مفيش رقم من المتصفح يتوثق فيه، زي ما اتحدد صراحة)
const express = require("express");
const router = express.Router();
const pool = require("../db/pool");
const { requireAuth, requireRole, assertOwnBranch } = require("../middleware/auth");
const { requirePermission } = require("../middleware/permissions");
const {
  computeProductionPlan, computeRawMaterialRequirement, activeRecipesByItem,
  approvedDemandByItem, pendingSubmittedDemandByItem, generateSuggestedRequisition,
} = require("../db/production-planning");

function isCentralKitchenActor(user) {
  return user.role === "admin" || (user.role === "branch_manager" && user.isCentralKitchen);
}

// كل الـendpoints هنا خاصة بالسنتر كيتشن بس - أدمن (لازم يحدد ckBranchId)، أو مدير فرع السنتر كيتشن نفسه
// (فرعه هو تلقائيًا، مايقدرش يحدد فرع تاني). نفس نمط التفويض المستخدم بالظبط في routes/kitchen-orders.js
// (picking) - مفيش تفويض جديد مخترع
function resolveCkBranchId(req) {
  if (!isCentralKitchenActor(req.user)) return { error: "الشاشة دي للسنتر كيتشن أو الأدمن بس", code: "FORBIDDEN_BRANCH" };
  if (req.user.role === "admin") {
    const ckBranchId = req.query.ckBranchId || req.body?.ckBranchId;
    if (!ckBranchId) return { error: "لازم تحدد فرع السنتر كيتشن (ckBranchId) للأدمن", code: "INVALID_PARAMETER" };
    return { ckBranchId: Number(ckBranchId) };
  }
  return { ckBranchId: req.user.branchId };
}

function todayStr() { return new Date().toISOString().slice(0, 10); }
function resolveWindow(req) {
  const fromDate = req.query.fromDate || todayStr();
  const toDate = req.query.toDate || fromDate;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fromDate) || !/^\d{4}-\d{2}-\d{2}$/.test(toDate)) return { error: "fromDate/toDate لازم يكونوا بصيغة YYYY-MM-DD" };
  if (toDate < fromDate) return { error: "toDate لازم يكون بعد أو يساوي fromDate" };
  return { fromDate, toDate };
}

// GET /api/production-planning/plan?ckBranchId=&fromDate=&toDate= - الخطة الكاملة لكل الأصناف المصنّعة
router.get("/plan", requireAuth, requirePermission("production_planning.view", "production.view"), async (req, res) => {
  const ck = resolveCkBranchId(req);
  if (ck.error) return res.status(ck.code === "INVALID_PARAMETER" ? 400 : 403).json({ error: ck.error, code: ck.code });
  const win = resolveWindow(req);
  if (win.error) return res.status(400).json({ error: win.error, code: "INVALID_PARAMETER" });
  try {
    const plan = await computeProductionPlan(pool, { ckBranchId: ck.ckBranchId, fromDate: win.fromDate, toDate: win.toDate });
    res.json({ ckBranchId: ck.ckBranchId, fromDate: win.fromDate, toDate: win.toDate, plan });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/production-planning/demand?ckBranchId=&fromDate=&toDate= - تفصيل الطلب لكل فرع/صنف (المعتمد
// + لسه في انتظار الاعتماد، منفصلين بوضوح)
router.get("/demand", requireAuth, requirePermission("production_planning.view", "production.view"), async (req, res) => {
  const ck = resolveCkBranchId(req);
  if (ck.error) return res.status(ck.code === "INVALID_PARAMETER" ? 400 : 403).json({ error: ck.error, code: ck.code });
  const win = resolveWindow(req);
  if (win.error) return res.status(400).json({ error: win.error, code: "INVALID_PARAMETER" });
  try {
    const [approved, pending] = await Promise.all([
      approvedDemandByItem(pool, { ckBranchId: ck.ckBranchId, fromDate: win.fromDate, toDate: win.toDate }),
      pendingSubmittedDemandByItem(pool, { ckBranchId: ck.ckBranchId, fromDate: win.fromDate, toDate: win.toDate }),
    ]);
    const itemIds = [...new Set([...approved, ...pending].map((r) => r.inventory_item_id))];
    const namesRes = itemIds.length
      ? await pool.query("SELECT id, name, unit FROM inventory_items WHERE id = ANY($1::int[])", [itemIds])
      : { rows: [] };
    const namesById = new Map(namesRes.rows.map((r) => [r.id, r]));
    const withNames = (rows) => rows.map((r) => ({ ...r, itemName: namesById.get(r.inventory_item_id)?.name || null, unit: namesById.get(r.inventory_item_id)?.unit || null }));
    res.json({ ckBranchId: ck.ckBranchId, fromDate: win.fromDate, toDate: win.toDate, approved: withNames(approved), pending: withNames(pending) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/production-planning/dashboard?ckBranchId=&fromDate=&toDate= - أرقام مجمّعة للوحة التخطيط
router.get("/dashboard", requireAuth, requirePermission("production_planning.view", "production.view"), async (req, res) => {
  const ck = resolveCkBranchId(req);
  if (ck.error) return res.status(ck.code === "INVALID_PARAMETER" ? 400 : 403).json({ error: ck.error, code: ck.code });
  const win = resolveWindow(req);
  if (win.error) return res.status(400).json({ error: win.error, code: "INVALID_PARAMETER" });
  try {
    const plan = await computeProductionPlan(pool, { ckBranchId: ck.ckBranchId, fromDate: win.fromDate, toDate: win.toDate });
    const requiredRows = plan.filter((p) => p.requiredProduction > 0);

    // نقص خامات - بس للأصناف اللي فعلًا محتاجة تصنيع وليها وصفة مباشرة (مش تقديرات التعبئة)
    let shortageCount = 0;
    for (const row of requiredRows) {
      if (!row.recipeVersionId) continue;
      const req2 = await computeRawMaterialRequirement(pool, {
        ckBranchId: ck.ckBranchId, inventoryItemId: row.inventoryItemId, quantity: row.requiredProduction, recipeVersionId: row.recipeVersionId,
      });
      if (req2.raw.some((r) => r.shortage > 0)) shortageCount++;
    }

    const inTransitRes = await pool.query(
      `SELECT COUNT(DISTINCT kt.id)::int AS transfer_count
       FROM kitchen_transfers kt WHERE kt.from_branch_id = $1 AND kt.status = ANY($2::text[])`,
      [ck.ckBranchId, ["issued", "in_transit"]]
    );

    res.json({
      ckBranchId: ck.ckBranchId, fromDate: win.fromDate, toDate: win.toDate,
      totalApprovedDemandItems: plan.filter((p) => p.approvedDemand > 0).length,
      totalRequiredProductionItems: requiredRows.length,
      readyForDistributionItems: plan.filter((p) => p.approvedDemand > 0 && p.requiredProduction === 0).length,
      inProgressItems: plan.filter((p) => p.plannedOrInProgress > 0).length,
      rawMaterialShortageItems: shortageCount,
      transfersInTransit: inTransitRes.rows[0].transfer_count,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/production-planning/raw-materials?ckBranchId=&inventoryItemId=&quantity=&recipeVersionId= -
// احتياج الخام لكمية معيّنة - بيستخدم محرك الوصفات الموجود، مفيش تفجير وصفة في الواجهة خالص
router.get("/raw-materials", requireAuth, requirePermission("production_planning.view", "production.view"), async (req, res) => {
  const ck = resolveCkBranchId(req);
  if (ck.error) return res.status(ck.code === "INVALID_PARAMETER" ? 400 : 403).json({ error: ck.error, code: ck.code });
  const inventoryItemId = Number(req.query.inventoryItemId);
  const quantity = Number(req.query.quantity);
  const recipeVersionId = req.query.recipeVersionId ? Number(req.query.recipeVersionId) : null;
  if (!inventoryItemId || !quantity || quantity <= 0) {
    return res.status(400).json({ error: "لازم تحدد صنف وكمية أكبر من صفر", code: "INVALID_PARAMETER" });
  }
  try {
    const result = await computeRawMaterialRequirement(pool, { ckBranchId: ck.ckBranchId, inventoryItemId, quantity, recipeVersionId });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/production-planning/forecast?ckBranchId=&branchId=&targetDate=&nextReplenishmentDate= - معاينة
// استرشادية بس لتوقع طلب فرع واحد بناءً على تاريخ الاستهلاك - نفس db/requisition-suggestion.js حرفيًا
// (نفس الدالة المستخدمة في GET /api/kitchen-orders/suggested)، من غير أي إعادة تنفيذ. عمدًا بيتطلب
// branchId واحد في كل استدعاء (مش كل الفروع مرة واحدة) عشان الاستعلام يفضل رخيص ومحدود
router.get("/forecast", requireAuth, requirePermission("production_planning.view", "production.view"), async (req, res) => {
  const ck = resolveCkBranchId(req);
  if (ck.error) return res.status(ck.code === "INVALID_PARAMETER" ? 400 : 403).json({ error: ck.error, code: ck.code });
  const { branchId, targetDate, nextReplenishmentDate } = req.query;
  if (!branchId || !targetDate) return res.status(400).json({ error: "لازم تحدد branchId و targetDate", code: "INVALID_PARAMETER" });
  try {
    const suggestions = await generateSuggestedRequisition(pool, {
      branchId: Number(branchId), targetDate, nextReplenishmentDate: nextReplenishmentDate || null,
    });
    res.json({ branchId: Number(branchId), targetDate, suggestions: suggestions.filter((s) => s.suggestedQuantity > 0) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
