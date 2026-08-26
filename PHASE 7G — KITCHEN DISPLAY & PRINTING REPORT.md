# PHASE 7G — KITCHEN DISPLAY & PRINTING REPORT

## 1. Executive Summary

Phase 7G closes the first item on the Phase 7F P1 remaining-gaps list: "no real Kitchen Display
System — kitchen staff still work off a plain status list." Unlike 7E/7F, no formal numbered spec
was provided — the user's instruction was a single line: **"شاشة مطبخ حقيقية + طباعة ايصالات
التحضير وايصالات الكاشير"** (a real kitchen display screen + printing for kitchen prep tickets and
cashier receipts). The same methodology used for 7E/7F was applied on that basis: research the
existing architecture first, then design, build, test, and document to the same standard. Delivered:
a fourth independent order-status column (`kitchen_status`) with a strict four-stage lifecycle, a
single-query dispatch board (`/api/kds/orders`), a live-refreshing KDS screen
(`satamoni-kds.html`), and a shared print module (`public/js/print-tickets.js`) that both fixes a
pre-existing race-condition bug in kitchen-ticket printing (present in three separate duplicated
copies of the same code) and adds cashier-receipt printing, which did not exist anywhere in the
system before this phase.

## 2. Existing Architecture (Read Before Writing Code)

A dedicated research pass, before any code was written, confirmed: no kitchen order-tracking screen
or `kitchen_status`-equivalent concept existed anywhere in the schema or routes; the unrelated
`/api/kitchen-orders` namespace (central-kitchen raw-material requests to branches, Phase 4A) is a
different concept entirely and was not touched; the three existing kitchen-ticket print functions in
`satamoni-pos.html`, `satamoni-delivery.html`, and `satamoni-callcenter.html` were byte-for-byte
duplicates sharing the same bug (`window.onload = () => window.print()` fires before the async order
fetch resolves, so the ticket printed the literal string "جاري التحميل..." instead of the order's
items); no cashier-receipt printing existed in any form; `order_status_log` was already a
general-purpose per-order status history table, reusable without a schema change; and no
`setInterval`-based auto-refresh pattern existed anywhere in the frontend. Nothing found in that pass
was duplicated — `kitchen_status` reuses the separate-status-column pattern from `payment_status`/
`dispatch_status`, the status log reuses the existing table, and the print fix consolidates three
copies into one shared file instead of fixing the bug three times.

## 3. `kitchen_status`: A Fourth Independent Status Column

`orders.kitchen_status` (`NEW`/`ACCEPTED`/`PREPARING`/`READY`, default `NEW`) plus
`kitchen_accepted_at`/`kitchen_ready_at` timestamps. Deliberately independent of `orders.status`,
exactly like `payment_status` and `dispatch_status` before it — but unlike `dispatch_status` (delivery
orders only), `kitchen_status` applies to **every** order type from creation, since every order is
prepared in the kitchen regardless of how it's paid or delivered. Full reasoning and worked examples:
[`docs/KITCHEN-DISPLAY.md`](./docs/KITCHEN-DISPLAY.md).

## 4. Kitchen Status Transitions — Strict, No Skipping or Reversal

`PATCH /api/orders/:id/kitchen-status` enforces `NEW → ACCEPTED → PREPARING → READY` with no skips
and no backward moves — `nextIdx` must equal `currentIdx + 1` exactly, verified with the same
`SELECT ... FOR UPDATE` row-locking pattern used for every other state-changing transition in the
system (shifts, delivery, driver settlement). A cancelled order cannot have its kitchen status
changed at all. Every transition writes to the existing `order_status_log` table with a
`kitchen_`-prefixed status string and a plain-language Arabic note, rather than a new dedicated log
table.

## 5. Kitchen Display Board

`GET /api/kds/orders?branchId=` (`routes/kds.js`, a new file deliberately named distinctly from the
pre-existing `/api/kitchen-orders`) returns every non-cancelled order for a branch with its items and
modifiers pre-aggregated via `json_agg`/`json_build_object` in a single query — no N+1 per-order
fetch, important for a board that refreshes every few seconds. `READY` orders remain visible for 30
minutes after completion for a final check before disappearing; `NEW`/`ACCEPTED`/`PREPARING` orders
have no time window and stay visible indefinitely until moved forward.

## 6. Frontend: `satamoni-kds.html`

