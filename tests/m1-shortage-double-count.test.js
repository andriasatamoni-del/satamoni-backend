// STEP L-audit (إغلاق M-1): يمنع ازدواج ترحيل نفس خسارة النقص بين محاسبة عجز الاستلام الأوتوماتيكية
// (postTransferAccounting وقت /receive) وفروقات الاستلام اليدوية (POST /discrepancies) - راجع الشرح
// الكامل في routes/kitchen-transfers.js فوق assertNoDuplicateShortageAccounting.
//
// القاعدة النهائية:
// - لو الصنف على التحويل فيه نقص استلام معروف (quantity_sent > quantity_received): ممنوع تسجيل أي فرق
//   SHORTAGE تاني عليه خالص - أي خسارة إضافية حقيقية لازم تتسجل بنوعها الفعلي (DAMAGED/WRONG_ITEM/
//   EXPIRED/OTHER)، مش SHORTAGE.
// - لو الصنف اتستلم كامل (مفيش نقص استلام): فروقات SHORTAGE مسموحة عادي، بس إجمالي كل الفروقات
//   (غير المرفوضة) على البند ده ما يتخطاش الكمية المُستلمة فعليًا.
const { app, request, pool, seedUser, login, authed } = require("./helpers");

let branchId, ckBranchId;
let adminToken, managerToken, ckManagerToken;
let itemId;

async function requestApproveIssue(quantity, businessDate = "2026-09-10") {
  const reqRes = await request(app).post("/api/kitchen-transfers/request").set(authed(ckManagerToken)).send({
    fromBranchId: ckBranchId, toBranchId: branchId, businessDate, items: [{ inventoryItemId: itemId, quantity }],
  });
  const transferId = reqRes.body.id;
  await request(app).post(`/api/kitchen-transfers/${transferId}/approve`).set(authed(adminToken)).expect(200);
  await request(app).post(`/api/kitchen-transfers/${transferId}/issue`).set(authed(ckManagerToken)).expect(200);
  return transferId;
}

async function transferItemId(transferId) {
  const rows = await pool.query("SELECT id FROM kitchen_transfer_items WHERE kitchen_transfer_id = $1", [transferId]);
  return rows.rows[0].id;
}

beforeAll(async () => {
  const b1 = await pool.query("INSERT INTO branches (name) VALUES ('فرع M1-جست') RETURNING id");
  branchId = b1.rows[0].id;
  const ck = await pool.query("INSERT INTO branches (name, is_central_kitchen) VALUES ('سنتر كيتشن-M1-جست', TRUE) RETURNING id");
  ckBranchId = ck.rows[0].id;

  await seedUser({ name: "أدمن-M1", email: "admin-m1@jest.test", role: "admin" });
  await seedUser({ branchId, name: "مدير فرع-M1", email: "manager-m1@jest.test", role: "branch_manager" });
  await seedUser({ branchId: ckBranchId, name: "مدير سنتر كيتشن-M1", email: "ck-m1@jest.test", role: "branch_manager" });
  adminToken = await login("admin-m1@jest.test");
  managerToken = await login("manager-m1@jest.test");
  ckManagerToken = await login("ck-m1@jest.test");

  const item = await pool.query("INSERT INTO inventory_items (name, unit, unit_cost) VALUES ('صنف M1-جست', 'KG', 10) RETURNING id");
  itemId = item.rows[0].id;
  await pool.query(
    "INSERT INTO branch_inventory_stock (branch_id, inventory_item_id, quantity) VALUES ($1,$2,1000),($3,$2,0)",
    [ckBranchId, itemId, branchId]
  );
});

afterAll(async () => {
  await pool.end();
});

