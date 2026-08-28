// Procurement v2 STEP G: فروقات الاستلام (Transfer Discrepancies) - بعد ما التحويل يتستلم، أي فرق
// (نقص/تلف/صنف غلط/كمية غلط/منتهي/تاني) بيتسجل كسطر مستقل، والتصحيح الفعلي (مخزون + محاسبة) بيحصل بس
// وقت /resolve صراحة - السجل الأصلي (quantity_received) فضل ثابت زي ما هو، مفيش UPDATE مباشر عليه.
const { app, request, pool, seedUser, login, authed } = require("./helpers");

let branchId, ckBranchId, otherBranchId;
let adminToken, managerToken, ckManagerToken, accountantToken, otherManagerToken;
let itemId;

async function createReceivedTransfer(quantity) {
  const reqRes = await request(app).post("/api/kitchen-transfers/request").set(authed(ckManagerToken)).send({
    fromBranchId: ckBranchId, toBranchId: branchId, businessDate: "2026-09-01",
    items: [{ inventoryItemId: itemId, quantity }],
  });
  const transferId = reqRes.body.id;
  await request(app).post(`/api/kitchen-transfers/${transferId}/approve`).set(authed(adminToken)).expect(200);
  await request(app).post(`/api/kitchen-transfers/${transferId}/issue`).set(authed(ckManagerToken)).expect(200);
  await request(app).post(`/api/kitchen-transfers/${transferId}/receive`).set(authed(managerToken)).send({
    items: [{ inventoryItemId: itemId, quantityReceived: quantity }],
  }).expect(200);
  const items = await pool.query("SELECT id FROM kitchen_transfer_items WHERE kitchen_transfer_id = $1", [transferId]);
  return { transferId, transferItemId: items.rows[0].id };
}

beforeAll(async () => {
  const b1 = await pool.query("INSERT INTO branches (name) VALUES ('فرع فروقات-جست') RETURNING id");
  branchId = b1.rows[0].id;
  const ck = await pool.query("INSERT INTO branches (name, is_central_kitchen) VALUES ('سنتر كيتشن-فروقات-جست', TRUE) RETURNING id");
  ckBranchId = ck.rows[0].id;
  const b2 = await pool.query("INSERT INTO branches (name) VALUES ('فرع تاني فروقات-جست') RETURNING id");
  otherBranchId = b2.rows[0].id;

  await seedUser({ name: "أدمن-فروقات", email: "admin-discrep@jest.test", role: "admin" });
  await seedUser({ branchId, name: "مدير فرع-فروقات", email: "manager-discrep@jest.test", role: "branch_manager" });
  await seedUser({ branchId: ckBranchId, name: "مدير سنتر كيتشن-فروقات", email: "ck-discrep@jest.test", role: "branch_manager" });
  await seedUser({ name: "محاسب-فروقات", email: "accountant-discrep@jest.test", role: "accountant" });
  await seedUser({ branchId: otherBranchId, name: "مدير فرع تاني-فروقات", email: "othermanager-discrep@jest.test", role: "branch_manager" });

  adminToken = await login("admin-discrep@jest.test");
  managerToken = await login("manager-discrep@jest.test");
  ckManagerToken = await login("ck-discrep@jest.test");
  accountantToken = await login("accountant-discrep@jest.test");
  otherManagerToken = await login("othermanager-discrep@jest.test");

  const item = await pool.query("INSERT INTO inventory_items (name, unit, unit_cost) VALUES ('صنف فروقات-جست', 'KG', 20) RETURNING id");
  itemId = item.rows[0].id;
  await pool.query(
    "INSERT INTO branch_inventory_stock (branch_id, inventory_item_id, quantity) VALUES ($1,$2,500),($3,$2,0)",
    [ckBranchId, itemId, branchId]
  );
});

afterAll(async () => {
  await pool.end();
});

