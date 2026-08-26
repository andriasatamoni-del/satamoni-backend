# PHASE 7J — EXPORT & DATE-RANGE FILTERING REPORT

## 1. Executive Summary

The user asked for every report to be downloadable as Excel or PDF, and for every report to offer a
"from - to" custom date-range filter instead of being locked to year/month. Before writing any code,
three technical choices were put to the user (via `AskUserQuestion`) because each carried a real
tradeoff:

1. **PDF export** — reuse the existing print screen (built in Phase 7I) rather than build a
   direct-download PDF library. Client-side Arabic PDF generation is a real risk: available libraries
   (jsPDF etc.) don't reliably shape Arabic text, so a generated PDF could come out garbled or
   reversed. The print screen uses the browser's own rendering engine, so Arabic is always correct —
   the user chose this (recommended) option, so **no new work was needed here**.
2. **Excel export** — a simple CSV file rather than a real formatted `.xlsx`, to avoid adding any new
   library to a project that has no bundler (every page loads plain `<script>` files). The user chose
   CSV (recommended).
3. **Date-range scope** — "do all reports at once" rather than prioritize a subset. Research done
   before implementation found this was less work than it sounded: most report endpoints already
   supported real from/to ranges via a shared `resolveDateRange()` helper in `routes/reports.js`. Only
   six endpoints were genuinely locked to year/month.

## 2. What Was Actually a Gap

A research pass (before any code) mapped every report/list endpoint in the backend and its current
date-filter mechanism. Findings:

- **Already real from/to** (no work needed): `sales-detail`, `expenses-report`, `purchases-report`,
  `journal-entries-report`, `general-ledger`, HR's `warnings`/`leaves`/`turnover`/`new-hires`/
  `terminations`, `audit-logs`, `shifts`, and about 20 more.
- **Locked to year/month, needed conversion**: `daily`, `income-statement`,
  `income-statement/by-branch`, `dashboard`, `vat-summary`, `accounting-reconciliation` — 6 endpoints.
