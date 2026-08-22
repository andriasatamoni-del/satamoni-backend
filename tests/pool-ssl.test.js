// المرحلة 7A: تأكيد إعداد SSL في db/pool.js - DB_SSL=true لازم يفعّل ssl، وغيابه (أو أي قيمة تانية)
// لازم يسيب السلوك المحلي زي ما هو (false) من غير أي تأثير على بيئة التطوير/الاختبار الحالية.
describe("db/pool.js - إعداد SSL", () => {
  const ORIGINAL_ENV = { ...process.env };

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    jest.resetModules();
    jest.dontMock("pg");
  });

  function loadPoolWithMockedPg() {
    const PoolMock = jest.fn().mockImplementation(() => ({ on: jest.fn() }));
    jest.doMock("pg", () => ({ Pool: PoolMock }));
    jest.resetModules();
    require("../db/pool");
    return PoolMock;
  }

  test("DB_SSL=true - بيفعّل ssl بـrejectUnauthorized: false", () => {
    process.env.DATABASE_URL = "postgresql://x/y";
    process.env.DB_SSL = "true";
    const PoolMock = loadPoolWithMockedPg();
    expect(PoolMock).toHaveBeenCalledWith(expect.objectContaining({ ssl: { rejectUnauthorized: false } }));
  });

  test("DB_SSL مش محدد - ssl: false (زي السلوك الأصلي قبل المرحلة دي)", () => {
    process.env.DATABASE_URL = "postgresql://x/y";
    delete process.env.DB_SSL;
    const PoolMock = loadPoolWithMockedPg();
    expect(PoolMock).toHaveBeenCalledWith(expect.objectContaining({ ssl: false }));
  });

  test("DB_SSL=false صراحة - ssl: false", () => {
    process.env.DATABASE_URL = "postgresql://x/y";
    process.env.DB_SSL = "false";
    const PoolMock = loadPoolWithMockedPg();
    expect(PoolMock).toHaveBeenCalledWith(expect.objectContaining({ ssl: false }));
  });
});
