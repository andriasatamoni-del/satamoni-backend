# -*- coding: utf-8 -*-
"""بيانات تجريبية (واضحة التعليم) لاختبار النظام + حسابات مستقلة بـ Python للتحقق من نتائج المعادلات."""
import datetime as dt
import fs_data as D

d = dt.date
ACC = "المحاسب (تجريبي)"
ASSIST = "محاسب مساعد (تجريبي)"
FM = "المدير المالي (تجريبي)"
PURCH = "مشرف المشتريات (تجريبي)"
HQCASH = "أمين صندوق الإدارة (تجريبي)"
MGR = {"BR01": "مدير الفرع 1 (تجريبي)", "BR02": "مدير الفرع 2 (تجريبي)", "BR03": "مدير الفرع 3 (تجريبي)", "BR04": "مدير الفرع 4 (تجريبي)"}
CSH = {"BR01": "أمين صندوق فرع 1 (تجريبي)", "BR02": "أمين صندوق فرع 2 (تجريبي)", "BR03": "أمين صندوق فرع 3 (تجريبي)", "BR04": "أمين صندوق فرع 4 (تجريبي)"}
BF = {"BR01": 1.0, "BR02": 0.8, "BR03": 0.65, "BR04": 0.3}
BASE = (6000, 9000, 3500, 1500)


def r2(x):
    return float(f"{x:.2f}")


def sales_row(seq, date, loc, dayf, status="مرحل", comp=0):
    f = BF[loc] * dayf
    g = [int(round(b * f / 10.0)) * 10 for b in BASE]
    gross = sum(g)
    disc = int(round(gross * 0.04))
    ret = int(round(gross * 0.01))
    net = gross - disc - ret
    tlb, dlv2, card, insta = (int(round(net * p)) for p in (0.22, 0.05, 0.18, 0.05))
    cash = net - tlb - dlv2 - card - insta
    row = dict(doc=f"SAL-{loc}-{seq:04d}", date=date, loc=loc, orders=int(round(gross / 170.0)), g1=g[0], g2=g[1], g3=g[2], g4=g[3], disc=disc, ret=ret,
               m1=cash, m2=card, m3=tlb, m4=dlv2, m5=insta, status=status, prepared=CSH[loc], approved=MGR[loc], poster=ACC, ref=f"شريط كاشير {date:%d/%m}")
    if comp:
        row["comp"] = comp
    row["_net"] = net
    row["_gross"] = gross
    return row


