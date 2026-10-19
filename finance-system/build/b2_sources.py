# -*- coding: utf-8 -*-
"""أوراق المستندات المصدرية: المبيعات، المنصات، الخزينة، المصروفات، الموردون، القيود اليدوية."""
import datetime as dt
from fs_common import *
import fs_data as D
from b1_masters import G, CAP_COA

d = dt.date

SCALE = 1.0


def cap(n):
    return max(10, int(n * SCALE))


# ------------------------------------------------------------------ helpers
def COAc(k):
    return REG["COA"].ws_col(k)


def VALID(a):
    return f'COUNTIFS({COAc("code")},{a},{COAc("valid")},1)=1'


def INVALID(a):
    return f'COUNTIFS({COAc("code")},{a},{COAc("valid")},1)<>1'


def cash_flag(a):
    return f'IFERROR(INDEX({COAc("cash")},MATCH({a},{COAc("code")},0)),0)'


def cf_of(a, default='"OPERATING"'):
    return f'IFERROR(IF(INDEX({COAc("cfclass")},MATCH({a},{COAc("code")},0))="",{default},INDEX({COAc("cfclass")},MATCH({a},{COAc("code")},0))),{default})'


def tre_gl(code):
    T = REG["Treasuries"]
    return f'IFERROR(INDEX({T.ws_col("gl")},MATCH({code},{T.ws_col("code")},0)),"؟")'


def tre_loc(code):
    T = REG["Treasuries"]
    return f'IFERROR(INDEX({T.ws_col("loc")},MATCH({code},{T.ws_col("code")},0)),"؟")'


def loc_exists(v):
    return f'COUNTIF({REG["Locations"].ws_col("code")},{v})>0'


def cc_exists(v):
    return f'COUNTIF({REG["Cost_Centers"].ws_col("code")},{v})>0'


def pm_attr(key, code, dflt='"؟"'):
    P = REG["Payment_Methods"]
    return f'IFERROR(INDEX({P.ws_col(key)},MATCH({code},{P.ws_col("code")},0)),{dflt})'


def settle_acct(mc, loc):
    """حساب تسوية وسيلة دفع: النقدي = خزينة الفرع الافتراضية، وغيره = حساب المستحقات في Payment_Methods"""
    L, T, P = REG["Locations"], REG["Treasuries"], REG["Payment_Methods"]
    cash_tre = f'INDEX({L.ws_col("cash_tre")},MATCH({loc},{L.ws_col("code")},0))'
    return (f'IFERROR(IF({pm_attr("type", mc, chr(34)+chr(34))}="نقدي",'
            f'INDEX({T.ws_col("gl")},MATCH({cash_tre},{T.ws_col("code")},0)),'
            f'INDEX({P.ws_col("gl")},MATCH({mc},{P.ws_col("code")},0))),"؟")')


def add_tail(sh):
    sh.add("status", "حالة المستند", w=11, dv=("list", "=LST_STATUS"), align="center")
    sh.add("prepared", "المُعِد / مقدم الطلب", w=22, dv=("list", "=LST_USER"))
    sh.add("approved", "المعتمد", w=22, dv=("list", "=LST_USER"))
    sh.add("poster", "المحاسب المرحِّل", w=22, dv=("list", "=LST_USER"))
    sh.add("ref", "مرفق / مرجع ورقي", w=16)
    sh.add("rev_ref", "مرجع التصحيح / الإلغاء", w=18)
    sh.add("notes", "ملاحظات", w=24)


def std_pairs(x, doc="doc", date="date", prefix='"?"'):
    dd, dtv, st = x(doc), x(date), x("status")
    return [
        (f'{dd}=""', "رقم المستند ناقص"),
        (f'COUNTIF({REG["Doc_Register"].ws_col("docno")},{dd})>1', "رقم مستند مكرر في السجل المركزي"),
        (f'LEFT({dd},LEN({prefix})+1)<>{prefix}&"-"', "بادئة الرقم لا تطابق نوع المستند"),
        (f'NOT(ISNUMBER({dtv}))', "التاريخ ناقص أو غير صحيح"),
        (f'{st}=""', "حالة المستند ناقصة"),
        (f'{x("prepared")}=""', "اسم المُعِد ناقص"),
        (f'AND(OR({st}=ST_APPR,{st}=ST_POST),{x("approved")}="")', "لا يوجد معتمد"),
        (f'AND({x("approved")}<>"",{x("approved")}={x("prepared")})', "المُعِد والمعتمد نفس الشخص (فصل المهام)"),
        (f'AND({st}=ST_POST,{x("poster")}="")', "اسم المحاسب المرحِّل ناقص"),
        (f'AND({st}=ST_POST,{x("poster")}<>"",OR({x("poster")}={x("prepared")},{x("poster")}={x("approved")}))', "المرحِّل يجب أن يختلف عن المُعِد والمعتمد"),
        (f'AND({st}=ST_REV,{x("rev_ref")}="")', "مرجع التصحيح/الإلغاء ناقص"),
        (f'AND(ISNUMBER({dtv}),OR({st}=ST_DRAFT,{st}=ST_APPR),COUNTIFS({REG["Period_Close"].ws_col("period")},YEAR({dtv})*100+MONTH({dtv}),{REG["Period_Close"].ws_col("status")},"مقفلة")>0)', "الفترة مقفلة: لا يسمح بمستند جديد"),
    ]


def finish(sh, extra_fn, prefix_fn, doc="doc", date="date"):
    sh.add("used", "مستخدم", "f", 7, f=lambda x: f'=IF(COUNTA(${sh.input_span()[0]}{x.r}:${sh.input_span()[1]}{x.r})>0,1,0)', hide=True)
    sh.add("chk", "فحص المستند (أول خطأ)", "f", 44,
           f=lambda x: f'=IF({x("used")}=0,"",' + chain(std_pairs(x, doc, date, prefix_fn(x)) + extra_fn(x)) + ')')
    sh.add("bad", "خطأ؟", "f", 6, f=lambda x: f'=IF({x("used")}=1,IF({x("chk")}<>"",1,0),0)', hide=True)
    sh.add("ok", "يُرحَّل؟", "f", 7, f=lambda x: f'=IF(AND({x("used")}=1,{x("bad")}=0,{x("status")}=ST_POST),1,0)', hide=True)


def lastrow_before(sh, key, x):
    L = sh.L(key)
    return f'${L}${sh.hdr}:${L}{x.r - 1}'


