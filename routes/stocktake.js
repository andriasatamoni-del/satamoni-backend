// المرحلة 8.58: جرد فعلي (Spot Check) - شاشة الأصناف. تدخل الكمية الحقيقية اللي عددتها لخامة واحدة
// أو أكتر، والسيستم بيحسب الفرق فورًا (قبل أي حفظ - راجع /preview) مع قيمته المالية وأسباب مقترحة،
// وبعدين تأكيد الجرد (/POST) بيسجّل الفرق فعليًا زي /api/inventory/reconcile بالظبط (STOCK_COUNT +
// قيد 5300/1400) - إلا لو اخترت تحمّل عجز معيّن كسلفة على موظف بعينه بدل حساب محاسبي عادي (نفس آلية
// عجز شيفت الكاشير - db/shift-engine.js). الخامات اللي الفرق فيها صفر مش بتتسجل كسطر خالص.
const express = require("express");
const router = express.Router();
const pool = require("../db/pool");
const { requireAuth, assertOwnBranch } = require("../middleware/auth");
const { requirePermission } = require("../middleware/permissions");
const { logAudit } = require("../db/audit");
const { postInventoryMovement } = require("../db/inventory-ledger");
const { postJournalEntry, getAccountByCode, getOrCreateEmployeeReceivableAccount } = require("../db/accounting-engine");
const { validateIdParam } = require("../middleware/validate-id-param");

router.use(requireAuth);
router.param("id", validateIdParam);
router.param("lineId", validateIdParam);

// أسباب مقترحة (توثيق سريع، مش تصنيف مقفول - الحقل reason نص حر برضو) - مقسّمة حسب اتجاه الفرق لأن
// سبب "تلف" منطقي للعجز بس، وسبب "جرد سابق ناقص" منطقي للزيادة بس
const SHORTAGE_REASONS = [
  "تلف/كسر أثناء التخزين أو التحضير", "انتهاء الصلاحية", "سرقة أو فقد",
  "استخدام أكتر من الكمية القياسية في الوصفة", "خطأ في وحدة القياس أو التحويل",
  "نقل لفرع تاني لسه ما اتسجلش", "خطأ في تسجيل كمية شراء سابقة",
];
const SURPLUS_REASONS = [
  "جرد سابق كان ناقص (كمية مسجّلة أقل من الحقيقي)", "استلام كمية زيادة عن الفاتورة من المورد",
  "نقل من فرع تاني لسه ما اتسجلش", "خطأ في وحدة القياس أو التحويل",
];

