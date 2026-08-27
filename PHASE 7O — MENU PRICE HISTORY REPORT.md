# PHASE 7O — Menu Price History Log

## Executive Summary

Phase 7O adds a price-history log for the menu — closing the "menu price-history log" item from the
Phase 7D audit's List B. Before this, only the base variant price had a generic mention in `audit_logs`
(action `PRICE_CHANGE`); talabat price, a modifier's default price, and a modifier's per-variant price
override had no history at all, and there was no dedicated, browsable view of price changes anywhere in
the menu screen.

## 1. Design

A new `menu_price_history` table, mirroring the existing `employee_history` pattern (generic
`field_name`, old/new value, who changed it, when — append-only). `db/menu-price-history.js` exports
`logPriceChange()`, called from `routes/menu.js` at the three places a price actually changes: variant
`price`/`talabat_price` (PATCH `/variants/:id`), a modifier's default `price_delta` (PATCH
`/modifiers/:id`), and a modifier's per-variant price override (PUT
`/modifiers/:id/variant-prices/:variantId`). It only inserts a row when the new value actually differs
from the old one — a no-op edit doesn't pollute the history.

## 2. Frontend

The base variant price had no edit affordance at all before this phase (only talabat price was
editable) — added one, since a price-history feature is meaningless without a way to actually change the
price it's tracking. Added a "📈 سجل السعر" (price history) button next to each variant showing its
combined base/talabat price history in a modal, and a small "📈" button next to each modifier's default
price and each per-variant override, opening the same modal filtered to that specific price.

## Files Changed

- `db/migrations/0009_menu_price_history.js` (new), `db/schema.sql`
- `db/menu-price-history.js` (new)
- `routes/menu.js` (3 logging call sites + 2 new GET history endpoints)
- `public/satamoni-menu.html` (base-price edit button, price-history modal + buttons)
- `tests/menu-price-history.test.js` (new, 4 tests)
- `docs/MENU-PRICE-HISTORY.md` (new)

## Testing

- Jest: 493/493 passing, stable across 2 consecutive full runs (489 pre-existing + 4 new).
- Migration 0009 applied to the dev database.
- Browser verification (Playwright): edited a variant's base price via the new edit button, opened the
  price-history modal, and confirmed the new old→new row appeared with the changer's name and timestamp;
  confirmed the modal closes correctly.

# PHASE 7O STATUS

**Implementation:** Complete — price-history table + logging at all three menu price-change points, two
read endpoints, and a browsable history modal wired to a newly-added base-price edit control.

**Tests:** 493/493 Jest tests passing, stable. 4 new tests cover logging, no-op suppression, and the
modifier-default vs. per-variant-override separation.

**Browser Verification:** Passed — price edit and history modal confirmed working end-to-end.

**Render Staging:** Not applicable — no deployment step requested this phase.

**Operational Completeness Before → After:**
- Before: no dedicated way to see when an item's price changed, by whom, or from what — only a generic,
  hard-to-browse audit-log trail for the base variant price alone, and no way to edit that base price at
  all through the UI.
- After: every price on the menu (base, talabat, modifier default, modifier per-variant override) is
  logged on change and browsable in one click from the menu screen.

**Remaining P1:** None identified for this phase's scope.

**Remaining Manual Workarounds:** Talabat/delivery-app API integration remains unaddressed (unchanged
from prior phases).

**Recommended Next Step:** Continuing directly to Phase 7P (customer blocking + duplicate-merge tooling)
per the user's standing instruction to work through the remaining backlog without stopping between
phases.
