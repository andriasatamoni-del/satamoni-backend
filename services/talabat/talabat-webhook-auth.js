// Verifies inbound Talabat webhook requests are genuinely from Talabat before anything else
// touches them - "no anonymous acceptance" is a hard mission requirement.
//
// STUB CAVEAT: the exact signature header name and algorithm are not yet confirmed against
// Talabat's real Partner API webhook specification. This mirrors the same HMAC-SHA256-over-
// raw-body-with-timing-safe-compare pattern already used and battle-tested for the WhatsApp
// webhook (db/whatsapp-client.js verifySignature) - the de-facto standard for provider
// webhooks - but the header name and algorithm must be confirmed (and this file updated if
// different) before going live. Fails CLOSED in every ambiguous case: not configured, no
// signature header, or a mismatched signature are all treated as unauthenticated - never as
// an anonymous pass-through.
const crypto = require("crypto");

function isConfigured() {
  return Boolean(process.env.TALABAT_WEBHOOK_SECRET);
}

function signatureHeaderName() {
  return process.env.TALABAT_WEBHOOK_SIGNATURE_HEADER || "x-talabat-signature";
}

function verifySignature(rawBody, signatureHeader) {
  const secret = process.env.TALABAT_WEBHOOK_SECRET;
  if (!secret || !signatureHeader || !rawBody) return false;
  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  const expectedBuf = Buffer.from(expected);
  const gotBuf = Buffer.from(String(signatureHeader));
  if (expectedBuf.length !== gotBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, gotBuf);
}

module.exports = { isConfigured, signatureHeaderName, verifySignature };
