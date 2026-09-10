# PHASE 9 — REAL RESTAURANT READINESS & COMPETITIVE GAP AUDIT

**Audit date:** 2026-09-11
**Method:** Six parallel deep-dive research passes (five code/test evidence audits by domain + one live Playwright browser simulation against a real running server and a real Postgres database) followed by manual synthesis. No application code, schema, or migration was modified during this audit.
**Codebase size at time of audit:** 50 route files, ~19,500 lines in `routes/` alone, 92 test files, 28 frontend HTML pages, 89 Jest suites / 1157 tests passing on `main`.

**Evidence legend** (used throughout): `[CODE VERIFIED file:line]` · `[TEST VERIFIED file: "test name"]` · `[BROWSER VERIFIED ...]` (from the live Playwright pass in this audit only) · `[DOCUMENT ONLY]` · `[INFERENCE — reasoning]`.

---

## 1. EXECUTIVE SUMMARY

Satamoni is a genuinely mature, unusually well-engineered restaurant ERP for its stage — not a fragile prototype. The core transaction engine (orders, inventory ledger, double-entry accounting) shows a consistent, repeated pattern across the whole codebase: a real concurrency or fraud bug was found in production/testing, root-caused, fixed with row-level locking or a server-side check, covered by a regression test, and documented inline in Arabic explaining exactly what broke and why. This pattern shows up independently in the shift engine, the inventory ledger, production/packaging orders, kitchen transfers, purchasing, and the newly-built stocktake module. The accounting core in particular is exceptional: journal entries are provably immutable once POSTED — not just by application convention but by two independent PostgreSQL triggers that reject even a raw SQL `UPDATE`/`DELETE` bypassing the application entirely, confirmed by a test that attempts exactly that attack and watches Postgres itself refuse it.

At the same time, this audit found a specific, identifiable, and genuinely serious set of gaps that must not be waved away by the size of the test suite:

1. **The PIN-approval mechanism used to gate order voids, discount overrides, and delivery-cash-variance approvals is not bound to the specific action it approves.** `verify-override-pin` returns a bare, reusable manager user ID; every consumer only re-checks "is this an active manager of the right branch," never that a PIN was actually presented for *this* request. This is demonstrably replayable — the project's own test suite reuses a manager's raw ID instead of calling the PIN endpoint. This is a real fraud-control failure, not a theoretical one.
2. **Three permission-catalog entries that an admin can grant/revoke per employee — `orders.cancel`, `orders.void.approve`, `orders.discount.approve` — have zero enforcement anywhere in the code.** An admin who revokes a manager's ability to void orders will see the change saved and audit-logged, and it will have no effect whatsoever, because the actual void endpoint checks role, not permission. This is a false sense of control over a financially sensitive action.
3. **Two independent, disconnected systems can post the same physical inventory receipt** — the formal Purchase Request → Purchase Order → Goods Receipt chain, and a separate cashier "quick cash purchase" endpoint — with no shared reference, no cross-check, and no alert if the same delivery is recorded through both.
4. **Employee termination in HR does not cascade to disable the linked login account or driver record.** A terminated employee's self-service login and driver assignment eligibility remain active indefinitely unless a second, disconnected manual step is remembered.
5. **The receipt/kitchen printer subsystem cannot actually detect a physically offline or out-of-paper printer** — a job can be marked `PRINTED` when nothing came out of the machine. This is self-documented in the project's own docs as an untested gap (no physical thermal printer has ever been used against this code), not something this audit discovered fresh, but it is worth restating plainly: **zero real hardware has ever confirmed this system prints a real receipt or kitchen ticket.**
6. The **POS screen's top toolbar is genuinely broken at tablet (820px) and phone (400px) widths** — several controls, including the branch selector for admin users, are silently clipped off-screen with no scroll affordance. This was directly observed live in this audit, not inferred.

None of these are subtle. All are fixable in bounded, well-scoped work (see the Phase 9A roadmap). None of them, on their own, indicate the system is broken at its core — the opposite is true: this is a system whose *foundations* (double-entry accounting, concurrency safety, server-side price/VAT/permission validation, combo explosion, cashier-fraud-blind shift close) are strong enough that a real branch manager, cashier, and kitchen team were able to run a complete order-to-close cycle live in this audit's browser pass without incident. What's missing is a short list of specific control gaps and one confirmed usability regression, not a rebuild.

**Overall Real Restaurant Operational Readiness: 68/100.**

**Final Verdict: CONTROLLED PILOT READY** — Satamoni can run one real branch today under direct, engaged supervision (an owner/admin who checks in daily and is aware of the specific gaps above), but is not yet safe to hand to multiple branches unsupervised, and has never been proven against real thermal-printer hardware.

### Top 10 gaps (ranked)
1. PIN-approval replay vulnerability (void/discount/delivery-cash approvals not bound to the specific action) — **P0**
2. `orders.cancel`/`orders.void.approve`/`orders.discount.approve` permissions are decorative, unenforced — **P0**
3. Dual, disconnected purchasing/inventory-posting paths (cashier quick-purchase vs. formal GRN) — **P0**
4. Employee termination doesn't cascade to disable login/driver access — **P0**
5. Printer hardware failure undetectable; zero real-hardware verification ever performed — **P0**
6. POS top toolbar broken at tablet/phone widths (branch selector unreachable at 400px) — **P1**
7. No idempotency key on stocktake commit/correction and legacy `/inventory/reconcile` — double-post risk on retry — **P1**
8. Branch daily close doesn't check unsettled driver cash before allowing close — **P1**
9. No aggregate/pattern reporting for repeated small cash-variance skimming (cashier or driver) — **P1**
10. Owner dashboard misses live operational-risk signals (cash variance, driver cash, stockouts, kitchen delays) — scattered across 5-6 screens — **P2**

