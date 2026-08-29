// MASTER MISSION - PART 26 (أداء): kitchen_orders (طلبيات الفروع) كانت من غير أي index غير الـPKey -
// جدول بيكبر يوميًا (كل طلبية فرع لكل يوم)، وبيتفلتر عليه بالمساواة على branch_id وstatus في كذا مكان
// فعليًا (routes/kitchen-orders.js GET / list, picking) وكمان في محرك التخطيط الجديد
// (db/production-planning.js: approvedDemandByItem/pendingSubmittedDemandByItem). إضافة بس، مفيش أي
// تعديل على بيانات أو منطق - آمنة التكرار (IF NOT EXISTS) زي كل migration سابق في المشروع.
module.exports = {
  async up(client) {
    await client.query(`CREATE INDEX IF NOT EXISTS idx_kitchen_orders_branch ON kitchen_orders(branch_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_kitchen_orders_status ON kitchen_orders(status)`);
  },
};
