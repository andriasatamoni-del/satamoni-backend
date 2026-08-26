# PHASE 7K — CASHIER EXPENSES & PURCHASES REPORT

## 1. Executive Summary

The user asked to add expense and purchase links to the cashier screen, because in real operation
cash sometimes leaves the register mid-shift for small day-to-day expenses and purchases (buying ice,
paying a supplier in cash, etc.), and until now that could only be recorded by an admin, accountant,
or branch manager from `satamoni-accounting.html` — the cashier had no access at all, not even to view.

Before writing code, research established the exact shape of the existing `expenses`/`purchases`
systems and their relationship to shift cash reconciliation, then three design questions were put to
the user:

1. **Should cashier entries need manager PIN authorization** (like the existing discount/void flow)?
   The user's answer, in their own words: the cashier can record freely without a PIN, but has no
   permission to "issue" the entry — that authority (review before it counts) stays with the branch
   manager or accountant. This maps directly onto `expenses.js`'s pre-existing but previously-unused
   `DRAFT → SUBMITTED → APPROVED → POSTED` workflow, and required building an equivalent status
   workflow for `purchases` (which had none at all before this phase).
2. **Should cash purchases feed into shift-close cash reconciliation?** Purchases were completely
   absent from that calculation before this phase (only expenses were, and only when tagged with a
   cash payment method). The user confirmed: yes, add it, or the expected-cash figure will be wrong.
3. **Should the cashier be locked to today/their own branch?** Confirmed yes — no date or branch
   picker at all; the server forces both regardless of what the client sends.

## 2. What Already Existed vs. What Was Built

- `expenses.js` already had a full `DRAFT/SUBMITTED/APPROVED/POSTED/CANCELLED` lifecycle with
  `/approve` and `/post` endpoints gated by `accounting.approve`/`accounting.post` (accountant-only).
  This phase did **not** touch that lifecycle — it added a new, narrower `/:id/review` endpoint
  (`SUBMITTED → POSTED` in one step, approve+post combined) gated by a new `expenses.review`
  permission granted to *both* branch_manager and accountant, specifically for reviewing cashier
  entries, so the existing accountant-only two-step flow stays exactly as it was for its own callers.
- `purchases.js` was a completely flat table with no status, no review workflow, and no accounting
  posting at all. This phase added `status` (`PENDING`/`CONFIRMED`/`REJECTED`), `created_by`,
  `created_at`, `reviewed_by`, `reviewed_at`, `rejection_reason`, plus `/:id/confirm` and
  `/:id/reject` endpoints. Direct manager/accountant/admin purchase entry (the pre-existing form in
  `satamoni-accounting.html`) is unchanged — it still creates `CONFIRMED` purchases immediately.
- `expenses` was missing a `created_at` column entirely (only `posted_at`, which stayed `NULL` until
  posting) — a real pre-existing gap, not something this phase introduced, but one that had to be
  fixed to make shift-cash math correct for not-yet-posted cashier expenses.

## 3. The Core Design Problem: Cash Leaves the Drawer Before Anyone Reviews It

A cashier's expense/purchase is created in a pending state (`SUBMITTED`/`PENDING`) — but the cash
physically left the register the moment the cashier logged it, not whenever a manager gets around to
reviewing it. `db/shift-engine.js`'s `computeShiftFinancials` had to be changed to count these
pending-review entries immediately:

- Expenses: status filter broadened from `POSTED`-only to `SUBMITTED`/`APPROVED`/`POSTED` (excludes
  only `DRAFT` and `CANCELLED`), and the time window switched from `posted_at` alone (which is `NULL`
  for a not-yet-posted expense) to `COALESCE(posted_at, created_at)`.
- Purchases: a brand-new query, since purchases were never in this calculation before — any status
  except `REJECTED` counts, windowed by `created_at` (the `purchases` table has no payment-method
  concept at all; every row in it represents cash by definition).
- `calcExpectedCash` gained a `cashPurchasesTotal` subtraction term.
- If a manager later rejects a purchase, it's excluded from expected cash going forward — a rejected
  entry is treated as "not a real cash outflow," so if the physical drawer count comes up short by
  that amount at close, it surfaces as a variance for investigation rather than being silently
  absorbed.

## 4. Cashier Auto-Scoping Is Enforced Server-Side, Not Just by Permission

