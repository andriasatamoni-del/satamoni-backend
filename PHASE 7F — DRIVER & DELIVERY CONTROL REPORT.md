# PHASE 7F — DRIVER & DELIVERY CONTROL REPORT

## 1. Executive Summary

Phase 7F replaces the free-text `orders.driver_name` field — the second P0 blocker identified in
`PHASE 7D — FULL OPERATIONAL GAP AUDIT.md` ("no driver accounts, no COD settlement") — with a full
accountability chain: ORDER → DISPATCH → DRIVER → OUT FOR DELIVERY → DELIVERED/FAILED → CASH
COLLECTION → DRIVER SETTLEMENT → ACCOUNTING RECONCILIATION. Drivers get a genuine, narrowly-scoped
login; dispatch is a real assignment against a driver record instead of a typed name; COD collection
requires the driver to record an actual amount at delivery time; and cash the driver is holding is
tracked in its own accounting custody account until formally handed over and reconciled. No GPS,
maps, route optimization, mobile app framework, or third-party delivery integration was built —
none of that exists in the repository today and none of it was needed to close this gap.

## 2. Existing Architecture (Read Before Writing Code)

A dedicated research pass (documented in this session) read, before any code was written:
`PHASE 7D — FULL OPERATIONAL GAP AUDIT.md`'s delivery/driver section and its own recommended Phase
7F spec; the full order lifecycle in `routes/orders.js` (status/payment_status separation, the
existing `driver_name`-on-dispatch pattern, the `/void` reversal logic); `delivery_areas` and
`customers` schema; `payment_methods.kind` and the exact COD `pending_collection` logic already in
place for delivery orders; `middleware/auth.js`/`middleware/permissions.js`; the full
`db/accounting-engine.js` and the seeded chart of accounts; the `employees` HR table (Phase 4D) and
confirmed it has no FK to `users`; and Phase 7E's `db/shift-engine.js`/`routes/shifts.js` as the
concurrency and engine-module pattern to mirror. Nothing found in that pass was duplicated —
`dispatch_status`, the driver custody account, and the void extension all directly reuse existing
mechanisms rather than inventing parallel ones (see §3–§8).

## 3. Driver Model

New `drivers` table, deliberately separate from `employees` (which is Phase 4D's full HR/payroll
database, mostly login-less): `id, user_id (nullable), employee_id (nullable FK to employees),
branch_id, driver_code (auto-generated DRV-000001...), name, phone, status (AVAILABLE/BUSY/OFF_DUTY/
SUSPENDED/INACTIVE), is_active`. `employee_id` is an optional link for payroll continuity, not a
duplication of HR data.

