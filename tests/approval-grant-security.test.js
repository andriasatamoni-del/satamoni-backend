// المرحلة 9A-1: اختبارات عدائية/تزامن مخصّصة لنظام approval_grants (db/approval-engine.js) - بديل
// الـPIN القديم اللي كان بيرجّع هوية مدير قابلة لإعادة الاستخدام من غير أي ربط بإجراء/طلب معيّن (ثغرة
// replay حقيقية). هنا بنختبر المحرك نفسه (issueApprovalGrant/consumeApprovalGrant) مباشرة عبر pool،
// بالإضافة لمسار HTTP الكامل (verify-override-pin -> void)، تغطية: إعادة استخدام (replay)، إجراء غلط،
// فرع غلط، انتهاء صلاحية، استخدام مرتين، 5 محاولات متزامنة (لازم واحدة بس تنجح)، وهوية مزوّرة.
const { app, request, pool, seedUser, login, authed } = require("./helpers");
const { issueApprovalGrant, consumeApprovalGrant } = require("../db/approval-engine");

let branchId, otherBranchId;
let managerId, cashierToken;
let menuItemId, variantId, paymentMethodId;

beforeAll(async () => {
  const b = await pool.query("INSERT INTO branches (name) VALUES ('فرع-9A1-أمان') RETURNING id");
  branchId = b.rows[0].id;
  const b2 = await pool.query("INSERT INTO branches (name) VALUES ('فرع-9A1-أمان-تاني') RETURNING id");
  otherBranchId = b2.rows[0].id;

  managerId = await seedUser({ branchId, name: "مدير-9A1-أمان", email: "manager-9a1sec@jest.test", role: "branch_manager", pin: "4321" });
  await seedUser({ branchId, name: "كاشير-9A1-أمان", email: "cashier-9a1sec@jest.test", role: "cashier" });
  cashierToken = await login("cashier-9a1sec@jest.test");

  const cat = await pool.query("INSERT INTO menu_categories (name) VALUES ('9A1-أمان-قسم') RETURNING id");
  const mi = await pool.query("INSERT INTO menu_items (category_id, name) VALUES ($1,'9A1-أمان-صنف') RETURNING id", [cat.rows[0].id]);
  menuItemId = mi.rows[0].id;
  const v = await pool.query("INSERT INTO menu_item_variants (item_id, label, price) VALUES ($1,'عادي',80) RETURNING id", [mi.rows[0].id]);
  variantId = v.rows[0].id;
  const pm = await pool.query("INSERT INTO payment_methods (name, kind) VALUES ('كاش-9A1-أمان', 'cash') RETURNING id");
  paymentMethodId = pm.rows[0].id;
});

afterAll(async () => {
  await pool.end();
});

async function makeOrder() {
  const res = await request(app).post("/api/orders").set(authed(cashierToken)).send({
    branchId, source: "pos", orderType: "takeaway", paymentMethodId,
    items: [{ itemId: menuItemId, variantId, quantity: 1 }],
  });
  expect(res.status).toBe(201);
  return res.body.orderId;
}

