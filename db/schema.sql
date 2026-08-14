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
  supports_dine_in BOOLEAN DEFAULT TRUE, -- هل الفرع ده فيه صالة تناول داخلي (يظهر خيار "صالة" في شاشة البيع)
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
  created_at    TIMESTAMPTZ DEFAULT now(),
  UNIQUE(category_id, name)
);

CREATE TABLE menu_item_variants (
  id            SERIAL PRIMARY KEY,
  item_id       INTEGER REFERENCES menu_items(id) ON DELETE CASCADE,
  label         TEXT NOT NULL,              -- وسط / كبير / عادي
  price         NUMERIC NOT NULL,           -- سعر الفرع (كاشير/موقع/كول سنتر)
  talabat_price NUMERIC,                    -- سعر تطبيق طلبات (NULL = الصنف مش مباع على طلبات حاليًا)
  UNIQUE(item_id, label)
);

-- ---------------- العروض/الكومبوهات (أكتر من صنف بسعر واحد) ----------------
CREATE TABLE combos (
  id            SERIAL PRIMARY KEY,
  name          TEXT NOT NULL UNIQUE,
  price         NUMERIC NOT NULL,
  is_active     BOOLEAN DEFAULT TRUE,
  created_at    TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE combo_items (
  id            SERIAL PRIMARY KEY,
  combo_id      INTEGER REFERENCES combos(id) ON DELETE CASCADE,
  variant_id    INTEGER REFERENCES menu_item_variants(id),
  quantity      INTEGER NOT NULL DEFAULT 1,
  UNIQUE(combo_id, variant_id)
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
  kind      TEXT NOT NULL DEFAULT 'cash' CHECK (kind IN ('cash', 'card_or_wallet', 'credit')),
  -- cash: كاش، بيتحصّل لحظة البيع أوتوماتيك. card_or_wallet: فيزا/محفظة/إنستاباي، بيفضل "تحت التحصيل"
  -- لحد ما يتأكد وصول الفلوس فعليًا. credit: آجل (زي طلبات آجل)، بيتحصّل في تسوية شهرية.
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
  -- دورة حياة الطلب: تحت التحضير -> (للدليفري بس) في الطريق -> مكتمل/تم التسليم، أو ملغي في أي وقت
  status            TEXT NOT NULL DEFAULT 'preparing'
                      CHECK (status IN ('preparing', 'out_for_delivery', 'completed', 'cancelled')),
  driver_name       TEXT, -- اسم الطيار اللي معاه الأوردر (بيتسجل وقت التحويل لحالة "في الطريق")
  -- حالة التحصيل: مستقلة عن حالة الطلب - كاش بيتسجل "محصّل" أوتوماتيك، فيزا/محفظة/آجل "تحت التحصيل" لحد ما يتأكد
  payment_status    TEXT NOT NULL DEFAULT 'collected' CHECK (payment_status IN ('collected', 'pending_collection')),
  created_at        TIMESTAMPTZ DEFAULT now(),
  sync_uuid         UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE, -- هوية ثابتة عبر الفروع لمزامنة السيرفر المركزي
  synced_at         TIMESTAMPTZ -- NULL يعني لسه محتاج يترفع للمركزي
);

-- سجل كل تغيير في حالة الطلب (بديل "نقدر نرجع لكل سجل الأوردرات")
CREATE TABLE order_status_log (
  id          SERIAL PRIMARY KEY,
  order_id    INTEGER REFERENCES orders(id) ON DELETE CASCADE,
  status      TEXT NOT NULL,
  changed_by  INTEGER REFERENCES users(id),
  notes       TEXT,
  changed_at  TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE order_items (
  id                       SERIAL PRIMARY KEY,
  order_id                 INTEGER REFERENCES orders(id) ON DELETE CASCADE,
  item_id                  INTEGER REFERENCES menu_items(id),
  variant_id               INTEGER REFERENCES menu_item_variants(id),
  combo_id                 INTEGER REFERENCES combos(id), -- لو السطر ده عرض/كومبو مش صنف مفرد (item_id/variant_id بيبقوا NULL)
  quantity                 INTEGER NOT NULL DEFAULT 1,
  unit_price                NUMERIC NOT NULL,
  line_total                NUMERIC NOT NULL,
  cost_at_sale              NUMERIC, -- تكلفة الريسبي وقت البيع فعليًا (مش محسوبة لحظيًا من الريسبي الحالي) - لدقة قائمة الدخل التاريخية
  cost_at_sale_incomplete   BOOLEAN NOT NULL DEFAULT FALSE -- TRUE لو في مكوّن من غير unit_cost وقت البيع (التكلفة أقل من الحقيقي)
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
  unit_cost     NUMERIC,                     -- تكلفة الوحدة (لحساب تكلفة الريسبي مستقبلًا) - اختياري
  item_type     TEXT NOT NULL DEFAULT 'raw' CHECK (item_type IN ('raw', 'manufactured')), -- خام (بيتشترى) أو مصنّع (بيتعمل في السنتر كيتشن)
  created_at    TIMESTAMPTZ DEFAULT now()
);

-- ---------------- الموردين (شركات المواد الخام) ----------------
CREATE TABLE suppliers (
  id            SERIAL PRIMARY KEY,
  name          TEXT NOT NULL UNIQUE,
  phone         TEXT,
  notes         TEXT,
  created_at    TIMESTAMPTZ DEFAULT now()
);

-- سعر كل مكوّن عند كل مورد بيبيعه (لمقارنة الأسعار واختيار الأرخص)
CREATE TABLE inventory_item_suppliers (
  id                SERIAL PRIMARY KEY,
  inventory_item_id INTEGER REFERENCES inventory_items(id) ON DELETE CASCADE,
  supplier_id       INTEGER REFERENCES suppliers(id) ON DELETE CASCADE,
  unit_price        NUMERIC NOT NULL,
  UNIQUE(inventory_item_id, supplier_id)
);

-- وصفة تصنيع صنف مصنّع من مكونات خام/مصنّعة تانية (كام وحدة من كل مكوّن داخل عشان تنتج وحدة واحدة من الناتج)
CREATE TABLE manufacturing_recipe_items (
  id                 SERIAL PRIMARY KEY,
  output_item_id     INTEGER REFERENCES inventory_items(id) ON DELETE CASCADE, -- الصنف المصنّع الناتج
  input_item_id      INTEGER REFERENCES inventory_items(id), -- مكوّن داخل في التصنيع
  quantity_per_unit  NUMERIC NOT NULL,
  UNIQUE(output_item_id, input_item_id)
);

-- ---------------- طلبيات الفروع للسنتر كيتشن ----------------
CREATE TABLE kitchen_orders (
  id            SERIAL PRIMARY KEY,
  branch_id     INTEGER REFERENCES branches(id),  -- الفرع الطالب
  business_date DATE NOT NULL DEFAULT CURRENT_DATE,
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'fulfilled', 'cancelled')),
  notes         TEXT,
  created_by    INTEGER REFERENCES users(id),
  created_at    TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE kitchen_order_items (
  id                  SERIAL PRIMARY KEY,
  kitchen_order_id    INTEGER REFERENCES kitchen_orders(id) ON DELETE CASCADE,
  inventory_item_id   INTEGER REFERENCES inventory_items(id),
  quantity_requested  NUMERIC NOT NULL
);

CREATE TABLE kitchen_transfers (
  id               SERIAL PRIMARY KEY,
  to_branch_id     INTEGER REFERENCES branches(id),
  business_date    DATE NOT NULL,
  amount_at_cost   NUMERIC NOT NULL,
  notes            TEXT,
  kitchen_order_id INTEGER REFERENCES kitchen_orders(id) -- لو التحويل ده تنفيذ لطلبية فرع (اختياري)
);

-- بنود التحويل بالتفصيل (أصناف وكميات) - amount_at_cost فوق بيتحسب من مجموعها
CREATE TABLE kitchen_transfer_items (
  id                    SERIAL PRIMARY KEY,
  kitchen_transfer_id   INTEGER REFERENCES kitchen_transfers(id) ON DELETE CASCADE,
  inventory_item_id     INTEGER REFERENCES inventory_items(id),
  quantity              NUMERIC NOT NULL
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
  movement_type     TEXT NOT NULL CHECK (movement_type IN ('purchase', 'sale_deduction', 'transfer_in', 'transfer_out', 'adjustment', 'production_in', 'production_out')),
  quantity          NUMERIC NOT NULL,        -- موجب = زيادة، سالب = نقصان
  order_id          INTEGER REFERENCES orders(id),
  business_date     DATE NOT NULL DEFAULT CURRENT_DATE,
  notes             TEXT,
  created_by        INTEGER REFERENCES users(id),
  created_at        TIMESTAMPTZ DEFAULT now()
);

-- ---------------- العملاء (CRM) - لدعم كول سنتر وتاريخ الطلبات ----------------
CREATE TABLE customers (
  id                   SERIAL PRIMARY KEY,
  phone                TEXT NOT NULL UNIQUE,
  phone2               TEXT,             -- رقم تليفون تاني (اختياري)
  name                 TEXT,
  address_details      TEXT,             -- العنوان بالتفصيل (شارع/عمارة/دور/شقة) - العنوان الافتراضي المحفوظ
  delivery_area_id     INTEGER REFERENCES delivery_areas(id), -- المنطقة الافتراضية
  distinguishing_mark  TEXT,             -- علامة مميزة (بجوار كذا، لون العمارة...) تساعد الطيار يوصل
  notes                TEXT,             -- ملاحظات كول سنتر (شكوى سابقة، تفضيلات، ...)
  loyalty_points       INTEGER DEFAULT 0,
  created_at           TIMESTAMPTZ DEFAULT now(),
  updated_at           TIMESTAMPTZ DEFAULT now()
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

-- ---------------- نظام الرواتب (يحسب أوتوماتيك من شيت البصمة) ----------------
-- ملحوظة: ده منفصل عن users/shifts/attendance_records اللي فوق (خاصة بحسابات الدخول والشيفتات
-- المجدولة للموظفين اللي بيستخدموا شاشات النظام). "employees" هنا هي قاعدة بيانات الرواتب الكاملة
-- (كل الموظفين الفعليين، أغلبهم من غير حساب دخول - شيفات وسائقين وعمال مطبخ...) واللي منها بيتحسب
-- المرتب الفعلي من بيانات البصمة.

CREATE TABLE payroll_settings (
  id                               INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1), -- صف واحد بس
  default_working_days            INTEGER NOT NULL DEFAULT 26,
  paid_leave_days_per_month       INTEGER NOT NULL DEFAULT 4,
  payroll_to_sales_warn_ratio     NUMERIC NOT NULL DEFAULT 0.3,
  standard_shift_hours            NUMERIC NOT NULL DEFAULT 10,
  overtime_multiplier             NUMERIC NOT NULL DEFAULT 1.5,
  min_overtime_hours              NUMERIC NOT NULL DEFAULT 1,
  allowed_late_exemptions         INTEGER NOT NULL DEFAULT 3,
  missed_punch_deduction_fraction NUMERIC NOT NULL DEFAULT 0.5,
  morning_shift_start              TIME NOT NULL DEFAULT '10:00',
  evening_shift_start              TIME NOT NULL DEFAULT '20:00'
);
INSERT INTO payroll_settings (id) VALUES (1);

-- سلم خصم التأخير: من دقيقة (شامل) لغاية دقيقة (غير شامل) -> نسبة الخصم من يوم العمل
CREATE TABLE late_deduction_tiers (
  id                 SERIAL PRIMARY KEY,
  from_minute        INTEGER NOT NULL,
  to_minute          INTEGER NOT NULL,
  deduction_fraction NUMERIC NOT NULL
);
INSERT INTO late_deduction_tiers (from_minute, to_minute, deduction_fraction) VALUES
  (0, 16, 0), (16, 31, 0.25), (31, 61, 0.5), (61, 999999, 1);

CREATE TABLE employees (
  id                     SERIAL PRIMARY KEY,
  name                   TEXT NOT NULL,
  department             TEXT NOT NULL, -- بيتزا/فطير/تشغيل الفرع/الإدارة/حسابات/كول سنتر/المطبخ المركزي
  job_title              TEXT,
  attendance_system      TEXT NOT NULL CHECK (attendance_system IN ('fingerprint_auto', 'manual', 'none')),
  hire_date              DATE,
  base_salary            NUMERIC NOT NULL DEFAULT 0,
  working_days_per_month INTEGER NOT NULL DEFAULT 26,
  shift                  TEXT CHECK (shift IN ('morning', 'evening', 'flexible')), -- بيني = flexible
  wage_type              TEXT NOT NULL DEFAULT 'fixed_monthly' CHECK (wage_type IN ('fixed_monthly', 'hourly')),
  hourly_rate            NUMERIC NOT NULL DEFAULT 0,
  phone                  TEXT,
  notes                  TEXT,
  is_active              BOOLEAN NOT NULL DEFAULT TRUE,
  count_day_31           BOOLEAN NOT NULL DEFAULT FALSE,
  restricted_branch_id   INTEGER REFERENCES branches(id), -- "احسب الراتب من فرع واحد بس" (اختياري)
  created_at             TIMESTAMPTZ DEFAULT now()
);

-- كود بصمة الموظف عند كل فرع (موظف ممكن يكون ليه كود في أكتر من فرع لو بيتنقل زي الطيار)
CREATE TABLE employee_fingerprint_codes (
  id          SERIAL PRIMARY KEY,
  employee_id INTEGER REFERENCES employees(id) ON DELETE CASCADE,
  branch_id   INTEGER REFERENCES branches(id),
  device_code TEXT NOT NULL,
  UNIQUE(branch_id, device_code),
  UNIQUE(employee_id, branch_id)
);

-- بصمات الدخول/الخروج الخام المستوردة من تصدير جهاز البصمة (يوم بدون سطر هنا = إجازة تلقائيًا)
CREATE TABLE attendance_punches (
  id          SERIAL PRIMARY KEY,
  branch_id   INTEGER REFERENCES branches(id),
  device_code TEXT NOT NULL,
  punch_date  DATE NOT NULL,
  clock_in    TIME,
  clock_out   TIME,
  exempted    BOOLEAN NOT NULL DEFAULT FALSE, -- "إذن تأخير؟" - يشيل خصم التأخير ليوم بعينه يدويًا
  imported_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(branch_id, device_code, punch_date)
);

-- حضور المطبخ المركزي (بدون جهاز بصمة) - إدخال شهري يدوي لكل موظف
CREATE TABLE central_kitchen_manual_attendance (
  id                  SERIAL PRIMARY KEY,
  employee_id         INTEGER REFERENCES employees(id) ON DELETE CASCADE,
  year                INTEGER NOT NULL,
  month               INTEGER NOT NULL,
  present_days        NUMERIC NOT NULL DEFAULT 0,
  absent_days         NUMERIC NOT NULL DEFAULT 0,
  total_late_minutes  NUMERIC NOT NULL DEFAULT 0,
  manual_deduction    NUMERIC NOT NULL DEFAULT 0,
  notes               TEXT,
  UNIQUE(employee_id, year, month)
);

-- السلف والجزاءات والمكافآت
CREATE TABLE payroll_adjustments (
  id              SERIAL PRIMARY KEY,
  employee_id     INTEGER REFERENCES employees(id) ON DELETE CASCADE,
  entry_date      DATE NOT NULL,
  adjustment_type TEXT NOT NULL CHECK (adjustment_type IN ('advance', 'penalty', 'bonus')), -- سلفة/جزاء/مكافأة
  amount          NUMERIC NOT NULL,
  notes           TEXT,
  created_by      INTEGER REFERENCES users(id),
  created_at      TIMESTAMPTZ DEFAULT now()
);

-- مبيعات كل قسم في كل فرع شهريًا (لمقارنة تكلفة الرواتب بالمبيعات في لوحة التحكم)
CREATE TABLE department_sales (
  id           SERIAL PRIMARY KEY,
  branch_id    INTEGER REFERENCES branches(id),
  department   TEXT NOT NULL,
  year         INTEGER NOT NULL,
  month        INTEGER NOT NULL,
  sales_amount NUMERIC NOT NULL DEFAULT 0,
  UNIQUE(branch_id, department, year, month)
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
