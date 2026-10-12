#!/usr/bin/env python3
"""Builds print-ready branch recipe sheets (HTML) from recipes_source.csv."""
import csv, html, re, sys, collections, os
here = os.path.dirname(os.path.abspath(__file__))
rows = list(csv.reader(open(os.path.join(here, 'recipes_source.csv'), encoding='utf-8')))[1:]
items = collections.OrderedDict()
for r in rows:
    if r and r[0]:
        items.setdefault(r[0], []).append((r[1], r[2]))

PACK = ['علب', 'علبة', 'اكياس', 'ورق زبدة', 'كراسي', 'جلافزات', 'كاتشب', 'شوك', 'سكينة', 'سيلفر',
        'كفرات', 'اطباق', 'بكر', 'شرايح', 'تكلفة زيت']
def is_pack(n):
    return any(n.startswith(p) for p in PACK)

SIZES = [' حجم اكبر', ' مخصوص', ' وسط', ' صغير', ' كبير']
def split_size(name):
    for s in SIZES:
        if name.endswith(s):
            return name[:-len(s)], s.strip()
    return name, ''

def fmt(q):
    try:
        f = float(q)
        return ('%g' % f)
    except ValueError:
        return q

SZ = re.compile(r'\s*(صغير|كبير|وسط)\b')
def norm(n):
    return SZ.sub('', n).strip()
def tag(n):
    m = SZ.search(n)
    return m.group(1) if m else ''

def build_card(base, variants):
    """variants: list of (sizeLabel, [(ing, qty)])"""
    cols = [{'حجم اكبر':'أكبر'}.get(v[0], v[0]) or 'عادي' for v in variants]
    order, data = [], {}
    for ci, (_, ings) in enumerate(variants):
        for n, q in ings:
            k = (norm(n), is_pack(n))
            if k not in data:
                data[k] = {}
                order.append(k)
            data[k][ci] = (fmt(q), tag(n))
    def table(pack):
        out = []
        for k in order:
            if k[1] != pack:
                continue
            tds = []
            for ci in range(len(cols)):
                if ci in data[k]:
                    q, t = data[k][ci]
                    tds.append('<td>%s%s</td>' % (html.escape(q), ' <i>%s</i>' % t if t and len({data[k][c][1] for c in data[k]}) > 1 else ''))
                else:
                    tds.append('<td class="na">—</td>')
            out.append('<tr%s><th>%s</th>%s</tr>' % (' class="pk"' if pack else '', html.escape(k[0]), ''.join(tds)))
        return ''.join(out)
    head = ''.join('<td class="h">%s</td>' % html.escape(c) for c in cols)
    food = table(False)
    pack = table(True)
    s = '<div class="card"><h3>%s</h3><table><tr><th class="h">المكونات</th>%s</tr>%s' % (html.escape(base), head, food)
    if pack:
        s += '<tr class="sep"><th colspan="%d">التغليف والمستهلكات</th></tr>%s' % (len(cols) + 1, pack)
    return s + '</table></div>'

def group(names):
    g = collections.OrderedDict()
    for n in names:
        b, s = split_size(n)
        g.setdefault(b, []).append((s, items[n]))
    return g

def is_fasting(n): return 'صيامي' in n
def cat(n):
    if n.startswith(('اضافة', 'إضافة', 'صوص ', 'بيبسي', 'باكت')): return None
    if n.startswith('بيتزا'): return ('S2', 'بيتزا')
    if n.startswith('مكرونة'): return ('S2', 'مكرونات')
    if n.startswith(('قنبلة', 'بهججة', 'شيكاغو', 'فطيررجر')): return ('S2', 'برجر')
    if n.startswith('كريب') or n.startswith('عيش كريب'): return ('S1', 'كريب')
    if n.startswith('فطيرة مشلتت'): return ('S1', 'الفطير المشلتت')
    if n.startswith('فطيرة'):
        if re.search(r'سكر|ملوكي|قشطة|شيكولاتة|نوتيلا|فورسيزون|لوتس', n): return ('S1', 'الفطير الحلو')
        return ('S1', 'الفطير الحادق')
    return None

