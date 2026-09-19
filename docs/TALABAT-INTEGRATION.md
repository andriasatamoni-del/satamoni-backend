# تكامل Talabat Partner API ← Stamoni POS

**حالة التنفيذ**: كل البنية الداخلية جاهزة ومختبرة بالكامل (webhook + idempotency + مزامنة أوردرات +
قفل دفع + إلغاء + إعادة محاولة + مطابقة داخلية + لوحة تحكم)، **بس التكامل الفعلي مع Talabat نفسه لسه
موقوف عمدًا** لحد ما تتوفر:
1. مواصفة Talabat Partner API الحقيقية (endpoint الـOAuth، شكل الـwebhook الفعلي، حقول GET Order
   Details/History الحقيقية) - النظام دلوقتي **مش عارف** شكل الحقول دي، وعمدًا مبنيش على تخمين.
2. تأكيد من Account Manager بتاع Talabat إن حساب Stamoni مؤهل لـPartner Picking / POS integration
   للفروع المطلوبة.
3. Sandbox credentials حقيقية (client_id/client_secret) لاختبار كامل قبل الإنتاج.

من غيرهم، النظام شغال عادي 100% (مفيش أي تأثير على باقي المطعم) - أي نداء فعلي لـTalabat API بيرجع
خطأ واضح (`TalabatNotImplementedError`)، ولوحة التكامل بترجع حالة اتصال صادقة (`NOT_CONFIGURED` أو
`CONFIGURED_UNVERIFIED`) بدل ما تدّعي اتصال حقيقي مالحصلش.

**الفلسفة الحاكمة لكل قرار هنا (زي ما اتحدد صراحة في المهمة الأصلية)**:
> لا تعتمد على "الكاشير أمين" ولا "مدير الكاشير هيراجع" ولا "المحاسب هيراجع". النظام يجب أن يقلل قدرة
> أي مستخدم على التلاعب أصلًا. المبدأ: **PREVENT → DETECT → AUDIT** وليس: TRUST → REVIEW.

---

## 1) الهدف الأساسي

مش بس توفير وقت الكاشير - **إلغاء إمكانية التلاعب بطريقة الدفع عند إعادة إدخال طلبات Talabat**. الأوردر
بيتسجل تلقائيًا من الـwebhook، وطريقة الدفع القادمة من Talabat هي **مصدر الحقيقة المقفول** - الكاشير
مش بيدخلها من أي شاشة بيع عادية، ومينفعش تتغير إلا عبر مسار موافقة استثنائي منفصل (القسم 6).

---

## 2) خريطة الملفات

| الملف | الدور |
|---|---|
| `services/talabat/talabat-client.js` | **STUB** - الاتصال الحقيقي بـTalabat (OAuth، GET order details/history). كل دالة بترمي `TalabatNotImplementedError` واضحة لحد ما المواصفة الحقيقية تتوفر. |
| `services/talabat/talabat-payload-adapter.js` | **STUB** - تحويل الـwebhook payload الخام (شكل Talabat الحقيقي، غير معروف) لشكل داخلي مُصمَّم مننا اسمه "NormalizedTalabatOrder" (موثّق بالتفصيل جوه الملف). كل باقي الـpipeline مبني على الشكل الداخلي ده بس - مش على حقول Talabat الحقيقية - عشان يكون قابل للبناء/الاختبار دلوقتي. |
| `services/talabat/talabat-webhook-auth.js` | توقيع HMAC-SHA256 (نفس نمط webhook واتساب المُختبَر) - fail-closed دايمًا. |
| `services/talabat/talabat-order-sync.js` | محرك المزامنة: NormalizedTalabatOrder → أوردر POS حقيقي عبر `createOrderHandler` (نفس محرك الكاشير بالظبط - صفر منطق موازي). |
| `services/talabat/talabat-cancellation.js` | إلغاء Talabat → تحويل حالة الأوردر لـ'cancelled' عبر `voidOrderHandler` (نفس مسار الاسترجاع الوحيد في النظام) - أبدًا DELETE. |
| `services/talabat/talabat-reconciliation.js` | المطابقة اليومية - `compareTalabatRecords` نقية ومختبرة بالكامل؛ `runDailyReconciliation` بتحاول تجيب سجلات Talabat الحقيقية (لسه stub). |
| `services/talabat/talabat-shared.js` | أدوات مشتركة (تسجيل Integration Error، جلب المستخدم النظامي، التقاط استجابة handler اصطناعي). |
| `routes/talabat-webhook.js` | `POST /api/talabat/webhook/orders` - الاستقبال الفعلي (محمي بتوقيع، مش بتسجيل دخول). |
| `routes/talabat.js` | شاشات الإدارة: integration-errors (list/retry)، reconciliation، dashboard-summary، payment-control-report. |
| `public/satamoni-talabat-integration.html` | لوحة التحكم (تبويبين: لوحة التحكم، Payment Control). |
| `routes/orders.js` (`createOrderHandler`, `voidOrderHandler`) | مُصدَّرين للاستدعاء الداخلي - **صفر تغيير في منطقهم الداخلي**، بس rename لدالة مسمّاة قابلة للاستدعاء بـreq/res اصطناعي. |

