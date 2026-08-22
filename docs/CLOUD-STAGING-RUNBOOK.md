# دليل نشر Staging سحابي (Render) — Phase 7A

**الحالة**: هذا الدليل مُعَدّ (prepared) بس **لسه مش مُنفّذ فعليًا** — بيئة العمل الحالية (الجلسة اللي كتبت
الدليل ده) ممنوعة صراحة من الوصول لـ`render.com` على مستوى سياسة الشبكة (اتفحص فعليًا: أي طلب لـ
`api.render.com`/`render.com`/`dashboard.render.com` بيترفض برسالة `403 policy denial` من الـproxy).
يعني الخطوات هنا **لازم تتنفّذ يدويًا من حد عنده وصول فعلي لحساب Render** (المستخدم، أو جلسة تانية
عندها وصول شبكة مفتوح). بعد التنفيذ، سيب الردود/النتائج في الأماكن المُعلّمة `<<املأ هنا>>` وابعتها
تاني عشان يتبني عليها تقرير `PHASE 7A — CLOUD PLATFORM & STAGING VALIDATION REPORT.md` بأمانة (مش
تخمين).

**اختيار Render نفسه اتبنى على تقييم فعلي لأربع منصات** (Render/Railway/DigitalOcean/AWS — مقارنة
تفصيلية، تكلفة، ومخاطر vendor lock-in) موثّق كامل في
[`PHASE 7A — CLOUD PLATFORM & STAGING VALIDATION REPORT.md`](../PHASE%207A%20—%20CLOUD%20PLATFORM%20&%20STAGING%20VALIDATION%20REPORT.md)
قسم 4-6 — مش افتراض إن Render هو الوحيد المتاح.

**قاعدة أمان صارمة قبل أي خطوة**: القاعدة اللي هتتعمل دلوقتي **staging بس** — قاعدة بيانات منفصلة تمامًا
عن أي قاعدة إنتاج حقيقية، وعن قاعدة `satamoni_test` المحلية (Jest)، وعن أي قاعدة تطوير. متستخدمش بيانات
عملاء/موظفين/مالية حقيقية فيها أبدًا.

---

## قرار مهم اتخذ في مرحلة التحضير: `NODE_ENV` في الـstaging

طلب المرحلة الأصلي اقترح `NODE_ENV=staging`. **فحصنا الكود فعليًا ولقينا إن ده قرار خطر** لو اتنفّذ
حرفيًا: ثلاث طبقات حماية من المرحلة 6B بتتفعّل بس لما `NODE_ENV === "production"` بالظبط (مش أي قيمة
تانية):

| الملف | السلوك لو `NODE_ENV=staging` (غير `production`) |
|---|---|
| `middleware/cors.js` | الـCORS lockdown (رفض أي origin غير محدد) **مش بيتفعّل** — بيرجع لسلوك التطوير المفتوح `{}` |
| `middleware/security-headers.js` | `Strict-Transport-Security` header **مش بيتضاف** |
| `middleware/error-sanitizer.js` | رسائل خطأ 500 التفصيلية (ممكن تسرّب تفاصيل داخلية) **بتفضل زي ما هي** بدل ما تتعقّم |
| `db/env-validation.js` | هيطبع warning: `NODE_ENV = "staging" مش قيمة معروفة` |

**القرار**: هنستخدم `NODE_ENV=production` فعليًا لخدمة الـstaging على Render (عشان كل طبقات الحماية
دي تشتغل زي الإنتاج فعلاً — ده أصلاً الهدف من "staging بيحاكي الإنتاج")، ونعتمد على **اسم الخدمة نفسها**
(`satamoni-staging`) واسم القاعدة (`satamoni-staging-db`) للتفرقة إنها staging مش إنتاج حقيقي، مش على
قيمة `NODE_ENV`. هذا قرار توثيقي بس (مفيش تعديل كود) — ملحوظة: ده معناه لازم تتأكد إنك **مش** حاطط
`CORS_ORIGINS` فاضي بالغلط في بيئة فيها فرونت إند بيتقدّم من origin مختلف، لأن `NODE_ENV=production`
من غير `CORS_ORIGINS` = رفض كل cross-origin تمامًا (آمن بس ممكن يكسر الواجهة لو مش متوقّع).

---

## الخطوة 0 — تجهيز محلي (اتعمل بالفعل في جلسة التحضير)

