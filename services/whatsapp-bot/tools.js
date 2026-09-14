// المرحلة 8.43: الأدوات اللي الذكاء الاصطناعي بيقدر يستخدمها عشان يرد على عملاء واتساب بمعلومات
// حقيقية من قاعدة البيانات (مش من عنده) وياخد إجراءات فعلية (تسجيل مسودة أوردر، تسجيل شكوى).
// كل أداة بترجع نص (مش JSON خام مركّب) عشان الموديل يقدر يقراه ويصيغ رد طبيعي بيه - مفيش أي أداة هنا
// بتلمس جدول orders الحقيقي مباشرة أو تأثر على مخزون/محاسبة (راجع db/schema.sql لتفسير القرار).
const pool = require("../../db/pool");
const { sendMessage } = require("../../db/whatsapp-client");

const TOOL_DEFINITIONS = [
  {
    name: "get_menu",
    description: "هات المنيو النشط الحالي (الأقسام، الأصناف، الأحجام والأسعار، والإضافات المتاحة). استخدمها قبل أي رد عن أصناف/أسعار.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "get_offers",
    description: "هات العروض/الكومبوهات النشطة حاليًا بأسعارها.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "get_business_info",
    description: "هات بيانات الفروع (الاسم، العنوان، رقم التليفون، مواعيد الشغل).",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "list_delivery_areas",
    description: "هات قايمة مناطق التوصيل المتاحة مع رسوم التوصيل والحد الأدنى للطلب ووقت التوصيل التقريبي لكل منطقة.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "lookup_recent_orders",
    description: "هات آخر 5 طلبات لنفس رقم العميل اللي بيكلم دلوقتي مع حالتها الحالية.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "save_draft_order",
    description:
      "سجّل/حدّث مسودة الأوردر الحالي بناءً على كلام العميل. استخدمها كل ما تعرف تفصيلة جديدة (أصناف، عنوان، اسم، نوع الطلب). بترجع ملخص بالسعر الصحيح من المنيو الحقيقي، أو توضح أي صنف/منطقة مش واضحة.",
    input_schema: {
      type: "object",
      properties: {
        orderType: { type: "string", enum: ["delivery", "takeaway"], description: "توصيل أو استلام من الفرع" },
        items: {
          type: "array",
          description: "قايمة الأصناف المطلوبة (استبدل القايمة بالكامل بكل التفاصيل المعروفة لحد دلوقتي، مش بس الجديد)",
          items: {
            type: "object",
            properties: {
              itemName: { type: "string" },
              variantLabel: { type: "string", description: "الحجم (وسط/كبير...) - لو الصنف له حجم واحد بس ممكن تسيبها فاضية" },
              quantity: { type: "integer", minimum: 1 },
              modifierNames: { type: "array", items: { type: "string" } },
              notes: { type: "string" },
            },
            required: ["itemName", "quantity"],
          },
        },
        customerName: { type: "string" },
        branchName: { type: "string", description: "اسم الفرع - مطلوب لطلبات الاستلام، أو لو المنطقة مش واضحة" },
        areaName: { type: "string", description: "اسم منطقة التوصيل اللي العميل قالها" },
        addressDetails: { type: "string", description: "تفاصيل العنوان (شارع/عمارة/دور/شقة)" },
        distinguishingMark: { type: "string", description: "علامة مميزة تساعد التوصيل" },
      },
      required: [],
    },
  },
  {
    name: "submit_pending_order",
    description: "أرسل مسودة الأوردر الحالية للفريق للمراجعة والتأكيد النهائي. استخدمها بس بعد ما العميل يأكد صراحة إنه عايز يبعت الأوردر.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "log_complaint",
    description: "سجّل شكوى العميل فورًا عشان فريق حقيقي يتابعها.",
    input_schema: {
      type: "object",
      properties: {
        category: { type: "string", enum: ["late_order", "wrong_item", "quality", "other"] },
        description: { type: "string" },
        orderId: { type: "integer", description: "رقم الطلب لو العميل ذكره، غير كده متبعتوش" },
      },
      required: ["category", "description"],
    },
  },
];

