# PHASE 7E — SHIFT & BRANCH OPERATIONS REPORT

## 1. Executive Summary

Phase 7E closes the highest-priority P0 gap identified in `PHASE 7D — FULL OPERATIONAL GAP AUDIT.md`:
Satamoni had no real POS cashier shift concept and no cash reconciliation tied to actual sales data
(`daily_cash_sessions` was a disconnected manual-entry form). This phase implements a full shift
lifecycle (open → active → close/pending-review → closed, or force-closed), a server-computed
(never cashier-typed) expected-cash formula, configurable variance thresholds with manager
review/approval, a branch daily-close workflow with a hard-blocking RED/YELLOW/GREEN checklist,
full audit trail, an explicit permission matrix, minimal POS/accounting UI additions, and a
concurrency-and-negative-test suite. Scope was deliberately held to shift/cash reconciliation only —
no driver management, KDS, tax/VAT, advanced delivery, new accounting architecture, or new
inventory architecture was touched, per the phase's explicit boundaries.

## 2. Pre-Implementation Architecture Review

Before writing any code, the following existing systems were read in full to ensure the new feature
integrates rather than duplicates:

- **`db/schema.sql`**: `orders` (status/payment_status lifecycle, `payment_method_id`), `expenses`
  (status/posted_at workflow), `payment_methods.kind` (`cash`/`card_or_wallet`/`credit`),
  `daily_cash_sessions` (the old manual, disconnected cash form — left untouched, coexists as a
  separate legacy tab), `audit_logs`, existing FK-added-via-`ALTER TABLE`-later pattern
  (`expenses.supplier_id`, `expenses.journal_entry_id`).
