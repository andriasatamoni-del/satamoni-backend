// طبقة الاتصال بالباك إند - HTTP بس، مفيش أي اتصال مباشر بقاعدة البيانات خالص (زي ما اتطلب صراحة في
// المواصفة). بيسجّل دخول بحساب مستخدم حقيقي عادي (مدير فرع/أدمن - لازم يكون معاه صلاحية
// print_jobs.manage_queue، راجع middleware/permissions.js في الباك إند) ويعيد تسجيل الدخول تلقائيًا لو
// الـtoken انتهت صلاحيته (401).
const axios = require("axios");

class ApiClient {
  constructor({ baseUrl, email, password, branchId }) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.email = email;
    this.password = password;
    this.branchId = branchId;
    this.token = null;
    this.printersCache = new Map();
  }

  async login() {
    const res = await axios.post(`${this.baseUrl}/api/auth/login`, { email: this.email, password: this.password });
    this.token = res.data.token;
    console.log(`[auth] تسجيل دخول ناجح - ${res.data.user.name} (${res.data.user.role})`);
  }

  async request(method, path, data) {
    if (!this.token) await this.login();
    try {
      const res = await axios({
        method, url: `${this.baseUrl}${path}`, data,
        headers: { Authorization: `Bearer ${this.token}` },
        timeout: 15000,
      });
      return res.data;
    } catch (err) {
      if (err.response && err.response.status === 401) {
        console.log("[auth] الجلسة انتهت - تسجيل دخول تاني");
        await this.login();
        const res = await axios({
          method, url: `${this.baseUrl}${path}`, data,
          headers: { Authorization: `Bearer ${this.token}` },
          timeout: 15000,
        });
        return res.data;
      }
      throw err;
    }
  }

  listPendingJobs() {
    return this.request("get", `/api/print-jobs?branchId=${this.branchId}&status=PENDING&limit=50`);
  }

  claimJob(id) {
    return this.request("post", `/api/print-jobs/${id}/claim`);
  }

  markPrinted(id) {
    return this.request("post", `/api/print-jobs/${id}/printed`);
  }

  markFailed(id, error) {
    return this.request("post", `/api/print-jobs/${id}/failed`, { error: String(error).slice(0, 500) });
  }

  // اسم الطابعة بالظبط زي ما هو في نظام التشغيل (os_printer_name) + عرض الورق - مبني على printerId
  // اللي راجع في الـjob نفسه. مخزّن مؤقتًا (cache) عشان مانسألش الباك إند على نفس الطابعة كل مرة
  async getPrinter(printerId) {
    if (this.printersCache.has(printerId)) return this.printersCache.get(printerId);
    const printers = await this.request("get", `/api/printers?branchId=${this.branchId}`);
    for (const p of printers) this.printersCache.set(p.id, p);
    if (!this.printersCache.has(printerId)) {
      throw new Error(`الطابعة رقم ${printerId} مش موجودة في فرع ${this.branchId} - راجع الإعدادات`);
    }
    return this.printersCache.get(printerId);
  }

  invalidatePrinterCache() {
    this.printersCache.clear();
  }
}

module.exports = { ApiClient };
