// المرحلة 6 (6B): تقوية الأمان - CORS allowlist صريح + تحديد محاولات دخول فاشلة على /api/auth/login
// + هيدرز أمان أساسية + إخفاء تفاصيل الأخطاء الداخلية في الإنتاج
const request = require("supertest");
const { app, pool, seedUser, login } = require("./helpers");
const { getCorsOptions } = require("../middleware/cors");
const { securityHeaders } = require("../middleware/security-headers");
const { errorSanitizer } = require("../middleware/error-sanitizer");

afterAll(async () => {
  await pool.end();
});

describe("6B: CORS - allowlist صريح عن طريق CORS_ORIGINS (دالة صرفة - من غير ما نعيد تحميل التطبيق/الـpool)", () => {
  test("CORS_ORIGINS محدّد - بيرجع allowlist بالظبط بغض النظر عن NODE_ENV", () => {
    expect(getCorsOptions({ CORS_ORIGINS: "https://app.satamoni.example, https://admin.satamoni.example" }))
      .toEqual({ origin: ["https://app.satamoni.example", "https://admin.satamoni.example"] });
    expect(getCorsOptions({ CORS_ORIGINS: "https://app.satamoni.example", NODE_ENV: "production" }))
      .toEqual({ origin: ["https://app.satamoni.example"] });
  });

  test("مفيش CORS_ORIGINS + NODE_ENV=production - origin:false (يمنع أي cross-origin تمامًا)", () => {
    expect(getCorsOptions({ NODE_ENV: "production" })).toEqual({ origin: false });
  });

  test("مفيش CORS_ORIGINS + مش production (تطوير) - {} زي السلوك القديم (مفتوح لأي origin)", () => {
    expect(getCorsOptions({})).toEqual({});
    expect(getCorsOptions({ NODE_ENV: "development" })).toEqual({});
  });

  test("فحص تكاملي حقيقي: التطبيق الفعلي شغّال بالإعداد المفتوح في بيئة الاختبار (NODE_ENV=test)", async () => {
    const res = await request(app).get("/health").set("Origin", "https://anything.example");
    expect(res.headers["access-control-allow-origin"]).toBe("*");
  });
});

describe("6B: تحديد محاولات دخول فاشلة على POST /api/auth/login", () => {
  test("بعد LOGIN_MAX_ATTEMPTS محاولة غلط من نفس IP - المحاولة اللي بعدها بترجع 429 حتى ببيانات صحيحة", async () => {
    await seedUser({ name: "مستخدم-م6-أمان", email: "ratelimit-p6@jest.test", role: "admin", password: "correct-password-123" });

    const maxAttempts = Number(process.env.LOGIN_MAX_ATTEMPTS || 10);
    for (let i = 0; i < maxAttempts; i++) {
      const res = await request(app).post("/api/auth/login").send({ email: "ratelimit-p6@jest.test", password: "wrong-password" });
      expect(res.status).toBe(401);
    }
    // بعد الوصول لعدد المحاولات المسموح - حتى لو بعتنا الباسورد الصح دلوقتي، لازم يترفض بـ429
    const blocked = await request(app).post("/api/auth/login").send({ email: "ratelimit-p6@jest.test", password: "correct-password-123" });
    expect(blocked.status).toBe(429);
  });

  test("رد القفل (429) مطابق تمامًا سواء الإيميل موجود فعلًا أو وهمي - مفيش تسريب معلومة عن وجود الحساب", async () => {
    const realEmailBlocked = await request(app).post("/api/auth/login")
      .send({ email: "ratelimit-p6@jest.test", password: "x" });
    const fakeEmailBlocked = await request(app).post("/api/auth/login")
      .send({ email: "totally-fake-email-does-not-exist@jest.test", password: "x" });
    expect(realEmailBlocked.status).toBe(429);
    expect(fakeEmailBlocked.status).toBe(429);
    expect(realEmailBlocked.body.error).toBe(fakeEmailBlocked.body.error);
  });
});