---

## 3) الجداول (`db/schema.sql` + `db/migrations/0049_talabat_integration.js`, `0050_talabat_branch_mapping.js`)

- **`talabat_orders`**: صف تتبّع 1:1 لكل أوردر Talabat (`talabat_order_id` UNIQUE، `pos_order_id` UNIQUE
  FK لـ`orders.id`). `order_status`: RECEIVED → MAPPING_ERROR | IMPORTED | FAILED | CANCELED.
- **`talabat_product_mapping`**: `talabat_item_id` → `stamoni_menu_item_id`/`stamoni_variant_id` (لكل
  فرع). صنف مش موجود هنا = `MAPPING_ERROR` مرئي، مش تجاهل صامت.
- **`talabat_webhook_events`**: سجل استلام كل حدث webhook (`dedupe_key` UNIQUE = sha256 الجسم الخام).
- **`talabat_integration_errors`**: أي فشل في أي مرحلة (adapter/mapping/order-creation/cancellation) -
  `retry_count`/`last_retry_at`/`status` (OPEN → RETRYING → RESOLVED/OPEN).
- **`payment_methods.talabat_payment_code`**: يربط كود دفع Talabat الخام بطريقة دفع Stamoni حقيقية.
- **`branches.talabat_branch_id`**: يربط معرّف متجر/فرع Talabat بفرع Stamoni حقيقي.
- **مستخدم نظامي**: `talabat-integration@system.internal` (role=admin، branch_id=NULL، كلمة سر
  عشوائية bcrypt مش معروفة لحد) - الـactor اللي بينفّذ كل عملية مزامنة/إلغاء داخليًا.

---

## 4) تدفق أوردر جديد (خطوة بخطوة)

1. Talabat تبعت webhook → `POST /api/talabat/webhook/orders`.
2. توقيع HMAC بيتحقق منه (`TALABAT_WEBHOOK_SECRET`) - fail closed لو مش متسجل أو غلط.
3. `dedupe_key = sha256(الجسم الخام)` بيتسجل بـ`ON CONFLICT DO NOTHING` - إعادة إرسال حرفية = "duplicate"
   بدون أي معالجة تانية.
4. `talabat-payload-adapter.js` بيحاول يحوّل الجسم الخام لـNormalizedTalabatOrder - **لسه بيرمي
   `TalabatPayloadNotImplementedError`** (القسم 8 تحت يوضح إيه اللي لازم يتعمل هنا بالظبط).
5. (بمجرد ما (4) يتنفّذ) `talabat-order-sync.js:syncNormalizedOrder`:
   - يحل الفرع (`branches.talabat_branch_id`) - مش موجود = `BRANCH_UNMAPPED`.
   - يتأكد إن الأوردر ده مش مستورد قبل كده (`talabat_orders.pos_order_id`) - لو موجود، `ALREADY_IMPORTED`
     (الـ1:1 مضمون structurally عبر الـUNIQUE constraint كمان، مش مجرد اتفاق كود).
   - يحل طريقة الدفع (`payment_methods.talabat_payment_code`) - مش موجودة = `PAYMENT_METHOD_UNMAPPED`.
   - يحل كل صنف (`talabat_product_mapping`) - أي صنف مش مربوط = `MAPPING_ERROR` (كل الأوردر، مش صنف
     بصنف - مفيش أوردر جزئي أبدًا).
   - ينادي `createOrderHandler` (نفس محرك الكاشير) بـreq/res اصطناعي والـmعامل النظامي - خصم مخزون/
     وصفة، قفل دفع (`lockPaymentForOrder`)، قيد محاسبي، كل حاجة زي أي أوردر كاشير عادي بالظبط.
   - فشل إنشاء الأوردر (نقص مخزون مثلًا) = `TALABAT_ORDER_FAILED` مسجّل، مش نجاح صامت.

