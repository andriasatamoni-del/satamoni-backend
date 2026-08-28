// نظام الطباعة: يغطي جزء الباك إند من الـ24 سيناريو المطلوبة في المواصفة - إنشاء print_jobs الصحيح
// حسب نوع الطلب/الحدث، التوجيه (محطة->طابعة) بما فيه فشل التوجيه الواضح (بدون ما يوقف الطلب أبدًا)،
// تفكيك الكومبو حسب محطة كل مكوّن، منع تكرار فاتورة الصالة، وAPI الـAgent (claim/printed/failed/retry)
// + الصلاحيات وعزل الفروع. ضد Postgres حقيقي زي باقي الاختبارات.
const { app, request, pool, seedUser, login, authed } = require("./helpers");
const { money } = require("../db/print-templates");

let branchA, branchB;
let managerAToken, managerBToken, adminToken, cashierAToken, cashierBToken;
let catPizza, catDrinks, itemPizza, variantPizza, itemDrink, variantDrink, comboId;

beforeAll(async () => {
  const bA = await pool.query("INSERT INTO branches (name) VALUES ('فرع طباعة-A-جست') RETURNING id");
  branchA = bA.rows[0].id;
  const bB = await pool.query("INSERT INTO branches (name) VALUES ('فرع طباعة-B-جست') RETURNING id");
  branchB = bB.rows[0].id;

  await seedUser({ branchId: branchA, name: "مدير-طباعة-A", email: "managerA-print@jest.test", role: "branch_manager" });
  await seedUser({ branchId: branchA, name: "كاشير-طباعة-A", email: "cashierA-print@jest.test", role: "cashier" });
  await seedUser({ branchId: branchB, name: "مدير-طباعة-B", email: "managerB-print@jest.test", role: "branch_manager" });
  await seedUser({ branchId: branchB, name: "كاشير-طباعة-B", email: "cashierB-print@jest.test", role: "cashier" });
  await seedUser({ name: "أدمن-طباعة", email: "admin-print@jest.test", role: "admin" });

  managerAToken = await login("managerA-print@jest.test");
  cashierAToken = await login("cashierA-print@jest.test");
  managerBToken = await login("managerB-print@jest.test");
  cashierBToken = await login("cashierB-print@jest.test");
  adminToken = await login("admin-print@jest.test");

  const cp = await pool.query("INSERT INTO menu_categories (name) VALUES ('طباعة-جست-بيتزا') RETURNING id");
  catPizza = cp.rows[0].id;
  const cd = await pool.query("INSERT INTO menu_categories (name) VALUES ('طباعة-جست-مشروبات') RETURNING id");
  catDrinks = cd.rows[0].id;

  const mp = await pool.query("INSERT INTO menu_items (category_id, name) VALUES ($1,'بيتزا-جست') RETURNING id", [catPizza]);
  itemPizza = mp.rows[0].id;
  const vp = await pool.query("INSERT INTO menu_item_variants (item_id, label, price) VALUES ($1,'وسط',100) RETURNING id", [itemPizza]);
  variantPizza = vp.rows[0].id;

  const md = await pool.query("INSERT INTO menu_items (category_id, name) VALUES ($1,'مشروب-جست') RETURNING id", [catDrinks]);
  itemDrink = md.rows[0].id;
  const vd = await pool.query("INSERT INTO menu_item_variants (item_id, label, price) VALUES ($1,'عادي',20) RETURNING id", [itemDrink]);
  variantDrink = vd.rows[0].id;

  const combo = await pool.query("INSERT INTO combos (name, price) VALUES ('كومبو-جست', 110) RETURNING id");
  comboId = combo.rows[0].id;
  await pool.query("INSERT INTO combo_items (combo_id, variant_id, quantity) VALUES ($1,$2,1)", [comboId, variantPizza]);
  await pool.query("INSERT INTO combo_items (combo_id, variant_id, quantity) VALUES ($1,$2,1)", [comboId, variantDrink]);
});

afterAll(async () => {
  await pool.end();
});

