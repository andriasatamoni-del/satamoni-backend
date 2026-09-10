// المرحلة 8.58: جرد فعلي (Spot Check) - شاشة الأصناف. بيغطي: حساب الفرق والقيمة والأسباب المقترحة
// في /preview من غير أي تسجيل، تأكيد الجرد وتسجيل الفرق فعليًا (STOCK_COUNT + قيد 5300/1400 زي
// reconcile بالظبط)، تحميل عجز كسلفة على موظف بعينه بدل حساب محاسبي، منع تحميل زيادة على موظف،
// تجاهل السطور اللي فرقها صفر، وسجل/تفاصيل جلسات الجرد.
const { app, request, pool, seedUser, login, authed } = require("./helpers");

let branchId;
let managerToken;
let itemAId, itemBId; // A: عندها unit_cost، B: من غيره (عشان نتأكد من التعامل مع NULL)
let employeeId;

beforeAll(async () => {
  const b = await pool.query("INSERT INTO branches (name) VALUES ('فرع جرد-8.58-جست') RETURNING id");
  branchId = b.rows[0].id;
  await seedUser({ branchId, name: "مدير-جرد-8.58", email: "manager-stocktake-858@jest.test", role: "branch_manager" });
  managerToken = await login("manager-stocktake-858@jest.test");

  const itemA = await pool.query(
    "INSERT INTO inventory_items (name, unit, unit_cost) VALUES ('خامة-جرد-A-جست', 'كيلو', 20) RETURNING id"
  );
  itemAId = itemA.rows[0].id;
  const itemB = await pool.query(
    "INSERT INTO inventory_items (name, unit) VALUES ('خامة-جرد-B-جست', 'قطعة') RETURNING id"
  );
  itemBId = itemB.rows[0].id;
  await pool.query(
    "INSERT INTO branch_inventory_stock (branch_id, inventory_item_id, quantity) VALUES ($1,$2,100), ($1,$3,50)",
    [branchId, itemAId, itemBId]
  );

  const userId = await seedUser({ branchId, name: "موظف-جرد-8.58", email: "employee-stocktake-858@jest.test", role: "cashier" });
  const emp = await pool.query(
    "INSERT INTO employees (user_id, name, department, attendance_system) VALUES ($1,'موظف-جرد-8.58','تشغيل الفرع','none') RETURNING id",
    [userId]
  );
  employeeId = emp.rows[0].id;
});

afterAll(async () => {
  await pool.end();
});

describe("POST /api/stocktake/preview - حساب من غير تسجيل (8.58)", () => {
  test("عجز: فرق سالب، قيمة سالبة، أسباب عجز مقترحة، ينفع يتحمّل على موظف", async () => {
    const res = await request(app).post("/api/stocktake/preview").set(authed(managerToken)).send({
      branchId, items: [{ inventoryItemId: itemAId, actualQuantity: 90 }],
    });
    expect(res.status).toBe(200);
    const line = res.body[0];
    expect(line.systemQuantity).toBe(100);
    expect(line.varianceQuantity).toBe(-10);
    expect(line.varianceValue).toBe(-200); // -10 * 20
    expect(line.canChargeEmployee).toBe(true);
    expect(line.suggestedReasons.length).toBeGreaterThan(0);
  });

  test("زيادة: فرق موجب، قيمة موجبة، مينفعش يتحمّل على موظف", async () => {
    const res = await request(app).post("/api/stocktake/preview").set(authed(managerToken)).send({
      branchId, items: [{ inventoryItemId: itemAId, actualQuantity: 115 }],
    });
    const line = res.body[0];
    expect(line.varianceQuantity).toBe(15);
    expect(line.varianceValue).toBe(300);
    expect(line.canChargeEmployee).toBe(false);
  });

  test("مطابق: فرق صفر، مفيش أسباب مقترحة", async () => {
    const res = await request(app).post("/api/stocktake/preview").set(authed(managerToken)).send({
      branchId, items: [{ inventoryItemId: itemAId, actualQuantity: 100 }],
    });
    expect(res.body[0].varianceQuantity).toBe(0);
    expect(res.body[0].suggestedReasons).toEqual([]);
  });

  test("صنف من غير unit_cost - varianceValue بترجع null من غير ما تكسر", async () => {
    const res = await request(app).post("/api/stocktake/preview").set(authed(managerToken)).send({
      branchId, items: [{ inventoryItemId: itemBId, actualQuantity: 45 }],
    });
    expect(res.body[0].varianceQuantity).toBe(-5);
    expect(res.body[0].varianceValue).toBeNull();
  });
});