- [x] `db/pool.js`: إضافة دعم SSL اختياري (`DB_SSL=true` → `{ rejectUnauthorized: false }`, افتراضي
      `false` زي ما كان بالظبط — مفيش تأثير على أي بيئة موجودة). قواعد البيانات المُدارة السحابية
      (Render من ضمنها) بترفض الاتصال من غير SSL افتراضيًا، فمن غير ده أول اتصال هيفشل فورًا.
      **ملحوظة صراحة**: `rejectUnauthorized: false` ده الإعداد الشائع لمزوّدين زي Render/Heroku (شهادة
      من CA وسيط مش في الـtrust store الافتراضي)، بس **ده مش مؤكد من توثيق Render الرسمي في جلسة
      التحضير دي** (مفيش وصول شبكة للتوثيق) — تأكد منه فعليًا وقت النشر (لو الاتصال فشل بخطأ SSL، راجع
      قسم "قاعدة البيانات" في لوحة تحكم Render نفسها للقيمة الدقيقة المطلوبة).
- [x] اختبار جديد (`tests/pool-ssl.test.js`) بيتأكد من سلوك `DB_SSL` بمحاكاة `pg.Pool` — 3/3 ناجح.
- [x] Full regression: **311/311 ناجح** (308 سابق + 3 جديد) بعد التعديل — مفيش أي تأثير على السلوك
      المحلي/الاختبار الحالي.
- [x] `render.yaml` الموجود في الريبو **مُتروك زي ما هو عمدًا** (اسمه `satamoni-backend`/`satamoni-db`
      — يوحي بإنه معدّ لإنتاج حقيقي لاحق). الدليل ده بيوجّهك تعمل خدمة/قاعدة **منفصلتين تمامًا** بأسماء
      staging واضحة عن طريق لوحة تحكم Render مباشرة (مش Blueprint) — عشان نضمن الـstaging محتلطش
      بإعداد الإنتاج المستقبلي بأي شكل.

---

## الخطوة 1 — إنشاء قاعدة PostgreSQL على Render

1. لوحة تحكم Render → **New +** → **PostgreSQL**.
2. الاسم: `satamoni-staging-db` (بالظبط بالبادئة `staging` — عشان تتفادى أي لبس مستقبلي مع إنتاج حقيقي).
3. الخطة: أرخص خطة متاحة (Free/Starter) كافية لـstaging.
4. بعد الإنشاء، من صفحة القاعدة سجّل:
   - **Internal Database URL**: `<<املأ هنا>>` (يستخدم بس لو الـWeb Service والـDB في نفس شبكة Render)
   - **External Database URL**: `<<املأ هنا>>` (المطلوب فعليًا لسكريبتات backup/restore اللي بتشتغل من برّه
     Render، وأي اتصال مباشر من جهازك — تأكد الاسم الدقيق للحقل في لوحة التحكم عندك، ممكن يختلف شوية)
   - **PostgreSQL Version**: `<<املأ هنا>>` — لازم تكون **13 أو أحدث** (المشروع بيستخدم
     `gen_random_uuid()` كـdefault، متضمّن من إصدار 13 من غير extension إضافي — راجع `docs/DEPLOYMENT.md`
     قسم 2). لو النسخة أقدم من 13، الخطوة الجاية (تطبيق الـschema) هترمي خطأ واضح.

---

## الخطوة 2 — تطبيق الـschema على قاعدة الـstaging

**قبل التنفيذ، تأكد إن الـconnection string اللي هتستخدمه فعلاً بتاع `satamoni-staging-db` مش أي قاعدة
تانية** (راجع اسم القاعدة في أول الـURL نفسه كتأكيد إضافي).

```bash
psql "<<External Database URL بتاع satamoni-staging-db>>" -f db/schema.sql
```

- المشروع **مفيهوش migration framework تراكمي** (موثّق في `docs/DEPLOYMENT.md` قسم 6) — `db/schema.sql`
  بيتطبّق **مرة واحدة بس على قاعدة فاضية جديدة**. تشغيله تاني على نفس القاعدة هيفشل على `CREATE TABLE`
  موجود بالفعل (متوقّع، مش مشكلة).
- بعد التطبيق، أول حساب أدمن:
  ```bash
  ADMIN_NAME=Admin ADMIN_EMAIL=staging-admin@satamoni.test ADMIN_PASSWORD=<<قيمة قوية عشوائية>> \
  DATABASE_URL="<<External Database URL>>" node db/seed-admin.js
  ```
  **إيميل/باسورد staging وهميين بالكامل — متستخدمش إيميل/باسورد حقيقي هنا.**

نتيجة الخطوة: `<<VERIFIED / فشل + تفاصيل الخطأ>>`

---

## الخطوة 3 — إنشاء Web Service على Render

