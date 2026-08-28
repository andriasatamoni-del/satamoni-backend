const express = require("express");
const router = express.Router();
const pool = require("../db/pool");
const { requireAuth, requireRole, assertOwnBranch } = require("../middleware/auth");
const { requirePermission } = require("../middleware/permissions");
const { logAudit } = require("../db/audit");
const { postInventoryMovement } = require("../db/inventory-ledger");
const { postJournalEntry, getAccountByCode, getOrCreateBranchCashAccount } = require("../db/accounting-engine");
const { validateIdParam } = require("../middleware/validate-id-param");

const canManage = requireRole("admin", "accountant", "branch_manager");

// المرحلة 8.6: نفس التحقق من routes/orders.js (المرحلة 8B) - :id لازم يكون رقم صحيح، وإلا 400 واضح
// بدل ما استعلام SQL يرمي خطأ Postgres خام (invalid input syntax) كـ500
router.param("id", validateIdParam);

// المرحلة 8.6: ترحيل بنود مشترى (لو موجودة) للمخزون + المحاسبة - نقطة الترحيل الوحيدة، بتتنفّذ مرة
// واحدة بس جوه transaction القفل بتاع /:id/confirm (أو مباشرة وقت الإنشاء لو المشترى اتسجل CONFIRMED
// من الأول زي مدير الفرع/المحاسب). نفس بالظبط الأدوات اللي GRN بيستخدمها (postInventoryMovement +
// postJournalEntry) - مفيش آلية مخزون تانية موازية. مشترى من غير بنود (amount حر زي الأول) مبيلمسش
// المخزون خالص وبيفضل زي ما كان قبل المرحلة دي
async function postPurchaseToInventory(client, purchase, userId, req) {
  const itemsRes = await client.query(
    `SELECT pi.*, ii.unit AS stock_unit FROM purchase_items pi
     JOIN inventory_items ii ON ii.id = pi.inventory_item_id
     WHERE pi.purchase_id = $1`,
    [purchase.id]
  );
  if (itemsRes.rows.length === 0) return;

  let totalValue = 0;
  for (const item of itemsRes.rows) {
    const { movement } = await postInventoryMovement(client, {
      branchId: purchase.branch_id, inventoryItemId: item.inventory_item_id, quantity: Number(item.quantity),
      movementType: "PURCHASE_RECEIPT", referenceType: "purchase", referenceId: purchase.id,
      unit: item.stock_unit, unitCost: Number(item.unit_price), userId,
      idempotencyKey: `purchase-item-${item.id}`,
    });
    if (movement.total_cost != null) totalValue += Number(movement.total_cost);
    else totalValue += Number(item.line_total);
  }

  if (totalValue > 0) {
    const inventoryAccount = await getAccountByCode(client, "1400");
    const cashAccount = await getOrCreateBranchCashAccount(client, purchase.branch_id);
    await postJournalEntry(client, {
      entryDate: new Date().toISOString().slice(0, 10), description: `مشترى نقدي - فاتورة #${purchase.id}`,
      sourceType: "purchase", sourceId: purchase.id, branchId: purchase.branch_id,
      lines: [
        { accountId: inventoryAccount.id, debit: totalValue },
        { accountId: cashAccount.id, credit: totalValue },
      ],
      idempotencyKey: `purchase-confirm-${purchase.id}`, userId,
    });
  }

  await client.query("UPDATE purchases SET posted_to_inventory = TRUE WHERE id = $1", [purchase.id]);
  await logAudit(client, {
    branchId: purchase.branch_id, userId, action: "PURCHASE_POSTED_TO_INVENTORY", entityType: "purchase",
    entityId: purchase.id, newValues: { itemCount: itemsRes.rows.length, totalValue }, req,
  });
}