### Top 5 strengths
1. Double-entry accounting core: DB-trigger-enforced immutability of POSTED entries, universal fiscal-period locking, a fully-mapped and mostly-idempotent set of 30+ posting call sites, all independently live-tested.
2. Cashier shift-close fraud control: variance is structurally hidden from the cashier's own API response (not just the UI), manager-gated debt creation, live-verified end-to-end in the browser including the exact "hidden from cashier / visible to manager" behavior.
3. Server-side integrity of the order pipeline: price, VAT, quantity, discount ceiling, and payment method are all re-validated server-side and cannot be manipulated by a tampered client request — proven by a dedicated adversarial test suite.
4. Combo/offer explosion is correct end-to-end (cart → order_items → inventory deduction → COGS → KDS → both kitchen-print paths → receipt) and was independently confirmed live in the browser, including the combo-to-component breakdown appearing correctly on the kitchen display.
5. Concurrency discipline: row-level locking (`FOR UPDATE`) applied consistently and correctly-ordered across the ledger, production, packaging, kitchen transfers, purchasing, and stocktake, each with its own regression test for the exact race it closes.

### Recommended next phase
**Phase 9A — Critical Operational Fixes** (see §16), starting with the PIN-approval binding fix and the `orders.*` permission enforcement fix, since both directly undermine the credibility of every other approval-gated control in the system. Do not proceed to multi-branch pilot until 9A is complete and a real physical thermal printer has been tested end-to-end at least once.

---

## 2. CURRENT SYSTEM MAP

Domains and their primary files, as inspected in this audit:

| Domain | Core backend | Core frontend | Status headline |
|---|---|---|---|
| POS / Cashier | `routes/orders.js`, `routes/menu.js`, `routes/combos.js` | `satamoni-pos.html`, `satamoni-callcenter.html` | Solid core, mobile layout broken, permission gap |
| KDS | `routes/kds.js`, `db/print-queue.js` | `satamoni-kds.html` | Solid query/data, no on-screen station view |
| Delivery / Drivers | `db/delivery-engine.js`, `routes/deliveries.js`, `routes/drivers.js`, `routes/driver-settlements.js` | `satamoni-dispatch.html`, `satamoni-driver-app.html` | Solid double-entry, PIN-replay + skim-detection gaps |
| Shift / Cash control | `db/shift-engine.js`, `routes/shifts.js` | `satamoni-pos.html`, `satamoni-accounting.html` | Strongest fraud control in the system, live-verified |
| Branch daily close | `routes/branch-days.js` | `satamoni-accounting.html` | Real hard block, live-verified, misses driver-cash check |
| Inventory / Stocktake | `db/inventory-ledger.js`, `routes/inventory.js`, `routes/stocktake.js` | `satamoni-items.html` | Excellent locking; legacy/duplicate endpoint risk |
| Recipes / Production / Packaging | `db/recipe-engine.js`, `routes/recipes.js`, `routes/production.js`, `routes/packaging.js` | various | Solid, well-tested |
| Purchasing (formal) | `routes/purchase-requests.js`, `purchase-orders.js`, `goods-receipts.js`, `supplier-invoices.js`, `purchase-returns.js` | various | Solid, integrated, concurrency-tested |
| Purchasing (cashier quick-entry) | `routes/purchases.js` | `satamoni-pos.html` modal | Disconnected from the formal chain — real double-count risk |
| Accounting | `db/accounting-engine.js`, `routes/accounting.js` | `satamoni-accounting.html` | Strongest domain in the system |
| Payroll / HR | `routes/payroll.js`, `routes/hr.js`, `db/employee-history.js` | `satamoni-payroll.html` | Solid aggregation; termination-cascade gap |
| CRM / Loyalty | `routes/customers.js`, `routes/customer-auth.js` | `satamoni-customers.html` | Solid merge/block; no proactive dedup |
| Reports / Dashboard | `routes/reports.js` (70+ endpoints) | `satamoni-dashboard.html`, `satamoni-reports.html` | Strong financial rollup; scattered risk signals |
| Auth / Permissions / Audit | `middleware/auth.js`, `middleware/permissions.js`, `routes/audit.js` | `satamoni-admin.html` | Mostly enforced; order-domain gap; audit log gaps |
| Printing | `routes/printers.js`, `routes/print-jobs.js`, `db/print-queue.js`, `print-agent/` | `satamoni-printing.html` | Solid queue/idempotency; hardware never confirmed |
| Infrastructure | `server.js`, `db/env-validation.js`, `db/ensure-schema.js`, `render.yaml` | — | Solid; backup unscheduled |

---

## 3. FULL RESTAURANT DAY SIMULATION

### Scenario A — Before Opening
`[INFERENCE from all domain audits, cross-checked]`. There is no single "is the branch ready to open" readiness screen. The pieces needed for one exist scattered: open-shift status (`GET /api/shifts/open-all`, admin dashboard), low stock (`/api/reports/negative-stock`), expiring batches (`/api/reports/expiring-batches`), pending purchases (purchasing reports), printer status (`routes/printers.js`), driver readiness (`routes/drivers.js`). **None of these are consolidated.** A branch manager cannot answer "are we ready to open" from one screen — they must check 5+ separate screens. **PARTIAL.**

