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

  await page.waitForSelector(".item-card", { timeout: 10000 });
  await page.click(".item-card");
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
  const content = await popup.content();
  expect(content).toContain("ساتاموني");
  expect(content).toContain(`#${orderId}`);
});