function money(n) {
  return `${Number(n).toFixed(2)} ج.م`;
}

async function getMenu() {
  const result = await pool.query(`
    SELECT mi.name, mi.is_best, mc.name AS category, mc.display_order,
           json_agg(jsonb_build_object('label', v.label, 'price', v.price) ORDER BY v.id) FILTER (WHERE v.id IS NOT NULL) AS variants,
           COALESCE(
             (SELECT json_agg(jsonb_build_object('name', m.name, 'priceDelta', m.price_delta) ORDER BY m.id)
              FROM menu_item_modifiers m WHERE m.item_id = mi.id AND m.is_active = TRUE),
             '[]'
           ) AS modifiers
    FROM menu_items mi
    JOIN menu_categories mc ON mc.id = mi.category_id
    JOIN menu_item_variants v ON v.item_id = mi.id
    WHERE mi.is_active = TRUE AND mc.menu_group = 'regular'
    GROUP BY mi.id, mc.name, mc.display_order
    ORDER BY mc.display_order, mi.name
  `);
  if (result.rows.length === 0) return "المنيو فاضي حاليًا - مفيش أصناف نشطة.";

  const byCategory = {};
  for (const row of result.rows) {
    byCategory[row.category] = byCategory[row.category] || [];
    const variants = (row.variants || []).map((v) => `${v.label}: ${money(v.price)}`).join("، ");
    const modifiers = (row.modifiers || []).map((m) => `${m.name} (${m.priceDelta > 0 ? "+" : ""}${money(m.priceDelta)})`).join("، ");
    let line = `- ${row.name}${row.is_best ? " ⭐" : ""}: ${variants}`;
    if (modifiers) line += `\n  إضافات: ${modifiers}`;
    byCategory[row.category].push(line);
  }
  return Object.entries(byCategory)
    .map(([cat, lines]) => `## ${cat}\n${lines.join("\n")}`)
    .join("\n\n");
}

async function getOffers() {
  const result = await pool.query(`
    SELECT c.name, c.price, json_agg(jsonb_build_object('itemName', mi.name, 'variant', v.label, 'quantity', ci.quantity)) AS items
    FROM combos c
    JOIN combo_items ci ON ci.combo_id = c.id
    JOIN menu_item_variants v ON v.id = ci.variant_id
    JOIN menu_items mi ON mi.id = v.item_id
    WHERE c.is_active = TRUE
    GROUP BY c.id
    ORDER BY c.id
  `);
  if (result.rows.length === 0) return "مفيش عروض نشطة حاليًا.";
  return result.rows
    .map((c) => `- ${c.name}: ${money(c.price)} (${c.items.map((i) => `${i.quantity}× ${i.itemName} ${i.variant}`).join(" + ")})`)
    .join("\n");
}

async function getBusinessInfo() {
  const result = await pool.query("SELECT name, address, phone, hours FROM branches ORDER BY id");
  if (result.rows.length === 0) return "مفيش بيانات فروع مسجلة.";
  return result.rows
    .map((b) => `- ${b.name}: ${b.address || "بدون عنوان مسجل"} - تليفون: ${b.phone || "-"} - المواعيد: ${b.hours || "غير محددة"}`)
    .join("\n");
}

async function listDeliveryAreas() {
  const result = await pool.query(`
    SELECT da.name AS area, da.fee, da.min_order, da.eta_minutes, b.name AS branch
    FROM delivery_areas da
    LEFT JOIN branches b ON b.id = da.branch_id
    ORDER BY b.name NULLS LAST, da.name
  `);
  if (result.rows.length === 0) return "مفيش مناطق توصيل مسجلة.";
  return result.rows
    .map((a) => `- ${a.area} (فرع ${a.branch || "غير محدد"}): رسوم توصيل ${money(a.fee)}، حد أدنى للطلب ${money(a.min_order)}، وقت متوقع ${a.eta_minutes} دقيقة`)
    .join("\n");
}

