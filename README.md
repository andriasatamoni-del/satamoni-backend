# Satamoni Backend (نقطة الانطلاق)

ده أول نسخة من الـ Backend المركزي اللي هيحل محل:
- `window.storage` في ملف الموقع (satamoni-ordering.jsx)
- اللصق اليدوي في شيتات "استيراد POS" و"استيراد كشف حساب" بالإكسل

## طريقة التشغيل

```bash
npm install
cp .env.example .env      # عدّل DATABASE_URL ببيانات السيرفر بتاعك
npm run migrate           # ينشئ كل الجداول (schema.sql)
npm run dev               # تشغيل السيرفر محليًا للتجربة
```

## الجداول وربطها بالإكسل الحالي

| جدول | بديل لأي شيت في الإكسل |
|---|---|
| `branches` | صف الفروع + سنتر كيتشن |
| `daily_cash_sessions` | شيت "فرع محرم بك/الإبراهيمية/العصافرة" (المبيعات والكاش) |
| `expenses` | أعمدة المصروفات في نفس الشيتات |
| `purchases` / `kitchen_transfers` | المشتريات والتحويلات من سنتر كيتشن |
| `supplier_ledger_entries` | شيت "استيراد كشف حساب" لكل فرع |
| `orders` / `order_items` | طلبات الموقع (بديل window.storage) |
| `v_daily_branch_summary` (view) | شيت "لوحة التحكم" |

## الخطوات الجاية

1. توصيل ملف الموقع (satamoni-ordering.jsx) بـ `/api/menu` و`/api/branches` و`/api/orders` بدل `window.storage`
2. بناء موديول الكاشير (شاشة بيع لكل فرع) بيستخدم نفس الـ `/api/orders`
3. أتمتة تسجيل المصروفات/المشتريات اليومية بدل إدخالها يدويًا
4. بناء الداشبورد يقرا من `/api/reports/daily` و`/api/reports/branch-debt`

## ملاحظة مهمة

النسخة دي بداية (MVP) — من غير Authentication أو صلاحيات مستخدمين لسه.
قبل أي استخدام فعلي في الإنتاج، لازم نضيف:
- تسجيل دخول وصلاحيات لكل موظف/فرع
- تشفير الاتصال (HTTPS)
- نسخ احتياطي دوري لقاعدة البيانات
