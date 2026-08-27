// المرحلة 7G: وحدة طباعة مشتركة - تذكرة تحضير المطبخ + إيصال الكاشير.
// بتحل مشكلة كانت موجودة في 3 نسخ متكررة من نفس الكود (satamoni-pos.html وsatamoni-delivery.html
// وsatamoni-callcenter.html): كانوا بيعملوا window.open() ويكتبوا شكل التذكرة بـ"جاري التحميل..."
// مكان الأصناف، وبعدين window.onload بيطبع فورًا - يعني الطباعة الفعلية كانت بتطلع بالنص "جاري
// التحميل..." مش الأصناف الحقيقية، لأن fetch تفاصيل الطلب (async) لسه ما خلصش وقت ما window.onload اتنادى.
// الحل هنا: window.open() لسه بيتنفذ فورًا (نفس اللحظة اللي المستخدم ضغط فيها الزرار - عشان متاح
// popup blockers)، بس الطباعة نفسها (win.print()) بقت بتتنادى يدويًا بعد ما البيانات توصل فعليًا
// وتتملى في الصفحة، مش معلّقة على window.onload خالص.
//
// معمول كـ<script> عادي (مش module) عشان يتحمّل بسهولة في الصفحات القديمة من غير تغيير نوع باقي السكريبتات.

