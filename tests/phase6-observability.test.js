// المرحلة 6 (6F): مراقبة - /health بيتحقق فعليًا من قاعدة البيانات، تسجيل منظّم لكل طلب (من غير أي
// سر خالص)، حد تنبيه للطلبات البطيئة قابل للتحكم، وpool.on('error') بيمنع طيحان السيرفر كله
const { app, request, pool, seedUser, login, authed } = require("./helpers");
const { requestLogger } = require("../middleware/request-logger");

afterAll(async () => {
  await pool.end();
});

describe("6F: GET /health - بيتحقق فعليًا من قاعدة البيانات، مش رد ثابت دايمًا", () => {
  test("قاعدة البيانات شغالة فعليًا - 200 و db:ok", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok", db: "ok" });
  });

  test("قاعدة البيانات مش متاحة - 503 و db:unreachable، من غير تسريب أي تفصيل داخلي (رسالة الخطأ الحقيقية)", async () => {
    const spy = jest.spyOn(pool, "query").mockRejectedValueOnce(
      new Error("connection refused to internal-db-host.internal:5432 (password=super-secret-value)")
    );
    const res = await request(app).get("/health");
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ status: "degraded", db: "unreachable" });
    // نتأكد صراحة إن التفصيل الداخلي (اسم الهوست/الباسورد) مش موجود في الرد للعميل خالص
    expect(JSON.stringify(res.body)).not.toContain("super-secret-value");
    expect(JSON.stringify(res.body)).not.toContain("internal-db-host");
    spy.mockRestore();
  });
});

describe("6F: pool.on('error') - خطأ على مستوى الـpool (اتصال idle اتقطع) مبيطيّحش الـprocess", () => {
  test("إطلاق event 'error' على الـpool - بيتسجل بس، مفيش uncaught exception", () => {
    // لو الـhandler مش موجود، الـEventEmitter هيرمي الخطأ ده كـuncaught exception فورًا (سلوك Node
    // القياسي لـevent اسمه 'error' من غير listener) - ده كان هيطيح كل عملية جيست نفسها لو حصل.
    // وصولنا للسطر ده بعد emit يعني الـhandler موجود وشغال صح
    expect(() => {
      pool.emit("error", new Error("simulated idle client connection error"));
    }).not.toThrow();
  });
});

describe("6F: تسجيل منظّم للطلبات (structured logging) - JSON واحد لكل طلب، من غير أي سر", () => {
  test("طلب عادي ناجح - بيتسجل console.log بصيغة JSON فيها method/path/statusCode/durationMs، مفيش أي كلمة سر فيه", async () => {
    const logSpy = jest.spyOn(console, "log").mockImplementation(() => {});
    await request(app).get("/health");
    const relevantCall = logSpy.mock.calls.find((args) => {
      try { return JSON.parse(args[0]).path === "/health"; } catch { return false; }
    });
    expect(relevantCall).toBeTruthy();
    const entry = JSON.parse(relevantCall[0]);
    expect(entry).toMatchObject({ method: "GET", path: "/health", statusCode: 200, event: "request" });
    expect(typeof entry.durationMs).toBe("number");
    logSpy.mockRestore();
  });

  test("محاولة دخول غلط (401) - بتتسجل بحدث auth_failure عن طريق console.warn", async () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    await request(app).get("/api/auth/me"); // من غير توكن - 401
    const relevantCall = warnSpy.mock.calls.find((args) => {
      try { return JSON.parse(args[0]).path === "/api/auth/me"; } catch { return false; }
    });
    expect(relevantCall).toBeTruthy();
    expect(JSON.parse(relevantCall[0]).event).toBe("auth_failure");
    warnSpy.mockRestore();
  });

  test("لوج الدخول بباسورد غلط - مفيش الباسورد نفسها ولا أي حقل من الـbody في اللوج خالص", async () => {
    const logSpy = jest.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    await request(app).post("/api/auth/login").send({ email: "someone@jest.test", password: "this-is-a-very-secret-password-12345" });
    const allLoggedText = [...logSpy.mock.calls, ...warnSpy.mock.calls].map((args) => args[0]).join("\n");
    expect(allLoggedText).not.toContain("this-is-a-very-secret-password-12345");
    logSpy.mockRestore();
    warnSpy.mockRestore();
  });

  test("طلب أبطأ من الحد المسموح (SLOW_REQUEST_THRESHOLD_MS) - بيتسجل تحذير slow_request", async () => {
    process.env.SLOW_REQUEST_THRESHOLD_MS = "1"; // أي حاجة هتبقى "بطيئة" بالحد ده
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    await request(app).get("/health");
    const relevantCall = warnSpy.mock.calls.find((args) => {
      try { return JSON.parse(args[0]).path === "/health" && JSON.parse(args[0]).event === "slow_request"; } catch { return false; }
    });
    expect(relevantCall).toBeTruthy();
    warnSpy.mockRestore();
    delete process.env.SLOW_REQUEST_THRESHOLD_MS;
  });

  test("نفس الطلب بحد افتراضي عادي (1000ms) - مبيتسجلش كـslow_request", async () => {
    delete process.env.SLOW_REQUEST_THRESHOLD_MS;
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    await request(app).get("/health");
    const slowCall = warnSpy.mock.calls.find((args) => {
      try { return JSON.parse(args[0]).event === "slow_request"; } catch { return false; }
    });
    expect(slowCall).toBeFalsy();
    warnSpy.mockRestore();
  });
});
