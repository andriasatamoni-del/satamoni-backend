# -*- coding: utf-8 -*-
"""يبني النسخة الفعلية (من القالب النظيف) بمبيعات 1-20 أكتوبر 2026 لفرعي محرم بك والإبراهيمية."""
import csv, datetime as dt, sys, os
import build_system as bs

d = dt.date
FILES = {"BR01": sys.argv[1], "BR02": sys.argv[2]}   # BR01 = محرم بك ، BR02 = الإبراهيمية
OUT = sys.argv[3]
NAMES = {"BR01": "فرع محرم بك", "BR02": "فرع الإبراهيمية"}
TMP = "مُعِد (مؤقت - استبدله)", "معتمد (مؤقت - استبدله)", "مرحِّل (مؤقت - استبدله)"


def rows(path, loc):
    out = []
    for r in csv.reader(open(path, encoding="utf-8")):
        if len(r) >= 12 and r[11][:4] == "2026" and len(r[11]) == 10:
            paid, cred, visa, cash = (float(r[i]) for i in (0, 1, 2, 3))
            assert abs(cash + visa + cred - paid) < 0.02, r
            dd = d.fromisoformat(r[11])
            out.append(dict(doc=f"SAL-{loc}-{dd.day:04d}", date=dd, loc=loc, g4=round(paid, 2), m1=round(cash, 2), m2=round(visa, 2), m3=round(cred, 2),
                            status="مرحل", prepared=TMP[0], approved=TMP[1], poster=TMP[2], ref="تقرير المبيعات الشهرية (نظام الكاشير)",
                            notes="مستورد من تقرير 1-20 أكتوبر؛ الصافي = إجمالي المسدد؛ آجل = طلبات تطبيق طلبات"))
    assert len(out) == 20, len(out)
    return out


def hook(REG):
    data = rows(FILES["BR01"], "BR01") + rows(FILES["BR02"], "BR02")
    REG["Sales_Daily"].samples = data
    L = REG["Locations"]
    for r in L.samples:
        if r["code"] in NAMES:
            r["name"] = NAMES[r["code"]]
    T = REG["Treasuries"]
    for r in T.samples:
        if r["code"] in ("CSH-BR01", "CSH-BR02"):
            r["name"] = "خزينة " + NAMES[r["loc"]]
    REG["Users"].samples = [dict(code=f"USR{i+1:02d}", name=n, role=ro, loc="HQ01", active="نعم") for i, (n, ro) in enumerate(zip(TMP, ["أمين صندوق", "مدير فرع", "المحاسب"]))]


path, _ = bs.build(OUT, demo=False, with_br04=False, scale=0.2, period=(d(2026, 10, 1), d(2026, 10, 20)), tag="_REAL_Oct1-20", hook=hook)
print(path)