async function lookupRecentOrders(phone) {
  const result = await pool.query(
    `SELECT id, order_type, status, total, created_at FROM orders
     WHERE customer_phone = $1 ORDER BY created_at DESC LIMIT 5`,
    [phone]
  );
  if (result.rows.length === 0) return "مفيش طلبات سابقة مسجلة على الرقم ده.";
  const STATUS_AR = { preparing: "تحت التحضير", out_for_delivery: "في الطريق", completed: "اتسلم/خلص", cancelled: "اتلغى" };
  return result.rows
    .map((o) => `- طلب #${o.id} (${o.order_type === "delivery" ? "توصيل" : "استلام"}): ${STATUS_AR[o.status] || o.status} - ${money(o.total)} - ${new Date(o.created_at).toLocaleString("ar-EG")}`)
    .join("\n");
}

// بيدوّر على صنف حقيقي في المنيو النشط بالاسم (مطابقة تامة الأول، وبعدين احتواء جزئي) - العميل مبيقدرش
// "يخترع" صنف مش موجود، ولو الاسم غامض بيرجع مرشحين عشان الموديل يسأل العميل يحدد
async function resolveMenuItem(client, itemName, variantLabel) {
  const items = await client.query(
    `SELECT mi.id, mi.name FROM menu_items mi WHERE mi.is_active = TRUE
     AND (lower(mi.name) = lower($1) OR mi.name ILIKE '%' || $1 || '%')
     ORDER BY (lower(mi.name) = lower($1)) DESC LIMIT 5`,
    [itemName]
  );
  if (items.rows.length === 0) return { error: `مفيش صنف اسمه "${itemName}" في المنيو الحالي.` };
  if (items.rows.length > 1) {
    return { error: `فيه أكتر من صنف قريب من "${itemName}": ${items.rows.map((r) => r.name).join("، ")} - حدد أنهي واحد بالظبط.` };
  }
  const item = items.rows[0];

  const variants = await client.query("SELECT id, label, price FROM menu_item_variants WHERE item_id = $1 ORDER BY id", [item.id]);
  if (variants.rows.length === 0) return { error: `الصنف "${item.name}" مالوش أي حجم متاح حاليًا.` };

  let variant;
  if (variants.rows.length === 1) {
    variant = variants.rows[0];
  } else if (variantLabel) {
    variant = variants.rows.find((v) => v.label.toLowerCase() === variantLabel.toLowerCase())
      || variants.rows.find((v) => v.label.includes(variantLabel) || variantLabel.includes(v.label));
    if (!variant) {
      return { error: `الصنف "${item.name}" أحجامه: ${variants.rows.map((v) => v.label).join("، ")} - أنهي حجم بالظبط؟` };
    }
  } else {
    return { error: `الصنف "${item.name}" أحجامه: ${variants.rows.map((v) => v.label).join("، ")} - أنهي حجم؟` };
  }

  return { itemId: item.id, itemName: item.name, variantId: variant.id, variantLabel: variant.label, basePrice: Number(variant.price) };
}

async function resolveModifiers(client, itemId, variantId, modifierNames) {
  const resolved = [];
  for (const name of modifierNames || []) {
    const rows = await client.query(
      `SELECT m.id, m.name, COALESCE(vp.price_delta, m.price_delta) AS price_delta
       FROM menu_item_modifiers m
       LEFT JOIN menu_item_modifier_variant_prices vp ON vp.modifier_id = m.id AND vp.variant_id = $3
       WHERE m.item_id = $1 AND m.is_active = TRUE AND (lower(m.name) = lower($2) OR m.name ILIKE '%' || $2 || '%')
       ORDER BY (lower(m.name) = lower($2)) DESC LIMIT 1`,
      [itemId, name, variantId]
    );
    if (rows.rows.length === 0) return { error: `مفيش إضافة اسمها "${name}" للصنف ده.` };
    resolved.push({ id: rows.rows[0].id, name: rows.rows[0].name, priceDelta: Number(rows.rows[0].price_delta) });
  }
  return { resolved };
}