The cashier's new permission (`expenses.create_own_daily`/`purchases.create_own_daily`) only gets
them past the route guard. Inside the handler, when the caller is a cashier, `branchId`, `businessDate`,
`status`, and (for expenses) `paymentMethodId` are all overwritten from server-side context —
`req.user.branchId`, today's date, the forced pending status, and an auto-looked-up cash payment
method — regardless of what the request body contains. A test explicitly sends a different branch,
a different date, and `status: "POSTED"` from a cashier token and confirms all three are ignored.

The auto-cash-payment-method lookup matters beyond convenience: the shift-cash query only counts
expenses whose `payment_method_id` resolves to `kind='cash'`, so a cashier expense without one set
would silently fall out of the shift reconciliation it's meant to feed.

## 5. Frontend

- **`satamoni-pos.html`**: a "🧾 مصروف/مشترى" button next to the shift-status button opens a small
  two-tab modal (expense category dropdown reusing `GET /api/expenses/categories`, now opened to
  cashiers too; purchase free-text category matching the existing accounting-page form). No branch,
  date, or payment-method fields — all locked. After submit, a confirmation message and a running
  "today's entries" list (fetched from the now-cashier-accessible `GET /api/expenses`/`GET
  /api/purchases`, branch-scoped like a branch_manager's own view) show pending-vs-reviewed status.
  The close-shift preview gained a "مشتريات كاش" deduction row next to the existing "مصروفات كاش" one.
- **`satamoni-accounting.html`**: the existing expenses/purchases tabs gained a status badge column
  and, for admin/accountant/branch_manager only, review action buttons — "✅ مراجعة واعتماد" for a
  `SUBMITTED` expense (calls the new `/:id/review`), "✅ تأكيد"/"❌ رفض" for a `PENDING` purchase.

## 6. Verification

- **Tests**: new `tests/cashier-expenses-purchases.test.js` (22 tests) — cashier server-side field
  forcing, cashier denied `/review`/`/approve`/`/post`/`/confirm`/`/reject` (403), branch_manager
  scoped to their own branch on review actions, accountant able to review across branches, a full
  shift-math scenario (open shift → cashier logs pending expense+purchase → both counted immediately
  in the preview → manager reviews the expense → total unchanged → manager rejects the purchase →
  total drops → close matches exactly with zero variance). Full suite: 450 (prior phases) + 22 new =
  **472/472**, stable across two consecutive runs.
- **Browser verification** (Playwright, headless Chromium, real Postgres): cashier logged an expense
  and a purchase from the POS quick-entry modal, both correctly showed "في انتظار المراجعة" in the
  today's-entries list; branch manager opened `satamoni-accounting.html`, saw both pending entries
  with review buttons, reviewed the expense (transitioned to "مرحّل"/POSTED with a journal entry) and
  confirmed the purchase (transitioned to "مؤكّد"/CONFIRMED); the close-shift preview correctly
  displayed both cash deduction rows.

## 7. Files Changed

**Database**: `db/migrations/0006_cashier_expenses_purchases.js` (new), `db/schema.sql`.

**Backend**: `middleware/permissions.js`, `routes/expenses.js`, `routes/purchases.js` (rewritten),
`db/shift-engine.js`.

**Frontend**: `public/satamoni-pos.html`, `public/satamoni-accounting.html`.

**Tests**: `tests/cashier-expenses-purchases.test.js` (new).

**Docs**: `docs/CASHIER-EXPENSES-PURCHASES.md` (new), this report.

---

# PHASE 7K STATUS

**Implementation**: COMPLETE

**Tests**: 472/472 (450 prior + 22 new), stable across 2 consecutive runs

**Browser Verification**: PASS (Playwright — cashier entry, manager review, shift-close preview)

**Render Staging**: NOT INDEPENDENTLY VERIFIED — no network access from this session; full flow
proven in a real local browser; user verification on next deploy recommended

**Operational Completeness Before**: ~90% (post-Phase-7J)

**Operational Completeness After**: ~91% (cashiers can now record real-time cash outflows they
actually handle day to day, with manager/accountant oversight before those entries count officially,
and the shift-cash reconciliation now reflects reality instead of silently missing purchases entirely)

**Remaining P1**: third-party delivery-app integration (Talabat etc.) — still blocked, no real API
credentials available; this remains the only unaddressed item from the original Phase 7D audit

**Remaining Manual Workarounds**: none introduced by this phase.

**Recommended Next Step**: delivery-app integration remains the only item from the original audit
still blocked on external access. Further work should come from the user's own priorities.

Per the same working pattern established across 7E–7J, stopping here to report before starting
anything further.
