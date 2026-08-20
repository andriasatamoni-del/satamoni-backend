-- ============================================================
-- Satamoni Central Database Schema
-- مبني على منطق التقرير اليومي الحالي (إكسل) — نفس الأعمدة والمفاهيم
-- ============================================================

-- سجل خفيف لتتبّع أي تحديث مستقبلي على القاعدة (اسم + وقت التطبيق) - مش migration runner كامل (ده
-- محتاج إعادة تصميم أكبر لطريقة نشر التحديثات الحالية، وده مخاطرة مش لازمة دلوقتي)، بس بيضمن إن أي
-- سكريبت تحديث جديد يقدر يتأكد "هل ده اتطبّق قبل كده؟" قبل ما يعمل ALTER تاني على نفس العمود/الجدول -
-- الاستخدام: INSERT INTO schema_migrations (name) VALUES ('اسم-وصفي-فريد') ON CONFLICT (name) DO NOTHING
-- في أول أي سكريبت تحديث جديد، وتتأكد من النتيجة قبل ما تكمل باقي الـALTER statements
CREATE TABLE schema_migrations (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

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
  pin_hash      TEXT, -- PIN قصير (4-6 أرقام) لمدير الفرع/الأدمن بس - لموافقة الخصومات الكبيرة واسترجاع الطلبات
                       -- من غير ما يسجلوا خروج ودخول تاني على جهاز الكاشير
  created_at    TIMESTAMPTZ DEFAULT now()
);

-- إعدادات نقطة البيع (صف واحد بس، زي payroll_settings)
CREATE TABLE pos_settings (
  id                             INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  max_unapproved_discount_percent NUMERIC NOT NULL DEFAULT 0.10, -- خصم لغاية 10% الكاشير يعمله لوحده، فوق كده لازم موافقة PIN
  discount_manager_max_percent   NUMERIC NOT NULL DEFAULT 0.15, -- خصم لغاية 15% مدير الفرع يقدر يوافق عليه، فوق كده لازم أدمن
  loyalty_points_per_egp         NUMERIC NOT NULL DEFAULT 0.1, -- نقاط ولاء لكل جنيه يتصرف (افتراضيًا نقطة واحدة لكل 10 ج.م)
  batch_consumption_method       TEXT NOT NULL DEFAULT 'FEFO' CHECK (batch_consumption_method IN ('FEFO', 'FIFO')), -- طريقة الصرف من الدفعات: الأقرب انتهاءً أو الأقدم دخولًا
  production_variance_alert_percent NUMERIC NOT NULL DEFAULT 10 -- فرق الإنتاج (مخطط مقابل فعلي) فوق النسبة دي لازم له سبب مكتوب
);
INSERT INTO pos_settings (id) VALUES (1);

