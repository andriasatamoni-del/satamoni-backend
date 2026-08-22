// المرحلة 6 (6C): تدقيق موثوقية المصادقة/الجلسة - الموديل الحالي (JWT صالح 12 ساعة، من غير أي إلغاء
// من طرف السيرفر) اتقيّم: مقبول لـERP داخلي بشرط إن تعطيل حساب موظف يبقى له أثر فوري، مش لازم
// يستنى انتهاء التوكن - وده الفجوة الحقيقية اللي كانت موجودة واتصلحت في middleware/auth.js (requireAuth
// بقى بيقرا is_active/role/branchId فريش من قاعدة البيانات في كل طلب، مش من التوكن القديم).
// "تسجيل الخروج" في الموديل ده client-side بس بتصميم (زي أي نظام JWT بدون حالة) - مقبول هنا لأن
// الفجوة الفعلية الخطيرة (موظف معطّل/منتهي خدمته لسه شغال بتوكن قديم) اتقفلت؛ إضافة إلغاء فوري لكل
// الأجهزة (logout-everywhere / token blocklist) محتاجة بنية تحتية جديدة (جدول/Redis) مش مبررة هنا
// كـ"أبسط آلية آمنة" لمخاطر ERP داخلي - موثّق كقرار واعي مش سهو.
const jwt = require("jsonwebtoken");
const { app, request, pool, seedUser, login, authed } = require("./helpers");

afterAll(async () => {
  await pool.end();
});

describe("6C: موظف معطّل الحساب (is_active=false) - أي توكن قديم بتاعه يترفض فورًا، مش لازم يستنى انتهاءه", () => {
  test("توكن صادر وقت الحساب كان نشط - بعد تعطيل الحساب، نفس التوكن يترفض على طول (401) من غير ما ننتظر انتهاءه", async () => {
    await seedUser({ name: "موظف-م6-تعطيل", email: "deactivate-p6@jest.test", role: "cashier", password: "test12345" });
    const token = await login("deactivate-p6@jest.test");

    // قبل التعطيل - التوكن شغال عادي
    const before = await request(app).get("/api/auth/me").set(authed(token));
    expect(before.status).toBe(200);

    await pool.query("UPDATE users SET is_active = FALSE WHERE email = $1", ["deactivate-p6@jest.test"]);

    // نفس التوكن بالظبط، من غير ما ينتهي أو نسجل خروج - المفروض يترفض دلوقتي
    const after = await request(app).get("/api/auth/me").set(authed(token));
    expect(after.status).toBe(401);
  });

  test("موظف اتعطّل، بيحاول يستخدم توكنه القديم في endpoint حساس (تسجيل بيع) - يترفض 401 مش يكمّل العملية", async () => {
    const branch = await pool.query("INSERT INTO branches (name) VALUES ('فرع-م6-تعطيل-جست') RETURNING id");
    const branchId = branch.rows[0].id;
    await seedUser({ branchId, name: "كاشير-م6-تعطيل", email: "deactivate-order-p6@jest.test", role: "cashier", password: "test12345" });
    const token = await login("deactivate-order-p6@jest.test");
    await pool.query("UPDATE users SET is_active = FALSE WHERE email = $1", ["deactivate-order-p6@jest.test"]);

    const res = await request(app).post("/api/orders").set(authed(token)).send({
      branchId, source: "pos", orderType: "takeaway", items: [],
    });
    expect(res.status).toBe(401);
  });
});

// ملاحظة: جربنا نص اختبار "مستخدم اتمسح تمامًا (DELETE) بعد إصدار توكنه" - القاعدة نفسها بترفض
// العملية (audit_logs.user_id مربوط بـFK على users، وده يمنع حذف أي مستخدم ليه سجل تدقيق - قرار
// تصميمي موجود بالفعل ومتّسق مع فلسفة "مفيش حذف صامت" في المشروع كله). يعني مسار "حذف مستخدم
// بالكامل" مش قابل للوصول فعليًا من غير ما تتصادم مع القيد ده أولًا - is_active=false (فوق) هي
// الطريقة الحقيقية الوحيدة لإنهاء وصول موظف، وده اللي اتغطى بالاختبارات فوق. الفحص الدفاعي
// (`if (!user...)`) في requireAuth فاضل كطبقة أمان إضافية من غير اختبار مخصص له.

