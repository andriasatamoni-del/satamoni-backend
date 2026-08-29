// دوال بناء محتوى الطباعة (HTML كامل جاهز لورقة حرارية 80mm) - كل دالة pure function بترجع نص HTML بس،
// من غير أي اتصال بقاعدة بيانات أو شبكة. المحتوى بيتسجل في print_jobs.content_html وقت إنشاء الطلب/الحدث
// (db/print-queue.js) - مش وقت الطباعة الفعلية، عشان يفضل ثابت تاريخيًا حتى لو الطلب/المنيو اتغيّر بعد كده.
//
// نفس منطق escape/تنسيق الجنيه/عرض مكوّنات الكومبو الموجود في public/js/print-tickets.js (طباعة يدوية من
// المتصفح، Phase 7G) بالظبط - بس منسوخ هنا كنسخة Node مستقلة (module.exports مش window) عشان السيرفر
// يقدر يستخدمه وقت إنشاء print_jobs، مش المتصفح وقت الضغط على زرار.
//
// كل الأنواع الستة + TEST_PRINT بالظبط زي المواصفة: buildCustomerReceipt (فيها سعر)، buildKitchenTicket
// و buildKitchenSummary و buildDeliverySummary (من غير سعر - المطبخ/السائق مش محتاجين يعرفوا السعر)،
// buildDeliveryFinalReceipt و buildDineInBill (فيها سعر - بتتسلم للعميل).

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function money(n) {
  return Number(n || 0).toLocaleString("ar-EG", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtDate(d) {
  return new Date(d).toLocaleString("ar-EG");
}

// إطار الصفحة المشترك - 80mm عرض ورق حراري، RTL، خط واضح لماكينة حرارية (مفيش صور/تدرجات، أبيض/أسود بس)
function page(title, bodyHtml, { paperWidthMm = 80 } = {}) {
  // معظم طابعات 80mm الحرارية عرض الطباعة الفعلي عندها أقل من عرض الورق الفعلي، وممكن كمان منطقة
  // الطباعة نفسها متبقاش متمركزة بالظبط في نص عرض الرول (اتأكد فعليًا على XP-D200N: محتوى بعرض 80mm
  // كامل طلع منزّح لجنب واحد بهامش فاضي في التاني، مش بس مقطوع من الحافة). الحل الأضمن: نخلي المحتوى
  // نفسه أضيق بوضوح من عرض الصفحة المُعلَن (فرق contentWidthMm)، ونخليه في النص أفقيًا (margin: 0 auto)
  // بدل ما يكون ملزوق بحافة الصفحة - كده حتى لو منطقة الطباعة الحقيقية مش متمركزة/أضيق من المتوقع،
  // المحتوى لسه جواها ومش بيتقطع/يتزحلق لحافة واحدة بس
  const contentWidthMm = Math.max(50, paperWidthMm - 12);
  return `<!DOCTYPE html>
<html dir="rtl" lang="ar"><head><meta charset="UTF-8"><title>${esc(title)}</title>
<style>
  @page { size: ${paperWidthMm}mm auto; margin: 0; }
  * { box-sizing: border-box; }
  body { font-family: 'Segoe UI', Tahoma, Arial, sans-serif; width: ${contentWidthMm}mm; margin: 0 auto; padding: 3mm 0; color: #000; }
  h1 { font-size: 15px; margin: 0 0 2mm; text-align: center; }
  h2 { font-size: 13px; margin: 0 0 1mm; }
  .center { text-align: center; }
  .meta { font-size: 10px; color: #000; margin-bottom: 1mm; word-wrap: break-word; overflow-wrap: break-word; }
  .sep { border-top: 1px dashed #000; margin: 2mm 0; }
  /* table-layout: fixed + word-wrap - من غير كده اسم صنف طويل من غير مسافات بيوسّع الجدول أعرض من
     عرض الصفحة نفسه، وأي حاجة زايدة بتتقطع فعليًا عند حافة الطابعة بدل ما تلف سطر جديد */
  table { width: 100%; border-collapse: collapse; table-layout: fixed; }
  td, th { padding: 1mm 0; font-size: 12px; text-align: right; vertical-align: top; word-wrap: break-word; overflow-wrap: break-word; }
  td.qty, th.qty { width: 16mm; white-space: nowrap; }
  td.price, th.price { width: 18mm; white-space: nowrap; }
  .mods { font-size: 10px; color: #000; padding-right: 2mm; word-wrap: break-word; overflow-wrap: break-word; }
  .totals td { border-bottom: none; font-size: 13px; }
  .totals td.val { width: 20mm; white-space: nowrap; }
  .totals tr.grand td { font-weight: bold; font-size: 15px; border-top: 1px solid #000; padding-top: 1mm; }
  .bold { font-weight: bold; }
</style></head><body>${bodyHtml}</body></html>`;
}

function comboComponentsRows(it) {
  if (!it.combo_components || !it.combo_components.length) return "";
  return `<div class="mods">${it.combo_components
    .map((c) => `${esc(c.name)}${c.variant ? ` (${esc(c.variant)})` : ""} × ${c.quantity}`)
    .join("<br/>")}</div>`;
}

function modsLine(it) {
  return (it.modifiers || []).map((m) => `+ ${esc(m.name_at_sale)}`).join("، ");
}

// جدول أصناف من غير سعر - للمطبخ/ملخص المطبخ/ملخص الدليفري (المطبخ/السائق مش لازم يشوفوا السعر)
function itemsTableNoPrice(items) {
  const rows = items.map((it) => {
    const name = it.item_name || it.combo_name || "صنف";
    const variant = it.variant_label ? ` (${esc(it.variant_label)})` : "";
    const mods = modsLine(it);
    return `<tr>
        <td>${esc(name)}${variant}${mods ? `<div class="mods">${mods}</div>` : ""}${comboComponentsRows(it)}</td>
        <td class="qty">× ${it.quantity}</td>
      </tr>`;
  }).join("");
  return `<table>${rows}</table>`;
}

// جدول أصناف بسعر - للإيصال/الفاتورة (فيها سعر بيتسلّم للعميل)
function itemsTableWithPrice(items) {
  const rows = items.map((it) => {
    const name = it.item_name || it.combo_name || "صنف";
    const variant = it.variant_label ? ` (${esc(it.variant_label)})` : "";
    const mods = (it.modifiers || [])
      .map((m) => `+ ${esc(m.name_at_sale)}${Number(m.price_at_sale) > 0 ? ` (${money(m.price_at_sale)})` : ""}`)
      .join("، ");
    return `<tr>
        <td>${esc(name)}${variant} × ${it.quantity}${mods ? `<div class="mods">${mods}</div>` : ""}${comboComponentsRows(it)}</td>
        <td class="price">${money(it.line_total)}</td>
      </tr>`;
  }).join("");
  return `<table>${rows}</table>`;
}

function totalsBlock(order) {
  const rows = [];
  rows.push(`<tr><td>الإجمالي الفرعي</td><td class="val">${money(order.subtotal)}</td></tr>`);
  if (Number(order.delivery_fee) > 0) rows.push(`<tr><td>رسوم التوصيل</td><td class="val">${money(order.delivery_fee)}</td></tr>`);
  if (Number(order.discount) > 0) rows.push(`<tr><td>الخصم</td><td class="val">-${money(order.discount)}</td></tr>`);
  if (Number(order.loyalty_redeem_value) > 0) rows.push(`<tr><td>نقاط ولاء مستخدمة</td><td class="val">-${money(order.loyalty_redeem_value)}</td></tr>`);
  if (Number(order.vat_amount) > 0) rows.push(`<tr><td>منها ضريبة قيمة مضافة</td><td class="val">${money(order.vat_amount)}</td></tr>`);
  rows.push(`<tr class="grand"><td>الإجمالي</td><td class="val">${money(order.total)}</td></tr>`);
  return `<table class="totals">${rows.join("")}</table>`;
}

function headerMeta(order, { orderTypeLabel, branchLabel, extraTitle } = {}) {
  return `
    <div class="meta">${branchLabel ? esc(branchLabel) + " — " : ""}${fmtDate(order.created_at)}</div>
    <div class="meta">طلب #${order.id}${orderTypeLabel ? ` — ${esc(orderTypeLabel)}` : ""}${extraTitle ? ` — ${esc(extraTitle)}` : ""}</div>
    ${order.customer_name || order.customer_phone ? `<div class="meta">العميل: ${esc(order.customer_name) || "—"} — ${esc(order.customer_phone) || "—"}</div>` : ""}
    ${order.table_number ? `<div class="meta">ترابيزة: ${esc(order.table_number)}</div>` : ""}
    ${order.address_details ? `<div class="meta">العنوان: ${esc(order.address_details)}</div>` : ""}
  `;
}

// 1) إيصال العميل (تيك أواي/صالة عادي) - فيها سعر، بتتسلّم للعميل وقت تأكيد الطلب
function buildCustomerReceipt({ order, items, paymentMethodLabel, branchLabel, orderTypeLabel }) {
  const body = `
    <h1>ستاموني</h1>
    ${headerMeta(order, { orderTypeLabel, branchLabel })}
    <div class="sep"></div>
    ${itemsTableWithPrice(items)}
    <div class="sep"></div>
    ${totalsBlock(order)}
    <div class="meta" style="margin-top:2mm">طريقة الدفع: ${esc(paymentMethodLabel) || "—"}</div>
  `;
  return page(`إيصال #${order.id}`, body);
}

// 2) تذكرة تحضير مطبخ لمحطة واحدة - من غير سعر، أصناف المحطة دي بس (تفلترة قبل النداء)
function buildKitchenTicket({ order, items, stationName, branchLabel, orderTypeLabel }) {
  const body = `
    <h2 class="center bold">${esc(stationName || "المطبخ")}</h2>
    ${headerMeta(order, { orderTypeLabel, branchLabel })}
    <div class="sep"></div>
    ${itemsTableNoPrice(items)}
  `;
  return page(`تذكرة ${stationName || "مطبخ"} #${order.id}`, body);
}

// 3) ملخص مطبخ - كل أصناف الطلب في تذكرة واحدة مجمّعة (من غير سعر) - مرجع سريع لكل المحطات مع بعض
function buildKitchenSummary({ order, items, branchLabel, orderTypeLabel }) {
  const body = `
    <h2 class="center bold">ملخص المطبخ - كل الأصناف</h2>
    ${headerMeta(order, { orderTypeLabel, branchLabel })}
    <div class="sep"></div>
    ${itemsTableNoPrice(items)}
  `;
  return page(`ملخص مطبخ #${order.id}`, body);
}

// 4) ملخص دليفري - من غير سعر، للمطبخ/نقطة التجهيز قبل ما السائق ياخد الطلب (عنوان + أصناف، بلا فلوس)
function buildDeliverySummary({ order, items, branchLabel }) {
  const body = `
    <h2 class="center bold">ملخص دليفري - تجهيز</h2>
    ${headerMeta(order, { orderTypeLabel: "دليفري", branchLabel })}
    <div class="sep"></div>
    ${itemsTableNoPrice(items)}
  `;
  return page(`ملخص دليفري #${order.id}`, body);
}

// 5) إيصال دليفري نهائي - فيها سعر، بتتطبع لحظة تسليم الطلب للسائق (هو اللي بيسلّمها للعميل)
function buildDeliveryFinalReceipt({ order, items, paymentMethodLabel, branchLabel }) {
  const body = `
    <h1>ستاموني</h1>
    ${headerMeta(order, { orderTypeLabel: "دليفري", branchLabel })}
    <div class="sep"></div>
    ${itemsTableWithPrice(items)}
    <div class="sep"></div>
    ${totalsBlock(order)}
    <div class="meta" style="margin-top:2mm">طريقة الدفع: ${esc(paymentMethodLabel) || "—"}</div>
  `;
  return page(`إيصال دليفري #${order.id}`, body);
}

// 6) فاتورة صالة (Bill) - فيها سعر، بتتطبع بناءً على طلب الجرسون قبل الدفع
function buildDineInBill({ order, items, branchLabel }) {
  const body = `
    <h1>ستاموني</h1>
    ${headerMeta(order, { orderTypeLabel: "صالة", branchLabel })}
    <div class="sep"></div>
    ${itemsTableWithPrice(items)}
    <div class="sep"></div>
    ${totalsBlock(order)}
  `;
  return page(`فاتورة صالة #${order.id}`, body);
}

// 7) طباعة تجريبية - بتتطبع من شاشة إدارة الطابعات (زرار "Test Print") للتأكد إن الطابعة متوصلة ومتظبطة صح
function buildTestPrint({ printerName, branchLabel }) {
  const body = `
    <h1>ستاموني</h1>
    <h2 class="center bold">طباعة تجريبية</h2>
    <div class="meta center">${esc(printerName || "")}</div>
    <div class="meta center">${branchLabel ? esc(branchLabel) : ""}</div>
    <div class="meta center">${fmtDate(new Date())}</div>
    <div class="sep"></div>
    <div class="center">إذا ظهرت هذه الورقة بشكل صحيح، الطابعة تعمل بنجاح</div>
  `;
  return page("طباعة تجريبية", body);
}

module.exports = {
  esc, money,
  buildCustomerReceipt, buildKitchenTicket, buildKitchenSummary,
  buildDeliverySummary, buildDeliveryFinalReceipt, buildDineInBill, buildTestPrint,
};