describe("Test 1: نقص استلام (Sent 100 / Received 90) - فرق SHORTAGE لاحق بنفس النقص مرفوض", () => {
  let transferId, itemRowId;

  test("استلام جزئي (90 من 100) - رصيد الفرع +90 والفرق يترحّل محاسبيًا أوتوماتيك", async () => {
    transferId = await requestApproveIssue(100);
    const stockBefore = await pool.query("SELECT quantity FROM branch_inventory_stock WHERE branch_id=$1 AND inventory_item_id=$2", [branchId, itemId]);
    const received = await request(app).post(`/api/kitchen-transfers/${transferId}/receive`).set(authed(managerToken)).send({
      items: [{ inventoryItemId: itemId, quantityReceived: 90 }],
    });
    expect(received.status).toBe(200);
    expect(received.body.status).toBe("partially_received");
    itemRowId = await transferItemId(transferId);

    const stockAfter = await pool.query("SELECT quantity FROM branch_inventory_stock WHERE branch_id=$1 AND inventory_item_id=$2", [branchId, itemId]);
    expect(Number(stockAfter.rows[0].quantity) - Number(stockBefore.rows[0].quantity)).toBeCloseTo(90, 5);

    const je = await pool.query(
      `SELECT jel.debit, jel.credit, a.code FROM journal_entry_lines jel JOIN accounts a ON a.id = jel.account_id
       WHERE jel.journal_entry_id = $1 AND a.code = '5300'`,
      [received.body.journal_entry_id]
    );
    expect(je.rows.length).toBe(1);
    expect(Number(je.rows[0].debit)).toBeCloseTo(100, 5); // 10 وحدات ناقصة × تكلفة 10 = 100 - العجز اترحّل تلقائيًا
  });

  test("فرق SHORTAGE لاحق بنفس الـ10 الناقصة - مرفوض صراحة (مش عجز مخفي، ومش خسارة مزدوجة)", async () => {
    const res = await request(app).post(`/api/kitchen-transfers/${transferId}/discrepancies`).set(authed(managerToken)).send({
      items: [{ kitchenTransferItemId: itemRowId, inventoryItemId: itemId, discrepancyType: "SHORTAGE", quantity: 10 }],
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/نقص استلام/);

    const discCount = await pool.query("SELECT COUNT(*) AS c FROM transfer_discrepancies WHERE kitchen_transfer_item_id = $1", [itemRowId]);
    expect(Number(discCount.rows[0].c)).toBe(0); // مفيش أي سطر فرق اتسجل خالص

    const stock = await pool.query("SELECT quantity FROM branch_inventory_stock WHERE branch_id=$1 AND inventory_item_id=$2", [branchId, itemId]);
    expect(Number(stock.rows[0].quantity)).toBeCloseTo(90, 5); // مفيش خصم تاني - نفس الـ90 المستلمة

    const jeCount = await pool.query(
      "SELECT COUNT(*) AS c FROM journal_entries WHERE source_type = 'transfer_discrepancy' AND source_id IN (SELECT id FROM transfer_discrepancies WHERE kitchen_transfer_item_id = $1)",
      [itemRowId]
    );
    expect(Number(jeCount.rows[0].c)).toBe(0); // مفيش قيد محاسبي تاني اترحّل
  });
});

describe("Test 2: استلام كامل ثم فقد مُكتشف لاحقًا - فرق SHORTAGE صريح ومسموح", () => {
  test("Sent 100 / Received 100 - بعدين SHORTAGE 10 مُكتشف بالجرد الفعلي - مسموح ومترحّل صح", async () => {
    const transferId = await requestApproveIssue(100);
    const received = await request(app).post(`/api/kitchen-transfers/${transferId}/receive`).set(authed(managerToken)).send({
      items: [{ inventoryItemId: itemId, quantityReceived: 100 }],
    });
    expect(received.status).toBe(200);
    expect(received.body.status).toBe("received");
    const itemRowId = await transferItemId(transferId);

    const stockAfterReceive = await pool.query("SELECT quantity FROM branch_inventory_stock WHERE branch_id=$1 AND inventory_item_id=$2", [branchId, itemId]);
    const receivedBaseline = Number(stockAfterReceive.rows[0].quantity);

    const disc = await request(app).post(`/api/kitchen-transfers/${transferId}/discrepancies`).set(authed(managerToken)).send({
      items: [{ kitchenTransferItemId: itemRowId, inventoryItemId: itemId, discrepancyType: "SHORTAGE", quantity: 10 }],
    });
    expect(disc.status).toBe(201);

    const discCount = await pool.query("SELECT COUNT(*) AS c FROM transfer_discrepancies WHERE kitchen_transfer_item_id = $1", [itemRowId]);
    expect(Number(discCount.rows[0].c)).toBe(1); // فرق واحد بالظبط

    const resolve = await request(app).post(`/api/kitchen-transfers/${transferId}/discrepancies/${disc.body[0].id}/resolve`)
      .set(authed(managerToken)).send({ action: "RESOLVE" });
    expect(resolve.status).toBe(200);

    const stockFinal = await pool.query("SELECT quantity FROM branch_inventory_stock WHERE branch_id=$1 AND inventory_item_id=$2", [branchId, itemId]);
    expect(Number(stockFinal.rows[0].quantity)).toBeCloseTo(receivedBaseline - 10, 5); // 100 -> 90

    const jeRows = await pool.query(
      `SELECT jel.debit, a.code FROM journal_entry_lines jel JOIN accounts a ON a.id = jel.account_id
       WHERE jel.journal_entry_id = $1 AND a.code = '5300'`,
      [resolve.body.adjustment_journal_entry_id]
    );
    expect(jeRows.rows.length).toBe(1);
    expect(Number(jeRows.rows[0].debit)).toBeCloseTo(100, 5); // 10 وحدة × تكلفة 10 = 100 - خسارة post-receipt واحدة بس
  });
});

describe("Test 3: نقص استلام + تلف مُكتشف لاحقًا (نوع مختلف) - مسموح ومش هيتكرر مع نقص الاستلام", () => {
  test("Sent 100 / Received 90 - بعدين DAMAGED 5 - مسموح عادي، منفصل تمامًا عن نقص الاستلام", async () => {
    const transferId = await requestApproveIssue(100);
    const stockBeforeReceive = await pool.query("SELECT quantity FROM branch_inventory_stock WHERE branch_id=$1 AND inventory_item_id=$2", [branchId, itemId]);
    await request(app).post(`/api/kitchen-transfers/${transferId}/receive`).set(authed(managerToken)).send({
      items: [{ inventoryItemId: itemId, quantityReceived: 90 }],
    }).expect(200);
    const itemRowId = await transferItemId(transferId);

    const damage = await request(app).post(`/api/kitchen-transfers/${transferId}/discrepancies`).set(authed(managerToken)).send({
      items: [{ kitchenTransferItemId: itemRowId, inventoryItemId: itemId, discrepancyType: "DAMAGED", quantity: 5 }],
    });
    expect(damage.status).toBe(201);
    expect(damage.body[0].discrepancy_type).toBe("DAMAGED");

    const resolve = await request(app).post(`/api/kitchen-transfers/${transferId}/discrepancies/${damage.body[0].id}/resolve`)
      .set(authed(managerToken)).send({ action: "RESOLVE" });
    expect(resolve.status).toBe(200);

    const jeRows = await pool.query(
      `SELECT jel.debit, a.code FROM journal_entry_lines jel JOIN accounts a ON a.id = jel.account_id
       WHERE jel.journal_entry_id = $1 AND a.code = '5300'`,
      [resolve.body.adjustment_journal_entry_id]
    );
    expect(Number(jeRows.rows[0].debit)).toBeCloseTo(50, 5); // 5 وحدة × 10 = 50 - قيمة التلف بس، مش مخلوطة بعجز الاستلام

    const stock = await pool.query("SELECT quantity FROM branch_inventory_stock WHERE branch_id=$1 AND inventory_item_id=$2", [branchId, itemId]);
    // 90 (استلام) - 5 (تلف) = +85 من رصيد ما قبل التحويل ده - العجز الأصلي (10) اترحّل قبل كده كمحاسبة بس
    // (مش خصم مخزون تاني)، فمش بيتكرر هنا مع خصم التلف
    expect(Number(stock.rows[0].quantity) - Number(stockBeforeReceive.rows[0].quantity)).toBeCloseTo(85, 5);
  });
});

describe("Test 4: سقف إجمالي فروقات SHORTAGE على البند - ما يتخطاش المُستلم فعليًا", () => {
  test("Sent 100 / Received 100 - SHORTAGE 60 مقبول، SHORTAGE 60 تانية (إجمالي 120>100) مرفوضة", async () => {
    const transferId = await requestApproveIssue(100);
    await request(app).post(`/api/kitchen-transfers/${transferId}/receive`).set(authed(managerToken)).send({
      items: [{ inventoryItemId: itemId, quantityReceived: 100 }],
    }).expect(200);
    const itemRowId = await transferItemId(transferId);

    const first = await request(app).post(`/api/kitchen-transfers/${transferId}/discrepancies`).set(authed(managerToken)).send({
      items: [{ kitchenTransferItemId: itemRowId, inventoryItemId: itemId, discrepancyType: "SHORTAGE", quantity: 60 }],
    });
    expect(first.status).toBe(201);

    const second = await request(app).post(`/api/kitchen-transfers/${transferId}/discrepancies`).set(authed(managerToken)).send({
      items: [{ kitchenTransferItemId: itemRowId, inventoryItemId: itemId, discrepancyType: "SHORTAGE", quantity: 60 }],
    });
    expect(second.status).toBe(400);
    expect(second.body.error).toMatch(/أقصى كمية مسموحة/);

    const discCount = await pool.query(
      "SELECT COUNT(*) AS c FROM transfer_discrepancies WHERE kitchen_transfer_item_id = $1 AND status <> 'REJECTED'", [itemRowId]
    );
    expect(Number(discCount.rows[0].c)).toBe(1); // بس الأول اللي اتسجل

    // كمية أصغر (40) بتكمل السقف بالظبط (60+40=100) - المفروض تتقبل
    const third = await request(app).post(`/api/kitchen-transfers/${transferId}/discrepancies`).set(authed(managerToken)).send({
      items: [{ kitchenTransferItemId: itemRowId, inventoryItemId: itemId, discrepancyType: "SHORTAGE", quantity: 40 }],
    });
    expect(third.status).toBe(201);
  });
});

describe("Test 5: طلبات فرق متزامنة لنفس البند - نجاح واحد بس مع القفل، مفيش تعدّي للسقف", () => {
  test("3 طلبات SHORTAGE متزامنة كل واحدة 50 على بند مُستلم 100 - المفروض تنجح طلبات بمجموع 100 بالظبط بس", async () => {
    const transferId = await requestApproveIssue(100);
    await request(app).post(`/api/kitchen-transfers/${transferId}/receive`).set(authed(managerToken)).send({
      items: [{ inventoryItemId: itemId, quantityReceived: 100 }],
    }).expect(200);
    const itemRowId = await transferItemId(transferId);

    const results = await Promise.all(
      Array.from({ length: 3 }, () => request(app).post(`/api/kitchen-transfers/${transferId}/discrepancies`).set(authed(managerToken)).send({
        items: [{ kitchenTransferItemId: itemRowId, inventoryItemId: itemId, discrepancyType: "SHORTAGE", quantity: 50 }],
      }))
    );
    const successCount = results.filter((r) => r.status === 201).length;
    expect(successCount).toBe(2); // 50+50=100 بالظبط - التالتة لازم ترفض لأنها هتعدّي السقف

    const totalAccepted = await pool.query(
      "SELECT COALESCE(SUM(quantity),0) AS total FROM transfer_discrepancies WHERE kitchen_transfer_item_id = $1 AND status <> 'REJECTED'",
      [itemRowId]
    );
    expect(Number(totalAccepted.rows[0].total)).toBeCloseTo(100, 5); // مش 150 - القفل منع تعدّي السقف تحت الضغط المتزامن
  });
});

describe("Test 6: تحويل بنمط قديم (قبل هذا الإصلاح) - لسه مقروء وسلوك الاستلام سليم", () => {
  test("تحويل فوري قديم (/itemized، status='completed' مباشرة) - لسه بيتقرا صح ومايتأثرش بالمنطق الجديد", async () => {
    const legacyTransfer = await request(app).post("/api/kitchen-transfers/itemized").set(authed(adminToken)).send({
      fromBranchId: ckBranchId, toBranchId: branchId, businessDate: "2026-09-10",
      items: [{ inventoryItemId: itemId, quantity: 15 }],
    });
    expect(legacyTransfer.status).toBe(201);

    const list = await request(app).get(`/api/kitchen-transfers?branchId=${branchId}`).set(authed(managerToken));
    expect(list.status).toBe(200);
    const found = list.body.find((t) => t.id === legacyTransfer.body.transferId);
    expect(found).toBeDefined();
    expect(found.status).toBe("completed");

    // مفيش تسجيل فروقات على تحويل 'completed' (المسار الفوري مايمرّش بحالة received/partially_received
    // خالص - ده سلوك موجود من قبل هذا الإصلاح، والتأكيد هنا إن الفحص الجديد مابيكسرش السلوك القديم ده
    const itemRowId = await transferItemId(legacyTransfer.body.transferId);
    const discAttempt = await request(app).post(`/api/kitchen-transfers/${legacyTransfer.body.transferId}/discrepancies`).set(authed(managerToken)).send({
      items: [{ kitchenTransferItemId: itemRowId, inventoryItemId: itemId, discrepancyType: "SHORTAGE", quantity: 1 }],
    });
    expect(discAttempt.status).toBe(400);
    expect(discAttempt.body.error).toMatch(/بعد استلام التحويل/);
  });

  test("تحويل مرحلي عادي باستلام كامل (مطابق تمامًا) - نفس سلوك ما قبل الإصلاح، فرق SHORTAGE عادي مسموح", async () => {
    const transferId = await requestApproveIssue(25);
    const received = await request(app).post(`/api/kitchen-transfers/${transferId}/receive`).set(authed(managerToken)).send({
      items: [{ inventoryItemId: itemId, quantityReceived: 25 }],
    });
    expect(received.status).toBe(200);
    expect(received.body.status).toBe("received");
    const itemRowId = await transferItemId(transferId);

    const disc = await request(app).post(`/api/kitchen-transfers/${transferId}/discrepancies`).set(authed(managerToken)).send({
      items: [{ kitchenTransferItemId: itemRowId, inventoryItemId: itemId, discrepancyType: "SHORTAGE", quantity: 3 }],
    });
    expect(disc.status).toBe(201); // نفس سلوك STEP G الأصلي - مفيش تغيير للحالة دي
  });
});
