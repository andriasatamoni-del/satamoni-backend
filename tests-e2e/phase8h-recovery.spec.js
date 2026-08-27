// المرحلة 8H: اختبار تعافي عملي حقيقي - اكتشفنا إن شاشتي POS/CallCenter مكنش بيبعتوا idempotencyKey
// خالص مع POST /api/orders رغم إن الباك إند بيدعمه بالكامل ومتأكد باختبارات جست (tests/inventory.test.js
// "Order-level idempotency"). ده يعني لو الكاشير عمل دبل-كليك سريع أو أعاد المحاولة بعد error مؤقت،
// كان ممكن يتسجل نفس الطلب فعليًا مرتين (فاتورتين، خصم مخزون مرتين، قيد محاسبي مرتين). الإصلاح:
// public/satamoni-pos.html و public/satamoni-callcenter.html دلوقتي بيولدوا مفتاح idempotency واحد
// لكل محاولة سلة، ويعيدوا استخدامه في أي محاولة إرسال تانية لنفس السلة (بيتصفّر بس بعد نجاح/طلب جديد).
// الاختبار ده بيتأكد إن المفتاح فعليًا بيتولد مرة واحدة وبيفضل ثابت عبر محاولات متعددة (مش مفتاح جديد
// كل مرة) - وده اللي بيخلّي حماية الباك إند الموجودة أصلًا شغالة فعليًا من واجهة المستخدم.
const { test, expect } = require("@playwright/test");

test("8H: مفتاح idempotency بيتولد مرة واحدة بس ويفضل ثابت عبر محاولات إرسال متعددة لنفس السلة (POS)", async ({ page }) => {
  await page.goto("/satamoni-pos.html");
  await page.fill("#loginEmail", "pw-cashier@test.local");
  await page.fill("#loginPassword", "Pw12345678");
  await page.click("#loginBtn");
  await expect(page.locator("#loginOverlay")).toBeHidden({ timeout: 10000 });
  await page.waitForSelector(".item-card", { timeout: 10000 });
  await page.click(".item-card");

  const key1 = await page.evaluate(() => getOrderAttemptKey());
  const key2 = await page.evaluate(() => getOrderAttemptKey());
  expect(key1).toBeTruthy();
  expect(key1).toBe(key2);

  await page.click("#submitBtn");
  await expect(page.locator("#confirmOverlay")).toHaveClass(/show/, { timeout: 10000 });
  await page.click("#newOrderBtn");

  const keyAfterReset = await page.evaluate(() => getOrderAttemptKey());
  expect(keyAfterReset).not.toBe(key1);
});

test("8H: نفس الحماية في شاشة الكول سنتر (CallCenter)", async ({ page }) => {
  await page.goto("/satamoni-callcenter.html");
  await page.fill("#loginEmail", "pw-callcenter@test.local");
  await page.fill("#loginPassword", "Pw12345678");
  await page.click("#loginBtn");
  await expect(page.locator("#loginOverlay")).toBeHidden({ timeout: 10000 });

  const key1 = await page.evaluate(() => getOrderAttemptKey());
  const key2 = await page.evaluate(() => getOrderAttemptKey());
  expect(key1).toBeTruthy();
  expect(key1).toBe(key2);
});

test("8H: طلبين حقيقيين بنفس مفتاح idempotency (زي ما الشاشة بقت بتبعت) - أوردر واحد بس بيترحّل فعليًا", async ({ page }) => {
  await page.goto("/satamoni-pos.html");
  await page.fill("#loginEmail", "pw-cashier@test.local");
  await page.fill("#loginPassword", "Pw12345678");
  await page.click("#loginBtn");
  await expect(page.locator("#loginOverlay")).toBeHidden({ timeout: 10000 });
  await page.waitForSelector(".item-card", { timeout: 10000 });
  await page.click(".item-card");

  // بنحاكي "دبل كليك/إعادة محاولة بعد فشل شبكة" حرفيًا زي ما هيحصل في الإنتاج: نفس البايلود اللي
  // الكود الحقيقي بيبنيه، بنداء fetch مباشر مرتين بنفس المفتاح (مش من غير المفتاح)
  const result = await page.evaluate(async () => {
    const key = getOrderAttemptKey();
    const branchId = state.selectedBranchId;
    const [item] = Object.values(state.cart);
    const payload = {
      branchId, source: "pos", orderType: "takeaway",
      paymentMethodId: state.selectedPaymentId,
      items: [{ itemId: item.itemId, variantId: item.variantId, unitPrice: item.price, quantity: item.qty }],
      idempotencyKey: key,
    };
    const headers = { "Content-Type": "application/json", Authorization: `Bearer ${auth.token}` };
    const [r1, r2] = await Promise.all([
      fetch(`${API_BASE_URL}/api/orders`, { method: "POST", headers, body: JSON.stringify(payload) }),
      fetch(`${API_BASE_URL}/api/orders`, { method: "POST", headers, body: JSON.stringify(payload) }),
    ]);
    const b1 = await r1.json();
    const b2 = await r2.json();
    return { s1: r1.status, s2: r2.status, orderId1: b1.orderId, orderId2: b2.orderId };
  });

  expect([result.s1, result.s2].sort()).toEqual([200, 201]);
  expect(result.orderId1).toBe(result.orderId2);
});
