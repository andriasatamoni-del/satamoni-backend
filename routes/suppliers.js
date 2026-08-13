const express = require("express");
const router = express.Router();
const pool = require("../db/pool");
const { requireAuth, requireRole, assertOwnBranch } = require("../middleware/auth");

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

// POST /api/suppliers - إضافة مورد جديد
router.post("/", requireAuth, requireRole("admin", "accountant"), async (req, res) => {
  const { name, phone, notes } = req.body;
  if (!name) return res.status(400).json({ error: "لازم اسم المورد" });
  try {
    const result = await pool.query(
      "INSERT INTO suppliers (name, phone, notes) VALUES ($1, $2, $3) RETURNING *",
      [name, phone || null, notes || null]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    if (err.code === "23505") return res.status(409).json({ error: "المورد ده موجود بالفعل" });
    res.status(500).json({ error: err.message });
  }
});

// POST /api/suppliers/:id/items - ربط صنف بمورد وسعره
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

module.exports = router;
