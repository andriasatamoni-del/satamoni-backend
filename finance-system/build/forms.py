# -*- coding: utf-8 -*-
"""يولّد النماذج الورقية A4 (30 نموذجًا) بصيغة HTML قابلة للطباعة + PDF."""
import html, os, subprocess, sys, glob
import fs_content as C

CSS = """
@page { size: A4 portrait; margin: 10mm; }
@page wide { size: A4 landscape; margin: 10mm; }
* { box-sizing: border-box; }
body { direction: rtl; font-family: 'Noto Naskh Arabic','Amiri','Tahoma','DejaVu Sans',sans-serif; font-size: 11pt; color:#111; margin:0; }
.page { page-break-after: always; padding: 0; min-height: 275mm; position: relative; }
.page.wide { page: wide; min-height: 178mm; }
.hdr { display:flex; align-items:center; justify-content:space-between; border:2px solid #0b4f5c; padding:6px 8px; }
.logo { width:34mm; height:18mm; border:1px dashed #888; display:flex; align-items:center; justify-content:center; font-size:8pt; color:#666; text-align:center; }
.title { text-align:center; flex:1; }
.title h1 { margin:0; font-size:17pt; color:#0b4f5c; }
.title div { font-size:9.5pt; color:#444; }
.serial { width:52mm; border:1.5px solid #0b4f5c; padding:4px 6px; font-size:10pt; }
.serial b { color:#b00020; font-size:11pt; letter-spacing:1px; }
.meta { display:grid; grid-template-columns: 1fr 1fr 1fr; gap:4px 10px; margin:6px 0; }
.meta .f, .fields .f { border-bottom:1px solid #444; min-height:7.5mm; padding:1px 3px; font-size:10pt; }
.fields { display:grid; grid-template-columns: 1fr 1fr; gap:4px 14px; margin:8px 0; }
.f span { font-size:9pt; color:#555; margin-left:5px; }
table.t { width:100%; border-collapse:collapse; margin:8px 0; }
table.t th, table.t td { border:1px solid #333; padding:3px 4px; font-size:9.5pt; text-align:center; }
table.t th { background:#e6eff1; }
table.t td { height:8.4mm; }
table.t td.l { text-align:right; }
.note { margin:6px 0; font-size:10pt; border:1px dashed #666; padding:4px 6px; min-height:12mm; }
.sigs { display:grid; gap:8px; margin-top:10px; }
.sig { border:1px solid #333; height:24mm; padding:3px 5px; font-size:9pt; display:flex; flex-direction:column; justify-content:space-between; }
.sig i { color:#777; font-style:normal; font-size:8pt; }
.att { margin:6px 0; display:grid; grid-template-columns: 1fr 1fr; gap:8px; }
.att div { border:1px solid #333; min-height:14mm; padding:3px 6px; font-size:9pt; }
.foot { position:absolute; bottom:0; right:0; left:0; border-top:1px solid #0b4f5c; font-size:8.5pt; color:#333; padding-top:3px; }
.foot b { color:#0b4f5c; }
.idx td, .idx th { border:1px solid #666; padding:3px 6px; font-size:9.5pt; }
.idx { border-collapse:collapse; width:100%; }
h2 { color:#0b4f5c; }
"""


def e(s):
    return html.escape(str(s))


