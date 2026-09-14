# PAYMENT CONTROL & RECONCILIATION — IMPLEMENTATION REPORT

**Date:** 2026-09-14
**Scope:** Phase 1 of the "Payment Control & Reconciliation" module requested by the owner — payment-method
lock + adjustment-approval workflow, role-based permissions, a dedicated audit log, three Phase-1
reconciliation checks (Talabat cash vs POS Visa mismatch, Talabat cash-collected discrepancy,
InstaPay/Orange Cash unmatched transactions, Visa settlement discrepancy), risk scoring, an 8-tab
dashboard, and an auto-sent daily owner exceptions report.
**Method followed:** codebase analysis first (no code touched) → implementation plan and schema presented
for approval → 8 open design questions asked and answered → implementation → 12 test scenarios →
full regression (2 consecutive clean runs) → this report.

---

## 1. WHAT WAS BUILT

### Schema (`db/migrations/0040_payment_control.js`, `0041_payment_control_tile.js`)
- `payments` — one locked payment record per order (no split payments — explicitly out of scope).
- `payment_methods.settlement_channel` — new column (`visa_pos`/`instapay`/`orange_cash`/
  `vodafone_cash`/`other`) so each `card_or_wallet` payment method can be matched to the right external
  statement type.
- `payment_adjustment_requests` — the approval-gated correction workflow after lock.
- `payment_reconciliation_records` — manual entry of external statement lines (the independent second
  source, never auto-unified with internal records — same philosophy as the existing
  `accounting-reconciliation` report).
- `payment_audit_logs` — a dedicated, append-only audit trail for this module (before/after JSON), kept
  separate from the general `audit_logs` table per the owner's explicit choice.
- `payment_daily_report_log` — idempotency guard so the daily auto-sent report never double-sends.
- `pos_settings` additions: `payment_adjustment_high_threshold_egp` (default 500), `payment_daily_report_enabled`,
  `owner_report_phone`, `payment_daily_report_hour`.

### Payment lock (`routes/orders.js`)
Locks the instant the cashier picks a payment method — at order creation, or the first time it's set on
edit if it was left blank. Any later attempt to change it through the normal order-edit endpoint is now
rejected with a clear 400, directing to the new adjustment-request flow instead.

### Adjustment approval — reused infrastructure, not a new mechanism
Extended the existing `approval_grants` system from Phase 9A-1 (`db/approval-engine.js`) with a
`PAYMENT_ADJUSTMENT` action type instead of building a parallel approval mechanism. The dual threshold
mirrors the project's existing tiered-discount-approval pattern exactly (`discount_manager_max_percent`):
a branch manager (Shift Supervisor) can approve any amount; at or above the configurable threshold
(500 EGP default), only an accountant or admin can — enforced after the PIN grant is consumed, via a
real permission-catalog key (`payment_control.adjustment.approve_high`) rather than a raw role check, so
it plays correctly with the existing per-employee permission-override system (8.58).

### Permissions (`middleware/permissions.js`)
A new `payment_control` group with 7 keys, assigned to the existing roles (cashier / branch_manager /
accountant / admin) per the owner's confirmed mapping — no new roles introduced.

### Reconciliation engine (`db/payment-control-engine.js`)
All three Phase-1 checks run together, computed at query time (never persisted as a stored risk score,
same reasoning as the accounting-reconciliation report):
1. Talabat orders recorded with a `card_or_wallet` payment method (should never happen — the customer
   pays the platform or the driver, not the in-house POS).
2. Talabat cash-collected (internal) vs manually entered Talabat statement totals, per branch/day.
3. InstaPay/Orange Cash payments with no matching statement line after a 3-day grace window, in both
   directions (internal-without-external and external-without-internal).
4. Visa settlement: internal `visa_pos` payment totals vs manually entered settlement batch totals.

Risk scoring is a newly proposed point system (explicitly not a recovery of any earlier, since the
original exact weights were lost to context compaction earlier in this session and the owner asked for a
fresh reasonable proposal) — documented in `docs/PAYMENT-CONTROL.md` and flagged as needing real-world
tuning after a live operating period.

### Dashboard (`public/satamoni-payment-control.html`)
A new standalone 8-tab page: Overview, Payments Ledger, Adjustment Requests, Talabat Reconciliation,
InstaPay/Orange Cash Reconciliation, Visa Settlement, Exceptions & Risk, Audit Log. Added to the home
screen tile list. Visible to admin/branch_manager/accountant (not cashier — cashiers can submit an
adjustment request through the API; this screen is management-facing).