def define_sources(demo, with_br04, ov):
    S = {}
    # ====================================================== Sales_Daily
    sd = Sheet("Sales_Daily", "المبيعات اليومية (Daily Sales) - صف لكل فرع وكل يوم",
               "مصدر المستند: نموذج تقرير المبيعات اليومي (15). إجمالي المبيعات حسب الفئة، ثم الخصومات والمرتجعات، ثم توزيع صافي المبيعات حسب وسيلة الدفع. مجموع وسائل الدفع يجب أن يساوي صافي المبيعات.",
               cap=cap(280), tab="548235")
    sd.add("doc", "رقم تقرير المبيعات", w=17, en="SAL-BR01-0001")
    sd.add("date", "تاريخ البيع", w=12, fmt="yyyy-mm-dd", dv=("date",))
    sd.add("loc", "الفرع", w=9, dv=("list", "=LST_LOC"), align="center")
    sd.add("orders", "عدد الطلبات", w=9, dv=("int",))
    sd.add("g1", "إجمالي مبيعات الفطير", w=13, fmt="#,##0.00", dv=("dec",))
    sd.add("g2", "إجمالي مبيعات البيتزا", w=13, fmt="#,##0.00", dv=("dec",))
    sd.add("g3", "إجمالي مبيعات المكرونات", w=13, fmt="#,##0.00", dv=("dec",))
    sd.add("g4", "إجمالي مبيعات أخرى", w=13, fmt="#,##0.00", dv=("dec",))
    sd.add("disc", "الخصومات والعروض (-)", w=13, fmt="#,##0.00", dv=("dec",))
    sd.add("ret", "المرتجعات والإلغاء (-)", w=13, fmt="#,##0.00", dv=("dec",))
    sd.add("comp", "ضيافة/طلبات مجانية بسعر البيع (للعلم فقط - لا قيد)", w=16, fmt="#,##0.00", dv=("dec",))
    for i, (code, nm) in enumerate(zip(D.SALES_PM_CODES, ["نقدي", "بطاقات", "طلبات", "منصة توصيل أخرى", "تحويل إلكتروني"]), start=1):
        sd.add(f"m{i}", f"تحصيل {nm} ({code})", w=13, fmt="#,##0.00", dv=("dec",))
    sd.add("m6", "تحصيل وسيلة أخرى", w=13, fmt="#,##0.00", dv=("dec",))
    sd.add("m6c", "كود الوسيلة الأخرى", w=11, dv=("list", "=LST_PM"), align="center")
    add_tail(sd)
    # derived
    g = lambda x: f'{x("g1")}+{x("g2")}+{x("g3")}+{x("g4")}'
    sd.add("gross", "إجمالي المبيعات", "f", 13, fmt="#,##0.00", f=lambda x: f'=IF({x("used")}=1,{g(x)},"")')
    sd.add("net", "صافي المبيعات", "f", 13, fmt="#,##0.00", f=lambda x: f'=IF({x("used")}=1,{x("gross")}-{x("disc")}-{x("ret")},"")')
    sd.add("mtot", "مجموع وسائل الدفع", "f", 13, fmt="#,##0.00", f=lambda x: f'=IF({x("used")}=1,{x("m1")}+{x("m2")}+{x("m3")}+{x("m4")}+{x("m5")}+{x("m6")},"")')
    sd.add("mdiff", "فرق (صافي - وسائل الدفع)", "f", 12, fmt="#,##0.00;[Red]-#,##0.00", f=lambda x: f'=IF({x("used")}=1,ROUND({x("net")}-{x("mtot")},2),"")')
    for k in range(1, 5):
        sd.add(f"r{k}", f"إيراد فئة {k} (بدون ضريبة)", "f", 12, fmt="#,##0.00", hide=True, f=(lambda k: lambda x: f'=IF({x("used")}=1,ROUND({x(f"g{k}")}/S_VATF,2),"")')(k))
    sd.add("dex", "الخصم (بدون ضريبة)", "f", 12, fmt="#,##0.00", hide=True, f=lambda x: f'=IF({x("used")}=1,ROUND({x("disc")}/S_VATF,2),"")')
    sd.add("rex", "المرتجع (بدون ضريبة)", "f", 12, fmt="#,##0.00", hide=True, f=lambda x: f'=IF({x("used")}=1,ROUND({x("ret")}/S_VATF,2),"")')
    sd.add("vat", "ضريبة المخرجات", "f", 11, fmt="#,##0.00", f=lambda x: f'=IF({x("used")}=1,ROUND({x("net")}+{x("dex")}+{x("rex")}-{x("r1")}-{x("r2")}-{x("r3")}-{x("r4")},2),"")')
    for k, code in enumerate(D.SALES_PM_CODES, start=1):
        sd.add(f"a{k}", f"حساب تسوية {code}", "f", 9, hide=True, f=(lambda k, code: lambda x: f'=IF(AND({x("used")}=1,N({x(f"m{k}")})>0),{settle_acct(chr(34)+code+chr(34), x("loc"))},"")')(k, code))
    sd.add("a6", "حساب تسوية الوسيلة الأخرى", "f", 9, hide=True, f=lambda x: f'=IF(AND({x("used")}=1,N({x("m6")})>0),{settle_acct(x("m6c"), x("loc"))},"")')
    for k in range(1, 5):
        sd.add(f"ra{k}", f"حساب إيراد {k}", "f", 9, hide=True, f=(lambda k: lambda x: f'=INDEX(Lists!$U$5:$U$8,{k})')(k))
    sd.add("recon", "تمت المطابقة اليومية؟", "f", 11, align="center",
           f=lambda x: f'=IF({x("used")}=1,IF(COUNTIFS({x.ext("Daily_Recon","date")},{x("date")},{x.ext("Daily_Recon","loc")},{x("loc")})>0,"نعم","لا"),"")')

    def sd_extra(x):
        parts = []
        for k in range(1, 7):
            parts.append(f'AND(N({x(f"m{k}")})>0,{INVALID(x(f"a{k}"))})')
        for k in range(1, 5):
            parts.append(f'AND(N({x(f"g{k}")})>0,{INVALID(x(f"ra{k}"))})')
        prior = (f'COUNTIFS({lastrow_before(sd,"date",x)},{x("date")},{lastrow_before(sd,"loc",x)},{x("loc")},'
                 f'{lastrow_before(sd,"status",x)},"<>"&ST_REV,{lastrow_before(sd,"status",x)},"<>"&ST_CANC)>0')
        return [
            (f'NOT({loc_exists(x("loc"))})', "الفرع غير معرف"),
            (f'IFERROR(INDEX({REG["Locations"].ws_col("type")},MATCH({x("loc")},{REG["Locations"].ws_col("code")},0)),"")<>"فرع"', "الموقع المختار ليس فرع بيع"),
            (f'AND({x("status")}<>ST_REV,{x("status")}<>ST_CANC,{prior})', "تقرير مبيعات مكرر لنفس الفرع واليوم"),
            (f'MIN({x("g1")},{x("g2")},{x("g3")},{x("g4")},{x("disc")},{x("ret")},{x("m1")},{x("m2")},{x("m3")},{x("m4")},{x("m5")},{x("m6")})<0', "توجد مبالغ سالبة (استخدم مستند عكسي)"),
            (f'{x("gross")}<=0', "إجمالي المبيعات صفر"),
            (f'{x("net")}<0', "الخصومات والمرتجعات أكبر من المبيعات"),
            (f'AND(N({x("m6")})>0,{x("m6c")}="")', "كود وسيلة الدفع الأخرى ناقص"),
            (f'ABS({x("mdiff")})>S_Tol', "مجموع وسائل الدفع لا يساوي صافي المبيعات"),
            ("OR(" + ",".join(parts) + ")", "حساب تسوية أو إيراد غير صالح"),
            (f'{x("vat")}<-S_Tol', "الضريبة المحسوبة سالبة"),
        ]
    finish(sd, sd_extra, lambda x: '"SAL"')
    S["sd"] = sd

    # ====================================================== Platform_Settlements
    ps = Sheet("Platform_Settlements", "تسويات المنصات والبطاقات (Platform & Card Settlements)",
               "مصدر المستند: نموذج كشف تسوية منصة توصيل (16). سجّل (إجمالي المستحق المسدَّد) ثم العمولة والخصومات الأخرى ثم المبلغ الفعلي الذي دخل البنك. الفرق يذهب لحساب مراجعة 1309 وليس إلى مصروف.",
               cap=cap(80), tab="548235")
    ps.add("doc", "رقم كشف التسوية", w=17)
    ps.add("date", "تاريخ التسوية/الاستلام", w=12, fmt="yyyy-mm-dd", dv=("date",))
    ps.add("pm", "المنصة / الوسيلة", w=10, dv=("list", "=LST_PM"), align="center")
    ps.add("loc", "الفرع", w=9, dv=("list", "=LST_LOC"), align="center")
    ps.add("pfrom", "الفترة من", w=11, fmt="yyyy-mm-dd", dv=("date",))
    ps.add("pto", "الفترة إلى", w=11, fmt="yyyy-mm-dd", dv=("date",))
    ps.add("settled", "قيمة الطلبات المسدَّدة (إجمالي)", w=14, fmt="#,##0.00", dv=("dec",))
    ps.add("comm", "عمولة المنصة (-)", w=12, fmt="#,##0.00", dv=("dec",))
    ps.add("other", "خصومات/غرامات أخرى (-)", w=12, fmt="#,##0.00", dv=("dec",))
    ps.add("actual", "المبلغ المستلم فعليًا", w=14, fmt="#,##0.00", dv=("dec",))
    ps.add("tre", "حساب الاستلام (بنك/خزينة)", w=12, dv=("list", "=LST_TRE"), align="center")
    add_tail(ps)
    ps.add("expected", "الصافي المتوقع", "f", 13, fmt="#,##0.00", f=lambda x: f'=IF({x("used")}=1,{x("settled")}-{x("comm")}-{x("other")},"")')
    ps.add("diff", "الفرق (متوقع - فعلي)", "f", 12, fmt="#,##0.00;[Red]-#,##0.00", f=lambda x: f'=IF({x("used")}=1,ROUND({x("expected")}-{x("actual")},2),"")')
    ps.add("ra", "حساب المستحقات", "f", 9, hide=True, f=lambda x: f'=IF({x("used")}=1,{pm_attr("gl", x("pm"))},"")')
    ps.add("ca", "حساب العمولة", "f", 9, hide=True, f=lambda x: f'=IF({x("used")}=1,{pm_attr("comm_acct", x("pm"))},"")')
    ps.add("ba", "حساب الاستلام", "f", 9, hide=True, f=lambda x: f'=IF({x("used")}=1,{tre_gl(x("tre"))},"")')
    finish(ps, lambda x: [
        (f'{pm_attr("type", x("pm"), chr(34)+chr(34))}=""', "المنصة/الوسيلة غير معرفة"),
        (f'{pm_attr("type", x("pm"), chr(34)+chr(34))}="نقدي"', "الوسيلة نقدية: لا تحتاج كشف تسوية"),
        (f'NOT({loc_exists(x("loc"))})', "الفرع غير معرف"),
        (f'NOT(AND({x("settled")}>0,{x("actual")}>=0))', "قيمة الطلبات يجب أن تكون موجبة والمستلم غير سالب"),
        (f'OR({x("comm")}<0,{x("other")}<0)', "العمولة/الخصومات لا تكون سالبة"),
        (f'{x("expected")}<0', "العمولة والخصومات أكبر من قيمة الطلبات"),
        (f'AND(ISNUMBER({x("pfrom")}),ISNUMBER({x("pto")}),{x("pfrom")}>{x("pto")})', "بداية الفترة بعد نهايتها"),
        (f'OR(NOT(ISNUMBER({x("pfrom")})),NOT(ISNUMBER({x("pto")})))', "فترة الكشف ناقصة"),
        (f'{INVALID(x("ra"))}', "حساب المستحقات غير صالح"),
        (f'{INVALID(x("ba"))}', "حساب الاستلام غير صالح"),
        (f'AND({x("comm")}>0,{INVALID(x("ca"))})', "حساب العمولة غير صالح"),
    ], lambda x: '"PLT"')
    S["ps"] = ps

    # ====================================================== Daily_Recon
    dr = Sheet("Daily_Recon", "المطابقة اليومية للمبيعات (Daily Sales Reconciliation)",
               "صف لكل (يوم، فرع، وسيلة دفع): المتوقع من Sales_Daily، والفعلي من العدّ/كشف الجهاز/تقرير المنصة. أي فرق يلزمه سبب ومسؤول وحالة معالجة.",
               cap=cap(300), tab="548235")
    dr.add("date", "التاريخ", w=12, fmt="yyyy-mm-dd", dv=("date",))
    dr.add("loc", "الفرع", w=9, dv=("list", "=LST_LOC"), align="center")
    dr.add("pm", "وسيلة الدفع", w=10, dv=("list", "=LST_PM"), align="center")
    dr.add("actual", "المبلغ الفعلي (عدّ/كشف)", w=15, fmt="#,##0.00", dv=("dec",))
    dr.add("reason", "سبب الفرق", w=16, dv=("list", "=LST_RSN"))
    dr.add("resp", "المسؤول عن التسوية", w=22, dv=("list", "=LST_USER"))
    dr.add("res", "حالة المعالجة", w=18, dv=("list", "=LST_RES"))
    dr.add("adj", "مستند التسوية", w=16)
    dr.add("notes", "ملاحظات", w=24)
    codes = D.SALES_PM_CODES

    def exp_formula(x):
        S_ = REG["Sales_Daily"]
        base = lambda key: S_.ws_col(key)
        crit = f'{base("date")},{x("date")},{base("loc")},{x("loc")},{base("status")},"<>"&ST_DRAFT,{base("status")},"<>"&ST_CANC,{base("status")},"<>"&ST_REV'
        terms = [f'IF({x("pm")}="{c}",SUMIFS({base(f"m{i}")},{crit}),0)' for i, c in enumerate(codes, start=1)]
        terms.append(f'SUMIFS({base("m6")},{crit},{base("m6c")},{x("pm")})')
        return "+".join(terms)

    dr.add("expected", "المتوقع (من المبيعات)", "f", 15, fmt="#,##0.00", f=lambda x: f'=IF(COUNTA(${dr.input_span()[0]}{x.r}:${dr.input_span()[1]}{x.r})=0,"",{exp_formula(x)})')
    dr.add("diff", "الفرق (فعلي - متوقع)", "f", 13, fmt="#,##0.00;[Red]-#,##0.00", f=lambda x: f'=IF({x("expected")}="","",ROUND({x("actual")}-{x("expected")},2))')
    dr.add("flag", "فحص", "f", 44, f=lambda x: f'=IF({x("expected")}="","",' + chain([
        (f'NOT(ISNUMBER({x("date")}))', "التاريخ ناقص"),
        (f'NOT({loc_exists(x("loc"))})', "الفرع غير معرف"),
        (f'COUNTIF({REG["Payment_Methods"].ws_col("code")},{x("pm")})=0', "وسيلة الدفع غير معرفة"),
        (f'COUNTIFS({dr.ws_col("date")},{x("date")},{dr.ws_col("loc")},{x("loc")},{dr.ws_col("pm")},{x("pm")})>1', "صف مطابقة مكرر"),
        (f'NOT(ISNUMBER({x("actual")}))', "المبلغ الفعلي ناقص"),
        (f'AND(ABS({x("diff")})>S_Tol,{x("reason")}="")', "فرق بدون سبب"),
        (f'AND(ABS({x("diff")})>S_Tol,{x("resp")}="")', "فرق بدون مسؤول"),
        (f'AND(ABS({x("diff")})>S_Tol,{x("res")}="")', "فرق بدون حالة معالجة"),
        (f'AND({x("res")}="تمت التسوية",ABS({x("diff")})>S_Tol,{x("adj")}="")', "التسوية بدون رقم مستند"),
        (f'AND({x("adj")}<>"",COUNTIF({REG["Doc_Register"].ws_col("docno")},{x("adj")})=0)', "مستند التسوية غير موجود"),
    ]) + ')')
    dr.add("open", "فرق مفتوح؟", "f", 9, align="center", f=lambda x: f'=IF({x("expected")}="","",IF(AND(ABS({x("diff")})>S_Tol,{x("res")}<>"تمت التسوية",{x("res")}<>"مقبول بموافقة الإدارة"),1,0))')
    S["dr"] = dr

    # ====================================================== Cash_Vouchers
    cv = Sheet("Cash_Vouchers", "سندات الخزينة والبنوك (Cash Vouchers) - قبض / صرف / تحويل / إيداع / عجز وزيادة",
               "المصدر: نماذج 11 و12 و13 و30. الأنواع: قبض، صرف، تحويل بين خزائن، إيداع بنكي، سحب بنكي، عجز خزينة، زيادة خزينة. التحويلات الداخلية لا تؤثر على الإيرادات أو المصروفات.",
               cap=cap(400), tab="BF8F00")
    cv.add("doc", "رقم السند", w=17)
    cv.add("date", "التاريخ", w=12, fmt="yyyy-mm-dd", dv=("date",))
    cv.add("vtype", "نوع السند", w=16, dv=("list", "=LST_VTYPE"))
    cv.add("tre", "الخزينة/البنك (من / المتأثر)", w=14, dv=("list", "=LST_TRE"), align="center")
    cv.add("tre2", "إلى خزينة/بنك (للتحويل)", w=14, dv=("list", "=LST_TRE"), align="center")
    cv.add("cacct", "الحساب المقابل (للقبض/الصرف)", w=12, dv=("list", "=LST_ACCT"), align="center")
    cv.add("party", "كود الجهة (عميل/موظف)", w=11)
    cv.add("payee", "المستلم / الدافع", w=22)
    cv.add("amount", "المبلغ", w=13, fmt="#,##0.00", dv=("dec",))
    cv.add("method", "طريقة الدفع", w=14, dv=("list", "نقدًا,تحويل بنكي,شيك,محفظة إلكترونية,بطاقة"))
    cv.add("desc", "البيان", w=30)
    cv.add("cc", "مركز التكلفة", w=9, dv=("list", "=LST_CC"), align="center")
    cv.add("linked", "المستند المرتبط (مصروف/فاتورة)", w=17)
    add_tail(cv)
    def lcol_(k):
        m = dict(VT_AR="E", VT_CODE="F", VT_PFX="G")
        return f"Lists!${m[k]}:${m[k]}"

    cv.add("tc", "رمز النوع", "f", 7, hide=True, f=lambda x: f'=IF({x("used")}=1,IFERROR(INDEX({lcol_("VT_CODE")},MATCH({x("vtype")},{lcol_("VT_AR")},0)),"?"),"")')
    cv.add("pfx", "بادئة", "f", 6, hide=True, f=lambda x: f'=IF({x("used")}=1,IFERROR(INDEX({lcol_("VT_PFX")},MATCH({x("vtype")},{lcol_("VT_AR")},0)),"?"),"")')
    cv.add("tgl", "حساب الخزينة", "f", 9, hide=True, f=lambda x: f'=IF({x("used")}=1,{tre_gl(x("tre"))},"")')
    cv.add("tgl2", "حساب الخزينة الثانية", "f", 9, hide=True, f=lambda x: f'=IF(AND({x("used")}=1,{x("tre2")}<>""),{tre_gl(x("tre2"))},"")')
    cv.add("tloc", "موقع الخزينة", "f", 8, hide=True, f=lambda x: f'=IF({x("used")}=1,{tre_loc(x("tre"))},"")')
    cv.add("tloc2", "موقع الخزينة الثانية", "f", 8, hide=True, f=lambda x: f'=IF(AND({x("used")}=1,{x("tre2")}<>""),{tre_loc(x("tre2"))},"")')
    internal = lambda x: f'OR({x("tc")}="TRF",{x("tc")}="DEP",{x("tc")}="WDR")'
    cv.add("dracct", "حساب المدين", "f", 10, align="center", f=lambda x: (
        f'=IF({x("used")}=1,IF({x("tc")}="RCV",{x("tgl")},IF({x("tc")}="PAY",{x("cacct")},IF({internal(x)},{x("tgl2")},IF({x("tc")}="SHT",ACC_CASH_SHORT,IF({x("tc")}="OVR",{x("tgl")},"؟"))))),"")'))
    cv.add("cracct", "حساب الدائن", "f", 10, align="center", f=lambda x: (
        f'=IF({x("used")}=1,IF({x("tc")}="RCV",{x("cacct")},IF({x("tc")}="PAY",{x("tgl")},IF({internal(x)},{x("tgl")},IF({x("tc")}="SHT",{x("tgl")},IF({x("tc")}="OVR",ACC_CASH_OVER,"؟"))))),"")'))
    cv.add("drloc", "موقع المدين", "f", 8, hide=True, f=lambda x: f'=IF({x("used")}=1,IF({internal(x)},{x("tloc2")},{x("tloc")}),"")')
    cv.add("crloc", "موقع الدائن", "f", 8, hide=True, f=lambda x: f'=IF({x("used")}=1,{x("tloc")},"")')
    cv.add("drcc", "مركز تكلفة المدين", "f", 8, hide=True, f=lambda x: f'=IF({x("used")}=1,IF(OR({x("tc")}="PAY",{x("tc")}="SHT"),IF({x("cc")}="","CC00",{x("cc")}),"CC00"),"")')
    cv.add("crcc", "مركز تكلفة الدائن", "f", 8, hide=True, f=lambda x: f'=IF({x("used")}=1,IF(OR({x("tc")}="RCV",{x("tc")}="OVR"),IF({x("cc")}="","CC00",{x("cc")}),"CC00"),"")')
    cv.add("drparty", "جهة المدين", "f", 8, hide=True, f=lambda x: f'=IF({x("used")}=1,IF(AND({x("tc")}="PAY",{x("party")}<>""),{x("party")},"-"),"")')
    cv.add("crparty", "جهة الدائن", "f", 8, hide=True, f=lambda x: f'=IF({x("used")}=1,IF(AND({x("tc")}="RCV",{x("party")}<>""),{x("party")},"-"),"")')
    cv.add("cfc", "تصنيف التدفق", "f", 11, f=lambda x: f'=IF({x("used")}=1,IF({internal(x)},"INTERNAL",IF(OR({x("tc")}="RCV",{x("tc")}="PAY"),{cf_of(x("cacct"))},"OPERATING")),"")')
    ctl = lambda x: f'OR({x("cacct")}=ACC_CUSTOMERS,{x("cacct")}=1501,{x("cacct")}=1502)'
    finish(cv, lambda x: [
        (f'{x("tc")}="?"', "نوع السند غير معرف"),
        (f'{INVALID(x("tgl"))}', "الخزينة/البنك غير معرف أو غير صالح"),
        (f'NOT(N({x("amount")})>0)', "المبلغ يجب أن يكون أكبر من صفر"),
        (f'AND({internal(x)},{x("tre2")}="")', "الخزينة المستلمة ناقصة"),
        (f'AND({internal(x)},{x("tre2")}={x("tre")})', "التحويل إلى نفس الخزينة"),
        (f'AND({internal(x)},{INVALID(x("tgl2"))})', "الخزينة المستلمة غير صالحة"),
        (f'AND(OR({x("tc")}="RCV",{x("tc")}="PAY"),{x("cacct")}="")', "الحساب المقابل ناقص"),
        (f'AND(OR({x("tc")}="RCV",{x("tc")}="PAY"),{INVALID(x("cacct"))})', "الحساب المقابل غير صالح أو رئيسي"),
        (f'AND(OR({x("tc")}="RCV",{x("tc")}="PAY"),{cash_flag(x("cacct"))}=1)', "الحساب المقابل نقدي: استخدم تحويل بين الخزائن"),
        (f'AND(OR({x("tc")}="RCV",{x("tc")}="PAY"),{x("cacct")}=ACC_SUPPLIERS)', "سداد الموردين يتم من Supplier_Payments"),
        (f'AND(OR({x("tc")}="RCV",{x("tc")}="PAY"),{x("payee")}="")', "المستلم/الدافع ناقص"),
        (f'AND(OR({x("tc")}="RCV",{x("tc")}="PAY"),{x("method")}="")', "طريقة الدفع ناقصة"),
        (f'AND(OR({x("tc")}="RCV",{x("tc")}="PAY"),{ctl(x)},{x("party")}="")', "كود الجهة إلزامي لهذا الحساب"),
        (f'AND({x("cacct")}=ACC_CUSTOMERS,{x("party")}<>"",COUNTIF({REG["Customers"].ws_col("code")},{x("party")})=0)', "كود العميل غير معرف"),
        (f'AND(OR({x("cacct")}=1501,{x("cacct")}=1502),{x("party")}<>"",COUNTIF({REG["Employees"].ws_col("code")},{x("party")})=0)', "كود الموظف غير معرف"),
        (f'AND({x("linked")}<>"",COUNTIF({REG["Doc_Register"].ws_col("docno")},{x("linked")})=0)', "المستند المرتبط غير موجود"),
        (f'AND(OR({x("tc")}="PAY",{x("tc")}="SHT"),NOT({cc_exists(x("drcc"))}))', "مركز التكلفة غير معرف"),
    ], lambda x: f'{x("pfx")}')
    S["cv"] = cv

    # ====================================================== Cash_Close
    cl = Sheet("Cash_Close", "إقفال الخزينة اليومي وفروق الجرد (Daily Cash Close)",
               "المصدر: نموذج 14. أدخل المبلغ المعدود فعليًا في آخر اليوم. النظام يقارن الرصيد الدفتري قبل أي سند تسوية مع المعدود، ويطلب سند عجز/زيادة (نموذج 30) لتسوية الفرق.",
               cap=cap(200), tab="BF8F00")
    cl.add("date", "التاريخ", w=12, fmt="yyyy-mm-dd", dv=("date",))
    cl.add("tre", "الخزينة", w=14, dv=("list", "=LST_TRE"), align="center")
    cl.add("counted", "المبلغ المعدود فعليًا", w=15, fmt="#,##0.00", dv=("dec",))
    cl.add("reason", "سبب الفرق", w=16, dv=("list", "=LST_RSN"))
    cl.add("resp", "المسؤول", w=22, dv=("list", "=LST_USER"))
    cl.add("res", "حالة المعالجة", w=18, dv=("list", "=LST_RES"))
    cl.add("adj", "سند التسوية (عجز/زيادة)", w=17)
    cl.add("notes", "ملاحظات", w=24)
    Gc = lambda k: G(k)
    cl.add("gl", "حساب الخزينة", "f", 9, f=lambda x: f'=IF({x("tre")}="","",{tre_gl(x("tre"))})')
    cl.add("book", "الرصيد الدفتري حتى نهاية اليوم", "f", 15, fmt="#,##0.00",
           f=lambda x: f'=IF({x("gl")}="","",SUMIFS({Gc("effdr")},{Gc("acct")},{x("gl")},{Gc("date")},"<="&{x("date")})-SUMIFS({Gc("effcr")},{Gc("acct")},{x("gl")},{Gc("date")},"<="&{x("date")}))')
    cl.add("adjamt", "أثر سند التسوية", "f", 12, fmt="#,##0.00;[Red]-#,##0.00",
           f=lambda x: f'=IF({x("gl")}="","",IF({x("adj")}="",0,SUMIFS({Gc("effdr")},{Gc("doc")},{x("adj")},{Gc("acct")},{x("gl")})-SUMIFS({Gc("effcr")},{Gc("doc")},{x("adj")},{Gc("acct")},{x("gl")})))')
    cl.add("before", "الدفتري قبل التسوية", "f", 15, fmt="#,##0.00", f=lambda x: f'=IF({x("gl")}="","",{x("book")}-{x("adjamt")})')
    cl.add("diff", "فرق الجرد (معدود - دفتري)", "f", 14, fmt="#,##0.00;[Red]-#,##0.00", f=lambda x: f'=IF({x("gl")}="","",IF(ISNUMBER({x("counted")}),ROUND({x("counted")}-{x("before")},2),""))')
    cl.add("resid", "فرق متبقٍ بعد التسوية", "f", 14, fmt="#,##0.00;[Red]-#,##0.00", f=lambda x: f'=IF({x("gl")}="","",IF(ISNUMBER({x("counted")}),ROUND({x("counted")}-{x("book")},2),""))')
    cl.add("flag", "فحص", "f", 40, f=lambda x: f'=IF({x("gl")}="","",' + chain([
        (f'NOT(ISNUMBER({x("date")}))', "التاريخ ناقص"), (f'{INVALID(x("gl"))}', "الخزينة غير صالحة"),
        (f'NOT(ISNUMBER({x("counted")}))', "المبلغ المعدود ناقص"),
        (f'AND(ABS({x("diff")})>S_CashTol,{x("reason")}="")', "فرق بدون سبب"),
        (f'AND(ABS({x("diff")})>S_CashTol,{x("resp")}="")', "فرق بدون مسؤول"),
        (f'AND(ABS({x("diff")})>S_CashTol,{x("adj")}="",{x("res")}<>"مقبول بموافقة الإدارة")', "فرق بدون سند تسوية"),
        (f'AND({x("adj")}<>"",COUNTIF({REG["Doc_Register"].ws_col("docno")},{x("adj")})=0)', "سند التسوية غير موجود"),
        (f'AND({x("adj")}<>"",ABS({x("resid")})>S_CashTol)', "الفرق لم يُسوَّ بالكامل (سند التسوية لا يطابق الفرق)"),
    ]) + ')')
    cl.add("open", "فرق مفتوح؟", "f", 9, align="center", f=lambda x: f'=IF({x("gl")}="","",IF(AND(ISNUMBER({x("diff")}),ABS({x("resid")})>S_CashTol),1,0))')
    S["cl"] = cl

    # ====================================================== Expenses
    ex = Sheet("Expenses", "سجل المصروفات (Expenses Register)",
               "المصدر: نموذج المصروفات (17). المصروف يثبت بتاريخ الاستحقاق. فوري = يُدفع الآن من الخزينة/البنك؛ آجل = يُثبت التزام (مصروف مستحق) ويُسدد لاحقًا بسند صرف مرتبط برقم هذا المستند. الأصول الثابتة لا تُسجل هنا.",
               cap=cap(400), tab="C55A11")
    ex.add("doc", "رقم المصروف", w=17)
    ex.add("date", "تاريخ الإثبات (الاستحقاق)", w=13, fmt="yyyy-mm-dd", dv=("date",))
    ex.add("loc", "الفرع / الإدارة", w=9, dv=("list", "=LST_LOC"), align="center")
    ex.add("cc", "مركز التكلفة", w=9, dv=("list", "=LST_CC"), align="center")
    ex.add("acct", "حساب المصروف", w=10, dv=("list", "=LST_ACCT"), align="center")
    ex.add("amount", "المبلغ", w=12, fmt="#,##0.00", dv=("dec",))
    ex.add("vat", "ضريبة مدخلات (اختياري)", w=11, fmt="#,##0.00", dv=("dec",))
    ex.add("mode", "نمط السداد", w=9, dv=("list", "=LST_EMODE"), align="center")
    ex.add("tre", "الخزينة/البنك (للفوري)", w=13, dv=("list", "=LST_TRE"), align="center")
    ex.add("payee", "المستفيد", w=22)
    ex.add("method", "طريقة الدفع", w=14, dv=("list", "نقدًا,تحويل بنكي,شيك,محفظة إلكترونية,بطاقة"))
    ex.add("desc", "البيان", w=28)
    add_tail(ex)
    ex.add("mc", "رمز النمط", "f", 7, hide=True, f=lambda x: f'=IF({x("used")}=1,IFERROR(INDEX(Lists!$O$5:$O$6,MATCH({x("mode")},Lists!$N$5:$N$6,0)),"?"),"")')
    ex.add("tgl", "حساب الخزينة", "f", 9, hide=True, f=lambda x: f'=IF(AND({x("used")}=1,{x("tre")}<>""),{tre_gl(x("tre"))},"")')
    ex.add("cr", "حساب الدائن", "f", 10, align="center", f=lambda x: f'=IF({x("used")}=1,IF({x("mc")}="IMM",{x("tgl")},ACC_ACCRUED),"")')
    ex.add("total", "الإجمالي", "f", 12, fmt="#,##0.00", f=lambda x: f'=IF({x("used")}=1,{x("amount")}+{x("vat")},"")')
    CVk = lambda k: REG["Cash_Vouchers"].ws_col(k)
    ex.add("paid", "المسدَّد لاحقًا (سندات مرتبطة)", "f", 13, fmt="#,##0.00", f=lambda x: f'=IF({x("used")}=1,SUMIFS({CVk("amount")},{CVk("linked")},{x("doc")},{CVk("ok")},1,{CVk("tc")},"PAY"),"")')
    ex.add("remain", "المتبقي", "f", 12, fmt="#,##0.00", f=lambda x: f'=IF({x("used")}=1,IF({x("mc")}="CRD",{x("total")}-{x("paid")},0),"")')
    ex.add("paystat", "حالة السداد", "f", 14, align="center", f=lambda x: f'=IF({x("used")}=1,IF({x("mc")}="IMM","مدفوع فورًا",IF({x("status")}<>ST_POST,"غير مرحل",IF({x("remain")}<=S_Tol,"مدفوع بالكامل",IF({x("paid")}>0,"مدفوع جزئيًا","غير مدفوع")))),"")')
    ex.add("lastpay", "تاريخ آخر دفعة", "f", 12, fmt="yyyy-mm-dd", f=lambda x: f'=IF({x("used")}=1,IF({x("paid")}>0,_xlfn.MAXIFS({CVk("date")},{CVk("linked")},{x("doc")},{CVk("ok")},1),""),"")')
    finish(ex, lambda x: [
        (f'NOT({loc_exists(x("loc"))})', "الفرع/الإدارة غير معرف"),
        (f'NOT({cc_exists(x("cc"))})', "مركز التكلفة غير معرف أو ناقص"),
        (f'COUNTIFS({COAc("code")},{x("acct")},{COAc("ae")},"نعم",{COAc("valid")},1)<>1', "حساب غير مسموح للمصروفات (الأصول الثابتة والمخزون لهما مسارات خاصة)"),
        (f'NOT(N({x("amount")})>0)', "المبلغ يجب أن يكون أكبر من صفر"),
        (f'{x("mc")}="?"', "نمط السداد غير معرف"),
        (f'AND({x("mc")}="IMM",{x("tre")}="")', "الدفع الفوري يحتاج خزينة/بنك"),
        (f'AND({x("mc")}="IMM",{INVALID(x("tgl"))})', "الخزينة/البنك غير صالح"),
        (f'AND({x("mc")}="IMM",{x("method")}="")', "طريقة الدفع ناقصة"),
        (f'AND(N({x("vat")})>0,S_VATOn<>"نعم")', "ضريبة المدخلات غير مفعلة في Tax_Settings"),
        (f'{x("payee")}=""', "المستفيد ناقص"),
        (f'AND({x("mc")}="CRD",{x("paid")}>{x("total")}+S_Tol)', "المسدَّد أكبر من المستحق"),
    ], lambda x: '"EXP"')
    S["ex"] = ex

    # ====================================================== Supplier_Invoices
    si = Sheet("Supplier_Invoices", "فواتير الموردين (Supplier Invoices & Notes)",
               "تسجيل الفاتورة بعد الاستلام ومطابقة المستندات (طلب/أمر/استلام - المرحلة 2). يُمنع تسجيل نفس رقم الفاتورة لنفس المورد مرتين. مخزون = حساب مخزون (لا مصروف). شراء نقدي = اختر خزينة في (الدفع الفوري).",
               cap=cap(400), tab="7030A0")
    si.add("doc", "رقم التسجيل الداخلي", w=17)
    si.add("sinv", "رقم فاتورة المورد", w=14)
    si.add("sup", "المورد", w=10, dv=("list", "=LST_SUP"), align="center")
    si.add("inv_date", "تاريخ الفاتورة", w=12, fmt="yyyy-mm-dd", dv=("date",))
    si.add("date", "تاريخ الإثبات المحاسبي", w=12, fmt="yyyy-mm-dd", dv=("date",))
    si.add("itype", "النوع", w=16, dv=("list", "=LST_ITYPE"))
    si.add("dacct", "الحساب المدين (مخزون/أصل/مصروف)", w=13, dv=("list", "=LST_ACCT"), align="center")
    si.add("loc", "جهة الاستلام", w=9, dv=("list", "=LST_LOC"), align="center")
    si.add("cc", "مركز التكلفة", w=9, dv=("list", "=LST_CC"), align="center")
    si.add("net", "الصافي قبل الضريبة", w=13, fmt="#,##0.00", dv=("dec",))
    si.add("vat", "الضريبة", w=10, fmt="#,##0.00", dv=("dec",))
    si.add("paynow", "الدفع الفوري (خزينة/بنك)", w=13, dv=("list", "=LST_TRE"), align="center")
    si.add("po", "أمر الشراء", w=12)
    si.add("grn", "إذن الاستلام", w=12)
    add_tail(si)
    si.add("tc", "رمز النوع", "f", 7, hide=True, f=lambda x: f'=IF({x("used")}=1,IFERROR(INDEX(Lists!$K$5:$K$7,MATCH({x("itype")},Lists!$J$5:$J$7,0)),"?"),"")')
    si.add("total", "الإجمالي", "f", 12, fmt="#,##0.00", f=lambda x: f'=IF({x("used")}=1,{x("net")}+{x("vat")},"")')
    si.add("terms", "مدة السداد", "f", 8, hide=True, f=lambda x: f'=IF({x("used")}=1,IFERROR(INDEX({REG["Suppliers"].ws_col("terms")},MATCH({x("sup")},{REG["Suppliers"].ws_col("code")},0)),"؟"),"")')
    si.add("due", "تاريخ الاستحقاق", "f", 12, fmt="yyyy-mm-dd", f=lambda x: f'=IF({x("used")}=1,IF(AND(ISNUMBER({x("inv_date")}),ISNUMBER({x("terms")})),{x("inv_date")}+{x("terms")},""),"")')
    si.add("dupf", "فاتورة مكررة؟", "f", 9, align="center", hide=True, f=lambda x: (
        f'=IF({x("used")}=1,IF(AND({x("status")}<>ST_REV,{x("status")}<>ST_CANC,COUNTIFS({lastrow_before(si,"sup",x)},{x("sup")},{lastrow_before(si,"sinv",x)},{x("sinv")},{lastrow_before(si,"status",x)},"<>"&ST_REV,{lastrow_before(si,"status",x)},"<>"&ST_CANC)>0),1,0),"")'))
    si.add("tgl", "حساب الدفع الفوري", "f", 9, hide=True, f=lambda x: f'=IF(AND({x("used")}=1,{x("paynow")}<>""),{tre_gl(x("paynow"))},"")')
    si.add("cfp", "تصنيف التدفق", "f", 11, f=lambda x: f'=IF({x("used")}=1,{cf_of(x("dacct"))},"")')
    si.add("due_amt", "المستحق للسداد", "f", 12, fmt="#,##0.00", hide=True, f=lambda x: f'=IF({x("used")}=1,IF(AND({x("tc")}<>"CN",{x("paynow")}=""),{x("total")},0),"")')
    finish(si, lambda x: [
        (f'COUNTIF({REG["Suppliers"].ws_col("code")},{x("sup")})=0', "المورد غير معرف"),
        (f'{x("sinv")}=""', "رقم فاتورة المورد ناقص"),
        (f'{x("dupf")}=1', "فاتورة مكررة (نفس المورد ونفس الرقم)"),
        (f'NOT(ISNUMBER({x("inv_date")}))', "تاريخ الفاتورة ناقص"),
        (f'{x("tc")}="?"', "نوع المستند غير معرف"),
        (f'COUNTIFS({COAc("code")},{x("dacct")},{COAc("ap")},"نعم",{COAc("valid")},1)<>1', "حساب مدين غير مسموح في المشتريات"),
        (f'NOT({loc_exists(x("loc"))})', "جهة الاستلام غير معرفة"),
        (f'NOT({cc_exists(x("cc"))})', "مركز التكلفة غير معرف"),
        (f'NOT(N({x("net")})>0)', "الصافي يجب أن يكون أكبر من صفر"),
        (f'AND(N({x("vat")})>0,S_VATOn<>"نعم")', "الضريبة غير مفعلة في Tax_Settings"),
        (f'AND({x("paynow")}<>"",{INVALID(x("tgl"))})', "خزينة الدفع الفوري غير صالحة"),
        (f'AND({x("paynow")}<>"",{x("tc")}="CN")', "الإشعار الدائن لا يُسدَّد فوريًا"),
        (f'AND({x("tc")}="INV",{x("po")}="",{x("grn")}="",{x("ref")}="")', "فاتورة بدون مرجع (أمر شراء/استلام/مرفق)"),
    ], lambda x: '"SINV"', doc="doc", date="date")
    S["si"] = si

    # ====================================================== Supplier_Payments
    sp = Sheet("Supplier_Payments", "دفعات الموردين (Supplier Payments)",
               "المصدر: نموذج سند الصرف (12). كل دفعة تخصم من حساب المورد. اربطها برقم تسجيل الفاتورة إن أمكن.",
               cap=cap(300), tab="7030A0")
    sp.add("doc", "رقم الدفعة", w=17)
    sp.add("date", "تاريخ الدفع", w=12, fmt="yyyy-mm-dd", dv=("date",))
    sp.add("sup", "المورد", w=10, dv=("list", "=LST_SUP"), align="center")
    sp.add("tre", "الخزينة/البنك", w=14, dv=("list", "=LST_TRE"), align="center")
    sp.add("amount", "المبلغ", w=13, fmt="#,##0.00", dv=("dec",))
    sp.add("method", "طريقة الدفع", w=14, dv=("list", "نقدًا,تحويل بنكي,شيك,محفظة إلكترونية,بطاقة"))
    sp.add("inv_doc", "رقم تسجيل الفاتورة المسددة", w=17)
    sp.add("desc", "البيان", w=26)
    add_tail(sp)
    sp.add("tgl", "حساب الخزينة", "f", 9, hide=True, f=lambda x: f'=IF({x("used")}=1,{tre_gl(x("tre"))},"")')
    sp.add("tloc", "موقع الخزينة", "f", 8, hide=True, f=lambda x: f'=IF({x("used")}=1,{tre_loc(x("tre"))},"")')
    sp.add("cfp", "تصنيف التدفق", "f", 11, f=lambda x: f'=IF({x("used")}=1,IFERROR(INDEX({REG["Supplier_Invoices"].ws_col("cfp")},MATCH({x("inv_doc")},{REG["Supplier_Invoices"].ws_col("doc")},0)),"OPERATING"),"")')
    finish(sp, lambda x: [
        (f'COUNTIF({REG["Suppliers"].ws_col("code")},{x("sup")})=0', "المورد غير معرف"),
        (f'{INVALID(x("tgl"))}', "الخزينة/البنك غير صالح"),
        (f'NOT(N({x("amount")})>0)', "المبلغ يجب أن يكون أكبر من صفر"),
        (f'{x("method")}=""', "طريقة الدفع ناقصة"),
        (f'AND({x("inv_doc")}<>"",COUNTIF({REG["Supplier_Invoices"].ws_col("doc")},{x("inv_doc")})=0)', "الفاتورة المسددة غير موجودة"),
        (f'AND({x("inv_doc")}<>"",COUNTIF({REG["Supplier_Invoices"].ws_col("doc")},{x("inv_doc")})>0,IFERROR(INDEX({REG["Supplier_Invoices"].ws_col("sup")},MATCH({x("inv_doc")},{REG["Supplier_Invoices"].ws_col("doc")},0)),"")<>{x("sup")})', "الفاتورة تخص موردًا آخر"),
    ], lambda x: '"SPAY"')
    S["sp"] = sp

    # ====================================================== Manual_JE
    mj = Sheet("Manual_JE", "القيود اليدوية والتسويات (Manual Journal Entries)",
               "قيود الافتتاح والتسويات والإهلاك وتسوية تكلفة المبيعات والتصحيح والإقفال. كل القيد = أسطر بنفس رقم القيد، وإجمالي المدين يساوي الدائن. القيد غير المتوازن لا يُرحَّل ويظهر خطؤه في كل أسطره.",
               cap=cap(300), tab="C00000")
    mj.add("doc", "رقم القيد", w=17)
    mj.add("date", "تاريخ القيد", w=12, fmt="yyyy-mm-dd", dv=("date",))
    mj.add("src", "رقم المستند الأصلي", w=16)
    mj.add("jtype", "نوع القيد", w=18, dv=("list", "=LST_JETYPE"))
    mj.add("acct", "رقم الحساب", w=10, dv=("list", "=LST_ACCT"), align="center")
    mj.add("loc", "الفرع/الموقع", w=9, dv=("list", "=LST_LOC"), align="center")
    mj.add("cc", "مركز التكلفة", w=9, dv=("list", "=LST_CC"), align="center")
    mj.add("party", "كود الجهة (مورد/عميل/موظف)", w=12)
    mj.add("desc", "البيان", w=34)
    mj.add("debit", "مدين", w=13, fmt="#,##0.00", dv=("dec",))
    mj.add("credit", "دائن", w=13, fmt="#,##0.00", dv=("dec",))
    mj.add("cf", "تصنيف التدفق (للأسطر النقدية)", w=14, dv=("list", "=LST_CF"))
    add_tail(mj)
    mj.add("aname", "اسم الحساب", "f", 30, f=lambda x: f'=IF({x("acct")}="","",IFERROR(INDEX({COAc("ar")},MATCH({x("acct")},{COAc("code")},0)),"حساب غير موجود"))')
    mj.add("used", "مستخدم", "f", 6, hide=True, f=lambda x: f'=IF(COUNTA(${mj.input_span()[0]}{x.r}:${mj.input_span()[1]}{x.r})>0,1,0)')
    mj.add("first", "أول سطر؟", "f", 7, hide=True, f=lambda x: f'=IF({x("doc")}="",0,IF(COUNTIF(${mj.L("doc")}${mj.first}:${mj.L("doc")}{x.r},{x("doc")})=1,1,0))')
    mj.add("jedr", "إجمالي مدين القيد", "f", 13, fmt="#,##0.00", f=lambda x: f'=IF({x("doc")}="","",SUMIFS({x.col("debit")},{x.col("doc")},{x("doc")}))')
    mj.add("jecr", "إجمالي دائن القيد", "f", 13, fmt="#,##0.00", f=lambda x: f'=IF({x("doc")}="","",SUMIFS({x.col("credit")},{x.col("doc")},{x("doc")}))')
    mj.add("jediff", "فرق القيد", "f", 11, fmt="#,##0.00;[Red]-#,##0.00", f=lambda x: f'=IF({x("doc")}="","",ROUND({x("jedr")}-{x("jecr")},2))')
    mj.add("jebal", "قيد غير متوازن (أول سطر)", "f", 8, hide=True, f=lambda x: f'=IF(AND({x("first")}=1,ABS(N({x("jediff")}))>S_Tol),1,0)')
    ctlj = lambda x: f'OR({x("acct")}=ACC_SUPPLIERS,{x("acct")}=ACC_CUSTOMERS,{x("acct")}=1501,{x("acct")}=1502)'
    lpairs = lambda x: std_pairs(x, "doc", "date", '"MJE"') + [
        (f'{x("acct")}=""', "رقم الحساب ناقص"),
        (f'{INVALID(x("acct"))}', "حساب غير صالح أو رئيسي أو غير نشط"),
        (f'NOT({loc_exists(x("loc"))})', "الموقع غير معرف"),
        (f'NOT({cc_exists(x("cc"))})', "مركز التكلفة غير معرف أو ناقص"),
        (f'OR(N({x("debit")})<0,N({x("credit")})<0)', "مبلغ سالب"),
        (f'AND(N({x("debit")})>0,N({x("credit")})>0)', "السطر يحتوي مدين ودائن معًا"),
        (f'AND(N({x("debit")})=0,N({x("credit")})=0)', "السطر بدون مبلغ"),
        (f'AND({ctlj(x)},{x("party")}="")', "كود الجهة إلزامي لحسابات الموردين/العملاء/السلف/العهد"),
        (f'AND({x("acct")}=ACC_SUPPLIERS,{x("party")}<>"",COUNTIF({REG["Suppliers"].ws_col("code")},{x("party")})=0)', "كود المورد غير معرف"),
        (f'AND({x("acct")}=ACC_CUSTOMERS,{x("party")}<>"",COUNTIF({REG["Customers"].ws_col("code")},{x("party")})=0)', "كود العميل غير معرف"),
        (f'AND(OR({x("acct")}=1501,{x("acct")}=1502),{x("party")}<>"",COUNTIF({REG["Employees"].ws_col("code")},{x("party")})=0)', "كود الموظف غير معرف"),
        (f'AND({cash_flag(x("acct"))}=1,{x("cf")}="")', "تصنيف التدفق ناقص لسطر نقدي"),
        (f'{x("jtype")}=""', "نوع القيد ناقص"),
        (f'AND({x("jtype")}="عكس",{x("rev_ref")}="")', "قيد العكس يحتاج مرجع القيد المعكوس"),
    ]
    mj.add("lmsg", "فحص السطر", "f", 40, hide=True, f=lambda x: f'=IF({x("used")}=0,"",' + chain(lpairs(x)) + ')')
    mj.add("lbad", "خطأ بالسطر", "f", 6, hide=True, f=lambda x: f'=IF({x("used")}=1,IF({x("lmsg")}<>"",1,0),0)')
    mj.add("jbad", "أخطاء أسطر القيد", "f", 6, hide=True, f=lambda x: f'=IF({x("doc")}="",0,SUMIFS({x.col("lbad")},{x.col("doc")},{x("doc")}))')
    mj.add("mixed", "حالات متباينة", "f", 6, hide=True, f=lambda x: f'=IF({x("doc")}="",0,IF(COUNTIFS({x.col("doc")},{x("doc")},{x.col("status")},"<>"&{x("status")})>0,1,0))')
    mj.add("chk", "فحص القيد (أول خطأ)", "f", 44, f=lambda x: (
        f'=IF({x("used")}=0,"",IF({x("lmsg")}<>"",{x("lmsg")},IF(ABS(N({x("jediff")}))>S_Tol,"القيد غير متوازن (مدين ≠ دائن) - لن يُرحَّل",'
        f'IF({x("mixed")}=1,"حالات أسطر القيد غير متسقة",IF({x("jbad")}>0,"يوجد خطأ في سطر آخر من نفس القيد","")))))'))
    mj.add("bad", "خطأ؟", "f", 6, hide=True, f=lambda x: f'=IF({x("used")}=1,IF({x("chk")}<>"",1,0),0)')
    mj.add("ok", "يُرحَّل؟", "f", 7, hide=True, f=lambda x: f'=IF(AND({x("used")}=1,{x("bad")}=0,{x("status")}=ST_POST),1,0)')
    S["mj"] = mj
    S["_samples"] = None
    return S