A new four-column board (New / Accepted / Preparing / Ready) matching the existing dark-theme UI
convention (`satamoni-drivers.html`/`satamoni-dispatch.html`). Each card shows items, modifiers, a
color-coded waiting-time badge (green under 10 minutes, orange 10–20, red past 20), an "advance to
next stage" button, and a print button. This is the **first screen in the codebase to use
`setInterval` polling** (8-second auto-refresh) — a deliberate, documented departure from the
manual-refresh convention used everywhere else, because kitchen staff's hands are occupied with food
prep and the screen has to update itself. Roles allowed: `admin`, `branch_manager`, `cashier` — no
new `kitchen` role was introduced (see §8).

## 7. Printing: Shared Module + Race-Condition Fix

`public/js/print-tickets.js` (new, plain `<script>`, no bundler) replaces the three duplicated
kitchen-ticket print functions with two shared functions:

- `SatamoniPrint.printKitchenTicket(order, apiFetch, {orderTypeLabel, branchLabel})` — items,
  quantities, and modifiers only, no prices (kitchen staff don't need to see money).
- `SatamoniPrint.printCashierReceipt(order, apiFetch, {orderTypeLabel, branchLabel,
  paymentMethodLabel})` — full receipt: line items with prices, subtotal, discount, delivery fee,
  loyalty redemption, total, and payment method. This function is entirely new — no cashier-receipt
  printing existed anywhere in the system before this phase.

**The fix**: the print window still opens synchronously on the user's click (`window.open()`, to stay
clear of popup blockers), but `win.print()` is now called manually after the fetched order data is
rendered into the page — not tied to `window.onload`, which previously fired before the async fetch
resolved. Verified with a real browser: the kitchen ticket and cashier receipt both render the actual
order contents, not a stuck loading placeholder (see §11).

`satamoni-pos.html`, `satamoni-delivery.html`, and `satamoni-callcenter.html` were updated to include
the shared script and call the shared functions; each also gained a "🧾 إيصال" (receipt) button
alongside the existing kitchen-ticket button. `satamoni-delivery.html` did not previously fetch
payment methods at all — a small `state.paymentMethods` fetch was added at boot so its receipt button
can show the payment method name (falls back to "—" if unavailable, never blocks the rest of the
receipt).

## 8. Deliberate Scope Decisions

- **No new `kitchen` role.** In real branch operations the cashier is the one standing at the kitchen
  screen (or the branch manager, in small branches covering everything) — a dedicated role would have
  been complexity without a real operational need, unlike Phase 7F's `driver` role, which was
  necessary because a driver is a genuinely different person with separate cash accountability.
- **No dispatch-gating on kitchen readiness.** A delivery order can be assigned to a driver and marked
  out-for-delivery even while `kitchen_status` is still `PREPARING` — this phase does not force
  `READY` as a precondition for dispatch. That coupling may be a real future need but wasn't part of
  what was asked, and imposing it now would constrain branches operating differently for no clear
  reason.
- **No print-agent or server-side print queue.** Printing stays 100% client-side
  (`window.open()` + `window.print()` against whatever printer is attached to the employee's own
  machine), exactly as it already worked for kitchen tickets before this phase. Building distributed
  print infrastructure was out of scope for a request that asked for printing, not a print system.
- **No new "kitchen order" concept beyond the status column.** `kitchen_status` lives directly on
  `orders` — no separate `kitchen_tickets` or `prep_orders` table was introduced, since an order *is*
  the unit of kitchen work; a parallel table would have duplicated data for no benefit.

## 9. Schema & Migration