**Driver login decision, made explicitly and documented**: yes, drivers get a real login
(`users.role='driver'`, a new value added to the existing role CHECK constraint) — but it's optional
per driver (`drivers.user_id` nullable). Full reasoning in
[`docs/DRIVER-OPERATIONS.md`](./docs/DRIVER-OPERATIONS.md#قرار-هل-السائق-محتاج-تسجيل-دخول-فعلي):
real cash accountability requires the driver's own confirmation, not a dispatcher acting on their
behalf; a driver without a login can still be assigned and tracked by a manager from the dispatch
board, which is strictly better than the old free-text field even without self-service.

## 4. Dispatch Workflow

`orders.dispatch_status` is a **new column, deliberately separate from `orders.status`** — the same
separation pattern already used for `payment_status`. This let the existing order-status state
machine (which branch-day close, accounting, and reports all depend on) go untouched while adding
finer-grained delivery tracking: `UNASSIGNED → ASSIGNED → OUT_FOR_DELIVERY → DELIVERED`, with
`FAILED` as a branch from `OUT_FOR_DELIVERY`. `orders.status` stays synchronized at the two points
that matter to existing consumers (`out_for_delivery` when the driver leaves, `completed` when
delivered). Assignment is branch-scoped both ways (order's branch must match driver's branch) and
locks the order row (`SELECT ... FOR UPDATE`) before any check, mirroring `routes/shifts.js`. Full
detail: [`docs/DELIVERY-DISPATCH.md`](./docs/DELIVERY-DISPATCH.md).

## 5. Delivery Lifecycle

Every transition (`assign`, `unassign`, `out-for-delivery`, `delivered`, `failed`, `reschedule`) is
implemented once in `db/delivery-engine.js` (the pure-logic engine module, mirroring
`db/shift-engine.js`'s split) and exposed via `routes/deliveries.js` (thin HTTP/permission/locking
layer). No arbitrary state jump is allowed — every function explicitly checks the required prior
`dispatch_status` and throws a typed error otherwise (`INVALID_DELIVERY_TRANSITION`).

## 6. COD Workflow

Confirmed existing behavior first: delivery orders already start `payment_status='pending_collection'`
regardless of payment kind (Phase 7A decision, unrelated to this phase). Phase 7F adds: at
`DELIVERED`, if the payment kind is `cash` and the order is still `pending_collection`, the driver
**must** supply `collectedAmount` — there is no bare "delivered" action for COD. The difference from
`order.total` is recorded immediately as `collection_variance` and posted as its own journal entry
(§9). Non-cash or already-collected orders complete with no amount required and no extra accounting
entry — nothing invented where the business event doesn't call for it.

## 7. Settlement Workflow

**No separate "driver shift" concept** — a deliberate, documented simplification (§9 of the task
spec: "choose the simplest model"). A driver's accountable period is simply "since their last
settlement," computed live from delivered-but-unsettled cash orders
(`dispatch_status='DELIVERED' AND driver_settlement_id IS NULL`), exactly mirroring
`computeShiftFinancials`'s live-computation philosophy. `POST /api/driver-settlements` locks the
candidate orders (`FOR UPDATE OF o`) before recomputing the batch, freezes the totals into a
`driver_settlements` row, and tags the orders so they can't be double-counted. Two-tier variance
(collection-time `cod_variance`, informational; handover-time `handover_variance`, the one that
actually gates manager review) with configurable thresholds
(`pos_settings.driver_settlement_variance_ack_threshold_egp`/`_review_threshold_egp`). Full detail
and the worked numeric example from the task spec, reproduced exactly:
[`docs/DRIVER-SETTLEMENT.md`](./docs/DRIVER-SETTLEMENT.md).

## 8. Failed Delivery Workflow

`FAILED` makes **no assumption** about whether payment was collected — `payment_status` and
`collected_amount` are untouched on failure. Two explicit, human-decided resolutions only:
**reschedule** (`FAILED → UNASSIGNED`, no reversal — the order simply wasn't sold or delivered yet)
or **return/cancel**. For the latter, rather than writing new reversal logic, `POST
/api/orders/:id/void` — the existing, already-tested inventory/loyalty/journal-reversal path — was
extended by one condition to also accept a `status='out_for_delivery' AND dispatch_status='FAILED'`
order (previously only `completed` orders were voidable). This directly satisfies the task's "do not
create duplicate inventory restoration, do not create duplicate accounting reversals" instruction:
zero new reversal code was written. Food-safety/inventory-restoration-on-return is explicitly **not**
assumed either way — documented as a business decision the branch makes manually through the
existing inventory-adjustment tools, not something the system decides automatically.

## 9. Accounting Integration

A new dynamic per-driver custody account (`1150-<driverId>`, "عهدة كاش السائق") was added, created on
demand via `getOrCreateDriverCustodyAccount` — an exact mirror of the existing
`getOrCreateBranchCashAccount` (`1100-<branchId>`) pattern. Two new journal entries, both genuinely
new business events (not corrections to the original sale entry, which stays untouched and `POSTED`
forever):

1. **At delivery** (`delivery_collection`): debits the driver's custody account for the cash
   actually collected, credits the existing receivable (`1300`) for the full order total, with any
   shortage/overage as a balancing line to `6900`/`4300` (both pre-existing, reused accounts — no new
   accounts invented beyond the one driver-custody account the task's own instruction implicitly
   requires by asking for driver cash accountability).
2. **At settlement** (`driver_settlement`): debits branch cash (`1100-<branchId>`) for the amount
   actually handed over, credits the driver's custody account for the collected total, again with any
   handover shortage/overage balanced to `6900`/`4300`.

Both entries are verified balanced (`totalDebit === totalCredit`) in `tests/driver-delivery.test.js`
against real Postgres data, not asserted in the abstract.

## 10. Permissions

| Permission | driver | branch_manager | accountant | admin |
|---|---|---|---|---|
| `deliveries.view_own` / `update_own` | ✅ (own only) | — | — | ✅ |
| `deliveries.view_branch` / `assign` | ❌ | ✅ (own branch) | view only | ✅ |
| `drivers.manage` | ❌ | ✅ (own branch) | ❌ | ✅ |
| `driver_settlements.view_own` | ✅ (own only) | — | — | ✅ |
| `driver_settlements.create` | ❌ | ✅ (own branch) | ❌ | ✅ |
| `driver_settlements.review` | ❌ | ✅ (own branch) | ✅ (own branch) | ✅ |

The `driver` role is the narrowest in the system: no accounting, inventory, payroll, other-branch, or
general-customer-directory access — verified with real HTTP requests in tests (§13), not just by
code inspection.

## 11. Security

Verified with real requests, not assumed: a driver hitting another branch's dispatch board (403), a
driver viewing another driver's order (403), a driver hitting `/api/accounting/accounts` (403), a
driver hitting `/api/inventory/stock` (403), a driver trying to review a settlement (403 — no
`driver_settlements.review` permission), and a driver trying to initiate their own settlement (403 —
no `driver_settlements.create` permission). Every delivery/settlement route re-checks branch
ownership (`assertOwnBranch`) independent of the permission check, matching the existing pattern from
Phase 7E.

## 12. Concurrency

Every critical action is lock-protected and verified with real parallel HTTP requests:

- **Assign same order to two drivers**: `SELECT ... FOR UPDATE` on the order row — exactly one of
  three parallel assign requests succeeds.
- **Mark delivered twice**: same lock — exactly one of four parallel requests succeeds; verified only
  one `delivery_collection` journal entry exists afterward.
- **Settle same driver twice**: `FOR UPDATE OF o` on the candidate orders before recomputing the
  batch — exactly one of four parallel settlement requests succeeds, the rest get `NOTHING_TO_SETTLE`
  because the winning request already tagged the orders.
- Reassignment, review, and duplicate-collection scenarios are covered the same way.

## 13. Tests

`tests/driver-delivery.test.js` — **45 tests**, all against real Postgres: driver CRUD and branch
isolation, the full delivery lifecycle (assign → out-for-delivery → delivered, with cross-branch and
wrong-driver rejection at every step), COD collection with shortage/overage and their balanced
journal entries, card-payment delivery (no collection required, no custody entry), failed delivery
with invalid-reason rejection, reschedule, the extended void/return path with real inventory and
accounting reversal verification, the dispatch board with filters and branch isolation, the driver's
own delivery view, security isolation (§11), full settlement lifecycle including the variance
threshold and review flow, and the three concurrency scenarios in §12.

**Full regression**: 405/405 passing (360 pre-existing + 45 new), confirmed clean across 4
consecutive full-suite runs after fixing two pieces of flakiness this phase's additions exposed (not
architectural bugs — see §16).

## 14. Render Staging Test

**Not independently executed this turn**, for the same reason as Phase 7E: this session has no
outbound network access to render.com. The migration (`db/migrations/0003_driver_delivery.js`) was
verified end-to-end locally using the same technique as Phases 7D/7E: applied the pre-7F `schema.sql`
(via `git show HEAD:db/schema.sql`) to a fresh temporary database, ran the migration runner once (all
three migrations `0001`–`0003` applied with zero errors), ran it a second time to confirm full
idempotency (including the `users.role` CHECK-constraint alteration, which needed special
non-standard handling since Postgres has no `ADD CONSTRAINT IF NOT EXISTS`), and verified every
resulting table/column/constraint/index against the live database via `psql \d`. The full
user-facing flow (assign → out-for-delivery → deliver with COD shortage → settle) was exercised
end-to-end in a real headless browser against a local server and Postgres instance, with zero
console errors on either the manager's dispatch-board page or the driver's own page. The expected
outcome on the real Render deploy is that migration `0003` applies automatically with no manual step,
per the same mechanism already proven twice in prior phases — but this has not been confirmed against
the actual staging database.

## 15. Operational Improvement

Before this phase: any name could be typed into a delivery order with zero validation, no way to see
which orders a given driver currently holds, no COD settlement workflow, and no failed-delivery
state at all (a driver who couldn't reach a customer left staff to either wrongly cancel the order —
losing the delivery-attempt record — or leave it stuck `out_for_delivery` forever). After this phase:
every delivery is assigned to a real, branch-scoped driver record; COD collection is recorded per
order with a visible variance; a driver's outstanding cash is tracked in its own accounting balance
until formally reconciled; and failed deliveries have an explicit, auditable resolution path.

## 16. Remaining Risks

- **Render staging not independently verified this session** — see §14; user verification on next
  deploy recommended.
- **No lock between branch-day close and mid-transit deliveries beyond what already existed** — a
  driver's `OUT_FOR_DELIVERY` order already blocks branch-day close via the existing Phase 7E
  checklist (`status IN ('preparing','out_for_delivery')`); this phase didn't need to add anything
  new here, but it's worth confirming operationally.
- **Test flakiness fixed, not architectural**: this phase's additions exposed two pre-existing test
  fragilities — a phone-number generation collision (`tests/order-edit.test.js` and this phase's new
  test both truncated `Date.now()` to the same 11-character prefix, occasionally colliding since that
  truncation only changes every ~100 seconds) and a floating-point precision assertion in
  `tests/accounting.test.js`'s global trial-balance check (`toBe` instead of `toBeCloseTo` on a
  cross-file aggregate sum). Both are now fixed (unique phone prefix `"017"`; tolerant float
  comparison) and confirmed stable across repeated runs — documented here for transparency since they
  were pre-existing weaknesses this phase's added test volume made visible, not new bugs introduced
  by the driver/delivery logic itself.
