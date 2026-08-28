# PHASE 8.7 — REAL-WORLD OPERATIONAL ACCEPTANCE REPORT

## 1. Executive Summary

Phase 8.7 simulated a complete Satamoni branch working day — morning open, denomination-based shift
opening, mixed-payment order-taking (cash/card/credit), a real offer/combo end-to-end, a delivery+COD
cycle with driver settlement, a cashier raw-material purchase invoice, KDS lifecycle, an order edit
before/after its cutoff, and a fraud-safe shift close+variance review — driven through the real HTTP
API against real PostgreSQL, plus a focused real-browser (Playwright) pass on payment-method
accessibility, cart clarity, and tablet/mobile usability of the cashier's five busiest screens.

One real backend bug was found and fixed: an invalid `paymentMethodId` on order creation/edit hit a
raw Postgres foreign-key violation and returned an unhandled `500` instead of a clean `400`. It has
been fixed and regression-tested on both the creation and edit paths. No money-corruption, inventory-
corruption, or security-bypass issues were found. A second, non-product issue was found and fixed:
two of this phase's own new test files generated customer phone numbers using a scheme that could
collide with an existing test file's scheme within the same ~100-second test-run window, corrupting a
shared customer's loyalty-points balance — a test-isolation bug in the new fixtures, not in the
product; it has been fixed so the full suite is deterministic (verified stable across three consecutive
full runs).

**Baseline: 596/596. Final: 643/643 (100%), stable across repeated runs.**

**Final Verdict: CONTROLLED PILOT READY** (unchanged from Phase 8.6 — this phase found no new
production-blocking issue, but did not re-establish full Phase 8F/8G/8H-style Playwright coverage of
every role/screen, which is why it does not advance to PRODUCTION CANDIDATE — see §28-30).

## 2. Baseline

```
$ npm test
Test Suites: 44 passed, 44 total   (42 pre-existing + 2 kept from Phase 8.6 already merged)
Tests:       596 passed, 596 total
```
Recorded before any code change this phase, matching the Phase 8.6 report's closing figure exactly.
Git status was clean at a committed HEAD (`697452f`, "Phase 8.6 (2/3)...") before this phase began.

## 3. Environment

- Backend: Node.js/Express, PostgreSQL, run against the project's real (non-mocked) Jest+Supertest
  harness (`tests/global-setup.js` drops/recreates `satamoni_jest_test` from `db/schema.sql` fresh
  before every `npm test` run) and, for the browser pass, a dedicated scratch database
  (`satamoni_e2e_87`) seeded by a new `tests-e2e/seed-phase87.js`, with the real server running
  against it on a private port and Chromium (Playwright) driving `public/*.html` directly.
- No physical printer, physical card terminal, or production/staging deployment was touched. Nothing
  in this phase required or performed a deploy.

## 4. Test Methodology

Per the mission's own rule, existing tests were treated as regression protection, not proof. For every
workflow area: the real implementation was inspected first (routes, engines, schema), the workflow was
executed through the real HTTP API (and, for UX-relevant items, the real browser), the resulting
database state, inventory movements, and accounting entries were inspected directly via SQL, and a
regression test was written for anything discovered. Two new Jest files
(`tests/phase87-restaurant-day.test.js`, `tests/phase87-adversarial.test.js`, 47 tests total) and one
new Playwright file (`tests-e2e/phase87-acceptance.spec.js`, 11 tests) were built for this purpose and
are now part of the permanent regression suite.

## 5. Complete Restaurant-Day Scenario

One continuous scenario (`tests/phase87-restaurant-day.test.js`), run against a single branch, single
cashier, single shift, in narrative order:

