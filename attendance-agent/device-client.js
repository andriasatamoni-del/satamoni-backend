// طبقة الاتصال بجهاز البصمة ZK نفسه عن طريق مكتبة node-zklib (بروتوكول ZKTeco/ZKSoftware القياسي عبر
// TCP/IP - بورت 4370 افتراضيًا). ⚠️ تنبيه مهم: الكود ده اتكتب على أساس الشكل الموثّق لمكتبة node-zklib
// (getAttendances() بترجع {data: [...]} فيها سجلات بصمة خام، كل سجل فيه deviceUserId + recordTime) -
// لكن **معندناش جهاز ZK حقيقي نجربه عليه من هنا** (بيئة sandboxed من غير وصول لشبكة الفرع). لازم يتجرب
// فعليًا على جهاز حقيقي، ولو أسماء الحقول في الـlogs اختلفت عن المتوقع (بتختلف شوية بين موديلات/نسخ
// firmware)، راجع getRawAttendanceLogs() تحت - فيها console.log لأول سجل خام عشان تشوف شكله الحقيقي
// وتظبط أسماء الحقول لو لازم.
const ZKLib = require("node-zklib");

class DeviceClient {
  constructor({ ip, port }) {
    this.ip = ip;
    this.port = Number(port) || 4370;
    this.zk = null;
  }

  async connect() {
    this.zk = new ZKLib(this.ip, this.port, 10000, 4000);
    await this.zk.createSocket();
  }

  async disconnect() {
    if (this.zk) {
      try { await this.zk.disconnect(); } catch (e) { /* الجهاز ممكن يكون قاطع الاتصال بالفعل - مش مشكلة */ }
      this.zk = null;
    }
  }

  // بيرجع سجلات البصمة الخام زي ما هي من الجهاز - بصمة دخول أو خروج مش متفرّقين في السجل الخام نفسه
  // (الجهاز بيسجل "لمسة" بس)، فـindex.js هو اللي بيحدد أول لمسة في اليوم = دخول وآخر لمسة = خروج
  async getRawAttendanceLogs() {
    const result = await this.zk.getAttendances();
    const logs = result?.data || [];
    if (logs.length > 0 && process.env.DEBUG_RAW_LOG === "1") {
      console.log("[device] شكل أول سجل خام من الجهاز (DEBUG_RAW_LOG=1):", JSON.stringify(logs[0]));
    }
    return logs.map((r) => ({
      // deviceUserId هو رقم/كود المستخدم اللي اتسجل بيه الموظف على الجهاز نفسه وقت التسجيل - لازم
      // يتطابق حرفيًا مع device_code المسجّل للموظف في شاشة "بصمة (استيراد وتصحيح)" بالباك إند
      deviceUserId: String(r.deviceUserId ?? r.userId ?? r.user_id ?? "").trim(),
      timestamp: r.recordTime instanceof Date ? r.recordTime : new Date(r.recordTime ?? r.timestamp),
    })).filter((r) => r.deviceUserId && !isNaN(r.timestamp.getTime()));
  }
}

module.exports = { DeviceClient };
