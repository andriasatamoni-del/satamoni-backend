-- ============================================================
-- Satamoni Central Database Schema
-- مبني على منطق التقرير اليومي الحالي (إكسل) — نفس الأعمدة والمفاهيم
-- ============================================================

CREATE TABLE branches (
  id            SERIAL PRIMARY KEY,
  name          TEXT NOT NULL,            -- محرم بك / الإبراهيمية / العصافرة
  address       TEXT,
  phone         TEXT,
  hours         TEXT,
  lat           NUMERIC,
  lng           NUMERIC,
  is_central_kitchen BOOLEAN DEFAULT FALSE, -- TRUE لسجل سنتر كيتشن
  opening_debt_to_kitchen NUMERIC DEFAULT 0, -- الرصيد الافتتاحي المستحق للمخزن الرئيسي
  created_at    TIMESTAMPTZ DEFAULT now()
);

-- ---------------- المستخدمين والصلاحيات ----------------
CREATE TABLE users (
  id            SERIAL PRIMARY KEY,
  branch_id     INTEGER REFERENCES branches(id), -- NULL = صلاحية على كل الفروع (إدارة)
  name          TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('admin', 'branch_manager', 'accountant', 'cashier', 'callcenter')),
  is_active     BOOLEAN DEFAULT TRUE,
  created_at    TIMESTAMPTZ DEFAULT now()
);

-- ---------------- المنيو ----------------
CREATE TABLE menu_categories (
  id    SERIAL PRIMARY KEY,
  name  TEXT NOT NULL UNIQUE             -- بيتزا / الفطير الحادق / البرجر ...
);

