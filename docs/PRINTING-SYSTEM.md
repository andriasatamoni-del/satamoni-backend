# نظام الطباعة — ساتاموني

مرجع تقني لنظام الطباعة الإنتاجي: من لحظة تأكيد الطلب في الكاشير لحد الورقة الفعلية اللي بتخرج من
الطابعة الحرارية في الفرع. راجع أيضًا `print-agent/README.md` لتفاصيل تركيب وتشغيل الـAgent على جهاز
الفرع، و`PRINTING SYSTEM — IMPLEMENTATION REPORT.md` (في جذر المشروع) للتقرير الكامل A–K.

## المعمارية

```
POS / Order Workflow  →  Database (print_jobs)  →  Branch Print Agent (Node.js على جهاز الفرع)  →  الطابعة الفعلية
```

القاعدة الذهبية: **فشل الطباعة (طابعة مقطوعة، Agent مقفول، توجيه ناقص) ميرجّعش أبدًا يلغي أو يوقف الطلب
أو الدفع.** صفوف `print_jobs` بتتسجل جوه نفس transaction إنشاء/تحديث الطلب (اتساق ذرّي)، لكن الطباعة
الفعلية بتحصل بعد كده بالكامل وبشكل غير متزامن - لو التوجيه (محطة/طابعة) مش متظبط، السطر بيتسجل
`FAILED` فورًا بسبب واضح بدل ما يوقف حاجة.

## جدول البيانات

- **`printers`** — طابعات الفرع. `printer_type` ∈ `CASHIER | KITCHEN | DELIVERY | REPORT`.
  `connection_type` = `USB` (شغالة فعليًا دلوقتي، `os_printer_name` لازم يطابق اسم الطابعة بالظبط في
  Windows) أو `LAN` (الأعمدة `ip_address`/`port` جاهزة معماريًا، **مش مفعّلة فعليًا في الـAgent لسه** -
  راجع "حدود معروفة" تحت). `is_default_for_type` سلوك "زرار راديو" فعليًا - تفعيلها على طابعة بيلغي أي
  طابعة تانية افتراضية لنفس النوع في نفس الفرع أوتوماتيك (routes/printers.js).
- **`kitchen_stations`** — محطة تحضير (بيتزا/حلواني/...) مربوطة بفرع، وبعمود `printer_id` (التوجيه نفسه -
  قابل للتعديل من الإعدادات، مش هارد كودد).
- **`menu_categories.station_id`** و**`menu_items.station_id`** — التوجيه من المنيو للمحطة. الصنف بيغلب
  القسم لو الاتنين متسجلين.
- **`print_jobs`** — سطر لكل مستند مطلوب طباعته. `print_type` ∈ `CUSTOMER_RECEIPT | KITCHEN_TICKET |
  KITCHEN_SUMMARY | DELIVERY_SUMMARY | DELIVERY_FINAL_RECEIPT | DINE_IN_BILL | TEST_PRINT`.
  `status` ∈ `PENDING | PRINTING | PRINTED | FAILED | CANCELLED`. `content_html` = محتوى جاهز بالكامل
  (متولّد وقت إنشاء السطر، مش وقت الطباعة - نفس منطق `cost_at_sale` في الطلبات: ثابت تاريخيًا). `idempotency_key`
  فريد - نفس نمط `accounting-engine.js`/`inventory-ledger.js` (`ON CONFLICT DO NOTHING` + إعادة select).

## مين بيولّد الطباعة، وإمتى بالظبط (db/print-queue.js)

| نوع الطلب | الحدث | المستندات |
|---|---|---|
| تيك أواي | إنشاء الطلب (`POST /api/orders`) | `CUSTOMER_RECEIPT` (كاشير) + `KITCHEN_SUMMARY` (مطبخ) + `KITCHEN_TICKET` لكل محطة ظهرت في الطلب |
| دليفري | إنشاء الطلب (الطلب بيتسجل `preparing` من لحظة الإنشاء أصلًا) | `DELIVERY_SUMMARY` (دليفري، من غير سعر) + `KITCHEN_TICKET` لكل محطة |
| دليفري | تسليم الطلب للسائق (`POST /api/deliveries/:id/out-for-delivery`) | `DELIVERY_FINAL_RECEIPT` (فيه سعر - بيتسلّم للعميل) |
| صالة | إنشاء الطلب | **مفيش أي طباعة خالص** |
| صالة | `kitchen_status` توصل `PREPARING` (`PATCH /api/orders/:id/kitchen-status`) | `KITCHEN_TICKET` لكل محطة بس (من غير ملخص/إيصال) |
| صالة | طلب الجرسون (`POST /api/orders/:id/print-bill`) | `DINE_IN_BILL` (idempotent - ضغطة تانية بترجع نفس الصف، مفيش فاتورة مكررة) |
| أي طابعة | زرار "اختبار طباعة" في الإعدادات | `TEST_PRINT` (مش مرتبطة بطلب، مسموح تتكرر بحرية) |

