# PHASE 8.6 — REAL-WORLD OPERATIONAL CORRECTION REPORT

## Executive Summary

Six operational bugs were reported by the business owner from hands-on testing of the live staging
POS (`satamoni-staging.onrender.com/satamoni-pos.html`). All six were reproduced against real
PostgreSQL, root-caused, and fixed at the smallest correct architectural layer — reusing existing
engines (inventory ledger, accounting engine, shift engine, payroll adjustments) rather than building
parallel mechanisms. A seventh, related gap (cashier purchases were a free-text cash log with no
connection to inventory) was closed by extending the existing purchasing/GRN posting pattern, not by
inventing a new inventory pathway.

| # | Reported symptom | Status |
|---|---|---|
| 1 | Payment method selection shows no blue indicator | **Fixed** |
| 2 | Cashier shift shortage/surplus has no accounting consequence | **Fixed** |
| 3 | Cashier can see the shortage/surplus amount (fraud-control risk) | **Fixed** |
| 4 | Offer/combo items don't appear in kitchen prep | **Fixed** |
| 5 | Cart items are unclear before submission | **Fixed** |
| 6 | Cashier close-shift UX should be blind cash counting | **Fixed** |
| 7 | Cashier purchases should be a real raw-material invoice, not free text | **Fixed** |

**Test results:** Jest suite grew from 562 → **596 passing (100%)**, zero failures, zero weakened
assertions. Six new Playwright browser tests confirm every fix is real in the actual UI, not just the
API. Four live-SQL reconciliation checks (unbalanced journal entries, unposted confirmed purchases,
duplicate inventory movements, missing employee debts) all return **zero violations**.

**Final verdict: CONTROLLED PILOT READY** (see Final Verdict section for reasoning).

---

## Issue-by-Issue Results

### 1. Payment method visual-state bug

- **Symptom:** switching between Cash/Visa/Credit did not move the blue "selected" highlight.
- **Reproduction:** `state.selectedPaymentId` was set from `data.paymentMethods` as a **number**
  (JSON from the API), but `renderPayments()` compared it against `el.dataset.id`, which is always a
  **string** (DOM attributes are always strings). `p.id === state.selectedPaymentId` was therefore
  `false` on every click after the very first render — a classic JS type-coercion bug, not a CSS
  problem.
- **Root cause:** `public/satamoni-pos.html` / `public/satamoni-callcenter.html`, the click handler:
  `el.onclick = () => { state.selectedPaymentId = el.dataset.id; ... }` — stored a string thereafter,
  permanently mismatching the numeric render comparison.
- **Fix:** `state.selectedPaymentId = Number(el.dataset.id)` — coerce once at the point of state
  mutation, so state stays numeric for the lifetime of the page, matching how it's initialized.
  Applied to both `satamoni-pos.html` and `satamoni-callcenter.html`.
- **Tests:** `tests-e2e/phase86-realworld.spec.js` — cycles Cash→Visa→Credit→Visa plus 4 rounds of
  repeated switching, asserting exactly one `.pay-opt.active` element at every step and that its text
  matches the just-clicked option.
- **Browser verification:** Playwright test passed against the real rendered page (not a DOM
  snapshot) — `1 passed`.

### 2 & 3. Cashier shift variance — accounting treatment + cashier-blind counting

- **Symptom:** a shift shortage "disappeared" with no accounting consequence, and the cashier could
  see the exact expected-vs-actual gap before entering their count — a direct invitation to pocket a
  surplus or fabricate a matching "actual" figure.
