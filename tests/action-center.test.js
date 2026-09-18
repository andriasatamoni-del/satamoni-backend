// مركز التنبيهات (Action Center) - اختبار مسار العمل الحرج بس: كل نوع تنبيه بيظهر لما شرطه يتحقق فعليًا
// (مش بس بيرجّع 200 فاضي)، صلاحيات الوصول، وعزل الفرع. المنطق التفصيلي لكل فحص فرعي (مخزون سالب/فرق
// تصنيع/مصروف متجاوز حده/فرق تكلفة طعام/استثناءات مدفوعات) أصلًا متغطّى في تقاريره المستقلة - هنا بنتأكد
// بس إن التجميع نفسه شغال صح ومش بيكسر عزل الصلاحيات/الفرع.
const { app, request, pool, seedUser, login, authed } = require("./helpers");

let branchId, otherBranchId;
let adminToken, managerToken, otherManagerToken, cashierToken;
let flourId, doughId;

async function createActiveRecipe({ inventoryItemId, yieldQuantity, ingredients }) {
  const created = await request(app).post("/api/recipes").set(authed(adminToken)).send({
    recipeType: "manufactured_item", inventoryItemId, yieldQuantity, yieldUnit: "unit", ingredients,
  });
  const versionId = created.body.version.id;
  await request(app).post(`/api/recipes/versions/${versionId}/submit`).set(authed(managerToken)).expect(200);
  await request(app).post(`/api/recipes/versions/${versionId}/approve`).set(authed(adminToken)).expect(200);
  await request(app).post(`/api/recipes/versions/${versionId}/activate`).set(authed(adminToken)).expect(200);
  const recipeRow = await pool.query("SELECT recipe_id FROM recipe_versions WHERE id = $1", [versionId]);
  return recipeRow.rows[0].recipe_id;
}

beforeAll(async () => {
  const b1 = await pool.query("INSERT INTO branches (name) VALUES ('فرع-تنبيهات-جست') RETURNING id");
  branchId = b1.rows[0].id;
  const b2 = await pool.query("INSERT INTO branches (name) VALUES ('فرع تاني-تنبيهات-جست') RETURNING id");
  otherBranchId = b2.rows[0].id;

  await seedUser({ name: "أدمن-تنبيهات", email: "admin-actioncenter@jest.test", role: "admin" });
  await seedUser({ branchId, name: "مدير فرع-تنبيهات", email: "manager-actioncenter@jest.test", role: "branch_manager" });
  await seedUser({ branchId: otherBranchId, name: "مدير فرع تاني-تنبيهات", email: "othermanager-actioncenter@jest.test", role: "branch_manager" });
  await seedUser({ branchId, name: "كاشير-تنبيهات", email: "cashier-actioncenter@jest.test", role: "cashier" });

  adminToken = await login("admin-actioncenter@jest.test");
  managerToken = await login("manager-actioncenter@jest.test");
  otherManagerToken = await login("othermanager-actioncenter@jest.test");
  cashierToken = await login("cashier-actioncenter@jest.test");

  const flour = await pool.query("INSERT INTO inventory_items (name, unit, unit_cost) VALUES ('دقيق-تنبيهات-جست', 'KG', 10) RETURNING id");
  flourId = flour.rows[0].id;
  const dough = await pool.query(
    "INSERT INTO inventory_items (name, unit, unit_cost, item_type) VALUES ('عجينة-تنبيهات-جست', 'KG', NULL, 'manufactured') RETURNING id"
  );
  doughId = dough.rows[0].id;
  await pool.query(
    "INSERT INTO branch_inventory_stock (branch_id, inventory_item_id, quantity) VALUES ($1,$2,1000),($3,$2,1000),($1,$4,0)",
    [branchId, flourId, otherBranchId, doughId]
  );
});

afterAll(async () => {
  await pool.end();
});

test("كاشير من غير صلاحية تقارير - 403", async () => {
  const res = await request(app).get("/api/reports/action-center").set(authed(cashierToken));
  expect(res.status).toBe(403);
});

