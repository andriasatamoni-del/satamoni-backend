# PHASE 7S — SMS/WhatsApp Order Confirmations

## Executive Summary

Phase 7S adds an automatic customer-facing order confirmation (SMS/WhatsApp) sent after a delivery or
phone-in takeaway order is created — closing the "SMS/WhatsApp order confirmations" item from the Phase
7D audit's List C (nice-to-have). The system has no real credentials for any third-party gateway
(Twilio or otherwise), so rather than build against a specific vendor SDK that couldn't actually be
tested, this phase follows the same pattern already established for Talabat: a fully-built, fully-tested
generic HTTP-webhook abstraction that no-ops safely until a real gateway URL is configured.

## 1. Design

`db/sms-provider.js` exports `sendMessage()` — a generic sender that POSTs (or GETs) `{to, message}` to
any HTTP endpoint named by `SMS_WEBHOOK_URL`, with an optional `SMS_WEBHOOK_METHOD` and
`SMS_WEBHOOK_AUTH_HEADER`. With no URL configured it returns `{sent:false, status:"not_configured"}`
without attempting any network call — the same "off by default until configured" posture as
`SYNC_API_KEY`. Any failure (HTTP error or connection failure) is caught and returned as
`{sent:false, status:"failed", error}`, never thrown.

`db/order-notifications.js` exports `maybeSendOrderConfirmation()`, called from `routes/orders.js`
immediately after `COMMIT` in the order-creation handler — deliberately after the order is already
durably saved, and wrapped entirely in try/catch that only logs to console, mirroring the existing
`logAudit()` philosophy that logging failures must never break the real operation they're attached to.
Only `delivery` and `takeaway` orders are notifiable (the customer isn't standing in front of a printed
receipt, unlike dine-in), and only when `pos_settings.sms_confirmations_enabled` is `TRUE` (default
`FALSE`). Every attempt — sent, failed, or not_configured — is logged to a new append-only
`order_notifications` table for review.

## 2. Backend & Frontend

- `routes/pos-settings.js` extended (GET already `SELECT *`; PATCH now accepts `smsConfirmationsEnabled`)
  alongside the existing discount/VAT/loyalty settings, admin-only.
- `public/satamoni-admin.html` gets a checkbox next to the existing POS-settings rows to toggle the
  feature, saved via the same `PATCH /api/pos-settings` endpoint.

## Files Changed

- `db/migrations/0011_order_notifications.js` (new), `db/schema.sql`
- `db/sms-provider.js` (new)
- `db/order-notifications.js` (new)
- `routes/orders.js` (require + call to `maybeSendOrderConfirmation()` after COMMIT in `POST /`)
- `routes/pos-settings.js` (`smsConfirmationsEnabled` in GET/PATCH)
- `public/satamoni-admin.html` (toggle checkbox + save handler)
- `tests/order-notifications.test.js` (new, 9 tests)
- `docs/SMS-WHATSAPP-CONFIRMATIONS.md` (new)

## Testing

- Jest: 508/508 passing, stable across 2 consecutive full runs (499 pre-existing + 9 new).
- New tests cover `sendMessage()` in isolation (not_configured / successful webhook with correct
  payload+auth header / HTTP error / connection failure) and the real effect inside order creation
  (setting off → no row even for delivery/takeaway; setting on with no gateway → `not_configured` row;
  setting on with a working gateway → `sent` row containing the order number and total; setting on with a
  failing gateway → order still returns 201, row logged `failed`; dine-in orders never attempt regardless
  of the setting).
- Migration 0011 applied to the dev database.
- Browser verification (Playwright) against the real dev server + dev database, plus a local mock HTTP
  gateway standing in for a real SMS provider: toggled the admin checkbox on, saved, reloaded the page and
  confirmed it stayed checked. Separately, with the setting enabled and `SMS_WEBHOOK_URL` pointed at the
  mock gateway, created a real takeaway order via the API and confirmed both that the `order_notifications`
  row was inserted with status `sent` and the correct message text, and that the mock gateway actually
  received the expected `{to, message}` payload.

# PHASE 7S STATUS

**Implementation:** Complete — generic webhook-based SMS/WhatsApp sender, order-creation hook that never
blocks or fails the order, admin on/off toggle, and a full attempt log.

**Tests:** 508/508 Jest tests passing, stable. 9 new tests cover the sender in isolation and its real
effect inside order creation, including the not-configured and failure paths.

**Browser Verification:** Passed — admin toggle persists correctly, and an end-to-end order → real HTTP
webhook call → logged `order_notifications` row was confirmed against a local mock gateway.

**Render Staging:** Not applicable — no deployment step requested this phase.

**Operational Completeness Before → After:**
- Before: no way to notify a delivery/takeaway customer their order was received other than a phone call;
  no infrastructure existed to plug in any SMS/WhatsApp provider.
- After: any HTTP-webhook-based SMS/WhatsApp gateway can be wired in with a single environment variable
  and an admin toggle — no code changes needed once real credentials exist. Until then, the system runs
  exactly as before, with attempts safely logged as `not_configured`.

**Remaining P1:** None identified for this phase's scope.

**Remaining Manual Workarounds:** Talabat/delivery-app API integration remains unaddressed (unchanged
from prior phases). Actual message delivery still requires the owner to obtain and configure a real
SMS/WhatsApp gateway — this phase ships the readiness infrastructure, not a vendor relationship.

**Recommended Next Step:** Continuing directly to Phase 7T (employee self-service login) per the user's
standing instruction to work through the remaining backlog without stopping between phases.
