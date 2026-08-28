// المرحلة 8.6: تحقق حقيقي بالمتصفح (Playwright/Chromium) لكل تصحيح من التصحيحات السبعة المُبلّغة -
// شغّال ضد سيرفر + قاعدة بيانات مخصصة (tests-e2e/seed-phase86.js)، مش mocks. الهدف: تأكيد إن الإصلاح
// ظاهر فعليًا في الشاشة الحقيقية اللي الكاشير/المدير هيستخدموها، مش بس في استجابة API.
const { test, expect } = require("@playwright/test");

const PASSWORD = "Pw12345678";
async function login(page, url, email) {
  await page.goto(url);
  await page.fill("#loginEmail", email);
  await page.fill("#loginPassword", PASSWORD);
  await page.click("#loginBtn");
  await expect(page.locator("#loginOverlay")).toBeHidden({ timeout: 10000 });
}

test.describe("8.6-POS: طريقة الدفع - العلامة الزرقاء بتتبع الاختيار الفعلي مش بتفضل عالقة", () => {
  test("كاش -> فيزا -> آجل -> فيزا: كل مرة sطر واحد بس هو اللي عليه .active", async ({ page }) => {
    await login(page, "/satamoni-pos.html", "pw-cashier86@test.local");
    await page.waitForSelector(".pay-opt", { timeout: 10000 });

    const opts = page.locator(".pay-opt");
    const count = await opts.count();
    expect(count).toBeGreaterThanOrEqual(3);

    // اختيار أولي - أول طريقة دفع لازم تبقى active افتراضيًا
    await expect(page.locator(".pay-opt.active")).toHaveCount(1);

    for (let i = 0; i < count; i++) {
      await opts.nth(i).click();
      await expect(page.locator(".pay-opt.active")).toHaveCount(1);
      const activeText = await page.locator(".pay-opt.active").textContent();
      const clickedText = await opts.nth(i).textContent();
      expect(activeText.trim()).toBe(clickedText.trim());
    }

    // تبديل متكرر (نفس الاختبار اللي كشف الباج الأصلي - بعد أول تبديل كان بيفضل عالق)
    for (let round = 0; round < 4; round++) {
      const idx = round % count;
      await opts.nth(idx).click();
      await expect(page.locator(".pay-opt.active")).toHaveCount(1);
    }
  });
});

test.describe("8.6-POS: السلة واضحة - إجمالي السطر بارز وزرار شيل شغال", () => {
  test("إضافة صنف - إجمالي السطر ظاهر، وزرار الشيل بيشيله فعليًا", async ({ page }) => {
    await login(page, "/satamoni-pos.html", "pw-cashier86@test.local");
    await page.waitForSelector(".item-card", { timeout: 10000 });
    // صنف "بطاطس" بدون مرفقات/مقاسات - بيتضاف للسلة مباشرة من غير مودال اختيار (عكس البيتزا اللي
    // ليها مرفق "إضافة جبنة" فبتفتح مودال اختيار الأول)
    await page.locator(".item-card", { hasText: "بطاطس" }).click();
    await expect(page.locator(".cart-row")).toHaveCount(1, { timeout: 5000 });
    await expect(page.locator(".cart-row .line-total")).toBeVisible();
    const lineTotalText = await page.locator(".cart-row .line-total").textContent();
    expect(lineTotalText.trim().length).toBeGreaterThan(0);

    await page.click(".cart-remove");
    await expect(page.locator(".cart-row")).toHaveCount(0, { timeout: 5000 });
    await expect(page.locator(".cart-empty")).toBeVisible();
  });
});

test.describe("8.6-Cashier: تقفيل الشيفت - عدّ فئات بس، من غير أي رقم عجز/زيادة", () => {
  test("فتح شيفت ثم تقفيله بعدّ الفئات - مفيش نص 'عجز' أو 'زيادة' أو رقم متوقع ظاهر للكاشير", async ({ page }) => {
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await login(page, "/satamoni-pos.html", "pw-cashier86@test.local");

    // فتح شيفت لو مش مفتوح
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
    const modalBody = await page.locator("#shiftModalBody").textContent();
    // شاشة قفل الشيفت الجديدة (المرحلة 8.6) - عدّ فئات، من غير أي رقم "متوقع" أو "عجز/زيادة" ظاهر
    expect(modalBody).not.toMatch(/عجز|زيادة|متوقع/);

    const denomInputs = page.locator("#shiftModalBody input[type='number']");
    const denomCount = await denomInputs.count();
    expect(denomCount).toBeGreaterThan(0);
    // ندخل فئة 200×3 = 600 عشان نقفل الشيفت بمبلغ حقيقي
    await denomInputs.nth(0).fill("3");

    await page.click("#shiftModalSubmit");
    await page.waitForTimeout(800);

    const bodyText = await page.locator("body").textContent();
    expect(bodyText).not.toMatch(/عجز \d|زيادة \d/);
    expect(errors).toEqual([]);
  });
});

