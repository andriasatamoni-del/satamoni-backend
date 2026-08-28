// Procurement v2 STEP I: تتبّع الدفعة (Batch/Lot Traceability) كامل الاتجاهين - مورد → GRN → دفعة خام →
// دفعة تصنيع → دفعة تعبئة → تحويلات → فرع. مصدر الحقيقة هو نفس الجداول اللي كل الأنظمة التانية بتكتب
// عليها فعليًا (production_order_batches/packaging_order_batches/goods_receipt_items/
// kitchen_transfer_item_batches/inventory_movements) - مفيش جدول تتبّع منفصل مكرر.
//
// ملحوظة معمارية مهمة (راجع routes/kitchen-transfers.js): لما دفعة تتحوّل بين فروع، الفرع المستلم بياخد
// **صف inventory_batches جديد بـid مختلف** بنفس الهوية (batch_number/expiry_date/production_date/
// unit_cost) - مش نفس الصف بالظبط. فالربط عبر حدود الفروع هنا بيتم بمطابقة الهوية دي، مش بمطابقة id.

const MAX_BACKWARD_DEPTH = 15;

// من فين جت مادة الدفعة دي - بيصعد لفوق لحد ما يوصل لمصدر حقيقي (مورد عن طريق GRN) أو يوصل لأقصى عمق آمن
async function traceBackward(client, batchId, depth = 0, visited = new Set()) {
  if (depth > MAX_BACKWARD_DEPTH || visited.has(batchId)) return null;
  visited.add(batchId);

  const batchRes = await client.query(
    `SELECT b.*, ii.name AS item_name, ii.unit FROM inventory_batches b JOIN inventory_items ii ON ii.id = b.inventory_item_id WHERE b.id = $1`,
    [batchId]
  );
  if (batchRes.rows.length === 0) return null;
  const batch = batchRes.rows[0];
  const node = { batch, origin: null, transferredIn: null, parent: null };

  const grnRes = await client.query(
    `SELECT gri.id AS goods_receipt_item_id, gri.accepted_quantity, gri.unit_price, gr.id AS goods_receipt_id,
            gr.supplier_document_number, gr.received_at, s.id AS supplier_id, s.name AS supplier_name
     FROM goods_receipt_items gri JOIN goods_receipts gr ON gr.id = gri.goods_receipt_id
     LEFT JOIN suppliers s ON s.id = gr.supplier_id
     WHERE gri.batch_id = $1`,
    [batchId]
  );
  if (grnRes.rows.length > 0) node.origin = { type: "PURCHASE", ...grnRes.rows[0] };

  if (!node.origin) {
    const prodRes = await client.query(
      `SELECT po.id AS production_order_id, po.status, po.production_date, po.planned_quantity, po.actual_quantity,
              po.parent_production_order_id, r.recipe_type
       FROM production_order_batches pob
       JOIN production_orders po ON po.id = pob.production_order_id
       JOIN recipes r ON r.id = po.recipe_id
       WHERE pob.role = 'output' AND pob.batch_id = $1`,
      [batchId]
    );
    if (prodRes.rows.length > 0) {
      const inputsRes = await client.query(
        `SELECT pob.inventory_item_id, ii.name AS item_name, pob.batch_id, pob.quantity, pob.planned_quantity, pob.variance_quantity
         FROM production_order_batches pob JOIN inventory_items ii ON ii.id = pob.inventory_item_id
         WHERE pob.production_order_id = $1 AND pob.role = 'input'`,
        [prodRes.rows[0].production_order_id]
      );
      node.origin = { type: "PRODUCTION", ...prodRes.rows[0], inputs: inputsRes.rows };
      // STEP L-audit fix: أمر تصنيع بمصادر متعددة (مثلًا دفعة X استهلكت من دفعتين خام A وB) كان بيوقف
      // التتبّع هنا - inputsRes.rows بترجع كل المدخلات صح على المستوى ده، بس مفيش recursion لأي مستوى
      // أعمق منها غير عن طريق batch.parent_batch_id (عمود قيمة واحدة بس، وproduction.js أصلًا بيملاه
      // بس لما يكون فيه مصدر واحد لا لبس فيه - في حالة تعدد المصادر بيفضل NULL). فكانت أي دفعة متعددة
      // المصادر بتقطع السلسلة هنا تمامًا (A وB مايتتبّعوش لأصلهم الحقيقي - GRN/مورد). الحل: نتتبّع كل
      // مدخل من inputsRes.rows رجوعًا لأصله بنفس الدالة (recursive)، مش بس نعرضهم في المستوى الحالي.
      for (const input of node.origin.inputs) {
        if (input.batch_id) {
          input.trace = await traceBackward(client, input.batch_id, depth + 1, visited);
        }
      }
    }
  }

  if (!node.origin) {
    const packRes = await client.query(
      `SELECT pgo.id AS packaging_order_id, pgo.status, pgo.packaging_date, pgo.input_item_id, pgo.input_batch_id,
              pgo.planned_input_quantity, pgo.actual_input_quantity, pgo.planned_output_quantity, pgo.actual_output_quantity
       FROM packaging_order_batches pob
       JOIN packaging_orders pgo ON pgo.id = pob.packaging_order_id
       WHERE pob.role = 'output' AND pob.batch_id = $1`,
      [batchId]
    );
    if (packRes.rows.length > 0) node.origin = { type: "PACKAGING", ...packRes.rows[0] };
  }

  // لو دفعة وصلت الفرع ده عن طريق تحويل (مش أصلها الحقيقي، بس وسيلة وصولها للفرع ده) - بمطابقة الهوية
  // (رقم الدفعة/الصلاحية/الإنتاج) لأن صف الدفعة في فرع الاستلام صف مختلف تمامًا عن صف فرع المصدر
  const transferInRes = await client.query(
    `SELECT kt.id AS kitchen_transfer_id, kt.from_branch_id, kt.to_branch_id, kt.status, kt.received_at,
            ktib.source_batch_id, ktib.quantity
     FROM kitchen_transfer_item_batches ktib
     JOIN kitchen_transfer_items kti ON kti.id = ktib.kitchen_transfer_item_id
     JOIN kitchen_transfers kt ON kt.id = kti.kitchen_transfer_id
     WHERE kt.to_branch_id = $1 AND kti.inventory_item_id = $2
       AND COALESCE(ktib.batch_number,'') = COALESCE($3,'')
       AND COALESCE(ktib.expiry_date, '0001-01-01'::date) = COALESCE($4::date, '0001-01-01'::date)
     ORDER BY kt.received_at DESC LIMIT 1`,
    [batch.branch_id, batch.inventory_item_id, batch.batch_number, batch.expiry_date]
  );
  if (transferInRes.rows.length > 0) {
    node.transferredIn = transferInRes.rows[0];
    // نكمل التتبّع للخلف من نفس الدفعة في فرع المصدر (id مختلف، هوية واحدة) لو معروف
    if (node.transferredIn.source_batch_id) {
      node.parent = await traceBackward(client, node.transferredIn.source_batch_id, depth + 1, visited);
    }
  } else if (batch.parent_batch_id && !(node.origin && node.origin.type === "PRODUCTION")) {
    // لو أصل الدفعة أمر تصنيع، السطر فوق (تتبّع كل input.batch_id) أصلًا بيغطي الحالة دي بالكامل - سواء
    // مصدر واحد أو أكتر - فتتبّع batch.parent_batch_id تاني هنا هيكرر نفس السلسلة من غير أي فايدة إضافية
    node.parent = await traceBackward(client, batch.parent_batch_id, depth + 1, visited);
  }

  return node;
}

