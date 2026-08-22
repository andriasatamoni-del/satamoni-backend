// المرحلة 6 (6F): تسجيل منظّم (structured logging) لكل طلب - سطر JSON واحد لكل طلب في console
// (بدون أي مكتبة جديدة - JSON.stringify بسيط كافي هنا، ومكتبة تسجيل أكبر ممكن تتضاف لاحقًا لو
// احتجنا تجميع/بحث مركزي، ده مش مبرر دلوقتي). بيسجل method/path/statusCode/durationMs/userId/
// branchId فقط - عمدًا مفيش تسجيل لمحتوى body/query خالص، عشان مفيش احتمال تسريب باسورد/PIN/JWT/
// أي سر حتى لو حد ضاف حقل حساس لـendpoint جديد بعدين من غير ما يفتكر يستثنيه من اللوج - الأمان هنا
// بالتصميم (by construction) مش بالاستثناء اليدوي.
function requestLogger(req, res, next) {
  const startedAt = process.hrtime.bigint();
  res.on("finish", () => {
    // بيتقرا من process.env في كل طلب، مش ثابت وقت تحميل الموديول - عشان يتقدر يتاختبر بسهولة
    // بتغيير المتغير، ولو حد غيّره وقت تشغيل السيرفر (نادر بس ممكن) بياخد أثره على طول
    const slowThresholdMs = Number(process.env.SLOW_REQUEST_THRESHOLD_MS || 1000);
    const durationMs = Math.round(Number(process.hrtime.bigint() - startedAt) / 1e6);
    const entry = {
      timestamp: new Date().toISOString(),
      method: req.method,
      path: req.originalUrl,
      statusCode: res.statusCode,
      durationMs,
      userId: req.user ? req.user.id : null,
      branchId: req.user ? req.user.branchId : null,
    };

    if (res.statusCode === 401 || res.statusCode === 403) {
      console.warn(JSON.stringify({ ...entry, event: "auth_failure" }));
    } else if (res.statusCode >= 500) {
      console.error(JSON.stringify({ ...entry, event: "server_error" }));
    } else if (durationMs >= slowThresholdMs) {
      console.warn(JSON.stringify({ ...entry, event: "slow_request", thresholdMs: slowThresholdMs }));
    } else {
      console.log(JSON.stringify({ ...entry, event: "request" }));
    }
  });
  next();
}

module.exports = { requestLogger };
