const express = require("express");
const router = express.Router();
const pool = require("../db/pool");
const { requireAuth, requireRole } = require("../middleware/auth");
const { logAudit } = require("../db/audit");

const canView = requireRole("admin", "callcenter", "branch_manager", "cashier", "accountant");
const canEdit = requireRole("admin", "callcenter", "branch_manager");
// الكاشير أصلًا بيسجل عناوين العملاء ضمنيًا وقت إنشاء طلب دليفري من الكاشير (Phase 7L/7M) - بالتالي له
// نفس الصلاحية هنا لإضافة/تعديل عنوان صراحة. الحذف أخطر (فقد بيانات) فمقصور على اللي بيديروا بيانات العملاء.
const canManageAddresses = requireRole("admin", "callcenter", "branch_manager", "cashier");
const canDeleteAddress = requireRole("admin", "callcenter", "branch_manager");

// GET /api/customers?q=  - بحث بالاسم أو رقم التليفون (لشاشة الكول سنتر)
// GET /api/customers?phone=  - بروفايل عميل واحد كامل (إحصائياته + آخر طلباته) - بيدوّر في phone و phone2 معًا
// GET /api/customers  (من غير q ولا phone) - دليل كل العملاء، الأحدث نشاطًا الأول (لشاشة بيانات العملاء)
router.get("/", requireAuth, canView, async (req, res) => {
  const { q, phone } = req.query;
  try {
    if (!q && !phone) {
      const result = await pool.query(
        `SELECT c.phone, c.name, c.loyalty_points, c.is_blocked, COALESCE(s.orders_count, 0) AS orders_count,
                COALESCE(s.total_spent, 0) AS total_spent, s.last_order_at
         FROM customers c
         LEFT JOIN v_customer_order_stats s ON s.phone = c.phone
         ORDER BY s.last_order_at DESC NULLS LAST
         LIMIT 200`
      );
      return res.json(result.rows.map((r) => ({
        phone: r.phone, name: r.name, loyaltyPoints: r.loyalty_points, isBlocked: r.is_blocked,
        ordersCount: Number(r.orders_count), totalSpent: Number(r.total_spent), lastOrderAt: r.last_order_at,
      })));
    }

    if (phone) {
      const customer = await pool.query(
        "SELECT * FROM customers WHERE phone = $1 OR phone2 = $1", [phone]
      );
      if (customer.rows.length === 0) {
        return res.json({
          phone, phone2: null, name: null, notes: null, addressDetails: null, deliveryAreaId: null,
          distinguishingMark: null, loyaltyPoints: 0, ordersCount: 0, totalSpent: 0, lastOrderAt: null,
          recentOrders: [], isRegistered: false,
        });
      }
      const row = customer.rows[0];
      const stats = await pool.query("SELECT * FROM v_customer_order_stats WHERE phone = $1", [row.phone]);
      const recentOrders = await pool.query(
        `SELECT id, branch_id, order_type, total, status, payment_status, created_at
         FROM orders WHERE customer_phone = $1 OR customer_phone = $2
         ORDER BY created_at DESC LIMIT 20`,
        [row.phone, row.phone2]
      );
      return res.json({
        phone: row.phone,
        phone2: row.phone2,
        name: row.name,
        notes: row.notes,
        addressDetails: row.address_details,
        deliveryAreaId: row.delivery_area_id,
        distinguishingMark: row.distinguishing_mark,
        loyaltyPoints: row.loyalty_points,
        isBlocked: row.is_blocked,
        blockReason: row.block_reason,
        isRegistered: true,
        ordersCount: Number(stats.rows[0]?.orders_count || 0),
        totalSpent: Number(stats.rows[0]?.total_spent || 0),
        lastOrderAt: stats.rows[0]?.last_order_at || null,
        recentOrders: recentOrders.rows,
      });
    }

    if (q) {
      const result = await pool.query(
        `SELECT c.*, COALESCE(s.orders_count, 0) AS orders_count, COALESCE(s.total_spent, 0) AS total_spent,
                s.last_order_at
         FROM customers c
         LEFT JOIN v_customer_order_stats s ON s.phone = c.phone
         WHERE c.phone ILIKE $1 OR c.name ILIKE $1
         ORDER BY s.last_order_at DESC NULLS LAST
         LIMIT 30`,
        [`%${q}%`]
      );
      return res.json(result.rows);
    }

    return res.status(400).json({ error: "لازم q (بحث) أو phone (بروفايل)" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/customers/dormant?days=30 - عملاء سجّلوا طلب قبل كده بس مطلبوش تاني من X يوم -
// مرتبين بالأكتر إنفاقًا الأول (أعلى قيمة تستاهل تتصل بيها للاسترجاع)
router.get("/dormant", requireAuth, canView, async (req, res) => {
  const days = Number(req.query.days) || 30;
  if (days <= 0) return res.status(400).json({ error: "عدد الأيام لازم يكون أكبر من صفر" });
  try {
    const result = await pool.query(
      `SELECT c.phone, c.phone2, c.name, c.loyalty_points,
              s.orders_count, s.total_spent, s.last_order_at
       FROM customers c
       JOIN v_customer_order_stats s ON s.phone = c.phone
       WHERE s.last_order_at < now() - ($1 || ' days')::interval
       ORDER BY s.total_spent DESC`,
      [days]
    );
    res.json({
      days,
      customers: result.rows.map((r) => ({
        phone: r.phone, phone2: r.phone2, name: r.name, loyaltyPoints: r.loyalty_points,
        ordersCount: Number(r.orders_count), totalSpent: Number(r.total_spent), lastOrderAt: r.last_order_at,
        daysSinceLastOrder: Math.floor((Date.now() - new Date(r.last_order_at).getTime()) / 86400000),
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/customers/:phone - تحديث بيانات العميل (بينشئ العميل لو مش موجود) - ده اللي بيسجل بيانات
// العميل كاملة وقت طلب الدليفري (رقمين تليفون، عنوان تفصيلي، منطقة، علامة مميزة، نقاط ولاء)
router.patch("/:phone", requireAuth, canEdit, async (req, res) => {
  const { phone } = req.params;
  const { notes, loyaltyPoints, name, phone2, addressDetails, deliveryAreaId, distinguishingMark } = req.body;
  if ([notes, loyaltyPoints, name, phone2, addressDetails, deliveryAreaId, distinguishingMark].every((v) => v === undefined)) {
    return res.status(400).json({ error: "مفيش حاجة تتعدل" });
  }
  try {
    const result = await pool.query(
      `INSERT INTO customers (phone, name, notes, loyalty_points, phone2, address_details, delivery_area_id, distinguishing_mark)
       VALUES ($1, $2, $3, COALESCE($4, 0), $5, $6, $7, $8)
       ON CONFLICT (phone) DO UPDATE SET
         name = COALESCE($2, customers.name),
         notes = COALESCE($3, customers.notes),
         loyalty_points = COALESCE($4, customers.loyalty_points),
         phone2 = COALESCE($5, customers.phone2),
         address_details = COALESCE($6, customers.address_details),
         delivery_area_id = COALESCE($7, customers.delivery_area_id),
         distinguishing_mark = COALESCE($8, customers.distinguishing_mark),
         updated_at = now()
       RETURNING *`,
      [phone, name ?? null, notes ?? null, loyaltyPoints ?? null, phone2 ?? null,
       addressDetails ?? null, deliveryAreaId ?? null, distinguishingMark ?? null]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------- المرحلة 7P: حظر عميل + دمج عملاء مكررين ----------------

// POST /api/customers/:phone/block - منع تسجيل طلبات دليفري جديدة للعميل ده (بلاغات كاذبة، عدم دفع
// متكرر...) - الحظر بيتفحص وقت إنشاء طلب دليفري بس (routes/orders.js)، مش تيك أواي/صالة
router.post("/:phone/block", requireAuth, canEdit, async (req, res) => {
  const { phone } = req.params;
  const { reason } = req.body;
  if (!reason) return res.status(400).json({ error: "سبب الحظر مطلوب" });
  try {
    const result = await pool.query(
      `UPDATE customers SET is_blocked = TRUE, block_reason = $2, blocked_by = $3, blocked_at = now(), updated_at = now()
       WHERE phone = $1 RETURNING *`,
      [phone, reason, req.user.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: "العميل مش موجود" });
    await logAudit(pool, {
      userId: req.user.id, action: "CUSTOMER_BLOCKED", entityType: "customer", entityId: null,
      metadata: { phone, reason }, req,
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/customers/:phone/unblock
router.post("/:phone/unblock", requireAuth, canEdit, async (req, res) => {
  const { phone } = req.params;
  try {
    const result = await pool.query(
      `UPDATE customers SET is_blocked = FALSE, block_reason = NULL, blocked_by = NULL, blocked_at = NULL, updated_at = now()
       WHERE phone = $1 RETURNING *`,
      [phone]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: "العميل مش موجود" });
    await logAudit(pool, {
      userId: req.user.id, action: "CUSTOMER_UNBLOCKED", entityType: "customer", entityId: null,
      metadata: { phone }, req,
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/customers/merge - {sourcePhone, targetPhone} - دمج عميل مكرر (مسجل برقمين/نسختين) في
// عميل واحد: عناوين وطلبات المصدر بتتحول لصاحب رقم الهدف، نقاط الولاء بتتجمع، وصف العميل المصدر بيتشال
// نهائيًا بعد كده (مفيش حاجة فاضلة تشاور عليه - عناوينه وطلباته اتحولوا بالفعل)
router.post("/merge", requireAuth, canEdit, async (req, res) => {
  const { sourcePhone, targetPhone } = req.body;
  if (!sourcePhone || !targetPhone) return res.status(400).json({ error: "رقم العميل المصدر والهدف مطلوبين" });
  if (sourcePhone === targetPhone) return res.status(400).json({ error: "مينفعش تدمج العميل في نفسه" });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const source = await client.query("SELECT * FROM customers WHERE phone = $1 FOR UPDATE", [sourcePhone]);
    const target = await client.query("SELECT * FROM customers WHERE phone = $1 FOR UPDATE", [targetPhone]);
    if (source.rows.length === 0 || target.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "العميل المصدر أو الهدف مش موجود" });
    }

    await client.query("UPDATE orders SET customer_phone = $2 WHERE customer_phone = $1", [sourcePhone, targetPhone]);
    await client.query("UPDATE customer_addresses SET customer_phone = $2 WHERE customer_phone = $1", [sourcePhone, targetPhone]);
    await client.query(
      `UPDATE customers SET
         name = COALESCE(customers.name, $2),
         phone2 = COALESCE(customers.phone2, $3),
         address_details = COALESCE(customers.address_details, $4),
         delivery_area_id = COALESCE(customers.delivery_area_id, $5),
         distinguishing_mark = COALESCE(customers.distinguishing_mark, $6),
         notes = CASE WHEN $7::text IS NULL THEN customers.notes
                       WHEN customers.notes IS NULL THEN $7
                       ELSE customers.notes || E'\n' || $7 END,
         loyalty_points = customers.loyalty_points + $8,
         updated_at = now()
       WHERE phone = $1`,
      [targetPhone, source.rows[0].name, source.rows[0].phone2, source.rows[0].address_details,
       source.rows[0].delivery_area_id, source.rows[0].distinguishing_mark, source.rows[0].notes,
       source.rows[0].loyalty_points]
    );
    await client.query("DELETE FROM customers WHERE phone = $1", [sourcePhone]);

    await logAudit(client, {
      userId: req.user.id, action: "CUSTOMER_MERGED", entityType: "customer", entityId: null,
      oldValues: source.rows[0], newValues: { mergedInto: targetPhone }, req,
    });
    await client.query("COMMIT");
    const merged = await pool.query("SELECT * FROM customers WHERE phone = $1", [targetPhone]);
    res.json(merged.rows[0]);
  } catch (err) {
    await client.query("ROLLBACK");
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ---------------- المرحلة 7M: دفتر عناوين العميل (عنوان واحد أو أكتر) ----------------

// GET /api/customers/:phone/addresses - كل عناوين العميل المحفوظة (الافتراضي أولًا)
router.get("/:phone/addresses", requireAuth, canView, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT ca.id, ca.label, ca.address_details, ca.delivery_area_id, da.name AS delivery_area_name,
              ca.distinguishing_mark, ca.is_default, ca.created_at
       FROM customer_addresses ca
       LEFT JOIN delivery_areas da ON da.id = ca.delivery_area_id
       WHERE ca.customer_phone = $1
       ORDER BY ca.is_default DESC, ca.created_at DESC`,
      [req.params.phone]
    );
    res.json(result.rows.map((r) => ({
      id: r.id, label: r.label, addressDetails: r.address_details,
      deliveryAreaId: r.delivery_area_id, deliveryAreaName: r.delivery_area_name,
      distinguishingMark: r.distinguishing_mark, isDefault: r.is_default, createdAt: r.created_at,
    })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/customers/:phone/addresses - إضافة عنوان جديد (بينشئ العميل نفسه لو مش موجود بعد)
router.post("/:phone/addresses", requireAuth, canManageAddresses, async (req, res) => {
  const { phone } = req.params;
  const { label, addressDetails, deliveryAreaId, distinguishingMark, isDefault } = req.body;
  if (!addressDetails) return res.status(400).json({ error: "العنوان التفصيلي مطلوب" });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO customers (phone) VALUES ($1) ON CONFLICT (phone) DO NOTHING`, [phone]
    );
    if (isDefault) {
      await client.query(`UPDATE customer_addresses SET is_default = FALSE WHERE customer_phone = $1`, [phone]);
    }
    const result = await client.query(
      `INSERT INTO customer_addresses (customer_phone, label, address_details, delivery_area_id, distinguishing_mark, is_default)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [phone, label || null, addressDetails, deliveryAreaId || null, distinguishingMark || null, !!isDefault]
    );
    await client.query("COMMIT");
    const row = result.rows[0];
    res.status(201).json({
      id: row.id, label: row.label, addressDetails: row.address_details,
      deliveryAreaId: row.delivery_area_id, distinguishingMark: row.distinguishing_mark,
      isDefault: row.is_default, createdAt: row.created_at,
    });
  } catch (err) {
    await client.query("ROLLBACK");
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// PATCH /api/customers/:phone/addresses/:id - تعديل عنوان محفوظ
router.patch("/:phone/addresses/:id", requireAuth, canManageAddresses, async (req, res) => {
  const { phone, id } = req.params;
  const { label, addressDetails, deliveryAreaId, distinguishingMark, isDefault } = req.body;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const existing = await client.query(
      `SELECT * FROM customer_addresses WHERE id = $1 AND customer_phone = $2`, [id, phone]
    );
    if (existing.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "العنوان غير موجود" });
    }
    if (isDefault === true) {
      await client.query(`UPDATE customer_addresses SET is_default = FALSE WHERE customer_phone = $1`, [phone]);
    }
    const result = await client.query(
      `UPDATE customer_addresses SET
         label = COALESCE($3, label),
         address_details = COALESCE($4, address_details),
         delivery_area_id = COALESCE($5, delivery_area_id),
         distinguishing_mark = COALESCE($6, distinguishing_mark),
         is_default = COALESCE($7, is_default),
         updated_at = now()
       WHERE id = $1 AND customer_phone = $2 RETURNING *`,
      [id, phone, label ?? null, addressDetails ?? null, deliveryAreaId ?? null, distinguishingMark ?? null, isDefault ?? null]
    );
    await client.query("COMMIT");
    const row = result.rows[0];
    res.json({
      id: row.id, label: row.label, addressDetails: row.address_details,
      deliveryAreaId: row.delivery_area_id, distinguishingMark: row.distinguishing_mark,
      isDefault: row.is_default,
    });
  } catch (err) {
    await client.query("ROLLBACK");
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// DELETE /api/customers/:phone/addresses/:id - حذف عنوان محفوظ
router.delete("/:phone/addresses/:id", requireAuth, canDeleteAddress, async (req, res) => {
  const { phone, id } = req.params;
  try {
    const result = await pool.query(
      `DELETE FROM customer_addresses WHERE id = $1 AND customer_phone = $2 RETURNING id`, [id, phone]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: "العنوان غير موجود" });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