---

## 5) الإلغاء

Talabat webhook بحالة `CANCELED` → `talabat-cancellation.js:cancelTalabatOrder`:
- الأوردر مستورد فعليًا → `voidOrderHandler` (نفس مسار الاسترجاع الوحيد - عكس مخزون/ولاء/قيد محاسبي
  كامل) → `orders.status = 'cancelled'`، **أبدًا DELETE**. `talabat_orders.cancellation_source =
  'TALABAT'` و`canceled_at` بيتسجلوا كدليل واضح إن الإلغاء ده جاي من طلبات نفسها.
- الأوردر لسه ملوش أوردر POS (كان MAPPING_ERROR) → صف التتبّع بس بيتحدّث لـCANCELED.
- إلغاء لأوردر مش متتبّع خالص → `ORPHAN_CANCELLATION` مرئي.

---

## 6) قفل الدفع + آلية الاعتماد الاستثنائي (Payment Override)

طريقة الدفع بتتقفل تلقائيًا وقت إنشاء الأوردر (`lockPaymentForOrder` - نفس آلية أي أوردر كاشير، صفر كود
جديد). أي محاولة تعديلها بعد كده بتمر من `routes/payment-control.js` (`POST /adjustment-requests` +
`/:id/approve`) اللي دلوقتي بيتحقق **إضافيًا** إن الأوردر ده مصدره Talabat، وساعتها بيطلب صلاحية منفصلة
`talabat.payment_override` (محاسب/أدمن بس - الكاشير ومدير الفرع معندهمش، حتى لو معاهم الصلاحية العامة
`payment_control.adjustment.request`/`approve`). تقرير "Payment Overrides" الفعلي هو
`GET /api/payment-control/talabat-payment-overrides`.

---

## 7) الصلاحيات (`middleware/permissions.js`, مجموعة `talabat`)

| الصلاحية | مين معاها |
|---|---|
| `talabat.view` | كاشير، كول سنتر، مدير فرع، محاسب، أدمن |
| `talabat.retry` | مدير فرع، محاسب، أدمن |
| `talabat.payment_override` | محاسب، أدمن **بس** |
| `talabat.reconciliation` | محاسب، أدمن **بس** |
| `talabat.mapping_manage` | أدمن **بس** |
| `talabat.integration_admin` | أدمن **بس** |

---

## 8) اللي المطلوب فعله بالظبط لتفعيل التكامل الحقيقي

1. **اقرأ مواصفة Talabat Partner API الحالية فعليًا** (Sandbox environment، OAuth flow، webhook payload
   schema، GET Order Details/History response schema). لا تخمّن.
2. **`services/talabat/talabat-client.js`**: نفّذ `getAccessToken`/`getOrderDetails`/`getOrderHistory`
   بالـendpoints/الحقول الحقيقية. اقرأ `TALABAT_CLIENT_ID`/`TALABAT_CLIENT_SECRET`/`TALABAT_API_BASE_URL`/
   `TALABAT_TOKEN_URL` من متغيرات البيئة السيرفر فقط (موجودين بالفعل في `.env.example`) - **ممنوع** تحطهم
   في أي كود frontend أو sessionStorage.
3. **`services/talabat/talabat-payload-adapter.js`**: نفّذ `normalizeTalabatOrderPayload` بالحقول
   الحقيقية، محوّلة لشكل `NormalizedTalabatOrder` الموثّق أعلى الملف (الشكل ده صُمِّم داخليًا ومستقر -
   باقي الـpipeline مش هيحتاج يتغيّر خالص).