### Scenario B — Cashier Operations
Full flow VERIFIED both by code/test evidence and live in the browser: login → shift open (denomination-count UI, not a plain number field) → takeaway order with combo → discount under threshold applied cleanly → card payment → order created → receipt reachable via a real printable popup. `[BROWSER VERIFIED]` Speed and clarity: genuinely good for a trained cashier at desktop/tablet-landscape width. Fraud protection: server-side price/VAT/quantity/payment-method/discount-ceiling validation is real and adversarially tested `[TEST VERIFIED tests/phase87-adversarial.test.js]`. Error recovery: double-submit is blocked by a synchronous disable-on-submit guard plus a DB-level idempotency key, confirmed live with **zero** duplicate orders under a forced rapid double-click `[BROWSER VERIFIED]`. **Weaknesses found**: no cart persistence on refresh (in-memory only) `[CODE VERIFIED]`; **the POS top toolbar is broken at 820px and 400px widths — several controls including the admin branch selector are clipped off-screen with no scroll** `[BROWSER VERIFIED: broken]`; the fine-grained `orders.cancel`/`orders.void.approve` permission toggles are decorative `[CODE VERIFIED]`.

### Scenario C — Offers & Combos
Traced end-to-end and independently confirmed live: a 2× combo correctly multiplies its component quantities through cart → `order_items` → inventory deduction → COGS/`cost_at_sale` → KDS board → both auto-print paths (station-split kitchen tickets) → receipt. `[CODE VERIFIED routes/orders.js multiple sites]` `[TEST VERIFIED tests/phase86-combo-resolution.test.js]` `[BROWSER VERIFIED: combo correctly broke into component items on the KDS board]`. One real gap: **no test asserts the actual `branch_inventory_stock` delta or `cost_at_sale` value after a combo sale** — only the display/JSON shape is tested at the data level; the deduction logic is correct by code reading but not proven by a data-level assertion. **VERIFIED with one unverified sub-claim.**

### Scenario D — Kitchen Operations
KDS backend query is a single non-N+1 query with `json_agg`, confirmed correct at 200-order scale by code and a dedicated N+1 test `[TEST VERIFIED tests/kds.test.js]`. Combo breakdown on-screen is clear and was directly observed live `[BROWSER VERIFIED]`. Status transitions are strictly forward-only and concurrency-safe (`FOR UPDATE`), with a genuine concurrent-PATCH race test `[TEST VERIFIED]`. **Real gap**: the on-screen board has **no per-station filtering or grouping** — every card shows every item regardless of prep station; station separation exists only on the *printed* tickets, not the digital board `[CODE VERIFIED routes/kds.js]`. For a real multi-station kitchen (pizza line vs. feteer line) at rush hour, staff cannot pull up "my station only" on screen. **PARTIAL.**

### Scenario E — Delivery Operations
Dispatch, driver assignment, COD collection, failure reasons, reschedule, return-after-dispatch, partial collection with approval gate, and double-settlement prevention are all real, code-verified, and test-verified `[CODE+TEST VERIFIED, db/delivery-engine.js]`. "How much cash does driver X hold right now" is answerable via `GET /api/driver-settlements/preview?driverId=`, correctly access-controlled — but this operational figure is **not** cross-checked against the actual ledger balance of the driver's custody account (which isn't even registered in the standard `treasuries` cash-position screen). **PARTIAL** on the ledger-reconciliation side. Refund/void of an order after the driver already collected cash is explicitly left as a manual process with **no tracking flag or report** to surface these cases to an accountant. `[CODE VERIFIED, gap confirmed]`

### Scenario F — Cashier Shift Closing
This is the strongest-evidenced scenario in the whole audit. Live-verified end-to-end: a cashier closing with a 300 EGP shortage sees **only** a generic "recorded, manager will review" message — no expected/actual/variance figures anywhere in the response their screen receives `[BROWSER VERIFIED, cross-checked against the raw network payload]`. The branch manager's review screen shows the full breakdown and a clear approve-(create real debt)-vs-acknowledge-(no consequence) choice; approving creates a real `payroll_adjustments` advance row linked to the employee, deducted from their next payroll run `[BROWSER VERIFIED, confirmed via raw API response]`. Excess cash is booked as other-revenue (4300), never credited back to the cashier `[CODE+TEST VERIFIED]`. **Real gap**: variances at or below a small threshold (20 EGP shift, 30 EGP driver settlement) auto-write off with **zero manager visibility per-instance and no aggregate report across shifts/drivers over time** — a disciplined skimmer taking slightly-under-threshold amounts every single shift is structurally invisible. `[CODE VERIFIED + INFERENCE for absence of a pattern report]`

### Scenario G — Daily Branch Closing
Live-verified as a genuine hard block, not a UI-only convenience: with a delivery order still `preparing` and a shift still `PENDING_REVIEW`, the close button is **hidden** (not just disabled), and a direct API call bypassing the UI is rejected with a structured 400 `[BROWSER VERIFIED]`. A secondary, earlier layer was also discovered live: a shift with an order still open can't even reach `PENDING_REVIEW` — it's rejected at shift-close time first (`409 OPEN_ORDERS_ON_SHIFT`) `[BROWSER VERIFIED]`. **Real gap**: the checklist does **not** check unsettled driver cash, pending cash purchases, or accounting-period imbalance — a branch can close its day while a driver is holding thousands of EGP of uncollected COD. `[CODE VERIFIED routes/branch-days.js — checklist read in full]` A secondary finding: the day-close date field defaults from UTC while the backend's actual "business day" concept is Africa/Cairo local time, which produced two separate `branch_days` rows for adjacent calendar dates in one evening of live testing `[BROWSER VERIFIED]`.

