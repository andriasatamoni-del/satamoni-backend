// Procurement v2 STEP F: نقطة تجهيز السنتر كيتشن - GET/POST /api/kitchen-orders/:id/picking.
// مفيش عجز مخفي أبدًا: أي فرق بين المطلوب والمتاح لازم يتسجل صراحة (fulfillment_status) بدل ما يختفي.
const { app, request, pool, seedUser, login, authed } = require("./helpers");

let branchId, ckBranchId;
let adminToken, managerToken, ckManagerToken;
let itemAId, itemBId;

async function createApprovedOrder(items) {
  const created = await request(app).post("/api/kitchen-orders").set(authed(managerToken)).send({
    branchId, status: "DRAFT", items,
  });
  const orderId = created.body.orderId;
  await request(app).post(`/api/kitchen-orders/${orderId}/submit`).set(authed(managerToken)).expect(200);
  await request(app).post(`/api/kitchen-orders/${orderId}/approve`).set(authed(ckManagerToken)).expect(200);
  return orderId;
}

beforeAll(async () => {
  const b1 = await pool.query("INSERT INTO branches (name) VALUES ('فرع تجهيز-جست') RETURNING id");
  branchId = b1.rows[0].id;
  const ck = await pool.query("INSERT INTO branches (name, is_central_kitchen) VALUES ('سنتر كيتشن-تجهيز-جست', TRUE) RETURNING id");
  ckBranchId = ck.rows[0].id;

  await seedUser({ name: "أدمن-تجهيز", email: "admin-picking@jest.test", role: "admin" });
  await seedUser({ branchId, name: "مدير فرع-تجهيز", email: "manager-picking@jest.test", role: "branch_manager" });
  await seedUser({ branchId: ckBranchId, name: "مدير سنتر كيتشن-تجهيز", email: "ck-picking@jest.test", role: "branch_manager" });
  adminToken = await login("admin-picking@jest.test");
  managerToken = await login("manager-picking@jest.test");
  ckManagerToken = await login("ck-picking@jest.test");

  const a = await pool.query("INSERT INTO inventory_items (name, unit, unit_cost) VALUES ('صنف أ-تجهيز-جست', 'KG', 5) RETURNING id");
  itemAId = a.rows[0].id;
  const b = await pool.query("INSERT INTO inventory_items (name, unit, unit_cost) VALUES ('صنف ب-تجهيز-جست', 'KG', 5) RETURNING id");
  itemBId = b.rows[0].id;
  // متاح في السنتر كيتشن: صنف أ = 100 (كفاية)، صنف ب = 3 (مش كفاية)
  await pool.query(
    "INSERT INTO branch_inventory_stock (branch_id, inventory_item_id, quantity) VALUES ($1,$2,100),($1,$3,3)",
    [ckBranchId, itemAId, itemBId]
  );
});

afterAll(async () => {
  await pool.end();
});

describe("GET /api/kitchen-orders/:id/picking - معاينة", () => {
  test("السنتر كيتشن بيشوف المطلوب مقابل المتاح والفرق (shortfall)", async () => {
    const orderId = await createApprovedOrder([
      { inventoryItemId: itemAId, quantityRequested: 10 },
      { inventoryItemId: itemBId, quantityRequested: 8 },
    ]);
    const res = await request(app).get(`/api/kitchen-orders/${orderId}/picking`).set(authed(ckManagerToken));
    expect(res.status).toBe(200);
    const a = res.body.items.find((i) => i.inventory_item_id === itemAId);
    const b = res.body.items.find((i) => i.inventory_item_id === itemBId);
    expect(Number(a.available)).toBe(100);
    expect(a.shortfall).toBe(0);
    expect(Number(b.available)).toBe(3);
    expect(b.shortfall).toBeCloseTo(5, 5);
  });

  test("الفرع الطالب نفسه (مش سنتر كيتشن) ممنوع يشوف شاشة التجهيز", async () => {
    const orderId = await createApprovedOrder([{ inventoryItemId: itemAId, quantityRequested: 5 }]);
    const res = await request(app).get(`/api/kitchen-orders/${orderId}/picking`).set(authed(managerToken));
    expect(res.status).toBe(403);
  });

  test("أدمن من غير ckBranchId - مرفوض", async () => {
    const orderId = await createApprovedOrder([{ inventoryItemId: itemAId, quantityRequested: 5 }]);
    const res = await request(app).get(`/api/kitchen-orders/${orderId}/picking`).set(authed(adminToken));
    expect(res.status).toBe(400);
  });

  test("أدمن مع ckBranchId - شغالة", async () => {
    const orderId = await createApprovedOrder([{ inventoryItemId: itemAId, quantityRequested: 5 }]);
    const res = await request(app).get(`/api/kitchen-orders/${orderId}/picking?ckBranchId=${ckBranchId}`).set(authed(adminToken));
    expect(res.status).toBe(200);
  });
});

