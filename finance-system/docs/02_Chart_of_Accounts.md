# دليل الحسابات الموحد

ترقيم 4 خانات: الفئة (1 أصول، 2 التزامات، 3 ملكية، 4 إيرادات، 5 تكلفة مبيعات، 6 مصروفات) ← المجموعة (مضاعفات 100) ← الحساب. يمكن إضافة حسابات جديدة في أي نطاق (مثلًا 1108 خزينة فرع جديد) من ورقة COA فتظهر آليًا في ميزان المراجعة والتقارير.

نوع الحساب: A أصل، L التزام، E ملكية، R إيراد، C تكلفة مبيعات، X مصروف. الحسابات (الرئيسية) لا يُرحَّل عليها.

| الكود | اسم الحساب | English | النوع | ترحيل | الطبيعة | نقدي | ملاحظات |
|---|---|---|---|---|---|---|---|
| 1000 | الأصول | Assets | A | رئيسي | مدين |  |  |
| 1100 | &nbsp;&nbsp;&nbsp;النقدية والخزائن | Cash on Hand | A | رئيسي | مدين |  |  |
| 1101 | &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;خزينة الفرع BR01 | Cash - Branch BR01 | A | ترحيل | مدين | نقدي |  |
| 1102 | &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;خزينة الفرع BR02 | Cash - Branch BR02 | A | ترحيل | مدين | نقدي |  |
| 1103 | &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;خزينة الفرع BR03 | Cash - Branch BR03 | A | ترحيل | مدين | نقدي |  |
| 1104 | &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;خزينة الإدارة الرئيسية HQ01 | Cash - Head Office | A | ترحيل | مدين | نقدي |  |
| 1105 | &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;عهدة المصروفات النثرية | Petty Cash | A | ترحيل | مدين | نقدي |  |
| 1106 | &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;نقدية بالطريق (تحويلات قيد التسوية) | Cash in Transit | A | ترحيل | مدين | نقدي | يجب أن يكون رصيده صفرًا عند الإقفال |
| 1107 | &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;خزينة الفرع BR04 (تجريبي - اختبار إضافة فرع) | Cash - Branch BR04 (test) | A | ترحيل | مدين | نقدي | حساب تجريبي لاختبار إضافة فرع |
| 1200 | &nbsp;&nbsp;&nbsp;البنوك | Banks | A | رئيسي | مدين |  |  |
| 1201 | &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;البنك الأول - حساب جاري (تجريبي) | Bank 1 - Current | A | ترحيل | مدين | نقدي |  |
| 1202 | &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;البنك الثاني - حساب جاري (تجريبي) | Bank 2 - Current | A | ترحيل | مدين | نقدي |  |
| 1203 | &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;محافظ وتحويلات إلكترونية | E-wallets / Instant transfers | A | ترحيل | مدين | نقدي |  |
| 1300 | &nbsp;&nbsp;&nbsp;العملاء ومنصات التوصيل والبطاقات | Receivables & Platforms | A | رئيسي | مدين |  |  |
| 1301 | &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;عملاء (مدينون تجاريون) | Trade Receivables | A | ترحيل | مدين |  |  |
| 1302 | &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;مستحقات بطاقات الدفع (POS Clearing) | Card Settlements Receivable | A | ترحيل | مدين |  |  |
| 1303 | &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;مستحقات منصة طلبات | Receivable - Talabat | A | ترحيل | مدين |  |  |
| 1304 | &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;مستحقات منصة توصيل أخرى | Receivable - Other Delivery Platform | A | ترحيل | مدين |  |  |
| 1309 | &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;فروق تسوية المنصات تحت المراجعة | Platform Settlement Differences (pending) | A | ترحيل | مدين |  | حساب مراجعة؛ يُسوّى شهريًا |
| 1400 | &nbsp;&nbsp;&nbsp;المخزون | Inventory | A | رئيسي | مدين |  |  |
| 1401 | &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;مخزون المخزن الرئيسي - مواد خام | Inventory - Main Warehouse (raw) | A | ترحيل | مدين |  |  |
| 1402 | &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;مخزون السنتر كيتشن - مواد خام | Inventory - Central Kitchen (raw) | A | ترحيل | مدين |  |  |
| 1403 | &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;مخزون منتجات نصف مصنعة وتامة | Inventory - WIP/Finished Goods | A | ترحيل | مدين |  |  |
| 1404 | &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;مخزون الفروع | Inventory - Branches | A | ترحيل | مدين |  |  |
| 1405 | &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;مخزون عبوات وتغليف | Inventory - Packaging | A | ترحيل | مدين |  |  |
| 1406 | &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;إنتاج تحت التشغيل (WIP) | Work in Process | A | ترحيل | مدين |  | المرحلة 2 |
| 1407 | &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;بضاعة بالطريق (تحويلات مخزنية مفتوحة) | Goods in Transit | A | ترحيل | مدين |  | المرحلة 2 |
| 1500 | &nbsp;&nbsp;&nbsp;السلف والعهد | Advances & Custody | A | رئيسي | مدين |  |  |
| 1501 | &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;سلف الموظفين | Employee Advances | A | ترحيل | مدين |  |  |
| 1502 | &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;عهد الموظفين | Employee Custody | A | ترحيل | مدين |  |  |
| 1600 | &nbsp;&nbsp;&nbsp;المصروفات المقدمة والضرائب المدينة | Prepaids & Tax Receivable | A | رئيسي | مدين |  |  |
| 1601 | &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;إيجار مدفوع مقدمًا | Prepaid Rent | A | ترحيل | مدين |  |  |
| 1602 | &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;تأمينات وتراخيص مدفوعة مقدمًا | Prepaid Insurance & Licences | A | ترحيل | مدين |  |  |
| 1603 | &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;مصروفات مدفوعة مقدمًا أخرى | Other Prepaids | A | ترحيل | مدين |  |  |
| 1610 | &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;ضريبة قيمة مضافة - مدخلات | VAT Input | A | ترحيل | مدين |  | تُستخدم فقط عند تفعيل الضريبة |
| 1700 | &nbsp;&nbsp;&nbsp;الأصول الثابتة | Fixed Assets | A | رئيسي | مدين |  |  |
| 1701 | &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;معدات المطابخ والأفران | Kitchen Equipment & Ovens | A | ترحيل | مدين |  |  |
| 1702 | &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;أثاث وتجهيزات | Furniture & Fixtures | A | ترحيل | مدين |  |  |
| 1703 | &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;أجهزة وحاسبات ونظم نقاط البيع | IT & POS Equipment | A | ترحيل | مدين |  |  |
| 1704 | &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;ديكورات وتجهيزات الفروع | Leasehold Improvements | A | ترحيل | مدين |  |  |
| 1790 | &nbsp;&nbsp;&nbsp;مجمع الإهلاك | Accumulated Depreciation | A | رئيسي | دائن |  |  |
| 1791 | &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;مجمع إهلاك معدات المطابخ | Acc. Dep. - Kitchen Equipment | A | ترحيل | دائن |  |  |
| 1792 | &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;مجمع إهلاك الأثاث والتجهيزات | Acc. Dep. - Furniture | A | ترحيل | دائن |  |  |
| 1793 | &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;مجمع إهلاك الأجهزة والحاسبات | Acc. Dep. - IT | A | ترحيل | دائن |  |  |
| 1794 | &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;مجمع إهلاك الديكورات | Acc. Dep. - Leasehold | A | ترحيل | دائن |  |  |
| 2000 | الالتزامات | Liabilities | L | رئيسي | دائن |  |  |
| 2100 | &nbsp;&nbsp;&nbsp;الموردون | Suppliers | L | رئيسي | دائن |  |  |
| 2101 | &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;موردون (ذمم دائنة) | Trade Payables | L | ترحيل | دائن |  |  |
| 2110 | &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;بضاعة مستلمة غير مفوترة (GRNI) | Goods Received Not Invoiced | L | ترحيل | دائن |  | المرحلة 2 |
| 2200 | &nbsp;&nbsp;&nbsp;المصروفات والرواتب المستحقة | Accruals | L | رئيسي | دائن |  |  |
| 2201 | &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;مصروفات مستحقة | Accrued Expenses | L | ترحيل | دائن |  |  |
| 2202 | &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;رواتب وأجور مستحقة | Accrued Salaries | L | ترحيل | دائن |  |  |
| 2203 | &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;تأمينات اجتماعية مستحقة | Social Insurance Payable | L | ترحيل | دائن |  |  |
| 2300 | &nbsp;&nbsp;&nbsp;الضرائب المستحقة | Taxes Payable | L | رئيسي | دائن |  |  |
| 2301 | &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;ضريبة قيمة مضافة - مخرجات | VAT Output | L | ترحيل | دائن |  | تُستخدم فقط عند تفعيل الضريبة |
| 2302 | &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;ضرائب ورسوم أخرى مستحقة | Other Taxes Payable | L | ترحيل | دائن |  |  |
| 2400 | &nbsp;&nbsp;&nbsp;التزامات أخرى | Other Liabilities | L | رئيسي | دائن |  |  |
| 2401 | &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;أمانات وتأمينات من الغير | Deposits Held | L | ترحيل | دائن |  |  |
| 2402 | &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;قروض وتمويل | Loans | L | ترحيل | دائن |  |  |
| 2403 | &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;التزامات أخرى | Other Payables | L | ترحيل | دائن |  |  |
| 2900 | &nbsp;&nbsp;&nbsp;حسابات معلقة | Suspense | L | رئيسي | دائن |  |  |
| 2901 | &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;حساب معلق (يجب تصفيره قبل الإقفال) | Suspense Account | L | ترحيل | دائن |  |  |
| 3000 | حقوق الملكية | Equity | E | رئيسي | دائن |  |  |
| 3100 | &nbsp;&nbsp;&nbsp;رأس المال | Capital | E | رئيسي | دائن |  |  |
| 3101 | &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;رأس المال | Owner's Capital | E | ترحيل | دائن |  |  |
| 3200 | &nbsp;&nbsp;&nbsp;جاري المالك | Owner Current Account | E | رئيسي | دائن |  |  |
| 3201 | &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;جاري المالك | Owner Current Account | E | ترحيل | دائن |  |  |
| 3300 | &nbsp;&nbsp;&nbsp;الأرباح المحتجزة | Retained Earnings | E | رئيسي | دائن |  |  |
| 3301 | &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;أرباح محتجزة (مرحّلة) | Retained Earnings | E | ترحيل | دائن |  |  |
| 3400 | &nbsp;&nbsp;&nbsp;المسحوبات والتوزيعات | Drawings & Distributions | E | رئيسي | مدين |  |  |
| 3401 | &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;مسحوبات المالك | Owner Drawings | E | ترحيل | مدين |  |  |
| 3402 | &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;توزيعات أرباح | Dividends | E | ترحيل | مدين |  |  |
| 3500 | &nbsp;&nbsp;&nbsp;ملخص الدخل (حساب الإقفال) | Income Summary | E | رئيسي | دائن |  |  |
| 3501 | &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;ملخص الدخل | Income Summary | E | ترحيل | دائن |  | يُستخدم فقط في قيد إقفال نهاية السنة |
| 4000 | الإيرادات | Revenue | R | رئيسي | دائن |  |  |
| 4100 | &nbsp;&nbsp;&nbsp;المبيعات | Sales | R | رئيسي | دائن |  |  |
| 4101 | &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;مبيعات الفطير | Sales - Fateer | R | ترحيل | دائن |  |  |
| 4102 | &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;مبيعات البيتزا | Sales - Pizza | R | ترحيل | دائن |  |  |
| 4103 | &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;مبيعات المكرونات | Sales - Pasta | R | ترحيل | دائن |  |  |
| 4104 | &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;مبيعات أخرى (مشروبات وإضافات) | Sales - Other | R | ترحيل | دائن |  |  |
| 4200 | &nbsp;&nbsp;&nbsp;إيرادات أخرى | Other Income | R | رئيسي | دائن |  |  |
| 4201 | &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;إيرادات متنوعة | Miscellaneous Income | R | ترحيل | دائن |  |  |
| 4210 | &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;زيادة خزينة | Cash Overage | R | ترحيل | دائن |  |  |
| 4900 | &nbsp;&nbsp;&nbsp;خصومات ومرتجعات المبيعات (حسابات مقابلة) | Sales Contra Accounts | R | رئيسي | مدين |  |  |
| 4901 | &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;خصومات المبيعات والعروض | Sales Discounts | R | ترحيل | مدين |  |  |
| 4902 | &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;مرتجعات وإلغاءات المبيعات | Sales Returns & Cancellations | R | ترحيل | مدين |  |  |
| 5000 | تكلفة المبيعات | Cost of Sales | C | رئيسي | مدين |  |  |
| 5100 | &nbsp;&nbsp;&nbsp;تكلفة المواد | Material Cost | C | رئيسي | مدين |  |  |
| 5101 | &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;تكلفة المواد المباشرة المستهلكة | Direct Materials Consumed | C | ترحيل | مدين |  |  |
| 5102 | &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;تكلفة المنتجات المحولة والمباعة | Transferred Products Sold | C | ترحيل | مدين |  |  |
| 5103 | &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;تكلفة العبوات والتغليف | Packaging Cost | C | ترحيل | مدين |  |  |
| 5200 | &nbsp;&nbsp;&nbsp;الهالك | Waste | C | رئيسي | مدين |  |  |
| 5201 | &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;هالك طبيعي معتمد | Normal Waste (approved) | C | ترحيل | مدين |  |  |
| 5202 | &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;هالك غير طبيعي | Abnormal Waste | C | ترحيل | مدين |  |  |
| 5300 | &nbsp;&nbsp;&nbsp;الضيافة والمجانيات | Complimentary | C | رئيسي | مدين |  |  |
| 5301 | &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;تكلفة الضيافة والطلبات المجانية | Complimentary Cost | C | ترحيل | مدين |  |  |
| 5400 | &nbsp;&nbsp;&nbsp;فروق المخزون والتكلفة | Inventory & Cost Variances | C | رئيسي | مدين |  |  |
| 5401 | &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;فروق جرد المخزون (عجز/زيادة) | Inventory Count Variance | C | ترحيل | مدين |  |  |
| 5402 | &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;فروق التكلفة والأسعار | Cost / Price Variance | C | ترحيل | مدين |  |  |
| 6000 | المصروفات التشغيلية والإدارية | Operating & Admin Expenses | X | رئيسي | مدين |  |  |
| 6100 | &nbsp;&nbsp;&nbsp;الرواتب والأجور | Payroll | X | رئيسي | مدين |  |  |
| 6101 | &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;رواتب وأجور | Salaries & Wages | X | ترحيل | مدين |  |  |
| 6102 | &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;تأمينات اجتماعية (حصة صاحب العمل) | Employer Social Insurance | X | ترحيل | مدين |  |  |
| 6103 | &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;حوافز ومكافآت | Bonuses | X | ترحيل | مدين |  |  |
| 6104 | &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;أجر إضافي | Overtime | X | ترحيل | مدين |  |  |
| 6200 | &nbsp;&nbsp;&nbsp;الإيجارات | Rent | X | رئيسي | مدين |  |  |
| 6201 | &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;إيجار الفروع | Rent - Branches | X | ترحيل | مدين |  |  |
| 6202 | &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;إيجار المخزن والمطبخ المركزي | Rent - Warehouse & CK | X | ترحيل | مدين |  |  |
| 6203 | &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;إيجار الإدارة | Rent - Head Office | X | ترحيل | مدين |  |  |
| 6300 | &nbsp;&nbsp;&nbsp;المرافق والاتصالات | Utilities & Comms | X | رئيسي | مدين |  |  |
| 6301 | &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;كهرباء | Electricity | X | ترحيل | مدين |  |  |
| 6302 | &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;مياه | Water | X | ترحيل | مدين |  |  |
| 6303 | &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;غاز | Gas | X | ترحيل | مدين |  |  |
| 6304 | &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;إنترنت واتصالات | Internet & Telecom | X | ترحيل | مدين |  |  |
| 6400 | &nbsp;&nbsp;&nbsp;التسويق | Marketing | X | رئيسي | مدين |  |  |
| 6401 | &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;تسويق وإعلانات | Marketing & Ads | X | ترحيل | مدين |  |  |
| 6500 | &nbsp;&nbsp;&nbsp;الصيانة | Maintenance | X | رئيسي | مدين |  |  |
| 6501 | &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;صيانة وإصلاحات | Repairs & Maintenance | X | ترحيل | مدين |  |  |
| 6600 | &nbsp;&nbsp;&nbsp;مصروفات التشغيل | Operations | X | رئيسي | مدين |  |  |
| 6601 | &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;نقل وتوصيل | Transport & Delivery | X | ترحيل | مدين |  |  |
| 6602 | &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;نظافة | Cleaning | X | ترحيل | مدين |  |  |
| 6603 | &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;مستلزمات تشغيلية | Operating Supplies | X | ترحيل | مدين |  |  |
| 6700 | &nbsp;&nbsp;&nbsp;العمولات والرسوم | Commissions & Fees | X | رئيسي | مدين |  |  |
| 6701 | &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;عمولات منصات التوصيل | Delivery Platform Commission | X | ترحيل | مدين |  |  |
| 6702 | &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;رسوم بنكية وعمولات بطاقات | Bank & Card Fees | X | ترحيل | مدين |  |  |
| 6705 | &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;غرامات وخصومات المنصات الأخرى | Platform Penalties / Other Deductions | X | ترحيل | مدين |  |  |
| 6800 | &nbsp;&nbsp;&nbsp;الإهلاك | Depreciation | X | رئيسي | مدين |  |  |
| 6801 | &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;إهلاك الأصول الثابتة | Depreciation Expense | X | ترحيل | مدين |  |  |
| 6900 | &nbsp;&nbsp;&nbsp;مصروفات إدارية وأخرى | Admin & Other | X | رئيسي | مدين |  |  |
| 6901 | &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;مصروفات إدارية وعمومية | G&A | X | ترحيل | مدين |  |  |
| 6902 | &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;رسوم حكومية وتراخيص وتأمينات | Government Fees, Licences & Insurance | X | ترحيل | مدين |  |  |
| 6903 | &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;أتعاب مهنية | Professional Fees | X | ترحيل | مدين |  |  |
| 6910 | &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;عجز خزينة | Cash Shortage | X | ترحيل | مدين |  |  |
| 6990 | &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;مصروفات أخرى | Other Expenses | X | ترحيل | مدين |  |  |

