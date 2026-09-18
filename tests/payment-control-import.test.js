// Payment Control & Reconciliation - Phase 2: استيراد ملفات (CSV/Excel) + مطابقة تلقائية. راجع
// db/payment-reconciliation-import.js للشرح الكامل ليه الاستيراد موضعي (بيختار المحاسب الأعمدة) بدل
// تخمين أسماء أعمدة ثابتة - مفيش ملف حقيقي من أي مزوّد اتاح وقت الكتابة.
const { app, request, pool, seedUser, login, authed } = require("./helpers");

let branchId, branch2Id;
let accountantToken, accountant2Token, managerToken, cashierToken;
let menuItemId, variantId, instapayMethodId, visaMethodId;

beforeAll(async () => {
  const b1 = await pool.query("INSERT INTO branches (name) VALUES ('فرع-PCI-1') RETURNING id");
  branchId = b1.rows[0].id;
  const b2 = await pool.query("INSERT INTO branches (name) VALUES ('فرع-PCI-2') RETURNING id");
  branch2Id = b2.rows[0].id;

  await seedUser({ branchId, name: "محاسب-PCI", email: "accountant-pci@jest.test", role: "accountant", pin: "5555" });
  accountantToken = await login("accountant-pci@jest.test");
  await seedUser({ branchId: branch2Id, name: "محاسب-PCI-2", email: "accountant2-pci@jest.test", role: "accountant", pin: "6666" });
  accountant2Token = await login("accountant2-pci@jest.test");
  await seedUser({ branchId, name: "مشرف-PCI", email: "manager-pci@jest.test", role: "branch_manager", pin: "7777" });
  managerToken = await login("manager-pci@jest.test");
  await seedUser({ branchId, name: "كاشير-PCI", email: "cashier-pci@jest.test", role: "cashier" });
  cashierToken = await login("cashier-pci@jest.test");

  const cat = await pool.query("INSERT INTO menu_categories (name) VALUES ('PCI-قسم') RETURNING id");
  const mi = await pool.query("INSERT INTO menu_items (category_id, name) VALUES ($1,'PCI-صنف') RETURNING id", [cat.rows[0].id]);
  menuItemId = mi.rows[0].id;
  const v = await pool.query("INSERT INTO menu_item_variants (item_id, label, price) VALUES ($1,'عادي',300) RETURNING id", [mi.rows[0].id]);
  variantId = v.rows[0].id;

  const insta = await pool.query(
    "INSERT INTO payment_methods (name, kind, settlement_channel) VALUES ('إنستاباي-PCI', 'card_or_wallet', 'instapay') RETURNING id"
  );
  instapayMethodId = insta.rows[0].id;
  const visa = await pool.query(
    "INSERT INTO payment_methods (name, kind, settlement_channel) VALUES ('فيزا-PCI', 'card_or_wallet', 'visa_pos') RETURNING id"
  );
  visaMethodId = visa.rows[0].id;
});

afterAll(async () => {
  await pool.end();
});

async function makeOrder(paymentMethodId) {
  const res = await request(app).post("/api/orders").set(authed(cashierToken)).send({
    branchId, source: "pos", orderType: "takeaway", paymentMethodId,
    items: [{ itemId: menuItemId, variantId, quantity: 1 }],
  });
  expect(res.status).toBe(201);
  return res.body.orderId;
}
async function paymentForOrder(orderId) {
  const r = await pool.query("SELECT * FROM payments WHERE order_id = $1", [orderId]);
  return r.rows[0];
}

test("1) preview: بيرجّع الصفوف الخام وعدد الأعمدة من غير أي تفسير", async () => {
  const csv = "التاريخ,المبلغ,المرجع\n05/01/2026,300,REF1\n06/01/2026,150,REF2\n";
  const res = await request(app).post("/api/payment-control/reconciliation-records/import/preview")
    .set(authed(accountantToken)).field("source", "instapay").attach("file", Buffer.from(csv), "statement.csv");
  expect(res.status).toBe(200);
  expect(res.body.columnCount).toBe(3);
  expect(res.body.sampleRows.length).toBe(3); // header + صفين بيانات
});