1. لوحة تحكم Render → **New +** → **Web Service** → اربطه بريبو `andriasatamoni-del/satamoni-backend`
   على فرع `claude/restaurant-erp-system-jctgj5` (أو الفرع اللي هيتدمج فيه ده لاحقًا).
2. الاسم: `satamoni-staging`.
3. **Runtime**: Node.
4. **Build Command**: `npm install`
5. **Start Command**: `node server.js`
   (لاحظ: **متستخدمش** `node db/ensure-schema.js && node server.js` بتاع `render.yaml` القديم هنا —
   الـschema اتطبّق يدويًا في الخطوة 2 فوق، مش محتاجين ensure-schema يشتغل تلقائي كل deploy على staging).
6. **متغيرات البيئة** (Environment tab):

   | المتغير | القيمة |
   |---|---|
   | `DATABASE_URL` | `<<Internal Database URL بتاع satamoni-staging-db>>` (استخدم الـInternal مش الـExternal هنا — الخدمتين في نفس شبكة Render) |
   | `DB_SSL` | `true` |
   | `JWT_SECRET` | قيمة عشوائية طويلة جديدة (`openssl rand -hex 32` مثلاً) — **مختلفة تمامًا عن أي secret تطوير/اختبار** |
   | `NODE_ENV` | `production` (راجع القرار في أول الدليل) |
   | `CORS_ORIGINS` | `https://satamoni-staging.onrender.com` (نفس origin الخدمة نفسها، بما إن الفرونت إند بيتقدّم من نفس الـExpress server — `public/*.html` — عادةً مش لازم CORS_ORIGINS أصلاً لو كله من نفس origin؛ حدده فقط لو هتستخدم origin مختلف فعليًا) |
   | `LOGIN_MAX_ATTEMPTS` | القيمة الافتراضية كافية للاختبار (اتركه فاضي = افتراضي الكود) |
   | `LOGIN_LOCKOUT_MINUTES` | افتراضي |

   **ملحوظة**: Render بيوفّر `PORT` تلقائيًا كمتغير بيئة — **متضيفوش يدوي**، `server.js` أصلاً بيقرا
   `process.env.PORT || 4000` (`server.js:104`).

7. Deploy.
8. بعد ما الـdeploy يخلص، سجّل الـURL الفعلي: `https://<<اسم الخدمة الفعلي>>.onrender.com`

نتيجة الخطوة: `<<VERIFIED / فشل + رسالة الخطأ من الـlogs>>`

---

## الخطوة 4 — HTTPS + Health Check

```bash
curl -i https://<<staging-url>>/health
```

المتوقع: `200 {"status":"ok","db":"ok"}` عن طريق HTTPS مباشرة (Render بيوفّر TLS termination تلقائي —
مفيش إعداد إضافي مطلوب من جانبنا). لو `503`، المشكلة اتصال الـDB (راجع `DATABASE_URL`/`DB_SSL`) مش
الشبكة.

نتيجة: `<<الصق نتيجة الـcurl هنا>>`

---

## الخطوة 5 — بيانات staging تركيبية (Synthetic Data)

بعد التأكد من `/health` سليم، أنشئ عن طريق الواجهة (`https://<<staging-url>>/satamoni-admin.html`) أو
الـAPI مباشرة:

- فرعين على الأقل (Branch A / Branch B)
- مستخدمين: admin (موجود من seed-admin)، branch_manager، cashier، مستخدم مطبخ، accountant — لكل فرع
- قائمة أصناف بسيطة + وصفات (recipes) + مكونات (ingredients) + مخزون ابتدائي
- مورد واحد على الأقل + بيانات شراء تجريبية
- موظفين تجريبيين (2-3)

**كل البيانات دي وهمية بالكامل — ممنوع نسخ بيانات فرع حقيقي حتى لو "مجهولة الهوية" من غير موافقة صريحة
منفصلة.**

نتيجة: `<<تم / لأ + تفاصيل>>`

---

## الخطوة 6 — تشغيل سيناريوهات Phase 6.5 كاملة ضد الرابط السحابي

نفس الـ9 مسارات اللي اتعملت في `PHASE 6.5 — CONTROLLED PILOT VALIDATION REPORT.md` (Sales, Kitchen,
Void/Refund, Purchase, Production, Branch Transfer, Waste, Expense, Payroll) — بس دلوقتي ضد
`https://<<staging-url>>` الحقيقي بدل `http://127.0.0.1:4700` المحلي. لو عندك Postman/curl scripts
جاهزة من التحقق المحلي، غيّر الـbase URL بس وشغّلها.