CREATE TABLE menu_items (
  id            SERIAL PRIMARY KEY,
  category_id   INTEGER REFERENCES menu_categories(id),
  name          TEXT NOT NULL,
  description   TEXT,
  image_url     TEXT,
  is_best       BOOLEAN DEFAULT FALSE,
  is_active     BOOLEAN DEFAULT TRUE,
  created_at    TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE menu_item_variants (
  id          SERIAL PRIMARY KEY,
  item_id     INTEGER REFERENCES menu_items(id) ON DELETE CASCADE,
  label       TEXT NOT NULL,              -- وسط / كبير / عادي
  price       NUMERIC NOT NULL
);

-- ---------------- مناطق التوصيل وطرق الدفع ----------------
CREATE TABLE delivery_areas (
  id            SERIAL PRIMARY KEY,
  name          TEXT NOT NULL,
  fee           NUMERIC DEFAULT 0,
  min_order     NUMERIC DEFAULT 0,
  eta_minutes   INTEGER DEFAULT 30
);

CREATE TABLE payment_methods (
  id        SERIAL PRIMARY KEY,
  name      TEXT NOT NULL,                -- نقدي / فيزا / آجل / محفظة إلكترونية
  note      TEXT,                         -- رقم فودافون كاش / رابط انستاباي ...إلخ
  enabled   BOOLEAN DEFAULT TRUE
);

-- ---------------- الطلبات (من الموقع أو الكاشير) ----------------
CREATE TABLE orders (
  id                SERIAL PRIMARY KEY,
  branch_id         INTEGER REFERENCES branches(id),
  source            TEXT NOT NULL DEFAULT 'pos',  -- 'website' | 'pos'
  order_type        TEXT NOT NULL,                -- 'dinein' | 'takeaway' | 'delivery'
  table_number       TEXT,
  delivery_area_id  INTEGER REFERENCES delivery_areas(id),
  address_details   TEXT,
  customer_name     TEXT,
  customer_phone    TEXT,
  payment_method_id INTEGER REFERENCES payment_methods(id),
  created_by        INTEGER REFERENCES users(id), -- الكاشير اللي سجل الطلب (NULL لو أونلاين من الموقع)
  subtotal          NUMERIC NOT NULL DEFAULT 0,
  delivery_fee      NUMERIC NOT NULL DEFAULT 0,
  discount          NUMERIC NOT NULL DEFAULT 0,
  total             NUMERIC NOT NULL DEFAULT 0,
  status            TEXT NOT NULL DEFAULT 'pending', -- pending/confirmed/preparing/done/cancelled
  created_at        TIMESTAMPTZ DEFAULT now(),
  sync_uuid         UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE, -- هوية ثابتة عبر الفروع لمزامنة السيرفر المركزي
  synced_at         TIMESTAMPTZ -- NULL يعني لسه محتاج يترفع للمركزي
);

CREATE TABLE order_items (
  id            SERIAL PRIMARY KEY,
  order_id      INTEGER REFERENCES orders(id) ON DELETE CASCADE,
  item_id       INTEGER REFERENCES menu_items(id),
  variant_id    INTEGER REFERENCES menu_item_variants(id),
  quantity      INTEGER NOT NULL DEFAULT 1,
  unit_price    NUMERIC NOT NULL,
  line_total    NUMERIC NOT NULL
);

-- ---------------- الكاش اليومي لكل فرع (بديل شيت الفرع) ----------------
CREATE TABLE daily_cash_sessions (
  id                    SERIAL PRIMARY KEY,
  branch_id             INTEGER REFERENCES branches(id),
  business_date         DATE NOT NULL,
  opening_cash          NUMERIC DEFAULT 0,
  cash_sales            NUMERIC DEFAULT 0,
  card_sales            NUMERIC DEFAULT 0,
  credit_sales          NUMERIC DEFAULT 0,     -- مبيعات آجل
  delivery_app_sales    NUMERIC DEFAULT 0,
  cash_paid_to_kitchen   NUMERIC DEFAULT 0,     -- سدادات نقدية للمخزن الرئيسي
  other_cash_payments   NUMERIC DEFAULT 0,
  expected_closing_cash NUMERIC DEFAULT 0,
  actual_counted_cash   NUMERIC DEFAULT 0,
  cash_difference       NUMERIC DEFAULT 0,      -- فرق الكاش
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(), -- بيتحدث كل تعديل، عشان المزامنة تعرف تبعت النسخة الأحدث
  sync_uuid             UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  synced_at             TIMESTAMPTZ,
  UNIQUE(branch_id, business_date)
);

-- ---------------- المصروفات ----------------
CREATE TABLE expenses (
  id            SERIAL PRIMARY KEY,
  branch_id     INTEGER REFERENCES branches(id),
  business_date DATE NOT NULL,
  category      TEXT NOT NULL,   -- رواتب / إيجار / مرافق / صيانة / أخرى
  amount        NUMERIC NOT NULL,
  notes         TEXT,
  sync_uuid     UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  synced_at     TIMESTAMPTZ
);

-- ---------------- المشتريات والتحويلات ----------------
CREATE TABLE purchases (
  id            SERIAL PRIMARY KEY,
  branch_id     INTEGER REFERENCES branches(id),  -- الفرع أو سنتر كيتشن
  business_date DATE NOT NULL,
  category      TEXT,            -- لحوم/خضار/بقالة/أخرى (لو سنتر كيتشن) أو مباشر (لو فرع)
  amount        NUMERIC NOT NULL,
  from_kitchen  BOOLEAN DEFAULT FALSE, -- مشتريات من سنتر كيتشن بالتكلفة
  notes         TEXT,
  sync_uuid     UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  synced_at     TIMESTAMPTZ
);

CREATE TABLE kitchen_transfers (
  id              SERIAL PRIMARY KEY,
  to_branch_id    INTEGER REFERENCES branches(id),
  business_date   DATE NOT NULL,
  amount_at_cost  NUMERIC NOT NULL,
  notes           TEXT
);

-- ---------------- مديونية الفروع للمخزن الرئيسي (كمورد) ----------------
CREATE TABLE supplier_ledger_entries (
  id            SERIAL PRIMARY KEY,
  branch_id     INTEGER REFERENCES branches(id),
  entry_date    DATE NOT NULL,
  document_no   TEXT,
  entry_type    TEXT,           -- مشتريات / إذن صرف نقدية / إيصال استلام نقدية
  invoice_amount NUMERIC DEFAULT 0,   -- فواتير (تزود المديونية)
  payment_amount NUMERIC DEFAULT 0,   -- سدادات (تقلل المديونية)
  notes         TEXT,
  created_by    TEXT
);

-- ---------------- المخزون الفعلي ووصفات الأصناف (BOM) ----------------
CREATE TABLE inventory_items (
  id            SERIAL PRIMARY KEY,
  name          TEXT NOT NULL UNIQUE,        -- دقيق / جبنة موتزاريلا / زيت ...
  unit          TEXT NOT NULL,               -- كيلو / لتر / قطعة
  created_at    TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE branch_inventory_stock (
  id                SERIAL PRIMARY KEY,
  branch_id         INTEGER REFERENCES branches(id),
  inventory_item_id INTEGER REFERENCES inventory_items(id),
  quantity          NUMERIC NOT NULL DEFAULT 0,
  UNIQUE(branch_id, inventory_item_id)
);

-- كام وحدة من كل مكوّن بتتاخد لما يتباع variant واحد (الوصفة/BOM)
CREATE TABLE menu_item_variant_ingredients (
  id                  SERIAL PRIMARY KEY,
  variant_id          INTEGER REFERENCES menu_item_variants(id) ON DELETE CASCADE,
  inventory_item_id   INTEGER REFERENCES inventory_items(id),
  quantity_per_unit   NUMERIC NOT NULL,
  UNIQUE(variant_id, inventory_item_id)
);

-- سجل حركة المخزون (بديل الجرد اليدوي بالإكسل)
CREATE TABLE inventory_movements (
  id                SERIAL PRIMARY KEY,
  branch_id         INTEGER REFERENCES branches(id),
  inventory_item_id INTEGER REFERENCES inventory_items(id),
  movement_type     TEXT NOT NULL CHECK (movement_type IN ('purchase', 'sale_deduction', 'transfer_in', 'transfer_out', 'adjustment')),
  quantity          NUMERIC NOT NULL,        -- موجب = زيادة، سالب = نقصان
  order_id          INTEGER REFERENCES orders(id),
  business_date     DATE NOT NULL DEFAULT CURRENT_DATE,
  notes             TEXT,
  created_by        INTEGER REFERENCES users(id),
  created_at        TIMESTAMPTZ DEFAULT now()
);

-- ---------------- العملاء (CRM) - لدعم كول سنتر وتاريخ الطلبات ----------------
CREATE TABLE customers (
  id              SERIAL PRIMARY KEY,
  phone           TEXT NOT NULL UNIQUE,
  name            TEXT,
  notes           TEXT,             -- ملاحظات كول سنتر (عنوان مفضل، شكوى سابقة، ...)
  loyalty_points  INTEGER DEFAULT 0,
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now()
);

-- ---------------- الموارد البشرية: شيفتات وحضور/انصراف ----------------
CREATE TABLE shifts (
  id            SERIAL PRIMARY KEY,
  user_id       INTEGER REFERENCES users(id),
  branch_id     INTEGER REFERENCES branches(id),
  shift_date    DATE NOT NULL,
  start_time    TIME NOT NULL,
  end_time      TIME NOT NULL,
  notes         TEXT,
  created_at    TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE attendance_records (
  id            SERIAL PRIMARY KEY,
  user_id       INTEGER REFERENCES users(id),
  branch_id     INTEGER REFERENCES branches(id),
  business_date DATE NOT NULL DEFAULT CURRENT_DATE,
  clock_in      TIMESTAMPTZ NOT NULL DEFAULT now(),
  clock_out     TIMESTAMPTZ
);

-- ---------------- رصيد المخزون الشهري ----------------
CREATE TABLE inventory_snapshots (
  id                  SERIAL PRIMARY KEY,
  branch_id           INTEGER REFERENCES branches(id),
  period_year         INTEGER NOT NULL,
  period_month        INTEGER NOT NULL,
  opening_stock_value NUMERIC DEFAULT 0,
  closing_stock_value NUMERIC DEFAULT 0,
  UNIQUE(branch_id, period_year, period_month)
);

-- ============================================================
-- Views مفيدة للداشبورد (بديل شيت "لوحة التحكم")
-- ============================================================
CREATE VIEW v_daily_branch_summary AS
SELECT
  b.id AS branch_id,
  b.name AS branch_name,
  dcs.business_date,
  (dcs.cash_sales + dcs.card_sales + dcs.credit_sales + dcs.delivery_app_sales) AS total_sales,
  dcs.credit_sales,
  COALESCE(exp.total_expenses, 0) AS total_expenses,
  COALESCE(pur.total_purchases, 0) AS total_purchases,
  dcs.cash_difference
FROM branches b
JOIN daily_cash_sessions dcs ON dcs.branch_id = b.id
LEFT JOIN (
  SELECT branch_id, business_date, SUM(amount) AS total_expenses
  FROM expenses GROUP BY branch_id, business_date
) exp ON exp.branch_id = b.id AND exp.business_date = dcs.business_date
LEFT JOIN (
  SELECT branch_id, business_date, SUM(amount) AS total_purchases
  FROM purchases GROUP BY branch_id, business_date
) pur ON pur.branch_id = b.id AND pur.business_date = dcs.business_date
WHERE b.is_central_kitchen = FALSE;

-- إحصائيات كل عميل من تاريخ طلباته الفعلي (بديل الاعتماد على شيت يدوي وقت المكالمة)
CREATE VIEW v_customer_order_stats AS
SELECT
  customer_phone AS phone,
  COUNT(*) AS orders_count,
  SUM(total) AS total_spent,
  MAX(created_at) AS last_order_at
FROM orders
WHERE customer_phone IS NOT NULL
GROUP BY customer_phone;
