# الصيغ الفعلية للأمثلة الإلزامية

منقولة حرفيًا من الملف المسلَّم (أول صف بيانات). الصيغ بفواصل الإنجليزية (,) كما تُخزَّن في xlsx؛ في Google Sheets بإعدادات إقليمية تستخدم الفاصلة المنقوطة (;) تتحول آليًا عند الفتح. تحت كل صيغة جدول يفسّر حروف الأعمدة.

### 3) رصيد المخزون (المرحلة 2 — تصميم)

رصيد الصنف في الموقع = الرصيد الافتتاحي + الوارد + التحويلات الداخلة - المنصرف - التحويلات الخارجة ± التسويات، مأخوذًا من سجل الحركات فقط: `=SUMIFS(Inventory_Moves!الكمية,الصنف,A2,المخزن_المستلم,B2)-SUMIFS(Inventory_Moves!الكمية,الصنف,A2,المخزن_المصدر,B2)` (الحركات تتضمن الافتتاحي والتسويات بإشارتها). لا يُعدَّل الرصيد يدويًا. انظر `11_Phase2_Design_Notes.md`.


### 1) إجمالي القيد = مجموع تفاصيله (Manual_JE)

- **إجمالي المدين لكل قيد:**

```
=IF($A5="","",SUMIFS($J:$J,$A:$A,$A5))
```

  المراجع: `Manual_JE!A` = رقم القيد؛ `Manual_JE!J` = مدين

- **إجمالي الدائن لكل قيد:**

```
=IF($A5="","",SUMIFS($K:$K,$A:$A,$A5))
```

  المراجع: `Manual_JE!A` = رقم القيد؛ `Manual_JE!K` = دائن

- **فرق القيد (يمنع الترحيل إن ≠ 0):**

```
=IF($A5="","",ROUND($W5-$X5,2))
```

  المراجع: `Manual_JE!A` = رقم القيد؛ `Manual_JE!W` = إجمالي مدين القيد؛ `Manual_JE!X` = إجمالي دائن القيد


### 2) رصيد الخزينة = الافتتاحي + المقبوضات - المدفوعات (Treasury_Balances)

- **الافتتاحي:**

```
=IF($A9="","",(SUMIFS(GL_Journal!$S:$S,GL_Journal!$G:$G,$E9,GL_Journal!$D:$D,"<"&TR_From)-SUMIFS(GL_Journal!$T:$T,GL_Journal!$G:$G,$E9,GL_Journal!$D:$D,"<"&TR_From)))
```

  المراجع: `Treasury_Balances!A` = الخزينة/البنك؛ `GL_Journal!S` = مدين مرحّل؛ `GL_Journal!G` = رقم الحساب؛ `Treasury_Balances!E` = الحساب؛ `GL_Journal!D` = تاريخ القيد؛ `GL_Journal!T` = دائن مرحّل

- **المقبوضات:**

```
=IF($A9="","",SUMIFS(GL_Journal!$S:$S,GL_Journal!$G:$G,$E9,GL_Journal!$D:$D,">="&TR_From,GL_Journal!$D:$D,"<="&TR_To))
```

  المراجع: `Treasury_Balances!A` = الخزينة/البنك؛ `GL_Journal!S` = مدين مرحّل؛ `GL_Journal!G` = رقم الحساب؛ `Treasury_Balances!E` = الحساب؛ `GL_Journal!D` = تاريخ القيد

- **المدفوعات:**

```
=IF($A9="","",SUMIFS(GL_Journal!$T:$T,GL_Journal!$G:$G,$E9,GL_Journal!$D:$D,">="&TR_From,GL_Journal!$D:$D,"<="&TR_To))
```

  المراجع: `Treasury_Balances!A` = الخزينة/البنك؛ `GL_Journal!T` = دائن مرحّل؛ `GL_Journal!G` = رقم الحساب؛ `Treasury_Balances!E` = الحساب؛ `GL_Journal!D` = تاريخ القيد

- **الختامي:**

```
=IF($A9="","",$F9+$G9-$H9)
```

  المراجع: `Treasury_Balances!A` = الخزينة/البنك؛ `Treasury_Balances!F` = الرصيد الافتتاحي؛ `Treasury_Balances!G` = المقبوضات؛ `Treasury_Balances!H` = المدفوعات


### 4) رصيد المورد = الالتزامات المعتمدة - المرتجعات والتسويات والدفعات (Supplier_Balances)

