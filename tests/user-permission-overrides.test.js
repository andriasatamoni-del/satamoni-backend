// المرحلة 8.58: صلاحيات كل موظف قابلة للتخصيص فرديًا فوق دوره الأساسي - إضافة صلاحية زيادة عن دوره،
// أو إلغاء صلاحية من صلاحيات دوره الافتراضية. بيغطي: منح صلاحية إضافية لكاشير تفتحله إجراء مقفول
// أصلًا على دوره، إلغاء صلاحية من مدير فرع/أدمن تقفلها حتى لو دوره بيدّيها له أصلًا (حتى صلاحية
// الأدمن الشاملة "*")، رفض صلاحية غير معروفة، وكتالوج الصلاحيات نفسه.
const { app, request, pool, seedUser, login, authed } = require("./helpers");

let branchId;
let adminToken, adminUserId;
let managerToken, managerUserId;
let cashierToken, cashierUserId;
let rolePermissions;

beforeAll(async () => {
  const b = await pool.query("INSERT INTO branches (name) VALUES ('فرع 8.58-جست') RETURNING id");
  branchId = b.rows[0].id;

  adminUserId = await seedUser({ name: "أدمن-8.58", email: "admin-858@jest.test", role: "admin" });
  adminToken = await login("admin-858@jest.test");
  managerUserId = await seedUser({ branchId, name: "مدير-8.58", email: "manager-858@jest.test", role: "branch_manager" });
  managerToken = await login("manager-858@jest.test");
  cashierUserId = await seedUser({ branchId, name: "كاشير-8.58", email: "cashier-858@jest.test", role: "cashier" });
  cashierToken = await login("cashier-858@jest.test");

  const catalogRes = await request(app).get("/api/users/permissions-catalog").set(authed(adminToken));
  expect(catalogRes.status).toBe(200);
  rolePermissions = catalogRes.body.rolePermissions;
});

afterAll(async () => {
  await pool.end();
});

describe("كتالوج الصلاحيات (8.58)", () => {
  test("أدمن بس - غير أدمن يترفض 403", async () => {
    const res = await request(app).get("/api/users/permissions-catalog").set(authed(cashierToken));
    expect(res.status).toBe(403);
  });

  test("الكتالوج فيه كل الصلاحيات مجمّعة، وrolePermissions.admin بيرجع كل الصلاحيات مش '*' حرفيًا", async () => {
    const res = await request(app).get("/api/users/permissions-catalog").set(authed(adminToken));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.catalog)).toBe(true);
    expect(res.body.catalog.length).toBeGreaterThan(10);
    const totalPerms = res.body.catalog.reduce((s, g) => s + g.permissions.length, 0);
    expect(totalPerms).toBeGreaterThan(50);
    expect(res.body.rolePermissions.admin).not.toContain("*");
    expect(res.body.rolePermissions.admin.length).toBe(totalPerms);
    expect(res.body.rolePermissions.cashier).toContain("orders.create");
    expect(res.body.rolePermissions.cashier).not.toContain("drivers.manage");
  });
});

describe("منح صلاحية إضافية فوق الدور (8.58)", () => {
  test("كاشير من غير drivers.manage - محاولة إنشاء سائق ترفض 403", async () => {
    const res = await request(app).post("/api/drivers").set(authed(cashierToken)).send({ name: "سائق تجربة 1", branchId });
    expect(res.status).toBe(403);
  });

  test("بعد منح drivers.manage لنفس الكاشير - بينجح فورًا من غير لوج آوت", async () => {
    const extraPermissions = [...rolePermissions.cashier, "drivers.manage"];
    const patchRes = await request(app)
      .patch(`/api/users/${cashierUserId}`)
      .set(authed(adminToken))
      .send({ permissions: extraPermissions });
    expect(patchRes.status).toBe(200);
    expect(patchRes.body.permission_grants).toContain("drivers.manage");
    expect(patchRes.body.permission_revokes).toEqual([]);

    const res = await request(app).post("/api/drivers").set(authed(cashierToken)).send({ name: "سائق تجربة 2", branchId });
    expect(res.status).toBe(201);
  });
});

