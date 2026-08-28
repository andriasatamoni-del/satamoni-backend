// طابور الطباعة: نقطة الدخول الوحيدة اللي أي route (orders.js/deliveries.js) بينادي عليها لإنشاء صفوف
// print_jobs. الفلسفة الأساسية (المفروض تتحافظ عليها في أي تعديل مستقبلي): الدوال هنا بتاخد نفس الـclient
// اللي جوه transaction الطلب نفسه (BEGIN...COMMIT في orders.js/deliveries.js) - يعني صفوف print_jobs
// بتتسجل بشكل ذري مع الطلب نفسه (نفس فلسفة "SAVE ORDER -> CREATE PRINT JOBS -> COMMIT ORDER" في
// المواصفة). لو التوجيه (محطة/طابعة) مش متظبط، السطر بيتسجل status='FAILED' فورًا بسبب واضح - مش استثناء
// بيوقف الطلب. الطباعة الفعلية بتحصل بعدين تمامًا خارج الـtransaction دي (Agent منفصل بيسحب PENDING من
// routes/print-jobs.js ويطبع فعليًا) - الملف ده مبيطبعش حاجة ولا بيلمس أي هاردوير خالص.
const {
  buildCustomerReceipt, buildKitchenTicket, buildKitchenSummary,
  buildDeliverySummary, buildDeliveryFinalReceipt, buildDineInBill, buildTestPrint,
} = require("./print-templates");

const ORDER_TYPE_LABELS = { delivery: "دليفري", takeaway: "تيك أواي", dinein: "صالة", talabat: "طلبات" };
const NO_PRINTER_ERROR = "لا يوجد طابعة موجّهة لهذا النوع/المحطة - راجع إعدادات الطباعة (Settings > الطباعة)";

async function loadOrderForPrint(client, orderId) {
  const r = await client.query(
    `SELECT o.*, pm.name AS payment_method_name, b.name AS branch_name
     FROM orders o
     LEFT JOIN payment_methods pm ON pm.id = o.payment_method_id
     LEFT JOIN branches b ON b.id = o.branch_id
     WHERE o.id = $1`,
    [orderId]
  );
  return r.rows[0] || null;
}

// نفس الـjoin بالظبط اللي GET /api/orders/:id وkds.js بيستخدموه لتفكيك مكوّنات الكومبو (combo_items ->
// menu_item_variants -> menu_items) - هنا زيادة واحدة بس: resolved_station_id لكل صنف مباشر ولكل مكوّن
// كومبو على حدة (item.station_id بيغلب category.station_id لو الاتنين متسجلين)
async function loadOrderItemsForPrint(client, orderId) {
  const itemsRes = await client.query(
    `SELECT oi.*, mi.name AS item_name, miv.label AS variant_label, c.name AS combo_name,
            COALESCE(mi.station_id, mc.station_id) AS resolved_station_id,
            CASE WHEN oi.combo_id IS NOT NULL THEN (
              SELECT json_agg(json_build_object(
                'name', cmi.name, 'variant', cv.label, 'quantity', ci.quantity * oi.quantity,
                'stationId', COALESCE(cmi.station_id, cmc.station_id)
              ) ORDER BY ci.id)
              FROM combo_items ci
              JOIN menu_item_variants cv ON cv.id = ci.variant_id
              JOIN menu_items cmi ON cmi.id = cv.item_id
              JOIN menu_categories cmc ON cmc.id = cmi.category_id
              WHERE ci.combo_id = oi.combo_id
            ) ELSE NULL END AS combo_components
     FROM order_items oi
     LEFT JOIN menu_item_variants miv ON miv.id = oi.variant_id
     LEFT JOIN menu_items mi ON mi.id = miv.item_id
     LEFT JOIN menu_categories mc ON mc.id = mi.category_id
     LEFT JOIN combos c ON c.id = oi.combo_id
     WHERE oi.order_id = $1
     ORDER BY oi.id`,
    [orderId]
  );
  const modsRes = await client.query(
    `SELECT oim.* FROM order_item_modifiers oim JOIN order_items oi ON oi.id = oim.order_item_id WHERE oi.order_id = $1`,
    [orderId]
  );
  const modsByItem = {};
  for (const m of modsRes.rows) {
    (modsByItem[m.order_item_id] = modsByItem[m.order_item_id] || []).push(m);
  }
  return itemsRes.rows.map((it) => ({ ...it, modifiers: modsByItem[it.id] || [] }));
}