**تفكيك الكومبو:** طلب فيه عرض (كومبو) بيتفكك لمكوّناته الحقيقية (`combo_items` -> `menu_item_variants`
-> `menu_items`)، وكل مكوّن بيروح لتذكرة محطته هو - مش محطة العرض ككل. عرض فيه بيتزا + مشروب بيولّد
تذكرتين منفصلتين، كل واحدة فيها مكوّنها بس (`db/print-queue.js::splitItemsByStation`).

**قاعدة السعر:** `CUSTOMER_RECEIPT`/`DELIVERY_FINAL_RECEIPT`/`DINE_IN_BILL` فيهم سعر (بيتسلّموا للعميل).
`KITCHEN_TICKET`/`KITCHEN_SUMMARY`/`DELIVERY_SUMMARY` من غير سعر خالص (للمطبخ/السائق).

## API

- `routes/printers.js` — CRUD طابعات + `/test-print`.
- `routes/kitchen-stations.js` — CRUD محطات + التوجيه (`/routing/menu-categories/:id`، `/routing/menu-items/:id`، `/routing/menu`).
- `routes/print-jobs.js` — واجهة الـAgent بس: `GET /` (قايمة PENDING)، `/:id/claim`، `/:id/printed`، `/:id/failed`، `/:id/retry`.
- صلاحيات جديدة في `middleware/permissions.js`: `printers.*`، `print_routing.*`، `print_jobs.view` /
  `print_jobs.manage_queue` (الـAgent) / `print_jobs.trigger` (زرار طباعة الفاتورة اليدوي).

## واجهة الإدارة

`public/satamoni-printing.html` — Settings > الطباعة، ٣ تبويبات: الطابعات، المحطات والتوجيه، طابور
الطباعة (مراقبة + إعادة محاولة للأوامر الفاشلة).

## Branch Print Agent

مشروع Node.js منفصل تمامًا (`print-agent/`) - **مش جزء من الباك إند** (عمدًا، عشان مايكسرش الديبلوي على
Linux/Render بمكتبات طباعة خاصة بـWindows). بيسحب أوامر PENDING بالـHTTP API بس (مفيش وصول مباشر
لقاعدة البيانات خالص)، بيحجزها (`claim`)، يرندرها HTML->PDF بـPuppeteer (نسخة Chromium معزولة تمامًا -
بيتفادى مشكلة `--kiosk-printing` اللي واجهناها فعليًا مع Chrome العادي)، وبيطبعها صامت بـ`pdf-to-printer`
على الاسم بالظبط المسجّل في `os_printer_name`. تفاصيل التركيب والتشغيل الدائم في `print-agent/README.md`.

## حدود معروفة (صراحة، مش مخفية)

1. **LAN (شبكة) للطابعات مش مفعّلة فعليًا** - الأعمدة (`ip_address`/`port`) جاهزة في الـschema والـUI،
   بس الـAgent حاليًا بيطبع على USB بس (`os_printer_name`). طباعة LAN حقيقية محتاجة تحويل HTML لبايتات
   ESC/POS خام (raster) - مسار رندر مختلف تمامًا، ومطلوب صراحة يفضل "جاهز معماريًا لحد ما يتفعّل لاحقًا".
2. **"فاتورة الصالة (Bill) بتتحصّل عند الدفع"** - النظام الحالي مفيهوش مفهوم "حساب مفتوح، يتقفل بعدين"
   لطلبات الصالة أصلًا: طلب الصالة بيتسجل `status='completed'` (مدفوع) من لحظة الإنشاء في الكاشير، زي
   التيك أواي بالظبط. مفيش تعديل على دورة حياة الطلب اتعمل هنا (بالظبط زي ما اتطلب صراحة - "متعملش نظام
   طلبات تاني متعارض"). عمليًا: `DINE_IN_BILL` بيتطبع بطلب الجرسون في أي وقت قبل الإلغاء (الاستخدام
   الواقعي: قبل ما الكاشير يسجّل الدفع فعليًا)، وده اللي بيعادل "الفاتورة النهائية" هنا.
3. **الطباعة الفعلية على الطابعة الحرارية الحقيقية (XP-D200N) لسه مش اتأكدت** - كل الاختبارات هنا (25
   اختبار Jest) بتتحقق من الطبقة اللي قبل الطباعة الفعلية بس (إنشاء الأمر، التوجيه، المحتوى، الـAPI).
   الطباعة الفعلية على الهاردوير الحقيقي محتاجة اختبار يدوي على جهاز فيه الطابعة موصّلة - راجع "الإجراء
   اليدوي بالضبط" في التقرير النهائي.
