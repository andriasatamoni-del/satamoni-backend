// Talabat Partner API client - STUB BOUNDARY
//
// This module is the ONLY place in the codebase allowed to talk to Talabat's real Partner
// API (OAuth token endpoint, GET order details, GET order history/reconciliation). Every
// network-calling function below throws TalabatNotImplementedError until:
//
//   1. The real Talabat Partner API specification is obtained (exact token endpoint,
//      grant params, order-details/order-history endpoints and field names), and
//   2. Talabat's Account Manager has confirmed the Stamoni account is eligible for
//      Partner Picking / POS integration for the target store(s).
//
// Do NOT guess endpoint paths or payload field names here - see docs/TALABAT-INTEGRATION.md
// for the full design and exactly what is needed to complete this module.
//
// Credentials are read ONLY from server-side environment variables. Never hardcode them,
// never send them to any frontend page, and never store them in sessionStorage/localStorage:
//   TALABAT_CLIENT_ID, TALABAT_CLIENT_SECRET, TALABAT_API_BASE_URL, TALABAT_TOKEN_URL,
//   TALABAT_WEBHOOK_SECRET (verifies inbound webhook signatures - see talabat-webhook.js),
//   TALABAT_ENVIRONMENT ('sandbox' | 'production', defaults to 'sandbox')

class TalabatNotImplementedError extends Error {
  constructor(message) {
    super(message);
    this.name = "TalabatNotImplementedError";
    this.code = "TALABAT_CLIENT_NOT_IMPLEMENTED";
  }
}

function getConfig() {
  return {
    clientId: process.env.TALABAT_CLIENT_ID || null,
    clientSecret: process.env.TALABAT_CLIENT_SECRET || null,
    apiBaseUrl: process.env.TALABAT_API_BASE_URL || null,
    tokenUrl: process.env.TALABAT_TOKEN_URL || null,
    webhookSecretConfigured: Boolean(process.env.TALABAT_WEBHOOK_SECRET),
    environment: process.env.TALABAT_ENVIRONMENT || "sandbox",
  };
}

// Whether server-side credentials/URLs have been SET - this does NOT mean they have ever
// been verified against a real Talabat call. The Integration Dashboard (TAL-9) must report
// a three-state status (NOT_CONFIGURED / CONFIGURED_UNVERIFIED / CONNECTED), never claim
// "CONNECTED" from isConfigured() alone.
function isConfigured() {
  const { clientId, clientSecret, apiBaseUrl, tokenUrl } = getConfig();
  return Boolean(clientId && clientSecret && apiBaseUrl && tokenUrl);
}

async function getAccessToken() {
  throw new TalabatNotImplementedError(
    "Talabat OAuth2 client-credentials token exchange is not implemented: the real token " +
      "URL, grant parameters, and credential-transport method (HTTP Basic auth header vs " +
      "body params, exact scope value) are not yet confirmed against Talabat's Partner API " +
      "specification. Implement this once that spec is available; do not guess the shape."
  );
}

async function getOrderDetails(talabatOrderId) {
  throw new TalabatNotImplementedError(
    `Talabat GET order-details call is not implemented (requested talabat_order_id=` +
      `${talabatOrderId}): the real endpoint path and response field names are not yet ` +
      "confirmed against Talabat's Partner API specification."
  );
}

async function getOrderHistory({ branchId, fromDate, toDate } = {}) {
  throw new TalabatNotImplementedError(
    `Talabat GET order-history/reconciliation call is not implemented (requested ` +
      `branchId=${branchId}, fromDate=${fromDate}, toDate=${toDate}): the real endpoint ` +
      "path, pagination scheme, and response field names are not yet confirmed against " +
      "Talabat's Partner API specification."
  );
}

module.exports = {
  TalabatNotImplementedError,
  getConfig,
  isConfigured,
  getAccessToken,
  getOrderDetails,
  getOrderHistory,
};