describe("6B: هيدرز أمان أساسية على كل رد", () => {
  function mockReqRes() {
    const headers = {};
    return {
      req: {},
      res: { setHeader: (k, v) => { headers[k] = v; } },
      headers,
      next: jest.fn(),
    };
  }

  test("X-Content-Type-Options / X-Frame-Options / Referrer-Policy بيتحطوا دايمًا", () => {
    const { req, res, headers, next } = mockReqRes();
    securityHeaders(req, res, next);
    expect(headers["X-Content-Type-Options"]).toBe("nosniff");
    expect(headers["X-Frame-Options"]).toBe("SAMEORIGIN");
    expect(headers["Referrer-Policy"]).toBe("strict-origin-when-cross-origin");
    expect(next).toHaveBeenCalledTimes(1);
  });

  test("Strict-Transport-Security بس في الإنتاج - مش في التطوير/الاختبار عشان مايكسرش وصول HTTP محلي", () => {
    const dev = mockReqRes();
    securityHeaders(dev.req, dev.res, dev.next);
    expect(dev.headers["Strict-Transport-Security"]).toBeUndefined();

    const originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    const prod = mockReqRes();
    securityHeaders(prod.req, prod.res, prod.next);
    expect(prod.headers["Strict-Transport-Security"]).toBe("max-age=15552000; includeSubDomains");
    process.env.NODE_ENV = originalEnv;
  });

  test("فحص تكاملي حقيقي: التطبيق الفعلي بيرجّع الهيدرز دي فعلًا", async () => {
    const res = await request(app).get("/health");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["x-frame-options"]).toBe("SAMEORIGIN");
  });
});

describe("6B: إخفاء تفاصيل الأخطاء الداخلية في الإنتاج بس - الرسائل التجارية الواضحة (400 وغيرها) مش متأثرة", () => {
  function mockReqRes(statusCode) {
    const sent = [];
    const res = { statusCode, json: jest.fn((body) => { sent.push(body); return res; }) };
    const req = { method: "GET", originalUrl: "/api/test-route" };
    return { req, res, sent, next: jest.fn() };
  }

  test("في التطوير/الاختبار (مش production) - res.json مبيتغيّرش خالص، الرسالة الحقيقية بترجع زي ما هي", () => {
    const { req, res, next } = mockReqRes(500);
    const originalJson = res.json;
    errorSanitizer(req, res, next);
    expect(res.json).toBe(originalJson); // مبيتلفّش خالص - next() بس
    expect(next).toHaveBeenCalledTimes(1);
  });

  test("في الإنتاج - 500 بتفصيل داخلي (رسالة Postgres مثلًا) بيتحوّل لرسالة عامة، والتفصيل الحقيقي يتسجل في السيرفر", () => {
    const originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    const consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { req, res, sent, next } = mockReqRes(500);
      errorSanitizer(req, res, next);
      res.json({ error: 'column "internal_secret_column" does not exist' });

      expect(sent).toHaveLength(1);
      expect(sent[0].error).not.toContain("internal_secret_column"); // مفيش تفصيل داخلي وصل للعميل
      expect(sent[0].error).toContain("حصل خطأ غير متوقع"); // رسالة عامة بدلها
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining("/api/test-route"),
        'column "internal_secret_column" does not exist'
      ); // بس التفصيل الحقيقي اتسجل في لوج السيرفر، مش ضاع
    } finally {
      consoleErrorSpy.mockRestore();
      process.env.NODE_ENV = originalEnv;
    }
  });

  test("في الإنتاج - رسالة تجارية واضحة بحالة 400 (زي نقص مخزون) بتوصل للعميل زي ما هي، من غير تغيير", () => {
    const originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      const { req, res, sent, next } = mockReqRes(400);
      errorSanitizer(req, res, next);
      res.json({ error: "الرصيد الحالي مش كافي" });
      expect(sent).toEqual([{ error: "الرصيد الحالي مش كافي" }]);
    } finally {
      process.env.NODE_ENV = originalEnv;
    }
  });
});
