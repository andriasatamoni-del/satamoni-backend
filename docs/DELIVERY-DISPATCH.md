# لوحة التوزيع ودورة حياة التوصيل (Delivery Dispatch)

## `dispatch_status` منفصل عمدًا عن `orders.status`

بدل ما نعيد تصميم دورة حياة الطلب الأساسية (`preparing`/`out_for_delivery`/`completed`/`cancelled` —
مستخدمة في كل مكان: تقفيل يوم الفرع، المحاسبة، التقارير)، أضفنا عمود جديد **`orders.dispatch_status`**
منفصل تمامًا — نفس فلسفة `payment_status` المنفصلة عن `status` بالظبط. القيمة دي `NULL` لأي طلب مش
دليفري، وبتتفعّل بس لما `orderType='delivery'`:

```
UNASSIGNED → ASSIGNED → OUT_FOR_DELIVERY → DELIVERED
                                       └──→ FAILED → UNASSIGNED (إعادة جدولة)
                                                  └→ RETURNED (عن طريق POST /:id/void الموسّع)
```

### التزامن مع `orders.status`

- `UNASSIGNED`/`ASSIGNED`: `orders.status` لسه `preparing` (لسه في المطبخ/جاهز، السائق لسه ما تحركش).
- `OUT_FOR_DELIVERY`: `orders.status` بيتزامن لـ`out_for_delivery` (نفس القيمة القديمة قبل المرحلة دي).
- `DELIVERED`: `orders.status` بيتزامن لـ`completed`.
- `FAILED`: `orders.status` بيفضل `out_for_delivery` — الطلب لسه "شغال" فعليًا لحد ما حد يقرر مصيره.
- `RETURNED`: بيتسجل بس لما `POST /api/orders/:id/void` يتنادى على طلب `FAILED` — `orders.status`
  بيبقى `cancelled` وقتها (راجع تحت).

هذا التصميم يعني إن أي كود قديم بيقرا `orders.status` بس (تقفيل يوم الفرع، تقارير قديمة) يفضل شغال
صح من غير أي تعديل — `dispatch_status` طبقة تفصيل إضافية فوقه بس.

## تعيين السائق

`POST /api/deliveries/:orderId/assign {driverId}` — مقفول على `deliveries.assign`
(`branch_manager`/`admin`)، ومقفول على نفس فرع الطلب (`assertOwnBranch`). شروط:

- الطلب لازم يكون `order_type='delivery'` و`dispatch_status` من `UNASSIGNED` أو `FAILED` بس.
- السائق لازم يكون تابع لنفس فرع الطلب (`DRIVER_BRANCH_MISMATCH` غير كده).
- السائق لازم `is_active=TRUE` وحالته `AVAILABLE` أو `BUSY` (`DRIVER_NOT_AVAILABLE` غير كده).

`POST /api/deliveries/:orderId/unassign` — بس قبل ما السائق يتحرك بيه (`dispatch_status='ASSIGNED'`).

## لوحة التوزيع

`GET /api/deliveries?branchId=&status=&driverId=&date=&paymentMethod=` — قايمة كل طلبات الدليفري
للفرع مع الفلاتر المطلوبة، بترجّع رقم الطلب، العميل، المنطقة، رسوم التوصيل، طريقة الدفع، الإجمالي،
السائق، ووقت الانتظار. الواجهة: `public/satamoni-dispatch.html` (تاب "لوحة التوزيع").

## دورة حياة السائق نفسه

- `POST /api/deliveries/:orderId/out-for-delivery` — السائق (لطلبه هو بس) أو المدير. `ASSIGNED →
  OUT_FOR_DELIVERY`.
- `POST /api/deliveries/:orderId/delivered {collectedAmount?}` — تفاصيل تحصيل الكاش تحت.
- `POST /api/deliveries/:orderId/failed {reason}` — `reason` لازم يكون واحد من: `CUSTOMER_UNREACHABLE`
  / `CUSTOMER_REFUSED` / `WRONG_ADDRESS` / `CLOSED_LOCATION` / `OTHER`.

كل انتقال حالة **بيتقفل بـ`SELECT ... FOR UPDATE`** على صف الطلب جوه transaction قبل أي تحقق (نفس نمط
`routes/shifts.js`) — لو طلبين متوازيين حاولوا يغيّروا نفس الطلب، واحد بس ينجح.

