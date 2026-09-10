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