`db/migrations/0004_kitchen_display.js` — idempotent, following the established pattern: guarded
`ADD COLUMN` via `DO $$ ... EXCEPTION WHEN duplicate_column THEN NULL; END $$`, a `pg_constraint`
existence check before adding the `kitchen_status` CHECK constraint, and `IF NOT EXISTS` on the two
timestamp columns and the partial index (`idx_orders_kitchen_status`, excluding `READY` rows to keep
it small and relevant to the board's own filtering). Verified end-to-end against a simulated
pre-Phase-7G database: apply once, re-run to confirm idempotency, structure checked via `psql \d`.

## 10. Tests

`tests/kds.test.js` (23 new tests, real Postgres, no mocks): `kitchen_status` defaults to `NEW` for
every order type (dinein/takeaway/delivery) and is confirmed independent of `dispatch_status`; strict
sequential transitions (forward-only, no skip, no reverse, no re-sending the current stage, unknown
status value rejected); a cancelled order cannot have its kitchen status changed; `order_status_log`
entries are written with the correct `kitchen_`-prefixed status and note text; permissions
(`branch_manager`/`cashier`/`admin` allowed, `callcenter`/`driver` rejected with 403) and branch
isolation (cross-branch update rejected, cross-branch board view rejected, board requires a
`branchId`); a real concurrency test — two parallel `PATCH` requests for the same transition on the
same order, exactly one succeeds (200/400), and exactly one `kitchen_accepted` log entry is written;
and board-query correctness (items and modifiers returned correctly with no N+1, cancelled orders
excluded, `READY` orders visible inside the 30-minute window and hidden past it, non-`READY` orders
visible regardless of age).

One pre-existing business rule surfaced during test-writing and required adjusting two test cases
(not a bug): non-delivery orders (`takeaway`/`dinein`) are created with `status='completed'`
immediately (paid at the POS on creation — a rule that predates this phase), which is already a
terminal status, so `PATCH /:id/status → cancelled` correctly rejects them. The two tests that needed
an actually-cancellable order were changed to create `delivery`-type orders instead (which start
`status='preparing'`), rather than working around the existing rule.

## 11. Verification

Full regression: **428/428** (405 pre-existing + 23 new), run twice consecutively with 100% pass both
times. A real browser smoke test (Playwright, headless Chromium) against a local server and live
Postgres: logged in as a cashier, created a dine-in order (with a modifier) and a takeaway order,
opened `satamoni-kds.html`, confirmed both appeared under "جديد" (New), advanced the dine-in order
through Accepted → Preparing → Ready (verifying the strict one-click-per-stage flow and that the
Ready column has no further advance button), and printed both a kitchen ticket (from the KDS board)
and a cashier receipt (from `satamoni-pos.html`'s order list) — both print popups rendered the actual
order contents (items, quantities, modifiers, prices, totals), confirming the race-condition fix
holds in a real browser, not just in code review. Screenshots taken at each step confirm the RTL
four-column layout, the waiting-time badges, and both print outputs render correctly.

## 12. Files Changed

**Schema/migration**: `db/schema.sql` (kitchen_status + timestamps + partial index),
`db/migrations/0004_kitchen_display.js` (new).

**Backend**: `routes/orders.js` (kitchen-status transition endpoint), `routes/kds.js` (new — board
query), `middleware/permissions.js` (`kitchen.view`/`kitchen.advance`), `server.js` (mount
`/api/kds`).

**Frontend**: `public/js/print-tickets.js` (new — shared print module), `public/satamoni-kds.html`
(new — the KDS board), `public/satamoni-pos.html`/`satamoni-delivery.html`/
`satamoni-callcenter.html` (wired to the shared print module, added receipt button, removed the
duplicated buggy print functions), `public/index.html` (added a KDS card to the landing page).

**Tests**: `tests/kds.test.js` (new, 23 tests).

**Docs**: `docs/KITCHEN-DISPLAY.md` (new), this report.

---

# PHASE 7G STATUS

**Implementation**: COMPLETE

**Tests**: 428/428 (405 pre-existing + 23 new), stable across two consecutive full-suite runs

**Concurrency**: PASS (parallel kitchen-status transitions on the same order — exactly one winner,
verified with real concurrent HTTP requests)

**Permissions**: PASS (branch_manager/cashier/admin allowed; callcenter/driver rejected with 403,
verified against real requests)

**Branch Isolation**: PASS (cross-branch kitchen-status update and cross-branch board view both
rejected with real cross-branch HTTP requests)

**Printing**: PASS (pre-existing race-condition bug fixed and verified in a real browser — both
kitchen ticket and cashier receipt render actual order content, not a stuck loading placeholder)

**Browser Verification**: PASS (Playwright smoke test against a local server and live Postgres —
board rendering, full stage advancement, both print flows)

**Render Staging**: NOT INDEPENDENTLY VERIFIED — no network access from this session; migration
proven locally (fresh apply + idempotent re-run) and the full user flow proven in a real local
browser; user verification on next deploy recommended

**Operational Completeness Before**: ~78% (post-Phase-7F)

**Operational Completeness After**: ~82% (one of four remaining Phase-7D P1 gaps closed: real KDS +
printing; VAT/tax, printable reports beyond receipts, and third-party delivery-app integration
remain)

**Remaining P1**: VAT/tax handling anywhere in the order or accounting pipeline; printable
management/financial reports (receipts are now covered, broader report printing is not); third-party
delivery-app integration (Talabat etc.)

**Remaining Manual Workarounds**: none introduced by this phase; printing remains client-side only
(no print-agent/queue) by deliberate design, not as a gap

**Recommended Next Phase**: VAT/tax handling — the next-most-impactful remaining P1 gap now that
shift accountability (7E), delivery/driver accountability (7F), and kitchen visibility + printing
(7G) are all closed

Per the same working pattern established in 7E/7F, **not** proceeding to a next phase automatically —
stopping here and waiting for review.
