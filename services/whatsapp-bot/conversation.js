// المرحلة 8.43 (وتعميم 8.46 لفيسبوك ماسنجر وإنستجرام): نقطة الدخول اللي routes/whatsapp.js بينادي
// عليها لكل رسالة واردة من عميل - بتسجّل الرسالة، تبني سياق المحادثة (آخر كام رسالة)، تنادي الذكاء
// الاصطناعي (مع الأدوات)، وتبعت الرد فعليًا على نفس القناة اللي جت منها الرسالة.
const pool = require("../../db/pool");
const whatsappClient = require("../../db/whatsapp-client");
const socialClient = require("../../db/social-client");
const aiClient = require("../../db/ai-client");
const { buildSystemPrompt } = require("./persona");
const { TOOL_DEFINITIONS, executeTool } = require("./tools");

const HISTORY_LIMIT = 20;

// كل قناة ليها عميل إرسال مختلف (Graph API مختلف/توكن مختلف) - واتساب دايمًا كان عنده عميله بتاعه،
// وماسنجر/إنستجرام بيشتركوا في نفس عميل social-client.js (نفس Send API بالظبط)
function clientFor(channel) {
  return channel === "whatsapp" ? whatsappClient : socialClient;
}

async function getOrCreateConversation(channel, phone, profileName) {
  const existing = await pool.query("SELECT * FROM whatsapp_conversations WHERE channel = $1 AND phone = $2", [channel, phone]);
  if (existing.rows.length > 0) {
    if (profileName && !existing.rows[0].customer_name) {
      await pool.query("UPDATE whatsapp_conversations SET customer_name = $2 WHERE id = $1", [existing.rows[0].id, profileName]);
      existing.rows[0].customer_name = profileName;
    }
    return { conversation: existing.rows[0], isNew: false };
  }
  const inserted = await pool.query(
    "INSERT INTO whatsapp_conversations (channel, phone, customer_name) VALUES ($1, $2, $3) RETURNING *",
    [channel, phone, profileName || null]
  );
  return { conversation: inserted.rows[0], isNew: true };
}

async function logMessage(conversationId, direction, body, waMessageId) {
  await pool.query(
    `INSERT INTO whatsapp_messages (conversation_id, direction, body, wa_message_id)
     VALUES ($1,$2,$3,$4) ON CONFLICT (wa_message_id) WHERE wa_message_id IS NOT NULL DO NOTHING`,
    [conversationId, direction, body, waMessageId || null]
  );
  await pool.query("UPDATE whatsapp_conversations SET last_message_at = now() WHERE id = $1", [conversationId]);
}

async function loadHistory(conversationId) {
  const result = await pool.query(
    `SELECT direction, body FROM whatsapp_messages WHERE conversation_id = $1
     ORDER BY created_at DESC LIMIT $2`,
    [conversationId, HISTORY_LIMIT]
  );
  return result.rows.reverse().map((row) => ({
    role: row.direction === "in" ? "user" : "assistant",
    content: row.body,
  }));
}

async function isBotEnabled() {
  const settings = await pool.query("SELECT whatsapp_bot_enabled FROM pos_settings WHERE id = 1");
  return Boolean(settings.rows[0]?.whatsapp_bot_enabled);
}

// دي الدالة الرئيسية - بتستقبل رسالة عميل واردة فعليًا وتد على كل حاجة: تسجيل، رد ذكاء اصطناعي، إرسال.
// من غير throw عمدًا (بترجع فقط) - أي خطأ هنا (Gemini واقع، مشكلة قاعدة بيانات مؤقتة) ميوقفش استقبال
// webhook التاني، ولا يرجّع 500 لميتا (اللي هتعيد المحاولة بشكل مبالغ فيه على نفس الرسالة)
async function handleInboundMessage({ channel = "whatsapp", phone, profileName, text, waMessageId }) {
  try {
    const { conversation, isNew } = await getOrCreateConversation(channel, phone, profileName);
    await logMessage(conversation.id, "in", text, waMessageId);

    if (!(await isBotEnabled())) return;
    if (!aiClient.isConfigured()) return;

    const history = await loadHistory(conversation.id);
    const system = buildSystemPrompt({ channel, customerName: conversation.customer_name, isNewConversation: isNew });
    const ctx = { conversationId: conversation.id, phone, customerName: conversation.customer_name };

    const { replyText } = await aiClient.runToolLoop({
      system,
      messages: history,
      tools: TOOL_DEFINITIONS,
      executeTool: (name, input) => executeTool(name, input, ctx),
    });

    if (!replyText) return;

    await logMessage(conversation.id, "out", replyText, null);
    await clientFor(channel).sendMessage({ to: phone, text: replyText });
  } catch (err) {
    console.error(JSON.stringify({ timestamp: new Date().toISOString(), event: "whatsapp_bot_error", channel, message: err.message }));
  }
}

// بيستخدمها routes/whatsapp.js عشان يبعت ردود إدارية (تأكيد/رفض أوردر، رد على شكوى) على نفس قناة
// العميل الأصلية - القرار المتعمّد هنا واضح لو نسيناه: مفيش استدعاء مباشر لـwhatsappClient من الراوت
// عشان أوردر جاي من ماسنجر/إنستجرام ميتبعتش عن طريق واتساب بالغلط (customer_phone وقتها PSID مش رقم)
async function sendReply({ channel = "whatsapp", phone, text }) {
  return clientFor(channel).sendMessage({ to: phone, text });
}

module.exports = { handleInboundMessage, sendReply };
