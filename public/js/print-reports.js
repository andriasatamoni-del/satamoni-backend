// المرحلة 7I: طباعة التقارير - وحدة مشتركة زي print-tickets.js بالظبط (نفس الأسلوب: نافذة جديدة،
// من غير أي عناصر تحكم في الصفحة، window.print()). الفرق الجوهري هنا: بيانات التقرير أصلًا موجودة
// في DOM الصفحة الحالية (الجداول اتملت بالفعل من نداء API قبل كده) - فمفيش أي fetch إضافي مطلوب،
// الدالة بس بتستنسخ كل <table> موجودة جوه اللوحة (panel) الحالية بترتيبها، مع أي عنوان (h1/h2/h3) قبلها
// مباشرة كعنوان قسم، وده بيغطي حتى التقارير متعددة الأقسام (قائمة الدخل، الميزانية العمومية، تقارير
// الموارد البشرية المجمّعة...) من غير أي كود خاص لكل تقرير على حدة - القسم في الصفحة هو نفسه القسم
// في الطباعة بالظبط.

(function () {
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  function currentUserName() {
    try {
      const u = JSON.parse(sessionStorage.getItem("satamoni_user") || "null");
      return u?.name || "";
    } catch (e) { return ""; }
  }

  // بيلقط أزواج <label>/عنصر تحكم (نفس نمط الماركاب المستخدم في كل صفحات النظام: <label>من</label>
  // <input .../> أو <label>الفرع</label><select>...</select>) من غير ما يدخل جوه أي جدول - عشان
  // مينلخبطش مع عناصر تحكم داخل صفوف الجدول نفسه (زي سلكت حالة سائق لكل صف)
  function readFilterLabels(container) {
    if (!container) return [];
    const parts = [];
    container.querySelectorAll("label").forEach((label) => {
      if (label.closest("table")) return;
      let el = label.nextElementSibling;
      if (!el) return;
      let value = null;
      if (el.tagName === "SELECT") value = el.selectedOptions[0]?.text?.trim();
      else if (el.tagName === "INPUT") value = el.value;
      if (value) parts.push(`${label.textContent.trim()}: ${value}`);
    });
    return parts;
  }

  function buildMeta(panelEl) {
    const parts = [
      ...readFilterLabels(document.getElementById("filterBar")),
      ...panelEl.querySelectorAll(":scope > .formbox").length
        ? Array.from(panelEl.querySelectorAll(":scope > .formbox")).flatMap((fb) => readFilterLabels(fb))
        : [],
    ];
    return parts.join(" — ");
  }

  // بينضّف نسخة الجدول من أي عنصر تفاعلي (زرار/سلكت/إنبوت) مالوش معنى في ورقة مطبوعة - بيستبدله
  // بالنص المعروض بدل ما يسيب زرار أو قايمة منسدلة فاضية المظهر في الطباعة
  function cleanTableForPrint(table) {
    const clone = table.cloneNode(true);
    clone.querySelectorAll("button").forEach((b) => b.remove());
    clone.querySelectorAll("select").forEach((s) => {
      const span = document.createElement("span");
      span.textContent = s.selectedOptions[0]?.text || "";
      s.replaceWith(span);
    });
    clone.querySelectorAll("input").forEach((i) => {
      const span = document.createElement("span");
      span.textContent = i.value || "";
      i.replaceWith(span);
    });
    // خلي الخلايا الفاضية (كانت زرار بس) تفضل فاضية بهدوء من غير ما تكسر شكل الجدول
    return clone;
  }

  // بيدوّر على أقرب عنوان (h1-h4) قبل الجدول - مش بس بين إخواته المباشرين، لأن جداول كتير في النظام
  // ملفوفة جوه <div class="tablewrap"> والعنوان بيبقى سابق للـwrapper نفسه مش للجدول (زي تبويب تقارير
  // HR اللي فيه 9 جداول مصغّرة متكدسة كل واحد جوه wrapper خاص بيه). بيطلع لحد ما يوصل لحدود اللوحة نفسها.
  function findPrecedingHeading(table, panelEl) {
    let el = table;
    while (el && el !== panelEl) {
      let sib = el.previousElementSibling;
      while (sib) {
        if (/^H[1-4]$/.test(sib.tagName)) return sib.textContent.trim();
        if (sib.tagName === "TABLE" || sib.querySelector?.("table")) return null; // قسم سابق - قف من غير عنوان غلط
        sib = sib.previousElementSibling;
      }
      el = el.parentElement;
    }
    return null;
  }

  // بيلمّ كل الأقسام (عنوان + جدول) بترتيب ظهورهم في الصفحة
  function collectSections(panelEl) {
    const tables = Array.from(panelEl.querySelectorAll("table"));
    return tables
      .filter((t) => t.querySelector("tbody tr")) // استبعاد جداول فاضية تمامًا (لسه ما تحمّلتش)
      .map((table) => ({ heading: findPrecedingHeading(table, panelEl), table: cleanTableForPrint(table) }));
  }

  function openPrintWindow(title) {
    const win = window.open("", "_blank");
    if (!win) {
      alert("المتصفح منع فتح نافذة الطباعة - سمح بالنوافذ المنبثقة لهذا الموقع وحاول تاني");
      return null;
    }
    win.document.write(`
      <html dir="rtl" lang="ar"><head><meta charset="UTF-8"><title>${esc(title)}</title>
      <style>
        body { font-family: 'Segoe UI', Tahoma, Arial, sans-serif; padding: 24px; color: #111; }
        .brand { font-size: 20px; font-weight: 800; margin-bottom: 2px; }
        h1 { font-size: 17px; margin: 4px 0 2px; }
        .meta { font-size: 12px; color: #444; margin-bottom: 4px; }
        .section-title { font-size: 14px; font-weight: 700; margin: 18px 0 6px; }
        table { width: 100%; border-collapse: collapse; margin-bottom: 6px; }
        th, td { padding: 5px 8px; border-bottom: 1px solid #ccc; font-size: 12px; text-align: right; }
        th { background: #f0f0f0; font-weight: 700; }
        .footer { margin-top: 20px; font-size: 11px; color: #777; border-top: 1px solid #ccc; padding-top: 6px; }
        .kpi-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 8px; margin-bottom: 10px; }
        .kpi-grid .kpi { border: 1px solid #ccc; border-radius: 6px; padding: 8px; }
        .kpi-grid .kpi .label { font-size: 11px; color: #555; }
        .kpi-grid .kpi .value { font-size: 15px; font-weight: 700; }
        ul.plainlist { margin: 0 0 6px; padding-inline-start: 18px; font-size: 12px; }
        ul.plainlist li { margin-bottom: 3px; }
        @media print { .brand { color: #000; } }
      </style></head><body>
      <div id="body"></div>
      </body></html>
    `);
    win.document.close();
    return win;
  }

  // printPanel(panelElement, {title}) - بيطبع كل الجداول جوه اللوحة الممررة بترتيبها، بعنوان مأخوذ
  // من اسم التبويب الحالي، وميتا (فلاتر) مستخرجة أوتوماتيك من عناصر التحكم المرئية
  function printPanel(panelEl, { title } = {}) {
    if (!panelEl) return;
    const sections = collectSections(panelEl);
    const win = openPrintWindow(title || "تقرير");
    if (!win) return;
    const meta = buildMeta(panelEl);
    const body = win.document.getElementById("body");
    body.innerHTML = `
      <div class="brand">🍕 ساتاموني</div>
      <h1>${esc(title || "تقرير")}</h1>
      ${meta ? `<div class="meta">${esc(meta)}</div>` : ""}
      ${sections.length
        ? sections.map((s) => `${s.heading ? `<div class="section-title">${esc(s.heading)}</div>` : ""}${s.table.outerHTML}`).join("")
        : `<div class="meta">مفيش بيانات لعرضها في التبويب ده حاليًا</div>`}
      <div class="footer">طُبع بواسطة ${esc(currentUserName())} — ${new Date().toLocaleString("ar-EG")}</div>
    `;
    win.print();
  }

  // اختصار شائع: بيطبع أي لوحة/تبويب فعّال حاليًا في صفحة بتستخدم نمط .tabbtn/.panel المعتاد في
  // النظام كله - مفيش حاجة تتكتب لكل تبويب لوحده، زرار واحد بس في الصفحة يكفي
  function printCurrentTab() {
    const activeTab = document.querySelector(".tabbtn.active");
    const activePanel = document.querySelector(".panel.active");
    printPanel(activePanel, { title: activeTab ? activeTab.textContent.trim() : undefined });
  }

  // مكشوفة للاستخدام المخصّص (زي الداش بورد - كروت وشارت مش جداول، محتاج تركيب مختلف) - بتستخدم نفس
  // شكل الطباعة والهيدر بالظبط، بس المحتوى بتاعها بيتبني يدويًا في الصفحة نفسها بدل استخراج جداول أوتوماتيك
  function openCustomPrint(title, bodyHtml) {
    const win = openPrintWindow(title || "تقرير");
    if (!win) return null;
    win.document.getElementById("body").innerHTML = `
      <div class="brand">🍕 ساتاموني</div>
      <h1>${esc(title || "تقرير")}</h1>
      ${bodyHtml}
      <div class="footer">طُبع بواسطة ${esc(currentUserName())} — ${new Date().toLocaleString("ar-EG")}</div>
    `;
    win.print();
    return win;
  }

  window.SatamoniPrint = Object.assign(window.SatamoniPrint || {}, { printPanel, printCurrentTab, openCustomPrint, esc });
})();