```
Manager reviews branch (empty shift list, no crash)
→ Cashier opens shift with real EGP denominations (200×5 + 100×3 + 50×2 = 1,400)
→ Cashier blocked from opening a second concurrent shift (409)
→ Cash order, card order (payment method switched before submit), credit order
→ Order with a modifier (price + inventory both include the modifier's ingredient)
→ Order with quantity ×3 (price and inventory both scale correctly)
→ Offer ×1 (resolves to real components, inventory debited by real components, not offer price)
→ Offer ×2 (components AND inventory both double correctly — not the offer price)
→ Offer + normal item mixed in one order; two offers in one order
→ KDS shows the offer's real components with correct quantities
→ Delivery order for a customer with two saved addresses — the non-default address's fields
  (not just its id) reach the created order correctly
→ Delivery order edited before dispatch (item added, total recalculated) — then a completed
  takeaway order's edit attempt is rejected (cutoff enforced, original total untouched)
→ Cashier purchase invoice (raw material only): malformed input rejected (zero/negative qty,
  negative price, unknown ingredient) with zero inventory effect; manager confirms → inventory
  increases by the exact quantity, a balanced journal entry posts; a second confirmation attempt
  is rejected and posts nothing further
→ Shift preview restricted to manager; cashier closes with an actual amount 50 EGP under
  expected — the cashier's own response contains no expected/variance figures at all
→ Manager sees the full breakdown and approves → exactly one employee debt + one balanced
  journal entry; a second approval attempt is rejected, debt count stays at 1
→ Exact-match shift (variance 0, no accounting entry) and surplus shift (+50, posted to revenue,
  no employee debt) both verified as the two remaining cash-variance cases
→ Full delivery day: order → assign → out-for-delivery → delivered (COD collected) → driver
  cash settlement, verified against the existing driver-settlement engine
→ KDS: NEW→ACCEPTED→PREPARING→READY in strict order, no disappearance; two simultaneous
  clicks on the same transition → exactly one succeeds, no duplicate log entry
```

All 33 assertions passed. Where the scenario touched money or inventory, the test asserted the
resulting database row, not just the HTTP status code.

## 6. POS Findings

- Payment-method selection, cart rendering, and combo/offer display all inherited Phase 8.6's fixes
  and were re-exercised here in a multi-order, multi-payment-method context with no regressions.
- **New finding (fixed):** an order create/edit with a `paymentMethodId` that doesn't exist in
  `payment_methods` raised an unhandled Postgres foreign-key error (`23503`) and returned `500`
  instead of a clean `400`. See §20/§25 for detail.

## 7. Payment Findings

- Cash/card/credit orders were each created, and the exact `payment_method_id` persisted was
  verified to match what was actually submitted (not a stale prior selection) — confirms Phase 8.6's
  root-cause fix (string/number coercion) holds under real multi-order use, not just single-order
  tests.
- Real-browser check (`tests-e2e/phase87-acceptance.spec.js`): the selected payment method's state is
  carried by a genuine `<input type="radio">` element (`checked`/unchecked), not merely a CSS class —
  confirmed that on every switch across all three methods, exactly one radio is `checked` and it is
  always the one inside the `.active`-styled option. This satisfies the mission's explicit "not color
  alone" requirement without any UI change being needed (the existing markup was already using a real
  native radio input; Phase 8.6 fixed the JS binding, not the markup).
- Cash-shift math was verified unaffected by card/credit orders in the same shift (only actual cash
  movements feed `expected_cash`) — implicit in the shift-variance scenario above, since the shift's
  cash orders and non-cash orders were mixed and the resulting variance matched only the cash flows.

## 8. Cart Findings

- Long item name (a 60+ character Arabic dish name, seeded specifically for this check) added to cart
  produces no horizontal page overflow (`document.documentElement.scrollWidth` measured, not just
  eyeballed).
- Multi-line, multi-offer, mixed carts were all created via the API and their `GET /:id` detail
  representation checked line-by-line — every line's item name, combo flag, and resolved components
  were distinguishable, matching Phase 8.6's cart-clarity redesign.

## 9. Offer/Combo Findings

- Full operational matrix executed: ×1, ×2, offer+normal item, two offers in one order, offer with
  quantity multiplication of a mixed cart. In every case the components resolved to the correct real
  preparation items (per §5), with quantities that multiply correctly by both the offer's own
  component count and the order line's quantity.
- Inventory consumption was verified to match the *actual resolved components* (dough+cheese for 2
  pizzas, potato for 1 fries), not the offer's flat price — i.e., COGS/inventory tracks reality, not
  the marketing bundle price.
- KDS's `components`/`isCombo` fields (Phase 8.6) were re-verified against a live order in this
  broader scenario and remain correct.
- Offer + modifier combination was not separately exercised this phase (offers in this system don't
  currently carry modifiers themselves — modifiers attach to individual menu items, and the existing
  combo schema (`combo_items` referencing a fixed `variant_id`) has no modifier association) — see §27
  (Remaining Gaps): **NOT APPLICABLE** to the current architecture, not skipped.

