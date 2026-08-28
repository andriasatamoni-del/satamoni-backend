// Procurement v2 STEP D: ترقية kitchen_orders لدورة حياة كاملة (Requisition Workflow) - إضافية بالكامل،
// الجزء الأول من الاختبارات بيتأكد إن السلوك القديم (pending/fulfilled/cancelled) فضل زي ما هو بالظبط
// (نفس شاشة satamoni-kitchen.html الحالية بتعتمد عليه)، والجزء التاني بيغطي الدورة الجديدة كاملة.
const { app, request, pool, seedUser, login, authed } = require("./helpers");

let branchId, ckBranchId, otherBranchId;
let adminToken, managerToken, ckManagerToken, otherManagerToken;
let itemId;

beforeAll(async () => {
  const b1 = await pool.query("INSERT INTO branches (name) VALUES ('فرع طلبيات-جست') RETURNING id");
  branchId = b1.rows[0].id;
  const ck = await pool.query("INSERT INTO branches (name, is_central_kitchen) VALUES ('سنتر كيتشن-طلبيات-جست', TRUE) RETURNING id");
  ckBranchId = ck.rows[0].id;
  const b2 = await pool.query("INSERT INTO branches (name) VALUES ('فرع تاني طلبيات-جست') RETURNING id");
  otherBranchId = b2.rows[0].id;

  await seedUser({ name: "أدمن-طلبيات", email: "admin-korders@jest.test", role: "admin" });
  await seedUser({ branchId, name: "مدير فرع-طلبيات", email: "manager-korders@jest.test", role: "branch_manager" });
  await seedUser({ branchId: ckBranchId, name: "مدير سنتر كيتشن-طلبيات", email: "ck-korders@jest.test", role: "branch_manager" });
  await seedUser({ branchId: otherBranchId, name: "مدير فرع تاني-طلبيات", email: "othermanager-korders@jest.test", role: "branch_manager" });

  adminToken = await login("admin-korders@jest.test");
  managerToken = await login("manager-korders@jest.test");
  ckManagerToken = await login("ck-korders@jest.test");
  otherManagerToken = await login("othermanager-korders@jest.test");

  const item = await pool.query("INSERT INTO inventory_items (name, unit, unit_cost) VALUES ('صنف طلبيات-جست', 'KG', 10) RETURNING id");
  itemId = item.rows[0].id;
  await pool.query(
    "INSERT INTO branch_inventory_stock (branch_id, inventory_item_id, quantity) VALUES ($1,$2,1000),($3,$2,0)",
    [ckBranchId, itemId, branchId]
  );
});

afterAll(async () => {
  await pool.end();
});

describe("Backward compatibility - old pending/fulfilled/cancelled flow untouched", () => {
  let orderId;

  test("POST / من غير status - لسه بتتسجل pending بالظبط زي الأول", async () => {
    const res = await request(app).post("/api/kitchen-orders").set(authed(managerToken)).send({
      branchId, items: [{ inventoryItemId: itemId, quantityRequested: 5 }], notes: "طلب عادي",
    });
    expect(res.status).toBe(201);
    orderId = res.body.orderId;
    const check = await pool.query("SELECT status FROM kitchen_orders WHERE id = $1", [orderId]);
    expect(check.rows[0].status).toBe("pending");
  });

  test("GET /?status=pending لسه بيرجّعها", async () => {
    const res = await request(app).get("/api/kitchen-orders?status=pending").set(authed(adminToken));
    expect(res.status).toBe(200);
    expect(res.body.some((o) => o.id === orderId)).toBe(true);
  });

  test("PATCH /:id {status:'cancelled'} لسه شغالة زي الأول", async () => {
    const res = await request(app).patch(`/api/kitchen-orders/${orderId}`).set(authed(managerToken)).send({ status: "cancelled" });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("cancelled");
  });

  test("تحويل فوري (itemized) مرتبط بطلبية قديمة - لسه بيقفلها 'fulfilled' مش 'RECEIVED'", async () => {
    const order = await request(app).post("/api/kitchen-orders").set(authed(managerToken)).send({
      branchId, items: [{ inventoryItemId: itemId, quantityRequested: 3 }],
    });
    const orderId2 = order.body.orderId;
    const transfer = await request(app).post("/api/kitchen-transfers/itemized").set(authed(adminToken)).send({
      fromBranchId: ckBranchId, toBranchId: branchId, businessDate: "2026-08-28",
      items: [{ inventoryItemId: itemId, quantity: 3 }], kitchenOrderId: orderId2,
    });
    expect(transfer.status).toBe(201);
    const check = await pool.query("SELECT status FROM kitchen_orders WHERE id = $1", [orderId2]);
    expect(check.rows[0].status).toBe("fulfilled");
  });
});

