// Security audit (final full security/permissions/production-readiness mission): regression test for a
// real stored-XSS finding. Customer-supplied fields (customer_name/customer_phone/address_details/
// distinguishing_mark on orders, and complaint description) reach several staff-facing dashboards
// (satamoni-crm.html and siblings) via `innerHTML` without escaping. Since these fields are set by an
// anonymous customer through the public website/WhatsApp order flow (source='website'/no auth required),
// a customer could inject a payload that executes in a staff member's browser session - and since auth
// tokens live in localStorage (not an httpOnly cookie), that's a realistic path to staff session/token
// theft. Fixed by escaping these fields before interpolation (see esc()/escapeHtml() additions across
// satamoni-crm.html, satamoni-dispatch.html, satamoni-driver-app.html, satamoni-kds.html,
// satamoni-callcenter.html, satamoni-delivery.html, satamoni-pos.html, satamoni-reports.html,
// satamoni-whatsapp.html, satamoni-customers.html). This test only re-verifies the CRM followup queue -
// the first page the vulnerability was found in - as a representative regression check.
const { test, expect } = require("@playwright/test");
const { Client } = require("pg");

const E2E_DB_URL = process.env.E2E_DATABASE_URL || "postgresql://postgres:test123@localhost:5432/satamoni_e2e_8fgh";
const XSS_MARKER = "xss-regression-marker";
const XSS_PAYLOAD = `<img src=x onerror="window.__xssFired='${XSS_MARKER}'">`;

let orderId;

test.beforeAll(async () => {
  const db = new Client({ connectionString: E2E_DB_URL });
  await db.connect();
  const branch = await db.query("SELECT id FROM branches ORDER BY id LIMIT 1");
  const branchId = branch.rows[0].id;
  const order = await db.query(
    `INSERT INTO orders (branch_id, source, order_type, customer_name, customer_phone, address_details,
                          distinguishing_mark, subtotal, total, dispatch_status, delivered_at)
     VALUES ($1, 'website', 'delivery', $2, '01000000000', $2, $2, 50, 50, 'DELIVERED', now())
     RETURNING id`,
    [branchId, XSS_PAYLOAD]
  );
  orderId = order.rows[0].id;
  await db.end();
});

test("8-Security: اسم عميل فيه HTML/JS في طابور متابعة الأوردرات (CRM) بيترندر كنص، مش كود بيتنفّذ", async ({ page }) => {
  let scriptExecuted = false;
  page.on("dialog", async (dialog) => { scriptExecuted = true; await dialog.dismiss(); });

  await page.goto("/satamoni-crm.html");
  await page.fill("#loginEmail", "pw-admin@test.local");
  await page.fill("#loginPassword", "Pw12345678");
  await page.click("#loginBtn");
  await expect(page.locator("#loginOverlay")).toHaveClass(/hidden/, { timeout: 10000 });

  await page.waitForSelector("#queueBody tr", { timeout: 10000 });

  // الصنم الفعلي: العلامة اللي المتصفح بيحطها لو الـ<img onerror> اتفّذ فعليًا كعنصر حي - لازم تفضل undefined
  const fired = await page.evaluate(() => window.__xssFired);
  expect(fired).toBeUndefined();
  expect(scriptExecuted).toBe(false);

  // والنص نفسه (مش الوسم) لازم يكون ظاهر في الصفحة - يعني اتعمله escape مش حذف
  const rowText = await page.locator(`tr:has-text("01000000000")`).innerText();
  expect(rowText).toContain("<img");
});