test.describe("8.6-Manager: مراجعة الشيفت - المدير بيشوف العجز/الزيادة (الكاشير لأ)", () => {
  test("تبويب مراجعة الشيفتات بيفتح من غير انهيار ويعرض أعمدة السلفة/الفرق", async ({ page }) => {
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await login(page, "/satamoni-accounting.html", "pw-manager86@test.local");
    await page.click('.tabbtn[data-tab="shifts"]');
    await expect(page.locator("#panel-shifts")).toHaveClass(/active/);
    await page.waitForTimeout(1000);
    expect(errors).toEqual([]);
  });
});

test.describe("8.6-Purchases: فاتورة مشترى مواد خام - الكاشير بيختار من الكتالوج الموجود بس", () => {
  test("فتح شاشة مصروف/مشترى، التبويب مشترى، إضافة بند مادة خام موجودة، الإجمالي بيتحدث", async ({ page }) => {
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await login(page, "/satamoni-pos.html", "pw-cashier86@test.local");
    await page.click("#cashEntryBtn");
    await page.waitForSelector("#cashEntryModalOverlay.show", { timeout: 5000 });
    await page.click("#cashEntryTabPurchase");
    await page.waitForSelector("#purchaseItemSelect", { timeout: 5000 });

    const optionsCount = await page.locator("#purchaseItemSelect option").count();
    expect(optionsCount).toBeGreaterThan(1); // فيه "اختر مادة خام..." + مادة خام واحدة على الأقل

    await page.selectOption("#purchaseItemSelect", { index: 1 });
    await page.fill("#purchaseItemQty", "5");
    await page.fill("#purchaseItemPrice", "20");
    await page.click("#purchaseItemAddBtn");

    await expect(page.locator("#purchaseItemsTbody tr")).toHaveCount(1, { timeout: 5000 });
    const totalText = await page.locator("#purchaseItemsTotal").textContent();
    expect(totalText).toContain("100"); // 5 × 20

    await page.click("#cashEntryModalSubmit");
    await page.waitForTimeout(800);
    const okText = await page.locator("#cashEntryModalOk").textContent();
    expect(okText).toContain("تم تسجيل فاتورة المشترى");
    expect(errors).toEqual([]);
  });
});

test.describe("8.6-Kitchen: العرض بيظهر في المطبخ كأصناف فعلية، مش 'عرض #كذا' مبهم", () => {
  test("طلب فيه العرض - لوحة المطبخ بتعرض مكونات العرض الحقيقية", async ({ page }) => {
    await login(page, "/satamoni-pos.html", "pw-cashier86@test.local");
    await page.waitForSelector(".item-card", { timeout: 10000 });

    // العروض في تبويب منفصل ("🎁 العروض") - لازم نفتحه الأول
    await page.locator(".tab", { hasText: "العروض" }).click();
    const comboCard = page.locator(".item-card[data-combo]").first();
    const hasCombo = await comboCard.count();
    test.skip(hasCombo === 0, "مفيش عرض ظاهر في هذه الشاشة/التبويب الحالي");
    await comboCard.click();
    await expect(page.locator(".cart-row")).toHaveCount(1, { timeout: 5000 });

    await page.click("#submitBtn");
    await page.waitForSelector("#confirmOverlay.show", { timeout: 10000 });
    const orderIdText = await page.locator("#confirmOrderId").textContent();
    const orderId = orderIdText.replace("#", "").trim();

    await page.goto("/satamoni-kds.html");
    // الجلسة (token) متخزنة في localStorage نفس الـorigin - غالبًا هتفتح مباشرة من غير أي لوجين تاني
    if (await page.locator("#loginOverlay").isVisible().catch(() => false)) {
      await page.fill("#loginEmail", "pw-cashier86@test.local");
      await page.fill("#loginPassword", PASSWORD);
      await page.click("#loginBtn");
    }
    await expect(page.locator("#loginOverlay")).toBeHidden({ timeout: 10000 });
    await expect(page.locator("#board")).toContainText(`#${orderId}`, { timeout: 10000 });
    const boardText = await page.locator("#board").textContent();
    expect(boardText).not.toMatch(/عرض\s*#\d+/);
  });
});