describe("6C: تغيير الدور/الفرع بعد إصدار التوكن - الصلاحية الفعلية بتتقرا فريش من القاعدة، مش من التوكن القديم", () => {
  test("موظف اتصعّد من cashier لـbranch_manager بعد إصدار التوكن - نفس التوكن بيدّي الصلاحية الجديدة فورًا من غير تسجيل دخول تاني", async () => {
    const branch = await pool.query("INSERT INTO branches (name) VALUES ('فرع-م6-ترقية-جست') RETURNING id");
    const branchId = branch.rows[0].id;
    await seedUser({ branchId, name: "كاشير-م6-ترقية", email: "promote-p6@jest.test", role: "cashier", password: "test12345" });
    const token = await login("promote-p6@jest.test");

    const beforePromotion = await request(app).get("/api/auth/me").set(authed(token));
    expect(beforePromotion.body.role).toBe("cashier");

    await pool.query("UPDATE users SET role = 'branch_manager' WHERE email = $1", ["promote-p6@jest.test"]);

    const afterPromotion = await request(app).get("/api/auth/me").set(authed(token));
    expect(afterPromotion.status).toBe(200);
    expect(afterPromotion.body.role).toBe("branch_manager"); // فريش من القاعدة - مش الدور القديم المخزّن في التوكن
  });
});

describe("6C: توكن منتهي الصلاحية - يترفض (سلوك موجود بالفعل، اختبار قفل عليه)", () => {
  test("توكن بتاريخ إصدار وانتهاء في الماضي - يترفض 401 برسالة واضحة", async () => {
    const userId = await seedUser({ name: "موظف-م6-انتهاء", email: "expired-p6@jest.test", role: "cashier", password: "test12345" });
    const expiredToken = jwt.sign(
      { sub: userId, name: "موظف-م6-انتهاء", email: "expired-p6@jest.test", role: "cashier", branchId: null },
      process.env.JWT_SECRET,
      { expiresIn: -10 } // بالفعل منتهي من 10 ثواني
    );
    const res = await request(app).get("/api/auth/me").set(authed(expiredToken));
    expect(res.status).toBe(401);
    expect(res.body.error).toContain("منتهي");
  });
});

describe("6C: تسجيل الخروج (logout) - client-side بتصميم في موديل JWT بدون حالة (موثّق كقرار واعي)", () => {
  test("توكن حساب لسه نشط وسليم - يفضل شغال طول مدة صلاحيته (مفيش آلية إلغاء فوري لكل الأجهزة - مقبول لERP داخلي)", async () => {
    await seedUser({ name: "موظف-م6-خروج", email: "logout-p6@jest.test", role: "cashier", password: "test12345" });
    const token = await login("logout-p6@jest.test");
    // "تسجيل الخروج" في الفرونت إند بيمسح التوكن من localStorage بس (client-side) - من ناحية
    // السيرفر، التوكن نفسه (لو استخدمه حد تاني قبل ما ينتهي) لسه صالح تقنيًا طالما الحساب نشط.
    // ده سلوك متوقع في أي نظام JWT بدون حالة، ومقبول هنا لأن الفجوة الخطيرة الفعلية (موظف معطّل/
    // منتهي خدمته) اتقفلت فوق - إضافة إلغاء فوري محتاجة بنية تحتية (blocklist) مش مبررة كـ"أبسط
    // آلية آمنة" لمخاطر ERP داخلي.
    const res = await request(app).get("/api/auth/me").set(authed(token));
    expect(res.status).toBe(200);
  });
});