## خريطة الحسابات الثابتة المستخدمة في المعادلات

| اسم الحساب في المعادلات | الرقم | الاستخدام |
|---|---|---|
| ACC_DISC | 4901 | خصومات المبيعات |
| ACC_RET | 4902 | مرتجعات وإلغاءات المبيعات |
| ACC_VAT_OUT | 2301 | ضريبة القيمة المضافة - مخرجات |
| ACC_VAT_IN | 1610 | ضريبة القيمة المضافة - مدخلات |
| ACC_SUPPLIERS | 2101 | حساب الموردين (حساب رقابة) |
| ACC_CUSTOMERS | 1301 | حساب العملاء (حساب رقابة) |
| ACC_ACCRUED | 2201 | المصروفات المستحقة |
| ACC_SUSPENSE | 2901 | الحساب المعلق |
| ACC_CASH_SHORT | 6910 | عجز الخزينة |
| ACC_CASH_OVER | 4210 | زيادة الخزينة |
| ACC_PLT_DIFF | 1309 | فروق تسوية المنصات تحت المراجعة |
| ACC_PLT_OTHER | 6705 | خصومات/غرامات المنصات الأخرى |
| ACC_ADVANCES | 1501 | سلف الموظفين |
| ACC_CAPITAL | 3101 | رأس المال |
| ACC_INCSUM | 3501 | ملخص الدخل |
| ACC_RE | 3301 | الأرباح المحتجزة |
| ACC_COGS | 5101 | تكلفة المواد المباشرة (تسوية التكلفة الدورية) |
| ACC_INV_MAIN | 1401 | مخزون المخزن الرئيسي |