test("مخزون سالب في فرع معيّن بيظهر كتنبيه HIGH", async () => {
  const item = await pool.query("INSERT INTO inventory_items (name, unit, unit_cost) VALUES ('صنف-سالب-تنبيهات-جست', 'KG', 5) RETURNING id");
  await pool.query("INSERT INTO branch_inventory_stock (branch_id, inventory_item_id, quantity) VALUES ($1,$2,-3)", [branchId, item.rows[0].id]);

  const res = await request(app).get(`/api/reports/action-center?branchId=${branchId}`).set(authed(adminToken));
  expect(res.status).toBe(200);
  const negativeStockAlert = res.body.alerts.find((a) => a.type === "NEGATIVE_STOCK" && a.branchId === branchId);
  expect(negativeStockAlert).toBeDefined();
  expect(negativeStockAlert.severity).toBe("HIGH");
  expect(res.body.countsBySeverity.HIGH).toBeGreaterThan(0);
});

test("مصروف تجاوز حد التنبيه بتاع بنده بيظهر في التنبيهات", async () => {
  const cat = await pool.query(
    "INSERT INTO expense_categories (name, alert_threshold) VALUES ('بند-تنبيهات-جست', 100) RETURNING id"
  );
  const today = new Date().toISOString().slice(0, 10);
  await pool.query(
    "INSERT INTO expenses (branch_id, business_date, category_id, amount, status) VALUES ($1,$2,$3,500,'POSTED')",
    [branchId, today, cat.rows[0].id]
  );

  const res = await request(app)
    .get(`/api/reports/action-center?branchId=${branchId}&from=${today}&to=${today}`)
    .set(authed(adminToken));
  expect(res.status).toBe(200);
  const expenseAlert = res.body.alerts.find((a) => a.type === "EXPENSE_OVER_THRESHOLD" && a.description.includes("بند-تنبيهات-جست"));
  expect(expenseAlert).toBeDefined();
});

test("فرق تصنيع كبير موثّق بسبب - بيظهر كتنبيه LOW (مش بديل لباقي التقرير التفصيلي)", async () => {
  const recipeId = await createActiveRecipe({
    inventoryItemId: doughId, yieldQuantity: 1,
    ingredients: [{ ingredientItemId: flourId, quantity: 1 }],
  });
  const created = await request(app).post("/api/production").set(authed(managerToken))
    .send({ branchId, recipeId, plannedQuantity: 100 });
  expect(created.status).toBe(201);
  await request(app).post(`/api/production/${created.body.id}/approve`).set(authed(adminToken)).expect(200);
  await request(app).post(`/api/production/${created.body.id}/start`).set(authed(managerToken)).expect(200);

  // فرق 100% (فعلي 50 بدل 100 مخطط) لازم سبب - بدون سبب لازم يترفض (يتأكد إن الحماية دي لسه شغالة)
  const rejectedWithoutReason = await request(app).post(`/api/production/${created.body.id}/complete`)
    .set(authed(managerToken)).send({ actualQuantity: 50 });
  expect(rejectedWithoutReason.status).toBe(400);
  expect(rejectedWithoutReason.body.code).toBe("VARIANCE_REASON_REQUIRED");

  const completed = await request(app).post(`/api/production/${created.body.id}/complete`)
    .set(authed(managerToken)).send({ actualQuantity: 50, varianceReason: "عجينة اتحرقت جزء منها - اختبار" });
  expect(completed.status).toBe(200);

  const today = new Date().toISOString().slice(0, 10);
  const res = await request(app)
    .get(`/api/reports/action-center?branchId=${branchId}&from=${today}&to=${today}`)
    .set(authed(adminToken));
  const productionAlert = res.body.alerts.find((a) => a.type === "PRODUCTION_VARIANCE_DOCUMENTED");
  expect(productionAlert).toBeDefined();
  expect(productionAlert.severity).toBe("LOW");
  expect(productionAlert.description).toContain("عجينة اتحرقت جزء منها");
});

test("مدير فرع بيشوف تنبيهات فرعه بس حتى لو حدد branchId لفرع تاني في الطلب", async () => {
  const item = await pool.query("INSERT INTO inventory_items (name, unit, unit_cost) VALUES ('صنف-سالب-فرع-تاني-جست', 'KG', 5) RETURNING id");
  await pool.query("INSERT INTO branch_inventory_stock (branch_id, inventory_item_id, quantity) VALUES ($1,$2,-1)", [otherBranchId, item.rows[0].id]);

  const res = await request(app)
    .get(`/api/reports/action-center?branchId=${otherBranchId}`)
    .set(authed(managerToken)); // مدير فرعId الأول، بس بيبعت branchId بتاع التاني في الطلب
  expect(res.status).toBe(200);
  const leakedAlert = res.body.alerts.find((a) => a.branchId === otherBranchId);
  expect(leakedAlert).toBeUndefined();

  const ownRes = await request(app).get("/api/reports/action-center").set(authed(otherManagerToken));
  const ownAlert = ownRes.body.alerts.find((a) => a.type === "NEGATIVE_STOCK" && a.branchId === otherBranchId);
  expect(ownAlert).toBeDefined();
});