def build(with_br04=True):
    S = {}
    E = {}   # توقعات مستقلة للتحقق
    # ---------------------------------------------------------------- المبيعات
    sales = []
    plan = [(1, d(2026, 9, 10), 1.0), (2, d(2026, 9, 20), 1.1), (3, d(2026, 9, 30), 0.9)]
    for loc in ("BR01", "BR02", "BR03"):
        for seq, dd, df in plan:
            sales.append(sales_row(seq, dd, loc, df, comp=(300 if (loc, seq) == ("BR01", 2) else 0)))
    sales.append(sales_row(4, d(2026, 10, 5), "BR01", 1.05))
    sales.append(sales_row(4, d(2026, 10, 12), "BR02", 1.0, comp=450))
    sales.append(sales_row(4, d(2026, 10, 12), "BR03", 1.0))
    if with_br04:
        sales.append(sales_row(1, d(2026, 10, 12), "BR04", 1.0))
    S["sd"] = [{k: v for k, v in r.items() if not k.startswith("_")} for r in sales]
    sep = [r for r in sales if r["date"].month == 9]
    octo = [r for r in sales if r["date"].month == 10]
    E["sales_sep_net"] = sum(r["_net"] for r in sep)
    E["sales_sep_gross"] = sum(r["_gross"] for r in sep)
    E["sales_oct_net"] = sum(r["_net"] for r in octo)
    E["sales_oct_gross"] = sum(r["_gross"] for r in octo)
    E["sales_rows"] = {r["doc"]: r for r in sales}
    E["tlb_sep"] = sum(r["m3"] for r in sep)

    # ---------------------------------------------------------------- مطابقة يومية
    recon = []
    for r in sales:
        for pm, key in (("CASH", "m1"), ("TLB", "m3")):
            actual = r[key]
            row = dict(date=r["date"], loc=r["loc"], pm=pm, actual=actual)
            if r["doc"] == "SAL-BR02-0002" and pm == "CASH":
                row.update(actual=actual - 150, reason="عجز نقدي", resp=CSH["BR02"], res="تمت التسوية", adj="ADJ-BR02-0001", notes="عجز عدّ نهاية اليوم - اختبار 16")
            if r["doc"] == "SAL-BR02-0004" and pm == "CASH":
                row.update(actual=actual - 150, reason="عجز نقدي", resp=CSH["BR02"], res="تمت التسوية", adj="ADJ-BR02-0002", notes="عجز عدّ نهاية اليوم - اختبار 16 (أكتوبر)")
            recon.append(row)
    S["dr"] = recon

    # ---------------------------------------------------------------- تسويات المنصات
    S["ps"] = [
        dict(doc="PLT-HQ01-0001", date=d(2026, 9, 25), pm="TLB", loc="HQ01", pfrom=d(2026, 9, 10), pto=d(2026, 9, 10), settled=9000, comm=1620, other=100, actual=7280, tre="BNK-01",
             status="مرحل", prepared=ASSIST, approved=FM, poster=ACC, ref="كشف طلبات 09/25"),
        dict(doc="PLT-HQ01-0002", date=d(2026, 9, 26), pm="CARD", loc="HQ01", pfrom=d(2026, 9, 10), pto=d(2026, 9, 10), settled=8000, comm=120, other=0, actual=7880, tre="BNK-01",
             status="مرحل", prepared=ASSIST, approved=FM, poster=ACC, ref="كشف البنك 09/26"),
        dict(doc="PLT-HQ01-0003", date=d(2026, 10, 8), pm="TLB", loc="HQ01", pfrom=d(2026, 9, 20), pto=d(2026, 9, 30), settled=15000, comm=2700, other=150, actual=11800, tre="BNK-01",
             status="مرحل", prepared=ASSIST, approved=FM, poster=ACC, ref="كشف طلبات 10/08", notes="فرق 350 غير مبرر - تحت المراجعة (1309) - اختبار 4"),
    ]

    # ---------------------------------------------------------------- سندات الخزينة
    def cv(doc, dt_, vt, tre, amt, status="مرحل", prep=HQCASH, appr=FM, **kw):
        r = dict(doc=doc, date=dt_, vtype=vt, tre=tre, amount=amt, status=status, prepared=prep, approved=appr, poster=ACC, ref=kw.pop("ref", "مرفق ورقي"))
        r.update(kw)
        return r
    S["cv"] = [
        cv("TRF-BR01-0001", d(2026, 9, 15), "إيداع بنكي", "CSH-BR01", 10000, tre2="BNK-01", desc="إيداع نقدية الفرع 1 بالبنك", prep=CSH["BR01"], appr=MGR["BR01"], method="نقدًا"),
        cv("TRF-HQ01-0002", d(2026, 9, 16), "تحويل بين خزائن", "CSH-HQ01", 5000, tre2="CSH-BR02", desc="فكة للفرع 2", method="نقدًا"),
        cv("RCV-HQ01-0003", d(2026, 9, 18), "قبض", "BNK-01", 20000, cacct=3201, payee="المالك", method="تحويل بنكي", desc="جاري المالك - تمويل مؤقت"),
        cv("ADJ-BR02-0001", d(2026, 9, 20), "عجز خزينة", "CSH-BR02", 150, cc="CC10", desc="عجز عدّ 20/9 الفرع 2", prep=CSH["BR02"], appr=MGR["BR02"], payee="أمين صندوق الفرع 2", method="نقدًا"),
        cv("PAY-HQ01-0004", d(2026, 10, 3), "صرف", "BNK-01", 60000, cacct=2202, payee="العاملون - رواتب سبتمبر", method="تحويل بنكي", cc="CC50", desc="سداد رواتب سبتمبر المستحقة"),
        cv("PAY-HQ01-0005", d(2026, 10, 10), "صرف", "BNK-01", 2400, cacct=2201, payee="شركة الكهرباء", method="تحويل بنكي", cc="CC10", linked="EXP-BR01-0003", desc="سداد كهرباء سبتمبر BR01"),
        cv("ADJ-BR02-0002", d(2026, 10, 12), "عجز خزينة", "CSH-BR02", 150, cc="CC10", desc="عجز عدّ 12/10 الفرع 2", prep=CSH["BR02"], appr=MGR["BR02"], payee="أمين صندوق الفرع 2", method="نقدًا"),
        cv("PAY-HQ01-0006", d(2026, 10, 15), "صرف", "CSH-HQ01", 2000, cacct=1501, party="EMP001", payee="موظف تجريبي 1", method="نقدًا", desc="سلفة موظف", cc="CC50"),
    ]

    # ---------------------------------------------------------------- مصروفات
    def ex(doc, dt_, loc, cc, acct, amt, mode, tre, payee, desc, status="مرحل", prep=None, **kw):
        r = dict(doc=doc, date=dt_, loc=loc, cc=cc, acct=acct, amount=amt, mode=mode, tre=tre, payee=payee, desc=desc, method="تحويل بنكي" if tre and tre.startswith("BNK") else "نقدًا",
                 status=status, prepared=prep or (MGR.get(loc) or HQCASH), approved=FM, poster=ACC, ref="فاتورة/عقد")
        r.update(kw)
        return r
    S["ex"] = [
        ex("EXP-BR01-0001", d(2026, 9, 1), "BR01", "CC10", 6201, 15000, "فوري", "BNK-01", "مالك عقار الفرع 1", "إيجار سبتمبر"),
        ex("EXP-BR02-0001", d(2026, 9, 1), "BR02", "CC10", 6201, 12000, "فوري", "BNK-01", "مالك عقار الفرع 2", "إيجار سبتمبر"),
        ex("EXP-BR03-0001", d(2026, 9, 1), "BR03", "CC10", 6201, 14000, "فوري", "BNK-01", "مالك عقار الفرع 3", "إيجار سبتمبر"),
        ex("EXP-HQ01-0001", d(2026, 9, 5), "HQ01", "CC40", 6401, 3000, "فوري", "CSH-HQ01", "وكالة إعلانات تجريبية", "حملة إعلانية"),
        ex("EXP-BR01-0002", d(2026, 9, 12), "BR01", "CC10", 6602, 600, "فوري", "CSH-BR01", "مورد نظافة", "مستلزمات نظافة", prep=CSH["BR01"]),
        ex("EXP-HQ01-0002", d(2026, 9, 1), "HQ01", "CC50", 1602, 12000, "فوري", "BNK-01", "شركة تأمين تجريبية", "تأمين سنوي مدفوع مقدمًا"),
        ex("EXP-BR01-0003", d(2026, 9, 28), "BR01", "CC10", 6301, 2400, "آجل", None, "شركة الكهرباء", "كهرباء سبتمبر (مستحقة)"),
        ex("EXP-HQ01-0003", d(2026, 9, 30), "HQ01", "CC50", 6304, 1500, "آجل", None, "مزود الإنترنت", "إنترنت سبتمبر (مستحقة)"),
        ex("EXP-BR01-0004", d(2026, 10, 1), "BR01", "CC10", 6201, 15000, "فوري", "BNK-01", "مالك عقار الفرع 1", "إيجار أكتوبر"),
        ex("EXP-BR02-0002", d(2026, 10, 1), "BR02", "CC10", 6201, 12000, "فوري", "BNK-01", "مالك عقار الفرع 2", "إيجار أكتوبر"),
        ex("EXP-BR03-0002", d(2026, 10, 1), "BR03", "CC10", 6201, 14000, "فوري", "BNK-01", "مالك عقار الفرع 3", "إيجار أكتوبر"),
        ex("EXP-HQ01-0004", d(2026, 10, 14), "HQ01", "CC60", 6501, 5000, "فوري", "CSH-HQ01", "فني صيانة تجريبي", "صيانة (خطأ: 5000 بدل 500)", status="معكوس", rev_ref="EXP-HQ01-0005"),
        ex("EXP-HQ01-0005", d(2026, 10, 14), "HQ01", "CC60", 6501, 500, "فوري", "CSH-HQ01", "فني صيانة تجريبي", "صيانة (تصحيح للمستند 0004)"),
    ]

    # ---------------------------------------------------------------- فواتير موردين
    def si(doc, sinv, sup, dt_, itype, dacct, loc, cc, net, status="مرحل", **kw):
        r = dict(doc=doc, sinv=sinv, sup=sup, inv_date=dt_, date=dt_, itype=itype, dacct=dacct, loc=loc, cc=cc, net=net, status=status,
                 prepared=PURCH, approved=FM, poster=ACC, ref=kw.pop("ref", "فاتورة + إذن استلام"))
        r.update(kw)
        return r
    S["si"] = [
        si("SINV-WH01-0001", "A-7781", "SUP001", d(2026, 9, 27), "فاتورة", 1401, "WH01", "CC70", 30000, po="PO-WH01-0001", grn="GRN-WH01-0001"),
        si("SINV-WH01-0002", "F-5521", "SUP002", d(2026, 9, 28), "فاتورة", 1401, "WH01", "CC70", 12500, po="PO-WH01-0002", grn="GRN-WH01-0002"),
        si("SINV-HQ01-0003", "P-3310", "SUP003", d(2026, 9, 29), "فاتورة", 1405, "WH01", "CC70", 4200, paynow="CSH-HQ01", ref="فاتورة نقدية + إذن استلام"),
        si("SINV-HQ01-0004", "M-0090", "SUP004", d(2026, 9, 29), "فاتورة", 1701, "HQ01", "CC00", 45000, ref="فاتورة فرن + محضر استلام"),
        si("SINV-WH01-0005", "CN-0012", "SUP001", d(2026, 10, 5), "إشعار خصم (مرتجع)", 1401, "WH01", "CC70", 2000, ref="إشعار خصم + نموذج مرتجع"),
        si("SINV-WH01-0006", "V-0777", "SUP005", d(2026, 10, 6), "فاتورة", 1401, "WH01", "CC70", 3600, ref="فاتورة + إذن استلام"),
        si("SINV-WH01-0007", "V-0777", "SUP005", d(2026, 10, 6), "فاتورة", 1401, "WH01", "CC70", 3600, status="مسودة", prepared=PURCH, approved=None, poster=None,
           ref="نسخة مكررة", notes="اختبار 14: فاتورة مكررة - يجب أن تُرفض"),
    ]
    S["sp"] = [
        dict(doc="SPAY-HQ01-0001", date=d(2026, 9, 30), sup="SUP001", tre="BNK-01", amount=10000, method="تحويل بنكي", desc="دفعة على الحساب", status="مرحل", prepared=PURCH, approved=FM, poster=ACC, ref="إشعار تحويل"),
        dict(doc="SPAY-HQ01-0002", date=d(2026, 10, 13), sup="SUP002", tre="BNK-01", amount=12500, method="تحويل بنكي", inv_doc="SINV-WH01-0002", desc="سداد الفاتورة F-5521", status="مرحل", prepared=PURCH, approved=FM, poster=ACC, ref="إشعار تحويل"),
        dict(doc="SPAY-HQ01-0003", date=d(2026, 10, 20), sup="SUP004", tre="BNK-01", amount=20000, method="تحويل بنكي", inv_doc="SINV-HQ01-0004", desc="دفعة أولى ثمن الفرن", status="مرحل", prepared=PURCH, approved=FM, poster=ACC, ref="إشعار تحويل"),
    ]

    # ---------------------------------------------------------------- قيود يدوية
    def mj(doc, dt_, jtype, rows, status="مرحل", prep=ASSIST, appr=FM, poster=ACC, src="", note=""):
        out = []
        for (acct, loc, dr, cr, desc, extra) in rows:
            r = dict(doc=doc, date=dt_, src=src, jtype=jtype, acct=acct, loc=loc, cc=extra.get("cc", "CC00"), desc=desc, debit=dr or None, credit=cr or None,
                     status=status, prepared=prep, approved=appr, poster=poster, ref="مستند ورقي", notes=note)
            r.update({k: v for k, v in extra.items() if k != "cc"})
            out.append(r)
        return out
    L = []
    L += mj("MJE-HQ01-0001", d(2026, 9, 1), "افتتاحي", [
        (1101, "BR01", 15000, 0, "رصيد افتتاحي خزينة BR01", dict(cf="OPENING")),
        (1102, "BR02", 12000, 0, "رصيد افتتاحي خزينة BR02", dict(cf="OPENING")),
        (1103, "BR03", 10000, 0, "رصيد افتتاحي خزينة BR03", dict(cf="OPENING")),
        (1104, "HQ01", 50000, 0, "رصيد افتتاحي خزينة الإدارة", dict(cf="OPENING")),
        (1201, "HQ01", 400000, 0, "رصيد افتتاحي البنك 1", dict(cf="OPENING")),
        (1401, "WH01", 80000, 0, "مخزون أول المدة - المخزن الرئيسي", {}),
        (1402, "CK01", 15000, 0, "مخزون أول المدة - السنتر كيتشن", {}),
        (1701, "HQ01", 250000, 0, "معدات مطابخ", {}),
        (1702, "HQ01", 100000, 0, "أثاث وتجهيزات", {}),
        (1703, "HQ01", 60000, 0, "أجهزة ونقاط بيع", {}),
        (2101, "HQ01", 0, 30000, "رصيد افتتاحي مورد SUP001", dict(party="SUP001")),
        (2101, "HQ01", 0, 12000, "رصيد افتتاحي مورد SUP002", dict(party="SUP002")),
        (3101, "HQ01", 0, 950000, "رأس المال", {}),
    ], note="رصيد افتتاحي تجريبي")
    L += mj("MJE-HQ01-0002", d(2026, 9, 30), "تسوية تكلفة المبيعات", [
        (5101, "WH01", 58000, 0, "تكلفة مواد سبتمبر = 80,000 + 42,500 - جرد 64,500", dict(cc="CC70")),
        (1401, "WH01", 0, 58000, "إخراج المستهلك من مخزون المخزن الرئيسي", dict(cc="CC70")),
    ], src="CNT-WH01-0009")
    L += mj("MJE-HQ01-0003", d(2026, 9, 30), "استحقاق/مقدم", [
        (6902, "HQ01", 1000, 0, "إطفاء حصة سبتمبر من التأمين", dict(cc="CC50")),
        (1602, "HQ01", 0, 1000, "إطفاء حصة سبتمبر من التأمين", dict(cc="CC50")),
    ], src="EXP-HQ01-0002")
    L += mj("MJE-HQ01-0004", d(2026, 9, 30), "إهلاك", [
        (6801, "HQ01", 6000, 0, "إهلاك سبتمبر", dict(cc="CC50")),
        (1791, "HQ01", 0, 4000, "مجمع إهلاك معدات المطابخ", dict(cc="CC50")),
        (1792, "HQ01", 0, 1000, "مجمع إهلاك الأثاث", dict(cc="CC50")),
        (1793, "HQ01", 0, 1000, "مجمع إهلاك الأجهزة", dict(cc="CC50")),
    ])
    L += mj("MJE-HQ01-0005", d(2026, 9, 30), "رواتب (مؤقت)", [
        (6101, "BR01", 15000, 0, "رواتب سبتمبر - BR01", dict(cc="CC10")),
        (6101, "BR02", 14000, 0, "رواتب سبتمبر - BR02", dict(cc="CC10")),
        (6101, "BR03", 13000, 0, "رواتب سبتمبر - BR03", dict(cc="CC10")),
        (6101, "HQ01", 18000, 0, "رواتب سبتمبر - الإدارة", dict(cc="CC50")),
        (2202, "HQ01", 0, 60000, "رواتب سبتمبر مستحقة", dict(cc="CC50")),
    ], src="PAYR-HQ01-0001")
    L += mj("MJE-HQ01-0008", d(2026, 10, 15), "تسوية", [
        (6990, "HQ01", 500, 0, "قيد تجريبي غير متوازن (اختبار 15)", dict(cc="CC50")),
        (2201, "HQ01", 0, 300, "قيد تجريبي غير متوازن (اختبار 15)", dict(cc="CC50")),
    ], note="اختبار 15: قيد غير متوازن يجب أن يُرفض")
    S["mj"] = L
    E["mje_opening"] = 992000
    return S, E