test("2) commit: استيراد إنستاباي بترتيب أعمدة مختلف + صف فاسد واحد يتخطّى من غير ما يوقف الباقي", async () => {
  const csv = "المرجع,التاريخ,المبلغ\nREF-A,08/01/2026,222.50\nREF-B,09/01/2026,مش رقم\nREF-C,10/01/2026,333\n";
  const res = await request(app).post("/api/payment-control/reconciliation-records/import/commit")
    .set(authed(accountantToken))
    .field("source", "instapay").field("branchId", String(branchId))
    .field("dateColumn", "1").field("amountColumn", "2").field("referenceColumn", "0").field("hasHeaderRow", "true")
    .attach("file", Buffer.from(csv), "statement.csv");
  expect(res.status).toBe(201);
  expect(res.body.imported).toBe(2);
  expect(res.body.errors.length).toBe(1);
  expect(res.body.errors[0].message).toMatch(/مبلغ/);

  const rows = await pool.query(
    "SELECT * FROM payment_reconciliation_records WHERE import_batch_id = $1 ORDER BY external_date", [res.body.batchId]
  );
  expect(rows.rows.length).toBe(2);
  expect(Number(rows.rows[0].external_amount)).toBe(222.5);
});

test("3) مطابقة تلقائية بعد الاستيراد: سطر كشف له دفعة واحدة مطابقة ضمن السماحية يتطابق فورًا", async () => {
  const orderId = await makeOrder(instapayMethodId);
  const payment = await paymentForOrder(orderId);
  const day = payment.locked_at.toISOString().slice(0, 10);

  const csv = `التاريخ,المبلغ,المرجع\n${day},300,AUTO-MATCH-1\n`;
  const res = await request(app).post("/api/payment-control/reconciliation-records/import/commit")
    .set(authed(accountantToken))
    .field("source", "instapay").field("branchId", String(branchId))
    .field("dateColumn", "0").field("amountColumn", "1").field("referenceColumn", "2").field("hasHeaderRow", "true")
    .attach("file", Buffer.from(csv), "s.csv");
  expect(res.status).toBe(201);
  expect(res.body.autoMatch.matched).toBe(1);

  const record = await pool.query(
    "SELECT * FROM payment_reconciliation_records WHERE import_batch_id = $1", [res.body.batchId]
  );
  expect(record.rows[0].match_status).toBe("MATCHED");
  expect(record.rows[0].matched_payment_id).toBe(payment.id);
});

test("4) غموض (أكتر من مرشح): مفيش مطابقة تلقائية - النظام مايخمّنش", async () => {
  const orderIdA = await makeOrder(instapayMethodId);
  const orderIdB = await makeOrder(instapayMethodId);
  const paymentA = await paymentForOrder(orderIdA);
  const day = paymentA.locked_at.toISOString().slice(0, 10);
  // نفس المبلغ بالظبط لدفعتين في نفس اليوم - سطر الكشف مش هيعرف يميّز أيهما، فيتسيب UNMATCHED
  await pool.query("UPDATE payments SET amount = 300 WHERE order_id IN ($1,$2)", [orderIdA, orderIdB]);

  const csv = `التاريخ,المبلغ,المرجع\n${day},300,AMBIG-1\n`;
  const res = await request(app).post("/api/payment-control/reconciliation-records/import/commit")
    .set(authed(accountantToken))
    .field("source", "instapay").field("branchId", String(branchId))
    .field("dateColumn", "0").field("amountColumn", "1").field("referenceColumn", "2").field("hasHeaderRow", "true")
    .attach("file", Buffer.from(csv), "s.csv");
  expect(res.status).toBe(201);
  expect(res.body.autoMatch.matched).toBe(0);

  const record = await pool.query(
    "SELECT match_status FROM payment_reconciliation_records WHERE import_batch_id = $1", [res.body.batchId]
  );
  expect(record.rows[0].match_status).toBe("UNMATCHED");
});