- **Investigation before coding:** searched for an existing employee receivable/debt mechanism before
  adding tables. Found `payroll_adjustments` (`adjustment_type IN ('advance','penalty','bonus')`),
  already summed into `netPayCents` by `services/payroll-engine.js` on every payroll run — the
  "settlement" of a debt is simply its automatic deduction from the cashier's next paycheck. No new
  settlement-tracking system was needed. Also found the driver-cash-settlement precedent
  (`db/delivery-engine.js`'s `settleDriverCash`) already treats a positive cash variance as revenue
  (credit account `4300`) and a negative one as an expense (debit `6900`) — this became the basis for
  the shift-surplus treatment (below), instead of inventing new policy.
- **Fix (accounting):**
  - `db/accounting-engine.js`: new `getOrCreateEmployeeReceivableAccount(client, employeeId)`,
    following the exact `getOrCreateBranchCashAccount` pattern (account code `1160-{employeeId}`,
    parented under `1100`, `ON CONFLICT DO UPDATE ... RETURNING`).
  - `db/schema.sql` + `db/migrations/0013_shift_variance_employee_debt.js`: `payroll_adjustments`
    gained a `shift_id INTEGER REFERENCES pos_shifts(id)` column, giving full traceability
    Employee → Shift → Date → Branch without duplicating any cash figures (those already live on
    `pos_shifts`).
  - `db/shift-engine.js`'s `reviewShiftVariance()`: on `decision: "approve"` with a non-zero
    `cash_variance`, looks up the `employees` row linked to the shift's cashier and, inside the same
    transaction as the already-atomic `UPDATE ... WHERE status = 'PENDING_REVIEW'` guard:
    - **Shortage** → inserts a `payroll_adjustments` row (`adjustment_type = 'advance'`) **and** a
      balanced journal entry `DR 1160-{employee} (receivable) / CR 1100-{branch} (cash)`.
    - **Surplus** → posts `DR 1100-{branch} / CR 4300` (other revenue) — no debt record, matching the
      driver-settlement precedent.
    - Both use `idempotencyKey: shift-variance-debt-${shift.id}` / `shift-variance-surplus-${shift.id}`.
    - If no linked `employees` row exists, the review still succeeds and an audit log entry
      (`SHIFT_VARIANCE_DEBT_SKIPPED_NO_EMPLOYEE`) is written instead of silently losing the shortage.
  - Duplicate-prevention: the pre-existing atomic `UPDATE ... WHERE status = 'PENDING_REVIEW'`
    (from Phase 7E/7U) is the same lock that gates the new debt-creation side effect — verified under
    5 concurrent `/review` calls.
- **Fix (cashier-blind counting, server-enforced):**
  - `db/shift-engine.js`: `CASHIER_SAFE_SHIFT_FIELDS` allowlist + `sanitizeShiftForCashier(shift)` —
    an **allowlist**, not a blocklist, so any future sensitive column added to `pos_shifts` is
    excluded by default rather than accidentally leaked.
  - `routes/shifts.js`: `shapeShiftResponse(shift, user)` applies the allowlist whenever
    `user.role === "cashier"`, wired into `GET /current`, `GET /mine`, `GET /:id`, `POST /:id/close`.
  - `GET /:id/preview` (which used to let the cashier peek at the expected cash before entering an
    "actual" figure) now requires `shifts.review` — a permission the cashier role does not have — so
    the endpoint that created the original leak is now 403 for cashiers outright.
  - New cashier closing UX (`public/satamoni-pos.html`): `openCloseShiftModal()` no longer calls
    `/preview` at all. It renders one input per Egyptian denomination
    (`[200, 100, 50, 20, 10, 5, 1, 0.5, 0.25]`), computes the total client-side purely for the
    cashier's own arithmetic convenience, and submits only `{actualCash, closingNotes}` — the closing
    notes are auto-built from the non-zero counts (`"عدّ الفئات: 200×5، 100×3"`) so the count itself is
    still auditable, without ever showing an expected figure. The success message is
    `"تم تسجيل النقدية وقفل الشيفت. لو محتاج مراجعة، مدير الفرع/المحاسب هيتابعها."` — never a variance
    number.
  - This is enforced **server-side by response shaping**, not CSS: a direct `curl`/devtools inspection
    of the cashier's own `GET /api/shifts/:id` response contains no `expected_cash`, `cash_variance`,
    or `actual_cash` fields at all (verified by test assertions on `res.body.expected_cash`
    `toBeUndefined()`).
- **Tests:**
  - `tests/shift-management.test.js` — new describe block: shortage+approve creates a debt with a
    balanced journal entry and a receivable account; surplus+approve posts to `4300` with no debt;
    `acknowledge` creates neither; **5 concurrent approve requests → exactly 1 debt record**; cashier
    with no linked `employees` row → review still succeeds, audit log written, no crash.
  - Existing tests that asserted the *old* (now-intentionally-removed) cashier-visible-variance
    behavior were re-pointed to the manager's view instead of weakened — `tests/shift-management.test.js`,
    `tests/cashier-expenses-purchases.test.js`, `tests/phase7u-audit.test.js` all still verify the
    underlying money math is correct, just from the correct role's viewpoint.
  - `tests/phase86-security-branch-isolation.test.js` — cashier gets 403 on `GET /api/shifts` (list),
    `GET /:id/preview`, and `POST /:id/review`; cashier cannot view or close a peer cashier's shift in
    the same branch (IDOR).
- **Browser verification:** Playwright — opens/closes a shift through the real denomination-count
  modal, asserts the modal body text never contains "عجز" (shortage), "زيادة" (surplus), or "متوقع"
  (expected), and that no such figure leaks into the page after closing.

### 4. Manager/accountant shift-variance review screen

- Reused the existing shift lifecycle (`OPEN → PENDING_REVIEW → REVIEWED/ACKNOWLEDGED`) — no parallel
  engine was created.
- `GET /api/shifts` (list, `shifts.view_branch`/`shifts.review` only) now joins `payroll_adjustments`
  (`pa.adjustment_type = 'advance' AND pa.shift_id = ps.id`) and the reviewing user's name, giving
  manager/accountant/admin one query showing cashier, branch, opening/actual/expected cash, variance,
  reviewer, and the resulting debt in one row.
- `public/satamoni-accounting.html`: the shift-review table gained "راجعها" (reviewer), "السلفة"
  (debt/surplus indicator), and "ملاحظات" columns; `reviewShift()`'s confirm prompt now states the
  real financial consequence of "approve" before it fires, and shows the created debt amount in the
  success alert.
- **Tests:** covered by the shift-variance describe block above (debt visibility) and
  `tests/phase86-security-branch-isolation.test.js` (branch isolation on the list/review endpoints).

### 5 & 6. Offer/combo items not resolving in kitchen/printing

- **Symptom:** an order line for a combo showed as an opaque "Offer #17" everywhere downstream —
  kitchen ticket, KDS, and (structurally, since they share the same endpoint) the cashier receipt.
- **Root cause:** `orders` stores **one row per combo purchase** (`combo_id` set, `item_id`/
  `variant_id` null) — the actual components only exist in the `combo_items` catalog table. Nothing
  downstream ever joined out to them.
- **Fix — reused the exact join pattern inventory/accounting already use for stock deduction and COGS**
  (`combo_items → menu_item_variants → menu_items`), applied at exactly two points so there is one
  source of truth, not duplicated offer-resolution logic per screen:
  - `routes/orders.js`'s `GET /:id` (the endpoint `public/js/print-tickets.js` — and therefore **every**
    printing path that calls it: kitchen ticket, cashier receipt, delivery print, call-center print —
    consumes) now returns `combo_components: [{name, variant, quantity}]` per combo line, with
    `quantity` already multiplied by the line's own quantity (2 combos × "2 pizzas each" = 4).
  - `routes/kds.js`'s `GET /orders` (the KDS board's own query) returns the equivalent `components`
    field plus an `isCombo` flag per cart line.
  - `public/js/print-tickets.js`: new `comboComponentsRows(it)` renders the resolved components under
    the combo line in both the kitchen-ticket and price-bearing receipt renderers.
  - `public/satamoni-kds.html`: `renderCard(o)` renders `it.components` as an additional modifiers-style
    block per cart line, next to any real modifiers.
