// صلاحيات دقيقة لكل دور - إضافة فوق نظام requireRole الحالي (auth.js)، مش بديل له.
// requireRole بيتحقق من اسم الدور بس؛ requirePermission بيتحقق من إجراء محدد، عشان نقدر نوسّع
// صلاحيات دور معيّن (زي محاسب يشوف طلبات الموافقة) من غير ما نلمس أي route قديم شغال بـ requireRole.
const ROLE_PERMISSIONS = {
  admin: ["*"],
  branch_manager: [
    // المرحلة 9A-2: orders.create/discount.request/void.request كانت موجودة في الكتالوج بس مش متحققة
    // فعليًا في أي راوت (requirePosAuthIfNeeded كان بيعتمد على requireRole بس) - يعني سحبها من مدير فرع
    // معيّن كان مالوش أي تأثير حقيقي. دلوقتي بقت متحققة فعليًا (راجع routes/orders.js)، فلازم تتضاف هنا
    // صراحة عشان السلوك الافتراضي (مدير الفرع أصلًا بيقدر يسجّل طلب/يطلب خصم/يطلب استرجاع لفرعه) يفضل
    // زي ما هو من غير تغيير - هو أصلًا معاه orders.cancel/discount.approve فمعندوش داعي يطلب موافقة حد
    // تاني على أي حاجة من دول، بس لازم يقدر يبدأها هو بنفسه الأول
    "orders.create", "orders.discount.request", "orders.void.request",
    "orders.discount.approve", "orders.void.approve", "orders.cancel",
    "inventory.view", "inventory.adjust", "inventory.count",
    "recipes.view", "recipes.create", "recipes.edit", "recipes.submit",
    "production.view", "production.create", "production.complete", "production.cancel",
    // MASTER MISSION - تخطيط تصنيع السنتر كيتشن: نفس مين بيقدر ينشئ أمر تصنيع فعليًا (production.create)
    // هو نفسه اللي منطقي يشوف/يستخدم شاشة التخطيط - مفيش صلاحية جديدة منفصلة عن production.* فعليًا،
    // بس بنسميها بوضوح هنا عشان تبان صراحة في التدقيق (Part 14) بدل ما تتخبى تحت اسم production.* عام
    "production_planning.view", "production_planning.create",
    "food_cost.view",
    "expenses.view", "purchases.view",
    // المرحلة 7K: مدير الفرع/المحاسب هما اللي بيراجعوا مصروفات/مشتريات الكاشير النقدية قبل ما تتحسب
    // رسميًا - "إصدار" (مراجعة) منفصل عن "تسجيل" (الكاشير) عمدًا، زي ما اتحدد صراحة
    "expenses.create", "expenses.review", "purchases.create", "purchases.review",
    // المرحلة 4A: مدير فرع/سنتر كيتشن يقدر ينشئ/يعدّل/يقدّم طلبات شراء وأوامر شراء لفرعه ويلغيها - بس
    // مش يعتمدها (purchasing.approve أدمن بس عمدًا، زي recipes.approve/production.approve بالظبط -
    // "الشخص اللي بينشئ PO ميقدرش يعتمدها لوحده من غير صلاحية منفصلة")
    "purchasing.view", "purchasing.create", "purchasing.edit", "purchasing.submit", "purchasing.cancel",
    "users.view",
    "approvals.create", "approvals.decide",
    "audit.view.branch",
    // المرحلة 4B: رؤية مالية تشغيلية لفرعه بس - مفيش تعديل على قيد مرحّل ولا قفل شهر خالص (زي ما اتحدد صراحة)
    "accounting.view",
    // المرحلة 8.42: مدير الفرع يشوف خزائن فرعه (خزينة رئيسية + دروج الكاشيرية) وكشف حركتها - مفيش
    // صلاحية تحويل (ده مالي بحت، محاسب/أدمن بس) ولا إدارة بنوك (banks.manage أدمن بس عمدًا)
    "treasuries.view",
    // المرحلة 7E: مدير الفرع بيقدر كمان يفتح/يقفل شيفت لنفسه (لو بيغطي الكاشير بنفسه في فروع صغيرة)،
    // وهو صاحب صلاحية مراجعة فروق الكاش (اعتماد/رفض) وقفل يوم الفرع - الاتنين دول مش متاحين للكاشير خالص
    "shifts.open_own", "shifts.view_own", "shifts.close_own",
    "shifts.view_branch", "shifts.review", "branch_day.view", "branch_day.close",
    // المرحلة 7F: مدير الفرع هو صاحب لوحة التوزيع (تعيين/إعادة تعيين سائق)، بيدير بيانات سائقي فرعه
    // (نفس نمط إدارة الموظفين HR في المرحلة 4D)، وهو صاحب صلاحية تسوية كاش السائقين ومراجعة فروقها
    "deliveries.view_branch", "deliveries.assign", "drivers.manage",
    "driver_settlements.create", "driver_settlements.review",
    // المرحلة 8.48: حضور وأجر السائقين بالساعة - نفس فلسفة driver_settlements.create (مدير الفرع أو
    // الكاشير أي منهم يقدر يسجّل دخول/خروج سائق فعليًا واقف قدامه)
    "driver_shifts.manage",
    // المرحلة 7G: مدير الفرع يشوف شاشة المطبخ (KDS) بتاعة فرعه ويقدر يقدّم حالة أي طلب فيها -
    // مش مقصور على الكاشير بس، لأن مدير الفرع كتير بيغطي المطبخ برضو في فروع صغيرة
    "kitchen.view", "kitchen.advance",
    // نظام الطباعة: مدير الفرع هو صاحب إدارة طابعات/محطات فرعه (نفس فلسفة إدارة السائقين drivers.manage
    // بالظبط - جهاز فعلي في فرعه هو). print_jobs.manage_queue خاص بالـAgent المحلي (بيسجّل دخول بحساب
    // مدير فرع حقيقي عادي، مفيش نوع حساب "خدمة" منفصل في النظام) - claim/printed/failed على طابور فرعه بس
    "printers.view", "printers.manage", "print_routing.view", "print_routing.manage",
    "print_jobs.view", "print_jobs.manage_queue", "print_jobs.trigger",
  ],
  accountant: [
    "inventory.view", "recipes.view",
    "production.view", "production_planning.view",
    "food_cost.view", "food_cost.export",
    "expenses.view", "purchases.view",
    // المرحلة 7K: نفس صلاحية مراجعة مصروفات/مشتريات الكاشير النقدية اللي عند مدير الفرع
    "expenses.create", "expenses.review", "purchases.create", "purchases.review",
    "purchasing.view", "purchasing.export",
    "approvals.create",
    "audit.view.branch",
    // المرحلة 4B: إنشاء/تعديل/اعتماد/ترحيل + تقارير - بدون عكس قيود (accounting.reverse) ولا قفل شهر
    // (accounting.close_period) - الاتنين دول أدمن بس عمدًا (زي ما اتحدد صراحة في المواصفات)
    "accounting.view", "accounting.create", "accounting.edit", "accounting.approve", "accounting.post", "accounting.export",
    // المرحلة 8.42: المحاسب هو اللي بيحوّل الفلوس بين الخزائن فعليًا (خزينة رئيسية -> بنك/مورد/مصروف) -
    // ده مالي بحت زي accounting.create بالظبط. رؤية بنوك بس، إدارتها (إنشاء بنك/حساب جديد) أدمن بس
    "treasuries.view", "treasuries.transfer", "banks.view",
    // المرحلة 7E: المحاسب بيراجع/يحقق في فروق الكاش عبر الفروع (رؤية + مراجعة)، بس مش هو اللي بيقفل
    // يوم الفرع فعليًا (ده قرار تشغيلي لمدير الفرع، مش مالي بحت)
    "shifts.view_branch", "shifts.review", "branch_day.view",
    // المرحلة 7F: نفس منطق مراجعة فروق الشيفت بالظبط - المحاسب يراجع فروق تسليم كاش السائقين، بس
    // مش هو اللي بيبدأ التسوية نفسها (ده قرار تشغيلي لمدير الفرع لحظة استلام الكاش فعليًا)
    "deliveries.view_branch", "driver_settlements.review",
    // رؤية بس لطابور الطباعة - نفس منطق shifts.view_branch (يراجع، مش هو اللي بيدير الطابعات فعليًا)
    "print_jobs.view",
  ],
  cashier: [
    "orders.create", "orders.discount.request", "orders.void.request",
    "approvals.create",
    // المرحلة 7E: الكاشير بيفتح/يشوف/يقفل شيفته هو بس - مفيش صلاحية يشوف شيفتات زمايله ولا يراجع فروق كاش
    "shifts.open_own", "shifts.view_own", "shifts.close_own",
    // المرحلة 7K: الكاشير يقدر يسجّل مصروف/مشترى نقدي لفرعه بس واليوم بس (مقفول من جوه الراوت نفسه،
    // مش بس بالصلاحية) - لكن معندوش صلاحية "الإصدار" (expenses.review/purchases.review) خالص، ده
    // للمدير/المحاسب بس عمدًا عشان يراجعوا قبل ما تتحسب رسميًا
    // المرحلة 8.14: edit_own_daily بتسمح للكاشير يعدّل بند/مبلغ مصروفه أو بنود فاتورة مشتراه هو بس -
    // بس لحد ما تتراجع (SUBMITTED/PENDING)، لأن بعد المراجعة الأرقام دخلت المحاسبة رسميًا وتعديلها
    // ساعتها بيحتاج مسار عكس قيود منفصل تمامًا (زي /:id/cancel)، مش تعديل مباشر
    "expenses.create_own_daily", "expenses.view_own_daily", "expenses.edit_own_daily",
    "purchases.create_own_daily", "purchases.view_own_daily", "purchases.edit_own_daily",
    // المرحلة 7G: الكاشير بيشوف شاشة المطبخ (KDS) بتاعة فرعه ويقدّم حالة الطلبات - هو أكتر حد
    // بيستخدمها فعليًا (واقف عند نقطة البيع/المطبخ في الفروع الصغيرة)
    "kitchen.view", "kitchen.advance",
    // الكاشير هو اللي بيضغط "اطبع الفاتورة" لطلب صالة بناءً على طلب الجرسون، أو يعيد طباعة إيصال -
    // مفيش صلاحية إدارة طابعات/توجيه خالص (ده مدير الفرع/الأدمن بس)
    "print_jobs.trigger",
    // المرحلة 8.46: تحصيل مجمّع من الطيار - الكاشير هو اللي فعليًا بياخد الكاش من السائق لحظة رجوعه
    // بأكتر من طلب، فمنطقي يقدر يبدأ التسوية بنفسه (نفس فلسفة expenses.create_own_daily: تسجيل فوري
    // من غير ما يستنى مدير الفرع) - بس معندوش driver_settlements.review خالص (مراجعة فرق التسليم لو
    // حصل تفضل قرار مدير الفرع/المحاسب بس، زي شيفت الكاش بالظبط). create مقفولة أصلًا على فرعه بس من
    // جوه الراوت نفسه (assertOwnBranch على فرع السائق)، مش محتاجة صلاحية "own_daily" منفصلة زي المصروفات
    // لأن مفيش هنا مفهوم "تعديل بعد التسجيل" أصلًا يحتاج تمييز
    "driver_settlements.create",
    // المرحلة 8.48: حضور وأجر السائقين بالساعة - الكاشير هو اللي فعليًا بيسجّل دخول/خروج السائق يدوي
    // وقت ما بيشوفه واقف قدامه، فمنطقي يبدأها بنفسه زي تحصيل الكاش بالظبط - مفيش صلاحية "مراجعة"
    // منفصلة هنا أصلًا (عكس driver_settlements) لأن المصروف الناتج بيعدّي على مراجعة expenses.review
    // العادية (مدير الفرع/المحاسب) قبل ما يترحّل محاسبيًا، مش محتاج مسار مراجعة إضافي مكرر
    "driver_shifts.manage",
    // المرحلة 8.49: "خروج مع الطيار" في شاشة الكاشير كان بيطلب اسم طيار حر بـprompt (مش مربوط بسجل سائق
    // حقيقي - الطلب مايظهرش في تحصيل الكاش/البونص/أجر الشيفت بتاعته أبدًا). الإصلاح استخدم نفس منطق
    // driver-engine الموجود فعلًا في callcenter.html/delivery.html (assign -> out-for-delivery)، لكن ده
    // كان هيفضل يفشل بـ403 لأن الكاشير معندوش deliveries.assign أصلًا - نفس فلسفة driver_settlements.create
    // بالظبط: الكاشير هو اللي فعليًا واقف قدام السائق وقت الخروج، فمنطقي يقدر يعيّنه ويسجّل خروجه/تسليمه بنفسه
    "deliveries.assign",
  ],
  callcenter: [
    "orders.create", "orders.discount.request", "orders.void.request",
    "approvals.create",
    // المرحلة 8.49: نفس السبب بالظبط بتاع الكاشير فوق - شاشة الكول سنتر هي مين بيستخدم زرار "خروج مع
    // الطيار" فعليًا يوميًا (مقفولة على دور callcenter/admin بس)، وكانت هتفشل بـ403 من غير الصلاحية دي
    "deliveries.assign",
  ],
  // المرحلة 7F: السائق أضيق دور في النظام عمدًا - طلباته المُسندة له بس (deliveries.view_own/update_own،
  // مقفولة كمان على مستوى الكود بمطابقة drivers.user_id مع req.user.id، مش الصلاحية دي بس)، وسجل
  // تسوياته الخاصة. مفيش أي وصول لمحاسبة/مخزون/رواتب/فروع تانية/عملاء خالص - غير اللي محتاجه بالظبط
  // عشان يوصّل الطلب (اسم/تليفون/عنوان العميل، ظاهرين أصلًا جوه تفاصيل الطلب المُسند له نفسه)
  driver: [
    "deliveries.view_own", "deliveries.update_own", "driver_settlements.view_own",
  ],
  // المرحلة 7T: نفس فلسفة driver بالظبط - أضيق دور، بياناته الخاصة بس (مقفولة كمان على مستوى الكود
  // بمطابقة employees.user_id مع req.user.id في routes/employee-self.js). مفيش أي وصول لبيانات موظفين
  // تانيين أو أي جزء تاني من النظام - قسائم راتبه وطلبات إجازته بس
  employee: [
    "payslips.view_own", "leave_requests.manage_own",
  ],
};