## 10. Shift Findings

- Denomination-based opening (real EGP note counts) and the Phase 8.6 blind-count closing UX were
  both exercised end-to-end in context of a full day with real orders feeding the expected-cash
  calculation, not an isolated shift test — expected cash matched actual order/expense/purchase flow
  exactly (§17).
- Browser pass: at both 1024px and 390px viewports, the denomination input fields and the close
  button remain visible and reachable with no page-level horizontal overflow.

## 11. Cash Variance Findings

All three cases (exact/shortage/surplus) verified this phase in one continuous run against the same
shift-engine code path validated in Phase 8.6:
- Exact: `variance = 0`, no accounting entry, no review-pending state.
- Shortage (-50): exactly one employee debt (`payroll_adjustments`, `adjustment_type='advance'`,
  linked to the correct employee via `shift.user_id`) and one balanced journal entry; a second
  approval attempt on the same shift is rejected and does not create a second debt.
- Surplus (+50): posted to the existing revenue-treatment account, no employee debt created —
  confirming the Phase 8.6 design decision (reused the driver-settlement-surplus precedent, not an
  invented new policy) still holds.

## 12. Purchase Findings

Cashier raw-material purchase-invoice workflow (Phase 8.6 feature) re-verified end-to-end with
malformed-input coverage specifically requested by this phase's mission: zero quantity, negative
quantity, negative price, and an unknown `inventoryItemId` are all rejected with `400` and zero
inventory/accounting side effects. A confirmed purchase increases inventory by the exact quantity and
posts a balanced `DR 1400 / CR 1100-{branch}` entry; a duplicate confirmation attempt is rejected
(`400`) and does not post a second time. Concurrent-confirmation coverage (5 simultaneous requests →
exactly one posting) was established in Phase 8.6 and re-confirmed still green in this phase's full
regression run — not re-duplicated here per the mission's own instruction not to manufacture
redundant tests.

## 13. Driver Findings

A full delivery cycle (assign → out-for-delivery → delivered with COD → driver cash settlement) was
run in context of the same branch/shift/day as the rest of the scenario, confirming the existing
driver-delivery engine composes correctly with same-day POS/shift/purchase activity. Dedicated edge
cases (wrong driver, cross-branch access, COD shortage/surplus, duplicate/concurrent settlement) are
already covered by `tests/driver-delivery.test.js` (pre-existing, currently 100% passing) and were not
re-duplicated — confirmed still green in the final full-suite run.

## 14. KDS Findings

NEW→ACCEPTED→PREPARING→READY progression, no order disappearance, and exactly-one-winner under two
simultaneous clicks on the same transition were all verified in the context of the full-day scenario
(not an isolated fixture). Wrong-branch access, cancelled-order lockout, and rapid/duplicate-click
protection are pre-existing `tests/kds.test.js` coverage, confirmed still green.

## 15. Printing Findings

Kitchen-ticket and receipt *digital payload* content (order number, items, quantities, variants,
modifiers, resolved offer components, VAT, discounts) is generated by `public/js/print-tickets.js`
against the same `GET /api/orders/:id` endpoint whose `combo_components` correctness was directly
re-verified this phase (§9). Direct live-browser verification of the generated printable HTML across
normal/offer/VAT/discount/delivery orders was performed in Phase 8G (`tests-e2e/phase8g-printing.spec.js`,
part of the existing suite) and was not re-run this phase (its seed fixtures were not rebuilt in this
session — see §27).

**Physical printer output: NOT VERIFIED — HARDWARE REQUIRED.** No physical printer exists in this
environment; only the digital payload has ever been verified, in this phase and in Phase 8G.

## 16. Customer/Address Findings

A customer with two saved addresses (`customer_addresses`) was created via the real API; the
call-center order flow was exercised selecting the *non-default* address, and the order's persisted
`address_details` was verified to match the selected address's field, not the default one — confirms
the address-selection UI's data path is correct end-to-end, not just that the addresses list renders.

## 17. Role/Permission Findings

