// المرحلة 8.47: باج حقيقي اتلقط فعليًا في الإنتاج - Gemini بيرفض حقل additionalProperties في تعريف
// أدوات function calling ("Invalid JSON payload received... Cannot find field") فكل استدعاء كان بيفشل
// فورًا من غير ما الموديل يشوف رسالة العميل خالص، حتى مع كل حاجة تانية مظبوطة (webhook/توكن/تفعيل).
// الاختبار ده بيقفل عليه عشان النوع ده من التوافق بين مزوّدين يتلقط تلقائيًا لو حصل تاني.
const { stripAdditionalProperties } = require("../db/ai-client");

describe("stripAdditionalProperties - توافق تعريف الأدوات مع Gemini", () => {
  it("بيشيل additionalProperties من مستوى السطح", () => {
    const schema = { type: "object", properties: {}, additionalProperties: false };
    expect(stripAdditionalProperties(schema)).toEqual({ type: "object", properties: {} });
  });

  it("بيشيلها من أي عمق جوه properties متداخلة (زي save_draft_order.items)", () => {
    const schema = {
      type: "object",
      properties: {
        items: {
          type: "array",
          items: { type: "object", additionalProperties: false, properties: { itemName: { type: "string" } } },
        },
      },
      additionalProperties: false,
    };
    const cleaned = stripAdditionalProperties(schema);
    expect(JSON.stringify(cleaned)).not.toContain("additionalProperties");
    expect(cleaned.properties.items.items.properties.itemName).toEqual({ type: "string" });
  });

  it("مش بيلمس أي حقل تاني (زي enum/required/description)", () => {
    const schema = { type: "string", enum: ["a", "b"], description: "وصف" };
    expect(stripAdditionalProperties(schema)).toEqual(schema);
  });
});