- **No printable driver/settlement report layout** — out of scope per the phase's minimal-frontend
  instruction, same deferral as Phase 7E's printable-reports gap.

## 17. Next Recommended Phase

Per `PHASE 7D — FULL OPERATIONAL GAP AUDIT.md`, the remaining P0/P1 gaps are: a real Kitchen Display
System (KDS — currently orders are tracked by status only, no dedicated multi-stage kitchen screen),
VAT/tax handling, and printable receipts/reports. With shift management (7E) and driver/delivery
control (7F) both closed, a real KDS is the most likely next priority — it directly affects kitchen
throughput visibility, which now has a fully accountable path once food leaves the kitchen (this
phase) but still no structured multi-stage tracking before that point.

---

# PHASE 7F STATUS

**Implementation**: COMPLETE

**Tests**: 405/405 (360 pre-existing + 45 new)

**Concurrency**: PASS (parallel assign, parallel delivery-collection, parallel settlement — exactly
one winner each time, verified with real concurrent HTTP requests)

**Accounting**: PASS (new driver-custody account created via the existing dynamic-account pattern;
two new journal entries per COD order — collection and settlement — both verified balanced against
real Postgres data; zero existing posted entries touched or altered)

**COD**: PASS (collection amount required for cash deliveries still pending collection; shortage/
overage recorded per order and balanced in the journal entry; the exact worked example from the task
spec reproduced: 7,500 expected / 7,400 collected / 7,400 handed over / SETTLED)