// بتفكك الأصناف لمجموعات حسب محطة التحضير - أصناف مباشرة بمحطتها المحسوبة، ومكوّنات كومبو كل واحد
// بمحطته هو (مش محطة العرض ككل - عرض فيه بيتزا + مشروب لازم يوصل جزء البيتزا لمحطة البيتزا بس، مش
// المشروب معاه). المفتاح 0 يعني "مفيش محطة معروفة" - بتتجمع كلها في تذكرة واحدة FAILED واضحة بدل ما تضيع
function splitItemsByStation(items) {
  const buckets = new Map();
  const push = (stationId, row) => {
    const key = stationId || 0;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(row);
  };
  for (const it of items) {
    if (it.combo_id) {
      for (const comp of it.combo_components || []) {
        push(comp.stationId, { item_name: comp.name, variant_label: comp.variant, quantity: comp.quantity, modifiers: [] });
      }
    } else {
      push(it.resolved_station_id, {
        item_name: it.item_name, variant_label: it.variant_label, quantity: it.quantity, modifiers: it.modifiers,
      });
    }
  }
  return buckets;
}

async function loadBranchStations(client, branchId) {
  const r = await client.query(
    `SELECT ks.*, p.name AS printer_name FROM kitchen_stations ks
     LEFT JOIN printers p ON p.id = ks.printer_id
     WHERE ks.branch_id = $1 AND ks.is_active = TRUE`,
    [branchId]
  );
  const byId = new Map();
  for (const s of r.rows) byId.set(s.id, s);
  return byId;
}

async function resolvePrinterForType(client, branchId, printerType) {
  const r = await client.query(
    `SELECT * FROM printers WHERE branch_id = $1 AND printer_type = $2 AND is_enabled = TRUE
     ORDER BY is_default_for_type DESC, id ASC LIMIT 1`,
    [branchId, printerType]
  );
  return r.rows[0] || null;
}

async function insertPrintJob(client, {
  orderId, branchId, printType, printerId, stationId, contentHtml, idempotencyKey, createdBy, errorReason,
}) {
  const status = printerId ? "PENDING" : "FAILED";
  const lastError = printerId ? null : (errorReason || NO_PRINTER_ERROR);
  const inserted = await client.query(
    `INSERT INTO print_jobs
      (order_id, branch_id, print_type, printer_id, station_id, status, content_html, idempotency_key, created_by, failed_at, last_error)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, CASE WHEN $6 = 'FAILED' THEN now() ELSE NULL END, $10)
     ON CONFLICT (idempotency_key) DO NOTHING
     RETURNING *`,
    [orderId || null, branchId, printType, printerId || null, stationId || null, status, contentHtml, idempotencyKey, createdBy || null, lastError]
  );
  if (inserted.rows.length > 0) return inserted.rows[0];
  const existing = await client.query("SELECT * FROM print_jobs WHERE idempotency_key = $1", [idempotencyKey]);
  return existing.rows[0];
}