describe("إلغاء صلاحية من صلاحيات الدور الأساسية (8.58)", () => {
  test("مدير الفرع معاه drivers.manage أصلًا - بعد إلغاؤها منه بيترفض 403", async () => {
    const reduced = rolePermissions.branch_manager.filter((p) => p !== "drivers.manage");
    const patchRes = await request(app)
      .patch(`/api/users/${managerUserId}`)
      .set(authed(adminToken))
      .send({ permissions: reduced });
    expect(patchRes.status).toBe(200);
    expect(patchRes.body.permission_revokes).toContain("drivers.manage");

    const res = await request(app).post("/api/drivers").set(authed(managerToken)).send({ name: "سائق تجربة 3", branchId });
    expect(res.status).toBe(403);
  });

  test("إلغاء صلاحية من أدمن (اللي أصله '*' شامل) - بتتقفل حتى مع صلاحية الأدمن الشاملة", async () => {
    const otherAdminUserId = await seedUser({ name: "أدمن-8.58-تاني", email: "admin2-858@jest.test", role: "admin" });
    const otherAdminToken = await login("admin2-858@jest.test");

    // أدمن تاني (مش هو نفسه) لسه معاه كل الصلاحيات - يقدر ينشئ بنك عادي
    const controlRes = await request(app).post("/api/banks").set(authed(otherAdminToken)).send({ name: "بنك ضبط 8.58" });
    expect(controlRes.status).toBe(201);

    const allExceptBanksManage = rolePermissions.admin.filter((p) => p !== "banks.manage");
    const patchRes = await request(app)
      .patch(`/api/users/${adminUserId}`)
      .set(authed(otherAdminToken))
      .send({ permissions: allExceptBanksManage });
    expect(patchRes.status).toBe(200);
    expect(patchRes.body.permission_revokes).toContain("banks.manage");

    const res = await request(app).post("/api/banks").set(authed(adminToken)).send({ name: "بنك ممنوع 8.58" });
    expect(res.status).toBe(403);

    // باقي صلاحيات الأدمن الأول لسه شغالة عادي (الإلغاء مقصور على banks.manage بس)
    const stillWorks = await request(app).get("/api/banks").set(authed(adminToken));
    expect(stillWorks.status).toBe(200);
  });
});

describe("تحقق من صحة الصلاحيات المبعوتة (8.58)", () => {
  test("صلاحية مش موجودة في الكتالوج - ترفض 400 عند الإنشاء", async () => {
    const res = await request(app).post("/api/users").set(authed(adminToken)).send({
      name: "موظف صلاحية غلط", email: "badperm-858@jest.test", password: "test12345",
      role: "cashier", branchId, permissions: ["orders.create", "شيء.مش.موجود"],
    });
    expect(res.status).toBe(400);
  });

  test("صلاحية مش موجودة - ترفض 400 عند التعديل", async () => {
    const res = await request(app)
      .patch(`/api/users/${cashierUserId}`)
      .set(authed(adminToken))
      .send({ permissions: ["مش.موجودة.خالص"] });
    expect(res.status).toBe(400);
  });

  test("إنشاء موظف من غير permissions خالص - بياخد صلاحيات دوره الافتراضية بالظبط", async () => {
    const res = await request(app).post("/api/users").set(authed(adminToken)).send({
      name: "كاشير عادي 8.58", email: "plaincashier-858@jest.test", password: "test12345",
      role: "cashier", branchId,
    });
    expect(res.status).toBe(201);
    expect(res.body.permission_grants).toEqual([]);
    expect(res.body.permission_revokes).toEqual([]);
  });
});

