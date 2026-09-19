// TAL-4: استقبال webhook طلبات - أمن التوقيع، idempotency (نفس الحدث حرفيًا مرتين = مرة واحدة فقط
// معالجة)، وتسجيل فشل الـadapter (لسه NOT_IMPLEMENTED) كـIntegration Error مرئي مش صامت.
const crypto = require("crypto");
const { app, request, pool } = require("./helpers");

const SECRET = "test-talabat-secret";

function sign(rawBody) {
  return crypto.createHmac("sha256", SECRET).update(rawBody).digest("hex");
}

afterAll(async () => {
  await pool.end();
});

describe("POST /api/talabat/webhook/orders", () => {
  afterEach(() => {
    delete process.env.TALABAT_WEBHOOK_SECRET;
  });

  it("بيرفض 503 لو التكامل مش مُفعّل (مفيش secret متسجل) - مش قبول صامت", async () => {
    const res = await request(app)
      .post("/api/talabat/webhook/orders")
      .set("Content-Type", "application/json")
      .send(JSON.stringify({ any: "payload" }));
    expect(res.status).toBe(503);
    expect(res.body.error).toBe("TALABAT_NOT_CONFIGURED");
  });

  it("بيرفض 401 لو التوقيع غلط", async () => {
    process.env.TALABAT_WEBHOOK_SECRET = SECRET;
    const res = await request(app)
      .post("/api/talabat/webhook/orders")
      .set("Content-Type", "application/json")
      .set("x-talabat-signature", "0".repeat(64))
      .send(JSON.stringify({ any: "payload" }));
    expect(res.status).toBe(401);
  });

  it("بيقبل توقيع صحيح، يسجل الاستلام، ويسجل فشل الـadapter كـIntegration Error مرئي (مش نجاح صامت)", async () => {
    process.env.TALABAT_WEBHOOK_SECRET = SECRET;
    const rawBody = JSON.stringify({ order: { id: "TAL-JEST-1" } });
    const res = await request(app)
      .post("/api/talabat/webhook/orders")
      .set("Content-Type", "application/json")
      .set("x-talabat-signature", sign(rawBody))
      .send(rawBody);

    expect(res.status).toBe(200);
    expect(res.body.processing).toBe("FAILED");
    expect(res.body.error).toBe("TALABAT_PAYLOAD_ADAPTER_NOT_IMPLEMENTED");

    const dedupeKey = crypto.createHash("sha256").update(rawBody).digest("hex");
    const eventRow = await pool.query(
      "SELECT processing_status, error_message FROM talabat_webhook_events WHERE dedupe_key = $1",
      [dedupeKey]
    );
    expect(eventRow.rows).toHaveLength(1);
    expect(eventRow.rows[0].processing_status).toBe("FAILED");

    const errorRow = await pool.query(
      "SELECT error_type, status FROM talabat_integration_errors WHERE error_type = $1 ORDER BY id DESC LIMIT 1",
      ["TALABAT_PAYLOAD_ADAPTER_NOT_IMPLEMENTED"]
    );
    expect(errorRow.rows.length).toBeGreaterThanOrEqual(1);
    expect(errorRow.rows[0].status).toBe("OPEN");
  });

  it("idempotency: نفس الجسم الخام مرتين = حدث واحد بس معالج، الثاني بيترفض كـduplicate", async () => {
    process.env.TALABAT_WEBHOOK_SECRET = SECRET;
    const rawBody = JSON.stringify({ order: { id: "TAL-JEST-DUP" } });
    const signature = sign(rawBody);

    const first = await request(app)
      .post("/api/talabat/webhook/orders")
      .set("Content-Type", "application/json")
      .set("x-talabat-signature", signature)
      .send(rawBody);
    expect(first.status).toBe(200);
    expect(first.body.status).toBe("received");

    const second = await request(app)
      .post("/api/talabat/webhook/orders")
      .set("Content-Type", "application/json")
      .set("x-talabat-signature", signature)
      .send(rawBody);
    expect(second.status).toBe(200);
    expect(second.body.status).toBe("duplicate");

    const dedupeKey = crypto.createHash("sha256").update(rawBody).digest("hex");
    const rows = await pool.query("SELECT id FROM talabat_webhook_events WHERE dedupe_key = $1", [dedupeKey]);
    expect(rows.rows).toHaveLength(1);
  });
});