// بتطبع تذكرة لكل محطة ظهرت فعليًا في الطلب - بتنادى من التيك أواي/الدليفري وقت الإنشاء، ومن الصالة
// وقت ما kitchen_status توصل PREPARING (مواصفة قسم 4/5/6 بالظبط)
async function queueKitchenTicketsByStation(client, { orderId, branchId, order, orderTypeLabel, items, createdBy }) {
  const buckets = splitItemsByStation(items);
  const stations = await loadBranchStations(client, branchId);
  const jobs = [];
  for (const [stationKey, stationItems] of buckets) {
    const station = stationKey ? stations.get(stationKey) : null;
    const printerId = station ? station.printer_id : null;
    const html = buildKitchenTicket({
      order, items: stationItems, stationName: station ? station.name : "غير محدد", branchLabel: order.branch_name, orderTypeLabel,
    });
    const job = await insertPrintJob(client, {
      orderId, branchId, printType: "KITCHEN_TICKET", printerId, stationId: station ? station.id : null,
      contentHtml: html, idempotencyKey: `order:${orderId}:type:KITCHEN_TICKET:station:${stationKey}`,
      createdBy,
      errorReason: station ? undefined : "الأصناف دي مش مربوطة بأي محطة تحضير - اربط الصنف/القسم بمحطة من إعدادات الطباعة",
    });
    jobs.push(job);
  }
  return jobs;
}

// المرحلة 9 (نظام الطباعة): تيك أواي/دليفري - عند إنشاء الطلب فورًا (نفس لحظة تأكيد الطلب)
async function queueOrderCreationPrintJobs(client, { orderId, createdBy }) {
  const order = await loadOrderForPrint(client, orderId);
  if (!order) return [];
  const items = await loadOrderItemsForPrint(client, orderId);
  const orderTypeLabel = ORDER_TYPE_LABELS[order.order_type] || order.order_type;
  const jobs = [];

  if (order.order_type === "takeaway") {
    const cashierPrinter = await resolvePrinterForType(client, order.branch_id, "CASHIER");
    jobs.push(await insertPrintJob(client, {
      orderId, branchId: order.branch_id, printType: "CUSTOMER_RECEIPT", printerId: cashierPrinter?.id,
      contentHtml: buildCustomerReceipt({ order, items, paymentMethodLabel: order.payment_method_name, branchLabel: order.branch_name, orderTypeLabel }),
      idempotencyKey: `order:${orderId}:type:CUSTOMER_RECEIPT`, createdBy,
    }));

    const kitchenPrinter = await resolvePrinterForType(client, order.branch_id, "KITCHEN");
    jobs.push(await insertPrintJob(client, {
      orderId, branchId: order.branch_id, printType: "KITCHEN_SUMMARY", printerId: kitchenPrinter?.id,
      contentHtml: buildKitchenSummary({ order, items, branchLabel: order.branch_name, orderTypeLabel }),
      idempotencyKey: `order:${orderId}:type:KITCHEN_SUMMARY`, createdBy,
    }));

    jobs.push(...await queueKitchenTicketsByStation(client, { orderId, branchId: order.branch_id, order, orderTypeLabel, items, createdBy }));
  } else if (order.order_type === "delivery") {
    const deliveryPrinter = await resolvePrinterForType(client, order.branch_id, "DELIVERY");
    jobs.push(await insertPrintJob(client, {
      orderId, branchId: order.branch_id, printType: "DELIVERY_SUMMARY", printerId: deliveryPrinter?.id,
      contentHtml: buildDeliverySummary({ order, items, branchLabel: order.branch_name }),
      idempotencyKey: `order:${orderId}:type:DELIVERY_SUMMARY`, createdBy,
    }));

    jobs.push(...await queueKitchenTicketsByStation(client, { orderId, branchId: order.branch_id, order, orderTypeLabel, items, createdBy }));
  }
  // dinein: مفيش طباعة عند الإنشاء خالص - تذاكر المطبخ بتتطبع لما المطبخ يقدّم الطلب لـPREPARING فعليًا
  // (queueDineInPreparingPrintJobs تحت)، والفاتورة بتتطبع بطلب الجرسون (queueDineInBillPrintJob)

  return jobs;
}

