# -*- coding: utf-8 -*-
"""إطار بناء أوراق Google Sheets/Excel للنظام المالي لمطاعم ستاموني.

كل ورقة تُعرَّف بأعمدة (مدخلات يدوية أو معادلات). المعادلات تُكتب كدوال Python
تستقبل سياق الصف `x` وتُرجع نص المعادلة، فلا توجد أرقام صفوف ثابتة في المعادلات.
"""
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side, Protection
from openpyxl.utils import get_column_letter as GL
from openpyxl.worksheet.datavalidation import DataValidation
from openpyxl.formatting.rule import FormulaRule, CellIsRule
from openpyxl.workbook.defined_name import DefinedName

FONT = "Tahoma"
C_TITLE = "0B4F5C"
C_IN_H = "1F4E78"
C_F_H = "595959"
C_IN = "FFF8E1"
C_F = "F2F2F2"
C_HDR_BAND = "DCEBEF"
C_RED = "F8CBAD"
C_GREEN = "C6E0B4"
C_AMBER = "FFE699"

thin = Side(style="thin", color="BFBFBF")
BORDER = Border(left=thin, right=thin, top=thin, bottom=thin)

LIST_REFS = {}    # اسم النطاق -> مرجع مباشر (لقوائم التحقق، تفاديًا لاعتماد Google Sheets على الأسماء)
REG = {}          # sheet name -> Sheet
ALL = []          # ordered list of Sheet objects


class Ctx:
    def __init__(self, sh, r):
        self.sh, self.r = sh, r

    def __call__(self, key):
        return f"${self.sh.L(key)}{self.r}"

    def col(self, key):
        L = self.sh.L(key)
        return f"${L}:${L}"

    def ext(self, sheet, key):
        L = REG[sheet].L(key)
        return f"{sheet}!${L}:${L}"

    @property
    def used(self):
        a, b = self.sh.input_span()
        return f"COUNTA(${a}{self.r}:${b}{self.r})>0"

    @property
    def row(self):
        return self.r


class Sheet:
    def __init__(self, name, title, subtitle="", hdr=4, cap=100, tab=None,
                 freeze_col=1, protect=True, widths_note=None):
        self.name, self.title, self.subtitle = name, title, subtitle
        self.hdr, self.cap, self.tab = hdr, cap, tab
        self.cols = []
        self.freeze_col = freeze_col
        self.protect = protect
        self.samples = []           # list of dict key->value
        self.extra = []             # callables(ws) executed after render
        self.dvs = []
        self.first = hdr + 1
        self.row_fn = None
        REG[name] = self
        ALL.append(self)

    # ---- columns -------------------------------------------------------
    def add(self, key, ar, kind="in", w=14, fmt=None, f=None, dv=None, en=None,
            align=None, hide=False, note=None):
        self.cols.append(dict(key=key, ar=ar, en=en, kind=kind, w=w, fmt=fmt, f=f,
                              dv=dv, align=align, hide=hide, note=note))
        return self

    def idx(self, key):
        for i, c in enumerate(self.cols):
            if c["key"] == key:
                return i + 1
        raise KeyError(f"{self.name}.{key}")

    def L(self, key):
        return GL(self.idx(key))

    def input_span(self):
        ins = [i + 1 for i, c in enumerate(self.cols) if c["kind"] == "in"]
        return GL(min(ins)), GL(max(ins))

    @property
    def last(self):
        return self.hdr + self.cap

    def rng(self, key, absolute=True):
        L = self.L(key)
        return f"{self.name}!${L}${self.first}:${L}${self.last}"

    # ---- rendering -----------------------------------------------------
    def render(self, wb, with_samples=True):
        ws = wb.create_sheet(self.name)
        self.ws = ws
        ws.sheet_view.rightToLeft = True
        ws.sheet_view.zoomScale = 90
        if self.tab:
            ws.sheet_properties.tabColor = self.tab
        n = len(self.cols)
        ws.cell(1, 1, self.title).font = Font(name=FONT, size=14, bold=True, color="FFFFFF")
        for c in range(1, max(n, 8) + 1):
            ws.cell(1, c).fill = PatternFill("solid", fgColor=C_TITLE)
        ws.row_dimensions[1].height = 26
        ws.cell(2, 1, self.subtitle).font = Font(name=FONT, size=9, italic=True, color="404040")
        ws.cell(2, 1).alignment = Alignment(wrap_text=False, vertical="center")
        # legend
        if self.hdr >= 4:
            a = ws.cell(3, 1, "خلايا الإدخال")
            a.fill = PatternFill("solid", fgColor=C_IN)
            b = ws.cell(3, 2, "معادلات (لا تعدّل)")
            b.fill = PatternFill("solid", fgColor=C_F)
            for c in (a, b):
                c.font = Font(name=FONT, size=9, bold=True)
                c.border = BORDER
        # header
        for i, c in enumerate(self.cols, start=1):
            h = ws.cell(self.hdr, i, c["ar"] + (f"\n{c['en']}" if c["en"] else ""))
            h.font = Font(name=FONT, size=10, bold=True, color="FFFFFF")
            h.fill = PatternFill("solid", fgColor=C_IN_H if c["kind"] == "in" else C_F_H)
            h.alignment = Alignment(horizontal="center", vertical="center", wrap_text=True)
            h.border = BORDER
            ws.column_dimensions[GL(i)].width = c["w"]
            if c["hide"]:
                ws.column_dimensions[GL(i)].hidden = True
        ws.row_dimensions[self.hdr].height = 34
        # body
        samples = self.samples if with_samples else []
        for k in range(self.cap):
            r = self.first + k
            x = Ctx(self, r)
            srow = samples[k] if k < len(samples) else {}
            for i, c in enumerate(self.cols, start=1):
                cell = ws.cell(r, i)
                if c["kind"] == "in":
                    v = srow.get(c["key"])
                    if v is not None:
                        cell.value = v
                    cell.fill = PatternFill("solid", fgColor=C_IN)
                    cell.protection = Protection(locked=False)
                else:
                    if c["f"] is not None:
                        cell.value = c["f"](x)
                    cell.fill = PatternFill("solid", fgColor=C_F)
                cell.font = Font(name=FONT, size=10)
                cell.border = BORDER
                if c["fmt"]:
                    cell.number_format = c["fmt"]
                if c["align"]:
                    cell.alignment = Alignment(horizontal=c["align"], vertical="center")
        # validations
        for i, c in enumerate(self.cols, start=1):
            if c["dv"]:
                dv = c["dv"]
                if c["kind"] != "in":
                    continue
                L = GL(i)
                rngtxt = f"{L}{self.first}:{L}{self.last}"
                d = make_dv(dv, f"{L}{self.first}")
                ws.add_data_validation(d)
                d.add(rngtxt)
        ws.freeze_panes = ws.cell(self.first, self.freeze_col + 1)
        ws.auto_filter.ref = f"A{self.hdr}:{GL(n)}{self.last}"
        # check/status conditional formats
        for i, c in enumerate(self.cols, start=1):
            L = GL(i)
            rr = f"{L}{self.first}:{L}{self.last}"
            if c["key"] in ("chk", "issue", "flag"):
                ws.conditional_formatting.add(
                    rr, FormulaRule(formula=[f"LEN({L}{self.first})>0"], fill=PatternFill("solid", bgColor=C_RED, fgColor=C_RED)))
            if c["key"] in ("mdiff", "diff", "jediff", "resid", "jebal"):
                ws.conditional_formatting.add(
                    rr, FormulaRule(formula=[f'AND(ISNUMBER({L}{self.first}),ABS({L}{self.first})>0.005)'], font=Font(color="C00000", bold=True)))
            if c["key"] == "status":
                ws.conditional_formatting.add(rr, FormulaRule(formula=[f'{L}{self.first}="مرحل"'], fill=PatternFill("solid", bgColor=C_GREEN, fgColor=C_GREEN)))
                ws.conditional_formatting.add(rr, FormulaRule(formula=[f'{L}{self.first}="معكوس"'], fill=PatternFill("solid", bgColor=C_AMBER, fgColor=C_AMBER)))
        for fn in self.extra:
            fn(ws)
        ws.page_setup.orientation = "landscape"
        ws.page_setup.fitToWidth = 1
        ws.page_setup.fitToHeight = 0
        ws.sheet_properties.pageSetUpPr.fitToPage = True
        if self.protect:
            protect_ws(ws)
        return ws


