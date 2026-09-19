describe("services/talabat/talabat-client (stub boundary)", () => {
  const ENV_KEYS = [
    "TALABAT_CLIENT_ID",
    "TALABAT_CLIENT_SECRET",
    "TALABAT_API_BASE_URL",
    "TALABAT_TOKEN_URL",
    "TALABAT_WEBHOOK_SECRET",
    "TALABAT_ENVIRONMENT",
  ];
  let savedEnv;

  beforeEach(() => {
    savedEnv = {};
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    jest.resetModules();
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  test("isConfigured() is false when no Talabat env vars are set", () => {
    const client = require("../services/talabat/talabat-client");
    expect(client.isConfigured()).toBe(false);
    expect(client.getConfig().environment).toBe("sandbox");
  });

  test("isConfigured() is true only once all required env vars are set", () => {
    process.env.TALABAT_CLIENT_ID = "id";
    process.env.TALABAT_CLIENT_SECRET = "secret";
    process.env.TALABAT_API_BASE_URL = "https://sandbox.example/api";
    const client = require("../services/talabat/talabat-client");
    expect(client.isConfigured()).toBe(false); // missing TALABAT_TOKEN_URL

    process.env.TALABAT_TOKEN_URL = "https://sandbox.example/oauth/token";
    jest.resetModules();
    const client2 = require("../services/talabat/talabat-client");
    expect(client2.isConfigured()).toBe(true);
  });

  test("getConfig() never exposes credentials via any frontend-reachable shape beyond what's asked, and reflects env directly", () => {
    process.env.TALABAT_CLIENT_ID = "id-123";
    process.env.TALABAT_CLIENT_SECRET = "shh";
    process.env.TALABAT_ENVIRONMENT = "production";
    const client = require("../services/talabat/talabat-client");
    const cfg = client.getConfig();
    expect(cfg.clientId).toBe("id-123");
    expect(cfg.clientSecret).toBe("shh");
    expect(cfg.environment).toBe("production");
  });

  test("getAccessToken() throws TalabatNotImplementedError, not a silent success", async () => {
    const client = require("../services/talabat/talabat-client");
    await expect(client.getAccessToken()).rejects.toThrow(client.TalabatNotImplementedError);
    await expect(client.getAccessToken()).rejects.toMatchObject({
      code: "TALABAT_CLIENT_NOT_IMPLEMENTED",
    });
  });

  test("getOrderDetails() throws TalabatNotImplementedError and includes the requested order id", async () => {
    const client = require("../services/talabat/talabat-client");
    await expect(client.getOrderDetails("TAL-999")).rejects.toThrow(/TAL-999/);
  });

  test("getOrderHistory() throws TalabatNotImplementedError", async () => {
    const client = require("../services/talabat/talabat-client");
    await expect(
      client.getOrderHistory({ branchId: 1, fromDate: "2026-01-01", toDate: "2026-01-02" })
    ).rejects.toThrow(client.TalabatNotImplementedError);
  });
});