لكل مسار سجّل: نجح / فشل + أي فرق سلوك ملحوظ عن البيئة المحلية (مثلاً زمن استجابة أبطأ بسبب cold start
على خطة مجانية — متوقّع، مش bug).

نتيجة: `<<جدول 9 مسارات: نجح/فشل لكل واحد>>`

---

## الخطوة 7 — الأمان (CORS / Rate Limiting / JWT)

**CORS**:
```bash
# origin مسموح (لو حددت CORS_ORIGINS) - لازم يعدي
curl -i -H "Origin: https://<<staging-url>>" https://<<staging-url>>/api/auth/login -X OPTIONS
# origin غير مسموح - لازم يترفض
curl -i -H "Origin: https://evil-example.com" https://<<staging-url>>/api/auth/login -X OPTIONS
```

**Rate limiting** (نفس منهجية Phase 6.5 — تشغيل فعلي مش قراءة كود بس):
```bash
for i in 1 2 3 4 5 6; do
  curl -s -o /dev/null -w "%{http_code}\n" -X POST https://<<staging-url>>/api/auth/login \
    -H "Content-Type: application/json" -d '{"email":"staging-admin@satamoni.test","password":"wrong"}'
done
```
المتوقع: بعد `LOGIN_MAX_ATTEMPTS` محاولة، `429`. سجّل العدد الفعلي والاستجابة.

**JWT lifecycle**: كرر بالظبط اختبارات Phase 6.5 (توكن منتهي، مستخدم متعطّل، تغيير دور، تغيير فرع) ضد
الرابط السحابي.

نتيجة: `<<تفاصيل كل فحص>>`

---

## الخطوة 8 — العزل بين الفروع (Branch Isolation) على السحابة

كرر بالظبط جدول اختبارات العزل من `PHASE 6.5` (مستخدم فرع A مايقدرش يشوف/يعدّل طلبات/مخزون/موظفين فرع
B، وأدمن يقدر يوصل للكل) — بس ضد الـAPI الحقيقي المنشور، مش localhost.

نتيجة: `<<جدول النتائج>>`

---

## الخطوة 9 — التزامن (Concurrency) على السحابة

لكل عملية من: void طلب، إصدار تحويل، استلام تحويل، بدء إنتاج، إكمال إنتاج، إلغاء إنتاج، تسوية مخزون،
ترحيل محاسبي — ابعت 3 طلبات متزامنة فعليًا (`curl ... & curl ... & curl ... & wait` أو سكريبت Node
بسيط بـ`Promise.all`) وتأكد إن الأثر التجاري/المخزوني/المحاسبي حصل **مرة واحدة بس**.

**الهدف من الخطوة دي تحديدًا**: التأكد إن النشر السحابي (شبكة أبطأ، احتمال multi-instance مستقبلي) مغيّرش
سلوك الـidempotency/locking اللي اتأكد منه محليًا.

نتيجة: `<<جدول: العملية / عدد الطلبات / الأثر الفعلي>>`

---

## الخطوة 10 — إعادة المحاولة الشبكية / Double-Submit

ابعت طلب مالي/مخزوني بـ`idempotencyKey`، قاطع/أخّر الرد، أعد إرسال **نفس** الطلب بنفس المفتاح، تأكد
مفيش أثر مزدوج (نفس فحص Phase 6.5 بالظبط، بس عن طريق شبكة حقيقية بدل loopback).

نتيجة: `<<VERIFIED / فشل>>`

---

## الخطوة 11 — الأداء (Performance Smoke Test)

قِس زمن استجابة (`curl -w "%{time_total}\n" -o /dev/null -s ...`) لـ: تسجيل الدخول، إنشاء طلب، عرض
طلبات، dashboard، استعلامات مخزون، تقارير مبيعات، تقارير محاسبية، توصيات الشراء.

**متوقّع طبيعي**: زمن أعلى من البيئة المحلية بسبب مسافة الشبكة + احتمال cold start (خطط Render
المجانية بتنام بعد فترة خمول وبتاخد ثواني تصحى) — ده مش عيب أداء، سجّله كملاحظة بيئة مش كـbug.

**ملحوظة صريحة (زي ما طلب Phase 7A)**: **متحاولش تحسّن الأداء دلوقتي** — الخطوة دي قياس وتوثيق بس.

نتيجة: `<<جدول: العملية / متوسط / أبطأ رد>>` — صنّفها VERIFIED لو اتقاست فعليًا، PARTIALLY VERIFIED لو
جزء بس اتقاس.