- **Cart clarity (issue #5, folded in here since it's the same screen):** `renderCart()` in
  `satamoni-pos.html`/`satamoni-callcenter.html` was rewritten to show, per line: a 🎁 prefix for
  combos, size/variant + unit price, modifiers, a bold line total (`price × qty`, previously entirely
  absent — the cashier had to do the multiplication in their head), and a 🗑️ remove button.
- **Tests:** `tests/phase86-combo-resolution.test.js` — a real combo (2× pizza + 1× fries) resolves to
  the correct components and quantities via `GET /:id`; the combo ordered ×2 correctly doubles the
  resolved quantities (4 pizzas, not 2); a mixed cart (normal item + combo) resolves each line
  independently; **repeated `GET /:id` reads never duplicate or drift the resolved quantity** (it's a
  pure `SELECT`, so this is structurally guaranteed, verified explicitly per the mission's
  no-duplicate-preparation-quantities requirement); `GET /api/kds/orders` returns the same resolved
  components with `isCombo: true`.
- **Browser verification:** Playwright — places a real combo order through the POS UI, opens the real
  KDS board, and asserts the board text contains the order and **does not** match the
  `/عرض\s*#\d+/` (opaque "Offer #N") pattern that was the original bug.
- **Printing paths note:** kitchen ticket, KDS, and cashier receipt were verified directly (generated
  content, not frontend-only rendering, per the mission's explicit instruction). Delivery print and
  call-center print consume the same `print-tickets.js` functions and the same `GET /:id` endpoint, so
  they inherit the fix structurally; they were not independently re-tested with a live browser in this
  pass (documented gap, not claimed as verified).

### 7. Cashier purchases — raw materials only, real invoice, no second inventory mechanism

- **Investigation before coding:** `routes/purchases.js`'s `purchases` table (from Phase 7K) was a
  lightweight, **inventory-disconnected** cash-outflow log — free-text `category`, single `amount`,
  feeding only `cash_purchases_total` in shift cash math. The formal
  `purchase_requests → purchase_orders → goods_receipts` pipeline requires a pre-approved PO and is
  too heavy for a cashier's spontaneous small cash purchase. `db/inventory-ledger.js`'s
  `postInventoryMovement` is the single authoritative stock-posting function used everywhere
  (GRN uses `movementType: "PURCHASE_RECEIPT"`); GRN's accounting pattern is `DR 1400 / CR 2100`
  (accounts payable) — for a **cash** purchase the correct analogous entry is `DR 1400 / CR 1100-
  {branchId}` (branch cash), consistent with how `purchases.amount` already fed
  `cash_purchases_total`.
- **Fix — extended the lightweight table with item lines, reused the GRN posting primitives, did not
  build a parallel inventory mechanism:**
  - `db/migrations/0014_purchase_items.js` + `db/schema.sql`: new `purchase_items` table
    (`purchase_id, inventory_item_id, quantity, unit, unit_price, line_total`), plus
    `purchases.posted_to_inventory BOOLEAN DEFAULT FALSE`.
  - `routes/purchases.js`'s `POST /` accepts an optional `items` array. When present, every
    `inventoryItemId` is validated server-side against `inventory_items WHERE item_type = 'raw'` —
    the cashier can only select an **existing raw material**, never create one, and cannot slip a
    `manufactured` item through. `amount` is **always recomputed server-side** from the item lines
    (`quantity × unitPrice` per line) — a client-supplied `amount` is silently ignored when items are
    present, closing a price-tampering path.
  - The existing status logic is untouched: cashier → `PENDING` (needs review), manager/accountant →
    `CONFIRMED` directly, preserving Phase 7K's review workflow exactly as before.
  - New `postPurchaseToInventory(client, purchase, userId, req)`: loops the purchase's item lines
    through `postInventoryMovement` (`movementType: 'PURCHASE_RECEIPT'`, `referenceType: 'purchase'`,
    `idempotencyKey: purchase-item-${item.id}`), then posts one journal entry
    `DR 1400 (inventory) / CR 1100-{branchId} (branch cash)` with
    `idempotencyKey: purchase-confirm-${purchase.id}`, and sets `posted_to_inventory = TRUE`.
  - This function is called from exactly **one authoritative posting point**: inside `POST /:id/confirm`
    (the same `SELECT ... FOR UPDATE WHERE status = 'PENDING'` transaction from Phase 7U that already
    guards against double-confirmation), or immediately inside the creation transaction when a
    manager/accountant creates a purchase that is `CONFIRMED` from the start. **A `PENDING` cashier
    draft never touches inventory** — verified explicitly by test.
  - `GET /:id` (new): returns a purchase with its item lines + resolved raw-material names, for the
    manager/accountant review screen and the cashier's own branch-scoped view.
  - Cashier frontend (`satamoni-pos.html`): the existing "مشترى" (purchase) tab in the cash-entry
    modal was rewritten into a real line-item invoice — a raw-material `<select>` sourced from
    `GET /api/inventory/items` (already cashier-accessible, filtered client-side to `item_type ===
    'raw'`), quantity + unit-price inputs, an "add" button building a running item table with a live
    total, and a submit that posts `{items: [...], notes}` — matching the mission's example invoice
    layout (raw material / quantity / unit / unit price / total).
- **Tests:** `tests/phase86-purchase-invoice.test.js` (13 tests) — item-based invoice creation
  (`PENDING`, server-computed total, client-supplied `amount` ignored); rejects a nonexistent
  `inventoryItemId`; rejects a `manufactured` item; **no inventory effect before confirmation**;
  confirmation increases stock by exactly the right quantity and posts a balanced `DR 1400 / CR
  1100-{branch}` entry; a legacy free-amount (no items) purchase still works exactly as before with no
  inventory side effect; reject never posts anything; manager/accountant direct-`CONFIRMED` creation
  posts immediately; cross-branch manager confirm → 403; cashier cannot view another branch's purchase
  detail; **5 concurrent `/confirm` requests on the same purchase → exactly 1 success, exactly 1
  inventory movement, exactly 1 journal entry** (the mission's explicit concurrency requirement for
  this feature).
- **Browser verification:** Playwright — opens the cash-entry modal, switches to the purchase tab,
  confirms the raw-material dropdown is populated from the real catalog, adds a line, confirms the
  displayed total updates (`5 × 20 = 100`), submits, and confirms the "في انتظار مراجعة" success
  message.

---

## Cash Control Model

```
Opening cash (cashier-entered at shift open)
  + Cash sales (from orders, cash-kind payment methods, this shift)
  − Cash refunds
  − Cash expenses (reviewed cashier expenses, Phase 7K)
  − Cash purchases (reviewed cashier purchases, Phase 7K, now item-aware)
  = Expected cash                                    ← computed server-side, NEVER sent to cashier
Actual cash = Σ(denomination count × face value)      ← entered by cashier, blind to expected
Variance = Actual − Expected
  Variance == 0                        → no accounting entry, shift closes REVIEWED
  Variance < 0 (shortage), on approve  → payroll_adjustments row (advance) + DR 1160-{employee} / CR 1100-{branch}
  Variance > 0 (surplus), on approve   → DR 1100-{branch} / CR 4300 (other revenue), no debt
  |Variance| within ack threshold      → manager can "acknowledge" instead of "approve": no accounting entry, closes the loop without treating it as a real shortage/surplus
Employee receivable/debt settlement    → automatic: services/payroll-engine.js deducts unsettled
                                          payroll_adjustments from the employee's next payroll run
```

Review workflow (reused, not parallel): `ACTIVE → PENDING_REVIEW (variance outside threshold) →
REVIEWED (approved, debt/surplus posted) | ACKNOWLEDGED (no accounting entry)`. Only
`Branch Manager / Accountant / Admin` (permission `shifts.review`) ever see `expected_cash`,
`actual_cash`, or `cash_variance` — enforced by `sanitizeShiftForCashier`'s allowlist at the response
layer, independent of any frontend hiding.

---

## Offer Architecture

An offer/combo is stored as **one `order_items` row** with `combo_id` set and `item_id`/`variant_id`
null — it is never expanded into N separate rows at order time. The catalog of what a combo actually
contains lives in `combo_items (combo_id, variant_id, quantity)`. Every consumer that needs the real
preparation items (kitchen ticket, KDS, cashier receipt, and by inheritance delivery/call-center
print) resolves the combo **on read**, via the identical join already used by the inventory/accounting
engines for stock deduction and COGS:

```sql
combo_items ci
  JOIN menu_item_variants cv ON cv.id = ci.variant_id
  JOIN menu_items cmi        ON cmi.id = cv.item_id
WHERE ci.combo_id = order_items.combo_id
-- component quantity = ci.quantity × order_items.quantity
```

This means the order table remains the single source of truth for *what was sold* (for revenue/COGS),
while every "what needs to be prepared/printed" question is answered by the same join, in exactly two
places (`GET /api/orders/:id` and `GET /api/kds/orders`), not duplicated per screen.

---

## Purchase Architecture

```
Cashier                          Manager/Accountant                  System (single posting point)
--------                         ------------------                  ------------------------------
select existing raw material  →                                     validates item_type='raw'
enter qty + unit price        →                                     computes amount server-side
submit                        →  purchase row: status=PENDING   →   purchase_items rows inserted
                                  (no inventory effect yet)

                                  review /:id/confirm            →   SELECT...FOR UPDATE (Phase 7U lock)
                                  (or reject → REJECTED,               status: PENDING → CONFIRMED
                                   no posting ever happens)            postInventoryMovement per item
                                                                       (movementType=PURCHASE_RECEIPT)
                                                                       postJournalEntry:
                                                                         DR 1400 (inventory)
                                                                         CR 1100-{branch} (cash)
                                                                       posted_to_inventory = TRUE
```

A manager/accountant creating a purchase directly (status `CONFIRMED` from creation, as before Phase
7K) triggers the same `postPurchaseToInventory` inside the same creation transaction — there is no
second code path that touches `inventory_movements` or `journal_entries` for purchases. Both
`postInventoryMovement` and `postJournalEntry` are idempotency-keyed
(`purchase-item-{id}` / `purchase-confirm-{purchaseId}`), and the surrounding `FOR UPDATE` transaction
means a purchase can be posted **exactly once** even under concurrent `/confirm` calls.

---

## Security Results

Verified by `tests/phase86-security-branch-isolation.test.js` (16 tests) and the shift/purchase test
files:

- **Cashier vs manager/accountant visibility:** cashier's own `GET /api/shifts/current|mine|:id` and
  `POST /:id/close` responses never contain `expected_cash`/`actual_cash`/`cash_variance` (allowlist
  enforced server-side, not CSS). `GET /api/shifts` (list, has debt data), `GET /:id/preview`, and
  `POST /:id/review` are 403 for `cashier` at the permission-middleware level.
- **Cashier cannot approve own shortage resolution:** `shifts.review` is not in the cashier's
  permission set — verified directly.
- **Cashier cannot manipulate expected cash:** expected cash is computed entirely server-side from
  sales/expenses/purchases; the cashier only ever submits `actualCash` (a denomination count) and
  `closingNotes`.
- **Cashier cannot submit arbitrary inventory items:** `POST /api/purchases` with a nonexistent
  `inventoryItemId` or a `manufactured`-type item → `400`.
- **Cashier cannot change another branch's purchase or shift:** cross-branch `GET`/`confirm`/`close`
  attempts → `403`; a cashier attempting to force `branchId` to another branch on purchase creation is
  silently overridden server-side to their own branch.
- **IDOR:** a cashier cannot view or close a peer cashier's shift within the *same* branch (`GET
  /:id`, `POST /:id/close` on another user's shift → `403`).
- **Malformed IDs:** `routes/purchases.js` and `routes/shifts.js` did not have the Phase 8B
  `validateIdParam` guard wired in — a non-numeric `:id` fell through to a raw Postgres `invalid input
  syntax` error (caught by the global error sanitizer, so nothing sensitive leaked, but it surfaced as
  a `500` instead of a clean `400`). Wired `router.param("id", validateIdParam)` into both routers
  (same pattern `routes/orders.js` already uses) — verified `400` on `not-a-number` across every
  `:id`-bearing route in both files, and that a well-formed-but-nonexistent numeric ID still correctly
  returns `404`.
- **JWT role manipulation / rate limiting / error sanitization:** unaffected by this phase's changes;
  their existing Phase 6B test coverage remains green in the full 596-test run.

## Migration Results

- `db/migrations/0013_shift_variance_employee_debt.js` (from part 1 of this phase) and
  `db/migrations/0014_purchase_items.js` (this part) both follow the project's idempotent pattern
  (`ALTER TABLE ... EXCEPTION WHEN duplicate_column THEN NULL`, `CREATE TABLE/INDEX IF NOT EXISTS`).
- **Fresh DB:** `db/schema.sql` was applied to a scratch database from scratch (the full Jest suite
  does this on every run via `tests/global-setup.js`) — `purchase_items` is now defined in the correct
  dependency order (after `inventory_items`, which it foreign-keys to; it was initially placed before
  `inventory_items` in the file and had to be moved — caught and fixed before merge, not discovered in
  production).
- **Existing Phase 8 DB:** applied the previously-committed (pre-8.6) `schema.sql` to a scratch
  database to simulate an existing production-shaped DB, then ran `db/migrate.js` — all 14 migrations
  (0001–0014) applied cleanly, confirmed `purchase_items` and `purchases.posted_to_inventory` exist
  with the correct structure afterward.
- **Idempotency:** ran `db/migrate.js` a second time against the same now-migrated database — zero
  output, zero errors (every migration already recorded in `schema_migrations`).
- No production data was touched; all migration verification ran against disposable scratch databases
  created and dropped for this purpose only.

## Test Results

| Metric | Before Phase 8.6 (part 1) | After Phase 8.6 (complete) |
|---|---|---|
| Jest test files | — | 42 |
| Jest tests | 556 | **596** |
| Jest status | — | **596/596 passing (100%)** |
| New tests this part (purchase invoice) | — | 13 |
| New tests this part (security/branch isolation) | — | 16 |
| New tests this part (combo resolution) | — | 5 |
| New tests part 1 (shift variance, payment fix, etc.) | — | ~34 |
| Playwright (Phase 8.6-specific) | 0 | **6/6 passing** |
| Concurrency tests (this phase) | 0 | 2 (5× concurrent purchase-confirm; 5× concurrent shift-review — both settle to exactly 1 winner) |
| Reconciliation checks (live SQL) | — | **4/4 zero violations** (unbalanced journal entries; confirmed-but-unposted item purchases; purchase items with ≠1 inventory movement; approved shortages with ≠1 employee debt) |

No existing test was weakened or deleted. Tests that asserted the now-intentionally-removed
cashier-visible-variance behavior were re-pointed to assert the same underlying money math from the
manager's authorized viewpoint instead.

**Known gap:** the pre-existing Phase 8F/8G/8H Playwright regression suites (`tests-e2e/phase8f-
regression.spec.js` and siblings) require a differently-seeded database (drivers, HR employees, etc.)
that was built ephemerally in an earlier session and is not committed as reusable tooling in this
repo. They were **not** re-run in this pass; only the new Phase-8.6-scoped Playwright spec was built
and run. The full Jest suite (which does cover every prior phase's backend logic, including this
phase's frontend-triggering endpoints) is the regression guarantee that was actually re-verified
end-to-end at 100%.

---

## Final Verdict: CONTROLLED PILOT READY

**Why not PRODUCTION READY:** the Playwright coverage added this phase is deliberately narrow (six
targeted scenarios proving each reported bug is actually fixed in the browser, not a general
regression sweep), and the delivery-print/call-center-print inheritance of the combo-resolution fix
was verified by code inspection (same shared function, same endpoint) rather than by an independent
live-browser check on those two specific screens. Both are reasonable, bounded gaps for a fix-focused
phase, but they mean "every screen, every role, browser-verified" has not been re-established as
comprehensively as the Phase 8F/8G/8H baseline once was.

**Why not NOT READY:** every reported bug was reproduced against real Postgres, root-caused (not
papered over), fixed at the correct architectural layer reusing existing engines, and covered by both
API-level (Jest) and real-browser (Playwright) tests. The two features with real money/inventory
consequences — shift-variance employee debt and cashier purchase-invoice posting — both have explicit
concurrency tests proving no double-posting, and four independent live-SQL reconciliation queries
confirm the resulting ledger, inventory, and debt data are internally consistent with zero violations.
Security boundaries (cashier-blind variance, branch isolation, IDOR, malformed-ID handling) were
tested adversarially, not assumed.

**Recommendation:** deploy to a controlled pilot (one or two branches, close management attention on
the first several shift closes and cashier purchase invoices), and use that pilot to close the two
gaps above (a full Phase 8F/8G/8H-style Playwright re-sweep, and a direct live check of
delivery/call-center print output for a combo order) before declaring full production readiness.

---

*Per the mission's explicit final instruction: this phase stops here. Phase 9 is not started.*