// makeDefault:true بيعمل PATCH فوري isDefaultForType=true - عشان فرع الاختبار (branchA) بيتشارك بين
// describe blocks كتير وبيتراكم فيه أكتر من طابعة لنفس النوع، فمن غير تحديد صريح للافتراضية resolvePrinterForType
// هياخد أقدم طابعة بالنوع ده (id ASC) مش اللي الاختبار الحالي عامله فعليًا - نفس المنطق اللي فرع حقيقي
// هيحتاجه أصلًا لو عنده أكتر من طابعة لنفس النوع
async function makePrinter(token, branchId, overrides = {}) {
  const res = await request(app).post("/api/printers").set(authed(token)).send({
    branchId, name: overrides.name || "طابعة-جست", printerType: overrides.printerType || "CASHIER",
    connectionType: "USB", osPrinterName: overrides.osPrinterName || "TEST-PRINTER-JEST",
  });
  expect(res.status).toBe(201);
  if (overrides.makeDefault) {
    const patched = await request(app).patch(`/api/printers/${res.body.id}`).set(authed(token)).send({ isDefaultForType: true });
    return patched.body;
  }
  return res.body;
}

async function makeStation(token, branchId, printerId, name = "محطة-جست") {
  const res = await request(app).post("/api/kitchen-stations").set(authed(token)).send({ branchId, name, printerId });
  expect(res.status).toBe(201);
  return res.body;
}

async function makeOrder(token, branchId, orderType, items) {
  const res = await request(app).post("/api/orders").set(authed(token)).send({
    branchId, source: "pos", orderType,
    tableNumber: orderType === "dinein" ? `T-طباعة-جست-${Date.now()}` : undefined,
    customerPhone: `018${Date.now()}`.slice(0, 11),
    items,
  });
  expect(res.status).toBe(201);
  return res.body.orderId;
}

async function printJobsForOrder(token, orderId) {
  const res = await request(app).get(`/api/print-jobs?branchId=${branchA}&orderId=${orderId}`).set(authed(token));
  expect(res.status).toBe(200);
  return res.body;
}

describe("إدارة الطابعات - CRUD وصلاحيات وعزل فروع", () => {
  test("مدير فرع يقدر ينشئ طابعة لفرعه", async () => {
    const p = await makePrinter(managerAToken, branchA, { name: "كاشير أمامي" });
    expect(p.branch_id).toBe(branchA);
    expect(p.is_enabled).toBe(true);
  });

  test("كاشير مش عنده صلاحية إدارة الطابعات", async () => {
    const res = await request(app).post("/api/printers").set(authed(cashierAToken)).send({
      branchId: branchA, name: "x", printerType: "CASHIER", osPrinterName: "x",
    });
    expect(res.status).toBe(403);
  });

  test("طابعة USB من غير اسم نظام تشغيل مرفوضة", async () => {
    const res = await request(app).post("/api/printers").set(authed(managerAToken)).send({
      branchId: branchA, name: "بدون اسم", printerType: "CASHIER", connectionType: "USB",
    });
    expect(res.status).toBe(400);
  });

  test("مدير فرع B مينفعش يشوف طابعات فرع A", async () => {
    const res = await request(app).get(`/api/printers?branchId=${branchA}`).set(authed(managerBToken));
    expect(res.status).toBe(403);
  });

  test("تعديل is_enabled/is_default_for_type", async () => {
    const p = await makePrinter(managerAToken, branchA, { name: "طابعة تعديل" });
    const res = await request(app).patch(`/api/printers/${p.id}`).set(authed(managerAToken)).send({ isEnabled: false, isDefaultForType: true });
    expect(res.status).toBe(200);
    expect(res.body.is_enabled).toBe(false);
    expect(res.body.is_default_for_type).toBe(true);
  });

  test("اختبار طباعة بينشئ print_jobs.TEST_PRINT حقيقي (نفس مسار الإنتاج)", async () => {
    const p = await makePrinter(managerAToken, branchA, { name: "طابعة اختبار" });
    const res = await request(app).post(`/api/printers/${p.id}/test-print`).set(authed(managerAToken));
    expect(res.status).toBe(201);
    expect(res.body.print_type).toBe("TEST_PRINT");
    expect(res.body.status).toBe("PENDING");
    expect(res.body.order_id).toBeNull();
  });

  test("طابعة معطّلة مينفعش تتعمل ليها اختبار طباعة", async () => {
    const p = await makePrinter(managerAToken, branchA, { name: "طابعة معطّلة" });
    await request(app).patch(`/api/printers/${p.id}`).set(authed(managerAToken)).send({ isEnabled: false });
    const res = await request(app).post(`/api/printers/${p.id}/test-print`).set(authed(managerAToken));
    expect(res.status).toBe(400);
  });

  test("حذف طابعة مربوطة بمحطة - المحطة ترجع بدون طابعة (ON DELETE SET NULL) مش بتتمنع", async () => {
    const p = await makePrinter(managerAToken, branchA, { name: "طابعة هتتمسح", printerType: "KITCHEN" });
    const s = await makeStation(managerAToken, branchA, p.id, "محطة هتفقد طابعتها");
    const del = await request(app).delete(`/api/printers/${p.id}`).set(authed(managerAToken));
    expect(del.status).toBe(200);
    const check = await request(app).get(`/api/kitchen-stations?branchId=${branchA}`).set(authed(managerAToken));
    const station = check.body.find((x) => x.id === s.id);
    expect(station.printer_id).toBeNull();
  });
});

