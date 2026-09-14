// المرحلة 8.43: أتمتة واتساب - استقبال رسائل العملاء من Meta Cloud API (webhook عام، محمي بتوقيع
// HMAC مش بتسجيل دخول - راجع db/whatsapp-client.js)، وشاشات إدارية لمراجعة "الطلبات المعلّقة" (مسودات
// جمّعها البوت من محادثة، لسه محتاجة كاشير/كول سنتر يسجلها فعليًا كطلب حقيقي) والشكاوى.
const express = require("express");
const router = express.Router();
const pool = require("../db/pool");
const { requireAuth, requireRole } = require("../middleware/auth");
const { validateIdParam } = require("../middleware/validate-id-param");
const whatsappClient = require("../db/whatsapp-client");
const { handleInboundMessage } = require("../services/whatsapp-bot/conversation");

router.param("id", validateIdParam);

const REVIEW_ROLES = ["cashier", "callcenter", "branch_manager", "admin"];

// GET /api/whatsapp/webhook - خطوة التحقق الأولى وقت ما تربط رابط الـwebhook في لوحة Meta
router.get("/webhook", (req, res) => {
  const challenge = whatsappClient.verifyHandshake({
    mode: req.query["hub.mode"],
    token: req.query["hub.verify_token"],
    challenge: req.query["hub.challenge"],
  });
  if (challenge) return res.status(200).send(challenge);
  res.sendStatus(403);
});

// بيحوّل شكل رسالة ميتا لنص - النصوص بتتاخد زي ما هي، وأي نوع تاني (صورة/صوت/موقع...) بيتحول لوصف
// نصي مختصر عشان يفضل مسجّل في سياق المحادثة حتى لو البوت (والموظف اللي هيراجع بعدين) مش هيقدر "يشوفه"
function extractMessageText(message) {
  if (message.type === "text") return message.text?.body || "";
  if (message.type === "button") return message.button?.text || "[رد بزرار]";
  if (message.type === "interactive") return message.interactive?.button_reply?.title || message.interactive?.list_reply?.title || "[رد تفاعلي]";
  const LABELS = { image: "صورة", audio: "رسالة صوتية", video: "فيديو", document: "ملف", location: "موقع", sticker: "ستيكر" };
  return `[${LABELS[message.type] || "رسالة غير مدعومة"} من العميل]`;
}

// POST /api/whatsapp/webhook - الإشعارات الفعلية (رسايل واردة، تحديثات حالة تسليم...) - لازم توقيع
// صحيح، وبيرد 200 فورًا (قبل معالجة أي حاجة) عشان ميتا معندهاش سبب تعيد الإرسال؛ المعالجة الفعلية
// بتحصل بعد الرد من غير ما الطلب يستناها (fire-and-forget - الأخطاء بتتسجل جوه handleInboundMessage نفسها)
router.post("/webhook", (req, res) => {
  const signature = req.headers["x-hub-signature-256"];
  if (!whatsappClient.verifySignature(req.rawBody, signature)) {
    return res.sendStatus(401);
  }
  res.sendStatus(200);

  try {
    const entries = req.body?.entry || [];
    for (const entry of entries) {
      for (const change of entry.changes || []) {
        const value = change.value || {};
        const messages = value.messages || [];
        if (messages.length === 0) continue;
        const contactsByWaId = Object.fromEntries((value.contacts || []).map((c) => [c.wa_id, c.profile?.name]));
        for (const message of messages) {
          handleInboundMessage({
            phone: message.from,
            profileName: contactsByWaId[message.from] || null,
            text: extractMessageText(message),
            waMessageId: message.id,
          }).catch((err) => console.error("whatsapp webhook processing error:", err.message));
        }
      }
    }
  } catch (err) {
    console.error("whatsapp webhook parse error:", err.message);
  }
});

// ---------------- شاشات إدارية (لازم تسجيل دخول) ----------------