-- ---------------- المنيو ----------------
CREATE TABLE menu_categories (
  id             SERIAL PRIMARY KEY,
  name           TEXT NOT NULL UNIQUE,             -- بيتزا / الفطير الحادق / البرجر ...
  display_order  INTEGER NOT NULL DEFAULT 0,        -- ترتيب ظهور القسم في شاشة البيع (تصاعديًا)
  menu_group     TEXT NOT NULL DEFAULT 'regular' CHECK (menu_group IN ('regular', 'fasting')) -- منيو عادي أو منيو صيامي منفصل
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

-- مرفقات/توصيفات اختيارية للصنف (إضافة موتزريلا، بدون طماطم...) - بتتضاف كسطر إضافي في الطلب
-- بسعر زيادة (موجب) أو مجانًا (صفر)، وبيختارها الكاشير/الكول سنتر وقت إضافة الصنف للسلة
CREATE TABLE menu_item_modifiers (
  id            SERIAL PRIMARY KEY,
  item_id       INTEGER REFERENCES menu_items(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,              -- إضافة موتزريلا / بدون طماطم / بدون خضار ...
  price_delta   NUMERIC NOT NULL DEFAULT 0, -- السعر الافتراضي (لو مفيش سعر مخصوص لحجم معيّن في الجدول اللي تحت)
  is_active     BOOLEAN DEFAULT TRUE,
  UNIQUE(item_id, name)
);

-- سعر المرفق ممكن يختلف حسب حجم الصنف (مثلاً "اضافة سدق" سعرها على بيتزا وسط مختلف عن فطير كبير) -
-- لو مفيش صف هنا لحجم (variant) معيّن، السعر الافتراضي بييجي من menu_item_modifiers.price_delta
CREATE TABLE menu_item_modifier_variant_prices (
  id             SERIAL PRIMARY KEY,
  modifier_id    INTEGER NOT NULL REFERENCES menu_item_modifiers(id) ON DELETE CASCADE,
  variant_id     INTEGER NOT NULL REFERENCES menu_item_variants(id) ON DELETE CASCADE,
  price_delta    NUMERIC NOT NULL,
  UNIQUE(modifier_id, variant_id)
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
  -- خصم فوق الحد المسموح للكاشير من غير موافقة (pos_settings.max_unapproved_discount_percent)
  -- لازم يتسجل هنا مين المدير/الأدمن اللي وافق عليه (عن طريق PIN)
  discount_approved_by INTEGER REFERENCES users(id),
  total             NUMERIC NOT NULL DEFAULT 0,
  -- نقاط الولاء اللي اتضافت للعميل وقت إنشاء الطلب ده بالظبط (لو ليه رقم تليفون) - محفوظة هنا عشان
  -- لو الطلب اتلغى أو اتسترجع بعد كده، نقدر نرجّع نفس الكمية دي بالظبط من رصيد العميل (مش نعيد حسابها)
  loyalty_points_earned INTEGER NOT NULL DEFAULT 0,
  -- دورة حياة الطلب: تحت التحضير -> (للدليفري بس) في الطريق -> مكتمل/تم التسليم، أو ملغي في أي وقت
  status            TEXT NOT NULL DEFAULT 'preparing'
                      CHECK (status IN ('preparing', 'out_for_delivery', 'completed', 'cancelled')),
  driver_name       TEXT, -- اسم الطيار اللي معاه الأوردر (بيتسجل وقت التحويل لحالة "في الطريق")
  -- حالة التحصيل: مستقلة عن حالة الطلب - كاش بيتسجل "محصّل" أوتوماتيك، فيزا/محفظة/آجل "تحت التحصيل" لحد ما يتأكد
  payment_status    TEXT NOT NULL DEFAULT 'collected' CHECK (payment_status IN ('collected', 'pending_collection')),
  -- استرجاع طلب مكتمل بالغلط (Void) - بيرجّع حالته لـ 'cancelled' (يستبعده من الإيرادات زي أي إلغاء)
  -- بس بيتفرّق عن الإلغاء العادي قبل التنفيذ بالأعمدة دي، ولازم موافقة مدير/أدمن دايمًا
  voided            BOOLEAN NOT NULL DEFAULT FALSE,
  voided_by         INTEGER REFERENCES users(id),
  voided_at         TIMESTAMPTZ,
  void_reason       TEXT,
  created_at        TIMESTAMPTZ DEFAULT now(),
  sync_uuid         UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE, -- هوية ثابتة عبر الفروع لمزامنة السيرفر المركزي
  synced_at         TIMESTAMPTZ, -- NULL يعني لسه محتاج يترفع للمركزي
  -- مفتاح idempotency اختياري من الكاشير/الموقع - لو نفس المفتاح اتبعت مرتين (retry شبكة أو ضغط زرار
  -- مرتين) الطلب التاني مبيتسجلش تاني، بيترجع نفس نتيجة الأول. الحماية على مستوى الـUNIQUE INDEX
  -- نفسه (partial، بيسمح بـNULL متكرر) عشان تفضل atomic حتى مع طلبين متزامنين بالظبط
  idempotency_key   TEXT
);
CREATE UNIQUE INDEX idx_orders_idempotency_key ON orders(idempotency_key) WHERE idempotency_key IS NOT NULL;

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
  cost_at_sale_incomplete   BOOLEAN NOT NULL DEFAULT FALSE, -- TRUE لو في مكوّن من غير unit_cost وقت البيع (التكلفة أقل من الحقيقي)
  -- نسخة الوصفة اللي كانت ACTIVE وقت البيع ده بالظبط (المرحلة 3) - رابط تتبّع صريح للتكلفة النظرية
  -- التاريخية، منفصل عن cost_at_sale (اللي هو التكلفة الفعلية المحسوبة وقتها). NULL على الطلبات اللي
  -- اتسجلت قبل المرحلة 3 (محرك الوصفات لسه ما كانش موجود وقتها). الـFK متضاف بـALTER TABLE تحت بعد ما
  -- جدول recipe_versions نفسه يتعرّف (recipe_versions معرّف بعد كدة في الملف)
  recipe_version_id        INTEGER
);

-- المرفقات المختارة فعليًا في سطر الطلب - بتتسجل بسعرها واسمها وقت البيع (snapshot) عشان لو اتغير
-- سعر المرفق بعدين، الطلبات القديمة تفضل دقيقة زي ما هي بالظبط
CREATE TABLE order_item_modifiers (
  id             SERIAL PRIMARY KEY,
  order_item_id  INTEGER REFERENCES order_items(id) ON DELETE CASCADE,
  modifier_id    INTEGER REFERENCES menu_item_modifiers(id),
  name_at_sale   TEXT NOT NULL,
  price_at_sale  NUMERIC NOT NULL DEFAULT 0
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
-- بنود مصروفات ثابتة (تكويد) - الأدمن بس بيضيف/يعطّل بند، وأي حد بيسجل مصروف لازم يختار من الليستة
-- دي بدل ما يكتب نص حر (عشان التقارير تتجمع صح ومحدش يكتب نفس البند بصياغات مختلفة)
CREATE TABLE expense_categories (
  id              SERIAL PRIMARY KEY,
  name            TEXT NOT NULL UNIQUE,   -- رواتب / إيجار / مرافق / صيانة / أخرى ...
  is_active       BOOLEAN DEFAULT TRUE,
  alert_threshold NUMERIC, -- لو مصروف من البند ده تجاوز المبلغ ده، يتعلّم كـ"غريب" في تقرير المصروفات (اختياري)
  -- المرحلة 4B: حساب دفتر الأستاذ اللي المصروف ده بيترحّل عليه محاسبيًا - accounts معرّف في آخر الملف
  -- (قسم المحاسبة)، الـFK بيتضاف بـALTER TABLE هناك. NULL = يترحّل على "6900 مصروفات تشغيل أخرى" افتراضيًا
  account_id      INTEGER
);

INSERT INTO expense_categories (name) VALUES
  ('إيجار'), ('مرافق (كهرباء/مياه/غاز)'), ('صيانة'), ('نقل ومواصلات'),
  ('تسويق وإعلانات'), ('أدوات ومستلزمات'), ('رسوم وضرائب'), ('أخرى');

-- المرحلة 4B: بقت مربوطة اختياريًا بمورد/طريقة دفع وبدورة حياة محاسبية (DRAFT→SUBMITTED→APPROVED→
-- POSTED→CANCELLED) - المسار القديم (POST /api/expenses من غير أي حقل جديد) لسه شغال زي ما هو بالظبط
-- (status بيتسجل POSTED فورًا + قيد محاسبي تلقائي، مش DRAFT) عشان مفيش أي كسر لأي كود قديم بينادي عليه
CREATE TABLE expenses (
  id                SERIAL PRIMARY KEY,
  branch_id         INTEGER REFERENCES branches(id),
  business_date     DATE NOT NULL,
  category_id       INTEGER NOT NULL REFERENCES expense_categories(id),
  amount            NUMERIC NOT NULL,
  notes             TEXT,
  payment_method_id INTEGER REFERENCES payment_methods(id),
  -- supplier_id: suppliers معرّف بعد كدة في الملف - الـFK بيتضاف بـALTER TABLE هناك
  supplier_id       INTEGER,
  status            TEXT NOT NULL DEFAULT 'POSTED'
                    CHECK (status IN ('DRAFT', 'SUBMITTED', 'APPROVED', 'POSTED', 'CANCELLED')),
  created_by        INTEGER REFERENCES users(id),
  approved_by       INTEGER REFERENCES users(id),
  posted_by         INTEGER REFERENCES users(id),
  posted_at         TIMESTAMPTZ,
  cancelled_by      INTEGER REFERENCES users(id),
  cancelled_at      TIMESTAMPTZ,
  -- journal_entry_id: journal_entries معرّف في آخر الملف - الـFK بيتضاف هناك
  journal_entry_id  INTEGER,
  idempotency_key   TEXT,
  sync_uuid         UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  synced_at         TIMESTAMPTZ
);
CREATE UNIQUE INDEX idx_expenses_idempotency_key ON expenses(idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX idx_expenses_status ON expenses(status);
CREATE INDEX idx_expenses_supplier ON expenses(supplier_id);

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
  id                    SERIAL PRIMARY KEY,
  name                  TEXT NOT NULL UNIQUE,        -- دقيق / جبنة موتزاريلا / زيت ...
  unit                  TEXT NOT NULL,               -- كيلو / لتر / قطعة (وحدة تتبّع الرصيد الأساسية)
  unit_cost             NUMERIC,                     -- تكلفة الوحدة (لحساب تكلفة الريسبي مستقبلًا) - اختياري
  item_type             TEXT NOT NULL DEFAULT 'raw' CHECK (item_type IN ('raw', 'manufactured')), -- خام (بيتشترى) أو مصنّع (بيتعمل في السنتر كيتشن)
  allow_negative_stock  BOOLEAN NOT NULL DEFAULT FALSE, -- (قديم، مش مستخدم في الكود الجديد) - استبدله negative_stock_policy تحت
  -- سياسة الرصيد السالب: STRICT = ممنوع خالص مهما حصل (حتى لأدمن في نفس عملية البيع). ALLOW_WITH_APPROVAL =
  -- ممنوع للكاشير لوحده، بس مسموح بموافقة مدير/أدمن (PIN) وقت البيع، أو للأدوار المخوّلة أصلًا
  -- (تسوية/هالك/تحويل - دورهم نفسه هو الموافقة) - افتراضيًا STRICT لكل صنف جديد
  negative_stock_policy TEXT NOT NULL DEFAULT 'STRICT' CHECK (negative_stock_policy IN ('STRICT', 'ALLOW_WITH_APPROVAL')),
  created_at            TIMESTAMPTZ DEFAULT now()
);

-- ---------------- الموردين (شركات المواد الخام) ----------------
-- المرحلة 4A: name فضل زي ما هو (لتوافق كل الكود القديم اللي بيقرأه) - الحقول الجديدة كلها اختيارية،
-- name لسه هو الاسم المعروض الافتراضي لو legal_name/trade_name مش متسجلين. مفيش DELETE للموردين خالص -
-- مورد بقى مرتبط بمعاملات تاريخية (PO/GRN) بيتقفل بـstatus='BLOCKED'/'INACTIVE' مش بيتمسح
CREATE TABLE suppliers (
  id              SERIAL PRIMARY KEY,
  name            TEXT NOT NULL UNIQUE,
  supplier_code   TEXT UNIQUE,
  legal_name      TEXT,
  trade_name      TEXT,
  contact_person  TEXT,
  phone           TEXT,
  email           TEXT,
  address         TEXT,
  tax_id          TEXT,
  payment_terms   TEXT,   -- نص حر (زي "30 يوم من تاريخ الفاتورة") - مش enum، يختلف من مورد لمورد
  default_currency TEXT NOT NULL DEFAULT 'EGP',
  status          TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'INACTIVE', 'BLOCKED')),
  notes           TEXT,
  created_by      INTEGER REFERENCES users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- expenses.supplier_id اتعرّف قبل كدة في الملف (expenses جاي قبل suppliers) - الـFK بيتضاف هنا
ALTER TABLE expenses ADD CONSTRAINT fk_expenses_supplier FOREIGN KEY (supplier_id) REFERENCES suppliers(id);

-- سعر كل مكوّن عند كل مورد بيبيعه (لمقارنة الأسعار واختيار الأرخص) - جدول قديم بيتحدّث بالسعر الأحدث
-- بس (ON CONFLICT DO UPDATE)، مالوش تاريخ. لسه شغال زي ما هو لأي كود قديم بيقرأه - مش متضاف عليه أي حاجة
CREATE TABLE inventory_item_suppliers (
  id                SERIAL PRIMARY KEY,
  inventory_item_id INTEGER REFERENCES inventory_items(id) ON DELETE CASCADE,
  supplier_id       INTEGER REFERENCES suppliers(id) ON DELETE CASCADE,
  unit_price        NUMERIC NOT NULL,
  UNIQUE(inventory_item_id, supplier_id)
);

-- المرحلة 4A: نفس فكرة inventory_item_suppliers، لكن بتاريخ أسعار حقيقي (مطلوب صراحة: "Never overwrite
-- historical prices") - كل تغيير سعر = صف جديد effective_from = دلوقتي، والصف القديم بيتقفل
-- effective_to = دلوقتي (زي نمط recipe_versions "نسخة واحدة نشطة" بالظبط، مطبّق هنا على الأسعار)
CREATE TABLE supplier_items (
  id                     SERIAL PRIMARY KEY,
  supplier_id            INTEGER NOT NULL REFERENCES suppliers(id),
  inventory_item_id      INTEGER NOT NULL REFERENCES inventory_items(id),
  supplier_item_code     TEXT,
  purchase_unit          TEXT,             -- الوحدة اللي المورد بيبيع بيها (ممكن تختلف عن وحدة تخزين الصنف)
  conversion_factor      NUMERIC,          -- purchase_unit → وحدة تخزين الصنف (لو NULL، يتحسب من unit_conversions وقت الاستلام)
  unit_price             NUMERIC NOT NULL, -- سعر وحدة الشراء (purchase_unit)، مش وحدة التخزين بالضرورة
  currency               TEXT NOT NULL DEFAULT 'EGP',
  minimum_order_quantity NUMERIC,
  lead_time_days         INTEGER,
  preferred_supplier     BOOLEAN NOT NULL DEFAULT FALSE,
  effective_from         TIMESTAMPTZ NOT NULL DEFAULT now(),
  effective_to           TIMESTAMPTZ,      -- NULL = السعر الحالي الساري
  created_by             INTEGER REFERENCES users(id),
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- سعر ساري واحد بس لكل (مورد، صنف) في نفس اللحظة - مفروض على مستوى القاعدة نفسها
CREATE UNIQUE INDEX idx_supplier_items_one_current ON supplier_items(supplier_id, inventory_item_id) WHERE effective_to IS NULL;
CREATE INDEX idx_supplier_items_supplier ON supplier_items(supplier_id);
CREATE INDEX idx_supplier_items_item ON supplier_items(inventory_item_id);

-- ============================================================
-- المرحلة 4A: المشتريات (Procurement) - Supplier → Purchase Request → Purchase Order → Approval →
-- Goods Receipt → Inventory Ledger → Batch/Cost Layer. الاستلام (GRN) هو المصدر الوحيد اللي بيلمس
-- المخزون فعليًا - بيعدّي حصريًا من db/inventory-ledger.js (postInventoryMovement)، زي أي حركة تانية
-- في النظام، من غير أي استثناء أو تحديث مباشر على branch_inventory_stock
-- ============================================================

-- طلب شراء داخلي (الفرع/السنتر كيتشن بيطلب صنف يتشترى) - قبل أي التزام مع مورد بسعر/كمية محددة
CREATE TABLE purchase_requests (
  id             SERIAL PRIMARY KEY,
  branch_id      INTEGER NOT NULL REFERENCES branches(id),
  requested_by   INTEGER REFERENCES users(id),
  requested_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  required_date  DATE,
  reason         TEXT,
  status         TEXT NOT NULL DEFAULT 'DRAFT'
                 CHECK (status IN ('DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED', 'CONVERTED_TO_PO', 'CANCELLED')),
  approved_by    INTEGER REFERENCES users(id),
  approved_at    TIMESTAMPTZ,
  rejected_by    INTEGER REFERENCES users(id),
  rejection_reason TEXT,
  cancelled_by   INTEGER REFERENCES users(id),
  cancelled_at   TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_purchase_requests_branch ON purchase_requests(branch_id);
CREATE INDEX idx_purchase_requests_status ON purchase_requests(status);
CREATE INDEX idx_purchase_requests_created ON purchase_requests(created_at);

CREATE TABLE purchase_request_items (
  id                  SERIAL PRIMARY KEY,
  purchase_request_id INTEGER NOT NULL REFERENCES purchase_requests(id) ON DELETE CASCADE,
  inventory_item_id   INTEGER NOT NULL REFERENCES inventory_items(id),
  requested_quantity  NUMERIC NOT NULL,
  unit                TEXT,
  notes               TEXT
);
CREATE INDEX idx_purchase_request_items_request ON purchase_request_items(purchase_request_id);
CREATE INDEX idx_purchase_request_items_item ON purchase_request_items(inventory_item_id);

-- أمر شراء رسمي لمورد محدد - العمود idempotency_key بيحمي إنشاء PO مكرر لو نفس الطلب اتبعت مرتين
-- (retry شبكة) بنفس نمط orders.idempotency_key بالظبط (المرحلة 2.5)
CREATE TABLE purchase_orders (
  id                     SERIAL PRIMARY KEY,
  supplier_id            INTEGER NOT NULL REFERENCES suppliers(id),
  branch_id              INTEGER NOT NULL REFERENCES branches(id), -- فرع/سنتر كيتشن الاستلام
  purchase_request_id    INTEGER REFERENCES purchase_requests(id), -- NULL لو PO مباشر من غير طلب شراء سابق
  order_date             DATE NOT NULL DEFAULT CURRENT_DATE,
  expected_delivery_date DATE,
  payment_terms          TEXT,
  currency               TEXT NOT NULL DEFAULT 'EGP',
  subtotal               NUMERIC NOT NULL DEFAULT 0,
  discount               NUMERIC NOT NULL DEFAULT 0,
  tax                    NUMERIC NOT NULL DEFAULT 0,
  total                  NUMERIC NOT NULL DEFAULT 0,
  status                 TEXT NOT NULL DEFAULT 'DRAFT'
                         CHECK (status IN ('DRAFT', 'SUBMITTED', 'APPROVED', 'PARTIALLY_RECEIVED', 'FULLY_RECEIVED', 'CLOSED', 'CANCELLED')),
  notes                  TEXT,
  created_by             INTEGER REFERENCES users(id),
  submitted_at           TIMESTAMPTZ,
  approved_by            INTEGER REFERENCES users(id),
  approved_at            TIMESTAMPTZ,
  cancelled_by           INTEGER REFERENCES users(id),
  cancelled_at           TIMESTAMPTZ,
  idempotency_key        TEXT,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX idx_purchase_orders_idempotency_key ON purchase_orders(idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX idx_purchase_orders_supplier ON purchase_orders(supplier_id);
CREATE INDEX idx_purchase_orders_branch ON purchase_orders(branch_id);
CREATE INDEX idx_purchase_orders_status ON purchase_orders(status);
CREATE INDEX idx_purchase_orders_expected_delivery ON purchase_orders(expected_delivery_date);
CREATE INDEX idx_purchase_orders_created ON purchase_orders(created_at);

-- received_quantity بيتحدّث بس وقت POST جرن (goods_receipts) فعلي - مصدره الوحيد. remaining_quantity
-- مش عمود مخزّن عمدًا (ordered_quantity - received_quantity محسوبة وقت القراءة) عشان متعملش drift
CREATE TABLE purchase_order_items (
  id                 SERIAL PRIMARY KEY,
  purchase_order_id  INTEGER NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  inventory_item_id  INTEGER NOT NULL REFERENCES inventory_items(id),
  ordered_quantity   NUMERIC NOT NULL,
  unit               TEXT,
  unit_price         NUMERIC NOT NULL,
  discount           NUMERIC NOT NULL DEFAULT 0,
  tax                NUMERIC NOT NULL DEFAULT 0,
  total              NUMERIC NOT NULL DEFAULT 0,
  received_quantity  NUMERIC NOT NULL DEFAULT 0
);
CREATE INDEX idx_purchase_order_items_po ON purchase_order_items(purchase_order_id);
CREATE INDEX idx_purchase_order_items_item ON purchase_order_items(inventory_item_id);

-- سند استلام بضاعة (GRN) - منفصل تمامًا عن إنشاء الـPO (ممكن أكتر من GRN لنفس الـPO - استلام جزئي على
-- مراحل). idempotency_key بيحمي POST (الترحيل الفعلي للمخزون) من التكرار لو اتبعت الطلب مرتين
CREATE TABLE goods_receipts (
  id                      SERIAL PRIMARY KEY,
  purchase_order_id       INTEGER NOT NULL REFERENCES purchase_orders(id),
  supplier_id             INTEGER NOT NULL REFERENCES suppliers(id),
  branch_id               INTEGER NOT NULL REFERENCES branches(id),
  received_by             INTEGER REFERENCES users(id),
  received_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  supplier_document_number TEXT,
  notes                   TEXT,
  status                  TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'POSTED', 'CANCELLED')),
  posted_by               INTEGER REFERENCES users(id),
  posted_at               TIMESTAMPTZ,
  cancelled_by            INTEGER REFERENCES users(id),
  cancelled_at            TIMESTAMPTZ,
  idempotency_key         TEXT,
  created_by              INTEGER REFERENCES users(id),
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX idx_goods_receipts_idempotency_key ON goods_receipts(idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX idx_goods_receipts_po ON goods_receipts(purchase_order_id);
CREATE INDEX idx_goods_receipts_branch ON goods_receipts(branch_id);
CREATE INDEX idx_goods_receipts_status ON goods_receipts(status);
CREATE INDEX idx_goods_receipts_created ON goods_receipts(created_at);

-- accepted_quantity بس هو اللي بيدخل المخزون فعليًا وقت POST (rejected_quantity بيتسجل للتتبّع/الـaudit
-- بس وميعملش أي حركة مخزون خالص - "لازم منخلّيهوش يدخل الرصيد المتاح"). batch_id بيتربط بعد POST
-- (لما الدفعة تتنشئ فعليًا في inventory_batches عن طريق الليدجر)
CREATE TABLE goods_receipt_items (
  id                     SERIAL PRIMARY KEY,
  goods_receipt_id       INTEGER NOT NULL REFERENCES goods_receipts(id) ON DELETE CASCADE,
  purchase_order_item_id INTEGER NOT NULL REFERENCES purchase_order_items(id),
  inventory_item_id      INTEGER NOT NULL REFERENCES inventory_items(id),
  ordered_quantity       NUMERIC NOT NULL, -- نسخة (snapshot) من كمية الـPO الأصلية وقت الاستلام، للمرجعية
  received_quantity      NUMERIC NOT NULL,
  accepted_quantity      NUMERIC NOT NULL,
  rejected_quantity      NUMERIC NOT NULL DEFAULT 0,
  unit                   TEXT,
  unit_price             NUMERIC NOT NULL,
  batch_number           TEXT,
  expiry_date            DATE,
  manufacturing_date     DATE,
  quality_status         TEXT NOT NULL DEFAULT 'ACCEPTED' CHECK (quality_status IN ('ACCEPTED', 'REJECTED', 'PARTIAL')),
  rejection_reason       TEXT,
  -- batch_id: مفيش REFERENCES هنا مباشرة لأن inventory_batches معرّف بعد كدة في الملف (زي
  -- order_items.recipe_version_id بالظبط في المرحلة 3) - الـFK بيتضاف بـALTER TABLE تحت
  batch_id               INTEGER,
  CHECK (accepted_quantity + rejected_quantity <= received_quantity + 0.0000001) -- سماحية تقريب عائمة بسيطة
);
CREATE INDEX idx_goods_receipt_items_grn ON goods_receipt_items(goods_receipt_id);
CREATE INDEX idx_goods_receipt_items_po_item ON goods_receipt_items(purchase_order_item_id);
CREATE INDEX idx_goods_receipt_items_item ON goods_receipt_items(inventory_item_id);

-- وصفة تصنيع صنف مصنّع من مكونات خام/مصنّعة تانية (كام وحدة من كل مكوّن داخل عشان تنتج وحدة واحدة من الناتج)
-- المرحلة 3: زي menu_item_variant_ingredients بالظبط - "جدول قراءة توافقي" (compatibility read model)،
-- مش مصدر حقيقة. المصدر الوحيد للحقيقة هو recipes/recipe_versions/recipe_ingredients؛ الجدول ده بيتكتب
-- تلقائيًا بس من projectVersionToLegacyTable() وقت تفعيل نسخة (routes/recipes.js activate)، ومفيش أي
-- endpoint تاني يعدّل عليه مباشرة. لو حصل تعارض بينه وبين الوصفة النشطة الحقيقية، ده باج لازم يتصلح في
-- projectVersionToLegacyTable مش في الجدول - اختبار phase3-1-costing.test.js بيتأكد إن الاتنين متطابقين
-- دايمًا لأي نسخة ACTIVE
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
  from_branch_id   INTEGER REFERENCES branches(id), -- الفرع/المخزن المُرسِل (NULL على تحويلات قديمة قبل الحقل ده)
  to_branch_id     INTEGER REFERENCES branches(id),
  business_date    DATE NOT NULL,
  amount_at_cost   NUMERIC NOT NULL,
  notes            TEXT,
  kitchen_order_id INTEGER REFERENCES kitchen_orders(id), -- لو التحويل ده تنفيذ لطلبية فرع (اختياري)
  -- دورة حياة التحويل الكاملة (اختيارية) - التحويل الفوري القديم (POST /itemized) لسه بيسجّل الصف بحالة
  -- 'completed' على طول زي الأول، أما لو حد استخدم الـworkflow الجديد (request→approve→issue→receive)
  -- الحالة بتتدرّج فعليًا والرصيد بيزيد في الفرع المستلم بس وقت الاستلام مش وقت الإنشاء
  status           TEXT NOT NULL DEFAULT 'completed'
                   CHECK (status IN ('requested', 'approved', 'issued', 'in_transit', 'received', 'partially_received', 'completed', 'cancelled')),
  requested_by     INTEGER REFERENCES users(id),
  approved_by      INTEGER REFERENCES users(id),
  issued_by        INTEGER REFERENCES users(id),
  received_by      INTEGER REFERENCES users(id),
  approved_at      TIMESTAMPTZ,
  issued_at        TIMESTAMPTZ,
  received_at      TIMESTAMPTZ
);

-- بنود التحويل بالتفصيل (أصناف وكميات) - amount_at_cost فوق بيتحسب من مجموعها
CREATE TABLE kitchen_transfer_items (
  id                    SERIAL PRIMARY KEY,
  kitchen_transfer_id   INTEGER REFERENCES kitchen_transfers(id) ON DELETE CASCADE,
  inventory_item_id     INTEGER REFERENCES inventory_items(id),
  quantity              NUMERIC NOT NULL,        -- الكمية المطلوبة/المخطط تحويلها
  quantity_sent         NUMERIC,                 -- الكمية اللي فعلًا خرجت من فرع المصدر (وقت issue)
  quantity_received     NUMERIC                  -- الكمية اللي فعلًا وصلت الفرع المستلم (وقت receive) - ممكن تقل عن المُرسل
);

CREATE TABLE branch_inventory_stock (
  id                SERIAL PRIMARY KEY,
  branch_id         INTEGER REFERENCES branches(id),
  inventory_item_id INTEGER REFERENCES inventory_items(id),
  quantity          NUMERIC NOT NULL DEFAULT 0,
  -- المرحلة 4.1: حدود إعادة الطلب - بوحدة تخزين الصنف نفسها بالظبط (نفس وحدة quantity فوق)، مفيش أي
  -- وحدة تانية أو تحويل جديد. NULL يعني "مفيش حد محدد لسه" لهذا الصنف في الفرع ده - مش صفر عمدًا
  reorder_point     NUMERIC,
  min_stock         NUMERIC,
  max_stock         NUMERIC,
  UNIQUE(branch_id, inventory_item_id)
);

-- تتبّع دفعات (Batch/Lot) اختياري بالصنف - لو الصنف اتستلم بدفعة (تاريخ إنتاج/صلاحية معروف)، بيتسجل هنا
-- ويتصرف منها أولًا بالأقرب انتهاءً (FEFO) أو الأقدم دخولًا (FIFO) حسب pos_settings.batch_consumption_method.
-- الأصناف اللي معندهاش دفعات مسجّلة أصلًا بتفضل شغالة زي الأول (بدون أي تتبّع دفعات - رصيد إجمالي بس)
CREATE TABLE inventory_batches (
  id                 SERIAL PRIMARY KEY,
  batch_number       TEXT,
  inventory_item_id  INTEGER NOT NULL REFERENCES inventory_items(id),
  branch_id          INTEGER NOT NULL REFERENCES branches(id), -- الفرع/المخزن الحائز على الدفعة
  supplier_id        INTEGER REFERENCES suppliers(id),
  received_date      DATE,
  production_date    DATE,
  expiry_date        DATE,
  original_quantity  NUMERIC NOT NULL,
  remaining_quantity NUMERIC NOT NULL,
  unit_cost          NUMERIC,
  status             TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'depleted', 'expired')),
  created_by         INTEGER REFERENCES users(id),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_inventory_batches_item_branch ON inventory_batches(inventory_item_id, branch_id, status);

-- المرحلة 4A: goods_receipt_items.batch_id اتعرّف قبل كدة في الملف (قبل inventory_batches) - الـFK
-- بيتضاف هنا بعد ما الجدول المرجعي يتعرّف فعليًا (زي order_items.recipe_version_id بالظبط في المرحلة 3)
ALTER TABLE goods_receipt_items ADD CONSTRAINT fk_goods_receipt_items_batch
  FOREIGN KEY (batch_id) REFERENCES inventory_batches(id);
CREATE INDEX idx_goods_receipt_items_batch ON goods_receipt_items(batch_id);

-- لو الصنف المُحوَّل بين فرعين متتبّع بدفعات، كل جزء من الكمية بيتسجل هنا بهويته الأصلية (رقم الدفعة/
-- الصلاحية/الإنتاج/التكلفة) - عشان الدفعة تفضل معروفة بنفس هويتها في الفرع المستلم بدل ما تتحول لرصيد
-- عام مجهول المصدر. لو التحويل استهلك من أكتر من دفعة (FEFO/FIFO)، كل دفعة بتاخد صف منفصل هنا بالترتيب
-- اللي اتصرفت بيه وقت الإصدار (issue) - وبيتحدد منها الدفعة (الدفعات) اللي بتتنشئ/تتزود في فرع الاستلام
CREATE TABLE kitchen_transfer_item_batches (
  id                        SERIAL PRIMARY KEY,
  kitchen_transfer_item_id  INTEGER NOT NULL REFERENCES kitchen_transfer_items(id) ON DELETE CASCADE,
  source_batch_id           INTEGER REFERENCES inventory_batches(id),
  quantity                  NUMERIC NOT NULL,
  batch_number              TEXT,
  expiry_date               DATE,
  production_date           DATE,
  unit_cost                 NUMERIC,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_kitchen_transfer_item_batches_item ON kitchen_transfer_item_batches(kitchen_transfer_item_id);

-- تحويلات وحدات بسيطة بين وحدات مختلفة لنفس الصنف (مثلًا استلام من المورد بالكرتونة والرصيد متابَع
-- بالكيلو) - factor: 1 من from_unit = factor من to_unit. اختيارية، مطلوبة بس لو حد استلم بوحدة مختلفة
CREATE TABLE unit_conversions (
  from_unit TEXT NOT NULL,
  to_unit   TEXT NOT NULL,
  factor    NUMERIC NOT NULL,
  PRIMARY KEY (from_unit, to_unit)
);

-- لو رصيد فرع (branch_inventory_stock) اختلف عن مجموع حركاته المسجّلة في الليدجر (inventory_movements) -
-- ده مؤشر خلل بيانات (تلاعب/باج قديم قبل ما كل الحركات تبقى بتعدي على postInventoryMovement) - بيتسجل
-- هنا كتنبيه، وميتصلّحش تلقائي، محتاج مراجعة وتصحيح واعي (PATCH .../resolve) مسجّل في الـaudit
CREATE TABLE inventory_discrepancies (
  id                 SERIAL PRIMARY KEY,
  branch_id          INTEGER NOT NULL REFERENCES branches(id),
  inventory_item_id  INTEGER NOT NULL REFERENCES inventory_items(id),
  ledger_sum         NUMERIC NOT NULL,
  stock_balance      NUMERIC NOT NULL,
  difference         NUMERIC NOT NULL,
  detected_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at        TIMESTAMPTZ,
  resolved_by        INTEGER REFERENCES users(id),
  resolution_notes   TEXT
);
CREATE INDEX idx_inventory_discrepancies_open ON inventory_discrepancies(branch_id) WHERE resolved_at IS NULL;

-- كام وحدة من كل مكوّن بتتاخد لما يتباع variant واحد (الوصفة/BOM) - "الجدول المسطّح" القديم، لسه هو
-- المصدر اللي بيقرأ منه خصم المخزون وقت البيع (routes/orders.js) وحساب cost_at_sale، من غير أي تغيير.
-- من المرحلة 3، محرك الوصفات الموثّق تحت (recipes/recipe_versions) هو اللي بيكتب هنا تلقائيًا وقت
-- تفعيل نسخة جديدة (activation) - يعني الجدول ده بقى "إسقاط" (projection) لآخر نسخة معتمدة، مش
-- مصدر التعديل المباشر تاني، لكن نفس الشكل بالظبط فمفيش أي كسر لأي كود قديم بيقرأ منه
CREATE TABLE menu_item_variant_ingredients (
  id                  SERIAL PRIMARY KEY,
  variant_id          INTEGER REFERENCES menu_item_variants(id) ON DELETE CASCADE,
  inventory_item_id   INTEGER REFERENCES inventory_items(id),
  quantity_per_unit   NUMERIC NOT NULL,
  UNIQUE(variant_id, inventory_item_id)
);

-- ============================================================
-- المرحلة 3: محرك الوصفات الموثّق بالإصدارات (Recipe Engine)
-- ============================================================

-- هوية ثابتة للوصفة (مش بتتغيّر) - إما وصفة صنف مباع (sellable_variant) أو وصفة تصنيع نصف مصنّع/مكوّن
-- مصنّع (manufactured_item). النُسخ الفعلية (recipe_versions) هي اللي فيها التفاصيل والتاريخ
CREATE TABLE recipes (
  id                 SERIAL PRIMARY KEY,
  recipe_type        TEXT NOT NULL CHECK (recipe_type IN ('sellable_variant', 'manufactured_item')),
  variant_id         INTEGER REFERENCES menu_item_variants(id) ON DELETE CASCADE,
  inventory_item_id  INTEGER REFERENCES inventory_items(id) ON DELETE CASCADE,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (
    (recipe_type = 'sellable_variant' AND variant_id IS NOT NULL AND inventory_item_id IS NULL) OR
    (recipe_type = 'manufactured_item' AND inventory_item_id IS NOT NULL AND variant_id IS NULL)
  ),
  UNIQUE (variant_id),
  UNIQUE (inventory_item_id)
);

-- نسخة فعلية من الوصفة - كل تغيير حقيقي في المكونات/الكميات بينشئ نسخة جديدة، مش بيعدّل نسخة قديمة.
-- نسخة اتستخدمت في بيع/تصنيع فعلي (APPROVED/ACTIVE/ARCHIVED) ما ينفعش تتعدّل تاني - غير قابلة للتغيير،
-- أي تعديل لازم نسخة جديدة (DRAFT) توديها لدورة اعتماد تانية من الأول
CREATE TABLE recipe_versions (
  id                        SERIAL PRIMARY KEY,
  recipe_id                 INTEGER NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
  version_number            INTEGER NOT NULL,
  status                    TEXT NOT NULL DEFAULT 'DRAFT'
                             CHECK (status IN ('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'ACTIVE', 'ARCHIVED', 'REJECTED')),
  yield_quantity             NUMERIC NOT NULL DEFAULT 1, -- الوصفة دي بتنتج كام وحدة (مثلًا: تنتج 10 بيتزا، أو 5 كيلو صوص)
  yield_unit                 TEXT,
  preparation_loss_percent   NUMERIC NOT NULL DEFAULT 0, -- فقد أثناء التحضير (تقطيع، تنضيف...)
  cooking_loss_percent        NUMERIC NOT NULL DEFAULT 0, -- فقد أثناء الطهي (تبخّر، انكماش...)
  notes                        TEXT,
  created_by                   INTEGER REFERENCES users(id),
  approved_by                    INTEGER REFERENCES users(id),
  rejected_by                     INTEGER REFERENCES users(id),
  rejection_reason                 TEXT,
  effective_from                    TIMESTAMPTZ,
  effective_to                       TIMESTAMPTZ,
  submitted_at                        TIMESTAMPTZ,
  approved_at                          TIMESTAMPTZ,
  activated_at                          TIMESTAMPTZ,
  archived_at                            TIMESTAMPTZ,
  created_at                              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                               TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (recipe_id, version_number)
);
-- نسخة واحدة بس ACTIVE لكل وصفة في نفس اللحظة - مفروضة على مستوى القاعدة نفسها، مش مجرد فحص تطبيقي
CREATE UNIQUE INDEX idx_recipe_versions_one_active ON recipe_versions(recipe_id) WHERE status = 'ACTIVE';
CREATE INDEX idx_recipe_versions_recipe ON recipe_versions(recipe_id);

-- order_items.recipe_version_id اتعرّف قبل كدة في الملف (order_items جاي قبل recipe_versions) - الـFK
-- بيتضاف هنا بعد ما الجدول المرجعي يتعرّف فعليًا
ALTER TABLE order_items ADD CONSTRAINT fk_order_items_recipe_version
  FOREIGN KEY (recipe_version_id) REFERENCES recipe_versions(id);
CREATE INDEX idx_order_items_recipe_version ON order_items(recipe_version_id);

-- مكونات نسخة الوصفة - المكوّن نفسه ممكن يكون خام أو "مصنّع له وصفة تانية بتاعته" (sub-recipe) - محرك
-- الاستهلاك النظري بيتعرّف على ده تلقائيًا وينفجر فيه (routes recipe-engine.js) لحد ما يوصل لخام بس
CREATE TABLE recipe_ingredients (
  id                          SERIAL PRIMARY KEY,
  recipe_version_id           INTEGER NOT NULL REFERENCES recipe_versions(id) ON DELETE CASCADE,
  ingredient_item_id          INTEGER NOT NULL REFERENCES inventory_items(id),
  quantity                    NUMERIC NOT NULL,
  unit                        TEXT,
  wastage_percent              NUMERIC NOT NULL DEFAULT 0,
  yield_percent                 NUMERIC NOT NULL DEFAULT 100,
  preparation_loss_percent       NUMERIC NOT NULL DEFAULT 0,
  cost_method                      TEXT NOT NULL DEFAULT 'AVERAGE' CHECK (cost_method IN ('AVERAGE', 'LATEST', 'FEFO_BATCH')),
  is_optional                        BOOLEAN NOT NULL DEFAULT FALSE,
  substitute_for_ingredient_id         INTEGER REFERENCES inventory_items(id),
  created_at                             TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_recipe_ingredients_version ON recipe_ingredients(recipe_version_id);
CREATE INDEX idx_recipe_ingredients_item ON recipe_ingredients(ingredient_item_id);

-- المرحلة 3.1: تجميد "التكلفة النظرية لكل مكوّن" لحظة البيع بالظبط - قبل كده كان محفوظ إجمالي بس
-- (order_items.cost_at_sale)، مش مفصّل لكل مكوّن، فأي تقرير بعدين كان مضطر يعيد حساب التكلفة النظرية
-- بسعر اليوم الحالي (خطأ - سعر المكوّن بيتغيّر). الجدول ده بيتكتب مرة واحدة بس، في نفس transaction
-- تسجيل الطلب (routes/orders.js)، وبيستخدم explodeRecipeConsumption (نفس محرك الوصفات، مش حساب منفصل)
-- + inventory_items.unit_cost **لحظة البيع دي بالظبط** - قيمة مجمّدة للأبد زي cost_at_sale تمامًا.
-- SUM(total_cost) هنا لازم يساوي order_items.cost_at_sale لنفس السطر (اختبار consistency بيتأكد من كده).
-- الطلبات القديمة (قبل المرحلة 3.1) مفيهاش صفوف هنا - قيود بيانات تاريخية حقيقية، مش باج.
CREATE TABLE order_item_ingredient_costs (
  id                  SERIAL PRIMARY KEY,
  order_item_id       INTEGER NOT NULL REFERENCES order_items(id) ON DELETE CASCADE,
  ingredient_item_id  INTEGER NOT NULL REFERENCES inventory_items(id),
  quantity            NUMERIC NOT NULL,  -- الكمية النظرية (من الوصفة) بوحدة تخزين الصنف
  unit_cost           NUMERIC,           -- تكلفة الوحدة وقت البيع بالظبط (NULL لو الصنف كان بلا تكلفة وقتها)
  total_cost          NUMERIC,           -- quantity × unit_cost (NULL لو unit_cost NULL)
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_order_item_ingredient_costs_item ON order_item_ingredient_costs(order_item_id);
CREATE INDEX idx_order_item_ingredient_costs_ingredient ON order_item_ingredient_costs(ingredient_item_id);

-- ============================================================
-- المرحلة 3: أوامر التصنيع (Production Orders) - دورة حياة كاملة فوق /api/inventory/produce الحالي
-- (اللي لسه شغال زي ما هو للتصنيع الفوري البسيط) - للحالات اللي محتاجة اعتماد وتتبّع دفعات وanomaly
-- ============================================================
CREATE TABLE production_orders (
  id                 SERIAL PRIMARY KEY,
  branch_id          INTEGER NOT NULL REFERENCES branches(id),
  recipe_id          INTEGER NOT NULL REFERENCES recipes(id),
  recipe_version_id  INTEGER NOT NULL REFERENCES recipe_versions(id),
  status             TEXT NOT NULL DEFAULT 'DRAFT'
                     CHECK (status IN ('DRAFT', 'APPROVED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED')),
  planned_quantity    NUMERIC NOT NULL,
  actual_quantity      NUMERIC,
  production_date       DATE NOT NULL DEFAULT CURRENT_DATE,
  batch_number            TEXT,
  expiry_date               DATE,
  variance_reason             TEXT, -- لازم تتحدد لو الفرق بين المخطط والفعلي كبير (نسبة قابلة للإعداد وقت الإكمال)
  notes                        TEXT,
  operator_id                   INTEGER REFERENCES users(id),
  approved_by                    INTEGER REFERENCES users(id),
  completed_by                     INTEGER REFERENCES users(id),
  cancelled_by                       INTEGER REFERENCES users(id),
  approved_at                         TIMESTAMPTZ,
  started_at                           TIMESTAMPTZ,
  completed_at                          TIMESTAMPTZ,
  cancelled_at                           TIMESTAMPTZ,
  created_at                              TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_production_orders_branch ON production_orders(branch_id);
CREATE INDEX idx_production_orders_recipe ON production_orders(recipe_id, recipe_version_id);
CREATE INDEX idx_production_orders_status ON production_orders(status);

-- تتبّع الدفعات: أي دفعات خام اتستهلكت (input) وأي دفعة ناتج اتنتجت (output) في نفس أمر التصنيع -
-- بيربط بينهم بـproduction_order_id الواحد، فتقدر تتبّع "الدفعة دي طلعت من إيه بالظبط"
CREATE TABLE production_order_batches (
  id                   SERIAL PRIMARY KEY,
  production_order_id  INTEGER NOT NULL REFERENCES production_orders(id) ON DELETE CASCADE,
  role                 TEXT NOT NULL CHECK (role IN ('input', 'output')),
  inventory_item_id     INTEGER NOT NULL REFERENCES inventory_items(id),
  batch_id               INTEGER REFERENCES inventory_batches(id),
  quantity                NUMERIC NOT NULL,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_production_order_batches_order ON production_order_batches(production_order_id);
CREATE INDEX idx_production_order_batches_batch ON production_order_batches(batch_id);

-- سجل حركة المخزون - ده الـInventory Ledger: المصدر الأساسي لكل حركة مخزون، append-only، كل حركة
-- بتتسجل من خلال db/inventory-ledger.js (postInventoryMovement) اللي بيقفل الصف (FOR UPDATE) ويحسب
-- quantity_before/after بدقة عشان يمنع أي سباق بين حركتين على نفس الصنف/الفرع في نفس اللحظة، ويمنع
-- أي تعديل مباشر على branch_inventory_stock من غير حركة مسجّلة. القيم القديمة lowercase (زي
-- 'sale_deduction'/'adjustment') اتسيبت في الـCHECK للحفاظ على الحركات التاريخية زي ما هي (بدون
-- إعادة كتابة تاريخ)؛ كل حركة جديدة بتستخدم القيم الكبيرة (SALE, ADJUSTMENT...) بس
CREATE TABLE inventory_movements (
  id                SERIAL PRIMARY KEY,
  branch_id         INTEGER REFERENCES branches(id),      -- = warehouse/فرع الحركة (مفيش جدول مخازن منفصل - الفرع نفسه هو "المخزن"، والسنتر كيتشن فرع بعلامة is_central_kitchen)
  inventory_item_id INTEGER REFERENCES inventory_items(id),
  movement_type     TEXT NOT NULL CHECK (movement_type IN (
                      -- قيم تاريخية (قبل هذه المرحلة) - متسيبناش نلمسها عشان محافظين على دقة السجلات القديمة
                      'purchase', 'sale_deduction', 'transfer_in', 'transfer_out', 'adjustment', 'production_in', 'production_out', 'waste',
                      -- القيم القياسية الجديدة (كل حركة جديدة بتستخدم واحدة منها)
                      'OPENING_BALANCE', 'PURCHASE_RECEIPT', 'PRODUCTION_IN', 'PRODUCTION_OUT', 'SALE', 'SALE_REVERSAL',
                      'TRANSFER_OUT', 'TRANSFER_IN', 'WASTE', 'DAMAGE', 'EXPIRY', 'STOCK_COUNT', 'ADJUSTMENT',
                      'RETURN_TO_SUPPLIER', 'RETURN_FROM_BRANCH', 'PRODUCTION_REVERSAL'
                     )),
  quantity          NUMERIC NOT NULL,        -- موجب = زيادة، سالب = نقصان
  unit              TEXT,                    -- وحدة الحركة (عادة نفس inventory_items.unit وقت الحركة)
  unit_cost         NUMERIC,                 -- تكلفة الوحدة التاريخية وقت الحركة (مش سعر الصنف الحالي - محفوظة زي ما هي حتى لو التكلفة اتغيرت بعدين)
  total_cost        NUMERIC,                 -- unit_cost × |quantity|
  quantity_before   NUMERIC,                 -- رصيد الصنف في الفرع قبل الحركة مباشرة
  quantity_after    NUMERIC,                 -- رصيد الصنف في الفرع بعد الحركة مباشرة
  reference_type    TEXT,                    -- 'order' / 'kitchen_transfer' / 'approval_request' / 'production' / 'discrepancy' ...
  reference_id      INTEGER,                 -- id السجل المرتبط حسب reference_type (مفيش FK واحد ثابت لاختلاف الجدول المرجعي)
  batch_id          INTEGER REFERENCES inventory_batches(id), -- الدفعة اللي اتصرف منها/اتضافت ليها (لو الصنف متتبّع بدفعات)
  reason            TEXT,                    -- سبب مقنّن (خصوصًا لحركات WASTE: EXPIRED/DAMAGED/BURNED...)
  idempotency_key   TEXT,                    -- عشان لو نفس الطلب اتكرر بسبب retry شبكة/مزامنة أوفلاين ميتسجلش مرتين
  order_id          INTEGER REFERENCES orders(id),  -- (قديم) لسه موجود لتوافق أي كود قديم بيقرأه مباشرة - reference_type='order' هو البديل العام
  business_date     DATE NOT NULL DEFAULT CURRENT_DATE,
  notes             TEXT,
  created_by        INTEGER REFERENCES users(id),
  created_at        TIMESTAMPTZ DEFAULT now()
);
CREATE UNIQUE INDEX idx_inventory_movements_idempotency ON inventory_movements(idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX idx_inventory_movements_item_branch_created ON inventory_movements(branch_id, inventory_item_id, created_at);
CREATE INDEX idx_inventory_movements_reference ON inventory_movements(reference_type, reference_id);
-- المرحلة 3.1: تقارير تصنيف الاستهلاك (نظري/فعلي/هالك/تسوية/تحويل...) بتفلتر دايمًا بـ(فرع + مدى تاريخ
-- + نوع الحركة) لكل حركات الفترة مرة واحدة - من غيره كانت هتعمل sequential scan على كل حركات الفرع
CREATE INDEX idx_inventory_movements_branch_date_type ON inventory_movements(branch_id, business_date, movement_type);

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

-- المرحلة 4C: تشغيلة رواتب شهرية رسمية - snapshot ثابت من نتيجة services/payroll-engine.js وقت
-- الاعتماد (مش تقرير حي زي GET /api/payroll/summary - لو الحضور/السلف اتعدّلوا بعد كده، الأرقام هنا
-- مابتتغيّرش) + دورة حياة محاسبية: DRAFT (مسودة، لسه مفيش قيد) → APPROVED (اتاعتمدت وترحّل قيدها
-- تلقائيًا: مدين 6100 الرواتب [مقسّم على الفروع] / دائن 2400 رواتب مستحقة) → CANCELLED (عكس القيد،
-- أدمن بس، زي عكس أي قيد محاسبي تمامًا - نفس نمط expenses.status بالظبط)
CREATE TABLE payroll_runs (
  id                   SERIAL PRIMARY KEY,
  year                 INTEGER NOT NULL,
  month                INTEGER NOT NULL CHECK (month BETWEEN 1 AND 12),
  status               TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'APPROVED', 'CANCELLED')),
  total_net_pay        NUMERIC NOT NULL DEFAULT 0,
  created_by           INTEGER REFERENCES users(id),
  approved_by          INTEGER REFERENCES users(id),
  approved_at          TIMESTAMPTZ,
  cancelled_by         INTEGER REFERENCES users(id),
  cancelled_at         TIMESTAMPTZ,
  cancellation_reason  TEXT,
  -- journal_entry_id: journal_entries معرّف في قسم المحاسبة تحت - الـFK بيتضاف هناك
  journal_entry_id     INTEGER,
  idempotency_key      TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (year, month)
);
CREATE UNIQUE INDEX idx_payroll_runs_idempotency_key ON payroll_runs(idempotency_key) WHERE idempotency_key IS NOT NULL;

-- سطر واحد لكل موظف في التشغيلة - snapshot ثابت من صافي راتبه وقت الاعتماد (مش مرجع حي لـ
-- payroll_adjustments/attendance_punches، عشان الرقم التاريخي يفضل زي ما هو حتى لو الحضور اتصحّح بعد كده)
CREATE TABLE payroll_run_employees (
  id              SERIAL PRIMARY KEY,
  payroll_run_id  INTEGER NOT NULL REFERENCES payroll_runs(id) ON DELETE CASCADE,
  employee_id     INTEGER NOT NULL REFERENCES employees(id),
  employee_name   TEXT NOT NULL, -- نسخة من اسم الموظف وقت الاعتماد (لو الاسم اتغيّر في employees بعد كده)
  branch_id       INTEGER REFERENCES branches(id), -- NULL = تكلفة عامة (إدارة/مطبخ مركزي بدون فرع بيع محدد)
  gross_pay       NUMERIC NOT NULL DEFAULT 0, -- الراتب بعد الحضور، قبل السلف/الجزاءات/المكافآت
  advances        NUMERIC NOT NULL DEFAULT 0,
  penalties       NUMERIC NOT NULL DEFAULT 0,
  bonuses         NUMERIC NOT NULL DEFAULT 0,
  net_pay         NUMERIC NOT NULL DEFAULT 0,
  UNIQUE (payroll_run_id, employee_id)
);
CREATE INDEX idx_payroll_run_employees_run ON payroll_run_employees(payroll_run_id);
CREATE INDEX idx_payroll_run_employees_employee ON payroll_run_employees(employee_id);

-- سداد فعلي لموظف من تشغيلة معتمدة - نفس نمط supplier_payments بالظبط (مدين 2400 رواتب مستحقة / دائن
-- كاش الفرع أو البنك)، ممكن أكتر من سداد جزئي لنفس الموظف لحد ما يوصل net_pay بالكامل. مفيش عمود رصيد
-- متبقي مخزّن هنا عمدًا - المتبقي بيتحسب وقت القراءة (SUM) زي رصيد المورد بالظبط، عشان يستحيل يحصل drift
CREATE TABLE payroll_payments (
  id                       SERIAL PRIMARY KEY,
  payroll_run_employee_id  INTEGER NOT NULL REFERENCES payroll_run_employees(id),
  branch_id                INTEGER NOT NULL REFERENCES branches(id),
  payment_date             DATE NOT NULL DEFAULT CURRENT_DATE,
  amount                   NUMERIC NOT NULL CHECK (amount > 0),
  payment_method_id        INTEGER REFERENCES payment_methods(id),
  notes                    TEXT,
  -- journal_entry_id: journal_entries معرّف في قسم المحاسبة تحت - الـFK بيتضاف هناك
  journal_entry_id         INTEGER,
  idempotency_key          TEXT,
  created_by               INTEGER REFERENCES users(id),
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX idx_payroll_payments_idempotency_key ON payroll_payments(idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX idx_payroll_payments_run_employee ON payroll_payments(payroll_run_employee_id);

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

-- ============================================================
-- سجل تدقيق مركزي (Audit Log) - append-only، بيسجل كل عملية حساسة
-- (دخول/خروج فاشل، تعديل سعر أو وصفة، تسوية مخزون، موافقة على خصم/استرجاع، تغيير دور موظف...)
-- ============================================================
CREATE TABLE audit_logs (
  id           BIGSERIAL PRIMARY KEY,
  branch_id    INTEGER REFERENCES branches(id),
  user_id      INTEGER REFERENCES users(id),
  action       TEXT NOT NULL,        -- LOGIN, LOGIN_FAILED, PRICE_CHANGE, RECIPE_CHANGE, INVENTORY_ADJUSTMENT, ...
  entity_type  TEXT,                 -- order, menu_variant, inventory_item, user, approval_request ...
  entity_id    INTEGER,
  old_values   JSONB,
  new_values   JSONB,
  metadata     JSONB,
  ip_address   TEXT,
  user_agent   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_audit_logs_entity ON audit_logs(entity_type, entity_id);
CREATE INDEX idx_audit_logs_user ON audit_logs(user_id);
CREATE INDEX idx_audit_logs_branch_created ON audit_logs(branch_id, created_at DESC);

-- ============================================================
-- المرحلة 4B: المحاسبة والدفتر العام (Double-Entry Accounting Ledger)
-- المصدر الوحيد لأي تمثيل محاسبي رسمي (Trial Balance/GL/P&L مرحّل) - بيترحّل تلقائيًا من الأحداث
-- التشغيلية الموجودة (بيع/استلام بضاعة/مصروف/هالك/تصنيع...) من غير ما يعيد حساب أي تكلفة أو يلمس
-- المخزون الفعلي مباشرة - db/inventory-ledger.js يفضل المصدر الوحيد للمخزون الفعلي،
-- و/api/reports/income-statement يفضل زي ما هو (تقرير تشغيلي خفيف مش مبني على القيود) - تقرير
-- المطابقة الجديد (accounting-reconciliation) بيقارن الاتنين، مش بيوحّدهم في مصدر واحد
-- ============================================================

-- شجرة الحسابات - account_type بمستوياته الستة الأساسية بس (CHECK enum، زي كل الحالات المشابهة
-- في المشروع ده، مش جدول منفصل). branch_id = NULL يعني حساب مشترك على مستوى الشركة كلها (زي 1400
-- المخزون أو 2100 الموردين)؛ لو محدد، الحساب ده خاص بفرع معيّن بس (زي 1100-N كاش كل فرع)
CREATE TABLE accounts (
  id                SERIAL PRIMARY KEY,
  code              TEXT NOT NULL UNIQUE,
  name              TEXT NOT NULL,
  account_type      TEXT NOT NULL CHECK (account_type IN ('ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'COGS', 'EXPENSE')),
  parent_account_id INTEGER REFERENCES accounts(id),
  branch_id         INTEGER REFERENCES branches(id),
  is_active         BOOLEAN NOT NULL DEFAULT TRUE,
  is_system_account BOOLEAN NOT NULL DEFAULT FALSE, -- حسابات افتراضية أساسية (زي 1400/2100/4100) محمية من الحذف
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_accounts_type ON accounts(account_type);
CREATE INDEX idx_accounts_branch ON accounts(branch_id);
CREATE INDEX idx_accounts_parent ON accounts(parent_account_id);

-- ترحيل شهري - قفل شهر بيمنع أي قيد جديد أو عكسي عليه؛ التصحيحات بعد القفل لازم تتسجل في الشهر
-- المفتوح الحالي (بقيد تصحيحي واضح السبب)، مش بإعادة فتح الشهر المقفول
CREATE TABLE accounting_periods (
  id          SERIAL PRIMARY KEY,
  year        INTEGER NOT NULL,
  month       INTEGER NOT NULL CHECK (month BETWEEN 1 AND 12),
  status      TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'CLOSED')),
  closed_by   INTEGER REFERENCES users(id),
  closed_at   TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (year, month)
);

-- مصدر رقم القيد (JE-000001...) - sequence منفصلة (مش SERIAL id الجدول نفسه) عشان الرقم يتحسب مرة واحدة
-- قبل الإدخال مباشرة (nextval آمن ومتزامن أصلًا في Postgres)، من غير أي UPDATE لاحق على عمود entry_number
-- بعد الإدخال (كان هيتصادم مع trigger عدم قابلية التعديل بعد الترحيل تحت لو القيد اتعمل POSTED فورًا)
CREATE SEQUENCE journal_entry_number_seq START 1;

-- رأس القيد - كل حدث محاسبي (بيع/استلام بضاعة/مصروف/هالك...) بينشئ قيد واحد بكل سطوره، مش قيد منفصل
-- لكل طرف. status: DRAFT (قيد يدوي لسه ما اتترحلش) → POSTED (مرحّل، غير قابل للتعديل إطلاقًا بعد كده -
-- محمي بـtrigger على مستوى القاعدة نفسها مش تطبيقي بس) → REVERSED (اتعكس بقيد تاني، بيفضل هو نفسه
-- POSTED وموجود للأبد، بس معلّم إنه اتعكس). القيود التلقائية (من الأحداث التشغيلية) بتتنشئ POSTED
-- مباشرة لأن الحدث نفسه أصلًا معتمد (بيع اتحصل، GRN اتاعتمد قبل الاستلام...) - القيد اليدوي بس هو اللي
-- بيمر بـDRAFT فعليًا
CREATE TABLE journal_entries (
  id                    SERIAL PRIMARY KEY,
  entry_number          TEXT NOT NULL UNIQUE,
  entry_date            DATE NOT NULL,
  description           TEXT,
  source_type           TEXT NOT NULL, -- 'order_sale' | 'order_void' | 'goods_receipt' | 'goods_receipt_cancel' |
                                        -- 'supplier_payment' | 'expense' | 'waste' | 'adjustment' | 'production' |
                                        -- 'production_cancel' | 'manual' | 'reversal'
  source_id             INTEGER,
  branch_id             INTEGER REFERENCES branches(id),
  status                TEXT NOT NULL DEFAULT 'POSTED' CHECK (status IN ('DRAFT', 'POSTED', 'REVERSED')),
  created_by            INTEGER REFERENCES users(id),
  posted_by             INTEGER REFERENCES users(id),
  posted_at             TIMESTAMPTZ,
  reversed_by           INTEGER REFERENCES users(id),
  reversed_at           TIMESTAMPTZ,
  reversal_of_entry_id  INTEGER REFERENCES journal_entries(id),
  reversal_reason       TEXT,
  idempotency_key       TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX idx_journal_entries_idempotency_key ON journal_entries(idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX idx_journal_entries_source ON journal_entries(source_type, source_id);
CREATE INDEX idx_journal_entries_branch_date ON journal_entries(branch_id, entry_date);
CREATE INDEX idx_journal_entries_status ON journal_entries(status);

-- سطور القيد - سطر واحد إما مدين أو دائن، مش الاتنين (CHECK تحت). reference_type/reference_id بيسمحوا
-- بدفتر أستاذ مساعد (subsidiary ledger) - زي رصيد مورد معيّن = مجموع سطور 2100 اللي reference_type='supplier'
-- AND reference_id = المورد ده، من غير ما نحتاج حساب GL منفصل لكل مورد
CREATE TABLE journal_entry_lines (
  id                SERIAL PRIMARY KEY,
  journal_entry_id  INTEGER NOT NULL REFERENCES journal_entries(id) ON DELETE CASCADE,
  account_id        INTEGER NOT NULL REFERENCES accounts(id),
  debit             NUMERIC NOT NULL DEFAULT 0 CHECK (debit >= 0),
  credit            NUMERIC NOT NULL DEFAULT 0 CHECK (credit >= 0),
  description       TEXT,
  branch_id         INTEGER REFERENCES branches(id),
  reference_type    TEXT,
  reference_id      INTEGER,
  CHECK (NOT (debit > 0 AND credit > 0))
);
CREATE INDEX idx_journal_entry_lines_entry ON journal_entry_lines(journal_entry_id);
CREATE INDEX idx_journal_entry_lines_account ON journal_entry_lines(account_id);
CREATE INDEX idx_journal_entry_lines_reference ON journal_entry_lines(reference_type, reference_id);

-- تحقق مزدوج (DB-level، مش تطبيقي بس) إن كل قيد متزن: مجموع المدين = مجموع الدائن بالظبط. Deferred
-- Constraint Trigger عشان يتأكد بعد ما كل سطور القيد (INSERT متعددة) تتحط، وقت الـCOMMIT بالظبط -
-- مش بعد كل سطر لوحده (كان هيرفض أي قيد وسط إدخاله)
CREATE OR REPLACE FUNCTION check_journal_entry_balanced() RETURNS TRIGGER AS $$
DECLARE
  target_entry_id INTEGER;
  total_debit NUMERIC;
  total_credit NUMERIC;
BEGIN
  target_entry_id := COALESCE(NEW.journal_entry_id, OLD.journal_entry_id);
  SELECT COALESCE(SUM(debit), 0), COALESCE(SUM(credit), 0) INTO total_debit, total_credit
  FROM journal_entry_lines WHERE journal_entry_id = target_entry_id;
  IF total_debit <> total_credit THEN
    RAISE EXCEPTION 'القيد رقم % غير متزن: مدين % ≠ دائن % - لازم يتساووا بالظبط', target_entry_id, total_debit, total_credit;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER trg_journal_entry_lines_balanced
  AFTER INSERT OR UPDATE OR DELETE ON journal_entry_lines
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION check_journal_entry_balanced();

-- عدم قابلية التعديل بعد الترحيل (DB-level) - قيد POSTED مينفعش أي سطر فيه يتضاف/يتعدّل/يتمسح خالص.
-- التصحيح الوحيد المسموح: قيد عكسي جديد منفصل (reversal)، مش لمس القيد الأصلي
CREATE OR REPLACE FUNCTION block_posted_journal_entry_line_changes() RETURNS TRIGGER AS $$
DECLARE
  entry_status TEXT;
BEGIN
  SELECT status INTO entry_status FROM journal_entries WHERE id = COALESCE(NEW.journal_entry_id, OLD.journal_entry_id);
  IF entry_status = 'POSTED' THEN
    RAISE EXCEPTION 'القيد ده مرحّل (POSTED) بالفعل - غير قابل للتعديل، اعمل قيد عكسي (reversal) بدل ما تعدّله';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_block_posted_lines_write
  BEFORE INSERT OR UPDATE OR DELETE ON journal_entry_lines
  FOR EACH ROW EXECUTE FUNCTION block_posted_journal_entry_line_changes();

-- نفس الحماية على رأس القيد نفسه - بعد POSTED، الحقول التانية كلها محمية، مسموح بس بانتقال
-- status: POSTED→REVERSED (وتسجيل reversed_by/reversed_at) عشان الإلغاء يفضل ممكن
CREATE OR REPLACE FUNCTION block_posted_journal_entry_changes() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' AND OLD.status IN ('POSTED', 'REVERSED') THEN
    RAISE EXCEPTION 'القيد ده مرحّل بالفعل - مينفعش يتمسح خالص';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.status = 'POSTED' THEN
    IF NEW.status NOT IN ('POSTED', 'REVERSED')
       OR NEW.entry_number <> OLD.entry_number OR NEW.entry_date <> OLD.entry_date
       OR COALESCE(NEW.description, '') <> COALESCE(OLD.description, '')
       OR NEW.source_type <> OLD.source_type OR COALESCE(NEW.source_id, -1) <> COALESCE(OLD.source_id, -1)
       OR COALESCE(NEW.branch_id, -1) <> COALESCE(OLD.branch_id, -1)
    THEN
      RAISE EXCEPTION 'القيد ده مرحّل (POSTED) بالفعل - غير قابل للتعديل، اعمل قيد عكسي (reversal) بدل ما تعدّله';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_block_posted_entry_changes
  BEFORE UPDATE OR DELETE ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION block_posted_journal_entry_changes();

-- سداد مورد - Accounts Payable (مدين) مقابل Cash/Bank (دائن)، مربوط بقيد محاسبي حقيقي. رصيد المورد
-- = مجموع سطور 2100 المرتبطة بيه (من GRN كدائن، من السداد كمدين) - مفيش عمود "رصيد" مخزّن منفصل
-- (كان هيعمل drift) - بيتحسب دايمًا من القيود وقت القراءة
CREATE TABLE supplier_payments (
  id                SERIAL PRIMARY KEY,
  supplier_id       INTEGER NOT NULL REFERENCES suppliers(id),
  branch_id         INTEGER NOT NULL REFERENCES branches(id),
  payment_date      DATE NOT NULL DEFAULT CURRENT_DATE,
  amount            NUMERIC NOT NULL CHECK (amount > 0),
  payment_method_id INTEGER REFERENCES payment_methods(id),
  reference_number  TEXT,
  notes             TEXT,
  journal_entry_id  INTEGER REFERENCES journal_entries(id),
  idempotency_key   TEXT,
  created_by        INTEGER REFERENCES users(id),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX idx_supplier_payments_idempotency_key ON supplier_payments(idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX idx_supplier_payments_supplier ON supplier_payments(supplier_id);
CREATE INDEX idx_supplier_payments_branch ON supplier_payments(branch_id);

-- expense_categories.account_id وexpenses.journal_entry_id اتعرّفوا قبل كدة في الملف - الـFKs بتتضاف
-- هنا بعد ما accounts/journal_entries يتعرّفوا فعليًا
ALTER TABLE expense_categories ADD CONSTRAINT fk_expense_categories_account FOREIGN KEY (account_id) REFERENCES accounts(id);
ALTER TABLE expenses ADD CONSTRAINT fk_expenses_journal_entry FOREIGN KEY (journal_entry_id) REFERENCES journal_entries(id);
-- المرحلة 4C: payroll_runs/payroll_payments معرّفين قبل كدة في الملف (قسم الرواتب) - الـFK بتتضاف هنا
ALTER TABLE payroll_runs ADD CONSTRAINT fk_payroll_runs_journal_entry FOREIGN KEY (journal_entry_id) REFERENCES journal_entries(id);
ALTER TABLE payroll_payments ADD CONSTRAINT fk_payroll_payments_journal_entry FOREIGN KEY (journal_entry_id) REFERENCES journal_entries(id);

-- شجرة الحسابات الافتراضية لساتاموني - حسابات مشتركة على مستوى الشركة (branch_id = NULL). حسابات الكاش
-- الفرعية (1100-N لكل فرع) بتتنشئ تلقائيًا أول مرة تتحتاج (db/accounting-engine.js) مش هنا، لأن الفروع
-- ديناميكية. ON CONFLICT DO NOTHING عشان السكريبت ده آمن يتشغّل تاني على قاعدة فيها الحسابات دي بالفعل
INSERT INTO accounts (code, name, account_type, is_system_account) VALUES
  ('1100', 'الكاش', 'ASSET', TRUE),
  ('1200', 'البنك', 'ASSET', TRUE),
  ('1300', 'عملاء (ذمم مدينة)', 'ASSET', TRUE),
  ('1350', 'مستحقات تطبيقات التوصيل', 'ASSET', TRUE),
  ('1400', 'المخزون', 'ASSET', TRUE),
  ('1500', 'مصروفات مدفوعة مقدمًا', 'ASSET', TRUE),
  ('2100', 'موردون (ذمم دائنة)', 'LIABILITY', TRUE),
  ('2200', 'مصروفات مستحقة', 'LIABILITY', TRUE),
  ('2300', 'ضرائب مستحقة', 'LIABILITY', TRUE),
  ('2400', 'رواتب مستحقة', 'LIABILITY', TRUE),
  ('3100', 'رأس مال المالك', 'EQUITY', TRUE),
  ('3200', 'أرباح مرحّلة', 'EQUITY', TRUE),
  ('3300', 'صافي ربح السنة الحالية', 'EQUITY', TRUE),
  ('4100', 'مبيعات الطعام', 'REVENUE', TRUE),
  ('4200', 'مبيعات التوصيل', 'REVENUE', TRUE),
  ('4300', 'مبيعات أخرى', 'REVENUE', TRUE),
  ('4900', 'خصومات المبيعات', 'REVENUE', TRUE),
  ('4950', 'مرتجعات المبيعات', 'REVENUE', TRUE),
  ('5100', 'تكلفة الطعام', 'COGS', TRUE),
  ('5200', 'تكلفة مستلزمات التغليف', 'COGS', TRUE),
  ('5300', 'تكلفة بضاعة مباعة أخرى', 'COGS', TRUE),
  ('6100', 'الرواتب', 'EXPENSE', TRUE),
  ('6200', 'الإيجار', 'EXPENSE', TRUE),
  ('6300', 'الكهرباء', 'EXPENSE', TRUE),
  ('6400', 'المياه', 'EXPENSE', TRUE),
  ('6500', 'الغاز', 'EXPENSE', TRUE),
  ('6600', 'عمولات تطبيقات التوصيل', 'EXPENSE', TRUE),
  ('6700', 'التسويق', 'EXPENSE', TRUE),
  ('6800', 'الصيانة', 'EXPENSE', TRUE),
  ('6900', 'مصروفات تشغيل أخرى', 'EXPENSE', TRUE)
ON CONFLICT (code) DO NOTHING;

-- ============================================================
-- محرك موافقات عام (Approval Requests) - لطلبات مش لازم تتحسم فورًا وقت البيع
-- (زي تسوية مخزون يطلبها كاشير ويعتمدها مدير الفرع) - يكمّل نظام الـPIN اللحظي، ما يستبدلوش
-- ============================================================
CREATE TABLE approval_requests (
  id                SERIAL PRIMARY KEY,
  type              TEXT NOT NULL,   -- inventory_adjustment, ... (قابل للتوسيع لاحقًا)
  entity_type       TEXT,
  entity_id         INTEGER,
  requested_by      INTEGER NOT NULL REFERENCES users(id),
  branch_id         INTEGER REFERENCES branches(id),
  amount            NUMERIC,
  reason            TEXT,
  payload           JSONB,           -- تفاصيل الإجراء المطلوب تنفيذه لو اتوافق عليه
  status            TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
  approved_by       INTEGER REFERENCES users(id),
  rejected_by       INTEGER REFERENCES users(id),
  approved_at       TIMESTAMPTZ,
  rejected_at       TIMESTAMPTZ,
  rejection_reason  TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_approval_requests_status ON approval_requests(status);
CREATE INDEX idx_approval_requests_branch ON approval_requests(branch_id);
