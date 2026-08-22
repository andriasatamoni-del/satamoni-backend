// المرحلة 6 (6I): جاهزية النشر - فحص متغيرات البيئة عند الإقلاع (رسالة واضحة بدل استثناء مبهم أو
// سيرفر شغال بس مش شغال فعليًا)، والإيقاف الآمن (graceful shutdown) عند SIGTERM/SIGINT - وقف استقبال
// اتصالات جديدة، استنى الطلبات الجارية، اقفل pg pool، اخرج بكود نظيف
const { validateEnv } = require("../db/env-validation");
const { spawn } = require("child_process");
const path = require("path");
const http = require("http");
const { TEST_DATABASE_URL } = require("./db-config");

describe("6I: validateEnv - فحص متغيرات البيئة عند الإقلاع", () => {
  test("كل حاجة مظبوطة - مفيش errors ولا warnings", () => {
    const result = validateEnv({ DATABASE_URL: "postgresql://x", JWT_SECRET: "a-very-long-random-secret-value" });
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  test("DATABASE_URL ناقصة - error واضح", () => {
    const result = validateEnv({ JWT_SECRET: "a-very-long-random-secret-value" });
    expect(result.errors.some((e) => e.includes("DATABASE_URL"))).toBe(true);
  });

  test("JWT_SECRET ناقصة - error واضح", () => {
    const result = validateEnv({ DATABASE_URL: "postgresql://x" });
    expect(result.errors.some((e) => e.includes("JWT_SECRET"))).toBe(true);
  });

  test("JWT_SECRET قصيرة - warning مش error (السيرفر لسه يقدر يشتغل)", () => {
    const result = validateEnv({ DATABASE_URL: "postgresql://x", JWT_SECRET: "short" });
    expect(result.errors).toEqual([]);
    expect(result.warnings.some((w) => w.includes("قصيرة"))).toBe(true);
  });

  test("NODE_ENV بقيمة غريبة - warning", () => {
    const result = validateEnv({ DATABASE_URL: "postgresql://x", JWT_SECRET: "a-very-long-random-secret-value", NODE_ENV: "staging-typo" });
    expect(result.warnings.some((w) => w.includes("NODE_ENV"))).toBe(true);
  });

  test("إنتاج من غير CORS_ORIGINS - warning بس (الافتراضي آمن أصلًا) مش error", () => {
    const result = validateEnv({ DATABASE_URL: "postgresql://x", JWT_SECRET: "a-very-long-random-secret-value", NODE_ENV: "production" });
    expect(result.errors).toEqual([]);
    expect(result.warnings.some((w) => w.includes("CORS_ORIGINS"))).toBe(true);
  });

  test("إنتاج بمفتاح JWT_SECRET بتاع الاختبار الافتراضي - error (خطر أمان حقيقي)", () => {
    const result = validateEnv({ DATABASE_URL: "postgresql://x", JWT_SECRET: "jest_test_secret_do_not_use_in_production", NODE_ENV: "production" });
    expect(result.errors.some((e) => e.includes("JWT_SECRET"))).toBe(true);
  });

  test("PORT مش رقم صالح - error", () => {
    const result = validateEnv({ DATABASE_URL: "postgresql://x", JWT_SECRET: "a-very-long-random-secret-value", PORT: "abc" });
    expect(result.errors.some((e) => e.includes("PORT"))).toBe(true);
  });
});

describe("6I: الإيقاف الآمن (graceful shutdown) - process حقيقي فرعي بيستقبل SIGTERM", () => {
  test("SIGTERM - السيرفر بيوقف استقبال اتصالات جديدة، بيقفل pg pool، وبيخرج بكود 0 من غير ما يعلّق", (done) => {
    const PORT = 4599;
    const child = spawn("node", [path.join(__dirname, "..", "server.js")], {
      env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL, JWT_SECRET: "deployment-test-secret-value-long-enough", PORT: String(PORT), NODE_ENV: "test" },
      cwd: path.join(__dirname, ".."),
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    const hardTimeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill("SIGKILL");
        done(new Error(`Server didn't shut down in time. stdout: ${stdout}\nstderr: ${stderr}`));
      }
    }, 15000);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      if (stdout.includes(`running on port ${PORT}`)) {
        // السيرفر شغال فعليًا - نتأكد إنه بيرد على health check الأول، وبعدين نبعت SIGTERM
        setTimeout(() => {
          http.get(`http://127.0.0.1:${PORT}/health`, (res) => {
            expect(res.statusCode).toBe(200);
            child.kill("SIGTERM");
          }).on("error", (err) => {
            if (!settled) {
              settled = true;
              clearTimeout(hardTimeout);
              done(new Error(`${err.message}\nstdout: ${stdout}\nstderr: ${stderr}`));
            }
          });
        }, 200);
      }
    });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });

    child.on("exit", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(hardTimeout);
      try {
        expect(code).toBe(0); // خروج نظيف، مش SIGKILL ولا كود خطأ
        expect(signal).toBeNull();
        expect(stdout).toMatch(/\[shutdown\].*SIGTERM/);
        expect(stdout).toMatch(/اتقفل pg pool/);
        done();
      } catch (assertionErr) {
        done(assertionErr);
      }
    });
  }, 20000);
});