---

## الخطوة 12 — النسخ الاحتياطي والاسترجاع على السحابة

```bash
DATABASE_URL="<<External Database URL بتاع satamoni-staging-db>>" node db/backup.js
DATABASE_URL="<<External Database URL>>" node db/restore-drill.js
```

سجّل: نجح الاتصال؟ حجم/مدة الباك أب؟ الاسترجاع نجح؟ فحص `SUM(debit)=SUM(credit)` بعد الاسترجاع نجح؟

**لو مفيش جدولة فعلية (cron) متظبّطة للباك أب على Render نفسه**: علّم صراحة
`SCHEDULED BACKUPS: NOT VERIFIED` — الباك أب اليدوي الناجح مش بديل عن الجدولة التلقائية.

نتيجة: `<<تفاصيل كاملة>>`

---

## الخطوة 13 — تخزين النسخ الاحتياطية خارج القاعدة نفسها

النسخة الاحتياطية اللي `db/backup.js` بينتجها لازم تتخزن في مكان **مختلف** عن سيرفر القاعدة نفسه (مش
مفيد لو القاعدة نفسها اتعطبت والنسخة كانت جواها). خيارات (وثّق أنهي واحد فعلاً اتستخدم):
- تنزيل يدوي بعد كل باك أب لمكان تخزين منفصل (محلي/سحابي).
- Render Disk منفصل (لو الخطة بتدعمه) — **تأكد من توثيق Render الرسمي وقت التنفيذ، مش مفترض هنا**.
- تخزين سحابي خارجي (S3-compatible أو مشابه) — يحتاج إعداد إضافي مش موجود حاليًا في الكود.

**ملحوظة صراحة**: الكود الحالي (`db/backup.js`) بيكتب على الـfilesystem المحلي اللي بيشتغل عليه بس —
مفيش تكامل تخزين سحابي خارجي مبني حاليًا. لو الخطوة دي مش اتنفذت فعليًا، علّمها NOT VERIFIED صراحة.

نتيجة: `<<الاستراتيجية الفعلية المُستخدمة + حالتها>>`

---

## الخطوة 14 — اللوجات

راجع Render logs (لوحة التحكم → الخدمة → Logs) بعد تشغيل الخطوات فوق، وتأكد:
- ✅ موجود: startup، shutdown، أحداث الطلبات، `auth_failure`، `server_error`، `slow_request`.
- ❌ **غير موجود إطلاقًا**: باسوردات، PINs، JWT tokens كاملة، `DATABASE_URL`.

نتيجة: `<<VERIFIED / تفاصيل أي تسريب لو لوحظ>>`

---

## الخطوة 15 — الإيقاف الآمن (Graceful Shutdown) على Render

من لوحة تحكم Render، جرّب "Manual Deploy" أو إعادة تشغيل الخدمة (بيبعت SIGTERM للـprocess القديم قبل
ما يشغّل الجديد). راجع اللوجات وتأكد ظهور تسلسل `[shutdown]` بالظبط زي `server.js` (مُختبَر محليًا فعليًا
في Phase 6.5 — الهدف هنا بس تأكيد إن سلوك Render نفسه (SIGTERM فعليًا، مش SIGKILL مباشر) بيدّي مهلة كافية).

نتيجة: `<<VERIFIED / فشل>>`

---

## الخطوة 16 — الطباعة و KDS

**لا تبني أي حاجة هنا** — الاتنين مش موجودين في الكود (اتفحص صراحة، مفيش print agent ولا KDS منفصل).
الهدف بس تأكيد إن البنية السحابية (Render Web Service + Postgres) **مفيهاش أي عائق معماري** يمنع إضافتهم
لاحقًا (مثلاً: لو التصميم المستقبلي محتاج WebSocket لشاشة مطبخ حية، Render بيدعم WebSockets على
الـWeb Services العادية — تأكيد ده لازم من توثيق Render الرسمي وقت التصميم الفعلي، مش هنا).

نتيجة: `Printing: NOT IMPLEMENTED` / `KDS: NOT IMPLEMENTED` (ثابتة، زي ما هي).

---

## بعد التنفيذ

ابعتلي النتائج اللي جمعتها من الخطوات فوق (حتى لو جزئية أو فيها فشل) — هبني عليها
`PHASE 7A — CLOUD STAGING VALIDATION REPORT.md` بالتصنيف الصادق (VERIFIED/PARTIALLY VERIFIED/NOT
VERIFIED لكل بند بالظبط، مش تحويل "الكود موجود" لـ"VERIFIED").