def form_html(f):
    wide = len(f["cols"]) > 7
    sigs = f["sigs"]
    cp = "، ".join(f"{n} ({col}) ← {h}" for n, col, h, w in f["copies"])
    when = "، ".join(f"{n}: {w}" for n, col, h, w in f["copies"] if w) or "—"
    out = [f'<section class="page {"wide" if wide else ""}">']
    out.append(f'''<div class="hdr"><div class="logo">ضع شعار ستاموني هنا<br/>(Logo)</div>
      <div class="title"><h1>{e(f["title"])}</h1><div>مطاعم ستاموني | نموذج رقم {f["no"]} | الإصدار 1.0</div></div>
      <div class="serial">الرقم المسلسل:<br/><b>{e(f["prefix"])} - ______ - ________</b><div style="font-size:8pt;color:#555">(كود الموقع - تسلسل 4 خانات)</div></div></div>''')
    out.append('<div class="meta"><div class="f"><span>التاريخ:</span> ____ / ____ / 20____</div><div class="f"><span>الفرع / الموقع (الكود):</span></div><div class="f"><span>الوردية / الوقت:</span></div></div>')
    if f["fields"]:
        out.append('<div class="fields">' + "".join(f'<div class="f"><span>{e(x)}:</span></div>' for x in f["fields"]) + '</div>')
    if f.get("table_custom"):
        out.append('<table class="t"><tr><th style="width:62%">البند</th><th>المبلغ (جنيه)</th></tr>' +
                   "".join(f'<tr><td class="l">{e(a)}</td><td></td></tr>' for a, b in f["table_custom"]) + '</table>')
    elif f["cols"]:
        n = f["rows"]
        out.append('<table class="t"><tr>' + "".join(f"<th>{e(c)}</th>" for c in f["cols"]) + "</tr>" +
                   "".join("<tr>" + "".join(f'<td>{i + 1 if j == 0 and f["cols"][0] == "م" else ""}</td>' for j, _ in enumerate(f["cols"])) + "</tr>" for i in range(n)) + "</table>")
    if f.get("note"):
        out.append(f'<div class="note">{e(f["note"])}</div>')
    out.append('<div class="att"><div><b>المرفقات:</b> ☐ فاتورة ☐ إيصال ☐ عقد ☐ إذن ☐ أخرى: ________</div><div><b>ملاحظات:</b></div></div>')
    out.append(f'<div class="sigs" style="grid-template-columns:repeat({len(sigs)},1fr)">' +
               "".join(f'<div class="sig"><b>{e(s)}</b><i>الاسم / التوقيع / التاريخ</i></div>' for s in sigs) + '</div>')
    out.append(f'<div class="foot"><b>عدد النسخ: {len(f["copies"])}</b> — {e(cp)}<br/><b>التسليم للمحاسب:</b> {e(when)} — مسجل في ورقة Google Sheets بنفس الرقم المسلسل. لا يُعدَّل بعد الترحيل؛ التصحيح بمستند عكسي.</div>')
    out.append("</section>")
    return "".join(out)


def build(outdir):
    os.makedirs(outdir, exist_ok=True)
    parts = [f"<!doctype html><html lang='ar' dir='rtl'><head><meta charset='utf-8'><title>نماذج مطاعم ستاموني</title><style>{CSS}</style></head><body>"]
    rows = "".join(f"<tr><td>{f['no']}</td><td>{e(f['title'])}</td><td>{e(f['prefix'])}</td><td>{len(f['copies'])}</td><td>{e('، '.join(h for n, col, h, w in f['copies']))}</td></tr>" for f in C.FORMS)
    parts.append(f"<section class='page'><h2>مطاعم ستاموني — فهرس النماذج الورقية (30 نموذجًا)</h2><p>اطبع على A4. يوضع الشعار في الخانة العلوية. الرقم المسلسل تُطبعه المطبعة بصيغة (البادئة-كود الموقع-تسلسل)، ويُسجَّل في السجل المركزي Doc_Register.</p>"
                 f"<table class='idx'><tr><th>م</th><th>النموذج</th><th>البادئة</th><th>النسخ</th><th>من يحتفظ بالنسخ</th></tr>{rows}</table>"
                 "<h3>الإلغاء والفقد والخطأ</h3><ul>" + "".join(f"<li><b>{e(a)}:</b> {e(b)}</li>" for a, b in C.CANCEL_RULES) + "</ul></section>")
    for f in C.FORMS:
        parts.append(form_html(f))
    parts.append("</body></html>")
    hp = os.path.join(outdir, "Satamoni_Forms_A4.html")
    open(hp, "w", encoding="utf-8").write("".join(parts))
    chrome = (glob.glob("/opt/pw-browsers/chromium-*/chrome-linux/chrome") + glob.glob("/opt/pw-browsers/chromium*/chrome-linux*/chrome"))
    pdf = os.path.join(outdir, "Satamoni_Forms_A4.pdf")
    if chrome:
        subprocess.run([chrome[0], "--headless=new", "--no-sandbox", "--disable-gpu", f"--print-to-pdf={pdf}", "--no-pdf-header-footer", f"file://{os.path.abspath(hp)}"],
                       check=False, capture_output=True, timeout=180)
    return hp, pdf


if __name__ == "__main__":
    print(build(sys.argv[1] if len(sys.argv) > 1 else "../forms"))