async function saveDraftOrder(input, ctx) {
  const client = await pool.connect();
  try {
    const existing = await client.query(
      "SELECT * FROM whatsapp_pending_orders WHERE conversation_id = $1 AND status = 'draft'",
      [ctx.conversationId]
    );
    const draft = existing.rows[0] || null;

    let resolvedItems = draft?.items || [];
    if (Array.isArray(input.items)) {
      resolvedItems = [];
      for (const rawItem of input.items) {
        const match = await resolveMenuItem(client, rawItem.itemName, rawItem.variantLabel);
        if (match.error) return match.error;
        const modResult = await resolveModifiers(client, match.itemId, match.variantId, rawItem.modifierNames);
        if (modResult.error) return modResult.error;
        const modifierTotal = modResult.resolved.reduce((s, m) => s + m.priceDelta, 0);
        const unitPrice = match.basePrice + modifierTotal;
        const quantity = Number(rawItem.quantity) || 1;
        resolvedItems.push({
          itemId: match.itemId, itemName: match.itemName, variantId: match.variantId, variantLabel: match.variantLabel,
          quantity, modifiers: modResult.resolved, notes: rawItem.notes || null,
          unitPrice, lineTotal: unitPrice * quantity,
        });
      }
    }

    let branchId = draft?.branch_id || null;
    if (input.branchName) {
      const branchRow = await client.query("SELECT id, name FROM branches WHERE name ILIKE '%' || $1 || '%' LIMIT 1", [input.branchName]);
      if (branchRow.rows.length === 0) return `مفيش فرع اسمه "${input.branchName}" - الفروع المتاحة اتاكد منها بأداة get_business_info.`;
      branchId = branchRow.rows[0].id;
    }

    let deliveryAreaId = draft?.delivery_area_id || null;
    let deliveryFee = Number(draft?.delivery_fee || 0);
    if (input.areaName) {
      const areaRow = await client.query(
        "SELECT id, fee, branch_id FROM delivery_areas WHERE name ILIKE '%' || $1 || '%' ORDER BY id LIMIT 1",
        [input.areaName]
      );
      if (areaRow.rows.length === 0) return `مفيش منطقة توصيل اسمها "${input.areaName}" - اسأل العميل يوصف منطقته بشكل تاني، أو اتاكد بأداة list_delivery_areas.`;
      deliveryAreaId = areaRow.rows[0].id;
      deliveryFee = Number(areaRow.rows[0].fee);
      if (areaRow.rows[0].branch_id) branchId = areaRow.rows[0].branch_id;
    }

    const orderType = input.orderType || draft?.order_type || "delivery";
    const customerName = input.customerName || draft?.customer_name || ctx.customerName || null;
    const addressDetails = input.addressDetails || draft?.address_details || null;
    const distinguishingMark = input.distinguishingMark || draft?.distinguishing_mark || null;

    const subtotal = resolvedItems.reduce((s, it) => s + it.lineTotal, 0);
    const total = subtotal + (orderType === "delivery" ? deliveryFee : 0);

    await client.query(
      `INSERT INTO whatsapp_pending_orders
         (conversation_id, customer_phone, customer_name, order_type, branch_id, delivery_area_id,
          address_details, distinguishing_mark, items, subtotal, delivery_fee, total, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'draft')
       ON CONFLICT (conversation_id) WHERE status = 'draft'
       DO UPDATE SET customer_name = $3, order_type = $4, branch_id = $5, delivery_area_id = $6,
         address_details = $7, distinguishing_mark = $8, items = $9, subtotal = $10, delivery_fee = $11,
         total = $12, updated_at = now()`,
      [ctx.conversationId, ctx.phone, customerName, orderType, branchId, deliveryAreaId,
        addressDetails, distinguishingMark, JSON.stringify(resolvedItems), subtotal, deliveryFee, total]
    );

    if (resolvedItems.length === 0) return "لسه مفيش أصناف في الأوردر - اسأل العميل عايز ياخد ايه.";

    const itemsSummary = resolvedItems
      .map((it) => `${it.quantity}× ${it.itemName} (${it.variantLabel})${it.modifiers.length ? " + " + it.modifiers.map((m) => m.name).join("، ") : ""} = ${money(it.lineTotal)}`)
      .join("\n");
    const missing = [];
    if (orderType === "delivery" && !deliveryAreaId) missing.push("منطقة التوصيل");
    if (orderType === "delivery" && !addressDetails) missing.push("تفاصيل العنوان");
    if (!customerName) missing.push("اسم العميل");
    if (orderType === "takeaway" && !branchId) missing.push("الفرع اللي هيستلم منه");

    return `ملخص الأوردر لحد دلوقتي:\n${itemsSummary}\n${orderType === "delivery" ? `رسوم توصيل: ${money(deliveryFee)}\n` : ""}الإجمالي: ${money(total)}` +
      (missing.length ? `\n\nناقص لسه: ${missing.join("، ")}` : "\n\nكل حاجة كاملة - اسأل العميل يأكد عشان تبعت الأوردر (submit_pending_order).");
  } finally {
    client.release();
  }
}