- **رصيد أول الفترة:**

```
=IF($A11="","",SUMIFS(GL_Journal!$T:$T,GL_Journal!$G:$G,ACC_SUPPLIERS,GL_Journal!$K:$K,$A11,GL_Journal!$D:$D,"<"&SB_From)-SUMIFS(GL_Journal!$S:$S,GL_Journal!$G:$G,ACC_SUPPLIERS,GL_Journal!$K:$K,$A11,GL_Journal!$D:$D,"<"&SB_From))
```

  المراجع: `Supplier_Balances!A` = كود المورد؛ `GL_Journal!T` = دائن مرحّل؛ `GL_Journal!G` = رقم الحساب؛ `GL_Journal!K` = الجهة؛ `GL_Journal!D` = تاريخ القيد؛ `GL_Journal!S` = مدين مرحّل

- **الختامي:**

```
=IF($A11="","",$C11+$D11-$E11)
```

  المراجع: `Supplier_Balances!A` = كود المورد؛ `Supplier_Balances!C` = رصيد أول الفترة؛ `Supplier_Balances!D` = فواتير والتزامات (دائن)؛ `Supplier_Balances!E` = دفعات ومرتجعات وتسويات (مدين)

- **عمر الدين: المبلغ غير المستحق (FIFO):**

```
=IF($A11="","",MIN(MAX($F11,0),SUMIFS(Supplier_Invoices!$AC:$AC,Supplier_Invoices!$C:$C,$A11,Supplier_Invoices!$AG:$AG,1,Supplier_Invoices!$Y:$Y,">="&(SB_To-0),Supplier_Invoices!$E:$E,"<="&SB_To)))
```

  المراجع: `Supplier_Balances!A` = كود المورد؛ `Supplier_Balances!F` = رصيد المورد (دائن+)؛ `Supplier_Invoices!AC` = المستحق للسداد؛ `Supplier_Invoices!C` = المورد؛ `Supplier_Invoices!AG` = يُرحَّل؟؛ `Supplier_Invoices!Y` = تاريخ الاستحقاق؛ `Supplier_Invoices!E` = تاريخ الإثبات المحاسبي


### 5) صافي المبيعات = إجمالي المبيعات - الخصومات - المرتجعات (Sales_Daily)

- **إجمالي المبيعات:**

```
=IF($AV5=1,$E5+$F5+$G5+$H5,"")
```

  المراجع: `Sales_Daily!AV` = مستخدم؛ `Sales_Daily!E` = إجمالي مبيعات الفطير؛ `Sales_Daily!F` = إجمالي مبيعات البيتزا؛ `Sales_Daily!G` = إجمالي مبيعات المكرونات؛ `Sales_Daily!H` = إجمالي مبيعات أخرى

- **الصافي:**

```
=IF($AV5=1,$Z5-$I5-$J5,"")
```

  المراجع: `Sales_Daily!AV` = مستخدم؛ `Sales_Daily!Z` = إجمالي المبيعات؛ `Sales_Daily!I` = الخصومات والعروض (-)؛ `Sales_Daily!J` = المرتجعات والإلغاء (-)

- **مطابقة وسائل الدفع مع الصافي (يمنع الترحيل إن ≠ 0):**

```
=IF($AV5=1,ROUND($AA5-$AB5,2),"")
```

  المراجع: `Sales_Daily!AV` = مستخدم؛ `Sales_Daily!AA` = صافي المبيعات؛ `Sales_Daily!AB` = مجموع وسائل الدفع


### 6) صافي تكلفة المبيعات (Income_Statement - من الأستاذ)

- **إجمالي تكلفة المبيعات:**

```
=E22+E23+E24+E25
```


### 7) مجمل الربح = صافي المبيعات - تكلفة المبيعات

- **مجمل الربح:**

```
=E20-E26
```

- **صافي المبيعات:**

```
=E17+E18+E19
```


### 8) صافي الربح = الإيرادات - التكاليف والمصروفات

- **الربح التشغيلي:**

```
=E27-E38
```

- **صافي الربح:**

```
=E39+E40
```


### 9) ميزان المراجعة يعرض المدين والدائن والفرق (Trial_Balance)

- **الحركة المدينة لحساب:**