## تحصيل الكاش عند التسليم (COD)

عند `DELIVERED`، لو `payment_methods.kind='cash'` والطلب لسه `payment_status='pending_collection'`:

- `collectedAmount` **إجباري** — مفيش "اتسلّم" من غير رقم.
- `collection_variance = collectedAmount - order.total` بيتسجل فورًا على الطلب.
- `payment_status` بيتحوّل لـ`collected` تلقائيًا.
- قيد محاسبي بيترحّل (تفاصيله الكاملة والمعادلة في `docs/DRIVER-SETTLEMENT.md`).

لو الدفع مش كاش (كارت/محفظة/آجل)، أو كان محصّل بالفعل، `DELIVERED` بتنجح من غير أي مبلغ مطلوب ومن
غير أي قيد إضافي — الطلب بيكمّل عادي زي أي طلب اتسلّم.

## فشل التسليم

`FAILED` **مبيفترضش** إن الفلوس اتحصّلت ولا حتى تتحصّل خالص — مفيش أي تغيير على `payment_status` أو
`collected_amount` عند الفشل. القرار بعد الفشل مفتوح على قرارين بس (موثّقين صراحة، مش مفترَضين تلقائيًا):

1. **إعادة جدولة** (`POST /api/deliveries/:orderId/reschedule`، مدير/أدمن بس): `FAILED → UNASSIGNED`،
   السائق (نفسه أو غيره) يقدر ياخد الطلب تاني. مفيش أي عكس مخزون/محاسبة — الطلب لسه "مبيعتش" فعليًا،
   بس محتاج محاولة تانية.
2. **رجوع/إلغاء** — عن طريق `POST /api/orders/:id/void` (الموسّع في المرحلة دي، راجع تحت)، مش عن طريق
   محرك التوصيل نفسه.

### ليه الرجوع عن طريق `void` مش endpoint جديد؟

قرار مقصود لتجنّب ازدواج المنطق. `POST /api/orders/:id/void` الموجود أصلًا (من مرحلة سابقة) عنده
بالفعل **كل** المنطق الصحيح والمُختبر لعكس أثر طلب: إرجاع المخزون (`SALE_REVERSAL`)، إرجاع نقاط
الولاء، وعكس القيد المحاسبي الأصلي (`reverseJournalEntry`). المرحلة دي وسّعت شرط القبول بس (سطر واحد):

```js
const isVoidableFailedDelivery = order.status === "out_for_delivery" && order.dispatch_status === "FAILED";
```

بدل ما نكتب دالة عكس جديدة (مخالف صراحة لتعليمة المرحلة "لا تُنشئ استرجاع مخزون مكرر، لا تُنشئ عكس
محاسبي مكرر")، أي طلب دليفري فشل تسليمه وقرر حد إنه هيرجع/يتلغي بيمرّ بنفس المسار المُختبر بالظبط. عند
النجاح، `dispatch_status` بيتحدّث لـ`RETURNED` تلقائيًا (سطر واحد إضافي في نفس الـUPDATE).

**قيد معروف**: لو الطلب بقى `RETURNED`، مفيش أي افتراض تلقائي عن سلامة الأكل (يترمي ولا يترجّع
للمخزون لو المكوّنات آمنة) — ده قرار تشغيلي/سلامة غذاء لازم يتاخد بمعرفة الفرع، مش بيفتّرضه النظام. لو
الفرع قرر إن جزء من المكوّنات آمن يترجّع للمخزون، ده بيتعمل عن طريق أدوات التسوية اليدوية الموجودة
أصلًا في `routes/inventory.js` (نفس المسار المستخدم لأي تسوية مخزون تانية) — مش بيتفعّل تلقائيًا.

## اختبارات

`tests/driver-delivery.test.js` يغطي كل انتقال حالة (بما فيهم الرفض للانتقالات غير الصحيحة)، تعيين/
إلغاء تعيين، فشل وإعادة جدولة، الاسترجاع الموسّع (استرجاع مخزون+قيد محاسبي حقيقي متحقق منه)، ولوحة
التوزيع مع عزل الفروع.