test("5) طلبات/فيزا: الاستيراد بينجح من غير أي محاولة مطابقة سطرية (مقارنة إجمالي مش سطرية)", async () => {
  const csv = "التاريخ,المبلغ\n2026-01-05,5000\n";
  const res = await request(app).post("/api/payment-control/reconciliation-records/import/commit")
    .set(authed(accountantToken))
    .field("source", "visa_settlement").field("branchId", String(branchId))
    .field("dateColumn", "0").field("amountColumn", "1").field("hasHeaderRow", "true")
    .attach("file", Buffer.from(csv), "s.csv");
  expect(res.status).toBe(201);
  expect(res.body.imported).toBe(1);
  expect(res.body.autoMatch).toBeNull();
});

test("6) إلغاء دفعة استيراد: بينجح لو كل السطور لسه UNMATCHED، ويترفض لو فيها سطر اتطابق", async () => {
  const csv = "التاريخ,المبلغ,المرجع\n2026-01-15,111,UNDO-1\n2026-01-16,222,UNDO-2\n";
  const commitRes = await request(app).post("/api/payment-control/reconciliation-records/import/commit")
    .set(authed(accountantToken))
    .field("source", "orange_cash").field("branchId", String(branchId))
    .field("dateColumn", "0").field("amountColumn", "1").field("referenceColumn", "2").field("hasHeaderRow", "true")
    .attach("file", Buffer.from(csv), "s.csv");
  expect(commitRes.status).toBe(201);

  const deleteRes = await request(app).delete(`/api/payment-control/reconciliation-records/import-batches/${commitRes.body.batchId}`)
    .set(authed(accountantToken));
  expect(deleteRes.status).toBe(200);
  expect(deleteRes.body.deleted).toBe(2);

  const remaining = await pool.query(
    "SELECT * FROM payment_reconciliation_records WHERE import_batch_id = $1", [commitRes.body.batchId]
  );
  expect(remaining.rows.length).toBe(0);

  const auditLog = await pool.query(
    "SELECT * FROM payment_audit_logs WHERE action_type = 'RECONCILIATION_IMPORT_BATCH_CANCELLED' AND branch_id = $1 ORDER BY id DESC LIMIT 1",
    [branchId]
  );
  expect(auditLog.rows.length).toBe(1);
  expect(auditLog.rows[0].actor_id).toBeTruthy();
  expect(auditLog.rows[0].before_state.batchId).toBe(commitRes.body.batchId);
  expect(auditLog.rows[0].before_state.deleted).toBe(2);
});

test("7) إلغاء دفعة فيها سطر اتطابق بالفعل - مرفوض", async () => {
  const orderId = await makeOrder(instapayMethodId);
  const payment = await paymentForOrder(orderId);
  const day = payment.locked_at.toISOString().slice(0, 10);
  // مبلغ مميّز (مش 300 - القيمة الافتراضية اللي الاختبارات التانية بتسيب دفعات UNMATCHED بيها) عشان
  // نضمن مرشح واحد بس متاح، مش نتأثر بدفعات غموض متروكة من اختبار سابق
  await pool.query("UPDATE payments SET amount = 480.75 WHERE id = $1", [payment.id]);

  const csv = `التاريخ,المبلغ,المرجع\n${day},480.75,MATCHED-UNDO-TEST\n`;
  const commitRes = await request(app).post("/api/payment-control/reconciliation-records/import/commit")
    .set(authed(accountantToken))
    .field("source", "instapay").field("branchId", String(branchId))
    .field("dateColumn", "0").field("amountColumn", "1").field("referenceColumn", "2").field("hasHeaderRow", "true")
    .attach("file", Buffer.from(csv), "s.csv");
  expect(commitRes.body.autoMatch.matched).toBe(1); // اتطابقت أوتوماتيك (دفعة فريدة متاحة)

  const deleteRes = await request(app).delete(`/api/payment-control/reconciliation-records/import-batches/${commitRes.body.batchId}`)
    .set(authed(accountantToken));
  expect(deleteRes.status).toBe(400);

  const stillThere = await pool.query(
    "SELECT * FROM payment_reconciliation_records WHERE import_batch_id = $1", [commitRes.body.batchId]
  );
  expect(stillThere.rows.length).toBe(1);
});