// المرحلة 9A-2: orders.create/orders.discount.request كانوا موجودين في الكتالوج بس مش متحققين فعليًا في
// أي راوت (requirePosAuthIfNeeded كان بيعتمد على requireRole بس، وبلوك الخصم كان بيشتغل لأي حد يقدر
// يسجّل طلب بغض النظر عن الصلاحية دي) - يعني سحبهم من موظف معيّن كان مالوش أي تأثير حقيقي على الإطلاق.
// الاختبارات دي بتتأكد إن السحب/المنح بقى بيغيّر السلوك فعليًا، مش مجرد قيمة متخزّنة في العمود
describe("orders.create / orders.discount.request بيغيّروا السلوك فعليًا (9A-2)", () => {
  let opBranchId, opCashierId, opCashierToken, opMenuItemId, opVariantId, opPmId;

  beforeAll(async () => {
    const b = await pool.query("INSERT INTO branches (name) VALUES ('فرع-9A2-صلاحيات') RETURNING id");
    opBranchId = b.rows[0].id;
    opCashierId = await seedUser({ branchId: opBranchId, name: "كاشير-9A2-صلاحيات", email: "cashier-9a2perm@jest.test", role: "cashier" });
    opCashierToken = await login("cashier-9a2perm@jest.test");

    const cat = await pool.query("INSERT INTO menu_categories (name) VALUES ('9A2-صلاحيات-قسم') RETURNING id");
    const mi = await pool.query("INSERT INTO menu_items (category_id, name) VALUES ($1,'9A2-صلاحيات-صنف') RETURNING id", [cat.rows[0].id]);
    opMenuItemId = mi.rows[0].id;
    const v = await pool.query("INSERT INTO menu_item_variants (item_id, label, price) VALUES ($1,'عادي',100) RETURNING id", [mi.rows[0].id]);
    opVariantId = v.rows[0].id;
    const pm = await pool.query("INSERT INTO payment_methods (name, kind) VALUES ('كاش-9A2-صلاحيات', 'cash') RETURNING id");
    opPmId = pm.rows[0].id;
  });

  test("كاشير عادي (معاه orders.create من دوره) - يقدر يسجّل طلب عادي", async () => {
    const res = await request(app).post("/api/orders").set(authed(opCashierToken)).send({
      branchId: opBranchId, source: "pos", orderType: "takeaway", paymentMethodId: opPmId,
      items: [{ itemId: opMenuItemId, variantId: opVariantId, quantity: 1 }],
    });
    expect(res.status).toBe(201);
  });

  test("بعد سحب orders.create - نفس الكاشير يترفض 403 حتى لو دوره الأساسي كاشير عادي", async () => {
    const reduced = rolePermissions.cashier.filter((p) => p !== "orders.create");
    const patchRes = await request(app)
      .patch(`/api/users/${opCashierId}`)
      .set(authed(adminToken))
      .send({ permissions: reduced });
    expect(patchRes.status).toBe(200);
    expect(patchRes.body.permission_revokes).toContain("orders.create");

    // محاولة تسجيل طلب مباشرة (direct API bypass - مفيش أي زرار في الواجهة، بس بنتأكد السيرفر رافض فعليًا)
    const res = await request(app).post("/api/orders").set(authed(opCashierToken)).send({
      branchId: opBranchId, source: "pos", orderType: "takeaway", paymentMethodId: opPmId,
      items: [{ itemId: opMenuItemId, variantId: opVariantId, quantity: 1 }],
    });
    expect(res.status).toBe(403);

    // إعادة orders.create - يرجع يقدر يسجّل طلب تاني فورًا من غير لوج آوت
    const restorePatch = await request(app)
      .patch(`/api/users/${opCashierId}`)
      .set(authed(adminToken))
      .send({ permissions: rolePermissions.cashier });
    expect(restorePatch.status).toBe(200);
    expect(restorePatch.body.permission_revokes).toEqual([]);
  });

  test("بعد سحب orders.discount.request - نفس الكاشير يقدر يسجّل طلب من غير خصم، بس يترفض 403 لو حط أي خصم (حتى صغير تحت حد الموافقة)", async () => {
    const reduced = rolePermissions.cashier.filter((p) => p !== "orders.discount.request");
    const patchRes = await request(app)
      .patch(`/api/users/${opCashierId}`)
      .set(authed(adminToken))
      .send({ permissions: reduced });
    expect(patchRes.status).toBe(200);
    expect(patchRes.body.permission_revokes).toContain("orders.discount.request");

    const noDiscount = await request(app).post("/api/orders").set(authed(opCashierToken)).send({
      branchId: opBranchId, source: "pos", orderType: "takeaway", paymentMethodId: opPmId,
      items: [{ itemId: opMenuItemId, variantId: opVariantId, quantity: 1 }],
    });
    expect(noDiscount.status).toBe(201);

    // خصم صغير (5 جنيه من 100 = 5%) تحت حد الموافقة الافتراضي (10%) - كان قبل كده بيعدّي عادي من غير
    // أي تحقق من orders.discount.request خالص، دلوقتي لازم يترفض 403
    const smallDiscount = await request(app).post("/api/orders").set(authed(opCashierToken)).send({
      branchId: opBranchId, source: "pos", orderType: "takeaway", paymentMethodId: opPmId,
      items: [{ itemId: opMenuItemId, variantId: opVariantId, quantity: 1 }], discount: 5,
    });
    expect(smallDiscount.status).toBe(403);

    const restorePatch = await request(app)
      .patch(`/api/users/${opCashierId}`)
      .set(authed(adminToken))
      .send({ permissions: rolePermissions.cashier });
    expect(restorePatch.status).toBe(200);

    const smallDiscountAfterRestore = await request(app).post("/api/orders").set(authed(opCashierToken)).send({
      branchId: opBranchId, source: "pos", orderType: "takeaway", paymentMethodId: opPmId,
      items: [{ itemId: opMenuItemId, variantId: opVariantId, quantity: 1 }], discount: 5,
    });
    expect(smallDiscountAfterRestore.status).toBe(201);
  });
});

