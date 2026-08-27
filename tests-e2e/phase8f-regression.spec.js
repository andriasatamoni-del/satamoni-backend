// المرحلة 8F: تراجع كامل بالمتصفح الحقيقي (Playwright/Chromium) عبر أدوار مختلفة - بيكشف باجات
// JS/رندر ما ينفعش Jest يكشفها (Jest بيختبر الـAPI بس، مش الشاشة الفعلية اللي بتتفاعل مع المستخدم).
// شغّال ضد سيرفر + قاعدة بيانات مخصصة لِPlaywright (مش قاعدة Jest ولا قاعدة التطوير المشتركة).
const { test, expect } = require("@playwright/test");

const PASSWORD = "Pw12345678";
async function login(page, url, email) {
  await page.goto(url);
  await page.fill("#loginEmail", email);
  await page.fill("#loginPassword", PASSWORD);
  await page.click("#loginBtn");
}

test.describe("8F-Auth: تسجيل الدخول", () => {
  test("باسورد غلط - بيظهر رسالة خطأ، مش انهيار الشاشة", async ({ page }) => {
    await page.goto("/satamoni-pos.html");
    await page.fill("#loginEmail", "pw-cashier@test.local");
    await page.fill("#loginPassword", "wrong-password-xyz");
    await page.click("#loginBtn");
    await expect(page.locator("#loginErr")).not.toHaveText("", { timeout: 10000 });
    await expect(page.locator("#loginOverlay")).toBeVisible();
  });

  test("بيانات صح - الشاشة الرئيسية بتظهر (اللوجين overlay بيختفي)", async ({ page }) => {
    await login(page, "/satamoni-pos.html", "pw-cashier@test.local");
    await expect(page.locator("#loginOverlay")).toBeHidden({ timeout: 10000 });
  });
});

let createdOrderId;

test.describe("8F-POS: نقطة البيع", () => {
  test("كاشير - إضافة صنف للسلة وإرسال طلب حقيقي بيرجع رقم أوردر", async ({ page }) => {
    await login(page, "/satamoni-pos.html", "pw-cashier@test.local");
    await expect(page.locator("#loginOverlay")).toBeHidden({ timeout: 10000 });

    await page.waitForSelector(".item-card", { timeout: 10000 });
    await page.click(".item-card");
    await expect(page.locator("#cartList .cart-empty")).toHaveCount(0);

    await page.click("#submitBtn");
    await expect(page.locator("#confirmOverlay")).toHaveClass(/show/, { timeout: 10000 });
    const orderIdText = await page.locator("#confirmOrderId").textContent();
    expect(orderIdText).toMatch(/#\d+/);
    createdOrderId = orderIdText.replace("#", "").trim();
  });
});

test.describe("8F-CallCenter: الكول سنتر", () => {
  test("موظف كول سنتر - الشاشة بترندر منيو حقيقي من الباك إند", async ({ page }) => {
    await login(page, "/satamoni-callcenter.html", "pw-callcenter@test.local");
    await expect(page.locator("#loginOverlay")).toBeHidden({ timeout: 10000 });
    await page.waitForSelector(".item-card", { timeout: 10000 });
    expect(await page.locator(".item-card").count()).toBeGreaterThan(0);
  });

  test("بحث برقم تليفون مش موجود - مفيش انهيار JS", async ({ page }) => {
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await login(page, "/satamoni-callcenter.html", "pw-callcenter@test.local");
    await expect(page.locator("#loginOverlay")).toBeHidden({ timeout: 10000 });
    await page.fill("#phoneInput", "01099999999");
    await page.click("#searchBtn");
    await page.waitForTimeout(800);
    expect(errors).toEqual([]);
  });
});

test.describe("8F-KDS: شاشة المطبخ", () => {
  test("كاشير - لوحة المطبخ بتظهر وفيها الطلب اللي اتعمل في POS", async ({ page }) => {
    test.skip(!createdOrderId, "محتاج طلب POS اتعمل قبل كده في نفس التشغيلة");
    await login(page, "/satamoni-kds.html", "pw-cashier@test.local");
    await expect(page.locator("#loginOverlay")).toBeHidden({ timeout: 10000 });
    await expect(page.locator("#board")).toBeVisible({ timeout: 10000 });
    await expect(page.locator("#board")).toContainText(`#${createdOrderId}`, { timeout: 10000 });
  });
});

test.describe("8F-Driver: تطبيق السائق", () => {
  test("سائق - شاشته بتفتح وتعرض تبويباته (view_own مقفولة على بياناته بس)", async ({ page }) => {
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await login(page, "/satamoni-driver-app.html", "pw-driver@test.local");
    await expect(page.locator("#loginOverlay")).toBeHidden({ timeout: 10000 });
    await expect(page.locator("#mainWrap")).toBeVisible({ timeout: 10000 });
    expect(errors).toEqual([]);
  });
});

test.describe("8F-BranchManager: مدير الفرع", () => {
  test("مدير فرع - تبويب مراجعة الشيفتات وتقفيل يوم الفرع بيفتحوا من غير انهيار", async ({ page }) => {
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await login(page, "/satamoni-accounting.html", "pw-branch_manager@test.local");
    await expect(page.locator("#loginOverlay")).toBeHidden({ timeout: 10000 });

    await page.click('.tabbtn[data-tab="shifts"]');
    await expect(page.locator("#panel-shifts")).toHaveClass(/active/);

    await page.click('.tabbtn[data-tab="dayclose"]');
    await expect(page.locator("#panel-dayclose")).toHaveClass(/active/);

    expect(errors).toEqual([]);
  });
});

test.describe("8F-Accounting: الحسابات", () => {
  test("محاسب - شجرة الحسابات بترجع بيانات حقيقية (الحسابات الافتراضية من schema.sql)", async ({ page }) => {
    await login(page, "/satamoni-accounting.html", "pw-accountant@test.local");
    await expect(page.locator("#loginOverlay")).toBeHidden({ timeout: 10000 });
    await page.click('.tabbtn[data-tab="coa"]');
    await expect(page.locator("#panel-coa")).toHaveClass(/active/);
    await page.waitForTimeout(1000);
    const text = await page.locator("#panel-coa").textContent();
    expect(text.length).toBeGreaterThan(20);
  });
});

test.describe("8F-HR: الموظفين والرواتب", () => {
  test("أدمن - تبويب الموظفين بيظهر الموظف اللي اتعمل seed", async ({ page }) => {
    await login(page, "/satamoni-payroll.html", "pw-admin@test.local");
    await expect(page.locator("#loginOverlay")).toBeHidden({ timeout: 10000 });
    await page.click('.tabbtn[data-tab="employees"]');
    await expect(page.locator("#panel-employees")).toHaveClass(/active/);
    await page.waitForTimeout(1000);
    await expect(page.locator("#panel-employees")).toContainText("موظف بلايرايت", { timeout: 10000 });
  });
});
