# PHASE 7L — POS Delivery Orders & Order-Type Separation

## Executive Summary

Phase 7L answered two linked requests from the user: (1) enable delivery orders directly from the
cashier (POS) screen, working exactly like the call-center screen — phone-number search, automatic
prefill for an existing customer, manual registration for a new one; and (2) separate takeaway orders
from delivery orders in the order-tracking / order-status screens.

Research (task #255) established that the backend already fully supported both requirements with zero
code changes needed:

- `POST /api/orders` with `source=pos` already permitted the cashier role to submit `orderType='delivery'`
  (`requirePosAuthIfNeeded` already allowed it).
- Customers are identified purely by phone number, with no separate "customer ID" concept. An unknown
  phone number is registered implicitly via `INSERT ... ON CONFLICT (phone) DO UPDATE` at order-creation
  time — there is no separate "register customer" call needed before submitting an order.
- `GET /api/customers?phone=` (the lookup used for prefill) was already open to the cashier role in
  `routes/customers.js`.
- `GET /api/orders?orderType=` was already a supported server-side filter (`routes/orders.js:576,591`) —
  it simply had no frontend consumer anywhere in the app.

Because of this, Phase 7L is a **frontend-only** phase: no migration, no permission changes, no route
changes. Full details are in `docs/POS-DELIVERY-ORDERS.md`.

## 1. Delivery Orders From the Cashier Screen

Ported the call-center screen's delivery-order flow into `public/satamoni-pos.html` verbatim:

- `state.deliveryAreas` + `renderAreaSelect()` — delivery areas scoped to the selected branch.
- `currentDeliveryFee()` — delivery fee computed from the selected area; the order payload now sends
  the real computed fee instead of the previously hardcoded `deliveryFee: 0`.
- `applyCustomerLookup(phone, p)` — a 500ms-debounced phone-number search. Existing customer → "✅ عميل
  مسجل من قبل" with non-destructive prefill of name/second phone/address/mark/delivery-area (never
  overwriting a field the cashier already typed into). Unknown number → "🆕 عميل جديد" with fields left
  blank for manual entry.
- New fields shown only when order type is "delivery": customer name, second phone (optional), delivery
  area, address, landmark/mark.
- `updateSubmitState()` now requires name/phone/area/address to be complete for a delivery order before
  allowing submission — matching the call-center screen's validation exactly.

## 2. Order-Type Separation in Order-Tracking Screens

The same gap existed identically in three screens: the "ongoing orders" overlay in
`satamoni-pos.html` and `satamoni-callcenter.html`, and the standalone `satamoni-delivery.html` screen.
All three listed every order type (takeaway/delivery/dine-in/orders) together in one list, distinguished
only by text inside each card's title — no filter or tab for order type at all, despite the backend
already supporting an `orderType` filter.

Fix: a new tab row ("كل الأنواع" / "تيك أواي" / "دليفري" / "صالة" / "طلبات 🛵") added directly under the
existing status-filter tab row in all three screens, wired to the pre-existing `orderType` query param on
`GET /api/orders`. The status-tab row and the new type-tab row are fully independent — selecting a status
tab does not clear the type-tab selection and vice versa. This required scoping every `querySelectorAll`
call to its specific container id (`#ordersTopbar .otab[data-ostatus]` vs `#ordersTypeTabs
.otab[data-otype]`; `#filters .tab[data-status]` vs `#typeFilters .tab[data-otype]`) since both tab rows
share the same CSS class — an unscoped selector would have made clicking one tab row incorrectly toggle
the other row's active state too.

## Files Changed

**Frontend only:**
- `public/satamoni-pos.html` — full delivery-order UI port (area select, customer lookup, delivery fee,
  validation) + order-type tabs in the ongoing-orders overlay.
- `public/satamoni-callcenter.html` — order-type tabs in the ongoing-orders overlay (the delivery flow
  itself already existed here and was left unchanged).
- `public/satamoni-delivery.html` — order-type tabs (`#typeFilters`).
- `docs/POS-DELIVERY-ORDERS.md` (new) — feature documentation.

**No backend files changed** — `routes/orders.js`, `routes/customers.js`, `middleware/permissions.js`,
and the database schema were already fully sufficient for both requirements.

## Testing

- Full Jest regression: 472/472 passing (unchanged from Phase 7K, since no backend code was touched — no
  new tests were needed for a frontend-only phase).
- Browser verification (Playwright, headless Chromium):
  - Cashier logged in, added an item to cart, switched order type to "delivery".
  - Entered a brand-new phone number → "🆕 عميل جديد" shown; filled name/address/area; submit button
    enabled only once required fields were complete; order submitted successfully.
  - Re-entered the same phone number in a new order → "✅ عميل مسجل من قبل" shown, with name and address
    correctly prefilled from the just-created customer record.
  - Opened the ongoing-orders overlay: the "دليفري" tab showed only the delivery order just created (no
    takeaway/dine-in cards); the "تيك أواي" tab showed no delivery cards. Confirmed the same separation
    works correctly in `satamoni-delivery.html`.

# PHASE 7L STATUS

**Implementation:** Complete — delivery-order creation from the cashier screen (phone lookup, new/existing
customer handling, delivery area & fee, validation) and order-type tab separation across all three
order-tracking screens (POS overlay, call-center overlay, delivery screen).

**Tests:** 472/472 Jest tests passing, stable. No new tests added — this phase touched no backend code.

**Browser Verification:** Passed via Playwright — new-customer delivery order creation, existing-customer
lookup/prefill, and order-type tab filtering all confirmed working in all three affected screens.

**Render Staging:** Not applicable — no deployment step requested this phase.

**Operational Completeness Before → After:**
- Before: cashiers could only place dine-in/takeaway orders; delivery orders required the separate
  call-center screen. Order-tracking screens mixed all order types in one undifferentiated list.
- After: cashiers can place delivery orders directly, with the same customer-lookup convenience as
  call-center staff. All three order-tracking screens can filter by order type independently of order
  status.

**Remaining P1:** None identified for this phase's scope.

**Remaining Manual Workarounds:** Talabat/delivery-app API integration remains unaddressed (carried over
from the Phase 7D audit) — still blocked on obtaining real API credentials from the delivery platforms.

**Recommended Next Step:** None pending from the user; awaiting further direction.
