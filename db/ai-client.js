// المرحلة 8.43 (وتحديث 8.46 - التحويل لـGoogle Gemini): عميل خفيف لـGemini API (بدون SDK رسمي - نفس
// فلسفة db/sms-provider.js/db/whatsapp-client.js: نداء HTTP مباشر بدل تبعية مكتبة كاملة لخدمة واحدة
// بنستخدم منها جزء بسيط). اتحول من Anthropic لـGemini عشان عنده مستوى مجاني حقيقي (من غير بطاقة/رصيد
// مسبق) كفاية لحجم مطعم واحد أو اتنين - القرار موثّق في docs/WHATSAPP-AUTOMATION.md.
//
// بيدعم حلقة "استخدام أدوات" (function calling): الموديل ممكن يطلب ينفّذ أداة (زي "هات المنيو الحالي
// من القاعدة")، إحنا بننفذها فعليًا ونرجّعله النتيجة، وهو بيكمل بناءً عليها - لحد ما يوصل لرد نصي نهائي
// (من غير functionCall في الرد) أو نوصل لحد أقصى لعدد الدورات (حماية من حلقة لا نهائية لو الموديل عالق).
//
// واجهة الموديول (isConfigured/runToolLoop) نفسها زي أي عميل ذكاء اصطناعي تاني عشان services/whatsapp-bot
// (والقنوات الجاية زي فيسبوك/إنستجرام) يستخدموها من غير ما يعرفوا تفاصيل مزوّد الخدمة.
//
// متغيرات البيئة:
//   GEMINI_API_KEY - مفتاح مجاني من aistudio.google.com/apikey (راجع docs/WHATSAPP-AUTOMATION.md)
//   GEMINI_MODEL    - اسم الموديل، افتراضيًا gemini-3.6-flash لو مش محدد (لو Google قفلت الموديل ده
//                     كمان مستقبلًا، غيّر GEMINI_MODEL في Render مباشرة من غير أي ديبلوي كود جديد)
const DEFAULT_MODEL = process.env.GEMINI_MODEL || "gemini-3.6-flash";
const MAX_TOOL_TURNS = 6;

function isConfigured() {
  return Boolean(process.env.GEMINI_API_KEY);
}

// Gemini بياخد تعريف الأدوات بشكل functionDeclarations{parameters} - شكله زي input_schema بتاعنا
// (كلاهما JSON Schema) بس Gemini بيرفض حقل additionalProperties تحديدًا (مش من ضمن الـOpenAPI subset
// اللي بيدعمه) - لازم نشيله (على أي عمق، مش السطح بس) قبل ما نبعت التعريف، وإلا كل استدعاء بيفشل فورًا
// بـ"Invalid JSON payload" من غير ما الموديل حتى يشوف رسالة العميل
function stripAdditionalProperties(schema) {
  if (Array.isArray(schema)) return schema.map(stripAdditionalProperties);
  if (schema && typeof schema === "object") {
    const { additionalProperties, ...rest } = schema;
    for (const key of Object.keys(rest)) rest[key] = stripAdditionalProperties(rest[key]);
    return rest;
  }
  return schema;
}

function toGeminiTools(tools) {
  if (!tools || tools.length === 0) return undefined;
  return [{
    functionDeclarations: tools.map((t) => ({ name: t.name, description: t.description, parameters: stripAdditionalProperties(t.input_schema) })),
  }];
}

async function callGenerateContent({ system, contents, tools, maxTokens }) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${DEFAULT_MODEL}:generateContent?key=${process.env.GEMINI_API_KEY}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents,
      tools: toGeminiTools(tools),
      // maxOutputTokens كان 1024 وبيتقطع في نص الرد فعليًا - موديلات Gemini الحديثة بتستهلك جزء من
      // نفس الحد ده في "تفكير" داخلي (thinking) قبل الرد النهائي حتى لو مش محتاج تفكير معقد لسؤال
      // بسيط، فبنعطّله صراحة (thinkingBudget: 0) عشان كل الحد يروح للرد الظاهر للعميل بدل ما ياكله
      // تفكير مالوش داعي لخدمة عملاء مطعم، وكمان رفعنا الحد نفسه احتياطًا
      generationConfig: { maxOutputTokens: maxTokens || 2048, thinkingConfig: { thinkingBudget: 0 } },
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data?.error?.message || `Gemini API error: HTTP ${res.status}`);
  }
  return data;
}

// بيشغّل الحوار كامل لحد ما يوصل لرد نصي نهائي - executeTool(name, input) لازم ترجع نص (النتيجة اللي
// هتتبعت للموديل كـfunctionResponse). بيرجّع {replyText, updatedMessages} - updatedMessages مفيدة لو
// حابب تسجّل كل خطوة، بس المتصل عندنا (services/whatsapp-bot/conversation.js) بيسجّل بس الرد النهائي
async function runToolLoop({ system, messages, tools, executeTool, maxTokens }) {
  let contents = messages.map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: m.content }],
  }));

  for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
    const data = await callGenerateContent({ system, contents, tools, maxTokens });
    const parts = data.candidates?.[0]?.content?.parts || [];
    const functionCalls = parts.filter((p) => p.functionCall);

    if (functionCalls.length === 0) {
      const replyText = parts.filter((p) => p.text).map((p) => p.text).join("\n").trim();
      return { replyText, updatedMessages: contents };
    }

    contents.push({ role: "model", parts });

    const responseParts = [];
    for (const fc of functionCalls) {
      let resultText;
      try {
        resultText = await executeTool(fc.functionCall.name, fc.functionCall.args || {});
      } catch (err) {
        resultText = `خطأ: ${err.message}`;
      }
      responseParts.push({ functionResponse: { name: fc.functionCall.name, response: { result: String(resultText) } } });
    }
    // "function" مش من ضمن الـroles المقبولة في نسخة الـAPI الحالية (اتلقطت فعليًا من رسالة خطأ Gemini
    // نفسها: "Role 'function' is not supported... use SYSTEM/USER/ASSISTANT/MODEL/..."). "user" هو
    // المكافئ المدعوم لإرجاع نتيجة الأداة للموديل
    contents.push({ role: "user", parts: responseParts });
  }

  return { replyText: "معلش، ممكن تعيد سؤالك؟ حصلت مشكلة مؤقتة عندي.", updatedMessages: contents };
}

module.exports = { isConfigured, runToolLoop, stripAdditionalProperties };
