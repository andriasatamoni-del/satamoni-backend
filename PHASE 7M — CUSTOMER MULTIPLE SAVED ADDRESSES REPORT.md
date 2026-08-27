# PHASE 7M — Customer Multiple Saved Addresses

## Executive Summary

Phase 7M closes the last remaining "must build before real daily operation" item from the Phase 7D
operational gap audit: customers with more than one delivery address (home, work, ...) had no way to
have them saved separately and picked at order time — only a single default address on the `customers`
row. This phase adds a full address book per customer, populated implicitly (no extra clicks) the same
way the system already registers customers implicitly, plus a management UI and CRUD API.

## 1. Design

A new `customer_addresses` table holds one or more addresses per phone number. Addresses are recorded
automatically: whenever a delivery order is created or edited with an address that doesn't exactly match
an existing saved address for that customer (same address text + same delivery area), a new row is
appended — mirroring the existing implicit-customer-registration pattern in `routes/orders.js`, just
extended to addresses. The first address recorded for a customer becomes their default. The existing
`customers.address_details`/`delivery_area_id`/`distinguishing_mark` columns are untouched and keep
acting as "last known address" for backward compatibility.

## 2. Backend

- `db/customer-addresses.js` (new) — `upsertCustomerAddress()`: dedupes on exact text+area match,
  marks the first address a customer gets as default.
- `routes/orders.js` — calls `upsertCustomerAddress()` at both existing customer-upsert points (order
  create and order edit), only for delivery orders with an address.
- `routes/customers.js` — 4 new endpoints: `GET/POST /:phone/addresses`, `PATCH/DELETE
  /:phone/addresses/:id`. Read and add/edit are open to admin/callcenter/branch_manager/cashier (cashier
  already writes address data implicitly via order creation, so explicit add/edit carries the same
  trust level); delete is restricted to admin/callcenter/branch_manager to avoid an accidental data-loss
  action from a busy cashier.

## 3. Frontend

- `satamoni-pos.html` / `satamoni-callcenter.html` — when a phone lookup finds a registered customer
  with more than one saved address, address chips appear under the address fields; clicking one fills
  area/address/mark (and switches branch for admin if the area belongs to a different branch, same as
  the existing customer-lookup prefill logic). No chip selected means the typed address is new and gets
  saved automatically on submit.
- `satamoni-customers.html` — customer profile now has an "دفتر العناوين" (address book) section:
  list, add, set-default, delete.

## Files Changed

- `db/migrations/0007_customer_addresses.js` (new), `db/schema.sql`
- `db/customer-addresses.js` (new)
- `routes/orders.js`, `routes/customers.js`
- `public/satamoni-pos.html`, `public/satamoni-callcenter.html`, `public/satamoni-customers.html`
- `tests/customer-addresses.test.js` (new, 8 tests)
- `docs/CUSTOMER-ADDRESSES.md` (new)

## Testing

- Jest: 480/480 passing, stable across 2 consecutive full runs (472 pre-existing + 8 new).
- Browser verification (Playwright): cashier placed a delivery order for a new customer — first address
  auto-saved as default; second order to the same phone with a different address — second chip appeared,
  selecting it correctly re-filled the fields. Admin address-book management verified: manual add, set
  default, delete all behaved correctly against a real customer record.

# PHASE 7M STATUS

**Implementation:** Complete — implicit address-book accumulation, CRUD API, address-picker UI in
POS/call-center, address-book management UI in the customer data screen.

**Tests:** 480/480 Jest tests passing, stable. 8 new tests cover implicit save/dedup and CRUD/permissions.

**Browser Verification:** Passed — order-time address save/pick and admin address-book management both
confirmed working end-to-end against a real Postgres instance.

**Render Staging:** Not applicable — no deployment step requested this phase.

**Operational Completeness Before → After:**
- Before: a repeat delivery customer with more than one address had no system-level way to have them
  saved and selected — a manual note was the only option, and the wrong address could ship silently.
- After: every distinct delivery address a customer has ever used is saved automatically and selectable
  by a single click at order time, with a back-office screen to curate the list.

**Remaining P1:** None identified for this phase's scope. This closes the last item from Phase 7D's
"must build before real daily operation" list.

**Remaining Manual Workarounds:** Talabat/delivery-app API integration remains unaddressed, still
blocked on real API credentials (unchanged from prior phases).

**Recommended Next Step:** Continuing directly to Phase 7N (purchase returns) per the user's standing
instruction to work through the remaining backlog without stopping between phases.