// GET /api/stocktake/board?branchId= - كل الخامات مع رصيد النظام الحالي (لعرض خامة واحدة أو الكل)
router.get("/board", requirePermission("inventory.view"), async (req, res) => {
  const branchId = req.query.branchId || req.user.branchId;
  if (!branchId) return res.status(400).json({ error: "لازم تحدد الفرع" });
  if (!assertOwnBranch(req.user, branchId)) {
    return res.status(403).json({ error: "معندكش صلاحية تشوف مخزون فرع تاني" });
  }
  try {
    const result = await pool.query(
      `SELECT ii.id, ii.name, ii.unit, ii.unit_cost, ii.item_type,
              COALESCE(bis.quantity, 0) AS system_quantity
       FROM inventory_items ii
       LEFT JOIN branch_inventory_stock bis ON bis.inventory_item_id = ii.id AND bis.branch_id = $1
       ORDER BY ii.name`,
      [branchId]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/stocktake/preview - {branchId, items: [{inventoryItemId, actualQuantity}]} - حساب الفروق
// وقيمتها والأسباب المقترحة من غير أي تسجيل - عشان تشوف النتيجة قبل ما تأكّد الجرد
router.post("/preview", requirePermission("inventory.count"), async (req, res) => {
  const { branchId, items } = req.body;
  if (!branchId || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: "بيانات ناقصة" });
  }
  if (!assertOwnBranch(req.user, branchId)) {
    return res.status(403).json({ error: "معندكش صلاحية على مخزون فرع تاني" });
  }
  try {
    const itemIds = items.map((it) => it.inventoryItemId);
    const rows = await pool.query(
      `SELECT ii.id, ii.name, ii.unit, ii.unit_cost, COALESCE(bis.quantity, 0) AS system_quantity
       FROM inventory_items ii
       LEFT JOIN branch_inventory_stock bis ON bis.inventory_item_id = ii.id AND bis.branch_id = $1
       WHERE ii.id = ANY($2::int[])`,
      [branchId, itemIds]
    );
    const byId = new Map(rows.rows.map((r) => [r.id, r]));
    const result = items.map((it) => {
      const item = byId.get(Number(it.inventoryItemId));
      if (!item) return { inventoryItemId: it.inventoryItemId, error: "الصنف مش موجود" };
      const systemQuantity = Number(item.system_quantity);
      const actualQuantity = Number(it.actualQuantity);
      const varianceQuantity = Math.round((actualQuantity - systemQuantity) * 1000) / 1000;
      const unitCost = item.unit_cost != null ? Number(item.unit_cost) : null;
      const varianceValue = unitCost != null ? Math.round(varianceQuantity * unitCost * 100) / 100 : null;
      return {
        inventoryItemId: item.id, name: item.name, unit: item.unit,
        systemQuantity, actualQuantity, varianceQuantity, unitCost, varianceValue,
        suggestedReasons: varianceQuantity < 0 ? SHORTAGE_REASONS : varianceQuantity > 0 ? SURPLUS_REASONS : [],
        canChargeEmployee: varianceQuantity < 0,
      };
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/stocktake - {branchId, notes?, lines: [{inventoryItemId, actualQuantity, reason?,
// chargeType?: 'account'|'employee', chargeAccountCode?, chargeEmployeeId?}]} - تأكيد الجرد وتسجيله
// فعليًا. سطور الفرق = صفر بتتجاهل تمامًا (مش بتتسجل). chargeType='employee' مسموح للعجز بس - الزيادة
// مالهاش "مسؤول" يتحمّلها، دايمًا بترحّل لحساب محاسبي (زيادة تخصم 5300/تزوّد 1400 - نفس منطق reconcile)
router.post("/", requirePermission("inventory.count"), async (req, res) => {
  const { branchId, notes, lines, idempotencyKey } = req.body;
  if (!branchId || !Array.isArray(lines) || lines.length === 0) {
    return res.status(400).json({ error: "بيانات ناقصة" });
  }
  if (!assertOwnBranch(req.user, branchId)) {
    return res.status(403).json({ error: "معندكش صلاحية تعدّل مخزون فرع تاني" });
  }
  for (const line of lines) {
    if (!line.inventoryItemId || line.actualQuantity === undefined || line.actualQuantity === null || Number(line.actualQuantity) < 0) {
      return res.status(400).json({ error: "بيانات سطر جرد ناقصة أو الكمية غير صالحة" });
    }
    if (line.chargeType && !["account", "employee"].includes(line.chargeType)) {
      return res.status(400).json({ error: "نوع تحميل غير معروف" });
    }
    if (line.chargeType === "employee" && !line.chargeEmployeeId) {
      return res.status(400).json({ error: "لازم تحدد الموظف اللي هيتحمّل العجز" });
    }
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // المرحلة 9A-6: لو العميل بعت نفس الطلب مرتين (retry شبكة/دبل كليك) بنفس المفتاح، بيرجّع نفس جلسة
    // الجرد الأصلية بسطورها من غير ما يعيد التسجيل (فرق مضاعف + قيد محاسبي مضاعف). الفحص هنا قبل أي
    // شغل تاني عشان الطلب المكرر يترد بسرعة من غير ما يعيد قفل/معالجة كل سطر تاني
    if (idempotencyKey) {
      const existing = await client.query("SELECT id FROM stocktakes WHERE idempotency_key = $1", [idempotencyKey]);
      if (existing.rows.length > 0) {
        await client.query("ROLLBACK");
        const existingId = existing.rows[0].id;
        const headerRes = await pool.query("SELECT * FROM stocktakes WHERE id = $1", [existingId]);
        const linesRes = await pool.query("SELECT * FROM stocktake_lines WHERE stocktake_id = $1 ORDER BY id", [existingId]);
        return res.status(200).json({
          id: existingId, branchId: headerRes.rows[0].branch_id,
          totalVarianceValue: Number(headerRes.rows[0].total_variance_value), lines: linesRes.rows, duplicate: true,
        });
      }
    }

    const stocktakeRes = await client.query(
      `INSERT INTO stocktakes (branch_id, created_by, notes, idempotency_key) VALUES ($1, $2, $3, $4) RETURNING id`,
      [branchId, req.user.id, notes || null, idempotencyKey || null]
    );
    const stocktakeId = stocktakeRes.rows[0].id;

    const savedLines = [];
    let totalVarianceValue = 0;

    for (const line of lines) {
      await client.query(
        `INSERT INTO branch_inventory_stock (branch_id, inventory_item_id, quantity)
         VALUES ($1, $2, 0) ON CONFLICT (branch_id, inventory_item_id) DO NOTHING`,
        [branchId, line.inventoryItemId]
      );
      const current = await client.query(
        "SELECT quantity FROM branch_inventory_stock WHERE branch_id = $1 AND inventory_item_id = $2 FOR UPDATE",
        [branchId, line.inventoryItemId]
      );
      const systemQuantity = Number(current.rows[0].quantity);
      const actualQuantity = Number(line.actualQuantity);
      const varianceQuantity = Math.round((actualQuantity - systemQuantity) * 1000) / 1000;
      if (varianceQuantity === 0) continue; // الرصيد مطابق - مفيش سطر يتسجل

      if (varianceQuantity > 0 && line.chargeType === "employee") {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "زيادة الجرد مالهاش موظف يتحمّلها - بس تترحّل لحساب محاسبي" });
      }

      const stocktakeNote = `جرد فعلي #${stocktakeId}: كان ${systemQuantity}، الفعلي ${actualQuantity}` + (line.reason ? ` - ${line.reason}` : "");
      const { movement } = await postInventoryMovement(client, {
        branchId, inventoryItemId: line.inventoryItemId, quantity: varianceQuantity, movementType: "STOCK_COUNT",
        notes: stocktakeNote, userId: req.user.id, negativeStockOverrideApproved: true,
      });
      const unitCost = movement.unit_cost != null ? Number(movement.unit_cost) : null;
      const varianceValue = unitCost != null ? Math.round(varianceQuantity * unitCost * 100) / 100 : null;

      const chargeType = varianceValue && varianceValue !== 0 ? (line.chargeType || "account") : null;
      let chargeAccountCode = null;
      let chargeEmployeeId = null;

      if (chargeType === "account" && varianceValue) {
        chargeAccountCode = line.chargeAccountCode || "5300";
        const accountExists = await client.query("SELECT id FROM accounts WHERE code = $1", [chargeAccountCode]);
        if (accountExists.rows.length === 0) {
          await client.query("ROLLBACK");
          return res.status(400).json({ error: `الحساب المحاسبي ${chargeAccountCode} غير موجود` });
        }
        const adjustmentAccount = await getAccountByCode(client, chargeAccountCode);
        const inventoryAccount = await getAccountByCode(client, "1400");
        const absValue = Math.abs(varianceValue);
        const isIncrease = varianceQuantity > 0;
        await postJournalEntry(client, {
          entryDate: movement.business_date, description: `فرق جرد فعلي #${stocktakeId}`,
          sourceType: "stock_count", sourceId: movement.id, branchId,
          lines: isIncrease
            ? [{ accountId: inventoryAccount.id, debit: absValue }, { accountId: adjustmentAccount.id, credit: absValue }]
            : [{ accountId: adjustmentAccount.id, debit: absValue }, { accountId: inventoryAccount.id, credit: absValue }],
          idempotencyKey: `stock-count-${movement.id}`, userId: req.user.id,
        });
      } else if (chargeType === "employee" && varianceValue) {
        chargeEmployeeId = line.chargeEmployeeId;
        const employeeRes = await client.query("SELECT id, name FROM employees WHERE id = $1", [chargeEmployeeId]);
        if (employeeRes.rows.length === 0) {
          await client.query("ROLLBACK");
          return res.status(400).json({ error: "الموظف المحدّد غير موجود" });
        }
        const employee = employeeRes.rows[0];
        const receivableAccount = await getOrCreateEmployeeReceivableAccount(client, employee.id);
        const inventoryAccount = await getAccountByCode(client, "1400");
        const shortage = Math.round(Math.abs(varianceValue) * 100) / 100;
        await postJournalEntry(client, {
          entryDate: movement.business_date, description: `عجز جرد #${stocktakeId} - ${employee.name}`,
          sourceType: "stock_count", sourceId: movement.id, branchId,
          lines: [
            { accountId: receivableAccount.id, debit: shortage, branchId },
            { accountId: inventoryAccount.id, credit: shortage, branchId },
          ],
          idempotencyKey: `stock-count-${movement.id}`, userId: req.user.id,
        });
        await client.query(
          `INSERT INTO payroll_adjustments (employee_id, entry_date, adjustment_type, amount, notes, created_by, stocktake_id)
           VALUES ($1, CURRENT_DATE, 'advance', $2, $3, $4, $5)`,
          [employee.id, shortage, `عجز جرد فعلي #${stocktakeId}`, req.user.id, stocktakeId]
        );
      }

      const lineRes = await client.query(
        `INSERT INTO stocktake_lines
          (stocktake_id, inventory_item_id, system_quantity, actual_quantity, variance_quantity,
           unit_cost, variance_value, reason, charge_type, charge_account_code, charge_employee_id, inventory_movement_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
        [
          stocktakeId, line.inventoryItemId, systemQuantity, actualQuantity, varianceQuantity,
          unitCost, varianceValue, line.reason || null, chargeType, chargeAccountCode, chargeEmployeeId, movement.id,
        ]
      );
      savedLines.push(lineRes.rows[0]);
      totalVarianceValue += Number(varianceValue || 0);
    }

    await client.query("UPDATE stocktakes SET total_variance_value = $1 WHERE id = $2", [Math.round(totalVarianceValue * 100) / 100, stocktakeId]);
    await logAudit(client, {
      branchId, userId: req.user.id, action: "STOCKTAKE_COMMITTED", entityType: "stocktake", entityId: stocktakeId,
      newValues: { linesCount: savedLines.length, totalVarianceValue: Math.round(totalVarianceValue * 100) / 100 }, req,
    });
    await client.query("COMMIT");
    res.status(201).json({ id: stocktakeId, branchId, totalVarianceValue: Math.round(totalVarianceValue * 100) / 100, lines: savedLines });
  } catch (err) {
    await client.query("ROLLBACK");
    if (err.code === "INSUFFICIENT_STOCK") return res.status(400).json({ error: err.message });
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// GET /api/stocktake?branchId=&from=&to= - سجل جلسات الجرد
router.get("/", requirePermission("inventory.view"), async (req, res) => {
  const { branchId, from, to } = req.query;
  const resolvedBranchId = branchId || req.user.branchId;
  if (!resolvedBranchId) return res.status(400).json({ error: "لازم تحدد الفرع" });
  if (!assertOwnBranch(req.user, resolvedBranchId)) {
    return res.status(403).json({ error: "معندكش صلاحية على فرع تاني" });
  }
  try {
    const result = await pool.query(
      `SELECT s.*, u.name AS created_by_name,
              (SELECT COUNT(*) FROM stocktake_lines l WHERE l.stocktake_id = s.id) AS lines_count
       FROM stocktakes s
       LEFT JOIN users u ON u.id = s.created_by
       WHERE s.branch_id = $1
         AND ($2::date IS NULL OR s.created_at >= $2::date)
         AND ($3::date IS NULL OR s.created_at < ($3::date + 1))
       ORDER BY s.created_at DESC LIMIT 200`,
      [resolvedBranchId, from || null, to || null]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/stocktake/:id - تفاصيل جلسة جرد بسطورها، وكل سطر بيحمل سجل تصحيحاته (لو فيه) + الكمية/الفرق/
// القيمة "الفعلية المعتمدة حاليًا" (آخر تصحيح لو موجود، وإلا الأصلية زي ما اتسجلت وقت التأكيد)
router.get("/:id", requirePermission("inventory.view"), async (req, res) => {
  try {
    const headerRes = await pool.query(
      `SELECT s.*, u.name AS created_by_name FROM stocktakes s LEFT JOIN users u ON u.id = s.created_by WHERE s.id = $1`,
      [req.params.id]
    );
    if (headerRes.rows.length === 0) return res.status(404).json({ error: "الجرد مش موجود" });
    const header = headerRes.rows[0];
    if (!assertOwnBranch(req.user, header.branch_id)) {
      return res.status(403).json({ error: "معندكش صلاحية على فرع تاني" });
    }
    const linesRes = await pool.query(
      `SELECT l.*, ii.name AS item_name, ii.unit, e.name AS charge_employee_name
       FROM stocktake_lines l
       JOIN inventory_items ii ON ii.id = l.inventory_item_id
       LEFT JOIN employees e ON e.id = l.charge_employee_id
       WHERE l.stocktake_id = $1
       ORDER BY l.id`,
      [req.params.id]
    );
    const lineIds = linesRes.rows.map((l) => l.id);
    const correctionsRes = lineIds.length
      ? await pool.query(
          `SELECT c.*, u.name AS created_by_name, e.name AS charge_employee_name
           FROM stocktake_line_corrections c
           LEFT JOIN users u ON u.id = c.created_by
           LEFT JOIN employees e ON e.id = c.charge_employee_id
           WHERE c.stocktake_line_id = ANY($1::int[])
           ORDER BY c.created_at`,
          [lineIds]
        )
      : { rows: [] };
    const correctionsByLine = new Map();
    for (const c of correctionsRes.rows) {
      if (!correctionsByLine.has(c.stocktake_line_id)) correctionsByLine.set(c.stocktake_line_id, []);
      correctionsByLine.get(c.stocktake_line_id).push(c);
    }
    const lines = linesRes.rows.map((l) => {
      const corrections = correctionsByLine.get(l.id) || [];
      const last = corrections[corrections.length - 1];
      const effectiveActualQuantity = last ? Number(last.corrected_actual_quantity) : Number(l.actual_quantity);
      const effectiveVarianceQuantity = Math.round((effectiveActualQuantity - Number(l.system_quantity)) * 1000) / 1000;
      const effectiveVarianceValue = Math.round(
        (Number(l.variance_value || 0) + corrections.reduce((sum, c) => sum + Number(c.delta_value || 0), 0)) * 100
      ) / 100;
      return { ...l, corrections, effectiveActualQuantity, effectiveVarianceQuantity, effectiveVarianceValue };
    });
    res.json({ ...header, lines });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/stocktake/:id/lines/:lineId/correct - {correctedActualQuantity, reason?, chargeType?,
// chargeAccountCode?, chargeEmployeeId?} - تصحيح سطر جرد اتسجّل برقم غلط. القاعدة الثابتة في المشروع
// إن قيد محاسبي POSTED ميتلمسش خالص - فبدل ما نعدّل السطر الأصلي أو قيده، كل تصحيح هنا بيحمل بس الفرق
// (delta) بين آخر كمية فعلية معتمدة والكمية الصح الجديدة، وبيترحّل بحركة مخزون وقيد محاسبي مستقلين خاصين
// بيه. ممكن تعمل أكتر من تصحيح لنفس السطر بمرور الوقت لو لزم الأمر
router.post("/:id/lines/:lineId/correct", requirePermission("inventory.count"), async (req, res) => {
  const { correctedActualQuantity, reason, chargeType, chargeAccountCode, chargeEmployeeId, idempotencyKey } = req.body;
  if (correctedActualQuantity === undefined || correctedActualQuantity === null || Number(correctedActualQuantity) < 0) {
    return res.status(400).json({ error: "الكمية الصح مطلوبة ولازم تكون رقم موجب" });
  }
  if (chargeType && !["account", "employee"].includes(chargeType)) {
    return res.status(400).json({ error: "نوع تحميل غير معروف" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // المرحلة 9A-6: نفس فكرة idempotency جلسة الجرد فوق - retry شبكة/دبل كليك بنفس المفتاح بيرجّع
    // نفس سجل التصحيح الأصلي من غير ما يسجّل delta تاني فوقه غلط
    if (idempotencyKey) {
      const existingCorrection = await client.query(
        "SELECT * FROM stocktake_line_corrections WHERE idempotency_key = $1", [idempotencyKey]
      );
      if (existingCorrection.rows.length > 0) {
        await client.query("ROLLBACK");
        return res.status(200).json({ ...existingCorrection.rows[0], duplicate: true });
      }
    }

    const lineRes = await client.query(
      `SELECT l.*, s.branch_id FROM stocktake_lines l JOIN stocktakes s ON s.id = l.stocktake_id
       WHERE l.id = $1 AND l.stocktake_id = $2 FOR UPDATE OF l`,
      [req.params.lineId, req.params.id]
    );
    if (lineRes.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "سطر الجرد مش موجود" });
    }
    const line = lineRes.rows[0];
    if (!assertOwnBranch(req.user, line.branch_id)) {
      await client.query("ROLLBACK");
      return res.status(403).json({ error: "معندكش صلاحية تعدّل جرد فرع تاني" });
    }

    const lastCorrectionRes = await client.query(
      `SELECT * FROM stocktake_line_corrections WHERE stocktake_line_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1`,
      [line.id]
    );
    const previousActualQuantity = lastCorrectionRes.rows.length > 0
      ? Number(lastCorrectionRes.rows[0].corrected_actual_quantity)
      : Number(line.actual_quantity);

    const newActual = Number(correctedActualQuantity);
    const deltaQuantity = Math.round((newActual - previousActualQuantity) * 1000) / 1000;
    if (deltaQuantity === 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "الكمية اللي دخلتها زي الكمية المسجّلة حاليًا بالظبط - مفيش تصحيح لازم" });
    }
    if (deltaQuantity > 0 && chargeType === "employee") {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "التصحيح ده بيقلّل العجز - مينفعش يتحمّله موظف، لازم يترحّل لحساب محاسبي" });
    }

    const correctionNote = `تصحيح جرد فعلي #${line.stocktake_id} - سطر ${line.id}: كان ${previousActualQuantity}، الصح ${newActual}` + (reason ? ` - ${reason}` : "");
    const { movement } = await postInventoryMovement(client, {
      branchId: line.branch_id, inventoryItemId: line.inventory_item_id, quantity: deltaQuantity, movementType: "STOCK_COUNT",
      notes: correctionNote, userId: req.user.id, negativeStockOverrideApproved: true,
    });
    const unitCost = movement.unit_cost != null ? Number(movement.unit_cost) : null;
    const deltaValue = unitCost != null ? Math.round(deltaQuantity * unitCost * 100) / 100 : null;

    const effectiveChargeType = deltaValue && deltaValue !== 0 ? (chargeType || line.charge_type || "account") : null;
    if (effectiveChargeType === "employee" && deltaQuantity > 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "التصحيح ده بيقلّل العجز - مينفعش يتحمّله موظف، لازم يترحّل لحساب محاسبي" });
    }
    let resolvedAccountCode = null;
    let resolvedEmployeeId = null;

    if (effectiveChargeType === "account" && deltaValue) {
      resolvedAccountCode = chargeAccountCode || line.charge_account_code || "5300";
      const accountExists = await client.query("SELECT id FROM accounts WHERE code = $1", [resolvedAccountCode]);
      if (accountExists.rows.length === 0) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: `الحساب المحاسبي ${resolvedAccountCode} غير موجود` });
      }
      const adjustmentAccount = await getAccountByCode(client, resolvedAccountCode);
      const inventoryAccount = await getAccountByCode(client, "1400");
      const absValue = Math.abs(deltaValue);
      const isIncrease = deltaQuantity > 0;
      await postJournalEntry(client, {
        entryDate: movement.business_date, description: `تصحيح فرق جرد فعلي #${line.stocktake_id}`,
        sourceType: "stock_count_correction", sourceId: movement.id, branchId: line.branch_id,
        lines: isIncrease
          ? [{ accountId: inventoryAccount.id, debit: absValue }, { accountId: adjustmentAccount.id, credit: absValue }]
          : [{ accountId: adjustmentAccount.id, debit: absValue }, { accountId: inventoryAccount.id, credit: absValue }],
        idempotencyKey: `stock-count-correction-${movement.id}`, userId: req.user.id,
      });
    } else if (effectiveChargeType === "employee" && deltaValue) {
      resolvedEmployeeId = chargeEmployeeId || line.charge_employee_id;
      if (!resolvedEmployeeId) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "لازم تحدد الموظف اللي هيتحمّل التصحيح" });
      }
      const employeeRes = await client.query("SELECT id, name FROM employees WHERE id = $1", [resolvedEmployeeId]);
      if (employeeRes.rows.length === 0) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "الموظف المحدّد غير موجود" });
      }
      const employee = employeeRes.rows[0];
      const receivableAccount = await getOrCreateEmployeeReceivableAccount(client, employee.id);
      const inventoryAccount = await getAccountByCode(client, "1400");
      const shortage = Math.round(Math.abs(deltaValue) * 100) / 100;
      await postJournalEntry(client, {
        entryDate: movement.business_date, description: `تصحيح عجز جرد #${line.stocktake_id} - ${employee.name}`,
        sourceType: "stock_count_correction", sourceId: movement.id, branchId: line.branch_id,
        lines: [
          { accountId: receivableAccount.id, debit: shortage, branchId: line.branch_id },
          { accountId: inventoryAccount.id, credit: shortage, branchId: line.branch_id },
        ],
        idempotencyKey: `stock-count-correction-${movement.id}`, userId: req.user.id,
      });
      await client.query(
        `INSERT INTO payroll_adjustments (employee_id, entry_date, adjustment_type, amount, notes, created_by, stocktake_id)
         VALUES ($1, CURRENT_DATE, 'advance', $2, $3, $4, $5)`,
        [employee.id, shortage, `تصحيح عجز جرد فعلي #${line.stocktake_id} - سطر ${line.id}`, req.user.id, line.stocktake_id]
      );
    }

    const correctionRes = await client.query(
      `INSERT INTO stocktake_line_corrections
        (stocktake_line_id, previous_actual_quantity, corrected_actual_quantity, delta_quantity,
         unit_cost, delta_value, reason, charge_type, charge_account_code, charge_employee_id, inventory_movement_id, created_by, idempotency_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
      [
        line.id, previousActualQuantity, newActual, deltaQuantity,
        unitCost, deltaValue, reason || null, effectiveChargeType, resolvedAccountCode, resolvedEmployeeId, movement.id, req.user.id,
        idempotencyKey || null,
      ]
    );

    await client.query(
      `UPDATE stocktakes SET total_variance_value = ROUND((COALESCE(total_variance_value, 0) + $1)::numeric, 2) WHERE id = $2`,
      [deltaValue || 0, line.stocktake_id]
    );
    await logAudit(client, {
      branchId: line.branch_id, userId: req.user.id, action: "STOCKTAKE_LINE_CORRECTED", entityType: "stocktake_line", entityId: line.id,
      newValues: { previousActualQuantity, correctedActualQuantity: newActual, deltaQuantity, deltaValue }, req,
    });
    await client.query("COMMIT");
    res.status(201).json(correctionRes.rows[0]);
  } catch (err) {
    await client.query("ROLLBACK");
    if (err.code === "INSUFFICIENT_STOCK") return res.status(400).json({ error: err.message });
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

module.exports = router;