describe("تيك أواي - إيصال + ملخص مطبخ + تذاكر مطبخ عند إنشاء الطلب مباشرة", () => {
  test("طلب تيك أواي بمحطة/طابعة متظبطة - CUSTOMER_RECEIPT+KITCHEN_SUMMARY+KITCHEN_TICKET كلهم PENDING", async () => {
    const cashierPrinter = await makePrinter(managerAToken, branchA, { name: "كاشير-تيك-جست", printerType: "CASHIER", makeDefault: true });
    const kitchenPrinter = await makePrinter(managerAToken, branchA, { name: "مطبخ-تيك-جست", printerType: "KITCHEN", makeDefault: true });
    const stationPrinter = await makePrinter(managerAToken, branchA, { name: "محطة-تيك-جست", printerType: "KITCHEN" });
    const station = await makeStation(managerAToken, branchA, stationPrinter.id, "محطة-تيك-جست-1");
    await request(app).patch(`/api/kitchen-stations/routing/menu-items/${itemPizza}`).set(authed(managerAToken)).send({ stationId: station.id });

    const orderId = await makeOrder(cashierAToken, branchA, "takeaway", [{ itemId: itemPizza, variantId: variantPizza, quantity: 2 }]);
    const jobs = await printJobsForOrder(managerAToken, orderId);
    const types = jobs.map((j) => j.print_type).sort();
    expect(types).toEqual(["CUSTOMER_RECEIPT", "KITCHEN_SUMMARY", "KITCHEN_TICKET"]);
    expect(jobs.every((j) => j.status === "PENDING")).toBe(true);

    const receipt = jobs.find((j) => j.print_type === "CUSTOMER_RECEIPT");
    expect(receipt.printer_id).toBe(cashierPrinter.id);
    const summary = jobs.find((j) => j.print_type === "KITCHEN_SUMMARY");
    expect(summary.printer_id).toBe(kitchenPrinter.id);
    const ticket = jobs.find((j) => j.print_type === "KITCHEN_TICKET");
    expect(ticket.printer_id).toBe(stationPrinter.id);
    expect(ticket.station_id).toBe(station.id);
    expect(ticket.content_html).toContain("بيتزا-جست");
  });

  test("طلب تيك أواي من غير أي توجيه متظبط - الطلب بينجح برضه (مبيتوقفش)، وKITCHEN_TICKET بيتسجل FAILED بسبب واضح", async () => {
    // فرع جديد نضيف - بدون أي طابعات/محطات خالص، عشان نتأكد التوجيه المفقود مبيوقفش إنشاء الطلب
    const bC = await pool.query("INSERT INTO branches (name) VALUES ('فرع طباعة-C-بدون-توجيه-جست') RETURNING id");
    const branchC = bC.rows[0].id;
    const mgrId = await seedUser({ branchId: branchC, name: "مدير-C-جست", email: "managerC-print@jest.test", role: "branch_manager" });
    const cashierId = await seedUser({ branchId: branchC, name: "كاشير-C-جست", email: "cashierC-print@jest.test", role: "cashier" });
    void mgrId; void cashierId;
    const cashierCToken = await login("cashierC-print@jest.test");
    const managerCToken = await login("managerC-print@jest.test");

    const res = await request(app).post("/api/orders").set(authed(cashierCToken)).send({
      branchId: branchC, source: "pos", orderType: "takeaway",
      customerPhone: `017${Date.now()}`.slice(0, 11),
      items: [{ itemId: itemPizza, variantId: variantPizza, quantity: 1 }],
    });
    expect(res.status).toBe(201); // الطلب نجح رغم مفيش أي طابعة متظبطة خالص - هذا هو المطلوب أصلًا

    const jobsRes = await request(app).get(`/api/print-jobs?branchId=${branchC}&orderId=${res.body.orderId}`).set(authed(managerCToken));
    expect(jobsRes.status).toBe(200);
    const receipt = jobsRes.body.find((j) => j.print_type === "CUSTOMER_RECEIPT");
    expect(receipt.status).toBe("FAILED");
    expect(receipt.printer_id).toBeNull();
    expect(receipt.last_error).toBeTruthy();
    const ticket = jobsRes.body.find((j) => j.print_type === "KITCHEN_TICKET");
    expect(ticket.status).toBe("FAILED");
    expect(ticket.last_error).toContain("محطة");
  });

  test("كومبو فيه بيتزا + مشروب من محطتين مختلفتين - تذكرتين مطبخ منفصلتين، كل واحدة فيها مكوّنها بس", async () => {
    const printerPizza = await makePrinter(managerAToken, branchA, { name: "محطة-بيتزا-كومبو-جست", printerType: "KITCHEN" });
    const printerDrinks = await makePrinter(managerAToken, branchA, { name: "محطة-مشروبات-كومبو-جست", printerType: "KITCHEN" });
    const stationPizza = await makeStation(managerAToken, branchA, printerPizza.id, "محطة-بيتزا-كومبو-جست-1");
    const stationDrinks = await makeStation(managerAToken, branchA, printerDrinks.id, "محطة-مشروبات-كومبو-جست-1");
    await request(app).patch(`/api/kitchen-stations/routing/menu-items/${itemPizza}`).set(authed(managerAToken)).send({ stationId: stationPizza.id });
    await request(app).patch(`/api/kitchen-stations/routing/menu-items/${itemDrink}`).set(authed(managerAToken)).send({ stationId: stationDrinks.id });

    const orderId = await makeOrder(cashierAToken, branchA, "takeaway", [{ comboId, quantity: 1 }]);
    const jobs = await printJobsForOrder(managerAToken, orderId);
    const tickets = jobs.filter((j) => j.print_type === "KITCHEN_TICKET");
    expect(tickets.length).toBe(2);
    const pizzaTicket = tickets.find((t) => t.station_id === stationPizza.id);
    const drinkTicket = tickets.find((t) => t.station_id === stationDrinks.id);
    expect(pizzaTicket.content_html).toContain("بيتزا-جست");
    expect(pizzaTicket.content_html).not.toContain("مشروب-جست");
    expect(drinkTicket.content_html).toContain("مشروب-جست");
    expect(drinkTicket.content_html).not.toContain("بيتزا-جست");
  });
});