CSS = '''
@page{size:A4;margin:5mm}
*{box-sizing:border-box}
body{font-family:"Noto Naskh Arabic","Noto Sans Arabic","Segoe UI",Tahoma,Arial,"DejaVu Sans",sans-serif;direction:rtl;margin:0;font-size:7pt;color:#111}
h1{font-size:13pt;margin:0 0 2mm;padding:1mm 3mm;background:#222;color:#fff}
h1 small{font-weight:normal;font-size:8pt;float:left}
h2{font-size:9.5pt;margin:2mm 0 1mm;padding:.5mm 2mm;background:#ddd;border-right:3px solid #222;break-after:avoid}
.grid{column-count:3;column-gap:2mm}
.card{break-inside:avoid;border:.4pt solid #666;margin:0 0 1mm;page-break-inside:avoid}
.card h3{font-size:8pt;margin:0;padding:.3mm 1.5mm;background:#f0f0f0;border-bottom:.4pt solid #666}
table{width:100%;border-collapse:collapse}
td,th{padding:0 1.2mm;line-height:1.1;border-bottom:.2pt solid #ccc;text-align:center;font-weight:normal}
th{text-align:right}
td.h,th.h{background:#fafafa;font-weight:bold}
td.na{color:#aaa}
tr.pk th,tr.pk td{font-size:6.2pt;color:#444;line-height:1.05}
tr.sep th{background:#f5f5f5;font-size:6.6pt;color:#555;text-align:center;font-weight:bold}
i{font-style:normal;font-size:6pt;color:#555}
'''
ADD_RE = re.compile(r'^[اإ]ضافة (.+?)(?: \((.+?)\))?(?: \((.+?)\))?$')
def addition_cards(key):
    """Returns HTML cards for additions relevant to section key (S1 fatayer / S2 pizza)."""
    want = 'فطير' if key == 'S1' else 'بيتزا'
    rows_ = collections.OrderedDict()
    szmap = {'M': 'وسط', 'L': 'كبير', 'وسط': 'وسط', 'كبير': 'كبير', 'Small': 'وسط', 'Medium': 'كبير'}
    for n, ings in items.items():
        is_sauce = n.startswith('صوص ')
        if not (n.startswith(('اضافة', 'إضافة')) or is_sauce):
            continue
        if is_sauce:
            m = re.match(r'(صوص .+?) \((M|L)\)', n)
            typ, kind, size = m.group(1), 'عام', szmap[m.group(2)]
        else:
            tokens = re.findall(r'\(([^)]*)\)', n)
            typ = re.sub(r'\s*\(.*', '', n).replace('اضافة', '').replace('إضافة', '').strip()
            kind = next((t for t in tokens if t.startswith(('فطير', 'بيتزا'))), 'عام')
            size = next((szmap[t.split()[-1]] for t in tokens + [kind] if t.split() and t.split()[-1] in szmap), 'وسط')
            if kind == 'عام' and any(t in szmap and t not in ('Small', 'Medium') for t in tokens):
                size = szmap[[t for t in tokens if t in szmap][0]]
            if typ.startswith('وش بيتزا'): typ = 'وش بيتزا (مخصوص)'
            if typ.startswith('حشو'): typ = 'حشو للأطراف'
            if kind == 'عام' and n.startswith('اضافة حشو'): kind = 'بيتزا'
            if typ.startswith('وش') : kind = 'بيتزا'
        if not kind.startswith(want) and kind != 'عام':
            continue
        ing, q = ings[0]
        short = ing.replace('برسيون ', '').replace(' كيلو', '')
        rows_.setdefault(typ, {})[size] = '%s %s' % (fmt(q), short)
    out = '<div class="card"><h3>إضافات %s</h3><table><tr><th class="h">الإضافة</th><td class="h">وسط</td><td class="h">كبير</td></tr>' % ('الفطير والعامة' if key == 'S1' else 'البيتزا والعامة')
    for t, d in rows_.items():
        out += '<tr><th>%s</th><td>%s</td><td>%s</td></tr>' % (html.escape(t), html.escape(d.get('وسط', '—')), html.escape(d.get('كبير', '—')))
    return out + '</table></div>'

def page(title, sub, sections, extra=''):
    body = ''
    for sec, names in sections:
        if not names: continue
        cards = ''.join(build_card(b, v) for b, v in group(names).items())
        body += '<h2>%s</h2><div class="grid">%s</div>' % (html.escape(sec), cards)
    return '<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><title>%s</title><style>%s</style></head><body><h1>%s<small>%s</small></h1>%s%s</body></html>' % (html.escape(title), CSS, html.escape(title), html.escape(sub), body, extra)

for key, secname in (('S1', 'القسم الأول — فطير حادق / فطير حلو / كريب'), ('S2', 'القسم الثاني — بيتزا / مكرونات / برجر')):
    for fast in (False, True):
        sections = collections.OrderedDict()
        for n in items:
            c = cat(n)
            if c and c[0] == key and is_fasting(n) == fast:
                sections.setdefault(c[1], []).append(n)
        order = ['الفطير الحادق', 'الفطير الحلو', 'الفطير المشلتت', 'كريب'] if key == 'S1' else ['بيتزا', 'مكرونات', 'برجر']
        secs = [(o, sections.get(o, [])) for o in order]
        menu = 'المنيو الصيامي' if fast else 'المنيو العادي'
        fn = 'recipe_%s_%s.html' % ('1_fatayer_crepe' if key == 'S1' else '2_pizza_pasta_burger', 'fasting' if fast else 'regular')
        open(os.path.join(here, fn), 'w', encoding='utf-8').write(page('ريسبي الفروع — %s' % menu, secname, secs, ('<h2>الإضافات</h2><div class="grid">%s</div>' % addition_cards(key)) if not fast else ''))
        print(fn, sum(len(x[1]) for x in secs))