describe("approval_grants: المحرك مباشرة (db/approval-engine.js)", () => {
  test("issueApprovalGrant: PIN غلط - PIN_INVALID", async () => {
    const client = await pool.connect();
    try {
      const result = await issueApprovalGrant(client, {
        pin: "0000", branchId, actionType: "ORDER_VOID", targetType: "order", targetId: "999999", requestedByUserId: null,
      });
      expect(result.error).toBe("PIN_INVALID");
    } finally {
      client.release();
    }
  });

  test("issueApprovalGrant: actionType غير معروف - ACTION_TYPE_UNKNOWN", async () => {
    const client = await pool.connect();
    try {
      const result = await issueApprovalGrant(client, {
        pin: "4321", branchId, actionType: "SOMETHING_MADE_UP", targetType: "order", targetId: "1", requestedByUserId: null,
      });
      expect(result.error).toBe("ACTION_TYPE_UNKNOWN");
    } finally {
      client.release();
    }
  });

  test("consumeApprovalGrant: بدون توكن خالص - APPROVAL_REQUIRED", async () => {
    const client = await pool.connect();
    try {
      await expect(consumeApprovalGrant(client, {
        token: null, actionType: "ORDER_VOID", targetType: "order", targetId: "1", branchId,
      })).rejects.toMatchObject({ code: "APPROVAL_REQUIRED" });
    } finally {
      client.release();
    }
  });

  test("consumeApprovalGrant: توكن مزوّر بالكامل - APPROVAL_INVALID", async () => {
    const client = await pool.connect();
    try {
      await expect(consumeApprovalGrant(client, {
        token: "totally-forged-token-does-not-exist", actionType: "ORDER_VOID", targetType: "order", targetId: "1", branchId,
      })).rejects.toMatchObject({ code: "APPROVAL_INVALID" });
    } finally {
      client.release();
    }
  });

  test("Replay: توكن مُستهلك قبل كده - مرفوض تاني", async () => {
    const client = await pool.connect();
    try {
      const grant = await issueApprovalGrant(client, {
        pin: "4321", branchId, actionType: "ORDER_VOID", targetType: "order", targetId: "555", requestedByUserId: null,
      });
      expect(grant.token).toBeTruthy();

      const first = await consumeApprovalGrant(client, {
        token: grant.token, actionType: "ORDER_VOID", targetType: "order", targetId: "555", branchId,
      });
      expect(first.grant.status).toBe("USED");

      await expect(consumeApprovalGrant(client, {
        token: grant.token, actionType: "ORDER_VOID", targetType: "order", targetId: "555", branchId,
      })).rejects.toMatchObject({ code: "APPROVAL_INVALID" });
    } finally {
      client.release();
    }
  });

  test("إجراء غلط: توكن صادر لـORDER_VOID مينفعش يُستخدم لـORDER_DISCOUNT", async () => {
    const client = await pool.connect();
    try {
      const grant = await issueApprovalGrant(client, {
        pin: "4321", branchId, actionType: "ORDER_VOID", targetType: "order", targetId: "556", requestedByUserId: null,
      });
      await expect(consumeApprovalGrant(client, {
        token: grant.token, actionType: "ORDER_DISCOUNT", targetType: "order", targetId: "556", branchId,
      })).rejects.toMatchObject({ code: "APPROVAL_INVALID" });
    } finally {
      client.release();
    }
  });

  test("هدف غلط: توكن صادر لطلب معيّن مينفعش يُستخدم لطلب تاني", async () => {
    const client = await pool.connect();
    try {
      const grant = await issueApprovalGrant(client, {
        pin: "4321", branchId, actionType: "ORDER_VOID", targetType: "order", targetId: "557", requestedByUserId: null,
      });
      await expect(consumeApprovalGrant(client, {
        token: grant.token, actionType: "ORDER_VOID", targetType: "order", targetId: "558", branchId,
      })).rejects.toMatchObject({ code: "APPROVAL_INVALID" });
    } finally {
      client.release();
    }
  });

  test("فرع غلط: توكن صادر لفرع معيّن مينفعش يُستهلك لفرع تاني", async () => {
    const client = await pool.connect();
    try {
      const grant = await issueApprovalGrant(client, {
        pin: "4321", branchId, actionType: "ORDER_VOID", targetType: "order", targetId: "559", requestedByUserId: null,
      });
      await expect(consumeApprovalGrant(client, {
        token: grant.token, actionType: "ORDER_VOID", targetType: "order", targetId: "559", branchId: otherBranchId,
      })).rejects.toMatchObject({ code: "APPROVAL_INVALID" });
    } finally {
      client.release();
    }
  });

  test("انتهاء الصلاحية: توكن expires_at في الماضي - مرفوض", async () => {
    const client = await pool.connect();
    try {
      const grant = await issueApprovalGrant(client, {
        pin: "4321", branchId, actionType: "ORDER_VOID", targetType: "order", targetId: "560", requestedByUserId: null,
      });
      await client.query("UPDATE approval_grants SET expires_at = now() - interval '1 minute' WHERE token = $1", [grant.token]);
      await expect(consumeApprovalGrant(client, {
        token: grant.token, actionType: "ORDER_VOID", targetType: "order", targetId: "560", branchId,
      })).rejects.toMatchObject({ code: "APPROVAL_INVALID" });
    } finally {
      client.release();
    }
  });

  test("تزامن حقيقي: 5 محاولات استهلاك متزامنة لنفس التوكن - واحدة بس تنجح (باقي القيود بريستريكت)", async () => {
    const issueClient = await pool.connect();
    let grant;
    try {
      grant = await issueApprovalGrant(issueClient, {
        pin: "4321", branchId, actionType: "ORDER_VOID", targetType: "order", targetId: "561", requestedByUserId: null,
      });
    } finally {
      issueClient.release();
    }
    expect(grant.token).toBeTruthy();

    const attempts = await Promise.all(
      Array.from({ length: 5 }).map(async () => {
        const client = await pool.connect();
        try {
          await consumeApprovalGrant(client, {
            token: grant.token, actionType: "ORDER_VOID", targetType: "order", targetId: "561", branchId,
          });
          return "OK";
        } catch (err) {
          return err.code || "ERROR";
        } finally {
          client.release();
        }
      })
    );
    const successes = attempts.filter((r) => r === "OK");
    expect(successes.length).toBe(1);
    expect(attempts.filter((r) => r === "APPROVAL_INVALID").length).toBe(4);

    const row = await pool.query("SELECT status FROM approval_grants WHERE token = $1", [grant.token]);
    expect(row.rows[0].status).toBe("USED");
  });
});