test("صنف مستخدم في وصفة نشطة من غير تكلفة وحدة - بيظهر كتنبيه HIGH في عرض كل الفروع بس", async () => {
  const noCostIngredient = await pool.query(
    "INSERT INTO inventory_items (name, unit, unit_cost) VALUES ('صنف-من-غير-تكلفة-جست', 'KG', NULL) RETURNING id"
  );
  const cake = await pool.query(
    "INSERT INTO inventory_items (name, unit, unit_cost, item_type) VALUES ('كيكة-تنبيهات-جست', 'KG', NULL, 'manufactured') RETURNING id"
  );
  await createActiveRecipe({
    inventoryItemId: cake.rows[0].id, yieldQuantity: 1,
    ingredients: [{ ingredientItemId: noCostIngredient.rows[0].id, quantity: 1 }],
  });

  const allBranchesRes = await request(app).get("/api/reports/action-center").set(authed(adminToken));
  expect(allBranchesRes.status).toBe(200);
  const costAlert = allBranchesRes.body.alerts.find((a) => a.type === "ITEMS_MISSING_COST");
  expect(costAlert).toBeDefined();
  expect(costAlert.severity).toBe("HIGH");
  expect(costAlert.detail).toContain("صنف-من-غير-تكلفة-جست");

  const scopedRes = await request(app).get(`/api/reports/action-center?branchId=${branchId}`).set(authed(adminToken));
  expect(scopedRes.body.alerts.find((a) => a.type === "ITEMS_MISSING_COST")).toBeUndefined();

  const managerRes = await request(app).get("/api/reports/action-center").set(authed(managerToken));
  expect(managerRes.body.alerts.find((a) => a.type === "ITEMS_MISSING_COST")).toBeUndefined();
});

test("أمر شراء APPROVED فات معاد تسليمه المتوقع ولسه فيه كمية متبقية - بيظهر كتنبيه MEDIUM", async () => {
  const supplier = await pool.query("INSERT INTO suppliers (name) VALUES ('مورد-متأخر-جست') RETURNING id");
  const item = await pool.query("INSERT INTO inventory_items (name, unit, unit_cost) VALUES ('صنف-أمر-متأخر-جست', 'KG', 20) RETURNING id");
  const po = await pool.query(
    `INSERT INTO purchase_orders (supplier_id, branch_id, expected_delivery_date, status)
     VALUES ($1,$2, CURRENT_DATE - INTERVAL '3 days', 'APPROVED') RETURNING id`,
    [supplier.rows[0].id, branchId]
  );
  await pool.query(
    `INSERT INTO purchase_order_items (purchase_order_id, inventory_item_id, ordered_quantity, unit_price, received_quantity)
     VALUES ($1,$2,10,20,0)`,
    [po.rows[0].id, item.rows[0].id]
  );

  const res = await request(app).get(`/api/reports/action-center?branchId=${branchId}`).set(authed(adminToken));
  expect(res.status).toBe(200);
  const overdueAlert = res.body.alerts.find((a) => a.type === "OVERDUE_PURCHASE_ORDERS" && a.branchId === branchId);
  expect(overdueAlert).toBeDefined();
  expect(overdueAlert.severity).toBe("MEDIUM");
  expect(overdueAlert.detail).toContain("مورد-متأخر-جست");

  // اتقفل بالكامل (received_quantity = ordered_quantity) - مايظهرش تاني
  await pool.query("UPDATE purchase_order_items SET received_quantity = 10 WHERE purchase_order_id = $1", [po.rows[0].id]);
  const afterReceipt = await request(app).get(`/api/reports/action-center?branchId=${branchId}`).set(authed(adminToken));
  expect(afterReceipt.body.alerts.find((a) => a.type === "OVERDUE_PURCHASE_ORDERS" && a.branchId === branchId)).toBeUndefined();
});

