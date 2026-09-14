// تجميع "لمسات" البصمة الخام (كل لمسة مجرد وقت + كود موظف، الجهاز مش بيفرّق دخول عن خروج) لكل موظف/يوم
// إلى دخول = أول لمسة و خروج = آخر لمسة (لو فيه أكتر من لمسة واحدة بس)، بنفس شكل الصف اللي endpoint
// المزامنة (POST /api/attendance-sync/punches) والاستيراد اليدوي (payroll.js) بيتوقعوه بالظبط. دالة نقية
// (pure) منفصلة عن اتصال الجهاز عمدًا عشان تتختبر من غير أي جهاز حقيقي أو حتى شبكة.
function pad2(n) { return String(n).padStart(2, "0"); }
function toDateStr(d) { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }
function toTimeStr(d) { return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`; }

// rawLogs: [{deviceUserId, timestamp: Date}] -> [{deviceCode, date, clockIn, clockOut}]
function groupPunchesByEmployeeDay(rawLogs) {
  const byKey = new Map();
  for (const log of rawLogs) {
    const dateStr = toDateStr(log.timestamp);
    const key = `${log.deviceUserId}|${dateStr}`;
    if (!byKey.has(key)) byKey.set(key, { deviceCode: log.deviceUserId, date: dateStr, times: [] });
    byKey.get(key).times.push(log.timestamp);
  }
  return [...byKey.values()].map((g) => {
    g.times.sort((a, b) => a - b);
    return {
      deviceCode: g.deviceCode,
      date: g.date,
      clockIn: toTimeStr(g.times[0]),
      clockOut: g.times.length > 1 ? toTimeStr(g.times[g.times.length - 1]) : null,
    };
  });
}

module.exports = { groupPunchesByEmployeeDay };
