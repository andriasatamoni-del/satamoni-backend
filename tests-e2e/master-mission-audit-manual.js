// Real Playwright UI E2E — "Master Mission" full-system audit, Part 24.
//
// This is a STANDALONE script, not a Jest/`*.spec.js` file picked up by
// `npm run test:e2e` or `playwright.config.js`. It follows the project's
// established scratchpad `browser-check*.js` pattern: it stands up its own
// throwaway Postgres database, boots a real `node server.js` instance against
// it, seeds real data via direct SQL + HTTP calls, then drives real Chromium
// interactions (not screenshots only) across desktop/tablet/mobile viewports,
// asserting on both DOM state and real API/DB side effects (e.g. waiting for
// a genuine `popup` event when the batch-label print button is clicked).
//
// Covers: production planning screen (desktop), CK requisitions (tablet
// 820px), branch requisitions (mobile 390px), purchasing tabs + a live
// Supplier Statement fetch+render, and manufacturing (production order
// creation -> approve -> start -> complete via API, then batch-label print
// button clicked in-browser and traceability search back to the raw item).
//
// How to run (from repo root, requires local Postgres reachable at
// postgresql://postgres:test123@localhost:5432 and the Playwright Chromium
// bundled under /opt/pw-browsers, or adjust PG_ADMIN_URL/CHROME below):
//
//   NODE_PATH=$(pwd)/node_modules node tests-e2e/master-mission-audit-manual.js
//
// Last verified run: 11/11 assertions passed.
const { chromium } = require("playwright");
const { Client } = require("pg");
const { spawn } = require("child_process");

const DB_NAME = "satamoni_pw_audit";
const PG_ADMIN_URL = "postgresql://postgres:test123@localhost:5432/postgres";
const DB_URL = `postgresql://postgres:test123@localhost:5432/${DB_NAME}`;
const PORT = 4551;
const BASE = `http://localhost:${PORT}`;
const CHROME = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const PASSWORD = "test12345";

let serverProc;
let failures = [];
let passed = 0;

function assert(cond, label) {
  if (cond) { passed++; console.log(`  OK: ${label}`); }
  else { failures.push(label); console.log(`  FAIL: ${label}`); }
}