test("فاتورة مورد فات معاد استحقاقها ولسه فيها مبلغ متبقي - بيظهر كتنبيه MEDIUM، ويختفي بعد السداد الكامل", async () => {
  const supplier = await pool.query("INSERT INTO suppliers (name) VALUES ('مورد-فاتورة-متأخرة-جست') RETURNING id");
  const invoice = await pool.query(
    `INSERT INTO supplier_invoices (supplier_id, branch_id, supplier_invoice_number, due_date, total, status)
     VALUES ($1,$2,'INV-OVERDUE-JEST-1', CURRENT_DATE - INTERVAL '5 days', 1000, 'APPROVED') RETURNING id`,
    [supplier.rows[0].id, branchId]
  );

  const res = await request(app).get(`/api/reports/action-center?branchId=${branchId}`).set(authed(adminToken));
  expect(res.status).toBe(200);
  const overdueInvoiceAlert = res.body.alerts.find((a) => a.type === "OVERDUE_SUPPLIER_INVOICES" && a.branchId === branchId);
  expect(overdueInvoiceAlert).toBeDefined();
  expect(overdueInvoiceAlert.severity).toBe("MEDIUM");
  expect(overdueInvoiceAlert.detail).toContain("مورد-فاتورة-متأخرة-جست");

  // سداد جزئي بس - لسه لازم يظهر
  await pool.query(
    "INSERT INTO supplier_payments (supplier_id, branch_id, amount, supplier_invoice_id) VALUES ($1,$2,400,$3)",
    [supplier.rows[0].id, branchId, invoice.rows[0].id]
  );
  const afterPartial = await request(app).get(`/api/reports/action-center?branchId=${branchId}`).set(authed(adminToken));
  expect(afterPartial.body.alerts.find((a) => a.type === "OVERDUE_SUPPLIER_INVOICES" && a.branchId === branchId)).toBeDefined();

  // سداد المتبقي بالكامل - مايظهرش تاني
  await pool.query(
    "INSERT INTO supplier_payments (supplier_id, branch_id, amount, supplier_invoice_id) VALUES ($1,$2,600,$3)",
    [supplier.rows[0].id, branchId, invoice.rows[0].id]
  );
  const afterFull = await request(app).get(`/api/reports/action-center?branchId=${branchId}`).set(authed(adminToken));
  expect(afterFull.body.alerts.find((a) => a.type === "OVERDUE_SUPPLIER_INVOICES" && a.branchId === branchId)).toBeUndefined();
});

test("شكوى عميل فاضلة مفتوحة من غير حل لأكتر من المدة الافتراضية - بيظهر كتنبيه MEDIUM، ومش الشكاوى الحديثة", async () => {
  const staleOrder = await pool.query(
    "INSERT INTO orders (branch_id, source, order_type, status, total) VALUES ($1,'pos','takeaway','completed',80) RETURNING id",
    [branchId]
  );
  const staleComplaint = await pool.query(
    `INSERT INTO customer_complaints (order_id, branch_id, customer_phone, category, status, created_at)
     VALUES ($1,$2,'01055500001','quality','open', now() - INTERVAL '5 days') RETURNING id`,
    [staleOrder.rows[0].id, branchId]
  );

  const freshOrder = await pool.query(
    "INSERT INTO orders (branch_id, source, order_type, status, total) VALUES ($1,'pos','takeaway','completed',80) RETURNING id",
    [branchId]
  );
  await pool.query(
    `INSERT INTO customer_complaints (order_id, branch_id, customer_phone, category, status, created_at)
     VALUES ($1,$2,'01055500002','other','open', now() - INTERVAL '1 day')`,
    [freshOrder.rows[0].id, branchId]
  );

  const res = await request(app).get(`/api/reports/action-center?branchId=${branchId}`).set(authed(adminToken));
  expect(res.status).toBe(200);
  const staleAlert = res.body.alerts.find((a) => a.type === "STALE_COMPLAINTS" && a.branchId === branchId);
  expect(staleAlert).toBeDefined();
  expect(staleAlert.severity).toBe("MEDIUM");
  expect(staleAlert.description).toContain("1 شكوى");

  await pool.query("UPDATE customer_complaints SET status = 'resolved' WHERE id = $1", [staleComplaint.rows[0].id]);
  const afterResolve = await request(app).get(`/api/reports/action-center?branchId=${branchId}`).set(authed(adminToken));
  expect(afterResolve.body.alerts.find((a) => a.type === "STALE_COMPLAINTS" && a.branchId === branchId)).toBeUndefined();
});

test("مدى افتراضي (آخر 7 أيام) لو from/to مش مبعوتين - مفيش رفض 400", async () => {
  const res = await request(app).get("/api/reports/action-center").set(authed(adminToken));
  expect(res.status).toBe(200);
  expect(res.body.from).toBeTruthy();
  expect(res.body.to).toBeTruthy();
  expect(Array.isArray(res.body.alerts)).toBe(true);
});