### Scenario H — Inventory Reality Test
The "100kg system, 94kg physical count" scenario is fully and correctly traceable through the newly-built stocktake module: preview (no writes) → commit (STOCK_COUNT movement + 5300/1400 or employee-advance journal entry) → correction endpoint that **never touches the original POSTED entry**, only posts a new delta entry — confirmed both by code reading and by a live browser walkthrough that entered a wrong count, corrected it, and watched the original line stay untouched while the session total recalculated correctly `[CODE VERIFIED routes/stocktake.js]` `[TEST VERIFIED 21/21 in stocktake.test.js]` `[BROWSER VERIFIED]`. **"Can Satamoni perform a complete monthly inventory count using only the ERP?" — Mostly yes for the accounting mechanics, no for count-taking ergonomics.** Missing: a blind-count mode (system quantity is shown to the counter before they enter their count, undermining the control value of an independent count) `[CODE VERIFIED]`; no dual-counter reconciliation; no session/progress tracking across a multi-hundred-item catalog (each submission is a flat array with no server-side "N of M counted" state); and the **legacy `/api/inventory/reconcile` endpoint is still live in parallel**, posting the identical STOCK_COUNT/5300 mechanics with no awareness of stocktake sessions — a real duplicate-posting risk if both are used on the same item on the same day. `[CODE VERIFIED]`

### Scenario I — Purchasing
The formal PR→PO→GRN→Invoice→Return chain is solid, integrated, and concurrency-tested (invoice-number races, over-payment races, GRN idempotency) `[CODE+TEST VERIFIED]`. **The cashier "quick purchase" path (`routes/purchases.js`) is a second, fully independent door into the same inventory and accounting tables** — same primitives (`postInventoryMovement`/`postJournalEntry`), different idempotency namespace, credits cash/bank instead of accounts-payable, creates no batch record, and has **no reference field linking it to a PO/GRN**. **Verdict: there are two parallel, non-integrated purchasing workflows, not one.** This is the single highest-value structural finding from the inventory/purchasing research pass. `[CODE VERIFIED, cross-referenced call sites in both routes/purchases.js and routes/goods-receipts.js]`

### Scenario J — Accounting Audit
The most thoroughly evidenced scenario in this audit — all 33 `postJournalEntry`/`reverseJournalEntry` call sites in the codebase were mapped and checked against the 13 required properties (no duplication, debit=credit, correct account, correct branch, correct reference, reversal behavior, audit trail). Nearly every row passes cleanly, with the accounting/payroll/HR test suites actually **executed live against Postgres** in this audit (not just read), all green: `accounting.test.js` 42/42, `vat.test.js` 14/14, `balance-sheet.test.js` 15/15, `payroll-accounting.test.js` 13/13, `hr-lifecycle.test.js` 37/37, `stocktake.test.js` 21/21, `m1-shortage-double-count.test.js` 8/8. POSTED-entry immutability is enforced at the **database trigger level**, confirmed by a test that attacks the DB directly with raw SQL and watches Postgres itself reject it — not merely an application convention. Fiscal-period locking is universal with no bypass path found. **Two real gaps**: (1) `POST /api/stocktake`, `POST /:id/lines/:lineId/correct`, `POST /api/inventory/reconcile`, and `POST /api/treasuries/:id/transfer` accept no client idempotency key and pass none to `postInventoryMovement`, so a double-click or retry can double-post these specific transaction types (unlike orders, expenses, supplier payments, and payroll, which all correctly support this); (2) **no distinct "refund" concept exists** — any refund, however small, requires voiding the entire order. `[CODE VERIFIED throughout]`

### Scenario K — Customer & CRM
Blocking (delivery-scope only, by explicit design), merge (correctly reassigns order history/addresses/loyalty in one transaction), multi-address, and loyalty earn/redeem/reversal are all real and tested `[CODE+TEST VERIFIED]`. **Gaps**: no proactive duplicate-customer detection (a second registration under a different phone is invisible until a human manually merges it), and blocking does not cover takeaway/dine-in orders under the same phone (a deliberate, documented scope limit — worth flagging, not a bug). Also found: `PATCH /api/customers/:phone` allows direct `loyaltyPoints` overwrite by branch_manager/callcenter/admin with **no audit log entry**, unlike the adjacent block/unblock/merge handlers in the same file. `[CODE VERIFIED routes/customers.js]`

### Scenario L — Management & Owner View
A genuinely strong financial dashboard exists (`GET /api/reports/dashboard` + `satamoni-dashboard.html`): revenue, orders, AOV, COGS, gross margin, branch comparison, daily trend, top items/areas, expense breakdown, live open-shifts panel. **But the "5-minute, one-screen" test fails on operational-risk signals**: cash-variance status, driver cash exposure, low-stock/expiring-batch alerts, and kitchen-delay indicators are **not** on this screen and require visiting 4-5 additional screens (shift review, driver settlements, inventory reports, KDS). `[CODE VERIFIED reports.js:346-465, satamoni-dashboard.html cross-checked against the full response shape]` **PARTIAL PASS.**

---

## 4. OPERATIONAL BLOCKERS

Things that would visibly stop or seriously impede a real branch's operations today:

1. **POS mobile/phone-width layout is unusable** — an admin cannot reach the branch selector, and several toolbar buttons are clipped, at 400px viewport width. `[BROWSER VERIFIED]`
2. **No branch-open readiness screen** — a manager cannot confirm the branch is ready to open (stock, printers, drivers, unresolved variances) from one place. `[INFERENCE, cross-domain]`
3. **Printer failures are silent** — a kitchen could go a full shift missing tickets with the system reporting everything as `PRINTED`. `[DOCUMENT ONLY docs/PRINTING-SYSTEM.md, self-admitted]`
4. **Branch daily close can proceed while a driver holds uncollected cash** — an operational and financial blind spot at end-of-day. `[CODE VERIFIED]`