describe("دليفري - ملخص دليفري + تذاكر مطبخ عند الإنشاء، إيصال نهائي عند التسليم للسائق بس", () => {
  test("طلب دليفري عند الإنشاء - DELIVERY_SUMMARY + KITCHEN_TICKET بس، من غير CUSTOMER_RECEIPT ولا DELIVERY_FINAL_RECEIPT", async () => {
    const deliveryPrinter = await makePrinter(managerAToken, branchA, { name: "دليفري-جست", printerType: "DELIVERY", makeDefault: true });
    const orderId = await makeOrder(cashierAToken, branchA, "delivery", [{ itemId: itemPizza, variantId: variantPizza, quantity: 1 }]);
    const jobs = await printJobsForOrder(managerAToken, orderId);
    const types = jobs.map((j) => j.print_type).sort();
    expect(types).toEqual(["DELIVERY_SUMMARY", "KITCHEN_TICKET"]);
    expect(jobs.find((j) => j.print_type === "DELIVERY_SUMMARY").printer_id).toBe(deliveryPrinter.id);
    expect(jobs.find((j) => j.print_type === "DELIVERY_SUMMARY").content_html).not.toContain(money(100)); // من غير سعر
  });

  test("لحظة تسليم الطلب للسائق (out-for-delivery) - DELIVERY_FINAL_RECEIPT بيتسجل (فيه سعر)", async () => {
    await makePrinter(managerAToken, branchA, { name: "دليفري-تسليم-جست", printerType: "DELIVERY" });
    const orderId = await makeOrder(cashierAToken, branchA, "delivery", [{ itemId: itemPizza, variantId: variantPizza, quantity: 1 }]);
    const driverUserId = await seedUser({ branchId: branchA, name: "سائق-طباعة-جست", email: `driver-print-${Date.now()}@jest.test`, role: "driver" });
    const driverRes = await pool.query(
      "INSERT INTO drivers (user_id, branch_id, driver_code, name) VALUES ($1,$2,$3,'سائق-طباعة-جست') RETURNING id",
      [driverUserId, branchA, `DRV-PRINT-${Date.now()}`]
    );
    await request(app).post(`/api/deliveries/${orderId}/assign`).set(authed(managerAToken)).send({ driverId: driverRes.rows[0].id });
    const res = await request(app).post(`/api/deliveries/${orderId}/out-for-delivery`).set(authed(managerAToken));
    expect(res.status).toBe(200);

    const jobs = await printJobsForOrder(managerAToken, orderId);
    const finalReceipt = jobs.find((j) => j.print_type === "DELIVERY_FINAL_RECEIPT");
    expect(finalReceipt).toBeTruthy();
    expect(finalReceipt.status).toBe("PENDING");
    expect(finalReceipt.content_html).toContain(money(100)); // فيه سعر (السطر × الكمية)
  });
});