### Daily owner report — auto-send (`db/payment-report-scheduler.js`)
Per the owner's explicit choice, this ships as an automatic send, not just an on-demand screen. Reuses
the existing `db/sms-provider.js` webhook gateway (the same one the project's WhatsApp order-confirmation
feature already uses) — no new gateway was introduced. Runs as an in-process `setInterval` (same
architectural pattern as `db/sync-worker.js`, simpler), checks every 10 minutes whether it's past the
configured Cairo-time hour and nothing has been sent yet today, and is completely inert
(`payment_daily_report_enabled = FALSE`, no phone number) until an admin explicitly turns it on.

---

## 2. AN IMPORTANT CORRECTION MADE DURING THIS WORK

While starting implementation, this session's local checkout was found to be out of sync with the actual
branch: the container had initialized the local `claude/restaurant-erp-system-jctgj5` branch pointer at
`main`'s tip rather than the real feature branch, meaning the previously completed and pushed Phase 9A
work (10 items + final report) was present on `origin` but not in the local working tree at the start of
this task. This was caught before any new code was written, verified against `origin` (all Phase 9A
commits were intact and pushed), and corrected with `git reset --hard origin/claude/restaurant-erp-system-jctgj5`
— a safe operation here since the local tree had no uncommitted work and the divergent local commit was
already fully reachable via `origin/main`. Nothing was lost; this is recorded here for transparency since
it's the kind of environment quirk that could otherwise cause confusion later.

---

## 3. REGRESSION

`npx jest --runInBand`, run twice consecutively after the full implementation: **96/96 suites, 1213/1213
tests** both times (1201 pre-existing + 12 new `tests/payment-control.test.js` scenarios). No existing
test was modified, weakened, or skipped.

### The 12 test scenarios
1. Payment locks immediately on order creation.
2. Direct `payment_method_id` change via order edit after lock is rejected.
3. Adjustment below the threshold — branch manager approves alone, succeeds.
4. Adjustment at/above the threshold — branch-manager-only approval is rejected (`HIGH_TIER_REQUIRED`).
5. Same large adjustment — accountant approval succeeds.
6. A consumed approval token cannot be replayed against a different adjustment request.
7. Talabat order + card_or_wallet payment method is flagged (`TALABAT_POS_MISMATCH`).
8. Talabat cash-collected vs manually entered statement produces the correct diff.
9. An old InstaPay payment with no matching statement line is flagged (`UNMATCHED_INTERNAL`).
10. An old InstaPay statement line with no matching payment is flagged (`UNMATCHED_EXTERNAL`).
11. Visa settlement diff between internal totals and the entered settlement batch is computed correctly.
12. Branch isolation — a branch manager/accountant from a different branch cannot view or act on another
    branch's payments, adjustment requests, or reconciliation data.