## 5. BROKEN FEATURES

1. **`orders.cancel` / `orders.void.approve` / `orders.discount.approve` permission overrides** — stored, UI-confirmed, audit-logged on change, but have **zero effect** on the actual order routes, which gate by role, not permission. `[CODE VERIFIED]`
2. **Printer "printed" status** — can be `true` when nothing physically printed, due to no post-print spooler-status check. `[DOCUMENT ONLY, self-admitted in project docs]`
3. **POS top toolbar at tablet/phone widths** — non-wrapping flex row silently clips content; directly reproduced. `[BROWSER VERIFIED]`
4. **Day-close date resolution (UTC vs. Africa/Cairo)** — produced two `branch_days` rows for adjacent calendar dates during live testing, inconsistent with the deliberate Cairo-local-time handling used elsewhere in the codebase. `[BROWSER VERIFIED]`

## 6. PARTIAL FEATURES

1. Driver cash custody — answerable operationally, but not reconciled against the underlying ledger and not visible on the standard treasuries screen.
2. KDS on-screen board — correct data, no station-level filtering.
3. Owner dashboard — strong financial view, missing live operational-risk signals.
4. Stocktake — excellent accounting mechanics, weak count-taking ergonomics (no blind mode, no session tracking, no dual-counter reconciliation).
5. Branch-open readiness — the underlying data exists in scattered reports; no consolidated readiness check.
6. Payroll run recovery — a cancelled month's run can never be recreated due to an unconditional unique constraint.

## 7. MISSING FEATURES

1. Genuine multi-tender split payment (only a single `paymentMethodId` per order exists).
2. Partial/line-item refund (only full-order void).
3. Proactive duplicate-customer detection.
4. Blind stocktake counting mode and dual-counter reconciliation.
5. Automatic HR-termination → login/driver-access cascade.
6. Aggregate/pattern reporting for repeated small cash variances (skim detection).
7. Consolidated branch-open readiness screen.
8. Production backup scheduling (script exists, nothing triggers it in deployment).
9. Any online payment gateway integration (cash/card/wallet/credit are just labels on `payment_methods` — no gateway found in any domain pass).
10. Egyptian e-Invoice/e-Receipt (ETA) tax-authority integration — not found anywhere in the codebase.

---

## 8. FRAUD & HUMAN ERROR RISKS

| Attempt | Classification | Domain evidence |
|---|---|---|
| Cashier: tamper client-side price/VAT/quantity/payment method | **Blocked** | Server re-resolves everything; adversarial test suite |
| Cashier: self-approve own discount override | **Blocked** | Approver role/branch re-validated server-side |
| Cashier: fake cancellation skipping approval | **Blocked** (at the PATCH-status level) | `status='cancelled'` explicitly rejected outside `/void` |
| Cashier: replay a known manager's ID to approve future voids/discounts without a real PIN check | **Allowed — confirmed bypass** | `verify-override-pin` issues a bare reusable ID; consumers don't bind it to the action; the project's own test suite demonstrates the bypass |
| Cashier: skim a small amount every shift, under the write-off threshold, repeatedly | **Allowed, undetected as a pattern** | No aggregate variance report exists |
| Cashier: manipulate a customer's loyalty balance directly | **Allowed, unaudited** | `PATCH /customers/:phone` accepts `loyaltyPoints`, no `logAudit` call |
| Driver: under-report COD collected | **Allowed at collection time, only caught in aggregate later** | Driver self-reports with no real-time verification |
| Driver: double-settle the same cash | **Blocked** | Row-locked, concurrency-tested |
| Driver: claim a completed delivery as "failed" to delay handover | **Not audited / plausible gap** | No customer-side confirmation cross-check found |
| Driver: deliver an order not assigned to them | **Blocked** | Ownership check on every state transition |
| Any employee: double-click / duplicate order submission | **Blocked** | Disable-on-submit + DB idempotency key, live-verified with zero duplicates under a forced rapid double-click |
| Any employee: wrong branch access | **Blocked** | `assertOwnBranch` applied consistently, extensively cross-branch tested |
| Terminated employee: continue using self-service login or driver assignment | **Allowed** | No cascade from `employees.status` to `users.is_active`/`drivers.is_active` |
| Manager/admin: revoke a cashier's void/discount/cancel permission expecting enforcement | **Allowed to fail silently** | Those three permissions are unenforced in code |

---

## 9. COMPETITIVE GAP ANALYSIS

Compared conceptually against Foodics/Toast/Lightspeed/Oracle Simphony-class expectations. Only gaps judged to create real value for Satamoni are listed.

