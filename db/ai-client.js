// المرحلة 8.43: عميل خفيف لـAnthropic Messages API (بدون SDK رسمي - نفس فلسفة db/sms-provider.js/
// db/whatsapp-client.js: نداء HTTP مباشر بدل تبعية مكتبة كاملة لخدمة واحدة بنستخدم منها جزء بسيط).
// بيدعم حلقة "استخدام أدوات" (tool use): الموديل ممكن يطلب ينفّذ أداة (زي "هات المنيو الحالي من
// القاعدة")، إحنا بننفذها فعليًا ونرجّعله النتيجة، وهو بيكمل بناءً عليها - لحد ما يوصل لرد نصي نهائي
// (stop_reason = 'end_turn') أو نوصل لحد أقصى لعدد الدورات (حماية من حلقة لا نهائية لو الموديل عالق).
//
// متغيرات البيئة:
//   ANTHROPIC_API_KEY - مفتاح API (راجع docs/whatsapp-automation.md لطريقة الحصول عليه)
//   ANTHROPIC_MODEL    - اسم الموديل، افتراضيًا claude-sonnet-5 لو مش محدد
const API_VERSION = "2023-06-01";
const DEFAULT_MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-5";
const MAX_TOOL_TURNS = 6;

function isConfigured() {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

async function callMessagesApi({ system, messages, tools, maxTokens }) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": API_VERSION,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: DEFAULT_MODEL,
      max_tokens: maxTokens || 1024,
      system,
      messages,
      tools: tools && tools.length > 0 ? tools : undefined,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data?.error?.message || `Anthropic API error: HTTP ${res.status}`);
  }
  return data;
}

// بيشغّل الحوار كامل لحد ما يوصل لرد نصي نهائي - executeTool(name, input) لازم ترجع نص (النتيجة اللي
// هتتبعت للموديل كـtool_result). بيرجّع {replyText, updatedMessages} - updatedMessages مفيدة لو حابب
// تسجّل كل خطوة، بس المتصل عندنا (services/whatsapp-bot/conversation.js) بيسجّل بس الرد النهائي للعميل
async function runToolLoop({ system, messages, tools, executeTool, maxTokens }) {
  let currentMessages = [...messages];

  for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
    const data = await callMessagesApi({ system, messages: currentMessages, tools, maxTokens });
    const toolUses = (data.content || []).filter((block) => block.type === "tool_use");

    if (toolUses.length === 0 || data.stop_reason !== "tool_use") {
      const replyText = (data.content || [])
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n")
        .trim();
      return { replyText, updatedMessages: currentMessages };
    }

    currentMessages.push({ role: "assistant", content: data.content });

    const toolResults = [];
    for (const toolUse of toolUses) {
      let resultText;
      try {
        resultText = await executeTool(toolUse.name, toolUse.input || {});
      } catch (err) {
        resultText = `خطأ: ${err.message}`;
      }
      toolResults.push({ type: "tool_result", tool_use_id: toolUse.id, content: String(resultText) });
    }
    currentMessages.push({ role: "user", content: toolResults });
  }

  return { replyText: "معلش، ممكن تعيد سؤالك؟ حصلت مشكلة مؤقتة عندي.", updatedMessages: currentMessages };
}

module.exports = { isConfigured, runToolLoop };