// المرحلة 9A-2: orders.void.approve بتتحقق فعليًا وقت إصدار توكن الموافقة نفسه (issueApprovalGrant في
// db/approval-engine.js بيرفض PIN مدير مش معاه الصلاحية دي) - سحبها من مدير فرع معيّن لازم يمنعه يبقى
// "موافق" لاسترجاع طلب حد تاني، حتى لو لسه معاه orders.cancel (يقدر يلغي طلباته هو بنفسه بس)
describe("orders.void.approve بتتحقق فعليًا وقت إصدار توكن الموافقة (9A-2)", () => {
  let vaBranchId, vaManagerId, vaCashierToken, vaMenuItemId, vaVariantId, vaPmId;

  beforeAll(async () => {
    const b = await pool.query("INSERT INTO branches (name) VALUES ('فرع-9A2-اعتماد-استرجاع') RETURNING id");
    vaBranchId = b.rows[0].id;
    vaManagerId = await seedUser({ branchId: vaBranchId, name: "مدير-9A2-اعتماد", email: "manager-9a2approve@jest.test", role: "branch_manager", pin: "6655" });
    await seedUser({ branchId: vaBranchId, name: "كاشير-9A2-اعتماد", email: "cashier-9a2approve@jest.test", role: "cashier" });
    vaCashierToken = await login("cashier-9a2approve@jest.test");

    const cat = await pool.query("INSERT INTO menu_categories (name) VALUES ('9A2-اعتماد-قسم') RETURNING id");
    const mi = await pool.query("INSERT INTO menu_items (category_id, name) VALUES ($1,'9A2-اعتماد-صنف') RETURNING id", [cat.rows[0].id]);
    vaMenuItemId = mi.rows[0].id;
    const v = await pool.query("INSERT INTO menu_item_variants (item_id, label, price) VALUES ($1,'عادي',60) RETURNING id", [vaMenuItemId]);
    vaVariantId = v.rows[0].id;
    const pm = await pool.query("INSERT INTO payment_methods (name, kind) VALUES ('كاش-9A2-اعتماد', 'cash') RETURNING id");
    vaPmId = pm.rows[0].id;
  });

  async function makeOrder() {
    const res = await request(app).post("/api/orders").set(authed(vaCashierToken)).send({
      branchId: vaBranchId, source: "pos", orderType: "takeaway", paymentMethodId: vaPmId,
      items: [{ itemId: vaMenuItemId, variantId: vaVariantId, quantity: 1 }],
    });
    expect(res.status).toBe(201);
    return res.body.orderId;
  }

  test("مدير الفرع (معاه orders.void.approve من دوره) - يقدر يوافق على استرجاع طلب كاشير", async () => {
    const orderId = await makeOrder();
    const pinRes = await request(app).post("/api/auth/verify-override-pin").set(authed(vaCashierToken)).send({
      pin: "6655", branchId: vaBranchId, actionType: "ORDER_VOID", targetType: "order", targetId: orderId,
    });
    expect(pinRes.status).toBe(200);
    const voidRes = await request(app).post(`/api/orders/${orderId}/void`).set(authed(vaCashierToken)).send({
      reason: "اختبار", approvalToken: pinRes.body.token,
    });
    expect(voidRes.status).toBe(200);
  });

  test("بعد سحب orders.void.approve من مدير الفرع - PIN بتاعه يترفض 403 وقت طلب الموافقة (مش وقت الاستخدام)", async () => {
    const catalogRes = await request(app).get("/api/users/permissions-catalog").set(authed(adminToken));
    const reduced = catalogRes.body.rolePermissions.branch_manager.filter((p) => p !== "orders.void.approve");
    const patchRes = await request(app)
      .patch(`/api/users/${vaManagerId}`)
      .set(authed(adminToken))
      .send({ permissions: reduced });
    expect(patchRes.status).toBe(200);
    expect(patchRes.body.permission_revokes).toContain("orders.void.approve");

    const orderId = await makeOrder();
    const pinRes = await request(app).post("/api/auth/verify-override-pin").set(authed(vaCashierToken)).send({
      pin: "6655", branchId: vaBranchId, actionType: "ORDER_VOID", targetType: "order", targetId: orderId,
    });
    expect(pinRes.status).toBe(403);

    // بس لسه معاه orders.cancel - يقدر يلغي طلب هو نفسه بحسابه على طول (بدون تفويض حد تاني)
    const managerToken = await login("manager-9a2approve@jest.test");
    const selfVoid = await request(app).post(`/api/orders/${orderId}/void`).set(authed(managerToken)).send({ reason: "استرجاع طلب نفسي" });
    expect(selfVoid.status).toBe(200);
  });
});