// GET /api/whatsapp/pending-orders?status=pending - افتراضيًا الطلبات المعلّقة اللي لسه محتاجة مراجعة
router.get("/pending-orders", requireAuth, requireRole(...REVIEW_ROLES), async (req, res) => {
  try {
    const status = req.query.status || "pending";
    const result = await pool.query(
      `SELECT po.*, b.name AS branch_name, da.name AS area_name
       FROM whatsapp_pending_orders po
       LEFT JOIN branches b ON b.id = po.branch_id
       LEFT JOIN delivery_areas da ON da.id = po.delivery_area_id
       WHERE po.status = $1 ORDER BY po.created_at DESC`,
      [status]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/pending-orders/:id", requireAuth, requireRole(...REVIEW_ROLES), async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT po.*, b.name AS branch_name, da.name AS area_name
       FROM whatsapp_pending_orders po
       LEFT JOIN branches b ON b.id = po.branch_id
       LEFT JOIN delivery_areas da ON da.id = po.delivery_area_id
       WHERE po.id = $1`,
      [req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: "الطلب المعلّق ده مش موجود" });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/whatsapp/pending-orders/:id/reject - رفض الطلب المعلّق (اتلغى قبل ما يترحّل لطلب حقيقي)
router.post("/pending-orders/:id/reject", requireAuth, requireRole(...REVIEW_ROLES), async (req, res) => {
  try {
    const { reason } = req.body;
    const result = await pool.query(
      `UPDATE whatsapp_pending_orders SET status = 'rejected', rejection_reason = $2,
         reviewed_by = $3, reviewed_at = now(), updated_at = now()
       WHERE id = $1 AND status = 'pending' RETURNING *`,
      [req.params.id, reason || null, req.user.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: "الطلب ده مش موجود أو اتراجع بالفعل" });

    const pendingOrder = result.rows[0];
    whatsappClient
      .sendMessage({
        to: pendingOrder.customer_phone,
        text: `للأسف مقدرناش نأكد الأوردر بتاعك دلوقتي${reason ? ` (${reason})` : ""} - كلمنا تاني لو حابب تعدّله.`,
      })
      .catch(() => {});

    res.json(pendingOrder);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/whatsapp/pending-orders/:id/link-order - بعد ما الموظف يسجّل الطلب فعليًا من شاشة الكول
// سنتر العادية (POST /api/orders نفسه - مفيش منطق أوردر مكرر هنا خالص)، الشاشة بتنادي الراوت ده
// عشان تربط المسودة بالطلب الحقيقي وتقفلها كـ"مؤكدة"، وتبعت تأكيد للعميل
router.post("/pending-orders/:id/link-order", requireAuth, requireRole(...REVIEW_ROLES), async (req, res) => {
  try {
    const { orderId } = req.body;
    if (!orderId) return res.status(400).json({ error: "orderId مطلوب" });

    const order = await pool.query("SELECT id FROM orders WHERE id = $1", [orderId]);
    if (order.rows.length === 0) return res.status(400).json({ error: "الطلب الحقيقي ده مش موجود" });

    const result = await pool.query(
      `UPDATE whatsapp_pending_orders SET status = 'confirmed', confirmed_order_id = $2,
         reviewed_by = $3, reviewed_at = now(), updated_at = now()
       WHERE id = $1 AND status = 'pending' RETURNING *`,
      [req.params.id, orderId, req.user.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: "الطلب ده مش موجود أو اتعالج بالفعل" });

    const pendingOrder = result.rows[0];
    whatsappClient
      .sendMessage({ to: pendingOrder.customer_phone, text: `تمام، الأوردر بتاعك اتأكد رسميًا رقم #${orderId} 🎉` })
      .catch(() => {});

    res.json(pendingOrder);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/whatsapp/complaints?status=open
router.get("/complaints", requireAuth, requireRole(...REVIEW_ROLES), async (req, res) => {
  try {
    const status = req.query.status || "open";
    const result = await pool.query(
      "SELECT * FROM whatsapp_complaints WHERE status = $1 ORDER BY created_at DESC",
      [status]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/whatsapp/complaints/:id/resolve
router.post("/complaints/:id/resolve", requireAuth, requireRole(...REVIEW_ROLES), async (req, res) => {
  try {
    const { resolutionNotes } = req.body;
    const result = await pool.query(
      `UPDATE whatsapp_complaints SET status = 'resolved', resolution_notes = $2,
         resolved_by = $3, resolved_at = now()
       WHERE id = $1 RETURNING *`,
      [req.params.id, resolutionNotes || null, req.user.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: "الشكوى دي مش موجودة" });

    const complaint = result.rows[0];
    whatsappClient
      .sendMessage({ to: complaint.customer_phone, text: "تم التعامل مع الشكوى بتاعتك - شكرًا لصبرك، ولو محتاج أي حاجة تانية إحنا موجودين." })
      .catch(() => {});

    res.json(complaint);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/whatsapp/conversations/:phone/messages - سياق المحادثة كامل (للمراجعة البشرية)
router.get("/conversations/:phone/messages", requireAuth, requireRole(...REVIEW_ROLES), async (req, res) => {
  try {
    const conv = await pool.query("SELECT id FROM whatsapp_conversations WHERE phone = $1", [req.params.phone]);
    if (conv.rows.length === 0) return res.json([]);
    const messages = await pool.query(
      "SELECT direction, body, created_at FROM whatsapp_messages WHERE conversation_id = $1 ORDER BY created_at",
      [conv.rows[0].id]
    );
    res.json(messages.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