describe("POST /api/kitchen-transfers/:id/discrepancies", () => {
  test("قبل الاستلام (لسه requested) - مرفوض", async () => {
    const reqRes = await request(app).post("/api/kitchen-transfers/request").set(authed(ckManagerToken)).send({
      fromBranchId: ckBranchId, toBranchId: branchId, businessDate: "2026-09-01",
      items: [{ inventoryItemId: itemId, quantity: 5 }],
    });
    const res = await request(app).post(`/api/kitchen-transfers/${reqRes.body.id}/discrepancies`).set(authed(managerToken)).send({
      items: [{ inventoryItemId: itemId, discrepancyType: "SHORTAGE", quantity: 1 }],
    });
    expect(res.status).toBe(400);
  });

  test("بعد الاستلام - الفرع المستلم بيسجّل فرق نوعه SHORTAGE", async () => {
    const { transferId, transferItemId } = await createReceivedTransfer(20);
    const res = await request(app).post(`/api/kitchen-transfers/${transferId}/discrepancies`).set(authed(managerToken)).send({
      items: [{ kitchenTransferItemId: transferItemId, inventoryItemId: itemId, discrepancyType: "SHORTAGE", quantity: 3, notes: "3 كيلو ناقصة" }],
    });
    expect(res.status).toBe(201);
    expect(res.body[0].status).toBe("OPEN");
    expect(res.body[0].discrepancy_type).toBe("SHORTAGE");
  });

  test("نوع فرق غير معروف - مرفوض", async () => {
    const { transferId } = await createReceivedTransfer(5);
    const res = await request(app).post(`/api/kitchen-transfers/${transferId}/discrepancies`).set(authed(managerToken)).send({
      items: [{ inventoryItemId: itemId, discrepancyType: "NOT_A_TYPE", quantity: 1 }],
    });
    expect(res.status).toBe(400);
  });

  test("فرع تاني (مش المستلم) ممنوع يسجل فرق", async () => {
    const { transferId } = await createReceivedTransfer(5);
    const res = await request(app).post(`/api/kitchen-transfers/${transferId}/discrepancies`).set(authed(otherManagerToken)).send({
      items: [{ inventoryItemId: itemId, discrepancyType: "SHORTAGE", quantity: 1 }],
    });
    expect(res.status).toBe(403);
  });
});

describe("GET /api/kitchen-transfers/:id/discrepancies", () => {
  test("الفرع المستلم والمصدر يقدروا يشوفوا، فرع تالت لأ", async () => {
    const { transferId, transferItemId } = await createReceivedTransfer(10);
    await request(app).post(`/api/kitchen-transfers/${transferId}/discrepancies`).set(authed(managerToken)).send({
      items: [{ kitchenTransferItemId: transferItemId, inventoryItemId: itemId, discrepancyType: "DAMAGED", quantity: 2 }],
    }).expect(201);

    const asReceiver = await request(app).get(`/api/kitchen-transfers/${transferId}/discrepancies`).set(authed(managerToken));
    expect(asReceiver.status).toBe(200);
    expect(asReceiver.body.length).toBe(1);

    const asSource = await request(app).get(`/api/kitchen-transfers/${transferId}/discrepancies`).set(authed(ckManagerToken));
    expect(asSource.status).toBe(200);

    const asOther = await request(app).get(`/api/kitchen-transfers/${transferId}/discrepancies`).set(authed(otherManagerToken));
    expect(asOther.status).toBe(403);
  });
});