// إيه اللي حصل لمادة الدفعة دي - استهلاك مباشر في تصنيع/تعبئة تانية، تحويل لفرع تاني، بيع، أو هالك/تسوية.
// مستوى واحد بس (مش recursive) - لو الـcaller عايز يكمل أعمق في أي فرع فرعي (دفعة ناتجة/دفعة وصلت فرع
// تاني)، يعيد نداء traceForward على الـid بتاعها
async function traceForward(client, batchId) {
  const consumedInProductionRes = await client.query(
    `SELECT po.id AS production_order_id, po.status, pob.quantity AS quantity_consumed, po.recipe_id,
            outp.batch_id AS output_batch_id, outp.inventory_item_id AS output_item_id, outp.quantity AS output_quantity
     FROM production_order_batches pob
     JOIN production_orders po ON po.id = pob.production_order_id
     LEFT JOIN production_order_batches outp ON outp.production_order_id = po.id AND outp.role = 'output'
     WHERE pob.role = 'input' AND pob.batch_id = $1`,
    [batchId]
  );

  const consumedInPackagingRes = await client.query(
    `SELECT pgo.id AS packaging_order_id, pgo.status, pob.quantity AS quantity_consumed,
            outp.batch_id AS output_batch_id, outp.inventory_item_id AS output_item_id, outp.quantity AS output_quantity
     FROM packaging_order_batches pob
     JOIN packaging_orders pgo ON pgo.id = pob.packaging_order_id
     LEFT JOIN packaging_order_batches outp ON outp.packaging_order_id = pgo.id AND outp.role = 'output'
     WHERE pob.role = 'input' AND pob.batch_id = $1`,
    [batchId]
  );

  const transferredOutRes = await client.query(
    `SELECT kt.id AS kitchen_transfer_id, kt.from_branch_id, kt.to_branch_id, kt.status, kt.received_at, ktib.quantity
     FROM kitchen_transfer_item_batches ktib
     JOIN kitchen_transfer_items kti ON kti.id = ktib.kitchen_transfer_item_id
     JOIN kitchen_transfers kt ON kt.id = kti.kitchen_transfer_id
     WHERE ktib.source_batch_id = $1`,
    [batchId]
  );

  const movementsRes = await client.query(
    `SELECT movement_type, quantity, reference_type, reference_id, business_date, notes, reason
     FROM inventory_movements WHERE batch_id = $1 AND movement_type NOT IN ('TRANSFER_OUT', 'PRODUCTION_OUT')
     ORDER BY created_at`,
    [batchId]
  );

  const childBatchesRes = await client.query(
    `SELECT id, batch_number, branch_id, remaining_quantity, status FROM inventory_batches WHERE parent_batch_id = $1`,
    [batchId]
  );

  return {
    consumedInProduction: consumedInProductionRes.rows,
    consumedInPackaging: consumedInPackagingRes.rows,
    transferredOut: transferredOutRes.rows,
    movements: movementsRes.rows,
    childBatches: childBatchesRes.rows,
  };
}

module.exports = { traceBackward, traceForward };