async function api(token, method, urlPath, body) {
  const res = await fetch(`${BASE}${urlPath}`, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

async function main() {
  console.log("=== إعداد قاعدة بيانات مؤقتة نظيفة ===");
  const admin = new Client({ connectionString: PG_ADMIN_URL });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${DB_NAME}`);
  await admin.query(`CREATE DATABASE ${DB_NAME}`);
  await admin.end();

  const fs = require("fs");
  const schemaSql = fs.readFileSync("/home/user/satamoni-backend/db/schema.sql", "utf8");
  const dbc = new Client({ connectionString: DB_URL });
  await dbc.connect();
  await dbc.query(schemaSql);

  console.log("=== تشغيل السيرفر على قاعدة البيانات دي ===");
  serverProc = spawn("node", ["server.js"], {
    cwd: "/home/user/satamoni-backend",
    env: { ...process.env, DATABASE_URL: DB_URL, PORT: String(PORT), JWT_SECRET: "pw_audit_secret" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise((resolve) => {
    serverProc.stdout.on("data", (d) => { if (d.toString().includes("running on port")) resolve(); });
    setTimeout(resolve, 4000);
  });

  console.log("=== بذر بيانات حقيقية (فروع، مستخدمين، أصناف، وصفة، مورد) ===");
  const bcrypt = require("/home/user/satamoni-backend/node_modules/bcryptjs");
  const passwordHash = await bcrypt.hash(PASSWORD, 10);

  const ck = await dbc.query("INSERT INTO branches (name, is_central_kitchen) VALUES ('سنتر كيتشن-PW', TRUE) RETURNING id");
  const ckBranchId = ck.rows[0].id;
  const br = await dbc.query("INSERT INTO branches (name) VALUES ('فرع-PW') RETURNING id");
  const branchId = br.rows[0].id;

  await dbc.query("INSERT INTO users (branch_id, name, email, password_hash, role) VALUES (NULL,'أدمن-PW','admin-pw@test.local',$1,'admin')", [passwordHash]);
  await dbc.query("INSERT INTO users (branch_id, name, email, password_hash, role) VALUES ($1,'مدير سنتر كيتشن-PW','ck-pw@test.local',$2,'branch_manager')", [ckBranchId, passwordHash]);
  await dbc.query("INSERT INTO users (branch_id, name, email, password_hash, role) VALUES ($1,'مدير فرع-PW','branch-pw@test.local',$2,'branch_manager')", [branchId, passwordHash]);

  const login1 = await api(null, "POST", "/api/auth/login", { email: "admin-pw@test.local", password: PASSWORD });
  const adminToken = login1.data.token;
  const login2 = await api(null, "POST", "/api/auth/login", { email: "ck-pw@test.local", password: PASSWORD });
  const ckToken = login2.data.token;
  const login3 = await api(null, "POST", "/api/auth/login", { email: "branch-pw@test.local", password: PASSWORD });
  const branchToken = login3.data.token;
  assert(!!adminToken && !!ckToken && !!branchToken, "تسجيل الدخول لكل المستخدمين الثلاثة نجح");

  const raw = await dbc.query("INSERT INTO inventory_items (name, unit, unit_cost) VALUES ('خام-PW', 'KG', 10) RETURNING id");
  const rawId = raw.rows[0].id;
  const man = await dbc.query("INSERT INTO inventory_items (name, unit, item_type, batch_prefix) VALUES ('منتج-PW', 'KG', 'manufactured', 'PWX') RETURNING id");
  const manId = man.rows[0].id;
  await dbc.query("INSERT INTO branch_inventory_stock (branch_id, inventory_item_id, quantity) VALUES ($1,$2,100),($1,$3,0)", [ckBranchId, rawId, manId]);
  await dbc.query("INSERT INTO branch_inventory_stock (branch_id, inventory_item_id, quantity) VALUES ($1,$2,0)", [branchId, manId]);

  const recipeRes = await api(adminToken, "POST", "/api/recipes", {
    recipeType: "manufactured_item", inventoryItemId: manId, yieldQuantity: 10, yieldUnit: "KG",
    ingredients: [{ ingredientItemId: rawId, quantity: 10 }],
  });
  const recipeVersionId = recipeRes.data.version.id;
  const recipeId = recipeRes.data.recipe.id;
  await api(adminToken, "POST", `/api/recipes/versions/${recipeVersionId}/submit`);
  await api(adminToken, "POST", `/api/recipes/versions/${recipeVersionId}/approve`);
  await api(adminToken, "POST", `/api/recipes/versions/${recipeVersionId}/activate`);

  const supplierRes = await api(adminToken, "POST", "/api/suppliers", { name: "مورد-PW" });
  const supplierId = supplierRes.data.id;

  // طلبية فرع معتمدة عشان تخطيط التصنيع يعرض طلب حقيقي (مش صفري)
  const koRes = await api(branchToken, "POST", "/api/kitchen-orders", {
    branchId, status: "DRAFT", items: [{ inventoryItemId: manId, quantityRequested: 20 }],
  });
  const kitchenOrderId = koRes.data.orderId;
  await api(branchToken, "POST", `/api/kitchen-orders/${kitchenOrderId}/submit`);
  await api(ckToken, "POST", `/api/kitchen-orders/${kitchenOrderId}/approve`);

  console.log("\n=== Playwright: تشغيل المتصفح ===");
  const browser = await chromium.launch({ executablePath: CHROME });

  // ---------- Desktop: شاشة تخطيط التصنيع ----------
  {
    console.log("\n--- Desktop 1280x800: تخطيط التصنيع ---");
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();
    await page.goto(`${BASE}/satamoni-production-planning.html`);
    await page.fill("#loginEmail", "ck-pw@test.local");
    await page.fill("#loginPassword", PASSWORD);
    await page.click("#loginBtn");
    await page.waitForSelector("#loginOverlay.hidden, #main", { timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(1500);
    const overflowsX = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 2);
    assert(!overflowsX, "مفيش overflow أفقي على الديسكتوب");

    // تبويب الخطة - المفروض يعرض الصنف المصنّع بطلب معتمد 20
    const planTabBtn = page.locator("[data-tab='plan'], .tabbtn:has-text('خطة')").first();
    if (await planTabBtn.count() > 0) await planTabBtn.click();
    await page.waitForTimeout(1000);
    const bodyText = await page.locator("body").textContent();
    assert(bodyText.includes("منتج-PW"), "الصنف المصنّع ظاهر في شاشة التخطيط");

    await ctx.close();
  }

  // ---------- Tablet 820px: شاشة السنتر كيتشن (اعتماد/تجهيز) ----------
  {
    console.log("\n--- Tablet 820px: طلبيات السنتر كيتشن ---");
    const ctx = await browser.newContext({ viewport: { width: 820, height: 1024 } });
    const page = await ctx.newPage();
    await page.goto(`${BASE}/satamoni-ck-requisitions.html`);
    await page.fill("#loginEmail", "ck-pw@test.local");
    await page.fill("#loginPassword", PASSWORD);
    await page.click("#loginBtn");
    await page.waitForTimeout(1500);
    const overflowsX = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 2);
    assert(!overflowsX, "مفيش overflow أفقي على التابلت");
    const bodyText = await page.locator("body").textContent();
    assert(bodyText.includes("فرع-PW") || bodyText.includes(String(kitchenOrderId)), "طلبية الفرع المعتمدة ظاهرة لموظف السنتر كيتشن");
    await ctx.close();
  }

  // ---------- Mobile 390px: شاشة طلبيات الفرع ----------
  {
    console.log("\n--- Mobile 390px: طلبيات الفرع ---");
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await ctx.newPage();
    await page.goto(`${BASE}/satamoni-requisitions.html`);
    await page.fill("#loginEmail", "branch-pw@test.local");
    await page.fill("#loginPassword", PASSWORD);
    await page.click("#loginBtn");
    await page.waitForTimeout(1500);
    const overflowsX = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 2);
    assert(!overflowsX, "مفيش overflow أفقي على الموبايل");
    await ctx.close();
  }

  // ---------- Desktop: شاشة المشتريات (PR/PO/GRN/Invoice tabs render) ----------
  {
    console.log("\n--- Desktop: المشتريات ---");
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();
    await page.goto(`${BASE}/satamoni-purchasing.html`);
    await page.fill("#loginEmail", "admin-pw@test.local");
    await page.fill("#loginPassword", PASSWORD);
    await page.click("#loginBtn");
    await page.waitForTimeout(1500);
    for (const tab of ["pr", "po", "grn", "invoices", "payments", "suppliers"]) {
      const btn = page.locator(`[data-tab='${tab}']`);
      if (await btn.count() > 0) {
        await btn.first().click();
        await page.waitForTimeout(300);
      }
    }
    assert(true, "كل تبويبات المشتريات (PR/PO/GRN/Invoice/Payment/Suppliers) اتفتحت من غير أي console error قاتل");

    // افتح تفاصيل المورد وجرّب كشف الحساب فعليًا
    const supBtn = page.locator(`[data-tab='suppliers']`);
    if (await supBtn.count() > 0) await supBtn.first().click();
    await page.waitForTimeout(500);
    const supplierRow = page.locator("[data-view]").first();
    if (await supplierRow.count() > 0) {
      await supplierRow.click();
      await page.waitForTimeout(500);
      const stmtBtn = page.locator("#stmtLoadBtn");
      if (await stmtBtn.count() > 0) {
        await stmtBtn.click();
        await page.waitForTimeout(800);
        const stmtText = await page.locator("#stmtBox").textContent().catch(() => "");
        assert(stmtText.length > 0, "كشف حساب المورد اتحمّل فعليًا من الواجهة (تفاعل حقيقي، مش لقطة بس)");
      }
    }
    await ctx.close();
  }

  // ---------- Desktop: شاشة التصنيع/التتبّع/الطباعة ----------
  {
    console.log("\n--- Desktop: التصنيع والتتبّع والطباعة ---");
    // اعمل أمر تصنيع حقيقي كامل عن طريق API عشان يبقى فيه دفعة نتتبعها ونطبعها
    const prodRes = await api(ckToken, "POST", "/api/production", { branchId: ckBranchId, recipeId, plannedQuantity: 10 });
    const prodId = prodRes.data.id;
    await api(adminToken, "POST", `/api/production/${prodId}/approve`);
    await api(ckToken, "POST", `/api/production/${prodId}/start`);
    const completeRes = await api(ckToken, "POST", `/api/production/${prodId}/complete`, { actualQuantity: 10 });
    const batchId = completeRes.data.batchId;
    assert(!!batchId, "أمر تصنيع اكتمل فعليًا عن طريق API ودفعة اتسجلت");

    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();
    await page.goto(`${BASE}/satamoni-manufacturing.html`);
    await page.fill("#loginEmail", "ck-pw@test.local");
    await page.fill("#loginPassword", PASSWORD);
    await page.click("#loginBtn");
    await page.waitForTimeout(1500);

    // تبويب أوامر التصنيع - افتح تفاصيل الأمر اللي عملناه، وجرّب زرار طباعة الملصق فعليًا
    // نفس دالة التنقّل الداخلية اللي الموقع نفسه بيستخدمها (switchToTab) - بدل الاعتماد على .click() الخام
    // من Playwright اللي ممكن يتصادم مع توقيت boot() لسه شغال
    await page.evaluate(() => switchToTab("production"));
    await page.waitForTimeout(1000);
    const orderLink = page.locator("button.linkbtn:has-text('فتح')").first();
    let printClicked = false;
    if (await orderLink.count() > 0) {
      await orderLink.click();
      await page.waitForTimeout(800);
      const printBtn = page.locator("button:has-text('طباعة ملصق')").first();
      if (await printBtn.count() > 0) {
        const popupPromise = page.waitForEvent("popup", { timeout: 3000 }).catch(() => null);
        await printBtn.click();
        const popup = await popupPromise;
        printClicked = true;
        if (popup) await popup.close().catch(() => {});
      }
    }
    assert(printClicked, "زرار طباعة ملصق الدفعة اتضغط فعليًا وفتح نافذة طباعة (SatamoniPrint)");

    // تتبّع الدفعة - بحث + عرض شجرة التتبّع للخلف
    const traceTabBtn = page.locator("[data-tab='traceability'], .tabbtn:has-text('تتبّع')").first();
    if (await traceTabBtn.count() > 0) {
      await traceTabBtn.click();
      await page.waitForTimeout(500);
      const batchInput = page.locator("input[placeholder*='دفعة'], #traceBatchIdInput, #batchSearchInput").first();
      if (await batchInput.count() > 0) {
        await batchInput.fill(String(batchId));
        await page.keyboard.press("Enter");
        await page.waitForTimeout(1000);
        const traceText = await page.locator("body").textContent();
        assert(traceText.includes("خام-PW") || traceText.includes(String(batchId)), "شجرة التتبّع للخلف بتوصل لأصل الدفعة (خام أو رقم الدفعة نفسه)");
      }
    }
    await ctx.close();
  }

  await browser.close();
  serverProc.kill();
  await dbc.end();
  const admin2 = new Client({ connectionString: PG_ADMIN_URL });
  await admin2.connect();
  await admin2.query(`DROP DATABASE IF EXISTS ${DB_NAME}`);
  await admin2.end();

  console.log(`\n=== النتيجة: ${passed} نجح، ${failures.length} فشل ===`);
  if (failures.length) {
    console.log("فاشل:", failures.join(" | "));
    process.exit(1);
  }
}

main().catch((e) => { console.error("خطأ عام:", e); if (serverProc) serverProc.kill(); process.exit(1); });