describe("POST /api/kitchen-transfers/:id/discrepancies/:discrepancyId/resolve", () => {
  test("RESOLVE بيصحّح المخزون (حركة سالبة) وبيرحّل قيد 5300/1400 بنفس قيمة التكلفة الحقيقية", async () => {
    const { transferId, transferItemId } = await createReceivedTransfer(20);
    const stockBefore = await pool.query("SELECT quantity FROM branch_inventory_stock WHERE branch_id = $1 AND inventory_item_id = $2", [branchId, itemId]);

    const created = await request(app).post(`/api/kitchen-transfers/${transferId}/discrepancies`).set(authed(managerToken)).send({
      items: [{ kitchenTransferItemId: transferItemId, inventoryItemId: itemId, discrepancyType: "SHORTAGE", quantity: 4 }],
    });
    const discId = created.body[0].id;

    const resolve = await request(app).post(`/api/kitchen-transfers/${transferId}/discrepancies/${discId}/resolve`)
      .set(authed(managerToken)).send({ action: "RESOLVE", resolutionNotes: "اتأكد النقص" });
    expect(resolve.status).toBe(200);
    expect(resolve.body.status).toBe("RESOLVED");
    expect(resolve.body.adjustment_journal_entry_id).not.toBeNull();

    const stockAfter = await pool.query("SELECT quantity FROM branch_inventory_stock WHERE branch_id = $1 AND inventory_item_id = $2", [branchId, itemId]);
    expect(Number(stockAfter.rows[0].quantity)).toBeCloseTo(Number(stockBefore.rows[0].quantity) - 4, 5);

    const lines = await pool.query(
      `SELECT jel.debit, jel.credit, a.code FROM journal_entry_lines jel JOIN accounts a ON a.id = jel.account_id
       WHERE jel.journal_entry_id = $1 ORDER BY a.code`,
      [resolve.body.adjustment_journal_entry_id]
    );
    const inv1400 = lines.rows.find((l) => l.code === "1400");
    const waste5300 = lines.rows.find((l) => l.code === "5300");
    expect(Number(inv1400.credit)).toBeCloseTo(80, 5); // 4 * 20 unit_cost
    expect(Number(waste5300.debit)).toBeCloseTo(80, 5);
  });

  test("REJECT - مفيش أي أثر على المخزون أو المحاسبة", async () => {
    const { transferId, transferItemId } = await createReceivedTransfer(10);
    const stockBefore = await pool.query("SELECT quantity FROM branch_inventory_stock WHERE branch_id = $1 AND inventory_item_id = $2", [branchId, itemId]);

    const created = await request(app).post(`/api/kitchen-transfers/${transferId}/discrepancies`).set(authed(managerToken)).send({
      items: [{ kitchenTransferItemId: transferItemId, inventoryItemId: itemId, discrepancyType: "WRONG_QUANTITY", quantity: 2 }],
    });
    const discId = created.body[0].id;

    const resolve = await request(app).post(`/api/kitchen-transfers/${transferId}/discrepancies/${discId}/resolve`)
      .set(authed(accountantToken)).send({ action: "REJECT", resolutionNotes: "مش حقيقي" });
    expect(resolve.status).toBe(200);
    expect(resolve.body.status).toBe("REJECTED");
    expect(resolve.body.adjustment_journal_entry_id).toBeNull();

    const stockAfter = await pool.query("SELECT quantity FROM branch_inventory_stock WHERE branch_id = $1 AND inventory_item_id = $2", [branchId, itemId]);
    expect(Number(stockAfter.rows[0].quantity)).toBe(Number(stockBefore.rows[0].quantity));
  });

  test("ACKNOWLEDGE ثم RESOLVE بعد كده - مسموح ومتسلسل", async () => {
    const { transferId, transferItemId } = await createReceivedTransfer(10);
    const created = await request(app).post(`/api/kitchen-transfers/${transferId}/discrepancies`).set(authed(managerToken)).send({
      items: [{ kitchenTransferItemId: transferItemId, inventoryItemId: itemId, discrepancyType: "EXPIRED", quantity: 1 }],
    });
    const discId = created.body[0].id;

    const ack = await request(app).post(`/api/kitchen-transfers/${transferId}/discrepancies/${discId}/resolve`)
      .set(authed(accountantToken)).send({ action: "ACKNOWLEDGE" });
    expect(ack.status).toBe(200);
    expect(ack.body.status).toBe("ACKNOWLEDGED");
    expect(ack.body.adjustment_journal_entry_id).toBeNull();

    const resolve = await request(app).post(`/api/kitchen-transfers/${transferId}/discrepancies/${discId}/resolve`)
      .set(authed(accountantToken)).send({ action: "RESOLVE" });
    expect(resolve.status).toBe(200);
    expect(resolve.body.status).toBe("RESOLVED");
    expect(resolve.body.adjustment_journal_entry_id).not.toBeNull();
  });

  test("RESOLVE مرتين - التاني مرفوض (اتراجع بالفعل)", async () => {
    const { transferId, transferItemId } = await createReceivedTransfer(10);
    const created = await request(app).post(`/api/kitchen-transfers/${transferId}/discrepancies`).set(authed(managerToken)).send({
      items: [{ kitchenTransferItemId: transferItemId, inventoryItemId: itemId, discrepancyType: "SHORTAGE", quantity: 1 }],
    });
    const discId = created.body[0].id;
    await request(app).post(`/api/kitchen-transfers/${transferId}/discrepancies/${discId}/resolve`)
      .set(authed(managerToken)).send({ action: "RESOLVE" }).expect(200);
    const second = await request(app).post(`/api/kitchen-transfers/${transferId}/discrepancies/${discId}/resolve`)
      .set(authed(managerToken)).send({ action: "RESOLVE" });
    expect(second.status).toBe(400);
  });

  test("postAdjustment:false - RESOLVED بس من غير أي تصحيح فعلي (ملاحظة إدارية بس)", async () => {
    const { transferId, transferItemId } = await createReceivedTransfer(10);
    const stockBefore = await pool.query("SELECT quantity FROM branch_inventory_stock WHERE branch_id = $1 AND inventory_item_id = $2", [branchId, itemId]);
    const created = await request(app).post(`/api/kitchen-transfers/${transferId}/discrepancies`).set(authed(managerToken)).send({
      items: [{ kitchenTransferItemId: transferItemId, inventoryItemId: itemId, discrepancyType: "OTHER", quantity: 1 }],
    });
    const discId = created.body[0].id;
    const resolve = await request(app).post(`/api/kitchen-transfers/${transferId}/discrepancies/${discId}/resolve`)
      .set(authed(managerToken)).send({ action: "RESOLVE", postAdjustment: false });
    expect(resolve.status).toBe(200);
    expect(resolve.body.status).toBe("RESOLVED");
    expect(resolve.body.adjustment_journal_entry_id).toBeNull();
    const stockAfter = await pool.query("SELECT quantity FROM branch_inventory_stock WHERE branch_id = $1 AND inventory_item_id = $2", [branchId, itemId]);
    expect(Number(stockAfter.rows[0].quantity)).toBe(Number(stockBefore.rows[0].quantity));
  });
});
