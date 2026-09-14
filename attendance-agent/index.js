// نقطة دخول الـAgent - عملية Node.js مستقلة تمامًا عن متصفح/واجهة ERP، المفروض تفضل شغالة طول الوقت على
// جهاز/سيرفر الفرع (نفس فلسفة print-agent/index.js بالظبط). بتتصل بجهاز البصمة ZK كل POLL_INTERVAL_SECONDS
// عن طريق الشبكة المحلية، تسحب البصمات الخام لآخر LOOKBACK_DAYS يوم، تجمّعها لدخول/خروج لكل موظف/يوم،
// وتبعتها دفعة واحدة لـPOST /api/attendance-sync/punches - upsert آمن (تكرار نفس اليوم مش بيكرر صف).
require("dotenv").config();
const { ApiClient } = require("./api-client");
const { DeviceClient } = require("./device-client");
const { groupPunchesByEmployeeDay } = require("./group-punches");

const config = {
  baseUrl: process.env.API_BASE_URL,
  email: process.env.AGENT_EMAIL,
  password: process.env.AGENT_PASSWORD,
  branchId: process.env.BRANCH_ID,
  deviceIp: process.env.ZK_DEVICE_IP,
  devicePort: process.env.ZK_DEVICE_PORT,
  pollIntervalMs: (Number(process.env.POLL_INTERVAL_SECONDS) || 300) * 1000,
  lookbackDays: Number(process.env.LOOKBACK_DAYS) || 2,
};

for (const key of ["baseUrl", "email", "password", "deviceIp"]) {
  if (!config[key]) {
    console.error(`[إعدادات] ناقص ${key} - راجع ملف .env (انسخ .env.example وابدأ منه)`);
    process.exit(1);
  }
}

const api = new ApiClient(config);
let stopping = false;

async function syncOnce() {
  const device = new DeviceClient({ ip: config.deviceIp, port: config.devicePort });
  await device.connect();
  let rawLogs;
  try {
    rawLogs = await device.getRawAttendanceLogs();
  } finally {
    await device.disconnect();
  }

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - config.lookbackDays);
  cutoff.setHours(0, 0, 0, 0);
  const recentLogs = rawLogs.filter((r) => r.timestamp >= cutoff);

  if (recentLogs.length === 0) {
    console.log(`[sync] مفيش بصمات جديدة في آخر ${config.lookbackDays} يوم`);
    return;
  }

  const punches = groupPunchesByEmployeeDay(recentLogs);
  const result = await api.pushPunches(punches);
  console.log(`[sync] اتبعت ${punches.length} صف يوم/موظف - السيرفر قبل ${result.imported} واستبعد ${result.skipped}`);
}

async function mainLoop() {
  console.log(`[agent] بدء التشغيل - ${config.baseUrl} <- جهاز البصمة ${config.deviceIp}:${config.devicePort || 4370}`);
  await api.login();
  console.log(`[agent] بيزامن بصمة فرع رقم ${api.branchId} كل ${config.pollIntervalMs / 1000} ثانية`);
  while (!stopping) {
    try {
      await syncOnce();
    } catch (err) {
      console.error(`[sync] خطأ: ${err.response?.data?.error || err.message}`);
    }
    await new Promise((r) => setTimeout(r, config.pollIntervalMs));
  }
}

function shutdown() {
  console.log("[agent] إيقاف...");
  stopping = true;
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

mainLoop().catch((err) => {
  console.error("[agent] خطأ قاتل:", err.message);
  process.exit(1);
});