| # | Feature | Why Satamoni needs it | Scenario | Current gap | Risk | Complexity | Dependencies | Phase |
|---|---|---|---|---|---|---|---|---|
| 1 | Bound, single-use PIN-approval tokens | Every approval gate in the system (void, discount, delivery variance) currently relies on a replayable ID | A colluding cashier learns a manager's user ID once and self-approves voids indefinitely | See §5/§8 | **Critical fraud vector** | Small-Medium | `verify-override-pin`, all consumers | 9A |
| 2 | Enforce `orders.*` permission overrides | The admin UI already promises per-employee control of cancel/void/discount-approve | Owner revokes a problem cashier's void ability, expects it enforced | Decorative today | **High — false sense of control** | Small | `routes/orders.js` guards | 9A |
| 3 | Unify or cross-link the two purchasing paths | Prevents double-counting a real supplier delivery | Manager records a delivery via quick-purchase; a colleague separately runs it through formal GRN | No shared reference today | **High — inventory/AP integrity** | Medium | `routes/purchases.js`, `routes/goods-receipts.js` | 9A |
| 4 | HR-termination access cascade | Standard offboarding control in any competitor system | Terminated cashier's driver/self-service login still works | Missing entirely | **High — access control** | Small | `routes/hr.js`, `users`, `drivers` | 9A |
| 5 | Real thermal-printer hardware confirmation | No restaurant can run without proven kitchen tickets/receipts | First live shift with real printers | Never confirmed against real hardware | **Critical — self-admitted** | Medium (testing, not code) | Physical printer, print-agent | 9A |
| 6 | Responsive POS layout at tablet/phone widths | Many independent cashiers run POS on tablets, not desktops | Cashier on a 10" tablet can't reach the branch/menu controls | Confirmed broken live | **High — usability/availability** | Small | `satamoni-pos.html` CSS | 9A |
| 7 | Branch-open readiness dashboard | Every competitor system has an opening checklist | Manager wants to confirm branch is ready before doors open | Data scattered across 5+ screens | Medium | Medium | Reports endpoints (mostly exist) | 9B |
| 8 | On-screen KDS station filtering | Multi-station kitchens are standard in mid/large restaurants | Pizza station wants to see only pizza items on screen | Only printed tickets are station-routed | Medium | Small-Medium | `routes/kds.js` | 9B |
| 9 | Cash-variance / skim pattern reporting | Standard loss-prevention feature in Toast/Foodics | Regional manager wants to see which cashier/driver has the most small variances over 30 days | Missing entirely | Medium-High | Small-Medium | `payroll_adjustments`, settlement data | 9B |
| 10 | Split/multi-tender payment | Common real-world need (half cash/half card) | Customer pays part cash, part card on one bill | Missing | Medium | Medium | `routes/orders.js`, payment UI | 9B |
| 11 | Partial/line-item refund | Comping a single item without voiding the whole order | Customer complains about one item only | Missing (full void only) | Medium | Medium-Large | Accounting reversal logic | 9B |
| 12 | Blind stocktake counting + session tracking | Real internal-control expectation for inventory counts | Monthly full-catalog count with independent counters | Missing | Medium | Medium | `routes/stocktake.js` | 9B |
| 13 | Consolidated owner risk dashboard | "5-minute business health check" is table stakes | Owner wants cash/driver/stock/kitchen risk on one screen | Scattered | Medium | Small-Medium | Mostly existing report queries | 9C |
| 14 | Online payment gateway | Card-not-present / online ordering growth | Website/app customer wants to pay online, not COD | Not found anywhere | Depends on market | Large | Gateway account, PCI scope | 9D |
| 15 | Egyptian e-Invoice/e-Receipt (ETA) integration | Legal/tax compliance requirement in Egypt | Every sale must eventually be reported to ETA | Not found | **Regulatory — high** | Large | ETA API/credentials | 9D |
| 16 | Deeper Talabat/aggregator live integration | Reduce manual order entry from aggregator apps | Talabat order should auto-populate, not be hand-keyed | Only cash/order-id fields exist; no live API integration found | Medium | Large | Talabat partner API | 9D |
| 17 | Scheduled production backups + monitoring/alerting | Baseline operational resilience at scale | Data-loss incident recovery | Scripts exist, nothing schedules them; no alerting found | **High — availability** | Small (infra config) | Render Cron or equivalent | 9E |

---

## 10. USABILITY AUDIT

Scored from the live browser pass plus code/UI reading. `/10` scale, lower = worse.

| Screen | Clarity | Speed | Error Prevention | Mobile/Tablet | Training Difficulty (lower=harder, scored as ease) | Rush-Hour Readiness |
|---|---|---|---|---|---|---|
| POS (cashier) | 8 | 8 | 8 | **3** (broken toolbar at 400-820px) | 7 | 6 (dragged down by mobile issue) |
| Call Center | 7 | 7 | 8 | 6 | 7 | 7 |
| KDS | 8 | 8 | 7 | 7 (fine, horizontal-scroll pattern) | 8 | 6 (no station filter) |
| Driver app | 6 | 6 | 7 | 7 | 6 | 6 |
| Manager (shift review, daily close) | 9 | 8 | 9 | 7 | 8 | 8 |
| Accountant (journal entries, payments) | 8 | 7 | 9 | 6 | 6 | 7 |
| HR / Payroll | 7 | 7 | 7 | 6 | 6 | — |
| Inventory / Stocktake (new) | 9 | 8 | 9 | 7 | 8 | 8 |
| Purchasing (formal) | 7 | 6 | 8 | 6 | 5 | — |

**Screens that technically work but are hard to operate**: Purchasing (formal PR→PO→GRN chain is correct but has real conceptual overhead for a new employee, and now sits alongside a second, simpler cashier purchase path that isn't clearly signposted as a different thing); Driver app (functionally complete but the cash-collection/variance flow requires understanding concepts — expected vs. collected vs. handover — that aren't explained in-app).

---

## 11. TEST COVERAGE GAP MATRIX

