// PHASE UI-1: خريطة رموز أخطاء API إلى رسائل عربية واضحة - للاستخدام في شاشات الطلبيات (الفرع والسنتر
// كيتشن). المصدر الوحيد للحقيقة هو رد الـbackend (error/code) - الملف ده بس بيترجم الـcode المعروف لرسالة
// أوضح للمستخدم النهائي، من غير ما يخمّن أو يعيد بناء أي منطق عمل. لو الـcode مش معروف، بيرجع رسالة
// الـbackend الخام (error) زي ما هي - نفس سلوك الصفحات القديمة اللي معندهاش code أصلًا
const REQUISITION_ERROR_MESSAGES = {
  DISCREPANCY_VALIDATION: (msg) => msg,
  INSUFFICIENT_STOCK: () => "الكمية المطلوبة أكبر من المتاح فعليًا في المخزون - راجع الرصيد قبل ما تكمل.",
  FORBIDDEN_BRANCH: () => "معندكش صلاحية على فرع تاني.",
  INVALID_PARAMETER: (msg) => msg,
  PICKING_VALIDATION: (msg) => msg,
  // PHASE UI-2: رموز المشتريات - نفس الملف المشترك (مطلوب صراحة إعادة استخدامه بدل عمل واحد جديد)
  OVER_RECEIVE_NEEDS_APPROVAL: (msg) => msg,
  DUPLICATE_INVOICE_NUMBER: () => "رقم الفاتورة ده مسجّل بالفعل لنفس المورد - تأكد من الرقم قبل ما تحفظ تاني.",
  INVOICE_PAYMENT_VALIDATION: (msg) => msg,
  // PHASE UI-3: رموز التصنيع/التعبئة - نفس الملف المشترك برضو (نفس مبدأ UI-2)
  VARIANCE_REASON_REQUIRED: (msg) => msg,
  PRODUCTION_VALIDATION: (msg) => msg,
};

// بيرجع {message, code} جاهزة للعرض - مبني على شكل الخطأ اللي بيرميه helper الـapi() في كل صفحة (Error
// عادي بـmessage بس، أو Error معاه .code لو الاستجابة فيها code). status اختياري (401/403/404/409/500) -
// بيتستخدم كـfallback بس لو مفيش code معروف ولا رسالة من السيرفر
function describeRequisitionError(err, status) {
  const code = err && err.code ? err.code : null;
  const rawMessage = (err && err.message) || "حصل خطأ غير متوقع";
  if (code && REQUISITION_ERROR_MESSAGES[code]) {
    return { message: REQUISITION_ERROR_MESSAGES[code](rawMessage), code };
  }
  if (status === 401) return { message: "انتهت الجلسة - سجل دخول تاني", code: "UNAUTHENTICATED" };
  if (status === 409) return { message: "العملية دي اتنفذت بالفعل من مكان تاني - حدّث الصفحة وتأكد.", code: "CONFLICT" };
  if (status >= 500) return { message: "حصل خطأ في السيرفر - جرّب تاني بعد شوية.", code: "SERVER_ERROR" };
  return { message: rawMessage, code };
}