describe("New requisition workflow (DRAFT -> SUBMITTED -> APPROVED -> PREPARING -> READY -> IN_TRANSIT -> RECEIVED)", () => {
  let orderId;

  test("إنشاء طلبية DRAFT", async () => {
    const res = await request(app).post("/api/kitchen-orders").set(authed(managerToken)).send({
      branchId, status: "DRAFT", requiredDate: "2026-09-01",
      items: [{ inventoryItemId: itemId, quantityRequested: 10, quantitySuggested: 8 }],
    });
    expect(res.status).toBe(201);
    orderId = res.body.orderId;
    const check = await pool.query("SELECT status, required_date FROM kitchen_orders WHERE id = $1", [orderId]);
    expect(check.rows[0].status).toBe("DRAFT");
  });

  test("status إنشاء غير مسموح بيها (مش pending ولا DRAFT) - مرفوضة", async () => {
    const res = await request(app).post("/api/kitchen-orders").set(authed(managerToken)).send({
      branchId, status: "APPROVED", items: [{ inventoryItemId: itemId, quantityRequested: 1 }],
    });
    expect(res.status).toBe(400);
  });

  test("تعديل أصناف DRAFT قبل التقديم", async () => {
    const res = await request(app).patch(`/api/kitchen-orders/${orderId}/items`).set(authed(managerToken)).send({
      items: [{ inventoryItemId: itemId, quantityRequested: 12 }],
    });
    expect(res.status).toBe(200);
    const items = await pool.query("SELECT quantity_requested FROM kitchen_order_items WHERE kitchen_order_id = $1", [orderId]);
    expect(Number(items.rows[0].quantity_requested)).toBe(12);
  });

  test("فرع تاني ممنوع يعدّل أصناف الطلبية دي", async () => {
    const res = await request(app).patch(`/api/kitchen-orders/${orderId}/items`).set(authed(otherManagerToken)).send({
      items: [{ inventoryItemId: itemId, quantityRequested: 1 }],
    });
    expect(res.status).toBe(403);
  });

  test("تقديم الطلبية (submit) - DRAFT → SUBMITTED", async () => {
    const res = await request(app).post(`/api/kitchen-orders/${orderId}/submit`).set(authed(managerToken));
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("SUBMITTED");
    expect(res.body.submitted_by).not.toBeNull();
  });

  test("تعديل أصناف بعد التقديم - مرفوض (مش DRAFT خالص)", async () => {
    const res = await request(app).patch(`/api/kitchen-orders/${orderId}/items`).set(authed(managerToken)).send({
      items: [{ inventoryItemId: itemId, quantityRequested: 1 }],
    });
    expect(res.status).toBe(400);
  });

  test("مدير الفرع الطالب نفسه ممنوع يعتمد طلبيته (مش سنتر كيتشن)", async () => {
    const res = await request(app).post(`/api/kitchen-orders/${orderId}/approve`).set(authed(managerToken));
    expect(res.status).toBe(403);
  });

  test("اعتماد الطلبية من مدير السنتر كيتشن - SUBMITTED → APPROVED", async () => {
    const res = await request(app).post(`/api/kitchen-orders/${orderId}/approve`).set(authed(ckManagerToken));
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("APPROVED");
  });

  test("اعتماد مرة تانية - مرفوض (مش SUBMITTED)", async () => {
    const res = await request(app).post(`/api/kitchen-orders/${orderId}/approve`).set(authed(ckManagerToken));
    expect(res.status).toBe(400);
  });

  test("بدء التحضير (start-preparing) - APPROVED → PREPARING", async () => {
    const res = await request(app).post(`/api/kitchen-orders/${orderId}/start-preparing`).set(authed(ckManagerToken));
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("PREPARING");
  });

  test("إلغاء الطلبية بعد بدء التحضير - مرفوض", async () => {
    const res = await request(app).post(`/api/kitchen-orders/${orderId}/cancel`).set(authed(managerToken)).send({ reason: "تراجعت" });
    expect(res.status).toBe(400);
  });

  test("تجهيز الطلبية (ready) - PREPARING → READY", async () => {
    const res = await request(app).post(`/api/kitchen-orders/${orderId}/ready`).set(authed(ckManagerToken));
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("READY");
  });

  test("تحويل مرحلي (request→approve→issue) - الطلبية بتتحول IN_TRANSIT وقت issue بالظبط", async () => {
    const transferReq = await request(app).post("/api/kitchen-transfers/request").set(authed(ckManagerToken)).send({
      fromBranchId: ckBranchId, toBranchId: branchId, businessDate: "2026-09-01",
      items: [{ inventoryItemId: itemId, quantity: 12 }], kitchenOrderId: orderId,
    });
    expect(transferReq.status).toBe(201);
    const transferId = transferReq.body.id;

    const approve = await request(app).post(`/api/kitchen-transfers/${transferId}/approve`).set(authed(adminToken));
    expect(approve.status).toBe(200);

    const checkBefore = await pool.query("SELECT status FROM kitchen_orders WHERE id = $1", [orderId]);
    expect(checkBefore.rows[0].status).toBe("READY");

    const issue = await request(app).post(`/api/kitchen-transfers/${transferId}/issue`).set(authed(ckManagerToken));
    expect(issue.status).toBe(200);
    const checkAfterIssue = await pool.query("SELECT status FROM kitchen_orders WHERE id = $1", [orderId]);
    expect(checkAfterIssue.rows[0].status).toBe("IN_TRANSIT");

    const receive = await request(app).post(`/api/kitchen-transfers/${transferId}/receive`).set(authed(managerToken)).send({
      items: [{ inventoryItemId: itemId, quantityReceived: 12 }],
    });
    expect(receive.status).toBe(200);
    const checkAfterReceive = await pool.query("SELECT status FROM kitchen_orders WHERE id = $1", [orderId]);
    expect(checkAfterReceive.rows[0].status).toBe("RECEIVED");
  });

  test("GET /:id بيرجّع الطلبية بتفاصيلها", async () => {
    const res = await request(app).get(`/api/kitchen-orders/${orderId}`).set(authed(managerToken));
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("RECEIVED");
    expect(res.body.items.length).toBe(1);
  });
});

