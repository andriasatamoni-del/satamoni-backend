// المرحلة 9A-8: اختبار تكامل حقيقي (HTTP + Postgres حقيقي) لحدود منتصف الليل بتوقيت القاهرة - بيثبّت
// إن الإصلاح فعليًا متطبّق في المسارات الحقيقية (مصروف كاشير، حالة إقفال يوم الفرع)، مش بس في الدالة
// المجرّدة. بنستخدم Jest fake timers لتثبيت "الوقت الحالي" (new Date()) بس - الـI/O الحقيقي (Postgres،
// HTTP) بيفضل شغال طبيعي عادي (doNotFake بيمنع تعطيل أي حاجة تانية غير Date نفسه)
const { app, request, pool, seedUser, login, authed } = require("./helpers");

let branchId, cashierToken, managerToken, categoryId;

beforeAll(async () => {
  const b = await pool.query("INSERT INTO branches (name) VALUES ('فرع-9A8-تاريخ') RETURNING id");
  branchId = b.rows[0].id;
  await seedUser({ branchId, name: "كاشير-9A8-تاريخ", email: "cashier-9a8date@jest.test", role: "cashier" });
  cashierToken = await login("cashier-9a8date@jest.test");
  await seedUser({ branchId, name: "مدير-9A8-تاريخ", email: "manager-9a8date@jest.test", role: "branch_manager" });
  managerToken = await login("manager-9a8date@jest.test");
  const cat = await pool.query("INSERT INTO expense_categories (name) VALUES ('بند-9A8-تاريخ') RETURNING id");
  categoryId = cat.rows[0].id;
});

afterAll(async () => {
  await pool.end();
});

afterEach(() => {
  jest.useRealTimers();
});

describe("حد منتصف الليل بتوقيت القاهرة - مصروف كاشير (9A-8)", () => {
  test("22:30 UTC (= 00:30 بتوقيت القاهرة، يوم جديد بدأ فعلًا) - business_date المسجّل يوم القاهرة مش يوم UTC", async () => {
    // 2025-03-10T22:30:00Z UTC = 2025-03-11T00:30:00+02:00 القاهرة (لسه شتاء، +2) - يوم القاهرة اتغيّر
    // فعليًا (11) بينما UTC لسه على يوم 10
    jest.useFakeTimers({
      doNotFake: [
        "nextTick", "setImmediate", "setInterval", "setTimeout", "clearTimeout", "clearInterval",
        "queueMicrotask", "performance", "hrtime",
      ],
    });
    jest.setSystemTime(new Date("2025-03-10T22:30:00Z"));

    const res = await request(app).post("/api/expenses").set(authed(cashierToken)).send({
      categoryId, amount: 50, notes: "اختبار حد منتصف الليل",
    });
    expect(res.status).toBe(201);
    expect(res.body.business_date.toString().slice(0, 10)).toBe("2025-03-11");
    expect(res.body.business_date.toString().slice(0, 10)).not.toBe("2025-03-10");
  });

  test("23:55 بتوقيت القاهرة (لسه نفس اليوم) - business_date بيفضل صحيح", async () => {
    // 2025-03-10T21:55:00Z UTC = 2025-03-10T23:55:00+02:00 القاهرة - لسه نفس اليوم في الاتنين
    jest.useFakeTimers({
      doNotFake: [
        "nextTick", "setImmediate", "setInterval", "setTimeout", "clearTimeout", "clearInterval",
        "queueMicrotask", "performance", "hrtime",
      ],
    });
    jest.setSystemTime(new Date("2025-03-10T21:55:00Z"));

    const res = await request(app).post("/api/expenses").set(authed(cashierToken)).send({
      categoryId, amount: 30, notes: "اختبار 23:55 قاهرة",
    });
    expect(res.status).toBe(201);
    expect(res.body.business_date.toString().slice(0, 10)).toBe("2025-03-10");
  });
});

describe("حد منتصف الليل بتوقيت القاهرة - حالة إقفال يوم الفرع (9A-8، كان مُصلَّح من 8.41 بس من غير اختبار)", () => {
  test("طلب اتسجل الساعة 22:30 UTC (00:30 قاهرة) - بيظهر في checklist يوم القاهرة الجديد مش يوم UTC القديم", async () => {
    jest.useFakeTimers({
      doNotFake: [
        "nextTick", "setImmediate", "setInterval", "setTimeout", "clearTimeout", "clearInterval",
        "queueMicrotask", "performance", "hrtime",
      ],
    });
    // 5 أبريل قبل بداية توقيت الصيف المصري (بيبدأ آخر جمعة في إبريل) - القاهرة UTC+2 هنا، فـ22:30 UTC
    // = 00:30 بتوقيت القاهرة يوم 6 إبريل فعليًا
    jest.setSystemTime(new Date("2025-04-05T22:30:00Z"));

    const statusRes = await request(app).get(`/api/branch-days/${branchId}/status`).set(authed(managerToken));
    expect(statusRes.status).toBe(200);
    // الديفولت المستخدم هنا لازم يكون تاريخ القاهرة (06) مش تاريخ UTC الخام (05)
    expect(statusRes.body.businessDate).toBe("2025-04-06");
  });
});
