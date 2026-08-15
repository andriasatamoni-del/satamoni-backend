const express = require("express");
const router = express.Router();
const pool = require("../db/pool");
const { requireAuth, requireRole, assertOwnBranch } = require("../middleware/auth");
const { logAudit } = require("../db/audit");

// GET /api/suppliers/ledger?branchId= - كشف حساب فرع مع المخزن الرئيسي (كمورد)
router.get(
  "/ledger",
  requireAuth,
  requireRole("admin", "accountant", "branch_manager"),
  async (req, res) => {
    let { branchId } = req.query;
    if (req.user.role === "branch_manager") {
      if (branchId && !assertOwnBranch(req.user, branchId)) {
        return res.status(403).json({ error: "معندكش صلاحية تشوف كشف حساب فرع تاني" });
      }
      branchId = req.user.branchId;
    }
    try {
      const result = await pool.query(
        `SELECT * FROM supplier_ledger_entries
         WHERE ($1::int IS NULL OR branch_id = $1)
         ORDER BY entry_date DESC, id DESC`,
        [branchId || null]
      );
      res.json(result.rows);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

// POST /api/suppliers/ledger - إضافة قيد (فاتورة مشتريات أو سداد) - أدمن ومحاسب بس
router.post("/ledger", requireAuth, requireRole("admin", "accountant"), async (req, res) => {
  const { branchId, entryDate, documentNo, entryType, invoiceAmount = 0, paymentAmount = 0, notes } = req.body;
  if (!branchId || !entryDate || !entryType) {
    return res.status(400).json({ error: "بيانات ناقصة" });
  }
  try {
    const result = await pool.query(
      `INSERT INTO supplier_ledger_entries
        (branch_id, entry_date, document_no, entry_type, invoice_amount, payment_amount, notes, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [branchId, entryDate, documentNo || null, entryType, invoiceAmount, paymentAmount, notes || null, req.user.name]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------- سجل الموردين (شركات المواد الخام) ----------------

// GET /api/suppliers - كل الموردين مع الأصناف اللي بيبيعوها وأسعارهم
router.get("/", requireAuth, requireRole("admin", "accountant", "branch_manager"), async (req, res) => {
  try {
    const suppliers = await pool.query("SELECT * FROM suppliers ORDER BY name");
    const items = await pool.query(`
      SELECT ins.supplier_id, ins.unit_price, ii.id AS inventory_item_id, ii.name, ii.unit
      FROM inventory_item_suppliers ins
      JOIN inventory_items ii ON ii.id = ins.inventory_item_id
    `);
    res.json(suppliers.rows.map((s) => ({
      ...s,
      items: items.rows.filter((it) => it.supplier_id === s.id),
    })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/suppliers - إضافة مورد جديد (المرحلة 4A: الحقول الجديدة كلها اختيارية، name لسه لازم بس)
router.post("/", requireAuth, requireRole("admin", "accountant"), async (req, res) => {
  const {
    name, supplierCode, legalName, tradeName, contactPerson, phone, email, address,
    taxId, paymentTerms, defaultCurrency, notes,
  } = req.body;
  if (!name) return res.status(400).json({ error: "لازم اسم المورد" });
  try {
    const result = await pool.query(
      `INSERT INTO suppliers
        (name, supplier_code, legal_name, trade_name, contact_person, phone, email, address,
         tax_id, payment_terms, default_currency, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,COALESCE($11,'EGP'),$12,$13) RETURNING *`,
      [name, supplierCode || null, legalName || null, tradeName || null, contactPerson || null,
       phone || null, email || null, address || null, taxId || null, paymentTerms || null,
       defaultCurrency || null, notes || null, req.user.id]
    );
    await logAudit(pool, {
      userId: req.user.id, action: "SUPPLIER_CREATED", entityType: "supplier", entityId: result.rows[0].id,
      newValues: result.rows[0], req,
    });
    res.status(201).json(result.rows[0]);
  } catch (err) {
    if (err.code === "23505") return res.status(409).json({ error: "المورد ده موجود بالفعل (الاسم أو الكود مستخدم قبل كده)" });
    res.status(500).json({ error: err.message });
  }
});

// GET /api/suppliers/:id - تفاصيل مورد + كل مكوناته وسعرها الساري حاليًا (من supplier_items، المرحلة 4A)
router.get("/:id", requireAuth, requireRole("admin", "accountant", "branch_manager"), async (req, res) => {
  try {
    const supplier = await pool.query("SELECT * FROM suppliers WHERE id = $1", [req.params.id]);
    if (supplier.rows.length === 0) return res.status(404).json({ error: "المورد مش موجود" });
    const items = await pool.query(
      `SELECT si.*, ii.name AS item_name, ii.unit AS item_unit
       FROM supplier_items si JOIN inventory_items ii ON ii.id = si.inventory_item_id
       WHERE si.supplier_id = $1 AND si.effective_to IS NULL
       ORDER BY ii.name`,
      [req.params.id]
    );
    res.json({ supplier: supplier.rows[0], currentItems: items.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/suppliers/:id - تعديل بيانات مورد أو حالته (ACTIVE/INACTIVE/BLOCKED) - مفيش DELETE خالص،
// مورد مرتبط بمعاملات تاريخية (PO/GRN) بيتقفل بالحالة مش بيتمسح
router.patch("/:id", requireAuth, requireRole("admin", "accountant"), async (req, res) => {
  const {
    name, supplierCode, legalName, tradeName, contactPerson, phone, email, address,
    taxId, paymentTerms, defaultCurrency, status, notes,
  } = req.body;
  const fields = [];
  const values = [];
  let i = 1;
  const push = (col, val) => { fields.push(`${col} = $${i++}`); values.push(val); };
  if (name !== undefined) push("name", name);
  if (supplierCode !== undefined) push("supplier_code", supplierCode);
  if (legalName !== undefined) push("legal_name", legalName);
  if (tradeName !== undefined) push("trade_name", tradeName);
  if (contactPerson !== undefined) push("contact_person", contactPerson);
  if (phone !== undefined) push("phone", phone);
  if (email !== undefined) push("email", email);
  if (address !== undefined) push("address", address);
  if (taxId !== undefined) push("tax_id", taxId);
  if (paymentTerms !== undefined) push("payment_terms", paymentTerms);
  if (defaultCurrency !== undefined) push("default_currency", defaultCurrency);
  if (notes !== undefined) push("notes", notes);
  if (status !== undefined) {
    if (!["ACTIVE", "INACTIVE", "BLOCKED"].includes(status)) return res.status(400).json({ error: "حالة المورد غير معروفة" });
    push("status", status);
  }
  if (fields.length === 0) return res.status(400).json({ error: "مفيش حاجة تتعدل" });
  fields.push("updated_at = now()");

  try {
    const before = await pool.query("SELECT * FROM suppliers WHERE id = $1", [req.params.id]);
    if (before.rows.length === 0) return res.status(404).json({ error: "المورد مش موجود" });
    values.push(req.params.id);
    const result = await pool.query(`UPDATE suppliers SET ${fields.join(", ")} WHERE id = $${i} RETURNING *`, values);
    await logAudit(pool, {
      userId: req.user.id,
      action: status !== undefined && status !== before.rows[0].status ? "SUPPLIER_STATUS_CHANGED" : "SUPPLIER_EDITED",
      entityType: "supplier", entityId: Number(req.params.id),
      oldValues: before.rows[0], newValues: result.rows[0], req,
    });
    res.json(result.rows[0]);
  } catch (err) {
    if (err.code === "23505") return res.status(409).json({ error: "الاسم أو الكود ده مستخدم لمورد تاني" });
    res.status(500).json({ error: err.message });
  }
});

// POST /api/suppliers/:id/items - ربط صنف بمورد وسعره (جدول قديم - بيتحدّث بالسعر الأحدث بس، مالوش تاريخ)
router.post("/:id/items", requireAuth, requireRole("admin", "accountant"), async (req, res) => {
  const { inventoryItemId, unitPrice } = req.body;
  if (!inventoryItemId || unitPrice === undefined) return res.status(400).json({ error: "لازم صنف وسعر" });
  try {
    const result = await pool.query(
      `INSERT INTO inventory_item_suppliers (inventory_item_id, supplier_id, unit_price)
       VALUES ($1, $2, $3)
       ON CONFLICT (inventory_item_id, supplier_id) DO UPDATE SET unit_price = EXCLUDED.unit_price
       RETURNING *`,
      [inventoryItemId, req.params.id, unitPrice]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------- المرحلة 4A: أسعار الموردين بتاريخ حقيقي (supplier_items) ----------------

// POST /api/suppliers/:id/price-history - سعر جديد لمكوّن عند المورد ده - بيقفل السعر الساري القديم
// (effective_to = دلوقتي) وينشئ صف جديد effective_from = دلوقتي. مينفعش يتمسح أو يتعدّل سعر قديم أبدًا
router.post("/:id/price-history", requireAuth, requireRole("admin", "accountant"), async (req, res) => {
  const {
    inventoryItemId, unitPrice, currency, purchaseUnit, conversionFactor,
    supplierItemCode, minimumOrderQuantity, leadTimeDays, preferredSupplier,
  } = req.body;
  if (!inventoryItemId || unitPrice === undefined || Number(unitPrice) < 0) {
    return res.status(400).json({ error: "لازم صنف وسعر صحيح" });
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const previous = await client.query(
      `SELECT * FROM supplier_items WHERE supplier_id = $1 AND inventory_item_id = $2 AND effective_to IS NULL`,
      [req.params.id, inventoryItemId]
    );
    if (previous.rows.length > 0) {
      await client.query(`UPDATE supplier_items SET effective_to = now() WHERE id = $1`, [previous.rows[0].id]);
    }
    const inserted = await client.query(
      `INSERT INTO supplier_items
        (supplier_id, inventory_item_id, supplier_item_code, purchase_unit, conversion_factor, unit_price,
         currency, minimum_order_quantity, lead_time_days, preferred_supplier, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7,'EGP'),$8,$9,$10,$11) RETURNING *`,
      [req.params.id, inventoryItemId, supplierItemCode || null, purchaseUnit || null,
       conversionFactor || null, unitPrice, currency || null, minimumOrderQuantity || null,
       leadTimeDays || null, !!preferredSupplier, req.user.id]
    );
    await logAudit(client, {
      userId: req.user.id, action: "SUPPLIER_PRICE_CHANGED", entityType: "supplier_item", entityId: inserted.rows[0].id,
      oldValues: previous.rows[0] || null, newValues: inserted.rows[0],
      metadata: { supplierId: Number(req.params.id), inventoryItemId }, req,
    });
    await client.query("COMMIT");
    res.status(201).json(inserted.rows[0]);
  } catch (err) {
    await client.query("ROLLBACK");
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// GET /api/suppliers/:id/price-history?itemId= - كل تاريخ الأسعار (كل صنف أو صنف محدد)، الأحدث الأول
router.get("/:id/price-history", requireAuth, requireRole("admin", "accountant", "branch_manager"), async (req, res) => {
  const { itemId } = req.query;
  try {
    const result = await pool.query(
      `SELECT si.*, ii.name AS item_name, ii.unit AS item_unit
       FROM supplier_items si JOIN inventory_items ii ON ii.id = si.inventory_item_id
       WHERE si.supplier_id = $1 AND ($2::int IS NULL OR si.inventory_item_id = $2)
       ORDER BY si.inventory_item_id, si.effective_from DESC`,
      [req.params.id, itemId || null]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
