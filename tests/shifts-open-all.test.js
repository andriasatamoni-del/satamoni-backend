// المرحلة 8.15: GET /api/shifts/open-all - شاشة "Live Operations" في داش بورد الأدمن/المالك. ضد
// Postgres حقيقي. بيغطي: بيرجع كل الشيفتات المفتوحة (ACTIVE) عبر كل الفروع مع بعض، مش بيرجع شيفتات
// مقفولة، ومقصور على الأدمن بس (مدير فرع/محاسب/كاشير كلهم 403).
const { app, request, pool, seedUser, login, authed } = require("./helpers");

let branchA, branchB;
let cashierAToken, cashierBToken, managerAToken, accountantToken, adminToken;

beforeAll(async () => {
  const bA = await pool.query("INSERT INTO branches (name) VALUES ('فرع-عمليات-حية-A-جست') RETURNING id");
  branchA = bA.rows[0].id;
  const bB = await pool.query("INSERT INTO branches (name) VALUES ('فرع-عمليات-حية-B-جست') RETURNING id");
  branchB = bB.rows[0].id;

  await seedUser({ branchId: branchA, name: "كاشير-عمليات-حية-A", email: "cashierA-liveops@jest.test", role: "cashier" });
  await seedUser({ branchId: branchB, name: "كاشير-عمليات-حية-B", email: "cashierB-liveops@jest.test", role: "cashier" });
  await seedUser({ branchId: branchA, name: "مدير-عمليات-حية", email: "manager-liveops@jest.test", role: "branch_manager" });
  await seedUser({ name: "محاسب-عمليات-حية", email: "accountant-liveops@jest.test", role: "accountant" });
  await seedUser({ name: "أدمن-عمليات-حية", email: "admin-liveops@jest.test", role: "admin" });

  cashierAToken = await login("cashierA-liveops@jest.test");
  cashierBToken = await login("cashierB-liveops@jest.test");
  managerAToken = await login("manager-liveops@jest.test");
  accountantToken = await login("accountant-liveops@jest.test");
  adminToken = await login("admin-liveops@jest.test");
});

afterAll(async () => {
  await pool.end();
});

describe("GET /api/shifts/open-all", () => {
  test("مدير فرع/محاسب/كاشير - 403", async () => {
    for (const token of [managerAToken, accountantToken, cashierAToken]) {
      const res = await request(app).get("/api/shifts/open-all").set(authed(token));
      expect(res.status).toBe(403);
    }
  });

  test("أدمن بيشوف الشيفتات المفتوحة عبر كل الفروع، مش المقفولة", async () => {
    const openA = await request(app).post("/api/shifts/open").set(authed(cashierAToken)).send({ openingCash: 200 });
    const openB = await request(app).post("/api/shifts/open").set(authed(cashierBToken)).send({ openingCash: 300 });
    await request(app).post(`/api/shifts/${openB.body.id}/close`).set(authed(cashierBToken)).send({ actualCash: 300 });

    const res = await request(app).get("/api/shifts/open-all").set(authed(adminToken));
    expect(res.status).toBe(200);
    const ids = res.body.map((s) => s.id);
    expect(ids).toContain(openA.body.id);
    expect(ids).not.toContain(openB.body.id);

    const rowA = res.body.find((s) => s.id === openA.body.id);
    expect(rowA.status).toBe("ACTIVE");
    expect(rowA.cashier_name).toBe("كاشير-عمليات-حية-A");
    expect(rowA.branch_name).toBe("فرع-عمليات-حية-A-جست");

    // امسح الشيفت المفتوح عشان مايأثرش على اختبارات تانية بتنادي نفس الـendpoint
    await request(app).post(`/api/shifts/${openA.body.id}/close`).set(authed(cashierAToken)).send({ actualCash: 200 });
  });
});