describe("POST /api/stocktake - تأكيد الجرد (8.58)", () => {
  test("سطر فرقه صفر مش بيتسجل خالص، وسطر فيه فرق بيتحمّل على حساب محاسبي زي reconcile", async () => {
    const res = await request(app).post("/api/stocktake").set(authed(managerToken)).send({
      branchId,
      lines: [
        { inventoryItemId: itemAId, actualQuantity: 100 }, // مطابق - مش هيتسجل
        { inventoryItemId: itemBId, actualQuantity: 45, reason: "تلف" }, // عجز 5 - حساب محاسبي افتراضي
      ],
    });
    expect(res.status).toBe(201);
    expect(res.body.lines.length).toBe(1);
    const line = res.body.lines[0];
    expect(line.inventory_item_id).toBe(itemBId);
    expect(Number(line.variance_quantity)).toBe(-5);
    expect(line.charge_type).toBeNull(); // itemB من غير unit_cost - مفيش قيمة تتحمّل خالص

    const stock = await pool.query("SELECT quantity FROM branch_inventory_stock WHERE branch_id=$1 AND inventory_item_id=$2", [branchId, itemBId]);
    expect(Number(stock.rows[0].quantity)).toBe(45);

    const movements = await pool.query("SELECT * FROM inventory_movements WHERE id = $1", [line.inventory_movement_id]);
    expect(movements.rows[0].movement_type).toBe("STOCK_COUNT");
  });

  test("عجز بقيمة مالية - يتحمّل على حساب محاسبي (5300/1400) زي reconcile بالظبط", async () => {
    const res = await request(app).post("/api/stocktake").set(authed(managerToken)).send({
      branchId,
      lines: [{ inventoryItemId: itemAId, actualQuantity: 90, reason: "تلف" }],
    });
    expect(res.status).toBe(201);
    const line = res.body.lines[0];
    expect(Number(line.variance_value)).toBe(-200);
    expect(line.charge_type).toBe("account");
    expect(line.charge_account_code).toBe("5300");

    const je = await pool.query("SELECT * FROM journal_entries WHERE source_type='stock_count' AND source_id=$1", [line.inventory_movement_id]);
    expect(je.rows.length).toBe(1);
    const jeLines = await pool.query("SELECT * FROM journal_entry_lines WHERE journal_entry_id=$1", [je.rows[0].id]);
    expect(jeLines.rows.length).toBe(2);

    const stock = await pool.query("SELECT quantity FROM branch_inventory_stock WHERE branch_id=$1 AND inventory_item_id=$2", [branchId, itemAId]);
    expect(Number(stock.rows[0].quantity)).toBe(90);
  });

  test("عجز يتحمّل كسلفة على موظف بعينه - قيد مدين ذمم الموظف، وسلفة payroll_adjustments", async () => {
    const before = await pool.query(
      "SELECT quantity FROM branch_inventory_stock WHERE branch_id=$1 AND inventory_item_id=$2", [branchId, itemAId]
    );
    const systemQty = Number(before.rows[0].quantity);

    const res = await request(app).post("/api/stocktake").set(authed(managerToken)).send({
      branchId,
      lines: [{
        inventoryItemId: itemAId, actualQuantity: systemQty - 4, reason: "سرقة أو فقد",
        chargeType: "employee", chargeEmployeeId: employeeId,
      }],
    });
    expect(res.status).toBe(201);
    const line = res.body.lines[0];
    expect(Number(line.variance_quantity)).toBe(-4);
    expect(line.charge_type).toBe("employee");
    expect(Number(line.variance_value)).toBe(-80); // -4 * 20

    const adjustments = await pool.query(
      "SELECT * FROM payroll_adjustments WHERE employee_id=$1 AND adjustment_type='advance' AND stocktake_id=$2",
      [employeeId, res.body.id]
    );
    expect(adjustments.rows.length).toBe(1);
    expect(Number(adjustments.rows[0].amount)).toBe(80);

    const receivable = await pool.query("SELECT id FROM accounts WHERE code = $1", [`1160-${employeeId}`]);
    expect(receivable.rows.length).toBe(1);
    const je = await pool.query("SELECT * FROM journal_entries WHERE source_type='stock_count' AND source_id=$1", [line.inventory_movement_id]);
    const jeLines = await pool.query("SELECT * FROM journal_entry_lines WHERE journal_entry_id=$1 AND account_id=$2", [je.rows[0].id, receivable.rows[0].id]);
    expect(Number(jeLines.rows[0].debit)).toBe(80);
  });

  test("زيادة (فرق موجب) - محاولة تحميلها على موظف ترفض 400", async () => {
    const res = await request(app).post("/api/stocktake").set(authed(managerToken)).send({
      branchId,
      lines: [{ inventoryItemId: itemAId, actualQuantity: 500, chargeType: "employee", chargeEmployeeId: employeeId }],
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/مالهاش موظف/);
  });

  test("موظف غير موجود - ترفض 400", async () => {
    const res = await request(app).post("/api/stocktake").set(authed(managerToken)).send({
      branchId,
      lines: [{ inventoryItemId: itemAId, actualQuantity: 80, chargeType: "employee", chargeEmployeeId: 999999999 }],
    });
    expect(res.status).toBe(400);
  });

  test("حساب محاسبي غير موجود - ترفض 400", async () => {
    const res = await request(app).post("/api/stocktake").set(authed(managerToken)).send({
      branchId,
      lines: [{ inventoryItemId: itemAId, actualQuantity: 80, chargeType: "account", chargeAccountCode: "9999-مش-موجود" }],
    });
    expect(res.status).toBe(400);
  });

  test("فرع تاني - يترفض 403", async () => {
    const b2 = await pool.query("INSERT INTO branches (name) VALUES ('فرع-جرد-تاني-8.58') RETURNING id");
    const res = await request(app).post("/api/stocktake").set(authed(managerToken)).send({
      branchId: b2.rows[0].id, lines: [{ inventoryItemId: itemAId, actualQuantity: 1 }],
    });
    expect(res.status).toBe(403);
  });
});

describe("سجل جلسات الجرد (8.58)", () => {
  test("GET /api/stocktake - بيرجّع الجلسات اللي اتسجلت", async () => {
    const res = await request(app).get(`/api/stocktake?branchId=${branchId}`).set(authed(managerToken));
    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThanOrEqual(3);
  });

  test("GET /api/stocktake/:id - تفاصيل جلسة بسطورها", async () => {
    const list = await request(app).get(`/api/stocktake?branchId=${branchId}`).set(authed(managerToken));
    const id = list.body[0].id;
    const res = await request(app).get(`/api/stocktake/${id}`).set(authed(managerToken));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.lines)).toBe(true);
  });
});

