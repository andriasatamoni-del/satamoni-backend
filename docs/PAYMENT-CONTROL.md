# التحكم في المدفوعات والمطابقة — ستاموني

مرجع تقني لوحدة كشف تلاعب/فروق طريقة الدفع: من لحظة اختيار الكاشير لطريقة الدفع لحد التقرير اليومي
للمالك. راجع أيضًا `PAYMENT CONTROL & RECONCILIATION — IMPLEMENTATION REPORT.md` (في جذر المشروع)
للتقرير الكامل.

## الهدف

كشف 3 أنواع فروق حقيقية:
1. **أوردر طلبات اتسجّل بفيزا POS** - أوردرات طلبات المفروض تبقى آجل (مستحق من الشركة) أو كاش محصّل
   من الطيار، مش "فيزا داخلية" (العميل بيدفع للشركة/الطيار مش للكاشير مباشرة).
2. **فرق كاش طلبات** - الجزء النقدي المحصّل من أوردرات طلبات (`orders.talabat_cash_collected`)
   مقابل كشف حساب طلبات الشهري/اليومي.
3. **معاملات إنستاباي/أورانج كاش/تسوية فيزا من غير مطابقة** - دفعة داخلية من غير سطر كشف حساب يقابلها،
   أو العكس.

القاعدة الذهبية: **المطابقة (Reconciliation) بتقارن مصدرين مستقلين، مايوحّدهمش تلقائي** - نفس فلسفة
`GET /api/reports/accounting-reconciliation` بالظبط. النظام بيسجّل الفرق ويعرضه، القرار (تصحيح/تجاهل
اعتبارًا لتفسير معقول) بيفضل بشري دايمًا.

## قفل طريقة الدفع

طريقة الدفع بتتقفل **فور اختيار الكاشير ليها** - وقت إنشاء الطلب (لو `paymentMethodId` متحدد وقتها)
أو أول مرة تتحدد فيها لاحقًا (`db/payment-control-engine.js::lockPaymentForOrder`، بيتنادى من
`routes/orders.js` في `POST /` و`PUT /:id`). بعد القفل، أي محاولة تغيير مباشر لطريقة الدفع عبر
`PUT /api/orders/:id` بترفض بـ400 وضوح - لازم تعدّي على **Payment Adjustment Request**.

## نموذج البيانات

- **`payments`** - سجل مستقل لكل طلب (1:1 - مفيش split payments، برّه النطاق). نسخة مجمّدة من
  `method_kind`/`settlement_channel`/`channel` وقت القفل (نفس فلسفة `cost_at_sale`: لو حد غيّر تصنيف
  طريقة الدفع نفسها بعد كده، السجلات القديمة تفضل صحيحة تاريخيًا).
- **`payment_methods.settlement_channel`** - عمود جديد (`visa_pos`/`instapay`/`orange_cash`/
  `vodafone_cash`/`other`، NULL لغير `card_or_wallet`) - بيحدد أي كشف حساب خارجي طريقة الدفع دي بتتطابق
  معاه.
- **`payment_adjustment_requests`** - طلب تعديل بعد القفل. `amount_delta` بيحدد مين لازم يعتمده: لو
  المبلغ نفسه بيتغيّر، الفرق المطلق هو الـdelta؛ لو بس طريقة الدفع بتتغيّر (تصنيف قناة كامل)، المبلغ
  كله بيتحسب delta (إعادة تصنيف قناة كاملة أخطر من فرق مبلغ بسيط).
- **`payment_reconciliation_records`** - إدخال يدوي لسطور كشوف حساب خارجية (طلبات/فيزا/إنستاباي/
  أورانج كاش) - المصدر المستقل اللي بيتقارن مع `payments`.
- **`payment_audit_logs`** - سجل تدقيق مخصّص (منفصل عن `audit_logs` العام - تفاصيل أدق: before/after
  كاملة)، append-only بالفعل (مفيش UPDATE/DELETE route ليه).
- **`payment_daily_report_log`** - منع إرسال التقرير اليومي أكتر من مرة لنفس اليوم.

## موافقة التعديل - سقف مزدوج

بيستخدم **نفس نظام `approval_grants`** بتاع 9A-1 (`db/approval-engine.js`) - مفيش نظام موافقة جديد:
`actionType: "PAYMENT_ADJUSTMENT"`. مرشحي الموافقة: مدير فرع (Shift Supervisor) بنفس فرع الدفعة، أو
محاسب/أدمن. بعد استهلاك التوكن، السقف بيتحقق في `routes/payment-control.js` (نفس منطق سقف الخصم
المرحلي الموجود فعلًا - `discount_manager_max_percent` بالظبط):

- `amount_delta < pos_settings.payment_adjustment_high_threshold_egp` (افتراضيًا 500 ج.م) - مدير الفرع
  يقدر يعتمده لوحده.
- `amount_delta >= الحد` - لازم محاسب أو أدمن (`payment_control.adjustment.approve_high`)، مدير الفرع
  مش كفاية حتى لو معاه توكن PIN صحيح.

## الصلاحيات