async function submitPendingOrder(ctx) {
  const result = await pool.query(
    "SELECT * FROM whatsapp_pending_orders WHERE conversation_id = $1 AND status = 'draft'",
    [ctx.conversationId]
  );
  const draft = result.rows[0];
  if (!draft) return "مفيش مسودة أوردر حالية - اجمع الأصناف الأول بـsave_draft_order.";
  const items = draft.items || [];
  if (items.length === 0) return "الأوردر لسه من غير أصناف.";
  if (draft.order_type === "delivery" && (!draft.delivery_area_id || !draft.address_details)) {
    return "العنوان أو منطقة التوصيل ناقصين - اسأل العميل يكملهم الأول.";
  }
  if (!draft.customer_name) return "اسم العميل ناقص - اسأله الأول.";

  await pool.query("UPDATE whatsapp_pending_orders SET status = 'pending', updated_at = now() WHERE id = $1", [draft.id]);

  const staffNumber = process.env.WHATSAPP_STAFF_NOTIFY_NUMBER;
  if (staffNumber) {
    sendMessage({
      to: staffNumber,
      text: `📥 أوردر جديد من واتساب محتاج مراجعة (#${draft.id}) - ${draft.customer_name} - ${money(draft.total)} - افتح شاشة "طلبات واتساب".`,
    }).catch(() => {});
  }

  return `تمام، الأوردر اتبعت للفريق للمراجعة والتأكيد (رقم مرجعي #${draft.id}) - هيتأكد خلال شوية.`;
}

async function logComplaint(input, ctx) {
  const orderId = input.orderId ? Number(input.orderId) : null;
  const result = await pool.query(
    `INSERT INTO whatsapp_complaints (conversation_id, customer_phone, order_id, category, description)
     VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [ctx.conversationId, ctx.phone, orderId, input.category || "other", input.description]
  );
  const complaintId = result.rows[0].id;

  const staffNumber = process.env.WHATSAPP_STAFF_NOTIFY_NUMBER;
  if (staffNumber) {
    sendMessage({
      to: staffNumber,
      text: `⚠️ شكوى جديدة من واتساب (#${complaintId})${orderId ? ` - طلب #${orderId}` : ""} - ${input.description}`,
    }).catch(() => {});
  }

  return `اتسجلت الشكوى (رقم #${complaintId}) - حد من الفريق هيتابع معاك.`;
}

async function executeTool(name, input, ctx) {
  switch (name) {
    case "get_menu": return getMenu();
    case "get_offers": return getOffers();
    case "get_business_info": return getBusinessInfo();
    case "list_delivery_areas": return listDeliveryAreas();
    case "lookup_recent_orders": return lookupRecentOrders(ctx.phone);
    case "save_draft_order": return saveDraftOrder(input, ctx);
    case "submit_pending_order": return submitPendingOrder(ctx);
    case "log_complaint": return logComplaint(input, ctx);
    default: return `أداة غير معروفة: ${name}`;
  }
}

module.exports = { TOOL_DEFINITIONS, executeTool };