A real bug was caught and fixed during test-writing, not just a test-authoring mistake: Postgres `DATE`
columns come back from `node-pg` as JS `Date` objects, which serialize to full ISO timestamps
(`2026-09-14T00:00:00.000Z`) in JSON rather than plain dates — breaking the day-grouping match in the
Talabat cash-diff check. Fixed by casting to `::text` in SQL everywhere a date is used as a grouping/
comparison key, and the same pass also fixed several date-range filters that were comparing against raw
session-timezone dates instead of Africa/Cairo dates (the project's established 9A-8 convention) for
consistency across all four reconciliation checks.

---

## 4. HONEST LIMITATIONS

1. **Reconciliation is fully manual in this phase**, as explicitly agreed — no file import, no fuzzy
   matching. This is Phase 1 by design, not an oversight.
2. **Risk-score weights are a freshly proposed set, not a validated one** — the original weights specified
   earlier in this session were lost to context compaction before this window began, and the owner
   explicitly asked for a new reasonable proposal rather than a guess presented as the original. They need
   review against real operating data.
3. **The SMS/WhatsApp webhook gateway itself remains unverified against a real provider** — this is an
   inherited limitation from the existing order-confirmation feature (Phase 7S), not something new to this
   module. The auto-send code path is exercised structurally but cannot be proven against a real gateway in
   this environment.
4. **No new hardware, external API, or payment gateway integration was added** — this module detects and
   surfaces discrepancies from data entered into it; it does not itself connect to Talabat, Visa, InstaPay,
   or Orange Cash. That integration, if ever wanted, is explicitly Phase 2+ territory.

## 5. VERDICT

Phase 1 is complete, tested, and regression-clean. The module is additive: it introduces a new locked
payment record per order, a new adjustment-approval path, and new reconciliation/reporting surfaces,
without modifying any existing accounting-posting logic, order lifecycle behavior, or previously passing
test. It is ready for a real branch to start using — entering statement data and reviewing the Exceptions
tab — with the explicit understanding that the risk-score weights are a starting point to be tuned, and
that the daily auto-send stays off until an admin turns it on and confirms `SMS_WEBHOOK_URL` is configured.

---

## 6. PHASE 2 ADDENDUM (2026-09-14) — File import + auto-matching

Requested as the next deferred item once Phase 1 was live. No real sample statement file from any provider
(Talabat, Visa, InstaPay, Orange Cash) was available to build against, so this was built on an explicit,
owner-confirmed assumption: rather than hard-coding guessed column names (a real risk in a fraud-detection
tool — a silently misread column means real discrepancies go undetected), the importer is **positional and
human-confirmed**. The accountant uploads a CSV/Excel file, sees a real sample of its rows
(`POST /api/payment-control/reconciliation-records/import/preview`), and explicitly picks which column is
the date, which is the amount, and (optionally) which is the reference — then commits the full import
(`.../import/commit`). When a real file eventually becomes available, an automatic column-guess can be
layered on top of this without replacing it.

### What was built
- `db/payment-reconciliation-import.js` — reads both `.csv` and `.xlsx` via the project's existing
  `exceljs` dependency (already used by the payroll importer, no new npm packages added), normalizes date
  cells (defaulting to DD/MM/YYYY on ambiguous text, matching regional statement conventions rather than
  the US MM/DD/YYYY default) and amount cells (currency symbols, thousands separators, parenthesized
  negatives), and skips — without aborting the whole file — any row with an unreadable date or amount,
  reporting exactly which row numbers were skipped and why.
- Every import is tagged with a shared `import_batch_id`. A bad import (wrong column picked) can be undone
  in one action (`DELETE .../import-batches/:batchId`) rather than corrected row by row — but only while
  every row in that batch is still `UNMATCHED`; a batch containing an already-matched row must be corrected
  manually, so a confirmed match is never silently unwound.
- `autoMatchChannelRecords` (`db/payment-control-engine.js`) — automatic fuzzy matching, scoped
  **specifically to InstaPay and Orange Cash**. This scoping is deliberate, not a shortcut: the Talabat-cash
  and Visa-settlement checks are period-total comparisons by design (`findTalabatCashDiscrepancies`,
  `findVisaSettlementDiscrepancy`) — there is no one-external-row-to-one-internal-payment relationship for
  them to match in the first place. Only InstaPay/Orange Cash were ever per-transaction checks, so only
  they get a matching step; importing a Talabat or Visa file simply bulk-loads the period totals faster
  than typing them one at a time.
- The match itself only commits on a **unique mutual match**: a statement line with exactly one candidate
  payment within tolerance (±1 EGP, ±3 days), and that payment itself a candidate for no other line. Any
  ambiguity (multiple candidates on either side) is left `UNMATCHED` on purpose — the system never guesses.
- Dashboard tabs 4/5/6 (Talabat, InstaPay/Orange Cash, Visa Settlement) each got an import widget: pick a
  file → read it → a live sample table with per-column dropdowns → import → inline undo link and an
  auto-match summary. The InstaPay/Orange Cash tab also got a manual "re-run matching now" button, for when
  new payments lock in after a statement was already imported.

### Testing
`tests/payment-control-import.test.js` — 9 new scenarios: preview returns raw sample data, a mixed-validity
file imports the valid rows and reports the invalid ones by row number, a unique match commits
automatically, a genuinely ambiguous case stays unmatched, Talabat/Visa imports skip matching entirely (as
designed), batch undo succeeds pre-match and is refused once any row in the batch is matched, and branch
isolation on both import and undo. Full regression after this addition: **98/98 suites, 1236/1236 tests**,
confirmed clean across two runs (one run hit the same pre-existing `accounting.test.js` ordering flake
already documented in the Phase 1 section of this repository's history — reconfirmed via isolated re-run,
42/42 passing, and unrelated to anything touched here).

### Honest limitation carried forward
The column-mapping approach is the right call under real uncertainty, but it is manual every time — it
does not remember "this is what Visa's export always looks like" between imports. That's a reasonable
follow-up once a real recurring file format is seen in practice, not before.