(function () {
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  function money(n) {
    return Number(n || 0).toLocaleString("ar-EG", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function openPrintWindow(title) {
    const win = window.open("", "_blank", "width=380,height=600");
    if (!win) {
      alert("المتصفح منع فتح نافذة الطباعة - سمح بالنوافذ المنبثقة لهذا الموقع وحاول تاني");
      return null;
    }
    win.document.write(`
      <html dir="rtl" lang="ar"><head><meta charset="UTF-8"><title>${esc(title)}</title>
      <style>
        body { font-family: 'Segoe UI', Tahoma, Arial, sans-serif; padding: 16px; }
        h2 { margin: 0 0 4px; }
        .meta { font-size: 13px; color: #444; margin-bottom: 6px; }
        table { width: 100%; border-collapse: collapse; margin-top: 10px; }
        td, th { padding: 6px 0; border-bottom: 1px dashed #999; font-size: 15px; text-align: right; }
        .mods { font-size: 12px; color: #555; padding-right: 8px; }
        .totals td { border-bottom: none; }
        .totals tr:last-child td { font-weight: bold; font-size: 17px; border-top: 2px solid #333; padding-top: 8px; }
        .loading { padding: 24px 0; text-align: center; color: #888; }
      </style></head><body>
      <div id="body"><div class="loading">جاري التحميل...</div></div>
      </body></html>
    `);
    win.document.close();
    return win;
  }

  // المرحلة 8.6: عرض/كومبو كان بيطبع اسم العرض بس ("عرض العيلة") من غير الأصناف الفعلية اللي المطبخ
  // محتاج يحضّرها. combo_components (لو موجودة) بترجع من GET /api/orders/:id جاهزة - نفس مصدر
  // الحقيقة، من غير أي تفكيك للعرض هنا
  function comboComponentsRows(it) {
    if (!it.combo_components || !it.combo_components.length) return "";
    return `<div class="mods">${it.combo_components
      .map((c) => `${esc(c.name)}${c.variant ? ` (${esc(c.variant)})` : ""} × ${c.quantity}`)
      .join("<br/>")}</div>`;
  }

  function itemsRows(items) {
    return items.map((it) => {
      const name = it.item_name || it.combo_name || "صنف";
      const variant = it.variant_label ? ` (${esc(it.variant_label)})` : "";
      const mods = (it.modifiers || [])
        .map((m) => `+ ${esc(m.name_at_sale)}`)
        .join("، ");
      return `
        <tr>
          <td>${esc(name)}${variant}${mods ? `<div class="mods">${mods}</div>` : ""}${comboComponentsRows(it)}</td>
          <td>× ${it.quantity}</td>
        </tr>`;
    }).join("");
  }

  function itemsRowsWithPrice(items) {
    return items.map((it) => {
      const name = it.item_name || it.combo_name || "صنف";
      const variant = it.variant_label ? ` (${esc(it.variant_label)})` : "";
      const mods = (it.modifiers || [])
        .map((m) => `+ ${esc(m.name_at_sale)}${Number(m.price_at_sale) > 0 ? ` (${money(m.price_at_sale)})` : ""}`)
        .join("، ");
      return `
        <tr>
          <td>${esc(name)}${variant} × ${it.quantity}${mods ? `<div class="mods">${mods}</div>` : ""}${comboComponentsRows(it)}</td>
          <td>${money(it.line_total)}</td>
        </tr>`;
    }).join("");
  }

  // printKitchenTicket(order, apiFetch, { orderTypeLabel, branchLabel })
  // order: صف الطلب (من قائمة الطلبات الجارية، من غير أصناف) - لازم يحتوي id على الأقل
  // apiFetch: دالة fetch الموجودة أصلًا في الصفحة (async (path) => جسم الرد كـJSON)
  async function printKitchenTicket(order, apiFetch, labels = {}) {
    const win = openPrintWindow(`تذكرة تحضير #${order.id}`);
    if (!win) return;
    try {
      const full = await apiFetch(`/api/orders/${order.id}`);
      const body = win.document.getElementById("body");
      body.innerHTML = `
        <h2>طلب #${full.id} — ${esc(labels.orderTypeLabel || full.order_type)}</h2>
        <div class="meta">${labels.branchLabel ? esc(labels.branchLabel) + " — " : ""}${new Date(full.created_at).toLocaleString("ar-EG")}</div>
        <div class="meta">العميل: ${esc(full.customer_name) || "—"} — ${esc(full.customer_phone) || "—"}</div>
        ${full.table_number ? `<div class="meta">ترابيزة: ${esc(full.table_number)}</div>` : ""}
        ${full.address_details ? `<div class="meta">العنوان: ${esc(full.address_details)}</div>` : ""}
        <table>${itemsRows(full.items || [])}</table>
      `;
      win.print();
    } catch (e) {
      win.document.getElementById("body").innerHTML = `<div class="loading">تعذر تحميل الطلب: ${esc(e.message)}</div>`;
    }
  }

  // printCashierReceipt(order, apiFetch, { orderTypeLabel, branchLabel, paymentMethodLabel })
  async function printCashierReceipt(order, apiFetch, labels = {}) {
    const win = openPrintWindow(`إيصال #${order.id}`);
    if (!win) return;
    try {
      const full = await apiFetch(`/api/orders/${order.id}`);
      const body = win.document.getElementById("body");
      const totalsRows = [];
      totalsRows.push(`<tr><td>الإجمالي الفرعي</td><td>${money(full.subtotal)}</td></tr>`);
      if (Number(full.delivery_fee) > 0) totalsRows.push(`<tr><td>رسوم التوصيل</td><td>${money(full.delivery_fee)}</td></tr>`);
      if (Number(full.discount) > 0) totalsRows.push(`<tr><td>الخصم</td><td>-${money(full.discount)}</td></tr>`);
      if (Number(full.loyalty_redeem_value) > 0) totalsRows.push(`<tr><td>نقاط ولاء مستخدمة</td><td>-${money(full.loyalty_redeem_value)}</td></tr>`);
      // المرحلة 7H: الضريبة مش سطر بيتضاف للإجمالي - هي جزء من full.total نفسه أصلًا (السعر شامل الضريبة)،
      // هنا بس بيان توضيحي (استخراج عكسي) لقيمتها المضمّنة، زي أي إيصال ضريبي حقيقي. لازم يفضل قبل سطر
      // "الإجمالي" عشان الإجمالي يفضل هو آخر سطر (فيه تنسيق بولد/خط علوي مخصوص له بس في CSS الجدول)
      if (Number(full.vat_amount) > 0) totalsRows.push(`<tr><td>منها ضريبة قيمة مضافة</td><td>${money(full.vat_amount)}</td></tr>`);
      totalsRows.push(`<tr><td>الإجمالي</td><td>${money(full.total)}</td></tr>`);
      body.innerHTML = `
        <h2>ساتاموني</h2>
        <div class="meta">إيصال طلب #${full.id} — ${esc(labels.orderTypeLabel || full.order_type)}</div>
        <div class="meta">${labels.branchLabel ? esc(labels.branchLabel) + " — " : ""}${new Date(full.created_at).toLocaleString("ar-EG")}</div>
        ${full.customer_name || full.customer_phone ? `<div class="meta">العميل: ${esc(full.customer_name) || "—"} — ${esc(full.customer_phone) || "—"}</div>` : ""}
        <table>${itemsRowsWithPrice(full.items || [])}</table>
        <table class="totals">${totalsRows.join("")}</table>
        <div class="meta" style="margin-top:10px">طريقة الدفع: ${esc(labels.paymentMethodLabel) || "—"}</div>
      `;
      win.print();
    } catch (e) {
      win.document.getElementById("body").innerHTML = `<div class="loading">تعذر تحميل الطلب: ${esc(e.message)}</div>`;
    }
  }

  // Object.assign بدل استبدال مباشر - عشان لو صفحة حمّلت print-reports.js (المرحلة 7I) كمان
  // مع الملف ده، الاتنين يتجمّعوا في نفس الكائن مهما كان ترتيب التحميل، مش يمسح واحد التاني
  window.SatamoniPrint = Object.assign(window.SatamoniPrint || {}, { printKitchenTicket, printCashierReceipt });
})();
