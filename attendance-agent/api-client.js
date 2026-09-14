// طبقة الاتصال بالباك إند - HTTP بس، مفيش أي اتصال مباشر بقاعدة البيانات خالص (نفس فلسفة print-agent/
// api-client.js بالظبط). بيسجّل دخول بحساب مستخدم حقيقي عادي (مدير فرع - لازم يكون معاه صلاحية
// attendance.sync_device، راجع middleware/permissions.js في الباك إند) ويعيد تسجيل الدخول تلقائيًا لو
// الـtoken انتهت صلاحيته (401).
const axios = require("axios");

class ApiClient {
  constructor({ baseUrl, email, password, branchId }) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.email = email;
    this.password = password;
    this.branchId = branchId;
    this.token = null;
  }

  async login() {
    const res = await axios.post(`${this.baseUrl}/api/auth/login`, { email: this.email, password: this.password });
    this.token = res.data.token;
    console.log(`[auth] تسجيل دخول ناجح - ${res.data.user.name} (${res.data.user.role})`);
    if (!this.branchId) {
      if (!res.data.user.branchId) {
        throw new Error("الحساب ده (أدمن) مش مربوط بفرع واحد بس - لازم تحدد BRANCH_ID صراحة في ملف .env");
      }
      this.branchId = res.data.user.branchId;
      console.log(`[auth] الفرع اتحدد أوتوماتيك من الحساب: ${this.branchId}`);
    }
  }

  async request(method, path, data) {
    if (!this.token) await this.login();
    try {
      const res = await axios({
        method, url: `${this.baseUrl}${path}`, data,
        headers: { Authorization: `Bearer ${this.token}` },
        timeout: 20000,
      });
      return res.data;
    } catch (err) {
      if (err.response && err.response.status === 401) {
        console.log("[auth] الجلسة انتهت - تسجيل دخول تاني");
        await this.login();
        const res = await axios({
          method, url: `${this.baseUrl}${path}`, data,
          headers: { Authorization: `Bearer ${this.token}` },
          timeout: 20000,
        });
        return res.data;
      }
      throw err;
    }
  }

  // punches: [{deviceCode, date:'YYYY-MM-DD', clockIn:'HH:MM'|null, clockOut:'HH:MM'|null}]
  pushPunches(punches) {
    return this.request("post", "/api/attendance-sync/punches", { branchId: this.branchId, punches });
  }
}

module.exports = { ApiClient };