4. **`services/talabat/talabat-webhook-auth.js`**: أكّد اسم header التوقيع والخوارزمية الحقيقية من
   المواصفة (افتراضيًا HMAC-SHA256 زي واتساب - عدّل لو مختلف).
5. **إدارة الربط** (قبل استلام أي أوردر حقيقي): اربط كل فرع فعلي بمعرّف متجره عند Talabat
   (`branches.talabat_branch_id`)، كل طريقة دفع بكود Talabat المقابل (`payment_methods.talabat_payment_code`)،
   وكل صنف منيو مباع على Talabat بمعرّفه عندهم (`talabat_product_mapping`).
6. **Sandbox أولًا**: اختبر كل الـ17 سيناريو (القسم 9) ضد Sandbox حقيقي قبل أي بيانات اعتماد Production.
   Production credentials تتحط في بيئة الإنتاج فقط - أبدًا في بيئة اختبار.
7. تأكد من Account Manager إن التفعيل متاح فعليًا للـstores المطلوبة (Partner Picking / POS integration
   eligibility) - ده شرط تجاري مش تقني، لازم يتأكد قبل ما أي حركة حقيقية تعدّي.

---

## 9) سيناريوهات ما قبل الإنتاج (تغطية الاختبارات الحالية)

| # | السيناريو | مغطى؟ | الملف |
|---|---|---|---|
| 1 | webhook مكرر (نفس البايت) | ✅ | `tests/talabat-webhook.test.js` |
| 2 | إعادة محاولة webhook فشل | ✅ | `tests/talabat-retry.test.js` |
| 3 | صنف مش معروف (unmapped) | ✅ | `tests/talabat-order-sync.test.js` |
| 4 | فشل إنشاء أوردر POS بعد استلام ناجح | ✅ | `tests/talabat-order-sync.test.js` |
| 5 | إلغاء من Talabat | ✅ | `tests/talabat-cancellation.test.js` |
| 6 | فرق دفع (Talabat vs POS) | ✅ | `tests/talabat-dashboard.test.js` |
| 7 | فشل شبكة حقيقي مع Talabat API | ⏸️ يحتاج client حقيقي (القسم 8) |
| 8 | Talabat API غير متاح | ⏸️ يحتاج client حقيقي |
| 9 | انتهاء صلاحية التوكن | ⏸️ يحتاج client حقيقي |
| 10 | أوردر مكرر (نفس talabat_order_id) | ✅ | `tests/talabat-order-sync.test.js` (ALREADY_IMPORTED) |
| 11 | فروع متعددة (عزل بيانات) | ✅ | `tests/talabat-dashboard.test.js` |
| 12 | نفس أوردر Talabat مايعملش أوردر POS تاني | ✅ | `tests/talabat-order-sync.test.js` (1:1) |
| 13 | الكاشير مايقدرش يغيّر دفع Talabat | ✅ | `tests/talabat-payment-override.test.js` |
| 14 | اعتماد مدير مخوَّل لتعديل دفع | ✅ | `tests/talabat-payment-override.test.js` |
| 15 | سجل تدقيق كامل | ✅ | `payment_audit_logs`/`talabat_integration_errors` مغطّاة عبر الاختبارات فوق |
| 16-17 | Sandbox-first، Production منفصل | ⏸️ سياسة تشغيلية - راجع القسم 8 بند 6 |

السيناريوهات المُعلَّمة ⏸️ محتاجة الـclient الحقيقي (القسم 8) - مش قابلة للاختبار من غير اتصال Talabat
فعلي، وده متوقع ومتعمّد مش نقص تنفيذ.

---

## 10) تشغيل التقارير/اللوحة

- `GET /api/talabat/dashboard-summary?branchId=&date=` - حالة الاتصال، أوردرات اليوم، ملخص الدفع،
  الاستثناءات المفتوحة.
- `GET /api/talabat/payment-control-report?branchId=&from=&to=` - "Talabat Payment Control".
- `GET /api/talabat/reconciliation?branchId=&from=&to=` - المطابقة اليومية (`TALABAT_API_NOT_CONFIGURED`
  لحد ما الـclient الحقيقي يتفعّل).
- `GET/POST /api/talabat/integration-errors[/:id/retry]` - شاشة الأخطاء + إعادة المحاولة.
- الصفحة: `public/satamoni-talabat-integration.html`.
