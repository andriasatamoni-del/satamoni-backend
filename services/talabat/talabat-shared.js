// تكامل طلبات - أدوات مشتركة بين محرك المزامنة (talabat-order-sync.js) ومحرك الإلغاء
// (talabat-cancellation.js): تسجيل Integration Error، جلب المستخدم النظامي (Talabat Integration
// System)، والتقاط استجابة createOrderHandler/voidOrderHandler الاصطناعية.
const SYSTEM_ACTOR_EMAIL = "talabat-integration@system.internal";

async function recordIntegrationError(client, { talabatOrderId, branchId = null, errorType, errorMessage, rawPayload = null }) {
  await client.query(
    `INSERT INTO talabat_integration_errors (talabat_order_id, branch_id, error_type, error_message, raw_payload)
     VALUES ($1, $2, $3, $4, $5)`,
    [talabatOrderId, branchId, errorType, errorMessage, rawPayload ? JSON.stringify(rawPayload) : null]
  );
}

async function getSystemActor(client) {
  const result = await client.query(
    "SELECT id, role, branch_id FROM users WHERE email = $1 AND is_active = TRUE",
    [SYSTEM_ACTOR_EMAIL]
  );
  if (result.rows.length === 0) {
    throw new Error(
      "Talabat system actor user not found (talabat-integration@system.internal) - run db migrations"
    );
  }
  const row = result.rows[0];
  return { id: row.id, role: row.role, branchId: row.branch_id };
}

// Captures a route handler's res.status(code).json(body) calls without a real HTTP response -
// the handler's calling convention is unchanged, so this harness is the only new surface.
function createCaptureResponse() {
  let statusCode = 200;
  let body = null;
  const res = {
    status(code) {
      statusCode = code;
      return res;
    },
    json(payload) {
      body = payload;
      return res;
    },
  };
  return { res, getStatusCode: () => statusCode, getBody: () => body };
}

module.exports = { SYSTEM_ACTOR_EMAIL, recordIntegrationError, getSystemActor, createCaptureResponse };
