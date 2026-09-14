// المرحلة 9A-4: قبل كده PATCH /api/hr/employees/:id {status:'terminated'} كان مجرد تحديث عمود عادي -
// مفيش أي أثر تاني خالص: حساب الدخول المرتبط (users.is_active) فاضل شغال (والتوكن الحالي بتاعه، لو
// عنده واحد، هيفضل شغال لحد ما ينتهي - 12 ساعة)، سجل السائق المرتبط (لو موجود) فاضل is_active=TRUE
// وقابل للتعيين لطلبات جديدة، ومفيش أي تحقق من أي حاجة معلّقة (شيفت شغال، كاش سائق لسه معاه، فرق
// تسوية لسه محتاج مراجعة، ذمم مديون بيها للشركة، راتب مستحق لسه ماتصرفش) قبل ما "الإنهاء" يتسجل.
//
// الحل هنا جزئين: (1) checkTerminationBlockers - بيرجّع كل حاجة معلّقة صراحة (مش بيخفيها) عشان اللي
// بينهي خدمة الموظف يشوفها ويقرر - القرار مش "امنع الإنهاء" (ممكن يكون فيه سبب حقيقي يستوجب إنهاء فوري
// حتى مع وجود معلّقات)، القرار "اعرضها بوضوح واطلب تأكيد صريح" (acknowledgeBlockers من الطالب) قبل ما
// ننفّذ - نفس فلسفة checklist إقفال يوم الفرع (9A-7) بالظبط بس هنا قابلة للتجاوز الواعي، مش قفل صارم.
// (2) applyTerminationCascade - التنفيذ الفعلي: تعطيل حساب الدخول المرتبط (يوقف كل التوكنات الحالية
// فورًا من الطلب اللي بعده مباشرة - middleware/auth.js من المرحلة 6C أصلًا بيقرأ is_active فريش من
// القاعدة في كل طلب، فمفيش داعي لأي آلية إبطال توكن منفصلة/blocklist/Redis)، وتعطيل سجل السائق المرتبط
// (لو موجود) عشان مايبقاش قابل للتعيين لطلبات جديدة. السجلات التاريخية (شيفتات قديمة، طلبات اتسلّمت،
// قيود محاسبية، تسويات سابقة) متتلمسش خالص - التعطيل بيمنع نشاط مستقبلي بس، مش بيمسح/يخفي حاجة فات.
async function checkTerminationBlockers(client, employee) {
  const blockers = [];

  if (employee.user_id) {
    const openShifts = await client.query(
      `SELECT id, status, opened_at FROM pos_shifts WHERE user_id = $1 AND status IN ('ACTIVE', 'PENDING_REVIEW')`,
      [employee.user_id]
    );
    if (openShifts.rows.length > 0) {
      blockers.push({
        code: "OPEN_SHIFT",
        message: `الموظف ده لسه عنده ${openShifts.rows.length} شيفت شغال أو محتاج مراجعة مدير`,
        shifts: openShifts.rows,
      });
    }
  }

  const employeeReceivableBalance = await client.query(
    `SELECT COALESCE(SUM(jel.debit) - SUM(jel.credit), 0) AS balance
     FROM journal_entry_lines jel
     JOIN journal_entries je ON je.id = jel.journal_entry_id
     JOIN accounts a ON a.id = jel.account_id
     WHERE a.code = $1 AND je.status <> 'DRAFT'`,
    [`1160-${employee.id}`]
  );
  const debtBalance = Number(employeeReceivableBalance.rows[0].balance);
  if (debtBalance > 0.005) {
    blockers.push({ code: "EMPLOYEE_DEBT", message: `الموظف ده لسه مديون للشركة بـ${debtBalance.toFixed(2)} ج.م`, amount: debtBalance });
  }

  const unpaidPayroll = await client.query(
    `SELECT pre.id, pre.net_pay, pr.year, pr.month,
            COALESCE((SELECT SUM(pp.amount) FROM payroll_payments pp WHERE pp.payroll_run_employee_id = pre.id), 0) AS paid
     FROM payroll_run_employees pre
     JOIN payroll_runs pr ON pr.id = pre.payroll_run_id
     WHERE pre.employee_id = $1 AND pr.status = 'APPROVED'`,
    [employee.id]
  );
  const unpaidRuns = unpaidPayroll.rows
    .map((r) => ({ ...r, remaining: Math.round((Number(r.net_pay) - Number(r.paid)) * 100) / 100 }))
    .filter((r) => r.remaining > 0.005);
  if (unpaidRuns.length > 0) {
    const total = unpaidRuns.reduce((s, r) => s + r.remaining, 0);
    blockers.push({
      code: "UNPAID_PAYROLL",
      message: `فيه ${unpaidRuns.length} تشغيلة راتب معتمدة لسه ماتصرفتش بالكامل للموظف ده (${total.toFixed(2)} ج.م متبقي)`,
      runs: unpaidRuns.map((r) => ({ year: r.year, month: r.month, remaining: r.remaining })),
    });
  }

  const driverRes = await client.query("SELECT * FROM drivers WHERE employee_id = $1", [employee.id]);
  const driver = driverRes.rows[0] || null;
  if (driver) {
    const activeAssignments = await client.query(
      `SELECT id, dispatch_status FROM orders WHERE driver_id = $1 AND dispatch_status IN ('ASSIGNED', 'OUT_FOR_DELIVERY')`,
      [driver.id]
    );
    if (activeAssignments.rows.length > 0) {
      blockers.push({
        code: "ACTIVE_DRIVER_ASSIGNMENT",
        message: `السائق المرتبط بالموظف ده لسه معاه ${activeAssignments.rows.length} طلب مُسند (معيّن أو في الطريق)`,
        orders: activeAssignments.rows,
      });
    }

    const custodyRes = await client.query(
      `SELECT o.id, o.collected_amount FROM orders o
       JOIN payment_methods pm ON pm.id = o.payment_method_id
       WHERE o.driver_id = $1 AND o.dispatch_status = 'DELIVERED' AND o.driver_settlement_id IS NULL AND pm.kind = 'cash'`,
      [driver.id]
    );
    const cashHeld = custodyRes.rows.reduce((s, r) => s + Number(r.collected_amount || 0), 0);
    if (cashHeld > 0.005) {
      blockers.push({
        code: "DRIVER_CASH_CUSTODY",
        message: `السائق المرتبط بالموظف ده لسه شايل ${cashHeld.toFixed(2)} ج.م كاش فرع من ${custodyRes.rows.length} طلب متسواش`,
        amount: cashHeld, pendingOrderCount: custodyRes.rows.length,
      });
    }

    const pendingSettlementReview = await client.query(
      `SELECT id, handover_variance FROM driver_settlements WHERE driver_id = $1 AND variance_status = 'PENDING_REVIEW'`,
      [driver.id]
    );
    if (pendingSettlementReview.rows.length > 0) {
      blockers.push({
        code: "PENDING_SETTLEMENT_REVIEW",
        message: `${pendingSettlementReview.rows.length} تسوية كاش للسائق ده لسه محتاجة مراجعة مدير/محاسب`,
        settlements: pendingSettlementReview.rows,
      });
    }
  }

  return { blockers, driver };
}

// بينفّذ التعطيل الفعلي بس - status='terminated' نفسه بيتسجل في نفس الـUPDATE اللي جوه routes/hr.js
// (مش هنا) عشان يفضل جزء واحد أتوميكي مع باقي منطق PATCH الموجود أصلًا (employee_history، audit log)
async function applyTerminationCascade(client, { employee, driver, actorUserId }) {
  const cascade = { userDisabled: false, driverDisabled: false };

  if (employee.user_id) {
    await client.query("UPDATE users SET is_active = FALSE WHERE id = $1", [employee.user_id]);
    cascade.userDisabled = true;
  }

  if (driver) {
    await client.query("UPDATE drivers SET is_active = FALSE, status = 'INACTIVE', updated_at = now() WHERE id = $1", [driver.id]);
    cascade.driverDisabled = true;
    cascade.driverId = driver.id;
  }

  return cascade;
}

module.exports = { checkTerminationBlockers, applyTerminationCascade };
