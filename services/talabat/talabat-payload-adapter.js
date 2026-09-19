// STUB BOUNDARY: the ONE place that would translate Talabat's real webhook JSON into
// Stamoni's own internal, Talabat-independent "normalized order" shape. Do NOT guess
// Talabat's real field names here - see docs/TALABAT-INTEGRATION.md. Every other module in
// the Talabat integration (webhook route, order-sync engine, tests) is built and tested
// against the NORMALIZED shape below, never against Talabat's raw payload directly - so the
// rest of the pipeline is fully buildable and testable now, and plugging in the real
// Talabat field mapping later touches only this one file.
//
// NormalizedTalabatOrder shape (internal design, not Talabat's real payload):
// {
//   talabatOrderId: string,            // stable Talabat order id - used for idempotency and
//                                      // the 1:1 Talabat-order <-> POS-order relationship
//   talabatExternalOrderId: string|null,
//   talabatOrderCode: string|null,     // human-readable code (e.g. printed on Talabat's receipt)
//   branchExternalId: string,          // Talabat's store/branch identifier - resolved to a real
//                                      // Stamoni branches.id by the order-sync engine, not here
//   orderStatus: string,               // e.g. 'NEW' | 'ACCEPTED' | 'CANCELED' - raw Talabat value,
//                                      // mapped to talabat_orders.order_status by the sync engine
//   orderType: string|null,            // e.g. delivery/pickup
//   paymentMethodCode: string,         // raw Talabat payment-method string - resolved to a real
//                                      // payment_methods.id via payment_methods.talabat_payment_code
//   subtotal: number|null,
//   deliveryFee: number|null,
//   discount: number|null,
//   total: number,
//   currency: string,
//   items: [{ talabatItemId: string, talabatSku: string|null, name: string, quantity: number,
//             unitPrice: number, totalPrice: number }],
//   customer: { name: string|null, phone: string|null } | null,
//   receivedAt: string,                // ISO timestamp
// }

class TalabatPayloadNotImplementedError extends Error {
  constructor(message) {
    super(message);
    this.name = "TalabatPayloadNotImplementedError";
    this.code = "TALABAT_PAYLOAD_ADAPTER_NOT_IMPLEMENTED";
  }
}

// Maps a raw Talabat webhook payload into the normalized shape above. Not implemented until
// the real payload structure is confirmed - do not guess field names.
function normalizeTalabatOrderPayload(_rawPayload) {
  throw new TalabatPayloadNotImplementedError(
    "Talabat raw webhook payload -> normalized order mapping is not implemented: the real " +
      "field names/structure are not yet confirmed against Talabat's Partner API " +
      "specification. Implement this function once that spec is available; every downstream " +
      "consumer (order-sync engine, tests) already works against the normalized shape " +
      "documented at the top of this file."
  );
}

const REQUIRED_FIELDS = [
  "talabatOrderId",
  "branchExternalId",
  "orderStatus",
  "paymentMethodCode",
  "total",
  "currency",
  "items",
];

// Guards the boundary from the other side: whatever produces a "normalized order" (the real
// adapter once implemented, or a test fixture) must satisfy this shape before the sync engine
// will touch it - independent of whether Talabat's real field names are known yet.
function validateNormalizedOrder(order) {
  const errors = [];
  if (!order || typeof order !== "object") return ["order must be an object"];
  for (const field of REQUIRED_FIELDS) {
    if (order[field] === undefined || order[field] === null || order[field] === "") {
      errors.push(`missing required field: ${field}`);
    }
  }
  if (order.items && !Array.isArray(order.items)) {
    errors.push("items must be an array");
  }
  if (order.total !== undefined && typeof order.total !== "number") {
    errors.push("total must be a number");
  }
  return errors;
}

module.exports = {
  TalabatPayloadNotImplementedError,
  normalizeTalabatOrderPayload,
  validateNormalizedOrder,
};