// المرحلة 8.58: كتالوج كل صلاحية موجودة في النظام (مجمّعة بالمجال + اسم عربي واضح) - عشان شاشة تعديل
// الموظف تقدر تعرضهم كلهم وتدّي/تشيل أي واحدة منهم لأي شخص بعينه، فوق دوره الأساسي. القائمة دي هي
// نفسها المصدر الوحيد للتحقق من صحة أي permission key بيتبعت من الفرونت إند (راجع routes/users.js) -
// لازم تتحدّث هنا أول ما تتضاف صلاحية جديدة لأي دور فوق، وإلا الشاشة مش هتعرضها ولا تقبلها
const PERMISSION_CATALOG = [
  { group: "orders", groupLabel: "الطلبات", permissions: [
    { key: "orders.create", label: "تسجيل طلب جديد" },
    { key: "orders.cancel", label: "إلغاء طلب" },
    { key: "orders.discount.request", label: "طلب خصم (يحتاج موافقة)" },
    { key: "orders.discount.approve", label: "الموافقة على خصم" },
    { key: "orders.void.request", label: "طلب استرجاع (Void) طلب" },
    { key: "orders.void.approve", label: "الموافقة على استرجاع طلب" },
  ] },
  { group: "inventory", groupLabel: "المخزون", permissions: [
    { key: "inventory.view", label: "رؤية أرصدة المخزون" },
    { key: "inventory.adjust", label: "تعديل/تسوية المخزون يدويًا" },
    { key: "inventory.count", label: "عمل جرد فعلي (Spot Check)" },
  ] },
  { group: "recipes", groupLabel: "الوصفات", permissions: [
    { key: "recipes.view", label: "رؤية الوصفات" },
    { key: "recipes.create", label: "إنشاء وصفة" },
    { key: "recipes.edit", label: "تعديل وصفة" },
    { key: "recipes.submit", label: "تقديم وصفة للاعتماد" },
    { key: "recipes.approve", label: "اعتماد وصفة" },
    { key: "recipes.activate", label: "تفعيل وصفة" },
    { key: "recipes.archive", label: "أرشفة وصفة" },
  ] },
  { group: "production", groupLabel: "التصنيع", permissions: [
    { key: "production.view", label: "رؤية أوامر التصنيع" },
    { key: "production.create", label: "إنشاء أمر تصنيع" },
    { key: "production.complete", label: "إكمال أمر تصنيع" },
    { key: "production.cancel", label: "إلغاء أمر تصنيع" },
    { key: "production.approve", label: "اعتماد أمر تصنيع" },
  ] },
  { group: "production_planning", groupLabel: "تخطيط التصنيع", permissions: [
    { key: "production_planning.view", label: "رؤية خطة التصنيع" },
    { key: "production_planning.create", label: "إنشاء خطة تصنيع" },
  ] },
  { group: "food_cost", groupLabel: "تكلفة الأصناف", permissions: [
    { key: "food_cost.view", label: "رؤية تقارير تكلفة الأصناف" },
    { key: "food_cost.export", label: "تصدير تقارير تكلفة الأصناف" },
  ] },
  { group: "expenses", groupLabel: "المصروفات", permissions: [
    { key: "expenses.view", label: "رؤية كل المصروفات" },
    { key: "expenses.create", label: "تسجيل مصروف" },
    { key: "expenses.review", label: "مراجعة/اعتماد مصروف الكاشير" },
    { key: "expenses.create_own_daily", label: "تسجيل مصروف كاشير (فرعه واليوم بس)" },
    { key: "expenses.view_own_daily", label: "رؤية مصروفات الكاشير الخاصة بيوم شغله" },
    { key: "expenses.edit_own_daily", label: "تعديل مصروف الكاشير قبل المراجعة" },
  ] },
  { group: "purchases", groupLabel: "المشتريات النقدية اليومية", permissions: [
    { key: "purchases.view", label: "رؤية كل المشتريات النقدية" },
    { key: "purchases.create", label: "تسجيل مشترى نقدي" },
    { key: "purchases.review", label: "مراجعة/اعتماد مشترى الكاشير" },
    { key: "purchases.create_own_daily", label: "تسجيل مشترى كاشير (فرعه واليوم بس)" },
    { key: "purchases.view_own_daily", label: "رؤية مشتريات الكاشير الخاصة بيوم شغله" },
    { key: "purchases.edit_own_daily", label: "تعديل مشترى الكاشير قبل المراجعة" },
  ] },
  { group: "purchasing", groupLabel: "أوامر الشراء الرسمية", permissions: [
    { key: "purchasing.view", label: "رؤية طلبات/أوامر الشراء" },
    { key: "purchasing.create", label: "إنشاء طلب/أمر شراء" },
    { key: "purchasing.edit", label: "تعديل طلب/أمر شراء" },
    { key: "purchasing.submit", label: "تقديم طلب/أمر شراء" },
    { key: "purchasing.cancel", label: "إلغاء طلب/أمر شراء" },
    { key: "purchasing.approve", label: "اعتماد طلب/أمر شراء" },
    { key: "purchasing.export", label: "تصدير تقارير المشتريات" },
  ] },
  { group: "users", groupLabel: "المستخدمين", permissions: [
    { key: "users.view", label: "رؤية قائمة المستخدمين" },
  ] },
  { group: "approvals", groupLabel: "طلبات الموافقة", permissions: [
    { key: "approvals.create", label: "تقديم طلب موافقة" },
    { key: "approvals.decide", label: "البت في طلب موافقة" },
  ] },
  { group: "audit", groupLabel: "سجل المراجعة", permissions: [
    { key: "audit.view.branch", label: "رؤية سجل مراجعة الفرع" },
  ] },
  { group: "accounting", groupLabel: "المحاسبة", permissions: [
    { key: "accounting.view", label: "رؤية الحسابات والقيود" },
    { key: "accounting.create", label: "إنشاء قيد محاسبي" },
    { key: "accounting.edit", label: "تعديل قيد محاسبي" },
    { key: "accounting.approve", label: "اعتماد قيد محاسبي" },
    { key: "accounting.post", label: "ترحيل قيد محاسبي" },
    { key: "accounting.export", label: "تصدير التقارير المالية" },
    { key: "accounting.reverse", label: "عكس قيد محاسبي مرحّل" },
    { key: "accounting.close_period", label: "قفل شهر محاسبي" },
    { key: "accounting.close_year", label: "قفل سنة مالية" },
  ] },
  { group: "treasuries", groupLabel: "الخزائن", permissions: [
    { key: "treasuries.view", label: "رؤية الخزائن ودروج الكاشير" },
    { key: "treasuries.transfer", label: "تحويل فلوس بين الخزائن" },
  ] },
  { group: "banks", groupLabel: "البنوك", permissions: [
    { key: "banks.view", label: "رؤية حسابات البنوك" },
    { key: "banks.manage", label: "إدارة/إنشاء حسابات بنوك" },
  ] },
  { group: "shifts", groupLabel: "شيفتات الكاشير", permissions: [
    { key: "shifts.open_own", label: "فتح شيفت لنفسه" },
    { key: "shifts.view_own", label: "رؤية شيفته الحالية" },
    { key: "shifts.close_own", label: "قفل شيفت لنفسه" },
    { key: "shifts.view_branch", label: "رؤية كل شيفتات الفرع" },
    { key: "shifts.review", label: "مراجعة فروق كاش الشيفت" },
  ] },
  { group: "branch_day", groupLabel: "إقفال يوم الفرع", permissions: [
    { key: "branch_day.view", label: "رؤية حالة إقفال اليوم" },
    { key: "branch_day.close", label: "قفل يوم الفرع" },
  ] },
  { group: "deliveries", groupLabel: "التوصيل", permissions: [
    { key: "deliveries.view_branch", label: "رؤية لوحة توزيع الفرع" },
    { key: "deliveries.assign", label: "تعيين سائق لطلب" },
    { key: "deliveries.view_own", label: "رؤية طلباته المُسندة (سائق)" },
    { key: "deliveries.update_own", label: "تحديث حالة طلباته (سائق)" },
  ] },
  { group: "drivers", groupLabel: "بيانات السائقين", permissions: [
    { key: "drivers.manage", label: "إدارة بيانات السائقين" },
  ] },
  { group: "driver_settlements", groupLabel: "تسوية كاش السائقين", permissions: [
    { key: "driver_settlements.create", label: "بدء تسوية كاش سائق" },
    { key: "driver_settlements.review", label: "مراجعة فرق تسليم سائق" },
    { key: "driver_settlements.view_own", label: "رؤية تسوياته الخاصة (سائق)" },
  ] },
  { group: "driver_shifts", groupLabel: "حضور السائقين", permissions: [
    { key: "driver_shifts.manage", label: "تسجيل حضور/انصراف سائق" },
  ] },
  { group: "kitchen", groupLabel: "شاشة المطبخ (KDS)", permissions: [
    { key: "kitchen.view", label: "رؤية شاشة المطبخ" },
    { key: "kitchen.advance", label: "تقديم حالة تحضير طلب" },
  ] },
  { group: "printers", groupLabel: "الطابعات", permissions: [
    { key: "printers.view", label: "رؤية الطابعات" },
    { key: "printers.manage", label: "إدارة الطابعات" },
  ] },
  { group: "print_routing", groupLabel: "توجيه الطباعة", permissions: [
    { key: "print_routing.view", label: "رؤية توجيه الأصناف للمحطات" },
    { key: "print_routing.manage", label: "إدارة توجيه الأصناف للمحطات" },
  ] },
  { group: "print_jobs", groupLabel: "طابور الطباعة", permissions: [
    { key: "print_jobs.view", label: "رؤية طابور الطباعة" },
    { key: "print_jobs.manage_queue", label: "إدارة طابور الطباعة (Print Agent)" },
    { key: "print_jobs.trigger", label: "طباعة/إعادة طباعة إيصال" },
  ] },
  { group: "payslips", groupLabel: "قسائم الرواتب", permissions: [
    { key: "payslips.view_own", label: "رؤية قسيمة راتبه (موظف)" },
  ] },
  { group: "leave_requests", groupLabel: "طلبات الإجازة", permissions: [
    { key: "leave_requests.manage_own", label: "تقديم/متابعة طلبات إجازته (موظف)" },
  ] },
];

