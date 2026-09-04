// نسخ إعدادات تشغيل فرع (منيو + طرق دفع + بنود مصروفات + إعدادات نقطة البيع + موظفي الفرع) من نسخة
// Render المركزية لقاعدة بيانات محلية جديدة (Docker) - جزء من إعداد "الفرع يشتغل من غير نت" في README.
//
// عمدًا مش بينسخ أي بيانات تشغيلية قديمة (طلبات/مصروفات/شيفتات/مخزون) - دي محفوظة بأمان على Render
// أصلًا، والفرع المحلي المفروض يبدأ "فاضي من التاريخ" ويسجّل بس اللي هيحصل من دلوقتي وقدّام (نفس فلسفة
// db/sync-worker.js: كل تسجيل جديد بيترفع للمركزي، مش العكس). نسخ التاريخ القديم كان هيسبب مشكلة حقيقية:
// db/sync-worker.js بيرفع كل صف synced_at IS NULL في القاعدة المحلية تحت رقم فرع واحد بس (CENTRAL_BRANCH_ID)
// من غير ما يفرّق فرع عن فرع - لو القاعدة المحلية فيها بيانات فروع تانية مخلوطة هتترفع كلها غلط.
//
// الاستخدام (من غير ما تفتح بورت Postgres المحلي للإنترنت خالص - بيشتغل جوه شبكة Docker نفسها):
//   docker compose run --rm \
//     -e SOURCE_DATABASE_URL="postgres://user:pass@xxxx.render.com/dbname" \
//     -e SOURCE_BRANCH_ID="2" \
//     app node scripts/copy-branch-config-to-local.js
//
// SOURCE_BRANCH_ID = رقم الفرع ده في نظام Render (مش رقمه المحلي - هيتحدد تلقائيًا هنا). لو مش متأكد
// من الرقم، شغّل السكريبت من غير SOURCE_BRANCH_ID وهيطبعلك قايمة كل الفروع المسجّلة على Render.
const { Client } = require("pg");

const SOURCE_URL = process.env.SOURCE_DATABASE_URL;
const TARGET_URL = process.env.DATABASE_URL;
const SOURCE_BRANCH_ID = process.env.SOURCE_BRANCH_ID ? Number(process.env.SOURCE_BRANCH_ID) : null;

if (!SOURCE_URL) {
  console.error("لازم تحدد SOURCE_DATABASE_URL (رابط قاعدة بيانات Render المركزية).");
  process.exit(1);
}
if (!TARGET_URL) {
  console.error("DATABASE_URL (القاعدة المحلية) مش متحدد - المفروض يكون متظبط أصلًا في docker-compose.yml.");
  process.exit(1);
}

