// TAL-7: retry_count/last_retry_at/status لكل Integration Error، ومحتاج صلاحية talabat.retry منفصلة
// (الكاشير معندوش خالص). إعادة المحاولة بتعيد تشغيل نفس المسار اللي فشل (adapter -> sync/cancel) - لسه
// هتفشل بـPAYLOAD_ADAPTER_ERROR لحد ما adapter الحقيقي يتنفّذ، وده سلوك متوقع مش باج.
const { app, request, pool, seedUser, login, authed } = require("./helpers");

let branchId;
let cashierToken, branchManagerToken;

beforeAll(async () => {
  const b = await pool.query("INSERT INTO branches (name) VALUES ('فرع-طلبات-ريتراي-جست') RETURNING id");
  branchId = b.rows[0].id;
  await seedUser({ branchId, name: "كاشير-طلبات-ريتراي", email: "cashier-talretry@jest.test", role: "cashier" });
  cashierToken = await login("cashier-talretry@jest.test");
  await seedUser({ branchId, name: "مدير-طلبات-ريتراي", email: "manager-talretry@jest.test", role: "branch_manager" });
  branchManagerToken = await login("manager-talretry@jest.test");
});

afterAll(async () => {
  await pool.end();
});

async function seedIntegrationError(overrides = {}) {
  const res = await pool.query(
    `INSERT INTO talabat_integration_errors (talabat_order_id, branch_id, error_type, error_message, raw_payload, status)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [
      overrides.talabatOrderId || "TLB-RETRY-1",
      overrides.branchId ?? branchId,
      overrides.errorType || "MAPPING_ERROR",
      overrides.errorMessage || "test error",
      JSON.stringify(overrides.rawPayload || { order: { id: "TLB-RETRY-1" } }),
      overrides.status || "OPEN",
    ]
  );
  return res.rows[0];
}

describe("GET /api/talabat/integration-errors", () => {
  test("الكاشير معاه talabat.view - يشوف القائمة", async () => {
    await seedIntegrationError();
    const res = await request(app).get("/api/talabat/integration-errors").set(authed(cashierToken));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });
});

describe("POST /api/talabat/integration-errors/:id/retry", () => {
  test("الكاشير معندوش talabat.retry - 403", async () => {
    const err = await seedIntegrationError();
    const res = await request(app).post(`/api/talabat/integration-errors/${err.id}/retry`).set(authed(cashierToken));
    expect(res.status).toBe(403);
  });

  test("مدير الفرع معاه talabat.retry - المحاولة بتحصل، بترجع RETRY_FAILED (adapter لسه stub)، وretry_count بيزيد", async () => {
    const err = await seedIntegrationError();
    const res = await request(app).post(`/api/talabat/integration-errors/${err.id}/retry`).set(authed(branchManagerToken));
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("RETRY_FAILED");
    expect(res.body.stage).toBe("ADAPTER");

    const row = await pool.query("SELECT retry_count, last_retry_at, status FROM talabat_integration_errors WHERE id = $1", [err.id]);
    expect(row.rows[0].retry_count).toBe(1);
    expect(row.rows[0].last_retry_at).toBeTruthy();
    expect(row.rows[0].status).toBe("OPEN"); // رجع OPEN بعد فشل المحاولة - مش RETRYING متجمّد للأبد
  });

  test("خطأ RESOLVED بالفعل - مينفعش يتعاد المحاولة عليه تاني (400)", async () => {
    const err = await seedIntegrationError({ status: "RESOLVED" });
    const res = await request(app).post(`/api/talabat/integration-errors/${err.id}/retry`).set(authed(branchManagerToken));
    expect(res.status).toBe(400);
  });

  test("خطأ مش موجود - 404", async () => {
    const res = await request(app).post("/api/talabat/integration-errors/999999/retry").set(authed(branchManagerToken));
    expect(res.status).toBe(404);
  });
});