const ALL_PERMISSIONS = PERMISSION_CATALOG.flatMap((g) => g.permissions.map((p) => p.key));

// المرحلة 8.58: تدعم استقبال role نصي زي الأول تمامًا (توافق رجعي كامل مع كل استدعاء موجود في الكود)،
// أو user object فيه {role, permissionGrants, permissionRevokes} - عشان نطبّق استثناءات فردية فوق
// صلاحيات الدور. الأولوية: revoke صريح بيغلب كل حاجة (حتى صلاحية admin الشاملة "*")، بعدها grant صريح،
// وأخيرًا صلاحيات الدور الافتراضية - نفس ترتيب "الاستثناء الأخص بيغلب القاعدة الأعم" المنطقي
function hasPermission(user, permission) {
  const isUserObject = user && typeof user === "object";
  const role = isUserObject ? user.role : user;
  const grants = isUserObject && Array.isArray(user.permissionGrants) ? user.permissionGrants : [];
  const revokes = isUserObject && Array.isArray(user.permissionRevokes) ? user.permissionRevokes : [];

  if (revokes.includes(permission)) return false;
  if (grants.includes(permission)) return true;

  const perms = ROLE_PERMISSIONS[role] || [];
  return perms.includes("*") || perms.includes(permission);
}

// المرحلة 8.58: شاشة تعديل الموظف بتبعت "الصلاحيات الفعلية المطلوبة" ككل (كل صلاحية اتعلّمت في
// الشاشة) مش grants/revokes منفصلين - الدالة دي بتقارنها بصلاحيات دوره الافتراضية وتستنتج الفرق:
// أي صلاحية اتعلّمت ومش من ضمن دوره الأساسي = grant، وأي صلاحية من دوره الأساسي ومش متعلّمة = revoke.
// الأدمن قاعدته "*" فعليًا كل الصلاحيات (ALL_PERMISSIONS) عشان المقارنة تشتغل صح حتى لو حد شال صلاحية
// محددة من أدمن معيّن بالغلط أو قصدًا
function computeEffectivePermissionOverrides(role, desiredPermissions) {
  const base = role === "admin" ? ALL_PERMISSIONS : (ROLE_PERMISSIONS[role] || []);
  if (desiredPermissions === undefined) return null; // مفيش تعديل على الصلاحيات خالص
  if (!Array.isArray(desiredPermissions)) {
    const err = new Error("صيغة الصلاحيات غير صحيحة");
    err.code = "INVALID_PERMISSIONS";
    throw err;
  }
  const invalid = desiredPermissions.filter((p) => !ALL_PERMISSIONS.includes(p));
  if (invalid.length > 0) {
    const err = new Error(`صلاحيات غير معروفة: ${invalid.join("، ")}`);
    err.code = "INVALID_PERMISSIONS";
    throw err;
  }
  const grants = desiredPermissions.filter((p) => !base.includes(p));
  const revokes = base.filter((p) => !desiredPermissions.includes(p));
  return { grants, revokes };
}

// يقبل أكتر من صلاحية - يكفي إن اليوزر يملك واحدة منهم (OR)
function requirePermission(...permissions) {
  return (req, res, next) => {
    if (!req.user || !permissions.some((p) => hasPermission(req.user, p))) {
      return res.status(403).json({ error: "معندكش صلاحية تعمل الإجراء ده" });
    }
    next();
  };
}

module.exports = {
  ROLE_PERMISSIONS, PERMISSION_CATALOG, ALL_PERMISSIONS,
  hasPermission, requirePermission, computeEffectivePermissionOverrides,
};