// المرحلة 8.59: تصحيح سطر جرد اتسجّل برقم غلط - بيسجّل حركة مخزون وقيد محاسبي جديدين يحملوا بس الفرق
// (delta) من غير ما يلمس السطر الأصلي أو قيده المرحّل POSTED خالص (نفس قاعدة "قيد POSTED ميتلمسش")
describe("تصحيح سطر جرد (8.59)", () => {
  let corrItemId;
  let corrStocktakeId;
  let corrLineId;

  beforeAll(async () => {
    const item = await pool.query(
      "INSERT INTO inventory_items (name, unit, unit_cost) VALUES ('خامة-تصحيح-جرد-8.59-جست', 'كيلو', 10) RETURNING id"
    );
    corrItemId = item.rows[0].id;
    await pool.query(
      "INSERT INTO branch_inventory_stock (branch_id, inventory_item_id, quantity) VALUES ($1,$2,200)",
      [branchId, corrItemId]
    );
    const res = await request(app).post("/api/stocktake").set(authed(managerToken)).send({
      branchId, lines: [{ inventoryItemId: corrItemId, actualQuantity: 180, reason: "تلف" }],
    });
    corrStocktakeId = res.body.id;
    corrLineId = res.body.lines[0].id;
  });

  test("تصحيح بيزوّد العجز - قيد جديد بس على الفرق، مش بيلمس القيد الأصلي POSTED", async () => {
    const res = await request(app)
      .post(`/api/stocktake/${corrStocktakeId}/lines/${corrLineId}/correct`)
      .set(authed(managerToken))
      .send({ correctedActualQuantity: 170, reason: "غلطة عد" });
    expect(res.status).toBe(201);
    expect(Number(res.body.delta_quantity)).toBe(-10);
    expect(Number(res.body.delta_value)).toBe(-100);
    expect(res.body.charge_type).toBe("account");
    expect(res.body.charge_account_code).toBe("5300");

    const stock = await pool.query(
      "SELECT quantity FROM branch_inventory_stock WHERE branch_id=$1 AND inventory_item_id=$2", [branchId, corrItemId]
    );
    expect(Number(stock.rows[0].quantity)).toBe(170);

    const je = await pool.query(
      "SELECT * FROM journal_entries WHERE source_type='stock_count_correction' AND source_id=$1", [res.body.inventory_movement_id]
    );
    expect(je.rows.length).toBe(1);

    const originalLine = await pool.query("SELECT inventory_movement_id FROM stocktake_lines WHERE id=$1", [corrLineId]);
    const originalJe = await pool.query(
      "SELECT status FROM journal_entries WHERE source_type='stock_count' AND source_id=$1", [originalLine.rows[0].inventory_movement_id]
    );
    expect(originalJe.rows[0].status).toBe("POSTED");
  });

  test("تصحيح تاني بيقلّل العجز - اتجاه القيد بيتعكس (مدين مخزون 1400 / دائن حساب التسوية 5300)", async () => {
    const res = await request(app)
      .post(`/api/stocktake/${corrStocktakeId}/lines/${corrLineId}/correct`)
      .set(authed(managerToken))
      .send({ correctedActualQuantity: 175 });
    expect(res.status).toBe(201);
    expect(Number(res.body.delta_quantity)).toBe(5);
    expect(Number(res.body.delta_value)).toBe(50);

    const je = await pool.query(
      "SELECT * FROM journal_entries WHERE source_type='stock_count_correction' AND source_id=$1", [res.body.inventory_movement_id]
    );
    const jeLines = await pool.query("SELECT * FROM journal_entry_lines WHERE journal_entry_id=$1", [je.rows[0].id]);
    const inv = await pool.query("SELECT id FROM accounts WHERE code='1400'");
    const debitLine = jeLines.rows.find((l) => Number(l.debit) > 0);
    expect(debitLine.account_id).toBe(inv.rows[0].id);
  });

  test("تصحيح بيحمّل العجز الإضافي كسلفة على موظف بعينه", async () => {
    const res = await request(app)
      .post(`/api/stocktake/${corrStocktakeId}/lines/${corrLineId}/correct`)
      .set(authed(managerToken))
      .send({ correctedActualQuantity: 170, chargeType: "employee", chargeEmployeeId: employeeId });
    expect(res.status).toBe(201);
    expect(Number(res.body.delta_quantity)).toBe(-5);
    expect(res.body.charge_type).toBe("employee");

    const adjustments = await pool.query(
      "SELECT * FROM payroll_adjustments WHERE employee_id=$1 AND stocktake_id=$2 AND notes LIKE 'تصحيح%'",
      [employeeId, corrStocktakeId]
    );
    expect(adjustments.rows.length).toBe(1);
    expect(Number(adjustments.rows[0].amount)).toBe(50);
  });

  test("تصحيح بيقلّل العجز ومحاولة تحميله على موظف - يترفض 400", async () => {
    const res = await request(app)
      .post(`/api/stocktake/${corrStocktakeId}/lines/${corrLineId}/correct`)
      .set(authed(managerToken))
      .send({ correctedActualQuantity: 172, chargeType: "employee", chargeEmployeeId: employeeId });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/مينفعش يتحمّله موظف/);
  });

  test("نفس الكمية المسجّلة حاليًا - يترفض 400 (مفيش فرق)", async () => {
    const res = await request(app)
      .post(`/api/stocktake/${corrStocktakeId}/lines/${corrLineId}/correct`)
      .set(authed(managerToken))
      .send({ correctedActualQuantity: 170 });
    expect(res.status).toBe(400);
  });

  test("سطر مش موجود - 404", async () => {
    const res = await request(app)
      .post(`/api/stocktake/${corrStocktakeId}/lines/999999999/correct`)
      .set(authed(managerToken))
      .send({ correctedActualQuantity: 100 });
    expect(res.status).toBe(404);
  });

  test("فرع تاني - يترفض 403", async () => {
    const b2 = await pool.query("INSERT INTO branches (name) VALUES ('فرع-تصحيح-جرد-تاني-8.59') RETURNING id");
    await seedUser({ branchId: b2.rows[0].id, name: "مدير-فرع-تاني-8.59", email: "manager-corr-b2-859@jest.test", role: "branch_manager" });
    const token2 = await login("manager-corr-b2-859@jest.test");
    const res = await request(app)
      .post(`/api/stocktake/${corrStocktakeId}/lines/${corrLineId}/correct`)
      .set(authed(token2))
      .send({ correctedActualQuantity: 100 });
    expect(res.status).toBe(403);
  });

  test("GET /api/stocktake/:id - بيرجّع سجل التصحيحات والكمية/الفرق المعتمدين حاليًا لكل سطر", async () => {
    const res = await request(app).get(`/api/stocktake/${corrStocktakeId}`).set(authed(managerToken));
    expect(res.status).toBe(200);
    const line = res.body.lines.find((l) => l.id === corrLineId);
    expect(line.corrections.length).toBe(3);
    expect(Number(line.effectiveActualQuantity)).toBe(170);
    expect(Number(line.effectiveVarianceQuantity)).toBe(-30);
  });
});
