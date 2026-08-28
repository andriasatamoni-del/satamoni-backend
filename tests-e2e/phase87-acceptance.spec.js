// المرحلة 8.7: قبول تشغيلي حقيقي بالمتصفح - يكمّل tests-e2e/phase86-realworld.spec.js بتركيز على:
// (أ) طريقة الدفع مش بتعتمد على اللون بس (radio حقيقي checked/unchecked، مش بس CSS class)،
// (ب) وضوح السلة مع اسم صنف طويل جدًا (مفيش تسريب أفقي خارج حاوية السلة)،
// (ج) قابلية الاستخدام على تابلت (1024px) وموبايل (390px) لأهم شاشات الكاشير: POS، تقفيل الشيفت،
// فاتورة المشترى، KDS - زرارات جوه الشاشة، مفيش overflow أفقي على مستوى body، المودالات قابلة للاستخدام.
const { test, expect } = require("@playwright/test");

const PASSWORD = "Pw12345678";
async function login(page, url, email) {
  await page.goto(url);
  await page.fill("#loginEmail", email);
  await page.fill("#loginPassword", PASSWORD);
  await page.click("#loginBtn");
  await expect(page.locator("#loginOverlay")).toBeHidden({ timeout: 10000 });
}

test.describe("8.7-POS: طريقة الدفع - المؤشر مش لون بس (radio حقيقي checked/unchecked)", () => {
  test("التبديل بين طرق الدفع بيغيّر حالة الـradio الفعلية، مش الـclass البصري بس", async ({ page }) => {
    await login(page, "/satamoni-pos.html", "pw-cashier87@test.local");
    await page.waitForSelector(".pay-opt", { timeout: 10000 });
    const opts = page.locator(".pay-opt");
    const count = await opts.count();

    for (let i = 0; i < count; i++) {
      await opts.nth(i).click();
      // radio واحد بس checked في نفس اللحظة - ده تأكيد semantic مش بصري بس (screen reader هيعلن الحالة صح)
      const checkedCount = await page.locator(".pay-opt input[type=radio]:checked").count();
      expect(checkedCount).toBe(1);
      const checkedIsInsideActive = await page.evaluate(() => {
        const checked = document.querySelector(".pay-opt input[type=radio]:checked");
        return checked ? checked.closest(".pay-opt").classList.contains("active") : false;
      });
      expect(checkedIsInsideActive).toBe(true); // الـradio المُختار جوه نفس العنصر اللي عليه .active بالظبط
    }
  });
});

test.describe("8.7-POS: وضوح السلة مع اسم صنف طويل جدًا - مفيش تسريب أفقي", () => {
  test("صنف باسم طويل جدًا - حاوية السلة مبتعملش overflow أفقي على مستوى الصفحة", async ({ page }) => {
    await login(page, "/satamoni-pos.html", "pw-cashier87@test.local");
    await page.waitForSelector(".item-card", { timeout: 10000 });
    await page.locator(".item-card", { hasText: "سوبر مكس" }).click();
    // الصنف له مقاس واحد بس، من غير مرفقات - المفروض يتضاف للسلة مباشرة من غير مودال
    await expect(page.locator(".cart-row")).toHaveCount(1, { timeout: 5000 });

    const overflowsX = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 2);
    expect(overflowsX).toBe(false);
  });
});

for (const vp of [
  { name: "تابلت 1024px", width: 1024, height: 768 },
  { name: "موبايل 390px", width: 390, height: 844 },
]) {
  test.describe(`8.7-Responsive: ${vp.name}`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } });

    test(`POS: زرار الإرسال والسلة ظاهرين جوه الشاشة، مفيش overflow أفقي (${vp.name})`, async ({ page }) => {
      await login(page, "/satamoni-pos.html", "pw-cashier87@test.local");
      await page.waitForSelector(".item-card", { timeout: 10000 });
      const overflowsX = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 2);
      expect(overflowsX).toBe(false);
      await expect(page.locator("#submitBtn")).toBeVisible();
    });

    test(`تقفيل الشيفت: حقول عدّ الفئات وزرار التأكيد قابلين للاستخدام (${vp.name})`, async ({ page }) => {
      await login(page, "/satamoni-pos.html", "pw-cashier87@test.local");
      const shiftBtn = page.locator("#shiftStatusBtn");
      if ((await shiftBtn.textContent())?.includes("افتح")) {
        await shiftBtn.click();
        await page.waitForSelector("#shiftModalOverlay.show", { timeout: 5000 });
        await page.fill("#shiftOpeningCash", "500");
        await page.click("#shiftModalSubmit");
        await page.waitForTimeout(500);
      }
      await page.click("#shiftStatusBtn");
      await page.waitForSelector("#shiftModalOverlay.show", { timeout: 5000 });
      const denomInputs = page.locator("#shiftModalBody input[type='number']");
      expect(await denomInputs.count()).toBeGreaterThan(0);
      await expect(denomInputs.first()).toBeVisible();
      await expect(page.locator("#shiftModalSubmit")).toBeVisible();
      const overflowsX = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 2);
      expect(overflowsX).toBe(false);
      // نقفل الشيفت تاني عشان مايتوهش مفتوح للاختبار اللي بعده
      await denomInputs.nth(0).fill("3");
      await page.click("#shiftModalSubmit");
    });

    test(`فاتورة المشترى: القائمة المنسدلة والجدول قابلين للاستخدام (${vp.name})`, async ({ page }) => {
      await login(page, "/satamoni-pos.html", "pw-cashier87@test.local");
      await page.click("#cashEntryBtn");
      await page.waitForSelector("#cashEntryModalOverlay.show", { timeout: 5000 });
      await page.click("#cashEntryTabPurchase");
      await page.waitForSelector("#purchaseItemSelect", { timeout: 5000 });
      await expect(page.locator("#purchaseItemSelect")).toBeVisible();
      await expect(page.locator("#purchaseItemAddBtn")).toBeVisible();
      const overflowsX = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 2);
      expect(overflowsX).toBe(false);
    });

    test(`KDS: اللوحة بتفتح من غير overflow أفقي (${vp.name})`, async ({ page }) => {
      await login(page, "/satamoni-kds.html", "pw-cashier87@test.local");
      await expect(page.locator("#board")).toBeVisible({ timeout: 10000 });
      const overflowsX = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 2);
      expect(overflowsX).toBe(false);
    });
  });
}

test.describe("8.7-Manager: مراجعة الشيفت بتفتح من غير انهيار (سياق قبول تشغيلي)", () => {
  test("تبويب الشيفتات في شاشة المحاسبة بيفتح ويعرض بيانات من غير أخطاء JS", async ({ page }) => {
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await login(page, "/satamoni-accounting.html", "pw-manager87@test.local");
    await page.click('.tabbtn[data-tab="shifts"]');
    await expect(page.locator("#panel-shifts")).toHaveClass(/active/);
    await page.waitForTimeout(1000);
    expect(errors).toEqual([]);
  });
});
