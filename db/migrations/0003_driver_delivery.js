// المرحلة 7F: تحكم السائق/التوصيل - كل الـDDL هنا idempotent زي أي migration سابق في الملف ده. تعديل
// CHECK constraint موجود (users.role) محتاج معاملة خاصة لأن Postgres مفيهوش "ALTER CONSTRAINT IF NOT
// EXISTS" ولا "DROP CONSTRAINT ... ADD VALUE" زي enum حقيقي - بنتأكد من تعريف القيد الحالي (pg_get_constraintdef)
// قبل أي DROP/ADD عشان الملف يفضل آمن حتى لو اتشغل أكتر من مرة بالغلط
module.exports = {
  async up(client) {
    const roleCheck = await client.query(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'users_role_check'`
    );
    if (roleCheck.rows.length > 0 && !roleCheck.rows[0].def.includes("driver")) {
      await client.query(`ALTER TABLE users DROP CONSTRAINT users_role_check`);
      await client.query(
        `ALTER TABLE users ADD CONSTRAINT users_role_check
         CHECK (role IN ('admin', 'branch_manager', 'accountant', 'cashier', 'callcenter', 'driver'))`
      );
    }

    await client.query(`
      CREATE TABLE IF NOT EXISTS drivers (
        id            SERIAL PRIMARY KEY,
        user_id       INTEGER REFERENCES users(id) UNIQUE,
        employee_id   INTEGER,
        branch_id     INTEGER NOT NULL REFERENCES branches(id),
        driver_code   TEXT UNIQUE,
        name          TEXT NOT NULL,
        phone         TEXT,
        status        TEXT NOT NULL DEFAULT 'AVAILABLE'
                        CHECK (status IN ('AVAILABLE', 'BUSY', 'OFF_DUTY', 'SUSPENDED', 'INACTIVE')),
        is_active     BOOLEAN NOT NULL DEFAULT TRUE,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await client.query(`CREATE SEQUENCE IF NOT EXISTS driver_code_seq START 1`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_drivers_branch ON drivers(branch_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_drivers_status ON drivers(branch_id, status)`);

    const employeeFkExists = await client.query(
      `SELECT 1 FROM pg_constraint WHERE conname = 'fk_drivers_employee'`
    );
    if (employeeFkExists.rows.length === 0) {
      await client.query(
        `ALTER TABLE drivers ADD CONSTRAINT fk_drivers_employee FOREIGN KEY (employee_id) REFERENCES employees(id)`
      );
    }

    await client.query(`
      CREATE TABLE IF NOT EXISTS driver_settlements (
        id                     SERIAL PRIMARY KEY,
        driver_id              INTEGER NOT NULL REFERENCES drivers(id),
        branch_id              INTEGER NOT NULL REFERENCES branches(id),
        settled_by             INTEGER REFERENCES users(id),
        settled_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
        order_count            INTEGER NOT NULL DEFAULT 0,
        cod_expected           NUMERIC NOT NULL DEFAULT 0,
        cod_collected          NUMERIC NOT NULL DEFAULT 0,
        cod_variance           NUMERIC NOT NULL DEFAULT 0,
        delivery_fees_total    NUMERIC NOT NULL DEFAULT 0,
        expected_handover      NUMERIC NOT NULL DEFAULT 0,
        actual_handover        NUMERIC,
        handover_variance      NUMERIC,
        variance_status        TEXT NOT NULL DEFAULT 'NONE'
                                  CHECK (variance_status IN ('NONE', 'PENDING_REVIEW', 'ACKNOWLEDGED', 'APPROVED')),
        variance_reviewed_by   INTEGER REFERENCES users(id),
        variance_reviewed_at   TIMESTAMPTZ,
        variance_review_notes  TEXT,
        notes                  TEXT,
        created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_driver_settlements_driver ON driver_settlements(driver_id, settled_at)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_driver_settlements_branch ON driver_settlements(branch_id, settled_at)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_driver_settlements_variance_status ON driver_settlements(branch_id, variance_status) WHERE variance_status = 'PENDING_REVIEW'`);

    await client.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS driver_id INTEGER`);
    await client.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS assigned_by INTEGER REFERENCES users(id)`);
    await client.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS assigned_at TIMESTAMPTZ`);
    await client.query(`
      DO $$ BEGIN
        ALTER TABLE orders ADD COLUMN dispatch_status TEXT;
      EXCEPTION WHEN duplicate_column THEN NULL;
      END $$;
    `);
    const dispatchCheckExists = await client.query(
      `SELECT 1 FROM pg_constraint WHERE conname = 'orders_dispatch_status_check'`
    );
    if (dispatchCheckExists.rows.length === 0) {
      await client.query(`
        ALTER TABLE orders ADD CONSTRAINT orders_dispatch_status_check
          CHECK (dispatch_status IS NULL OR dispatch_status IN
            ('UNASSIGNED', 'ASSIGNED', 'OUT_FOR_DELIVERY', 'DELIVERED', 'FAILED', 'RETURNED'))
      `);
    }
    await client.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMPTZ`);
    await client.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_failed_at TIMESTAMPTZ`);
    await client.query(`
      DO $$ BEGIN
        ALTER TABLE orders ADD COLUMN delivery_failure_reason TEXT;
      EXCEPTION WHEN duplicate_column THEN NULL;
      END $$;
    `);
    const failureCheckExists = await client.query(
      `SELECT 1 FROM pg_constraint WHERE conname = 'orders_delivery_failure_reason_check'`
    );
    if (failureCheckExists.rows.length === 0) {
      await client.query(`
        ALTER TABLE orders ADD CONSTRAINT orders_delivery_failure_reason_check
          CHECK (delivery_failure_reason IS NULL OR delivery_failure_reason IN
            ('CUSTOMER_UNREACHABLE', 'CUSTOMER_REFUSED', 'WRONG_ADDRESS', 'CLOSED_LOCATION', 'OTHER'))
      `);
    }
    await client.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS collected_amount NUMERIC`);
    await client.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS collection_variance NUMERIC`);
    await client.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS driver_settlement_id INTEGER`);

    const driverFkExists = await client.query(`SELECT 1 FROM pg_constraint WHERE conname = 'fk_orders_driver'`);
    if (driverFkExists.rows.length === 0) {
      await client.query(`ALTER TABLE orders ADD CONSTRAINT fk_orders_driver FOREIGN KEY (driver_id) REFERENCES drivers(id)`);
    }
    const settlementFkExists = await client.query(`SELECT 1 FROM pg_constraint WHERE conname = 'fk_orders_driver_settlement'`);
    if (settlementFkExists.rows.length === 0) {
      await client.query(`ALTER TABLE orders ADD CONSTRAINT fk_orders_driver_settlement FOREIGN KEY (driver_settlement_id) REFERENCES driver_settlements(id)`);
    }
    await client.query(`CREATE INDEX IF NOT EXISTS idx_orders_driver_id ON orders(driver_id) WHERE driver_id IS NOT NULL`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_orders_dispatch_status ON orders(branch_id, dispatch_status) WHERE dispatch_status IS NOT NULL`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_orders_driver_settlement_id ON orders(driver_settlement_id) WHERE driver_settlement_id IS NOT NULL`);

    await client.query(`ALTER TABLE pos_settings ADD COLUMN IF NOT EXISTS driver_settlement_variance_ack_threshold_egp NUMERIC NOT NULL DEFAULT 30`);
    await client.query(`ALTER TABLE pos_settings ADD COLUMN IF NOT EXISTS driver_settlement_variance_review_threshold_egp NUMERIC NOT NULL DEFAULT 150`);
  },
};