describe("صالة - تذاكر مطبخ عند PREPARING بس، مفيش طباعة عند الإنشاء، فاتورة بطلب الجرسون من غير تكرار", () => {
  test("طلب صالة عند الإنشاء - مفيش أي print_jobs خالص", async () => {
    await makePrinter(managerAToken, branchA, { name: "كاشير-صالة-جست", printerType: "CASHIER" });
    const orderId = await makeOrder(cashierAToken, branchA, "dinein", [{ itemId: itemPizza, variantId: variantPizza, quantity: 1 }]);
    const jobs = await printJobsForOrder(managerAToken, orderId);
    expect(jobs.length).toBe(0);
  });

  test("لما kitchen_status توصل PREPARING - تذاكر مطبخ بس بتتسجل (من غير ملخص/إيصال)", async () => {
    const stationPrinter = await makePrinter(managerAToken, branchA, { name: "محطة-صالة-جست", printerType: "KITCHEN" });
    const station = await makeStation(managerAToken, branchA, stationPrinter.id, "محطة-صالة-جست-1");
    await request(app).patch(`/api/kitchen-stations/routing/menu-items/${itemPizza}`).set(authed(managerAToken)).send({ stationId: station.id });

    const orderId = await makeOrder(cashierAToken, branchA, "dinein", [{ itemId: itemPizza, variantId: variantPizza, quantity: 1 }]);
    await request(app).patch(`/api/orders/${orderId}/kitchen-status`).set(authed(cashierAToken)).send({ status: "ACCEPTED" });
    await request(app).patch(`/api/orders/${orderId}/kitchen-status`).set(authed(cashierAToken)).send({ status: "PREPARING" });

    const jobs = await printJobsForOrder(managerAToken, orderId);
    expect(jobs.map((j) => j.print_type)).toEqual(["KITCHEN_TICKET"]);
    expect(jobs[0].printer_id).toBe(stationPrinter.id);
  });

  test("فاتورة الصالة بطلب الجرسون - ضغطتين متتاليتين بيرجّعوا نفس الصف (مفيش فاتورة مكررة)", async () => {
    await makePrinter(managerAToken, branchA, { name: "كاشير-فاتورة-جست", printerType: "CASHIER" });
    const orderId = await makeOrder(cashierAToken, branchA, "dinein", [{ itemId: itemPizza, variantId: variantPizza, quantity: 1 }]);

    const r1 = await request(app).post(`/api/orders/${orderId}/print-bill`).set(authed(cashierAToken));
    expect(r1.status).toBe(201);
    const r2 = await request(app).post(`/api/orders/${orderId}/print-bill`).set(authed(cashierAToken));
    expect(r2.status).toBe(201);
    expect(r2.body.id).toBe(r1.body.id); // نفس الصف بالظبط - مفيش صف تاني اتعمل

    const jobs = await printJobsForOrder(managerAToken, orderId);
    expect(jobs.filter((j) => j.print_type === "DINE_IN_BILL").length).toBe(1);
  });

  test("فاتورة الصالة متاحة بس لطلبات الصالة", async () => {
    const orderId = await makeOrder(cashierAToken, branchA, "takeaway", [{ itemId: itemPizza, variantId: variantPizza, quantity: 1 }]);
    const res = await request(app).post(`/api/orders/${orderId}/print-bill`).set(authed(cashierAToken));
    expect(res.status).toBe(400);
  });
});