// GET /api/purchases?branchId=&date=&status= - الكاشير (المرحلة 7K) يشوف مشتريات فرعه بس، زي مدير الفرع بالظبط
router.get(
  "/",
  requireAuth,
  requirePermission("purchases.view", "purchases.view_own_daily"),
  async (req, res) => {
    let { branchId, date, status } = req.query;
    if (req.user.role === "branch_manager" || req.user.role === "cashier") {
      if (branchId && !assertOwnBranch(req.user, branchId)) {
        return res.status(403).json({ error: "معندكش صلاحية تشوف مشتريات فرع تاني" });
      }
      branchId = req.user.branchId;
    }
    try {
      const result = await pool.query(
        `SELECT * FROM purchases
         WHERE ($1::int IS NULL OR branch_id = $1)
           AND ($2::date IS NULL OR business_date = $2)
           AND ($3::text IS NULL OR status = $3)
         ORDER BY business_date DESC, id DESC`,
        [branchId || null, date || null, status || null]
      );
      res.json(result.rows);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

// المرحلة 8.6: GET /api/purchases/:id - تفاصيل مشترى واحد + بنوده (لو فاتورة مواد خام) - لشاشة
// المراجعة (مدير/محاسب) وللكاشير يشوف تفاصيل مشتريات فرعه بس
router.get(
  "/:id",
  requireAuth,
  requirePermission("purchases.view", "purchases.view_own_daily"),
  async (req, res) => {
    try {
      const purchaseRes = await pool.query("SELECT * FROM purchases WHERE id = $1", [req.params.id]);
      if (purchaseRes.rows.length === 0) return res.status(404).json({ error: "المشترى مش موجود" });
      const purchase = purchaseRes.rows[0];
      if ((req.user.role === "branch_manager" || req.user.role === "cashier") && !assertOwnBranch(req.user, purchase.branch_id)) {
        return res.status(403).json({ error: "معندكش صلاحية تشوف مشتريات فرع تاني" });
      }
      const itemsRes = await pool.query(
        `SELECT pi.*, ii.name AS item_name FROM purchase_items pi
         JOIN inventory_items ii ON ii.id = pi.inventory_item_id
         WHERE pi.purchase_id = $1 ORDER BY pi.id`,
        [req.params.id]
      );
      res.json({ ...purchase, items: itemsRes.rows });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

// POST /api/purchases - تسجيل مشترى (فرع أو سنتر كيتشن)
//
// المرحلة 7K: الكاشير (purchases.create_own_daily بس) بيقدر يسجل مشترى نقدي - مقفول بالكامل على
// فرعه/النهاردة بس (مفروضة من السيرفر، مش من العميل)، وحالته دايمًا PENDING (محتاج مراجعة مدير/محاسب
// عبر /:id/confirm أو /:id/reject قبل ما يتحسب رسميًا في التقارير المالية). المدير/المحاسب لسه بيسجلوا
// مباشرة CONFIRMED زي الأول بالظبط - مفيش تغيير في سلوكهم
//
// المرحلة 8.6: items اختياري - فاتورة مواد خام حقيقية (اسم المادة الخام لازم يكون موجود فعلاً في
// inventory_items وnوعها 'raw'، الكاشير میقدرش يكتب صنف جديد). الإجمالي (amount) بيتحسب من السيرفر
// من سطور الأصناف نفسها لو موجودة - مش بياخده زي ما هو من العميل - عشان محدش يقدر يلاعب فيه
router.post(
  "/",
  requireAuth,
  requirePermission("purchases.create", "purchases.create_own_daily"),
  async (req, res) => {
    const isCashierDaily = req.user.role === "cashier";
    let { branchId, businessDate, category, amount, fromKitchen = false, notes, items } = req.body;

    if (isCashierDaily) {
      branchId = req.user.branchId;
      businessDate = new Date().toISOString().slice(0, 10);
      fromKitchen = false;
    }

    const hasItems = Array.isArray(items) && items.length > 0;
    if (hasItems) {
      for (const it of items) {
        if (!it || !Number.isInteger(Number(it.inventoryItemId)) || !(Number(it.quantity) > 0) || !(Number(it.unitPrice) >= 0)) {
          return res.status(400).json({ error: "بيانات بند المشترى غير صحيحة" });
        }
      }
    }

    if (!branchId || !businessDate || (!hasItems && !amount)) {
      return res.status(400).json({ error: "بيانات ناقصة" });
    }
    if (req.user.role === "branch_manager" && !assertOwnBranch(req.user, branchId)) {
      return res.status(403).json({ error: "معندكش صلاحية تسجل مشترى على فرع تاني" });
    }
    const status = isCashierDaily ? "PENDING" : "CONFIRMED";

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      let computedAmount = amount || 0;
      let validatedItems = [];
      if (hasItems) {
        const ids = items.map((it) => Number(it.inventoryItemId));
        const catalog = await client.query(
          `SELECT id, name, unit FROM inventory_items WHERE id = ANY($1::int[]) AND item_type = 'raw'`,
          [ids]
        );
        const catalogById = new Map(catalog.rows.map((r) => [r.id, r]));
        computedAmount = 0;
        for (const it of items) {
          const invItem = catalogById.get(Number(it.inventoryItemId));
          if (!invItem) {
            await client.query("ROLLBACK");
            return res.status(400).json({ error: "مادة خام غير موجودة في الكتالوج - الكاشير میقدرش يسجل صنف جديد" });
          }
          const lineTotal = Number(it.quantity) * Number(it.unitPrice);
          computedAmount += lineTotal;
          validatedItems.push({ inventoryItemId: invItem.id, quantity: Number(it.quantity), unit: invItem.unit, unitPrice: Number(it.unitPrice), lineTotal });
        }
      }

      const result = await client.query(
        `INSERT INTO purchases (branch_id, business_date, category, amount, from_kitchen, notes, status, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
        [branchId, businessDate, category || (hasItems ? "مواد خام" : null), computedAmount, fromKitchen, notes || null, status, req.user.id]
      );
      const purchase = result.rows[0];

      for (const it of validatedItems) {
        await client.query(
          `INSERT INTO purchase_items (purchase_id, inventory_item_id, quantity, unit, unit_price, line_total)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [purchase.id, it.inventoryItemId, it.quantity, it.unit, it.unitPrice, it.lineTotal]
        );
      }

      await logAudit(client, {
        branchId, userId: req.user.id, action: "PURCHASE_CREATED", entityType: "purchase", entityId: purchase.id,
        newValues: { amount: computedAmount, category, status, itemCount: validatedItems.length }, req,
      });

      // مشترى بنود اتسجل مباشرة CONFIRMED (مدير/محاسب) - يترحّل فورًا نفس لحظة الإنشاء، زي ما لو
      // كان اتأكّد فورًا. مشترى الكاشير (PENDING) بيستنى /:id/confirm - الترحيل مش بيحصل قبل المراجعة
      let finalPurchase = purchase;
      if (status === "CONFIRMED" && validatedItems.length > 0) {
        await postPurchaseToInventory(client, purchase, req.user.id, req);
        const refreshed = await client.query("SELECT * FROM purchases WHERE id = $1", [purchase.id]);
        finalPurchase = refreshed.rows[0];
      }

      await client.query("COMMIT");
      res.status(201).json(finalPurchase);
    } catch (err) {
      await client.query("ROLLBACK");
      res.status(500).json({ error: err.message });
    } finally {
      client.release();
    }
  }
);

// المرحلة 7K: POST /api/purchases/:id/confirm - PENDING → CONFIRMED - مدير الفرع/المحاسب بيراجع
// مشترى الكاشير النقدي ويأكّده - بعدها بس بيتحسب رسميًا في تقارير المشتريات/تحليل التكلفة
//
// المرحلة 7U: قبل كده كانت القراءة والتحديث في نداءين منفصلين من غير أي قفل (زي purchase_returns.js/
// expenses.js/driver_settlements.js بالظبط اللي بيستخدموا BEGIN + SELECT...FOR UPDATE) - يعني نافذة
// سباق حقيقية: confirm وreject متزامنين (أو confirm مرتين) كانوا يقدروا الاتنين يعدّوا فحص "لسه PENDING"
// قبل ما أي حد يكتب، فالاتنين ينجحوا (200) والنتيجة النهائية تبقى عشوائية حسب مين كتب أخيرًا - اتكشفت
// وثبتت بتدقيق 7U (tests/phase7u-audit.test.js)، مصلّحة هنا بنفس نمط الأقفال المستخدم في كل مكان تاني
//
// المرحلة 8.6: نفس الـFOR UPDATE ده هو اللي بيضمن إن ترحيل المخزون (postPurchaseToInventory) هيحصل
// مرة واحدة بالظبط حتى لو /:id/confirm اتنادى بالتوازي أكتر من مرة على نفس الفاتورة - الترحيل بيحصل
// جوه نفس الـtransaction بعد ما الحالة تتغيّر لـCONFIRMED بنجاح
router.post("/:id/confirm", requireAuth, requirePermission("purchases.review"), async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const existing = await client.query("SELECT * FROM purchases WHERE id = $1 FOR UPDATE", [req.params.id]);
    if (existing.rows.length === 0) { await client.query("ROLLBACK"); return res.status(404).json({ error: "المشترى مش موجود" }); }
    const purchase = existing.rows[0];
    if (purchase.status !== "PENDING") { await client.query("ROLLBACK"); return res.status(400).json({ error: "المشترى ده مش في حالة انتظار مراجعة" }); }
    if (req.user.role === "branch_manager" && !assertOwnBranch(req.user, purchase.branch_id)) {
      await client.query("ROLLBACK");
      return res.status(403).json({ error: "معندكش صلاحية على فرع تاني" });
    }

    const result = await client.query(
      "UPDATE purchases SET status = 'CONFIRMED', reviewed_by = $1, reviewed_at = now() WHERE id = $2 RETURNING *",
      [req.user.id, req.params.id]
    );
    await logAudit(client, {
      branchId: purchase.branch_id, userId: req.user.id, action: "PURCHASE_CONFIRMED", entityType: "purchase", entityId: purchase.id, req,
    });

    await postPurchaseToInventory(client, result.rows[0], req.user.id, req);
    const finalPurchase = await client.query("SELECT * FROM purchases WHERE id = $1", [req.params.id]);

    await client.query("COMMIT");
    res.json(finalPurchase.rows[0]);
  } catch (err) {
    await client.query("ROLLBACK");
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// POST /api/purchases/:id/reject - PENDING → REJECTED - نفس صلاحية التأكيد، مع سبب اختياري
router.post("/:id/reject", requireAuth, requirePermission("purchases.review"), async (req, res) => {
  const { reason } = req.body;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const existing = await client.query("SELECT * FROM purchases WHERE id = $1 FOR UPDATE", [req.params.id]);
    if (existing.rows.length === 0) { await client.query("ROLLBACK"); return res.status(404).json({ error: "المشترى مش موجود" }); }
    const purchase = existing.rows[0];
    if (purchase.status !== "PENDING") { await client.query("ROLLBACK"); return res.status(400).json({ error: "المشترى ده مش في حالة انتظار مراجعة" }); }
    if (req.user.role === "branch_manager" && !assertOwnBranch(req.user, purchase.branch_id)) {
      await client.query("ROLLBACK");
      return res.status(403).json({ error: "معندكش صلاحية على فرع تاني" });
    }

    const result = await client.query(
      "UPDATE purchases SET status = 'REJECTED', reviewed_by = $1, reviewed_at = now(), rejection_reason = $2 WHERE id = $3 RETURNING *",
      [req.user.id, reason || null, req.params.id]
    );
    await logAudit(client, {
      branchId: purchase.branch_id, userId: req.user.id, action: "PURCHASE_REJECTED", entityType: "purchase", entityId: purchase.id,
      metadata: { reason }, req,
    });
    await client.query("COMMIT");
    res.json(result.rows[0]);
  } catch (err) {
    await client.query("ROLLBACK");
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

module.exports = router;