describe("Reject + cancel guards", () => {
  test("رفض طلبية SUBMITTED - لازم سبب", async () => {
    const created = await request(app).post("/api/kitchen-orders").set(authed(managerToken)).send({
      branchId, status: "DRAFT", items: [{ inventoryItemId: itemId, quantityRequested: 1 }],
    });
    const orderId = created.body.orderId;
    await request(app).post(`/api/kitchen-orders/${orderId}/submit`).set(authed(managerToken)).expect(200);

    const noReason = await request(app).post(`/api/kitchen-orders/${orderId}/reject`).set(authed(ckManagerToken)).send({});
    expect(noReason.status).toBe(400);

    const res = await request(app).post(`/api/kitchen-orders/${orderId}/reject`).set(authed(ckManagerToken)).send({ reason: "الكمية مبالغ فيها" });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("REJECTED");
    expect(res.body.rejection_reason).toBe("الكمية مبالغ فيها");
  });

  test("إلغاء طلبية DRAFT من الفرع الطالب - مسموح", async () => {
    const created = await request(app).post("/api/kitchen-orders").set(authed(managerToken)).send({
      branchId, status: "DRAFT", items: [{ inventoryItemId: itemId, quantityRequested: 1 }],
    });
    const res = await request(app).post(`/api/kitchen-orders/${created.body.orderId}/cancel`).set(authed(managerToken)).send({ reason: "غلط" });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("cancelled");
    expect(res.body.cancellation_reason).toBe("غلط");
  });

  test("فرع تاني ممنوع يلغي طلبية مش بتاعته", async () => {
    const created = await request(app).post("/api/kitchen-orders").set(authed(managerToken)).send({
      branchId, status: "DRAFT", items: [{ inventoryItemId: itemId, quantityRequested: 1 }],
    });
    const res = await request(app).post(`/api/kitchen-orders/${created.body.orderId}/cancel`).set(authed(otherManagerToken)).send({});
    expect(res.status).toBe(403);
  });
});
