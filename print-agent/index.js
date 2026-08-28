// نقطة دخول الـAgent - عملية Node.js مستقلة تمامًا عن متصفح/واجهة ERP، المفروض تفضل شغالة طول الوقت على
// جهاز الفرع (حتى لو الكاشير قفل شاشة الـPOS خالص - راجع docs/PRINTING-SYSTEM.md لطريقة تشغيلها كخدمة
// Windows دائمة). بتسحب أوامر الطباعة PENDING كل POLL_INTERVAL_SECONDS، تحجزها (claim)، تطبعها فعليًا،
// وتبلّغ النتيجة - واحدة واحدة (مش متوازي) عشان لو فيه أكتر من job لنفس الطابعة يطلعوا بالترتيب الصح،
// وعشان لو Puppeteer حصله مشكلة في job واحدة الطابور كله يكمل عادي (try/catch حوالين كل job لوحدها).
require("dotenv").config();
const { ApiClient } = require("./api-client");
const { printJobContent, closeBrowser } = require("./printer");

const config = {
  baseUrl: process.env.API_BASE_URL,
  email: process.env.AGENT_EMAIL,
  password: process.env.AGENT_PASSWORD,
  branchId: process.env.BRANCH_ID,
  pollIntervalMs: (Number(process.env.POLL_INTERVAL_SECONDS) || 5) * 1000,
};

// BRANCH_ID اختياري عمدًا - لو الحساب (AGENT_EMAIL) مدير فرع، الفرع بيتحدد أوتوماتيك من الحساب نفسه
// وقت تسجيل الدخول (راجع ApiClient.login) - أسهل بكتير من ما تدوّر على رقم الفرع يدوي. لازم تحدده
// صراحة هنا بس لو الحساب أدمن (مربوط بكل الفروع، مفيش فرع واحد يتحدد منه أوتوماتيك)
for (const key of ["baseUrl", "email", "password"]) {
  if (!config[key]) {
    console.error(`[إعدادات] ناقص ${key} - راجع ملف .env (انسخ .env.example وابدأ منه)`);
    process.exit(1);
  }
}

const api = new ApiClient(config);
let stopping = false;

async function processJob(job) {
  console.log(`[job ${job.id}] طلب #${job.order_id || "-"} - ${job.print_type} - جاري الطباعة على الطابعة رقم ${job.printer_id}...`);
  try {
    const claimed = await api.claimJob(job.id);
    const printer = await api.getPrinter(claimed.printer_id);
    await printJobContent({
      html: claimed.content_html, paperWidthMm: printer.paper_width_mm, osPrinterName: printer.os_printer_name,
    });
    await api.markPrinted(job.id);
    console.log(`[job ${job.id}] تمت الطباعة بنجاح`);
  } catch (err) {
    const message = err.response?.data?.error || err.message || String(err);
    console.error(`[job ${job.id}] فشلت الطباعة: ${message}`);
    // لو claim نفسها فشلت (409 - job اتحجزت من agent تاني) مفيش داعي نبلّغ FAILED، هي أصلاً مش بتاعتنا
    if (err.response?.status !== 409) {
      try { await api.markFailed(job.id, message); } catch (e2) { console.error(`[job ${job.id}] فشل تبليغ الفشل نفسه كمان: ${e2.message}`); }
    }
  }
}

async function pollOnce() {
  const jobs = await api.listPendingJobs();
  for (const job of jobs) {
    if (stopping) return;
    await processJob(job);
  }
}

async function mainLoop() {
  console.log(`[agent] بدء التشغيل - ${config.baseUrl}`);
  await api.login();
  console.log(`[agent] بيسحب أوامر الطباعة لفرع رقم ${api.branchId}`);
  while (!stopping) {
    try {
      await pollOnce();
    } catch (err) {
      console.error(`[poll] خطأ: ${err.response?.data?.error || err.message}`);
    }
    await new Promise((r) => setTimeout(r, config.pollIntervalMs));
  }
}

async function shutdown() {
  console.log("[agent] إيقاف...");
  stopping = true;
  await closeBrowser();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

mainLoop().catch((err) => {
  console.error("[agent] خطأ قاتل:", err.message);
  process.exit(1);
});