test("8) عزل الفروع: محاسب فرع تاني مايقدرش يستورد ولا يلغي دفعة فرع مختلف", async () => {
  const csv = "التاريخ,المبلغ\n2026-01-20,100\n";
  const importRes = await request(app).post("/api/payment-control/reconciliation-records/import/commit")
    .set(authed(accountant2Token))
    .field("source", "visa_settlement").field("branchId", String(branchId))
    .field("dateColumn", "0").field("amountColumn", "1").field("hasHeaderRow", "true")
    .attach("file", Buffer.from(csv), "s.csv");
  expect(importRes.status).toBe(403);

  const ownCsv = "التاريخ,المبلغ\n2026-01-20,100\n";
  const ownImport = await request(app).post("/api/payment-control/reconciliation-records/import/commit")
    .set(authed(accountantToken))
    .field("source", "visa_settlement").field("branchId", String(branchId))
    .field("dateColumn", "0").field("amountColumn", "1").field("hasHeaderRow", "true")
    .attach("file", Buffer.from(ownCsv), "s.csv");
  expect(ownImport.status).toBe(201);

  const deleteRes = await request(app).delete(`/api/payment-control/reconciliation-records/import-batches/${ownImport.body.batchId}`)
    .set(authed(accountant2Token));
  expect(deleteRes.status).toBe(403);
});

test("9) مدير الفرع (Shift Supervisor) معندوش صلاحية يستورد - reconciliation.enter لمحاسب/أدمن بس", async () => {
  const csv = "التاريخ,المبلغ\n2026-01-20,100\n";
  const res = await request(app).post("/api/payment-control/reconciliation-records/import/commit")
    .set(authed(managerToken))
    .field("source", "visa_settlement").field("branchId", String(branchId))
    .field("dateColumn", "0").field("amountColumn", "1").field("hasHeaderRow", "true")
    .attach("file", Buffer.from(csv), "s.csv");
  expect(res.status).toBe(403);
});

// -------------------- تحديث قنوات تسوية الطلبات القديمة (backfill-settlement-channels) --------------------
// إعادة إنتاج حقيقية للباج اللي حصل فعليًا أول استخدام للميزة: طريقة دفع اتضافلها قناة تسوية *بعد* ما
// طلبات اتسجّلت عليها بالفعل - الدفعات القديمة دي لازم تتحدّث، من غير ما نلمس دفعة قناتها متحددة أصلًا

test("10) طلب اتسجّل قبل ما القناة تتظبط على طريقة الدفع - backfill بيصلّحه", async () => {
  const pm = await pool.query("INSERT INTO payment_methods (name, kind) VALUES ('فيزا-متأخرة-PCI', 'card_or_wallet') RETURNING id");
  const orderId = await makeOrder(pm.rows[0].id);
  const before = await paymentForOrder(orderId);
  expect(before.settlement_channel).toBeNull(); // زي ما هو متوقع - القناة كانت فاضية وقت القفل

  // دلوقتي الأدمن بيظبط القناة على طريقة الدفع (بعد ما الطلب اتسجّل بالفعل)
  await pool.query("UPDATE payment_methods SET settlement_channel = 'visa_pos' WHERE id = $1", [pm.rows[0].id]);

  const res = await request(app).post("/api/payment-control/backfill-settlement-channels")
    .set(authed(accountantToken)).send({ branchId });
  expect(res.status).toBe(200);
  expect(res.body.updated).toBeGreaterThanOrEqual(1);

  const after = await paymentForOrder(orderId);
  expect(after.settlement_channel).toBe("visa_pos");
});

