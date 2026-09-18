// المرحلة 8G: تحقق حي من محتوى الطباعة الرقمي (window.print() المحتوى المُولّد) - التمييز الصريح
// المطلوب: هنا بنتحقق من "المحتوى" بس (رقميًا، عبر نافذة الطباعة الحقيقية اللي بتتفتح في متصفح
// حقيقي)، مش من الطباعة الفعلية على ورق حراري - ده NOT VERIFIED/NOT APPLICABLE في بيئة سحابية
// من غير أي طابعة فعلية متصلة، موثّق صراحة في تقرير المرحلة 8 النهائي.
const { test, expect } = require("@playwright/test");

test("8G: إيصال الكاشير - نافذة الطباعة بتتفتح فعليًا وفيها محتوى الطلب الصحيح", async ({ page, context }) => {
  await page.goto("/satamoni-pos.html");
  await page.fill("#loginEmail", "pw-cashier@test.local");
  await page.fill("#loginPassword", "Pw12345678");
  await page.click("#loginBtn");
  await expect(page.locator("#loginOverlay")).toBeHidden({ timeout: 10000 });

  // المرحلة 8.10 (لاحقة، وشرعية): المودال بقى بيفتح لكل صنف - لازم نأكّد الإضافة منه
  await page.waitForSelector(".item-card", { timeout: 10000 });
  await page.click(".item-card");
  await expect(page.locator("#itemModalOverlay")).toHaveClass(/show/);
  await page.click("#itemModalAdd");
  await page.click("#submitBtn");
  await expect(page.locator("#confirmOverlay")).toHaveClass(/show/, { timeout: 10000 });
  const orderIdText = await page.locator("#confirmOrderId").textContent();
  const orderId = orderIdText.replace("#", "").trim();
  await page.click("#newOrderBtn");
  await expect(page.locator("#confirmOverlay")).not.toHaveClass(/show/);

  await page.click("#ordersOpenBtn");
  await expect(page.locator("#ordersOverlay")).toHaveClass(/show/);
  await page.click("#ordersRefreshBtn");

  const card = page.locator(`.order-card[data-id="${orderId}"]`);
  await expect(card).toBeVisible({ timeout: 10000 });

  const [popup] = await Promise.all([
    context.waitForEvent("page", { timeout: 10000 }),
    card.locator('button[data-oact="receipt"]').click(),
  ]);
  await popup.waitForLoadState("domcontentloaded");
  // print-tickets.js: window.open() بيتنفذ فورًا بشكل مبدئي (".loading") قبل ما تفاصيل الطلب توصل
  // بالـfetch الـasync وتستبدل #body بالإيصال الفعلي - لازم نستنى ده يختفي قبل ما نقرا المحتوى
  await popup.waitForSelector(".loading", { state: "detached", timeout: 10000 });
  const content = await popup.content();
  expect(content).toContain("ستاموني");
  expect(content).toContain(`#${orderId}`);
});