describe("approval_grants: هجوم عدائي حقيقي عبر HTTP (verify-override-pin -> void)", () => {
  test("هوية مدير مزوّرة (مش من verify-override-pin) - مرفوضة على طول عبر الـvoid endpoint", async () => {
    const orderId = await makeOrder();
    const res = await request(app).post(`/api/orders/${orderId}/void`).set(authed(cashierToken)).send({
      reason: "محاولة تزوير", approvalToken: "forged-" + require("crypto").randomBytes(24).toString("hex"),
    });
    expect(res.status).toBe(400);
  });

  test("Replay عبر HTTP: نفس approvalToken اتستخدم في إلغاء طلب، محاولة استخدامه تاني في طلب مختلف ترفض", async () => {
    const orderId1 = await makeOrder();
    const orderId2 = await makeOrder();

    const pinRes = await request(app).post("/api/auth/verify-override-pin").set(authed(cashierToken)).send({
      pin: "4321", branchId, actionType: "ORDER_VOID", targetType: "order", targetId: orderId1,
    });
    expect(pinRes.status).toBe(200);

    const first = await request(app).post(`/api/orders/${orderId1}/void`).set(authed(cashierToken)).send({
      reason: "طلب أول", approvalToken: pinRes.body.token,
    });
    expect(first.status).toBe(200);

    const replay = await request(app).post(`/api/orders/${orderId2}/void`).set(authed(cashierToken)).send({
      reason: "محاولة إعادة استخدام نفس التوكن على طلب تاني", approvalToken: pinRes.body.token,
    });
    expect(replay.status).toBe(400);
    const check = await pool.query("SELECT voided FROM orders WHERE id = $1", [orderId2]);
    expect(check.rows[0].voided).toBe(false);
  });

  test("توكن صادر لطلب معيّن مينفعش يُستخدم لإلغاء طلب تاني (حتى لو نفس الكاشير/نفس الفرع)", async () => {
    const orderId1 = await makeOrder();
    const orderId2 = await makeOrder();

    const pinRes = await request(app).post("/api/auth/verify-override-pin").set(authed(cashierToken)).send({
      pin: "4321", branchId, actionType: "ORDER_VOID", targetType: "order", targetId: orderId1,
    });
    expect(pinRes.status).toBe(200);

    const wrongTarget = await request(app).post(`/api/orders/${orderId2}/void`).set(authed(cashierToken)).send({
      reason: "استخدام توكن طلب تاني", approvalToken: pinRes.body.token,
    });
    expect(wrongTarget.status).toBe(400);
  });

  test("5 طلبات إلغاء متزامنة بنفس approvalToken (لطلب واحد) - واحدة بس تنجح فعليًا", async () => {
    const orderId = await makeOrder();
    const pinRes = await request(app).post("/api/auth/verify-override-pin").set(authed(cashierToken)).send({
      pin: "4321", branchId, actionType: "ORDER_VOID", targetType: "order", targetId: orderId,
    });
    expect(pinRes.status).toBe(200);

    const results = await Promise.all(
      Array.from({ length: 5 }).map(() =>
        request(app).post(`/api/orders/${orderId}/void`).set(authed(cashierToken)).send({
          reason: "محاولة متزامنة", approvalToken: pinRes.body.token,
        })
      )
    );
    const okCount = results.filter((r) => r.status === 200).length;
    expect(okCount).toBe(1);
    const check = await pool.query("SELECT voided FROM orders WHERE id = $1", [orderId]);
    expect(check.rows[0].voided).toBe(true);
  });
});
