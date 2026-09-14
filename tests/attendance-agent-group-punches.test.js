// HR-5: اختبار وحدة لدالة تجميع بصمات جهاز ZK الخام (attendance-agent/group-punches.js) - الجزء الوحيد
// من الـAgent المحلي القابل للاختبار فعليًا من غير جهاز بصمة حقيقي (باقي الـAgent بيتواصل مع الشبكة/
// الجهاز الفعلي، مش قابل للاختبار من بيئة sandboxed). دالة نقية بحتة - مفيش قاعدة بيانات ولا شبكة هنا.
const { groupPunchesByEmployeeDay } = require("../attendance-agent/group-punches");

describe("groupPunchesByEmployeeDay", () => {
  test("لمستين لنفس الموظف في نفس اليوم -> أول لمسة دخول وآخر لمسة خروج", () => {
    const rows = groupPunchesByEmployeeDay([
      { deviceUserId: "101", timestamp: new Date("2098-01-05T10:03:00") },
      { deviceUserId: "101", timestamp: new Date("2098-01-05T18:47:00") },
    ]);
    expect(rows).toEqual([{ deviceCode: "101", date: "2098-01-05", clockIn: "10:03", clockOut: "18:47" }]);
  });

  test("لمسة واحدة بس في اليوم - clockOut null (مش تسجيل انصراف)", () => {
    const rows = groupPunchesByEmployeeDay([
      { deviceUserId: "101", timestamp: new Date("2098-01-05T10:03:00") },
    ]);
    expect(rows).toEqual([{ deviceCode: "101", date: "2098-01-05", clockIn: "10:03", clockOut: null }]);
  });

  test("أكتر من لمستين (زيارات متكررة أثناء اليوم) - أول وآخر لمسة بس بيتاخدوا، الوسط بيتجاهل", () => {
    const rows = groupPunchesByEmployeeDay([
      { deviceUserId: "101", timestamp: new Date("2098-01-05T10:03:00") },
      { deviceUserId: "101", timestamp: new Date("2098-01-05T13:00:00") },
      { deviceUserId: "101", timestamp: new Date("2098-01-05T13:30:00") },
      { deviceUserId: "101", timestamp: new Date("2098-01-05T18:47:00") },
    ]);
    expect(rows).toEqual([{ deviceCode: "101", date: "2098-01-05", clockIn: "10:03", clockOut: "18:47" }]);
  });

  test("اللمسات من غير ترتيب زمني في المصدر - بيترتبوا صح قبل ما ياخدوا أول/آخر", () => {
    const rows = groupPunchesByEmployeeDay([
      { deviceUserId: "101", timestamp: new Date("2098-01-05T18:47:00") },
      { deviceUserId: "101", timestamp: new Date("2098-01-05T10:03:00") },
    ]);
    expect(rows[0].clockIn).toBe("10:03");
    expect(rows[0].clockOut).toBe("18:47");
  });

  test("موظفين مختلفين وأيام مختلفة - كل مجموعة (موظف+يوم) بصف منفصل", () => {
    const rows = groupPunchesByEmployeeDay([
      { deviceUserId: "101", timestamp: new Date("2098-01-05T10:00:00") },
      { deviceUserId: "102", timestamp: new Date("2098-01-05T09:30:00") },
      { deviceUserId: "101", timestamp: new Date("2098-01-06T10:15:00") },
    ]);
    expect(rows.length).toBe(3);
    expect(rows.find((r) => r.deviceCode === "101" && r.date === "2098-01-05")).toBeTruthy();
    expect(rows.find((r) => r.deviceCode === "102" && r.date === "2098-01-05")).toBeTruthy();
    expect(rows.find((r) => r.deviceCode === "101" && r.date === "2098-01-06")).toBeTruthy();
  });

  test("مصفوفة فاضية -> مصفوفة فاضية", () => {
    expect(groupPunchesByEmployeeDay([])).toEqual([]);
  });
});
