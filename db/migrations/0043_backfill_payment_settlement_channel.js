// Payment Control: قناة التسوية (settlement_channel) اتضافت لواجهة إدارة طرق الدفع بعد ما فروع حقيقية
// كانت أصلًا بتسجّل طلبات فيزا/محفظة/إنستاباي - يعني payments.settlement_channel (نسخة مجمّدة وقت
// القفل) اتسجّلت NULL لكل الطلبات دي، حتى بعد ما الأدمن يظبط القناة على طريقة الدفع نفسها بعد كده.
// ده بيمنع فحوص المطابقة (تسوية فيزا/إنستاباي/أورانج كاش) من شوفة أي طلب قديم خالص. الترحيل ده بيعمل
// نسخ لمرة واحدة من settlement_channel الحالي بتاع طريقة الدفع لأي دفعة لسه NULL - مش بيلمس دفعة
// اتحدد لها قناة بالفعل (نفس فلسفة "نسخة مجمّدة" - بيكمّل الفجوة، مش بيغيّر تاريخ موجود). نفس المنطق
// متاح كمان عند الطلب من routes/payment-control.js (POST /backfill-settlement-channels) لأي حالة
// مشابهة تحصل مستقبلًا (طريقة دفع جديدة اتضافت قناتها بعد ما طلبات اتسجلت عليها بالفعل).
module.exports = {
  async up(client) {
    await client.query(`
      UPDATE payments p
      SET settlement_channel = pm.settlement_channel
      FROM payment_methods pm
      WHERE p.payment_method_id = pm.id
        AND p.method_kind = 'card_or_wallet'
        AND p.settlement_channel IS NULL
        AND pm.settlement_channel IS NOT NULL
    `);
  },
};