**Driver Settlement**: PASS (live-computed unsettled batch, frozen at settlement time, double-
settlement protection via row locking, two-tier variance with configurable thresholds and manager
review)

**Branch Isolation**: PASS (verified with real cross-branch HTTP requests on every driver/delivery/
settlement route — assignment, dispatch board, settlement creation, and review all reject
cross-branch access)

**Render Staging**: NOT INDEPENDENTLY VERIFIED — no network access from this session; migration
proven locally (fresh apply + idempotent re-run) and the full user flow proven in a real browser
against a local server; user verification on next deploy recommended (see §14)

**Operational Completeness Before**: ~70% (post-Phase-7E)

**Operational Completeness After**: ~78% (second of five original P0 blockers closed: shift
management + branch daily close in 7E, driver/delivery control + COD settlement in 7F; three remain)

**Remaining P0**: none outstanding from the original five that are still classified P0 after 7E+7F —
KDS and VAT/tax remain but were reclassified P1 in the 7D audit's own feature-completeness matrix

**Remaining P1**: real Kitchen Display System, VAT/tax handling, printable receipts/reports,
third-party delivery-app integration (Talabat etc. — explicitly out of scope for both 7E and 7F)

**Remaining Manual Workarounds**: drivers without a login still require a manager to record their
delivery status changes from the dispatch board (an accepted, documented tradeoff — see §3); no
printed driver/settlement report (browser print of the existing tables is available as a fallback)

**Recommended Next Phase**: Kitchen Display System (KDS) — the next-most-impactful remaining P1 gap
given shift and delivery accountability are now both closed

**Top Remaining Operational Gaps**:
1. No real Kitchen Display System — kitchen staff still work off a plain status list, not a
   dedicated multi-stage screen
2. No VAT/tax handling anywhere in the order or accounting pipeline
3. No printable receipt or report layout (browser print only)
4. No third-party delivery-app integration (Talabat etc.) — orders from these are still recorded
   manually after the fact
5. Driver login is optional, not mandatory — a branch that never issues driver logins gets the
   accountability benefit of real driver records and settlement, but not driver self-service

Per the phase's explicit instruction, **not** proceeding to Phase 7G automatically — stopping here
for review.