async function main() {
  const source = new Client({ connectionString: SOURCE_URL, ssl: { rejectUnauthorized: false } });
  const target = new Client({ connectionString: TARGET_URL });
  await source.connect();
  await target.connect();

  try {
    if (!SOURCE_BRANCH_ID) {
      const branches = await source.query("SELECT id, name, is_central_kitchen FROM branches ORDER BY id");
      console.log("محتاج تحدد SOURCE_BRANCH_ID - الفروع المسجّلة على Render دلوقتي:");
      for (const b of branches.rows) {
        console.log(`  ${b.id} — ${b.name}${b.is_central_kitchen ? " (سنتر كيتشن)" : ""}`);
      }
      process.exit(1);
    }

    await target.query("BEGIN");

    // 1) الفرع نفسه - صف محلي واحد بس (مش كل الفروع الثلاثة مع بعض)، بياناته منسوخة من فرعه على Render
    const branchRes = await source.query("SELECT * FROM branches WHERE id = $1", [SOURCE_BRANCH_ID]);
    if (branchRes.rows.length === 0) throw new Error(`مفيش فرع بالرقم ${SOURCE_BRANCH_ID} على Render`);
    const srcBranch = branchRes.rows[0];
    // مفيش UNIQUE constraint على branches.name في الاسكيما، فـON CONFLICT مش هتشتغل هنا خالص - لازم
    // نتأكد إحنا بالبحث بالاسم الأول بدل ما نعتمد على تعارض قاعدة بيانات مش موجود أصلًا (كان بيسبب فرع
    // مكرر جديد في كل مرة نشغّل السكريبت تاني)
    const existingBranch = await target.query("SELECT id FROM branches WHERE name = $1", [srcBranch.name]);
    let localBranchId;
    if (existingBranch.rows.length > 0) {
      localBranchId = existingBranch.rows[0].id;
      console.log(`الفرع موجود محليًا بالفعل برقم ${localBranchId} (${srcBranch.name}) - هتتحدّث بياناته`);
      await target.query(
        `UPDATE branches SET address=$2, phone=$3, hours=$4, lat=$5, lng=$6, supports_dine_in=$7 WHERE id=$1`,
        [localBranchId, srcBranch.address, srcBranch.phone, srcBranch.hours, srcBranch.lat, srcBranch.lng, srcBranch.supports_dine_in]
      );
    } else {
      const inserted = await target.query(
        `INSERT INTO branches (name, address, phone, hours, lat, lng, supports_dine_in)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         RETURNING id`,
        [srcBranch.name, srcBranch.address, srcBranch.phone, srcBranch.hours, srcBranch.lat, srcBranch.lng, srcBranch.supports_dine_in]
      );
      localBranchId = inserted.rows[0].id;
      console.log(`فرع جديد اتسجّل محليًا برقم ${localBranchId} (${srcBranch.name})`);
    }

    // 2) المنيو - نفس الأرقام (IDs) بالظبط زي Render، عشان كل الربط بينهم (variant/modifier/combo) يفضل
    // صحيح من غير أي إعادة حساب. آمن لأن القاعدة المحلية الجديدة فاضية من المنيو أصلًا (schema.sql مبيحطش
    // أي صنف افتراضي). station_id بيتصفّر عمدًا - محطات التحضير خاصة بكل فرع وطابعاته الفعلية، لازم
    // تتظبط محليًا مرة واحدة من شاشة "الطباعة" بعد النسخ ده (مش حاجة تتنقل، لأن أرقامها هتختلف عن Render)
    const categories = await source.query("SELECT * FROM menu_categories ORDER BY id");
    for (const c of categories.rows) {
      await target.query(
        `INSERT INTO menu_categories (id, name, display_order, menu_group, station_id)
         VALUES ($1,$2,$3,$4,NULL)
         ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, display_order=EXCLUDED.display_order, menu_group=EXCLUDED.menu_group`,
        [c.id, c.name, c.display_order, c.menu_group]
      );
    }
    await target.query(`SELECT setval(pg_get_serial_sequence('menu_categories','id'), COALESCE((SELECT MAX(id) FROM menu_categories), 1))`);

    const items = await source.query("SELECT * FROM menu_items ORDER BY id");
    for (const it of items.rows) {
      await target.query(
        `INSERT INTO menu_items (id, category_id, name, description, image_url, is_best, is_active, created_at, station_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NULL)
         ON CONFLICT (id) DO UPDATE SET category_id=EXCLUDED.category_id, name=EXCLUDED.name, description=EXCLUDED.description,
           image_url=EXCLUDED.image_url, is_best=EXCLUDED.is_best, is_active=EXCLUDED.is_active`,
        [it.id, it.category_id, it.name, it.description, it.image_url, it.is_best, it.is_active, it.created_at]
      );
    }
    await target.query(`SELECT setval(pg_get_serial_sequence('menu_items','id'), COALESCE((SELECT MAX(id) FROM menu_items), 1))`);

    const variants = await source.query("SELECT * FROM menu_item_variants ORDER BY id");
    for (const v of variants.rows) {
      await target.query(
        `INSERT INTO menu_item_variants (id, item_id, label, price, talabat_price)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (id) DO UPDATE SET item_id=EXCLUDED.item_id, label=EXCLUDED.label, price=EXCLUDED.price, talabat_price=EXCLUDED.talabat_price`,
        [v.id, v.item_id, v.label, v.price, v.talabat_price]
      );
    }
    await target.query(`SELECT setval(pg_get_serial_sequence('menu_item_variants','id'), COALESCE((SELECT MAX(id) FROM menu_item_variants), 1))`);

    // excluded_ingredient_item_id بيتصفّر عمدًا (بيشاور على inventory_items - مش منسوخ في السكريبت ده)
    const modifiers = await source.query("SELECT * FROM menu_item_modifiers ORDER BY id");
    for (const m of modifiers.rows) {
      await target.query(
        `INSERT INTO menu_item_modifiers (id, item_id, name, price_delta, is_active, excluded_ingredient_item_id)
         VALUES ($1,$2,$3,$4,$5,NULL)
         ON CONFLICT (id) DO UPDATE SET item_id=EXCLUDED.item_id, name=EXCLUDED.name, price_delta=EXCLUDED.price_delta, is_active=EXCLUDED.is_active`,
        [m.id, m.item_id, m.name, m.price_delta, m.is_active]
      );
    }
    await target.query(`SELECT setval(pg_get_serial_sequence('menu_item_modifiers','id'), COALESCE((SELECT MAX(id) FROM menu_item_modifiers), 1))`);

    const modPrices = await source.query("SELECT * FROM menu_item_modifier_variant_prices ORDER BY id");
    for (const mp of modPrices.rows) {
      await target.query(
        `INSERT INTO menu_item_modifier_variant_prices (id, modifier_id, variant_id, price_delta)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (id) DO UPDATE SET modifier_id=EXCLUDED.modifier_id, variant_id=EXCLUDED.variant_id, price_delta=EXCLUDED.price_delta`,
        [mp.id, mp.modifier_id, mp.variant_id, mp.price_delta]
      );
    }
    await target.query(`SELECT setval(pg_get_serial_sequence('menu_item_modifier_variant_prices','id'), COALESCE((SELECT MAX(id) FROM menu_item_modifier_variant_prices), 1))`);

    const combos = await source.query("SELECT * FROM combos ORDER BY id");
    for (const c of combos.rows) {
      await target.query(
        `INSERT INTO combos (id, name, price, is_active, created_at)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, price=EXCLUDED.price, is_active=EXCLUDED.is_active`,
        [c.id, c.name, c.price, c.is_active, c.created_at]
      );
    }
    await target.query(`SELECT setval(pg_get_serial_sequence('combos','id'), COALESCE((SELECT MAX(id) FROM combos), 1))`);

    const comboItems = await source.query("SELECT * FROM combo_items ORDER BY id");
    for (const ci of comboItems.rows) {
      await target.query(
        `INSERT INTO combo_items (id, combo_id, variant_id, quantity)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (id) DO UPDATE SET combo_id=EXCLUDED.combo_id, variant_id=EXCLUDED.variant_id, quantity=EXCLUDED.quantity`,
        [ci.id, ci.combo_id, ci.variant_id, ci.quantity]
      );
    }
    await target.query(`SELECT setval(pg_get_serial_sequence('combo_items','id'), COALESCE((SELECT MAX(id) FROM combo_items), 1))`);

    console.log(`المنيو اتنسخ: ${categories.rows.length} قسم، ${items.rows.length} صنف، ${variants.rows.length} حجم/سعر، ${modifiers.rows.length} إضافة، ${combos.rows.length} كومبو`);

    // 3) طرق الدفع - نفس الأرقام كمان (القاعدة المحلية فاضية منها أصلًا)
    const pms = await source.query("SELECT * FROM payment_methods ORDER BY id");
    for (const pm of pms.rows) {
      await target.query(
        `INSERT INTO payment_methods (id, name, note, kind, enabled)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, note=EXCLUDED.note, kind=EXCLUDED.kind, enabled=EXCLUDED.enabled`,
        [pm.id, pm.name, pm.note, pm.kind, pm.enabled]
      );
    }
    await target.query(`SELECT setval(pg_get_serial_sequence('payment_methods','id'), COALESCE((SELECT MAX(id) FROM payment_methods), 1))`);
    console.log(`طرق الدفع اتنسخت: ${pms.rows.length}`);

    // 4) بنود المصروفات - بالاسم (upsert) مش بالرقم، عشان القاعدة المحلية أصلًا فيها 8 بنود افتراضية
    // من التثبيت (نفس الأسماء غالبًا) - وaccount_id بيتصفّر عمدًا (بيترحّل على "مصروفات تشغيل أخرى"
    // افتراضيًا لو مش متحدد، زي ما موضّح في db/schema.sql)
    const expCats = await source.query("SELECT name, is_active, alert_threshold FROM expense_categories ORDER BY id");
    for (const ec of expCats.rows) {
      await target.query(
        `INSERT INTO expense_categories (name, is_active, alert_threshold)
         VALUES ($1,$2,$3)
         ON CONFLICT (name) DO UPDATE SET is_active=EXCLUDED.is_active, alert_threshold=EXCLUDED.alert_threshold`,
        [ec.name, ec.is_active, ec.alert_threshold]
      );
    }
    console.log(`بنود المصروفات اتظبطت: ${expCats.rows.length}`);

    // 5) إعدادات نقطة البيع (صف واحد بس) - كل القيم زي الفرع المركزي بالظبط (نسب الخصم، الضريبة، عتبات
    // فرق الكاش...) عشان سلوك الفرع المحلي يفضل مطابق لما كان شغال عليه على Render
    const settings = await source.query("SELECT * FROM pos_settings WHERE id = 1");
    if (settings.rows.length > 0) {
      const s = settings.rows[0];
      await target.query(
        `UPDATE pos_settings SET
           max_unapproved_discount_percent=$1, discount_manager_max_percent=$2,
           loyalty_points_per_egp=$3, loyalty_redeem_value_egp=$4,
           batch_consumption_method=$5, production_variance_alert_percent=$6,
           shift_variance_ack_threshold_egp=$7, shift_variance_review_threshold_egp=$8,
           require_shift_for_pos_sales=$9,
           driver_settlement_variance_ack_threshold_egp=$10, driver_settlement_variance_review_threshold_egp=$11,
           vat_rate=$12
         WHERE id = 1`,
        [
          s.max_unapproved_discount_percent, s.discount_manager_max_percent,
          s.loyalty_points_per_egp, s.loyalty_redeem_value_egp,
          s.batch_consumption_method, s.production_variance_alert_percent,
          s.shift_variance_ack_threshold_egp, s.shift_variance_review_threshold_egp,
          s.require_shift_for_pos_sales,
          s.driver_settlement_variance_ack_threshold_egp, s.driver_settlement_variance_review_threshold_egp,
          s.vat_rate,
        ]
      );
      console.log("إعدادات نقطة البيع اتنسخت");
    }

    // 6) موظفي الفرع ده بس (كاشير/مدير فرع) - بالإيميل (upsert)، عشان يقدروا يسجّلوا دخول محليًا بنفس
    // الإيميل والباسورد وكود الـPIN اللي مستخدمينهم على Render بالظبط، من غير ما نعيد تسجيلهم يدويًا
    const users = await source.query(
      "SELECT name, email, password_hash, role, is_active, pin_hash FROM users WHERE branch_id = $1", [SOURCE_BRANCH_ID]
    );
    for (const u of users.rows) {
      await target.query(
        `INSERT INTO users (branch_id, name, email, password_hash, role, is_active, pin_hash)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (email) DO UPDATE SET
           branch_id=EXCLUDED.branch_id, name=EXCLUDED.name, password_hash=EXCLUDED.password_hash,
           role=EXCLUDED.role, is_active=EXCLUDED.is_active, pin_hash=EXCLUDED.pin_hash`,
        [localBranchId, u.name, u.email, u.password_hash, u.role, u.is_active, u.pin_hash]
      );
    }
    console.log(`موظفين الفرع ده اتنسخوا: ${users.rows.length} (بنفس الإيميل/الباسورد اللي بيستخدموه على Render)`);

    await target.query("COMMIT");
    console.log(`\nخلصنا. رقم الفرع محليًا: ${localBranchId}`);
    console.log(`لو هتفعّل المزامنة بعد كده، حط CENTRAL_BRANCH_ID="${SOURCE_BRANCH_ID}" في docker-compose.yml (رقم الفرع على Render، مش الرقم المحلي).`);
    console.log("خطوة يدوية باقية: اعمل محطات التحضير والطابعات من شاشة \"الطباعة\" محليًا (خاصة بجهاز الفرع ده، مش بتتنسخ).");
  } catch (err) {
    await target.query("ROLLBACK");
    throw err;
  } finally {
    await source.end();
    await target.end();
  }
}

main().catch((err) => {
  console.error("فشل النسخ:", err.message);
  process.exit(1);
});