- **Deliberately NOT converted** (converting them would change what the report means, not just how
  it's filtered):
  - `trial-balance`, `balance-sheet`, `cash-report`, `ap-aging` — "as of a date" snapshot reports, no
    "from" makes sense for a balance.
  - `payroll.js`'s summary/attendance-punches/central-kitchen-attendance/adjustments/runs — payroll
    is a calendar-month business process in this system; `central_kitchen_manual_attendance` and
    `department_sales` are literally keyed by `(year, month)` integer columns, not a date, and
    `computePayrollSummary` computes "this month's payroll" as a unit, not a sum over days.
  - Live operational boards: the dispatch board's single-day filter, cashier shift lists, daily
    attendance — these show "today," not a period; forcing a range changes them into something else.
  - Threshold reports: dormant customers ("no order in N days"), expiring batches ("expiring within N
    days") — a different question from "orders between date A and B."

This distinction is documented in `docs/EXPORT-AND-DATE-FILTERING.md` so the boundary is intentional,
not an oversight discovered later.

## 3. The Real Technical Problem: Payroll Cost on a Partial Range

`income-statement` and `dashboard` both include `payrollCost`/`netProfitAfterPayroll` in their
response, computed via `computePayrollCostByBranch(year, month)` — a genuinely monthly figure
(employees without fingerprint tracking get a flat month's salary, not a per-day proration). Once
these two endpoints accept an arbitrary `from`/`to`, a range that isn't exactly one calendar month has
no honest payroll-cost number to report.

Solution: `monthIfFullMonthRange(from, to)` checks whether the resolved range is exactly one calendar
month (day 1 through the month's last day). If yes, payroll cost is computed as before. If no,
`payrollCost` and `netProfitAfterPayroll` come back as `null` with a `note` explaining why — never a
silently wrong number, never a `0.00` that could be mistaken for "no payroll cost." The frontend
(`moneyOrNA()` helper, both in `satamoni-accounting.html` and `satamoni-dashboard.html`) renders this
as "غير متاح" (not available) instead of coercing `null` to `0.00 ج.م`, and the profit/loss coloring
logic was fixed too — `null >= 0` evaluates to `true` in JavaScript, which would have wrongly
colored an unavailable figure green.

## 4. What Was Built

- **`public/js/print-reports.js`**: new `exportPanelCSV()`/`exportCurrentTabCSV()` reusing the exact
  same `collectSections()` table-extraction logic Phase 7I built for printing — same tables, same
  section headings, but written out as CSV lines and triggered as a browser download (with a UTF-8
  BOM so Excel renders Arabic correctly) instead of opening a print window.
- **routes/reports.js**: `computeRevenueAndCogsByBranch` converted from `(year, month)` to
  `(from, to)`; the 6 locked endpoints now accept `from`/`to` as well as `year`/`month` (backward
  compatible — no caller breaks); `monthIfFullMonthRange` added.
- **Frontend**: an "📊 تصدير Excel" button added next to the existing print button on all 8 pages
  from Phase 7I (accounting, reports center, payroll, customers, audit, dispatch, drivers,
  dashboard). `satamoni-accounting.html`'s income-statement/VAT/reconciliation tabs and
  `satamoni-dashboard.html` gained an optional "أو مدى مخصص: من - لحد" custom-range control next to
  their existing year/month pickers (custom range takes priority when filled). Several pre-existing
  but unlabeled from/to input pairs (general ledger, journal entries, ledger P&L, HR turnover/hires,
  audit log) gained `<label>` elements so Phase 7I's print-meta extraction picks them up correctly —
  a compatibility fix, not a behavior change.
- **`satamoni-payroll.html`, `satamoni-customers.html`, `satamoni-dispatch.html`,
  `satamoni-drivers.html`**: deliberately left untouched for date-range filtering, per the scope
  decisions in §2 — they already have print/CSV export buttons from this phase, but no new date
  controls, because none would be meaningful.

## 5. Verification

- **Tests**: new `tests/report-date-range.test.js` (8 tests) — confirms `from`/`to` and the equivalent
  `year`/`month` return identical results on all 6 converted endpoints, confirms `payrollCost`/
  `netProfitAfterPayroll` come back `null` with an explanatory note for a same-day (non-full-month)
  range and non-null for a full calendar month, and confirms all 6 endpoints still reject requests with
  neither `from`/`to` nor `year`/`month` (400). Full suite: 442 (prior phases) + 8 new = **450/450**,
  stable across two consecutive runs.
- **Browser verification** (Playwright, headless Chromium, real Postgres): custom date ranges on
  income statement, VAT summary, reconciliation, and dashboard all returned correct figures; the
  partial-range payroll-unavailable case showed "غير متاح" correctly instead of "0.00 ج.م"; CSV
  downloads from 6 different report tabs (income statement, VAT, expenses, dashboard, reports-center
  cancelled-orders) all produced correctly structured, correctly Arabic-encoded content; printing
  (Phase 7I) was re-verified unaffected by the new custom-range controls sitting on the same tabs.

## 6. Files Changed

**Backend**: `routes/reports.js`.

**Frontend**: `public/js/print-reports.js`, `public/satamoni-accounting.html`,
`public/satamoni-dashboard.html`, `public/satamoni-reports.html`, `public/satamoni-payroll.html`,
`public/satamoni-customers.html`, `public/satamoni-audit.html`, `public/satamoni-dispatch.html`,
`public/satamoni-drivers.html` (export button wiring only on the last 6).

**Tests**: `tests/report-date-range.test.js` (new).

**Docs**: `docs/EXPORT-AND-DATE-FILTERING.md` (new), this report.

No schema/migration changes this phase — purely query-shape and presentation changes.

---

# PHASE 7J STATUS

**Implementation**: COMPLETE

**Tests**: 450/450 (442 prior + 8 new), stable across 2 consecutive runs

**Browser Verification**: PASS (Playwright — custom date ranges, CSV downloads across 6 report tabs,
partial-range payroll-null handling, print still unaffected)

**Render Staging**: NOT INDEPENDENTLY VERIFIED — no network access from this session; full flow
proven in a real local browser; user verification on next deploy recommended

**Operational Completeness Before**: ~88% (post-Phase-7I)

**Operational Completeness After**: ~90% (Excel/CSV export and date-range filtering now available
everywhere they make sense; PDF export was already covered by Phase 7I's print screen)

**Remaining P1**: third-party delivery-app integration (Talabat etc.) — still blocked, no real API
credentials available; this remains the only unaddressed item from the original Phase 7D audit

**Remaining Manual Workarounds**: none introduced by this phase. The date-range exclusions
(payroll, as-of snapshots, live operational boards, threshold reports) are deliberate design
decisions documented in `docs/EXPORT-AND-DATE-FILTERING.md`, not gaps left half-done.

**Recommended Next Step**: with VAT (7H), printable reports (7I), and export/date-filtering (7J) all
closed, delivery-app integration is the only remaining item from the original audit — genuinely
blocked until real API access exists. Absent that, further work should come from the user's own
priorities or a fresh look at what's used most in daily operation.

Per the same working pattern established across 7E–7I, stopping here to report before starting
anything further.