describe("API الـAgent (print-jobs) - claim/printed/failed/retry + عزل فروع", () => {
  async function makePendingJob() {
    const printer = await makePrinter(managerAToken, branchA, { name: `اجنت-${Date.now()}`, printerType: "CASHIER", makeDefault: true });
    const orderId = await makeOrder(cashierAToken, branchA, "takeaway", [{ itemId: itemPizza, variantId: variantPizza, quantity: 1 }]);
    const jobs = await printJobsForOrder(managerAToken, orderId);
    const job = jobs.find((j) => j.print_type === "CUSTOMER_RECEIPT");
    expect(job.printer_id).toBe(printer.id);
    return job;
  }

  test("claim بيحوّل PENDING لـPRINTING ويزود attempts", async () => {
    const job = await makePendingJob();
    const res = await request(app).post(`/api/print-jobs/${job.id}/claim`).set(authed(managerAToken));
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("PRINTING");
    expect(res.body.attempts).toBe(1);
  });

  test("claim تانية لنفس الـjob بعد ما اتحجزت مرفوضة (409) - منع تكرار طباعة", async () => {
    const job = await makePendingJob();
    await request(app).post(`/api/print-jobs/${job.id}/claim`).set(authed(managerAToken));
    const res = await request(app).post(`/api/print-jobs/${job.id}/claim`).set(authed(managerAToken));
    expect(res.status).toBe(409);
  });

  test("printed بعد claim ينجح، وقبل claim (PENDING) مرفوض", async () => {
    const job = await makePendingJob();
    const early = await request(app).post(`/api/print-jobs/${job.id}/printed`).set(authed(managerAToken));
    expect(early.status).toBe(409);
    await request(app).post(`/api/print-jobs/${job.id}/claim`).set(authed(managerAToken));
    const res = await request(app).post(`/api/print-jobs/${job.id}/printed`).set(authed(managerAToken));
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("PRINTED");
    expect(res.body.printed_at).not.toBeNull();
  });

  test("failed بعد claim بيسجّل السبب، وretry بيرجّعها PENDING نظيفة", async () => {
    const job = await makePendingJob();
    await request(app).post(`/api/print-jobs/${job.id}/claim`).set(authed(managerAToken));
    const failRes = await request(app).post(`/api/print-jobs/${job.id}/failed`).set(authed(managerAToken)).send({ error: "الطابعة مقطوعة" });
    expect(failRes.status).toBe(200);
    expect(failRes.body.status).toBe("FAILED");
    expect(failRes.body.last_error).toBe("الطابعة مقطوعة");

    const retryRes = await request(app).post(`/api/print-jobs/${job.id}/retry`).set(authed(managerAToken));
    expect(retryRes.status).toBe(200);
    expect(retryRes.body.status).toBe("PENDING");
    expect(retryRes.body.last_error).toBeNull();
  });

  test("مدير فرع B مينفعش يـclaim أمر طباعة فرع A", async () => {
    const job = await makePendingJob();
    const res = await request(app).post(`/api/print-jobs/${job.id}/claim`).set(authed(managerBToken));
    expect(res.status).toBe(403);
  });

  test("كاشير معندهوش print_jobs.manage_queue - مينفعش يـclaim", async () => {
    const job = await makePendingJob();
    const res = await request(app).post(`/api/print-jobs/${job.id}/claim`).set(authed(cashierAToken));
    expect(res.status).toBe(403);
  });
});

describe("عزل الفروع - المحطات والتوجيه", () => {
  test("مدير فرع B مينفعش ينشئ محطة مربوطة بطابعة فرع A", async () => {
    // مدير فرع (مش أدمن) branchId بتاعه بيتحدد من حسابه هو نفسه (req.user.branchId) - branchId في الـbody
    // بيتجاهل تمامًا لغير الأدمن. يعني هنا هتتحاول تتعمل محطة لفرع B، لكن بطابعة فرع A -> مرفوضة
    const p = await makePrinter(managerAToken, branchA, { name: "طابعة-عزل-جست", printerType: "KITCHEN" });
    const res = await request(app).post("/api/kitchen-stations").set(authed(managerBToken)).send({ branchId: branchA, name: "محطة-عزل-جست", printerId: p.id });
    expect(res.status).toBe(400);
  });

  test("الأدمن يقدر يدير طابعات ومحطات أي فرع", async () => {
    const p = await makePrinter(adminToken, branchA, { name: "طابعة-أدمن-جست", printerType: "KITCHEN" });
    const s = await makeStation(adminToken, branchA, p.id, "محطة-أدمن-جست");
    expect(s.branch_id).toBe(branchA);
  });
});