`middleware/permissions.js` - مجموعة `payment_control`: `.view`، `.adjustment.request`،
`.adjustment.approve`، `.adjustment.approve_high`، `.reconciliation.enter`، `.exceptions.resolve`،
`.audit.view`. موزّعة على الأدوار الموجودة (بدون أدوار جديدة): Cashier (طلب تعديل بس) / Shift
Supervisor=branch_manager (رؤية + طلب + اعتماد أي مبلغ) / Accountant (كل حاجة فوق + السقف العالي +
إدخال مطابقة + سجل تدقيق) / Owner-Admin=admin (كل حاجة).

## نقاط المخاطر (Risk Score)

بتتحسب لحظيًا وقت الاستعلام (`db/payment-control-engine.js::computeExceptions`) - **مش عمود مخزّن**،
نفس فلسفة تقرير المطابقة المحاسبية بالظبط. أوزان جديدة مقترحة (مش قيم أصلية مسترجعة - راجع
`RISK_WEIGHTS` للتفاصيل والتعديل المستقبلي بناءً على بيانات فرع حقيقية):

| الحدث | نقاط |
|---|---|
| أوردر طلبات مسجّل بفيزا POS | 40 |
| فرق كاش طلبات (لكل 50 جنيه فرق، سقف 50) | 10 |
| إنستاباي/أورانج كاش من غير مطابقة بعد 3 أيام | 30 |
| فرق تسوية فيزا > 1% من مبيعات الفيزا في الفترة | 40 |
| ≥3 طلبات تعديل دفع من نفس الكاشير في نفس الشيفت | 25 |

تصنيف: 0-29 منخفض، 30-59 متوسط، ≥60 عالي.

## API

- `routes/payment-control.js` - `GET /payments`، `POST /adjustment-requests`،
  `GET /adjustment-requests`، `POST /adjustment-requests/:id/approve`،
  `POST /adjustment-requests/:id/reject`، `POST /reconciliation-records`،
  `GET /reconciliation-records`، `PATCH /reconciliation-records/:id/match`، `GET /exceptions`،
  `GET /reports/daily-owner`، `GET /audit-logs`.
- موافقة التعديل بتتصدر عبر `POST /api/auth/verify-override-pin` الموجود فعلًا (`actionType:
  "PAYMENT_ADJUSTMENT"`) - مفيش endpoint جديد لإصدار التوكن.

## واجهة الإدارة

`public/satamoni-payment-control.html` - صفحة مستقلة (بطاقة "التحكم في المدفوعات والمطابقة" في
الصفحة الرئيسية)، 8 تبويبات: نظرة عامة، سجل المدفوعات، طلبات تعديل الدفع، مطابقة طلبات، إنستاباي/
أورانج كاش، تسوية فيزا، الاستثناءات والمخاطر، سجل التدقيق. متاحة لـ admin/branch_manager/accountant
بس (مش cashier - الكاشير بيقدر يطلب تعديل عبر الـAPI مباشرة، الشاشة دي إدارية).

## التقرير اليومي للمالك - إرسال تلقائي

`db/payment-report-scheduler.js` - نفس بوابة `db/sms-provider.js` المستخدمة أصلًا لتأكيد الطلبات
(`SMS_WEBHOOK_URL`)، بدون بوابة إضافية. **معطّل تمامًا افتراضيًا**
(`pos_settings.payment_daily_report_enabled = FALSE` ورقم المالك فاضي) - محتاج تفعيل صريح من
الإعدادات + `owner_report_phone` + `payment_daily_report_hour` (افتراضيًا 9 مساءً بتوقيت القاهرة).
بيشتغل كـ`setInterval` جوه نفس الـprocess (نفس فلسفة `db/sync-worker.js` بس أبسط)، فحص كل 10 دقايق،
idempotent بالكامل عبر `payment_daily_report_log` (منع إرسال مكرر لنفس اليوم).

## حدود معروفة (صراحة، مش مخفية)

1. **المطابقة يدوية بالكامل في هذه المرحلة** - إدخال كشوف طلبات/فيزا/إنستاباي/أورانج كاش يدوي، مفيش
   استيراد ملفات (CSV/Excel) أو مطابقة تلقائية (fuzzy matching). مؤجّل صراحة لمرحلة تالية.
2. **أوزان نقاط المخاطر اقتراح جديد غير مُجرَّب على بيانات فرع حقيقية** - محتاجة مراجعة/تعديل بعد
   شهر تشغيل فعلي على الأقل.
3. **بوابة الإرسال (`SMS_WEBHOOK_URL`) نفسها مش مُختبَرة فعليًا ضد مزوّد حقيقي** - نفس القيد الموروث
   من 7S (تأكيد الطلبات)، مش قيد جديد خاص بالمرحلة دي.
4. **`payments` بيتقفل بس لو `paymentMethodId` متحدد فعليًا** - طلب اتسجّل من غير طريقة دفع (نادر) ومكملش
   تحديدها أبدًا مالوش سجل `payments` خالص، فمش هيظهر في أي فحص هنا.