test("11) backfill ميلمسش دفعة قناتها متحددة أصلًا حتى لو طريقة الدفع اتغيّرت بعد كده", async () => {
  const orderId = await makeOrder(instapayMethodId); // instapayMethodId قناته 'instapay' من الأساس
  const before = await paymentForOrder(orderId);
  expect(before.settlement_channel).toBe("instapay");

  // نفترض حد غيّر قناة طريقة الدفع بعد كده لقيمة تانية
  await pool.query("UPDATE payment_methods SET settlement_channel = 'orange_cash' WHERE id = $1", [instapayMethodId]);

  await request(app).post("/api/payment-control/backfill-settlement-channels").set(authed(accountantToken)).send({ branchId });

  const after = await paymentForOrder(orderId);
  expect(after.settlement_channel).toBe("instapay"); // فضلت زي ما هي - مش اتكتبت فوقها
  await pool.query("UPDATE payment_methods SET settlement_channel = 'instapay' WHERE id = $1", [instapayMethodId]); // نرجّعها لحالتها الأصلية لباقي الاختبارات
});

test("12) عزل الفروع: محاسب فرع تاني مايقدرش يشغّل backfill لفرع مختلف", async () => {
  const res = await request(app).post("/api/payment-control/backfill-settlement-channels")
    .set(authed(accountant2Token)).send({ branchId });
  expect(res.status).toBe(403);
});

// -------------------- حذف سطر مطابقة مُدخل يدوي/بالغلط (DELETE /reconciliation-records/:id) --------------------
test("13) حذف سطر UNMATCHED بينجح ويشيله من القايمة", async () => {
  const created = await request(app).post("/api/payment-control/reconciliation-records").set(authed(accountantToken)).send({
    branchId, source: "visa_settlement", externalAmount: 999, externalDate: "2026-01-25", externalReference: "TO-DELETE",
  });
  expect(created.status).toBe(201);

  const del = await request(app).delete(`/api/payment-control/reconciliation-records/${created.body.id}`).set(authed(accountantToken));
  expect(del.status).toBe(200);

  const check = await pool.query("SELECT * FROM payment_reconciliation_records WHERE id = $1", [created.body.id]);
  expect(check.rows.length).toBe(0);

  const auditLog = await pool.query(
    "SELECT * FROM payment_audit_logs WHERE action_type = 'RECONCILIATION_DELETED' AND branch_id = $1 ORDER BY id DESC LIMIT 1",
    [branchId]
  );
  expect(auditLog.rows.length).toBe(1);
  expect(auditLog.rows[0].before_state.external_reference).toBe("TO-DELETE");
});

test("13ب) مطابقة يدوية صريحة (PATCH /:id/match) بتسجّل في سجل التدقيق", async () => {
  const orderId = await makeOrder(visaMethodId);
  const payment = await paymentForOrder(orderId);
  await pool.query("UPDATE payments SET amount = 733.5 WHERE id = $1", [payment.id]);

  const created = await request(app).post("/api/payment-control/reconciliation-records").set(authed(accountantToken)).send({
    branchId, source: "visa_settlement", externalAmount: 733.5, externalDate: "2026-01-27", externalReference: "MANUAL-MATCH-TEST",
  });
  expect(created.status).toBe(201);

  const matchRes = await request(app).patch(`/api/payment-control/reconciliation-records/${created.body.id}/match`)
    .set(authed(accountantToken)).send({ paymentId: payment.id });
  expect(matchRes.status).toBe(200);
  expect(matchRes.body.match_status).toBe("MATCHED");
  expect(matchRes.body.matched_payment_id).toBe(payment.id);

  const auditLog = await pool.query(
    "SELECT * FROM payment_audit_logs WHERE action_type = 'RECONCILIATION_MATCHED_MANUAL' AND payment_id = $1 ORDER BY id DESC LIMIT 1",
    [payment.id]
  );
  expect(auditLog.rows.length).toBe(1);
  expect(auditLog.rows[0].before_state.match_status).toBe("UNMATCHED");
  expect(auditLog.rows[0].after_state.match_status).toBe("MATCHED");
});