| Workflow | Jest | Integration | Browser | Real Hardware | Status |
|---|---|---|---|---|---|
| Order create/price/VAT/discount integrity | ✅ (phase87-adversarial) | ✅ | ✅ (this audit) | — | OK |
| Order void/cancel/reversal | ✅ | ✅ | — | — | OK |
| Order edit | ✅ | — | — | — | OK |
| Combo explosion (display/JSON) | ✅ | ✅ | ✅ (this audit) | — | OK |
| Combo inventory/COGS deduction (data-level) | — | — | — | — | **GAP** |
| KDS board query/transitions | ✅ | ✅ | ✅ (this audit) | — | OK |
| KDS station filtering | — | — | — | — | **N/A — feature missing** |
| Printing queue/idempotency | ✅ | — | — | **✗ never** | **GAP — no real hardware ever** |
| Shift open/close/review, variance hiding | ✅ | ✅ | ✅ (this audit, full cycle) | — | OK |
| Branch daily close checklist | ✅ | ✅ | ✅ (this audit, live block + bypass attempt) | — | OK |
| Driver dispatch/settlement/double-settlement | ✅ | ✅ | — | — | OK |
| Delivery-after-void cash reconciliation | — | — | — | — | **GAP** |
| PIN-approval binding | — (own test bypasses it) | — | — | — | **GAP — confirmed weakness** |
| Order-domain permission overrides | — | — | — | — | **GAP — confirmed unenforced** |
| Stocktake commit/correction | ✅ (21/21) | — | ✅ (this audit) | — | OK, but idempotency gap noted |
| Legacy inventory/reconcile vs. stocktake overlap | — | — | — | — | **GAP** |
| Cashier quick-purchase vs. formal GRN overlap | — | — | — | — | **GAP** |
| Accounting core (all posting types) | ✅ (42/42 + domain suites) | ✅ | — | — | OK |
| POSTED-entry immutability (incl. raw-SQL bypass attempt) | ✅ | — | — | — | OK |
| Fiscal period lock | ✅ | ✅ (phase5-integration) | — | — | OK |
| Payroll runs (double-payment, concurrency) | ✅ | — | — | — | OK |
| Payroll re-run after cancel | — | — | — | — | **GAP — confirmed blocked scenario** |
| HR termination → access cascade | — | — | — | — | **GAP — confirmed missing** |
| Customer block/merge/loyalty | ✅ | — | — | — | OK |
| Backup/restore (incl. accounting-balance check) | ✅ | ✅ | — | — | OK (scripts), **GAP** (not scheduled) |
| Mobile/tablet POS layout | — | — | ✅ (this audit, found broken) | — | **GAP — confirmed broken** |

**Interpretation**: the 1157 Jest tests are real, mostly integration-grade (real Postgres, real concurrency scenarios), and genuinely cover the transactional core very well. They are not a substitute for the specific holes this audit found — none of the 6 confirmed P0/P1 issues above were caught by the existing suite, precisely because they are gaps in what's *checked*, not bugs in what's *tested*.

---

## 12. HARDWARE READINESS

| Item | Status |
|---|---|
| Cashier receipt printing | Queue/idempotency logic solid `[TEST VERIFIED]`; **real thermal printer never confirmed** `[DOCUMENT ONLY, self-admitted]` |
| Kitchen ticket printing (incl. combo/station split) | Same — logic solid, hardware unconfirmed |
| Multiple printers per branch | Supported in schema/routing logic; unconfirmed on real hardware |
| Printer offline detection | **Missing** — job can be falsely marked `PRINTED` |
| Print queue/duplicate prevention | Solid, DB-level idempotency + atomic claim, tested |
| POS device (desktop) | Confirmed usable live |
| POS device (tablet, 820px) | **Broken** — toolbar clipped |
| POS device (phone, 400px) | **Broken** — branch selector unreachable |
| KDS device (tablet) | Usable, horizontal-scroll pattern at narrow widths |
| Cash drawer | No direct hardware integration found in code — assumed manual, not electronically triggered |
| Barcode scanner | No integration found in any domain pass — not currently a supported input method |

---

## 13. INFRASTRUCTURE READINESS

Env validation blocks boot on missing critical vars `[CODE VERIFIED]`. `/health` genuinely checks DB reachability with a timeout, not hardcoded `[CODE VERIFIED]`. Graceful shutdown drains in-flight requests before closing the pool `[CODE VERIFIED]`. **Migrations run automatically on every boot** via `render.yaml`'s start command chaining `db/ensure-schema.js` before `server.js`, with duplicate-key races between restarting instances handled gracefully — this is stronger than initially assumed; it is not a manual-only process `[CODE VERIFIED]`. CORS defaults to deny-all cross-origin in production unless explicitly configured `[CODE VERIFIED]`. Structured JSON logging with slow-request/auth-failure/server-error classification exists `[CODE VERIFIED]`.

Backup and restore scripts are real, working, and tested against live Postgres including an accounting-balance integrity check after restore `[TEST VERIFIED tests/phase6-backup.test.js, full cycle]` — but **nothing in the deployment configuration schedules them to actually run in production**; the project's own documentation states this plainly. If the production Postgres plan lacks vendor-level point-in-time recovery, there is currently no recurring backup happening at all. `[DOCUMENT ONLY, self-admitted]`

No monitoring/alerting layer beyond structured stdout logs was found in any domain pass.

---

## 14. FINAL SCORING (honest, not inflated)

| # | Category | Score /100 |
|---|---|---|
| 1 | POS Readiness | 74 |
| 2 | Kitchen Readiness | 68 |
| 3 | Delivery Readiness | 70 |
| 4 | Cash & Shift Control | 72 |
| 5 | Inventory Readiness | 76 |
| 6 | Purchasing Readiness | 62 |
| 7 | Accounting Integrity | 88 |
| 8 | Management Visibility | 62 |
| 9 | Security | 65 |
| 10 | Infrastructure | 74 |
| 11 | Usability | 68 |
| 12 | **Real Restaurant Operational Readiness** | **68** |