```
=IF($A15="","",SUMIFS(GL_Journal!$S:$S,GL_Journal!$G:$G,">="&$K15,GL_Journal!$G:$G,"<="&$L15,GL_Journal!$I:$I,TB_LOCC,GL_Journal!$J:$J,TB_CCC,GL_Journal!$D:$D,">="&TB_From,GL_Journal!$D:$D,"<="&TB_To))
```

  المراجع: `Trial_Balance!A` = كود؛ `GL_Journal!S` = مدين مرحّل؛ `GL_Journal!G` = رقم الحساب؛ `Trial_Balance!K` = من؛ `Trial_Balance!L` = إلى؛ `GL_Journal!I` = الفرع؛ `GL_Journal!J` = مركز التكلفة؛ `GL_Journal!D` = تاريخ القيد

- **الرصيد الختامي:**

```
=IF($A15="","",$C15+$D15-$E15)
```

  المراجع: `Trial_Balance!A` = كود؛ `Trial_Balance!C` = رصيد افتتاحي (مدين+/دائن-)؛ `Trial_Balance!D` = حركة مدين؛ `Trial_Balance!E` = حركة دائن

- **إجمالي المدين الختامي:**

```
=SUMIFS($F$15:$F$264,$J$15:$J$264,"نعم")
```

  المراجع: `Trial_Balance!F` = ختامي مدين؛ `Trial_Balance!J` = ترحيل

- **إجمالي الدائن الختامي:**

```
=SUMIFS($G$15:$G$264,$J$15:$J$264,"نعم")
```

  المراجع: `Trial_Balance!G` = ختامي دائن؛ `Trial_Balance!J` = ترحيل

- **الفرق:**

```
=ROUND(F10-G10,2)
```


### 10) قائمة الدخل والميزانية تسحبان من الأستاذ العام لا من خلايا إدخال

- **بند إيراد في قائمة الدخل (مبيعات الفطير):**

```
=SUMIFS(GL_Journal!$T:$T,GL_Journal!$G:$G,">=4101",GL_Journal!$G:$G,"<=4101",GL_Journal!$D:$D,">="&IS_From,GL_Journal!$D:$D,"<="&IS_To,GL_Journal!$I:$I,IS_LOCC,GL_Journal!$J:$J,IS_CCC,GL_Journal!$AE:$AE,0)-SUMIFS(GL_Journal!$S:$S,GL_Journal!$G:$G,">=4101",GL_Journal!$G:$G,"<=4101",GL_Journal!$D:$D,">="&IS_From,GL_Journal!$D:$D,"<="&IS_To,GL_Journal!$I:$I,IS_LOCC,GL_Journal!$J:$J,IS_CCC,GL_Journal!$AE:$AE,0)
```

  المراجع: `GL_Journal!T` = دائن مرحّل؛ `GL_Journal!G` = رقم الحساب؛ `GL_Journal!D` = تاريخ القيد؛ `GL_Journal!I` = الفرع؛ `GL_Journal!J` = مركز التكلفة؛ `GL_Journal!AE` = قيد إقفال؟؛ `GL_Journal!S` = مدين مرحّل

- **بند أصول في الميزانية (النقدية والخزائن):**

```
=SUMIFS(GL_Journal!$S:$S,GL_Journal!$G:$G,">=1100",GL_Journal!$G:$G,"<=1199",GL_Journal!$D:$D,"<="&BS_AsOf)-SUMIFS(GL_Journal!$T:$T,GL_Journal!$G:$G,">=1100",GL_Journal!$G:$G,"<=1199",GL_Journal!$D:$D,"<="&BS_AsOf)
```

  المراجع: `GL_Journal!S` = مدين مرحّل؛ `GL_Journal!G` = رقم الحساب؛ `GL_Journal!D` = تاريخ القيد؛ `GL_Journal!T` = دائن مرحّل


### توليد دفتر اليومية من المستندات (GL_Journal)

- **أثر فعلي (شرط الترحيل):**

```
=IF($A5=1,IF(AND($Q5=1,COUNTIFS(COA!$A:$A,$G5,COA!$R:$R,1)=1),1,0),"")
```

  المراجع: `GL_Journal!A` = سطر نشط؛ `GL_Journal!Q` = جاهز للترحيل؛ `COA!A` = كود الحساب؛ `GL_Journal!G` = رقم الحساب؛ `COA!R` = صالح للترحيل (1/0)

- **المدين المرحّل:**

```
=IF($A5=1,IF($R5=1,N($M5),0),"")
```

  المراجع: `GL_Journal!A` = سطر نشط؛ `GL_Journal!R` = أثر فعلي؛ `GL_Journal!M` = مدين