No new role/permission gaps were found this phase. The adversarial pass (§20 below) specifically
re-confirmed: a cashier's `discountApprovedBy` self-approval and a wrong-branch manager's approval are
both rejected; a cashier cannot see shift-variance data (Phase 8.6, re-confirmed); the existing
branch-isolation coverage across shifts/purchases/drivers (Phase 8.6's `phase86-security-branch-
isolation.test.js`, `driver-delivery.test.js`) remained 100% green through this phase's changes.
Full role-by-role UI walkthroughs (Call Center, Kitchen, Driver, HR, Admin dashboards specifically)
were not independently re-run this phase beyond what Phase 8F already covers — see §27.

## 18. Mobile/Tablet Findings

At both 1024px (tablet) and 390px (mobile) viewports, POS, shift-close, purchase-invoice, and KDS were
each checked for: no page-level horizontal overflow, key action buttons (submit, confirm, add-item)
remaining visible without extra scrolling/zooming, and denomination/quantity input fields remaining
usable. All checks passed with the existing (unmodified) CSS — no responsive-layout fix was required
this phase.

## 19. Failure/Recovery Findings

- **Duplicate/retried order submission (same `idempotencyKey`, different body):** the server returns
  the original order's id/total (marked `duplicate: true`) and ignores the new body entirely — no
  second order row, no second inventory deduction. Verified both for a simple retry and for 5
  simultaneous requests sharing one key (exactly one order persisted).
- Expired JWT / role-changed-after-login / branch-changed-after-login were not newly exercised this
  phase (each request is independently authorized against the JWT's embedded role/branch on every
  call, per the existing `middleware/auth.js`/`middleware/permissions.js` design — there is no
  session-cache to go stale) — this is an architectural property re-confirmed by inspection, not a
  fresh test; see §27.
- Browser refresh mid-flow / network interruption were not separately simulated this phase (Phase 8H
  already covers client-side recovery for POS order submission specifically) — see §27.

## 20. Security Findings

Adversarial pass (`tests/phase87-adversarial.test.js`, 14 tests, playing a dishonest employee):

| Attempt | Result |
|---|---|
| Send fake `unitPrice`/`lineTotal`/`price` in order items | Ignored — server always recomputes from the menu's real price |
| Discount above the unapproved threshold, no approver | Rejected (400) |
| Discount approver = the cashier themself | Rejected (400) |
| Discount approver = a manager of a *different* branch | Rejected (400) |
| Client-supplied `vatAmount`/`vatRate` fields | No such input path exists — VAT is always computed server-side from `pos_settings.vat_rate`, confirmed by inspection and by a live order whose VAT the client tried to zero out |
| **`paymentMethodId` pointing at a non-existent row** | **Found a real bug — was 500, now 400 (fixed, §25)** |
| Empty order (no items), zero quantity, negative quantity | All rejected (400) |
| Skip kitchen states directly (NEW→READY) | Rejected (400); `kitchen_status` unchanged |
| Edit a completed (cutoff-passed) order with inflated quantity/discount | Rejected (400); original total untouched |
| Reuse an `idempotencyKey` with a different order body | Returns the original order only; DB has exactly one row for that key |
| 5 concurrent requests sharing one `idempotencyKey` | Exactly one order persisted |

"Manipulate customer ID" was assessed as **NOT APPLICABLE**: the system identifies customers by phone
number (free text, matched to the caller's legitimate business input), not by a client-supplied
numeric customer ID with its own authorization boundary — there is no such field to manipulate.

## 21. Accounting Reconciliation

Run against the full post-regression database (`satamoni_jest_test`, all 44 test files' combined
state) and, more meaningfully, scoped to this phase's own isolated scenario (branch id 11 only):

| Check | Full-suite result | Scoped to Phase 8.7 scenario (branch 11) |
|---|---|---|
| Every POSTED journal entry balances (Σdebit = Σcredit) | **0 violations** | **0 violations** |
| Confirmed item-purchases all posted to inventory | **0 violations** | n/a (checked in Phase 8.6, still 0 across full suite) |
| Every purchase item has exactly one inventory movement | **0 violations** | — |
| Every approved shortage has exactly one employee debt | **0 violations** | — |
| VAT: Σ`orders.vat_amount` (active orders) vs net balance of account 2300 | 4,087.50 vs 4,124.34 (≈0.9% gap) | **230.23 vs 230.23 — exact match** |

The full-suite VAT aggregate gap was investigated directly (not dismissed): it is fully explained by
`tests/accounting.test.js`, which posts manual journal entries directly to account 2300 to test the
manual chart-of-accounts feature, unrelated to any order. Re-running the same check scoped to only
this phase's own scenario (which touches no manual journal entries) shows an **exact match**,
confirming the VAT posting logic itself is correct and the aggregate figure's gap is a test-fixture
artifact, not a product defect. This is reported explicitly rather than silently dropped, per the
mission's instruction not to convert "not fully explained without scoping" into "passed" without
investigation.

## 22. Inventory Reconciliation

Every ingredient deduction in the scenario (§5) was checked against the expected quantity computed
from the recipe (`menu_item_variant_ingredients`) times the actual sold quantity, including combo
multiplication — all matched exactly (see the specific quantities asserted in §9). The cashier
purchase-invoice's inventory increase matched the confirmed quantity exactly, with zero movement
before confirmation and zero duplicate movement on a repeated confirmation attempt.

## 23. Performance Results

Hot-path timings, `curl -w '%{time_total}'`, warm connection, against the full-suite-populated
database (hundreds of pre-existing rows, not an empty table):

| Endpoint | Observed |
|---|---|
| `GET /api/shifts?branchId=` (shift dashboard) | 6–11ms |
| `GET /api/kds/orders?branchId=` (KDS poll) | 7–11ms |
| `GET /api/purchases?branchId=` (cashier purchase list) | 5–7ms |
| `GET /api/orders?branchId=` (order list) | 5–8ms |
| `POST /api/orders` (order creation — full transaction: pricing, inventory deduction, VAT, accounting) | 28–30ms steady state |

No regression flagged; all well within operational tolerance for a single-branch POS. This is a
lightweight spot-check of the specific hot paths named in the mission, not a repeat of Phase 8's full
load-test benchmark (not required unless a regression is suspected, and none was found).

## 24. Bugs Found

1. **P1 — `paymentMethodId` foreign-key violation surfaces as HTTP 500.** `POST /api/orders` and
   `PUT /api/orders/:id` inserted/updated `orders.payment_method_id` without first checking it exists
   in `payment_methods`, so an invalid id (typo, stale client cache, or deliberate probing) hit a raw
   Postgres `23503` error, caught only by the generic sanitizer as an unhelpful `500`. Not a money or
   security bug (no data was corrupted — the transaction rolled back cleanly), but a real operational
   failure mode: a real cashier client bug sending a stale payment-method id would show a confusing
   server error instead of "طريقة الدفع غير موجودة".
2. **Test-isolation flake (not a product bug).** Two new Phase 8.7 test files generated
   `customerPhone` values as `` `PREFIX${Date.now()}`.slice(0, 11) ``, which takes the *first* 8 digits
   of the 13-digit millisecond timestamp — a value that only changes roughly every 100 seconds. An
   existing file (`tests/loyalty-redemption.test.js`) used the identical scheme with an identical
   prefix (`"011"`), so within the same ~100-second full-suite run window, both files could generate
   the exact same phone number and silently share one `customers` row, corrupting the other file's
   loyalty-points assertions. This was caught by the flakiness itself (two consecutive full runs
   producing different results with no code change in between) and is a defect in this phase's own
   new test fixtures, not in the product.

## 25. Bugs Fixed

1. `routes/orders.js`: added an explicit `payment_methods` existence check (mirroring the existing
   `discountApprovedBy`/`inventoryOverrideApprovedBy` validation pattern already in the same function)
   before the `BEGIN` in `POST /`, and before the `UPDATE` in `PUT /:id` — both now return a clean
   `400 { error: "طريقة الدفع غير موجودة" }` and leave no partial/orphan row. Regression tests added
   for both the create and edit paths, including a check that no order row is left behind and that an
   in-flight order's payment method is unchanged after a rejected edit attempt.
2. `tests/phase87-restaurant-day.test.js` and `tests/phase87-adversarial.test.js`: replaced all
   `` `PREFIX${Date.now()}`.slice(0, 11) `` phone generation with a `uniquePhone(prefix)` helper that
   uses the *last* 8 digits of the timestamp (which change every millisecond) plus a per-call counter,
   eliminating the collision class entirely. Verified stable across three consecutive full `npm test`
   runs (643/643 each time) after the fix, versus intermittent failures before it.

## 26. Tests Added

- `tests/phase87-restaurant-day.test.js` — 33 tests, one continuous full-day scenario.
- `tests/phase87-adversarial.test.js` — 14 tests, dishonest-employee attack surface, including the
  `paymentMethodId` regression tests for the bug above.
- `tests-e2e/phase87-acceptance.spec.js` — 11 Playwright tests: payment-method radio-state
  accessibility, long-name cart overflow, and tablet/mobile usability across POS/shift-close/purchase-
  invoice/KDS.
- `tests-e2e/seed-phase87.js` — dedicated scratch-DB seed script for the above (separate from Phase
  8.6's, adds a long-name menu item for the overflow check).

## 27. Remaining Gaps

| Item | Status |
|---|---|
| Physical printer / physical card-terminal output | **REQUIRES HARDWARE** |
| Full Phase 8F/8G/8H-style Playwright re-sweep across every role (Call Center, Kitchen, Driver, HR, Admin dashboards specifically) | **NOT VERIFIED this phase** — those suites' original seed fixtures were not rebuilt in this session; their last confirmed-passing run was Phase 8F/8G/8H, prior to this phase's code changes (which did not touch those screens) |
| Offer + modifier combination | **NOT APPLICABLE** — current combo schema has no modifier association; there is nothing to test |
| Expired-JWT / role-changed-after-login / branch-changed-after-login | **VERIFIED by architectural inspection** (every request re-authorizes from the JWT's own claims, no session cache), not by a fresh executed test this phase |
| Browser-refresh-mid-request / network-interruption recovery for order submission | **NOT VERIFIED this phase** — last verified in Phase 8H, prior to this phase's changes, which did not touch that code path |
| Full driver-settlement edge-case matrix (wrong driver, concurrent settlement, COD shortage/surplus) | **VERIFIED** — pre-existing `tests/driver-delivery.test.js`, confirmed still 100% passing after this phase's changes, not re-duplicated |
| Load/scale performance benchmark (beyond the 5 hot-path spot checks in §23) | **NOT APPLICABLE this phase** — no regression was found to justify repeating Phase 8's full benchmark |

## 28. Operational Completeness Score

**8.5 / 10.** Every workflow named in the mission was either freshly executed end-to-end this phase or
traced to an existing, currently-passing, equivalent test with an honest note where it wasn't
re-verified. The two gaps that keep this below a higher score are the un-rebuilt Phase 8F/8G/8H
browser fixtures (role-by-role UI and physical-adjacent printing/recovery flows) and the offer+modifier
combination being architecturally absent rather than confirmed present-and-working.

## 29. Production Readiness Score

**7.5 / 10.** Money integrity, inventory integrity, accounting balance, VAT correctness (scoped),
concurrency, branch isolation, and the specific security/adversarial attack surface tested this phase
all passed cleanly, and the one real bug found was fixed and regression-tested. The score is held back
from higher by: the full-suite VAT aggregate check not being clean without scoping (explained, not a
defect, but worth a human's attention before trusting that report at face value in production), the
unverified physical printer/terminal hardware path, and the role-by-role browser walkthroughs not
being freshly re-run this phase.

## 30. Final Verdict

**CONTROLLED PILOT READY.**

Unchanged from Phase 8.6. This phase's adversarial and full-day-scenario testing found and fixed one
real (non-critical, non-security) operational bug and surfaced no money, inventory, accounting,
concurrency, or branch-isolation defects — a positive signal, but not by itself grounds to upgrade the
verdict, per the mission's explicit instruction not to raise the score merely because tests pass. The
verdict stays at CONTROLLED PILOT READY because full role-by-role browser coverage and physical
printer verification remain open, both squarely inside what "production ready" would require.

## 31. Exact Next Steps

1. Rebuild (or make persistent/scriptable) the Phase 8F/8G/8H Playwright seed fixtures so the full
   role-by-role and printing-payload suites can be re-run as part of every phase's regression, not
   just the phase that originally wrote them.
2. Verify physical printer and card-terminal output during the actual controlled pilot at a real
   branch — this cannot be done from this environment.
3. During the pilot, have an accountant/admin independently run the existing
   `GET /api/reports/accounting-reconciliation` endpoint (built in Phase 4B/8I) against real
   production data on a normal schedule, rather than relying solely on this phase's scoped Jest-level
   VAT check.
4. No further schema or architecture changes are indicated by this phase's findings — the one fix
   (payment-method validation) is complete and merged.

---

*Per the mission's explicit final instruction: this phase stops here. Phase 9 is not started.*