Rationale for the two lowest scores: **Purchasing (62)** is dragged down entirely by the confirmed dual-path double-count risk — the formal chain alone would score in the mid-80s. **Management Visibility (62)** reflects a genuinely good financial dashboard undermined by the complete absence of live operational-risk signals on that same screen. **Security (65)** reflects strong input/price/VAT validation offset heavily by the demonstrated PIN-replay vulnerability and the decorative order-permission gap — both are the kind of finding that should weigh disproportionately in a security score because they're exploitable by an insider, not just theoretical.

---

## 15. FINAL VERDICT

# CONTROLLED PILOT READY

Satamoni can run **one real branch today under direct, engaged supervision** — an owner or admin who is aware of the specific gaps in this report, checks in daily, and treats the PIN-approval and order-permission findings as immediate priorities. It is **not yet** safe for unsupervised multi-branch operation, both because of the confirmed fraud-control gaps (PIN replay, decorative permissions, dual purchasing paths) and because **no part of this system has ever been proven against real printer hardware** — a non-negotiable prerequisite for any restaurant, of any size.

---

## 16. SATAMONI MASTER GAP ROADMAP

### PHASE 9A — Critical Operational Fixes
*Only items that can cause money loss, inventory loss, fraud, incorrect orders, kitchen mistakes, or operational shutdown.*

1. Bind PIN-approval to the specific action (single-use, short-lived, scoped token) instead of a bare reusable user ID — fixes the replay vulnerability across order void, discount override, and delivery-cash-variance approval simultaneously.
2. Wire `orders.cancel`, `orders.void.approve`, `orders.discount.approve` into real `requirePermission()` checks on the actual order routes.
3. Add a reference/cross-check between the cashier quick-purchase path and the formal PO/GRN chain to prevent the same delivery being posted twice.
4. Cascade `employees.status = terminated/resigned` to disable the linked `users.is_active` and `drivers.is_active` in the same transaction.
5. Physically test the real thermal printer(s) end-to-end at least once, and add a post-print spooler-status check so a failed print is never marked `PRINTED`.
6. Fix the POS top toolbar to wrap/scroll correctly at tablet (820px) and phone (400px) widths.
7. Add idempotency-key support to `POST /api/stocktake`, its correction endpoint, `POST /api/inventory/reconcile`, and `POST /api/treasuries/:id/transfer`.
8. Add an "unsettled driver cash" RED check to the branch daily-close checklist.
9. Fix the day-close date field to use Africa/Cairo business-day resolution consistently, matching the pattern already used elsewhere in the codebase.

### PHASE 9B — Daily Operation Improvements
1. Cart draft persistence across a browser refresh.
2. On-screen KDS station filtering, reusing the existing print-time station-routing logic.
3. Reconcile the manual KDS reprint path with the automatic station-split print path.
4. Deprecate or merge the legacy `/api/inventory/reconcile` into the stocktake module.
5. Blind stocktake counting mode, session/progress tracking, and (optionally) dual-counter reconciliation.
6. Aggregate cash-variance pattern report, per cashier and per driver, across time.
7. Audit-log shift review/close/force-close and driver-settlement review decisions.
8. Audit-log direct loyalty-point edits.
9. Multi-tender split payment support.
10. Partial/line-item refund support.
11. Fix the `payroll_runs` unique constraint to allow recreating a cancelled month.
12. A consolidated branch-open readiness checklist screen.

### PHASE 9C — Management & Dashboard
1. Extend the owner dashboard with live operational-risk signals: open cash variances, driver cash exposure, low-stock/expiring-batch alerts, kitchen-delay indicators — most of the underlying queries already exist elsewhere and just need consolidating.
2. Proactive duplicate-customer detection (fuzzy name/phone match) surfaced as a non-blocking merge prompt.
3. Driver custody ledger reconciliation report against the operational settlement-preview figure.

### PHASE 9D — External Integrations
1. Egyptian e-Invoice/e-Receipt (ETA) tax-authority integration — treat as a compliance requirement, not optional.
2. Evaluate and, if warranted, add a real online payment gateway.
3. Deepen Talabat/aggregator integration beyond the current cash/order-id fields, if order volume justifies the investment.
4. Confirm the existing WhatsApp/SMS order-confirmation feature (built in an earlier phase of this project) is still functioning correctly — it was not re-verified in this Phase 9 pass.

### PHASE 9E — Scale & Infrastructure
1. Schedule the existing, tested backup script to actually run in production (Render Cron or equivalent), with the existing restore-drill script run on a regular cadence and alerting on failure.
2. Add a monitoring/alerting layer beyond structured stdout logs.
3. Multi-branch load testing before any multi-branch rollout.
4. Formal hardware certification checklist (printers, cash drawers, barcode scanners if ever added) before any new branch goes live.

---

## 17. RECOMMENDED NEXT PHASE

**Phase 9A**, in the order listed above. Items 1, 2, and 5 (PIN binding, order-permission enforcement, real printer test) should be treated as blocking prerequisites for any pilot branch launch — they are the three findings in this audit that are both high-severity and cheap to fix, and leaving them unaddressed would mean launching a pilot with a known, demonstrated fraud vector and an unconfirmed core hardware dependency. Items 3, 4, 6-9 should follow immediately after in the same phase. Do not begin Phase 9B until 9A is complete and re-verified.
