// Procurement v2: فاتورة المورد (بدون تكرار قيد AP - راجع الشرح جوه db/schema.sql) + ترقية kitchen_orders
// لدورة حياة Requisition كاملة + transfer_discrepancies + دفعات أب/ابن للتصنيع متعدد المراحل + التعبئة
// (Packaging) + ترقيم دفعات نظامي. كل DDL هنا آمن التكرار (IF NOT EXISTS / DO $$ EXCEPTION) عشان يفضل
// آمن حتى لو اتشغل أكتر من مرة بالغلط - نفس فلسفة أي migration سابق في المشروع
module.exports = {
  async up(client) {
    await client.query(`
      CREATE TABLE IF NOT EXISTS supplier_invoices (
        id                         SERIAL PRIMARY KEY,
        supplier_id                INTEGER NOT NULL REFERENCES suppliers(id),
        branch_id                  INTEGER NOT NULL REFERENCES branches(id),
        purchase_order_id          INTEGER REFERENCES purchase_orders(id),
        supplier_invoice_number    TEXT NOT NULL,
        invoice_date               DATE NOT NULL DEFAULT CURRENT_DATE,
        due_date                   DATE,
        currency                   TEXT NOT NULL DEFAULT 'EGP',
        subtotal                   NUMERIC NOT NULL DEFAULT 0,
        tax                        NUMERIC NOT NULL DEFAULT 0,
        total                      NUMERIC NOT NULL DEFAULT 0,
        matched_total               NUMERIC NOT NULL DEFAULT 0,
        variance_amount              NUMERIC NOT NULL DEFAULT 0,
        variance_journal_entry_id     INTEGER REFERENCES journal_entries(id),
        status                        TEXT NOT NULL DEFAULT 'DRAFT'
                                      CHECK (status IN ('DRAFT', 'MATCHED', 'VARIANCE_PENDING', 'APPROVED', 'PAID', 'PARTIALLY_PAID', 'CANCELLED')),
        notes                         TEXT,
        created_by                    INTEGER REFERENCES users(id),
        approved_by                    INTEGER REFERENCES users(id),
        approved_at                     TIMESTAMPTZ,
        cancelled_by                    INTEGER REFERENCES users(id),
        cancelled_at                     TIMESTAMPTZ,
        idempotency_key                  TEXT,
        created_at                        TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at                        TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE(supplier_id, supplier_invoice_number)
      );
    `);
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_supplier_invoices_idempotency_key ON supplier_invoices(idempotency_key) WHERE idempotency_key IS NOT NULL`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_supplier_invoices_supplier ON supplier_invoices(supplier_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_supplier_invoices_branch ON supplier_invoices(branch_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_supplier_invoices_po ON supplier_invoices(purchase_order_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_supplier_invoices_status ON supplier_invoices(status)`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS supplier_invoice_lines (
        id                     SERIAL PRIMARY KEY,
        supplier_invoice_id    INTEGER NOT NULL REFERENCES supplier_invoices(id) ON DELETE CASCADE,
        goods_receipt_item_id  INTEGER REFERENCES goods_receipt_items(id),
        inventory_item_id      INTEGER NOT NULL REFERENCES inventory_items(id),
        invoiced_quantity      NUMERIC NOT NULL,
        unit                   TEXT,
        unit_price             NUMERIC NOT NULL,
        line_total             NUMERIC NOT NULL,
        grn_unit_price         NUMERIC,
        variance_amount        NUMERIC NOT NULL DEFAULT 0
      );
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_supplier_invoice_lines_invoice ON supplier_invoice_lines(supplier_invoice_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_supplier_invoice_lines_grn_item ON supplier_invoice_lines(goods_receipt_item_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_supplier_invoice_lines_item ON supplier_invoice_lines(inventory_item_id)`);

    await client.query(`
      DO $$ BEGIN
        ALTER TABLE supplier_payments ADD COLUMN supplier_invoice_id INTEGER REFERENCES supplier_invoices(id);
      EXCEPTION WHEN duplicate_column THEN NULL;
      END $$;
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_supplier_payments_invoice ON supplier_payments(supplier_invoice_id)`);

    // ترقية kitchen_orders: توسيع الـCHECK على status - بندور على اسم الـconstraint الفعلي بدل ما نفترضه
    // (احتياط لو الاسم مختلف عن الافتراضي kitchen_orders_status_check على أي نسخة قديمة من القاعدة)
    await client.query(`
      DO $$
      DECLARE
        cname TEXT;
      BEGIN
        SELECT conname INTO cname
        FROM pg_constraint
        WHERE conrelid = 'kitchen_orders'::regclass
          AND contype = 'c'
          AND pg_get_constraintdef(oid) LIKE '%status%pending%';
        IF cname IS NOT NULL THEN
          EXECUTE format('ALTER TABLE kitchen_orders DROP CONSTRAINT %I', cname);
        END IF;
      END $$;
    `);
    await client.query(`
      DO $$ BEGIN
        ALTER TABLE kitchen_orders ADD CONSTRAINT kitchen_orders_status_check CHECK (status IN (
          'pending', 'fulfilled', 'cancelled',
          'DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED', 'PREPARING', 'READY', 'DISPATCHED', 'IN_TRANSIT', 'RECEIVED'
        ));
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$;
    `);

    const kitchenOrderColumns = [
      ["required_date", "DATE"],
      ["is_auto_suggested", "BOOLEAN NOT NULL DEFAULT FALSE"],
      ["submitted_by", "INTEGER REFERENCES users(id)"],
      ["submitted_at", "TIMESTAMPTZ"],
      ["approved_by", "INTEGER REFERENCES users(id)"],
      ["approved_at", "TIMESTAMPTZ"],
      ["rejected_by", "INTEGER REFERENCES users(id)"],
      ["rejected_at", "TIMESTAMPTZ"],
      ["rejection_reason", "TEXT"],
      ["preparing_started_by", "INTEGER REFERENCES users(id)"],
      ["preparing_started_at", "TIMESTAMPTZ"],
      ["ready_by", "INTEGER REFERENCES users(id)"],
      ["ready_at", "TIMESTAMPTZ"],
      ["dispatched_by", "INTEGER REFERENCES users(id)"],
      ["dispatched_at", "TIMESTAMPTZ"],
      ["received_by", "INTEGER REFERENCES users(id)"],
      ["received_at", "TIMESTAMPTZ"],
      ["cancelled_by", "INTEGER REFERENCES users(id)"],
      ["cancelled_at", "TIMESTAMPTZ"],
      ["cancellation_reason", "TEXT"],
    ];
    for (const [name, type] of kitchenOrderColumns) {
      await client.query(`
        DO $$ BEGIN
          ALTER TABLE kitchen_orders ADD COLUMN ${name} ${type};
        EXCEPTION WHEN duplicate_column THEN NULL;
        END $$;
      `);
    }

    const kitchenOrderItemColumns = [
      ["quantity_suggested", "NUMERIC"],
      ["quantity_available", "NUMERIC"],
      ["quantity_to_prepare", "NUMERIC"],
      ["quantity_dispatched", "NUMERIC"],
      ["shortage_notes", "TEXT"],
    ];
    for (const [name, type] of kitchenOrderItemColumns) {
      await client.query(`
        DO $$ BEGIN
          ALTER TABLE kitchen_order_items ADD COLUMN ${name} ${type};
        EXCEPTION WHEN duplicate_column THEN NULL;
        END $$;
      `);
    }
    await client.query(`
      DO $$ BEGIN
        ALTER TABLE kitchen_order_items ADD COLUMN fulfillment_status TEXT NOT NULL DEFAULT 'PENDING'
          CHECK (fulfillment_status IN ('PENDING', 'FULL', 'PARTIAL', 'UNFULFILLED'));
      EXCEPTION WHEN duplicate_column THEN NULL;
      END $$;
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS transfer_discrepancies (
        id                           SERIAL PRIMARY KEY,
        kitchen_transfer_id          INTEGER NOT NULL REFERENCES kitchen_transfers(id),
        kitchen_transfer_item_id     INTEGER REFERENCES kitchen_transfer_items(id),
        inventory_item_id            INTEGER NOT NULL REFERENCES inventory_items(id),
        discrepancy_type             TEXT NOT NULL CHECK (discrepancy_type IN
                                      ('SHORTAGE', 'DAMAGED', 'WRONG_ITEM', 'WRONG_QUANTITY', 'EXPIRED', 'OTHER')),
        quantity                     NUMERIC NOT NULL,
        unit                         TEXT,
        notes                        TEXT,
        evidence_urls                TEXT[],
        status                       TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'ACKNOWLEDGED', 'RESOLVED', 'REJECTED')),
        resolution_notes             TEXT,
        adjustment_journal_entry_id  INTEGER REFERENCES journal_entries(id),
        reported_by                  INTEGER REFERENCES users(id),
        reported_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
        resolved_by                  INTEGER REFERENCES users(id),
        resolved_at                  TIMESTAMPTZ
      );
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_transfer_discrepancies_transfer ON transfer_discrepancies(kitchen_transfer_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_transfer_discrepancies_status ON transfer_discrepancies(status)`);

    // STEP L-audit (بند 18 - أداء): kitchen_order_items.kitchen_order_id و kitchen_transfer_items.kitchen_transfer_id
    // عمودين FK بس من غير أي index عليهم صراحة (Postgres مابيعملش index تلقائي لعمود FK نفسه، بس للعمود
    // المُشار إليه). الجدولين دول بيتقروا بكثرة شديدة مع كل استدعاء تقريبًا في الـworkflow الجديد (تفاصيل
    // الطلبية، picking، التقاط الفروقات، تقرير requisition-fulfillment) - على مقياس مطعم حقيقي (آلاف
    // الطلبيات/التحويلات) الاستعلامات دي هتتحول لـsequential scan كامل على الجدول من غير الـindex ده
    await client.query(`CREATE INDEX IF NOT EXISTS idx_kitchen_order_items_order ON kitchen_order_items(kitchen_order_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_kitchen_transfer_items_transfer ON kitchen_transfer_items(kitchen_transfer_id)`);

    await client.query(`
      DO $$ BEGIN
        ALTER TABLE production_orders ADD COLUMN parent_production_order_id INTEGER REFERENCES production_orders(id);
      EXCEPTION WHEN duplicate_column THEN NULL;
      END $$;
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_production_orders_parent ON production_orders(parent_production_order_id)`);

    const productionOrderBatchColumns = [
      ["planned_quantity", "NUMERIC"],
      ["variance_quantity", "NUMERIC"],
      ["variance_reason", "TEXT"],
    ];
    for (const [name, type] of productionOrderBatchColumns) {
      await client.query(`
        DO $$ BEGIN
          ALTER TABLE production_order_batches ADD COLUMN ${name} ${type};
        EXCEPTION WHEN duplicate_column THEN NULL;
        END $$;
      `);
    }

    await client.query(`
      DO $$ BEGIN
        ALTER TABLE inventory_items ADD COLUMN batch_prefix TEXT;
      EXCEPTION WHEN duplicate_column THEN NULL;
      END $$;
    `);
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_inventory_items_batch_prefix ON inventory_items(batch_prefix) WHERE batch_prefix IS NOT NULL`);

    await client.query(`
      DO $$ BEGIN
        ALTER TABLE inventory_batches ADD COLUMN parent_batch_id INTEGER REFERENCES inventory_batches(id);
      EXCEPTION WHEN duplicate_column THEN NULL;
      END $$;
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_inventory_batches_parent ON inventory_batches(parent_batch_id)`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS batch_number_counters (
        id             SERIAL PRIMARY KEY,
        prefix         TEXT NOT NULL,
        counter_date   DATE NOT NULL,
        last_sequence  INTEGER NOT NULL DEFAULT 0,
        UNIQUE(prefix, counter_date)
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS packaging_orders (
        id                      SERIAL PRIMARY KEY,
        branch_id               INTEGER NOT NULL REFERENCES branches(id),
        input_item_id           INTEGER NOT NULL REFERENCES inventory_items(id),
        input_batch_id          INTEGER REFERENCES inventory_batches(id),
        output_item_id          INTEGER NOT NULL REFERENCES inventory_items(id),
        status                  TEXT NOT NULL DEFAULT 'DRAFT'
                                CHECK (status IN ('DRAFT', 'APPROVED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED')),
        planned_input_quantity  NUMERIC NOT NULL,
        actual_input_quantity   NUMERIC,
        planned_output_quantity NUMERIC NOT NULL,
        actual_output_quantity  NUMERIC,
        packaging_date          DATE NOT NULL DEFAULT CURRENT_DATE,
        batch_number            TEXT,
        expiry_date             DATE,
        variance_reason         TEXT,
        notes                   TEXT,
        operator_id             INTEGER REFERENCES users(id),
        approved_by             INTEGER REFERENCES users(id),
        completed_by            INTEGER REFERENCES users(id),
        cancelled_by            INTEGER REFERENCES users(id),
        approved_at             TIMESTAMPTZ,
        started_at              TIMESTAMPTZ,
        completed_at            TIMESTAMPTZ,
        cancelled_at            TIMESTAMPTZ,
        created_at              TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_packaging_orders_branch ON packaging_orders(branch_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_packaging_orders_status ON packaging_orders(status)`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS packaging_order_batches (
        id                  SERIAL PRIMARY KEY,
        packaging_order_id  INTEGER NOT NULL REFERENCES packaging_orders(id) ON DELETE CASCADE,
        role                TEXT NOT NULL CHECK (role IN ('input', 'output')),
        inventory_item_id   INTEGER NOT NULL REFERENCES inventory_items(id),
        batch_id            INTEGER REFERENCES inventory_batches(id),
        quantity            NUMERIC NOT NULL,
        created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_packaging_order_batches_order ON packaging_order_batches(packaging_order_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_packaging_order_batches_batch ON packaging_order_batches(batch_id)`);
  },
};
