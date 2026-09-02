// نظام الوضع الليلي/النهاري المشترك لكل شاشات ستاموني - الافتراضي أبيض (نهاري)، وأي صفحة فيها زرار
// #themeToggleBtn بيتفعّل تلقائيًا هنا (نفس فلسفة js/print-reports.js: أداة مشتركة، كل صفحة بتضيف
// بس الزرار في الـHTML وتربط الملف ده). التفضيل بيتحفظ في localStorage فبيفضل موحّد بين كل الشاشات
// المفتوحة لنفس المتصفح. كل صفحة فيها كمان سكريبت صغير inline في أول <head> (قبل أي CSS) بيطبّق
// data-theme="dark" فورًا لو محفوظ - عشان الصفحة متلمعش أبيض لحظة قبل ما الملف ده يتحمّل (FOUC)
(function () {
  const KEY = "satamoni-theme";

  function apply(theme) {
    if (theme === "dark") document.documentElement.setAttribute("data-theme", "dark");
    else document.documentElement.removeAttribute("data-theme");
  }

  function current() {
    return document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
  }

  function updateButton() {
    const btn = document.getElementById("themeToggleBtn");
    if (!btn) return;
    const dark = current() === "dark";
    btn.textContent = dark ? "☀️" : "🌙";
    btn.title = dark ? "الوضع النهاري" : "الوضع الليلي";
  }

  function set(theme) {
    try { localStorage.setItem(KEY, theme); } catch (e) { /* localStorage معطّل - التفضيل هيفضل شغال للصفحة الحالية بس */ }
    apply(theme);
    updateButton();
  }

  function toggle() {
    set(current() === "dark" ? "light" : "dark");
  }

  function init() {
    updateButton();
    const btn = document.getElementById("themeToggleBtn");
    if (btn) btn.onclick = toggle;
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();

  window.SatamoniTheme = { toggle, set, current };
})();