def protect_ws(ws):
    p = ws.protection
    p.sheet = True
    p.autoFilter = False
    p.formatColumns = False
    p.formatRows = False
    p.formatCells = False
    p.selectLockedCells = False
    p.selectUnlockedCells = False


def make_dv(dv, first_cell):
    """dv: ('list', '=Sheet!$A$5:$A$20' | 'a,b,c') | ('date',) | ('dec',) | ('int',) | ('custom', fn)"""
    kind = dv[0]
    if kind == "list":
        src = dv[1]
        if src.startswith("=") and src[1:] in LIST_REFS:
            src = "=" + LIST_REFS[src[1:]]
        if not src.startswith("="):
            src = '"' + src + '"'
        d = DataValidation(type="list", formula1=src, allow_blank=True, showErrorMessage=True)
        d.errorTitle = "قيمة غير مسموحة"
        d.error = "اختر قيمة من القائمة المنسدلة."
    elif kind == "date":
        d = DataValidation(type="date", operator="greaterThan", formula1="36526", allow_blank=True, showErrorMessage=True)
        d.errorTitle = "تاريخ غير صحيح"
        d.error = "أدخل تاريخًا صحيحًا."
    elif kind == "dec":
        d = DataValidation(type="decimal", operator="greaterThanOrEqual", formula1="0", allow_blank=True, showErrorMessage=True)
        d.errorTitle = "مبلغ غير صحيح"
        d.error = "أدخل رقمًا موجبًا (لا يسمح بالسالب؛ استخدم المستند العكسي)."
    elif kind == "int":
        d = DataValidation(type="whole", operator="greaterThanOrEqual", formula1="0", allow_blank=True, showErrorMessage=True)
        d.error = "أدخل عددًا صحيحًا موجبًا."
    elif kind == "custom":
        d = DataValidation(type="custom", formula1=dv[1].replace("{c}", first_cell), allow_blank=True, showErrorMessage=True)
        d.error = dv[2] if len(dv) > 2 else "قيمة غير مسموحة."
    else:
        raise ValueError(kind)
    return d


def chain(pairs, default='""'):
    """pairs: [(cond, msg)] -> nested IF returning first failing message."""
    out = default
    for cond, msg in reversed(pairs):
        out = f'IF({cond},"{msg}",{out})'
    return out


def name_cell(wb, name, ref):
    dn = DefinedName(name, attr_text=ref)
    wb.defined_names[name] = dn