// دليفري - وقت تسليم الطلب فعليًا للسائق (dispatch_status -> OUT_FOR_DELIVERY) - إيصال نهائي فيه سعر
// هو اللي هيتسلّم للعميل لحظة التوصيل
async function queueDeliveryHandoverPrintJobs(client, { orderId, createdBy }) {
  const order = await loadOrderForPrint(client, orderId);
  if (!order) return [];
  const items = await loadOrderItemsForPrint(client, orderId);
  const printer = await resolvePrinterForType(client, order.branch_id, "DELIVERY");
  const job = await insertPrintJob(client, {
    orderId, branchId: order.branch_id, printType: "DELIVERY_FINAL_RECEIPT", printerId: printer?.id,
    contentHtml: buildDeliveryFinalReceipt({ order, items, paymentMethodLabel: order.payment_method_name, branchLabel: order.branch_name }),
    idempotencyKey: `order:${orderId}:type:DELIVERY_FINAL_RECEIPT`, createdBy,
  });
  return [job];
}

// صالة - وقت ما المطبخ يقدّم حالة الطلب لـPREPARING (نفس نقطة PATCH /:id/kitchen-status الموجودة أصلًا) -
// تذاكر مطبخ بس، من غير ملخص أو إيصال (مطابقة صريحة لقسم 6 في المواصفة)
async function queueDineInPreparingPrintJobs(client, { orderId, createdBy }) {
  const order = await loadOrderForPrint(client, orderId);
  if (!order || order.order_type !== "dinein") return [];
  const items = await loadOrderItemsForPrint(client, orderId);
  const orderTypeLabel = ORDER_TYPE_LABELS[order.order_type];
  return queueKitchenTicketsByStation(client, { orderId, branchId: order.branch_id, order, orderTypeLabel, items, createdBy });
}

// صالة - فاتورة بطلب الجرسون، أي وقت قبل التحصيل. مفتاح الـidempotency ثابت لكل طلب (من غير أي جزء
// متغيّر زي وقت الطلب) عمدًا - عشان "مفيش فاتورة مكررة" فعليًا: أي ضغطة تانية على الزرار قبل ما الطلب
// يتلغي/يتقفل بترجع نفس صف print_jobs الموجود بدل ما تنشئ واحد جديد
async function queueDineInBillPrintJob(client, { orderId, createdBy }) {
  const order = await loadOrderForPrint(client, orderId);
  if (!order) return null;
  const items = await loadOrderItemsForPrint(client, orderId);
  const printer = await resolvePrinterForType(client, order.branch_id, "CASHIER");
  return insertPrintJob(client, {
    orderId, branchId: order.branch_id, printType: "DINE_IN_BILL", printerId: printer?.id,
    contentHtml: buildDineInBill({ order, items, branchLabel: order.branch_name }),
    idempotencyKey: `order:${orderId}:type:DINE_IN_BILL`, createdBy,
  });
}

// طباعة تجريبية من شاشة إدارة الطابعات - مش مرتبطة بطلب حقيقي، ومسموح تتكرر بحرية (كل ضغطة زر لها
// idempotency_key فريد بالوقت - عكس باقي الأنواع عمدًا، لأن هنا التكرار مطلوب مش عيب)
async function queueTestPrintJob(client, { printer, createdBy }) {
  return insertPrintJob(client, {
    orderId: null, branchId: printer.branch_id, printType: "TEST_PRINT", printerId: printer.id,
    contentHtml: buildTestPrint({ printerName: printer.name, branchLabel: printer.branch_name }),
    idempotencyKey: `printer:${printer.id}:test:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
    createdBy,
  });
}

module.exports = {
  ORDER_TYPE_LABELS,
  queueOrderCreationPrintJobs,
  queueDeliveryHandoverPrintJobs,
  queueDineInPreparingPrintJobs,
  queueDineInBillPrintJob,
  queueTestPrintJob,
  resolvePrinterForType,
};