describe("POST /api/kitchen-orders/:id/picking - الالتزام الفعلي", () => {
  test("تجهيز كامل لصنف متاح بالكامل - FULL + الطلبية تتحول APPROVED → PREPARING", async () => {
    const orderId = await createApprovedOrder([{ inventoryItemId: itemAId, quantityRequested: 10 }]);
    const res = await request(app).post(`/api/kitchen-orders/${orderId}/picking`).set(authed(ckManagerToken)).send({
      items: [{ inventoryItemId: itemAId, quantityToPrepare: 10 }],
    });
    expect(res.status).toBe(200);
    expect(res.body.order.status).toBe("PREPARING");
    expect(res.body.items[0].fulfillment_status).toBe("FULL");
    expect(Number(res.body.items[0].quantity_to_prepare)).toBe(10);
    expect(Number(res.body.items[0].quantity_available)).toBe(100);
  });

  test("تجهيز جزئي لصنف ناقص - PARTIAL بالظبط، مفيش عجز مخفي", async () => {
    const orderId = await createApprovedOrder([{ inventoryItemId: itemBId, quantityRequested: 8 }]);
    const res = await request(app).post(`/api/kitchen-orders/${orderId}/picking`).set(authed(ckManagerToken)).send({
      items: [{ inventoryItemId: itemBId, quantityToPrepare: 3 }],
    });
    expect(res.status).toBe(200);
    expect(res.body.items[0].fulfillment_status).toBe("PARTIAL");
    expect(Number(res.body.items[0].quantity_to_prepare)).toBe(3);
  });

  test("تجهيز صفر - UNFULFILLED صراحة", async () => {
    const orderId = await createApprovedOrder([{ inventoryItemId: itemBId, quantityRequested: 8 }]);
    const res = await request(app).post(`/api/kitchen-orders/${orderId}/picking`).set(authed(ckManagerToken)).send({
      items: [{ inventoryItemId: itemBId, quantityToPrepare: 0 }],
    });
    expect(res.status).toBe(200);
    expect(res.body.items[0].fulfillment_status).toBe("UNFULFILLED");
  });

  test("كمية تجهيز أكبر من المطلوب - مرفوضة", async () => {
    const orderId = await createApprovedOrder([{ inventoryItemId: itemAId, quantityRequested: 5 }]);
    const res = await request(app).post(`/api/kitchen-orders/${orderId}/picking`).set(authed(ckManagerToken)).send({
      items: [{ inventoryItemId: itemAId, quantityToPrepare: 999 }],
    });
    expect(res.status).toBe(400);
  });

  test("تكرار التجهيز وهي بالفعل PREPARING - بيحدّث الالتزام من غير ما يعيد النقلة", async () => {
    const orderId = await createApprovedOrder([{ inventoryItemId: itemAId, quantityRequested: 10 }]);
    const first = await request(app).post(`/api/kitchen-orders/${orderId}/picking`).set(authed(ckManagerToken)).send({
      items: [{ inventoryItemId: itemAId, quantityToPrepare: 6 }],
    });
    expect(first.body.order.status).toBe("PREPARING");
    const firstStartedAt = first.body.order.preparing_started_at;

    const second = await request(app).post(`/api/kitchen-orders/${orderId}/picking`).set(authed(ckManagerToken)).send({
      items: [{ inventoryItemId: itemAId, quantityToPrepare: 10 }],
    });
    expect(second.status).toBe(200);
    expect(second.body.order.status).toBe("PREPARING");
    expect(second.body.order.preparing_started_at).toBe(firstStartedAt);
    expect(second.body.items[0].fulfillment_status).toBe("FULL");
  });

  test("تجهيز طلبية لسه SUBMITTED (مش APPROVED/PREPARING) - مرفوض", async () => {
    const created = await request(app).post("/api/kitchen-orders").set(authed(managerToken)).send({
      branchId, status: "DRAFT", items: [{ inventoryItemId: itemAId, quantityRequested: 5 }],
    });
    await request(app).post(`/api/kitchen-orders/${created.body.orderId}/submit`).set(authed(managerToken)).expect(200);
    const res = await request(app).post(`/api/kitchen-orders/${created.body.orderId}/picking`).set(authed(ckManagerToken)).send({
      items: [{ inventoryItemId: itemAId, quantityToPrepare: 5 }],
    });
    expect(res.status).toBe(400);
  });

  test("الفرع الطالب نفسه ممنوع يجهّز طلبيته", async () => {
    const orderId = await createApprovedOrder([{ inventoryItemId: itemAId, quantityRequested: 5 }]);
    const res = await request(app).post(`/api/kitchen-orders/${orderId}/picking`).set(authed(managerToken)).send({
      items: [{ inventoryItemId: itemAId, quantityToPrepare: 5 }],
    });
    expect(res.status).toBe(403);
  });
});
