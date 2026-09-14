// المرحلة 9A-8: اختبار وحدة مباشر لـ db/business-date.js - التركيز على حدود منتصف الليل بتوقيت القاهرة
// (Africa/Cairo هي UTC+2 شتاءً، UTC+3 صيفًا بتوقيت DST المصري - مصر بترجع تطبّق DST من 2023) حيث UTC
// وتوقيت القاهرة بيختلفوا في التاريخ فعليًا
const { getCairoBusinessDate } = require("../db/business-date");

describe("getCairoBusinessDate (9A-8)", () => {
  test("منتصف الليل بتوقيت القاهرة (23:55 قاهرة = لسه إمبارح بتوقيت UTC لو +2) - يرجع تاريخ القاهرة مش UTC", () => {
    // 2025-01-15 23:55 بتوقيت القاهرة (UTC+2 شتاءً) = 2025-01-15 21:55 UTC (نفس اليوم بالصدفة هنا،
    // لازم نختار وقت بعد نص الليل بتوقيت القاهرة عشان الاختلاف الحقيقي يظهر)
    const justAfterMidnightCairo = new Date("2025-01-16T00:05:00+02:00"); // 2025-01-15T22:05:00Z UTC
    expect(justAfterMidnightCairo.toISOString().slice(0, 10)).toBe("2025-01-15"); // UTC بيقول لسه إمبارح
    expect(getCairoBusinessDate(justAfterMidnightCairo)).toBe("2025-01-16"); // القاهرة بتقول اليوم الجديد بدأ فعلًا
  });

  test("23:55 بتوقيت القاهرة - يرجع تاريخ القاهرة الصحيح (لسه نفس اليوم)", () => {
    const beforeMidnightCairo = new Date("2025-01-15T23:55:00+02:00"); // 2025-01-15T21:55:00Z UTC
    expect(getCairoBusinessDate(beforeMidnightCairo)).toBe("2025-01-15");
  });

  test("من غير أي معامل - بيستخدم الوقت الحالي فعليًا (يرجع سترينج بصيغة YYYY-MM-DD صحيحة)", () => {
    const result = getCairoBusinessDate();
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test("نفس اللحظة بالظبط بتوقيت الصيف (UTC+3) - لسه بتحسب صح", () => {
    const summerJustAfterMidnight = new Date("2025-07-16T00:30:00+03:00"); // 2025-07-15T21:30:00Z UTC
    expect(summerJustAfterMidnight.toISOString().slice(0, 10)).toBe("2025-07-15");
    expect(getCairoBusinessDate(summerJustAfterMidnight)).toBe("2025-07-16");
  });
});