- **`db/migrate.js` / `db/ensure-schema.js`**: the automatic migration runner built in the immediately
  preceding turn (idempotent `db/migrations/000N_*.js` files tracked in `schema_migrations`,
  auto-applied on every server start via Render's `startCommand`). This phase's schema change plugs
  into that system as `0002_shift_management.js` rather than requiring any manual `ALTER TABLE` step.
- **`middleware/auth.js`**: `requireAuth` (re-reads role/branchId/is_active fresh from DB every
  request), `requireRole`, `assertOwnBranch` (admin bypass, else strict string-equality on
  `branchId`).
- **`middleware/permissions.js`**: `ROLE_PERMISSIONS` / `hasPermission` / `requirePermission` — the
  fine-grained permission layer added in Phase 1, extended here rather than replaced.
- **`db/accounting-engine.js`**: `postJournalEntry`, `reverseJournalEntry`, period-lock guard —
  read to determine whether shift open/close needed new journal entries (conclusion: no, see §9).
- **`db/audit.js`**: `logAudit(executor, {...})` — reused as-is for all new audit events.
- **`routes/orders.js`**: existing sale/void/discount-approval flow, `payment_status` collection
  semantics (delivery orders stay `pending_collection` until a driver/cashier explicitly confirms
  collection via `PATCH /:id/payment-status`) — this distinction turned out to be critical for
  correct cash-reconciliation math (§5).
- **`tests/loyalty-redemption.test.js`**: established the pattern of mutating global `pos_settings`
  in `beforeAll`/restoring in `afterAll`, reused for the new shift-related settings columns.

## 3. Shift Lifecycle Design

```
ACTIVE ──(close, |variance| ≤ ack threshold)──► CLOSED
   │
   └──(close, |variance| > ack threshold)──► PENDING_REVIEW ──(manager review)──► CLOSED
   │
   └──(admin force-close, reason required)──► FORCE_CLOSED
```

One `pos_shifts` row per shift; `branch_id`, `user_id`, `opening_cash`, and at close:
`expected_cash`, `actual_cash`, `cash_variance`, per-category sales/refunds/expenses breakdown,
`variance_status` (`NONE`/`PENDING_REVIEW`/`ACKNOWLEDGED`/`APPROVED`), and reviewer metadata. Full
design detail in [`docs/SHIFT-MANAGEMENT.md`](./docs/SHIFT-MANAGEMENT.md).

## 4. Concurrency & Locking Model

- **One active shift per cashier**: enforced by a **partial unique index**
  (`CREATE UNIQUE INDEX ... ON pos_shifts(user_id) WHERE status = 'ACTIVE'`) — the same pattern
  already used for `orders.idempotency_key`. The application-level pre-check in
  `db/shift-engine.js` is a UX optimization only; the real guarantee is the database constraint,
  with the resulting `23505` mapped to a friendly `SHIFT_ALREADY_ACTIVE` (409) error.
- **Double-close / double-review**: every close and review route `SELECT ... FOR UPDATE`s the shift
  row inside a transaction before checking its status, so two concurrent requests serialize at the
  database and only one can transition the row.
- **Branch-day double-close**: `UNIQUE(branch_id, business_date)` on `branch_days`, plus a
  `SELECT ... FOR UPDATE` on the branch's active/pending shifts inside the close transaction before
  re-running the checklist.
- All of the above were verified with real parallel HTTP requests (`Promise.all`), not just reasoned
  about — see §17.

## 5. Expected-Cash Formula & Source-of-Truth Philosophy

```
expected_cash = opening_cash + cash_sales − cash_refunds − cash_expenses
```

Consistent with this project's established "Phase 5 duplicate-calculation audit" philosophy, every
number is **computed live from `orders`/`expenses` at preview/close time**, never accumulated by a
running counter updated on each order (which would be exposed to update races and duplicate-source-
of-truth bugs). `db/shift-engine.js::computeShiftFinancials` is the single source of truth, called
identically from both `GET /:id/preview` (live) and `POST /:id/close` (frozen at that instant,
mirroring the existing `order_items.cost_at_sale` frozen-cost pattern).

**Correctness fix made during implementation** (caught before any test was written against it):
cash/card/other sales are filtered on `payment_status = 'collected'`, not just `status <> 'cancelled'`.
Without this filter, a POS-sourced delivery order — which stays `pending_collection` until the
driver/cashier confirms — would have inflated `cash_sales` with money not actually in the drawer yet,
producing a phantom shortage unrelated to any real cashier error. This is documented in
[`docs/SHIFT-MANAGEMENT.md`](./docs/SHIFT-MANAGEMENT.md).

**Cash-refund double-count guard**: a cash order sold and voided within the *same* shift is already
excluded from `cash_sales` (its `status='cancelled'`); the refund query additionally excludes
same-shift originals (`shift_id IS DISTINCT FROM $1`) so it isn't also subtracted as a refund — which
would otherwise double-penalize cash that was never in the drawer to begin with.

## 6. Variance Thresholds & Manager Review Workflow

Configurable, not hardcoded: `pos_settings.shift_variance_ack_threshold_egp` (default 20 EGP) and
`shift_variance_review_threshold_egp` (default 100 EGP, a UI-only visual-severity marker — not a
third blocking state). Below the ack threshold: silent auto-close, `variance_status='NONE'`. Above
it: `PENDING_REVIEW`, requiring `POST /api/shifts/:id/review {decision: "approve"|"acknowledge",
notes}` from `branch_manager`/`accountant`/`admin`. Both decisions terminally close the shift
(`CLOSED`); only `variance_status` (`ACKNOWLEDGED` vs `APPROVED`) differs, preserved for historical
reporting. Full detail in [`docs/SHIFT-MANAGEMENT.md`](./docs/SHIFT-MANAGEMENT.md).

## 7. Shift Close, Lock & Force-Close Behavior

Once closed (any terminal status), a shift is fully locked from cashier edits — no route allows
further mutation of a non-`ACTIVE` shift's financials. `POST /:id/force-close` is admin-only,
requires a non-empty `reason` (enforced in `db/shift-engine.js::forceCloseShift`, returns `400
FORCE_CLOSE_REASON_REQUIRED` otherwise), and records `FORCE_CLOSED` distinctly from `CLOSED` so
reports can tell a normal cashier close from an administrative override.

## 8. Branch Daily Close & RED/YELLOW/GREEN Checklist

`branch_days` has no explicit "open" action — a day is implicitly open until a `CLOSED` row exists
for it (deliberate: avoids inventing a new "open day" concept the business doesn't otherwise have).
`GET /api/branch-days/:branchId/status` returns a checklist:

- 🔴 **RED (hard-blocking, no override)**: any `ACTIVE` shift, any `PENDING_REVIEW` shift, any order
  still `preparing`/`out_for_delivery` (any date, not just the day being closed).
- 🟡 **YELLOW (informational only)**: any shift closed with a reviewed variance in the last 24h.
- 🟢 **GREEN**: `canClose = true`.

The checklist is evaluated twice by design — once for display, once again inside the close
transaction (with `FOR UPDATE` on relevant shift rows) — so a change between "manager opens the
close screen" and "manager clicks close" is caught. Full detail, including the explicitly documented
gap around a new order slipping in mid-close (accepted, not silently hidden), in
[`docs/BRANCH-DAILY-CLOSE.md`](./docs/BRANCH-DAILY-CLOSE.md).

## 9. Accounting Integration Decision

**No new journal entries are posted for shift open, shift close, or branch-day close themselves.**
Cash and card sales already post their own journal entries at the point of sale (Phase 4B, untouched
here); a shift is a *classification/grouping* of existing, already-correctly-posted sales — not a
new business event requiring its own entry. This directly follows the phase's own instruction:
"add journal entries only where the business event genuinely requires it; existing posted entries
must remain immutable." No existing entry was reversed, edited, or reposted by this phase.

## 10. Inventory Handling

Not touched. Shifts and branch-days report on `orders`/`expenses`; no new inventory movement,
reservation, or duplicate-tracking concept was introduced. Inventory remains exactly as reported by
the existing Phase 2 ledger.

## 11. Audit Trail

Every critical action logs to `audit_logs` via the existing `logAudit()` helper with actor, branch,
before/after values, and (for force-close) the mandatory reason: `SHIFT_OPENED`, `SHIFT_CLOSED`,
`SHIFT_VARIANCE_REVIEWED`, `SHIFT_FORCE_CLOSED`, `BRANCH_DAY_CLOSED`.

## 12. Permission Matrix

| Permission | cashier | branch_manager | accountant | admin |
|---|---|---|---|---|
| `shifts.open_own` / `view_own` / `close_own` | ✅ (own) | ✅ (own) | ❌ | ✅ |
| `shifts.view_branch` | ❌ | ✅ (own branch) | ✅ (own branch) | ✅ (all) |
| `shifts.review` | ❌ | ✅ (own branch) | ✅ (own branch) | ✅ (all) |
| force-close | ❌ | ❌ | ❌ | ✅ only |
| `branch_day.view` | ❌ | ✅ (own branch) | ✅ (own branch) | ✅ (all) |
| `branch_day.close` | ❌ | ✅ (own branch) | ❌ | ✅ (all) |

Branch isolation (`assertOwnBranch`) is enforced on every route; verified with real cross-branch HTTP
requests in tests (§17), not just code inspection.

## 13. Backend API Surface

`routes/shifts.js` (mounted at `/api/shifts`): `POST /open`, `GET /current`, `GET /mine`,
`GET /` (branch list, filterable), `GET /:id`, `GET /:id/preview`, `POST /:id/close`,
`POST /:id/review`, `POST /:id/force-close`.

`routes/branch-days.js` (mounted at `/api/branch-days`): `GET /:branchId/status`,
`POST /:branchId/close`, `GET /:branchId/history`.

`routes/orders.js`: `source=pos` orders now auto-attribute `shift_id` from the creator's active
shift; `pos_settings.require_shift_for_pos_sales` (default `FALSE`, documented decision — see §16)
optionally hard-blocks POS sales with no active shift.

## 14. Frontend Changes

- **`public/satamoni-pos.html`**: a shift-status pill in the topbar (no-shift / active with opened
  time), an open-shift modal (opening cash + notes), and a close-shift modal showing the live
  expected-cash breakdown, an actual-cash input with a live variance indicator, and closing notes.
  Also fixed a pre-existing gap where the order-submit handler discarded the server's actual error
  message (`throw new Error("submit failed")` regardless of body) — needed so the new
  shift-required error surfaces to the cashier instead of a generic message.
- **`public/satamoni-accounting.html`**: two new tabs reusing the page's existing tab/panel IA —
  "مراجعة الشيفتات" (branch shift list with variance coloring and a review action for
  `PENDING_REVIEW` rows) and "تقفيل يوم الفرع" (checklist status display, close action, closure
  history). The pre-existing "تقفيل الكاش" (legacy manual `daily_cash_sessions` form) tab was left
  untouched and coexists.
- Both pages were exercised end-to-end in a real headless browser (Playwright) against a live local
  Postgres + server instance — not just unit-tested — including the full open → sell → preview →
  close flow on POS and the review → day-close flow on the accounting page. See §17.

## 15. Printable Reports

No new dedicated print stylesheet was added (out of scope — the phase's minimal-frontend-changes
instruction). The shift detail (`GET /:id`) and branch-day history (`GET /:branchId/history`)
endpoints return everything needed for a manager to print via the browser's native print dialog from
the existing tables; a dedicated print layout is left as a follow-up if requested.

## 16. Documented Design Decisions & Known Limitations

- **`require_shift_for_pos_sales` defaults to `FALSE`**: dozens of pre-existing tests and real branch
  workflows create POS orders with no shift concept at all; hard-blocking by default would have
  broken all of them for no operational benefit. Opt-in per branch/organization via
  `PATCH /api/pos-settings`.
- **Only `source=pos` orders attribute to a shift**: delivery/callcenter orders collect asynchronously
  (driver returns, cashier confirms later) and have no physical drawer moment to attribute — see
  [`docs/SHIFT-MANAGEMENT.md`](./docs/SHIFT-MANAGEMENT.md) for the full reasoning. Real
  delivery-collection-to-shift attribution is explicitly deferred, consistent with the phase's
  "no advanced delivery" boundary.
- **Branch-day close has no lock against a concurrent order creation mid-close**: documented
  explicitly rather than hidden, in [`docs/BRANCH-DAILY-CLOSE.md`](./docs/BRANCH-DAILY-CLOSE.md).
  Building cross-entity coordination (e.g., an advisory lock shared with `routes/orders.js`) would be
  new architecture beyond this phase's explicit scope; the accepted operational mitigation is closing
  after confirming with staff, same as any manual close practice.
- **No printable/PDF report layout** — deferred, see §15.

## 17. Test Coverage

`tests/shift-management.test.js` — **38 tests**, all against a real Postgres instance (no mocks):

- Basic lifecycle (open, duplicate-open rejection, current-shift lookup, cash-sale attribution,
  zero-variance close, close-already-closed rejection, negative-amount rejection).
- The full worked numeric example from the phase spec, verbatim (2000 opening → 5000 cash + 3000
  card sales → 200 cash refund → 300 cash expense → expected 6500 → actual 6450 → shortage −50 →
  `PENDING_REVIEW` → manager acknowledge → `CLOSED`).
- Permissions & branch isolation: cashier closing a colleague's shift (403), cross-branch manager
  view/list access (403), non-admin force-close (403), force-close without reason (400), successful
  admin force-close.
- `require_shift_for_pos_sales` enforcement on/off.
- **Concurrency**: 5 parallel shift-opens for the same cashier (exactly 1 succeeds, 4 get 409); 5
  parallel closes of the same shift (exactly 1 succeeds); 5 parallel reviews of the same
  `PENDING_REVIEW` shift (exactly 1 succeeds).
- **Branch daily close**: green-by-default, active-shift blocks close, open delivery order blocks
  close, successful close after resolution, duplicate-close rejection (409), cross-branch access
  denial, history retrieval, 4 parallel closes for the same day (exactly 1 succeeds).

## 18. Full Regression Result

```
Test Suites: 24 passed, 24 total
Tests:       360 passed, 360 total   (322 pre-existing + 38 new)
Time:        ~39s
```

100% passing — zero regressions in any pre-existing suite.

## 19. Migration Safety

`db/migrations/0002_shift_management.js` follows the established idempotent pattern (`CREATE TABLE
IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`, a guarded
`pg_constraint` check before `ADD CONSTRAINT` since Postgres has no `ADD CONSTRAINT IF NOT EXISTS`).
Verified end-to-end this turn against a simulated "already deployed, pre-Phase-7E" database (the
exact same DB-state-simulation technique used to verify migration `0001` last turn): applied the
pre-7E `schema.sql` (from `git show HEAD:db/schema.sql`) to a fresh temp database with zero errors,
ran the migration runner once (both `0001` and `0002` applied cleanly), ran it a second time
(confirmed fully idempotent no-op), and verified every resulting column/constraint/index/FK via
`psql \d` against the live database. No manual `ALTER TABLE` step is required on deploy — this is
exactly the automatic-migration guarantee built in the immediately preceding turn, now proven to
extend correctly to a second real migration.

## 20. Render Staging Walkthrough

**Not independently executed this turn.** This session has no outbound network access to
render.com, and unlike the migration-system verification in the immediately preceding turn (which
was done interactively with the user relaying Render dashboard screenshots step by step), no such
live session occurred during this phase. Given the automatic migration system is now proven
end-to-end twice (locally, against a faithfully simulated pre-migration database) and Render's
`startCommand` already runs `db/ensure-schema.js` (which calls `runMigrations()`) on every deploy, the
expected outcome is that migration `0002` applies automatically on the next deploy with no manual
step — but this has not been confirmed against the real staging database in this session. **The user
should verify this on the next deploy** (check deploy logs for `تم تطبيق الترحيل: 0002_shift_management.js`,
per the pattern already established for `0001`), and can request a guided walkthrough (as was done for
the migration system) if anything looks off.

## 21. Remaining P0/P1 Gaps & Recommended Next Phase

Per `PHASE 7D — FULL OPERATIONAL GAP AUDIT.md`, four other gaps remain from the original five P0
blockers (driver/delivery management, a real KDS, VAT/tax handling, and printable
receipts/reports were all explicitly out of scope for this phase). Recommended next phase: whichever
of those the business needs most urgently for real daily operation — driver/delivery management is
the most likely candidate given it directly blocks accurate delivery-order cash collection tracking,
which this phase deliberately deferred (§16).

---

# PHASE 7E STATUS

- **Implementation**: COMPLETE
- **Tests**: 360/360 (322 pre-existing + 38 new)
- **Concurrency**: PASS (parallel shift-open, parallel shift-close, parallel review, parallel
  branch-day close all verified with real concurrent HTTP requests — exactly one winner each time)
- **Accounting**: PASS (no new journal entries for shift/day-close events; all pre-existing posted
  entries left untouched; verified via full regression of `accounting.test.js`,
  `payroll-accounting.test.js`, `balance-sheet.test.js`)
- **Cash Reconciliation**: PASS (worked numeric example from the spec reproduced exactly —
  2000 + 5000 − 200 − 300 = 6500 expected, 6450 actual → −50 shortage → PENDING_REVIEW)
- **Branch Daily Close**: PASS (RED/YELLOW/GREEN checklist hard-blocks on active shift, pending
  review, and open orders; verified with real API calls and a real browser session)
- **Branch Isolation**: PASS (cross-branch access denied on every shift/branch-day route, verified
  with real HTTP requests from a second branch's manager)
- **Render Staging**: NOT INDEPENDENTLY VERIFIED — no network access from this session; migration
  system proven locally twice and expected to auto-apply on next deploy per the existing
  `db/ensure-schema.js` mechanism; user verification on next deploy recommended (see §20)
- **Operational Completeness**: Before 64% / After ~70% (one of five original P0 blockers closed:
  shift management + cash reconciliation + branch daily close; four remain — driver/delivery
  management, KDS, VAT/tax, printable receipts)
- **Remaining P0/P1 gaps**: driver/delivery management, real KDS, VAT/tax handling, printable
  receipts/reports (all explicitly out of scope for this phase)
- **Recommended Next Phase**: Driver/Delivery Management (most directly blocks accurate delivery-
  order cash-collection tracking, which this phase deliberately deferred)

Per the phase's explicit instruction, **not** proceeding to Phase 7F automatically — stopping here
for review.
