# PHASE 7P — Customer Blocking & Duplicate-Merge Tooling

## Executive Summary

Phase 7P closes the last two customer-data items from the Phase 7D audit's "should build after pilot"
list: blocking a customer from delivery orders, and merging duplicate customer records.

## 1. Customer Blocking

Added `is_blocked`/`block_reason`/`blocked_by`/`blocked_at` to `customers`, plus
`POST /api/customers/:phone/block` and `/unblock`. Enforcement is wired into `POST /api/orders`: a
delivery order for a blocked phone (checked against both the primary and secondary number) is rejected
with a 403 naming the block reason. Takeaway and dine-in orders are unaffected — blocking exists to stop
a delivery commitment to a problem customer, not to bar someone who walks in. The customer screen shows a
block/unblock control on the profile and a red "محظور" badge in the directory; the POS and call-center
phone-lookup now surface a clear warning instead of the normal "registered" message when the looked-up
customer is blocked.

## 2. Duplicate-Merge

`POST /api/customers/merge` (`{sourcePhone, targetPhone}`) moves the source customer's orders and saved
addresses onto the target phone, sums loyalty points, backfills any blank target fields from the source,
and permanently deletes the source customer row (nothing is left referencing it once orders/addresses are
repointed, so deletion is clean). This is a one-way, destructive operation — the UI requires an explicit
confirmation before calling it.

## Files Changed

- `db/migrations/0010_customer_blocking.js` (new), `db/schema.sql`
- `routes/customers.js` (block/unblock/merge endpoints, isBlocked exposed on existing responses)
- `routes/orders.js` (block check on delivery order creation)
- `public/satamoni-customers.html` (block/merge UI, blocked badge)
- `public/satamoni-pos.html`, `public/satamoni-callcenter.html` (block warning in phone lookup)
- `tests/customer-blocking-merge.test.js` (new, 6 tests)
- `docs/CUSTOMER-BLOCKING-MERGE.md` (new)

## Testing

- Jest: 499/499 passing, stable across 2 consecutive full runs (493 pre-existing + 6 new).
- Migration 0010 applied to the dev database.
- Browser verification (Playwright): blocked a seeded customer from the profile screen, confirmed the
  block reason appeared and the directory badge showed, then unblocked and confirmed the status reverted.

# PHASE 7P STATUS

**Implementation:** Complete — customer blocking (schema, enforcement at delivery order creation, UI) and
duplicate-customer merge (orders/addresses/loyalty-points consolidation, UI with confirmation).

**Tests:** 499/499 Jest tests passing, stable. 6 new tests cover block enforcement (and non-interference
with other customers), unblock recovery, and merge (data movement, field backfill, self-merge/missing-
customer rejection).

**Browser Verification:** Passed — block/unblock flow confirmed working end-to-end in the customer screen.

**Render Staging:** Not applicable — no deployment step requested this phase.

**Operational Completeness Before → After:**
- Before: no way to stop taking delivery orders from a specific troublesome customer, and no way to
  consolidate a customer who ended up with two separate records.
- After: staff can block/unblock a customer's delivery orders from the customer screen with a visible
  reason, and merge duplicate records in one confirmed action.

**Remaining P1:** None identified for this phase's scope. This closes the last remaining item from Phase
7D's customer-data gap list.

**Remaining Manual Workarounds:** Talabat/delivery-app API integration remains unaddressed (unchanged
from prior phases).

**Recommended Next Step:** Continuing directly to Phase 7Q (report search/filter in
satamoni-reports.html) per the user's standing instruction to work through the remaining backlog without
stopping between phases.