test("14) حذف سطر MATCHED بالفعل مرفوض", async () => {
  const orderId = await makeOrder(instapayMethodId);
  const payment = await paymentForOrder(orderId);
  const day = payment.locked_at.toISOString().slice(0, 10);
  // مبلغ مميّز - نفس سبب الاختبار المشابه فوق: نتجنب التصادم مع دفعات UNMATCHED متروكة من اختبارات تانية
  await pool.query("UPDATE payments SET amount = 512.34 WHERE id = $1", [payment.id]);

  const created = await request(app).post("/api/payment-control/reconciliation-records").set(authed(accountantToken)).send({
    branchId, source: "instapay", externalAmount: 512.34, externalDate: day, externalReference: "TO-STAY-MATCHED",
  });
  await request(app).post("/api/payment-control/reconciliation-records/match-auto").set(authed(accountantToken))
    .send({ source: "instapay", branchId });

  const check = await pool.query("SELECT match_status FROM payment_reconciliation_records WHERE id = $1", [created.body.id]);
  expect(check.rows[0].match_status).toBe("MATCHED");

  const del = await request(app).delete(`/api/payment-control/reconciliation-records/${created.body.id}`).set(authed(accountantToken));
  expect(del.status).toBe(400);
});

test("15) عزل الفروع: محاسب فرع تاني مايقدرش يمسح سطر فرع مختلف", async () => {
  const created = await request(app).post("/api/payment-control/reconciliation-records").set(authed(accountantToken)).send({
    branchId, source: "visa_settlement", externalAmount: 50, externalDate: "2026-01-26", externalReference: "BRANCH-ISOLATION",
  });
  const del = await request(app).delete(`/api/payment-control/reconciliation-records/${created.body.id}`).set(authed(accountant2Token));
  expect(del.status).toBe(403);
});

// -------------------- ?sources= (تبويب إنستاباي/أورانج كاش محتاج المصدرين مع بعض بدون فيزا/طلبات) --------------------
test("16) GET /reconciliation-records?sources=instapay,orange_cash بيرجّع المصدرين بس مش فيزا/طلبات", async () => {
  await request(app).post("/api/payment-control/reconciliation-records").set(authed(accountantToken)).send({
    branchId, source: "visa_settlement", externalAmount: 111, externalDate: "2026-02-01", externalReference: "SRC-VISA",
  });
  await request(app).post("/api/payment-control/reconciliation-records").set(authed(accountantToken)).send({
    branchId, source: "instapay", externalAmount: 222, externalDate: "2026-02-01", externalReference: "SRC-INSTA",
  });
  await request(app).post("/api/payment-control/reconciliation-records").set(authed(accountantToken)).send({
    branchId, source: "orange_cash", externalAmount: 333, externalDate: "2026-02-01", externalReference: "SRC-ORANGE",
  });

  const res = await request(app).get(`/api/payment-control/reconciliation-records?sources=instapay,orange_cash&branchId=${branchId}`)
    .set(authed(accountantToken));
  expect(res.status).toBe(200);
  const refs = res.body.map((r) => r.external_reference);
  expect(refs).toContain("SRC-INSTA");
  expect(refs).toContain("SRC-ORANGE");
  expect(refs).not.toContain("SRC-VISA");
});
