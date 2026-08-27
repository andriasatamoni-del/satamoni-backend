# PHASE 7N — Purchase Returns

## Executive Summary

Phase 7N adds a "purchase return" transaction — returning goods to a supplier (defective, wrong item,
expired) — closing the "Purchase-return / rejected-goods transaction" item from the Phase 7D audit's
List B. This is distinct from the existing `goods-receipts/:id/cancel` full-GRN reversal (which only
works if none of the batch has been consumed yet): a purchase return can reverse a **partial** quantity
from a **specific item or batch** at any later point, without touching the original GRN or PO.

## 1. Design

New `purchase_returns`/`purchase_return_items` tables. Lifecycle: `DRAFT` → `POST /:id/post` → `POSTED`
(final — no un-posting, since the goods have physically left for the supplier); a `DRAFT` can be
cancelled, a `POSTED` return cannot. Posting is a single atomic transaction (row-locked like every other
posting workflow in this codebase) that:

- Decrements the specific batch's `remaining_quantity` exactly when a `batchId` is given (rejects if the
  requested quantity exceeds what remains in that batch), or falls back to standard FEFO/FIFO consumption
  when no batch is specified.
- Posts one inventory movement per line (`RETURN_TO_SUPPLIER` — an existing movement type already used by
  the GRN-cancel path, so no schema/check-constraint change was needed).
- Posts one journal entry: DR Accounts Payable (2100) / CR Inventory (1400) — the mirror image of the
  original goods-receipt entry, reducing what's owed to the supplier.

Reuses the existing `purchasing.create`/`purchasing.view`/`purchasing.approve`/`purchasing.cancel`
permissions from Phase 4A — no new permission strings.

## 2. Scope Note — No Frontend

The entire formal procurement module (suppliers, purchase requests, purchase orders, goods receipts —
Phase 4A) has **no frontend screen at all** yet; it's API-only. Purchase returns were built the same way:
a complete, tested API ready to be wired into whichever purchasing screen gets built later. Building a
full purchasing back-office UI from scratch is a separate, materially larger undertaking than "purchase
returns" and was out of this phase's scope — flagged here rather than silently built as a one-off page
disconnected from the rest of that module.

## Files Changed

- `db/migrations/0008_purchase_returns.js` (new), `db/schema.sql`
- `routes/purchase-returns.js` (new)
- `server.js` (mount route)
- `tests/purchase-returns.test.js` (new, 9 tests)
- `docs/PURCHASE-RETURNS.md` (new)

## Testing

- Jest: 489/489 passing, stable across 2 consecutive full runs (480 pre-existing + 9 new).
- Migration 0008 confirmed idempotent against the real dev database (second run applied nothing).
- No browser verification — no UI exists for this phase's scope, as noted above.

# PHASE 7N STATUS

**Implementation:** Complete — purchase-return transaction (draft/post/cancel), batch-specific and
FEFO-fallback inventory reversal, accounts-payable-reducing journal entry.

**Tests:** 489/489 Jest tests passing, stable. 9 new tests cover value calculation, posting +
idempotency, batch-specific reversal with insufficient-quantity rejection, branch isolation, and the
draft-only cancel rule.

**Browser Verification:** Not applicable — this phase is API-only, matching the rest of the formal
purchasing module which has no frontend yet.

**Render Staging:** Not applicable — no deployment step requested this phase.

**Operational Completeness Before → After:**
- Before: no way to formally record goods sent back to a supplier after receipt — the only reversal
  available was cancelling an entire, still-unconsumed goods receipt.
- After: any quantity of any received item (down to a specific batch) can be returned at any later point,
  with inventory and the supplier's payable balance kept correct automatically.

**Remaining P1:** None identified for this phase's scope.

**Remaining Manual Workarounds:** Talabat/delivery-app API integration remains unaddressed (unchanged
from prior phases). The formal purchasing module (suppliers/PR/PO/GRN/returns) remains API-only with no
back-office screen — a separate, larger scope item than what was asked for this phase.

**Recommended Next Step:** Continuing directly to Phase 7O (menu price-history log) per the user's
standing instruction to work through the remaining backlog without stopping between phases.
