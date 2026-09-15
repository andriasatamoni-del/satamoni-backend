# Satamoni ERP — System Architecture & Clean-Rebuild Reference

Generated from a full survey of the current codebase (`andriasatamoni-del/satamoni-backend`, branch `claude/restaurant-erp-system-jctgj5`, snapshot: Sep 2026). Covers the whole system as it exists today: **118 database tables**, **54 API route files (~4 auth domains)**, **28 frontend pages**, **7 user roles**. The goal of this document is to give an accurate ground-truth picture *and* flag every duplication/fragmentation issue found, so a clean rebuild starts from a real map instead of guesswork.

---

## Table of Contents

1. [System Overview](#1-system-overview)
2. [Roles & Permission Model](#2-roles--permission-model)
3. [Frontend Pages Inventory](#3-frontend-pages-inventory)
4. [API Routes Inventory](#4-api-routes-inventory)
5. [Database Schema by Domain](#5-database-schema-by-domain)
6. [Cross-Cutting Architectural Patterns (worth keeping)](#6-cross-cutting-architectural-patterns-worth-keeping)
7. [Duplication & Fragmentation Findings (consolidated)](#7-duplication--fragmentation-findings-consolidated)
8. [Recommendations for a Clean Rebuild](#8-recommendations-for-a-clean-rebuild)

---

## 1. System Overview

**Stack:** Node.js/Express backend + PostgreSQL (single database, no read replicas), server-rendered **static multi-page HTML + vanilla JS** frontend (`public/*.html`, one file per screen, no build step, no shared frontend framework).

**Four separate authentication/trust domains coexist by design:**

| Domain | Mechanism | Used by |
|---|---|---|
| Staff auth | JWT Bearer, 12h TTL, role/branch/permissions re-read from DB every request (not trusted from token) | All 7 staff roles |
| Customer auth | Separate JWT (different secret derivation `JWT_SECRET::customer`), 180-day TTL | Public ordering site customers |
| Branch sync | Static `SYNC_API_KEY` Bearer token, fails closed if unset | Server-to-server order/cash/expense replication (`/api/sync`) |
| WhatsApp webhook | Meta HMAC signature verification, no bearer token at all | Inbound WhatsApp bot messages |

**Local agent pattern:** two standalone Node.js processes run on branch hardware and talk to the backend *only* over HTTP as a real low-privilege staff login (never direct DB access): `print-agent/` (polls `/api/print-jobs`, prints receipts/tickets silently via a headless Chromium) and `attendance-agent/` (polls a branch's ZKTeco biometric device, pushes punches to `/api/attendance-sync/punches`).

**Core architectural backbone:** `inventory_movements` is the single source of truth for all stock changes (never write `branch_inventory_stock` directly), and `journal_entries`/`journal_entry_lines` is the single source of truth for all money movement, with Postgres triggers enforcing debit=credit balance and immutability once posted. Almost every operational feature (sales, purchasing, production, payroll, transfers, waste) ultimately posts into one or both of these two ledgers.

---

## 2. Roles & Permission Model

### 2.1 The 7 roles

`admin`, `branch_manager`, `accountant`, `cashier`, `callcenter`, `driver`, `employee` — enforced by a DB `CHECK` constraint on `users.role`. No separate "owner" or "HR" role; `admin` plays both parts.

### 2.2 Two coexisting authorization mechanisms

1. **`requireRole(...)`** (`middleware/auth.js`) — coarse, hardcoded role-name allowlist per route. Used by ~15 older route files (kitchen-orders, kitchen-transfers, suppliers, customers, hr, whatsapp, branches, combos, menu, cash-sessions, payroll, driver-settlements partially).
2. **`requirePermission(...)`** (`middleware/permissions.js`) — fine-grained action keys (`orders.create`, `payment_control.adjustment.approve_high`, etc.), checked against a role's default permission list **plus per-user JSONB override arrays** (`permission_grants`/`permission_revokes` on the `users` row — revoke always wins, even over admin's `"*"`). Used by ~30 newer route files. Drives the "تعديل الصلاحيات" admin UI, which can grant/revoke any individual permission for any individual user on top of their role default — this is how, e.g., a cashier account can be given `payslips.view_own` without becoming role `employee`.

Some routes double-gate deliberately: `requireRole("admin")` **and** `requirePermission(...)` together on irreversible actions (journal reversal, period close, recipe approval, production approval) — belt-and-suspenders on the highest-risk actions.

Branch isolation is enforced **per-route**, ad hoc, via `assertOwnBranch(req.user, branchId)` (admin bypasses; everyone else must match `req.user.branchId`) — copy-pasted into hundreds of individual handlers, not centralized.

`driver` and `employee` get an *additional* code-level ownership check beyond any permission key: the route matches `drivers.user_id`/`employees.user_id` against `req.user.id` directly, so even a mis-granted permission can't leak another driver's/employee's data.

### 2.3 Default permission catalog (condensed by group)

The full catalog lives in `middleware/permissions.js` (`PERMISSION_CATALOG`, 29 groups, ~95 individual keys). Condensed to **which roles get a group by default**:

| Permission group | admin | branch_manager | accountant | cashier | callcenter | driver | employee |
|---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| orders (create/discount/void) | ✅ all | ✅ create+request, approve | — | ✅ create+request only | ✅ create+request only | — | — |
| inventory (view/adjust/count) | ✅ | ✅ | view only | — | — | — | — |
| recipes (full lifecycle) | ✅ | create/edit/submit | view | — | — | — | — |
| production / production_planning | ✅ | ✅ | view only | — | — | — | — |
| food_cost | ✅ | view | view+export | — | — | — | — |
| expenses / purchases (cash) | ✅ | full+review | full+review | own-daily only | — | — | — |
| purchasing (formal PO/GRN) | ✅ | create/edit/submit/cancel | view+export | — | — | — | — |
| users.view | ✅ | ✅ | — | — | — | — | — |
| approvals | ✅ | ✅ | create only | ✅ create | ✅ create | — | — |
| audit.view.branch | ✅ | ✅ | ✅ | — | — | — | — |
| accounting | ✅ full incl. reverse/close | view only | full minus reverse/close | — | — | — | — |
| treasuries / banks | ✅ | view only | view+transfer / view | — | — | — | — |
| shifts (cashier till) | ✅ | open/close own + review branch | view+review branch | open/view/close own | — | — | — |
| branch_day | ✅ | ✅ | view only | — | — | — | — |
| deliveries | ✅ | view branch+assign | — | ✅ assign | ✅ assign | view/update own | — |
| drivers.manage / driver_settlements | ✅ | ✅ | review only | create only | — | view own | — |
| driver_shifts.manage | ✅ | ✅ | — | ✅ | — | — | — |
| kitchen (KDS) | ✅ | ✅ | — | ✅ | — | — | — |
| printers / print_routing | ✅ | ✅ | — | — | — | — | — |
| print_jobs | ✅ | view+manage_queue+trigger | view | trigger only | — | — | — |
| attendance.sync_device | ✅ | ✅ | — | — | — | — | — |
| payment_control | ✅ | view+request+approve | view+request+approve+approve_high+reconcile | request only | — | — | — |
| crm (followups/complaints) | ✅ | ✅ | — | — | ✅ | — | — |
| payslips.view_own / leave_requests.manage_own / attendance.view_own | ✅ | — | — | — | — | — | ✅ |

`admin`'s literal role default is `["*"]` (everything); `branch_manager` and `accountant` have the broadest non-admin reach; `cashier`/`callcenter` are POS/phone-order-floor roles with narrow permissions; `driver`/`employee` are the narrowest, self-service-only roles.

### 2.4 Role → landing page / home tiles

`public/index.html` is the single shared login page. On successful login:

| Role | Behavior |
|---|---|
| `cashier` | Force-redirected to `satamoni-pos.html`. Never sees the tile grid. |
| `callcenter` | Force-redirected to `satamoni-callcenter.html`. |
| `driver` | Force-redirected to `satamoni-driver-app.html`. |
| `employee` | Force-redirected to `satamoni-employee-self.html`. |
| `admin`, `branch_manager`, `accountant` | Shown the **same** full home-tile grid — no role-based tile filtering. Each destination page then self-gates and may bounce them right back with an "access denied" message. |

The tile grid itself is data-driven (`GET /api/home-tiles`, DB-backed, admin-editable order/title/description — but `href`/`icon` are fixed) and is **public with no auth at all**. Current tiles (19): نقطة البيع، متابعة العملاء (CRM)، الكول سنتر، دورة حياة الدليفري، إدارة السائقين، لوحة توزيع وتسوية السائقين، طلبات وشكاوى واتساب، داش بورد المالك، الأصناف، الحسابات، التحكم في المدفوعات والمطابقة، مركز التقارير، سجل التدقيق والموافقات، الحضور والانصراف، إدارة المستخدمين، المنيو والإعدادات، المشتريات والتصنيع، شاشة المطبخ (KDS)، الرواتب.

**Roles with only one page total, ever:** `driver` (driver-app.html) and `employee` (employee-self.html). Both were retrofitted with forced redirects after the fact — the login page's own comments note *every* role used to see the full tile grid (including tiles they couldn't open) until this was fixed for cashier/callcenter first, then driver/employee later. `branch_manager` and `accountant` never got an equivalent tailored landing page — they still see the generic admin-shaped grid.

---

## 3. Frontend Pages Inventory

28 pages under `public/satamoni-*.html` (plus `index.html`). Every page implements its own auth/role-gate boot logic independently — there is **no shared frontend router or auth module**; the `auth` object, `api()` fetch wrapper, login-overlay markup, and role-check/redirect logic are copy-pasted near-identically into all 28 files. The frontend checks are UX convenience only — real enforcement is server-side.

| Page | Lines | Allowed role(s) | Purpose | Tabs | Reachable via |
|---|---:|---|---|---|---|
| `satamoni-pos.html` | 3049 | admin, branch_manager, cashier | POS terminal — order entry, cash handling, shift close | none (flat) | home tile |
| `satamoni-accounting.html` | 2290 | admin, accountant, branch_manager⚠ | Full accounting suite | **17 tabs** | home tile |
| `satamoni-purchasing.html` | 2122 | admin, branch_manager⚠, accountant | Procurement: PR→PO→GRN→returns→invoices→payments→suppliers | 8 tabs | iframe in procurement-hub only |
| `satamoni-manufacturing.html` | 1775 | admin, branch_manager⚠, accountant | Central-kitchen manufacturing: BOM, orders, packing, batch trace | 5 tabs | iframe in procurement-hub only |
| `satamoni-payroll.html` | 1681 | admin, accountant, branch_manager⚠ | Payroll engine, HR admin, HR reports | 8 tabs | home tile |
| `satamoni-callcenter.html` | 1614 | admin, callcenter | Phone-order intake | none | forced landing (callcenter) |
| `satamoni-items.html` | 1465 | admin, accountant, branch_manager⚠ | Unified item catalog + stocktake | type filter, no tab bar | home tile |
| `satamoni-menu.html` | 1365 | admin only | Menu/catalog/zones/payment methods/offers admin | 6 tabs (incl. iframe→printing) | home tile |
| `satamoni-reports.html` | 1021 | admin, accountant, branch_manager⚠ | Reporting hub — everything | **17 tabs** | home tile |
| `satamoni-requisitions.html` | 1059 | admin, branch_manager, cashier | Branch-side stock requisitions | 5 tabs | iframe in procurement-hub, also direct (`?stay`) |
| `satamoni-payment-control.html` | 888 | admin, branch_manager⚠, accountant | Payment reconciliation dashboard | 7 tabs | home tile |
| `satamoni-delivery.html` | 751 | admin, callcenter, branch_manager, cashier, accountant | Delivery order lifecycle board | status×type filter-tabs | home tile |
| `satamoni-admin.html` | 646 | admin only | User management | none | home tile |
| `satamoni-ck-requisitions.html` | 616 | admin, branch_manager (+ central-kitchen flag) | Central-kitchen side of requisitions | 3 tabs | iframe in procurement-hub only |
| `satamoni-dispatch.html` | 560 | admin, branch_manager, accountant | Driver dispatch + settlement | 2 tabs | home tile |
| `satamoni-customers.html` | 578 | admin, callcenter, branch_manager, cashier, accountant | Customer directory + dormant list | 2 tabs | home tile **and** iframe in CRM |
| `satamoni-printing.html` | 563 | admin, branch_manager | Printer/station/routing config | 3 tabs | iframe in menu.html only |
| `satamoni-production-planning.html` | 641 | admin, branch_manager | MRP-style demand/production planning | 4 tabs | iframe in procurement-hub only |
| `satamoni-dashboard.html` | 493 | admin, accountant, branch_manager | Owner/exec sales & profitability dashboard | none | home tile |
| `satamoni-audit.html` | 410 | admin, branch_manager, accountant, cashier⚠ | Audit log + stocktake-approval inbox | 2 tabs | home tile |
| `satamoni-crm.html` | 390 | admin, branch_manager, callcenter | Post-delivery follow-up calls + complaints | 3 tabs (incl. iframe→customers) | home tile |
| `satamoni-employee-self.html` | 353 | employee | Own payslips, leave requests, attendance | 3 tabs | forced landing (employee) |
| `satamoni-driver-app.html` | 342 | driver | Own assigned orders, own settlements | 2 tabs | forced landing (driver) |
| `satamoni-whatsapp.html` | 311 | admin, branch_manager, cashier, callcenter | Review bot-drafted orders/complaints | 2 tabs | home tile |
| `satamoni-drivers.html` | 273 | admin, branch_manager | Driver roster admin | none | home tile |
| `satamoni-attendance.html` | 285 | all except cashier/callcenter | Personal clock-in/out + manager oversight panel | none + mgr sub-section | home tile |
| `satamoni-kds.html` | 335 | admin, branch_manager, cashier | Kitchen Display System | none | home tile |
| `satamoni-procurement-hub.html` | 99 | *(no gate — pure iframe shell)* | Wraps 5 standalone pages as tabs | 5 tabs, each a full page in an `<iframe>` | home tile |

⚠ = allowed but with a restricted view inside the page (own-branch scoping, read-only, or missing a sub-tab).

### 3.1 Rough access reach per role (of 28 non-index pages)

- **admin**: effectively all 28 — the only truly universal role.
- **branch_manager**: ~20, mostly own-branch scoped.
- **accountant**: ~13, finance/ops-reporting only, no POS/operational pages.
- **cashier**: 6 (pos, kds, requisitions, delivery, customers, whatsapp) — true home is `pos`.
- **callcenter**: 5 (callcenter, crm, customers, delivery, whatsapp) — true home is `callcenter`.
- **driver**: 1 (driver-app only).
- **employee**: 1 (employee-self only).

---

## 4. API Routes Inventory

54 files under `routes/`, all mounted in `server.js`. Grouped here by domain (mount path → file).

### 4.1 Auth & Identity
- `/api/auth` — login, session, PIN-verify-to-approval-token issuance.
- `/api/users` — staff account CRUD, permission overrides, employee-record linking.
- `/api/customer-auth` — separate customer-facing register/login (different JWT domain).
- `/api/sync` — server-to-server replication, static API key.

### 4.2 Branches, Menu & Catalog
- `/api/branches` — branch/location master data.
- `/api/menu` — categories/items/variants/modifiers, price/recipe bulk Excel import-export.
- `/api/combos` — bundle offers.
- `/api/config` — public bundled site config, delivery areas, payment methods.
- `/api/pos-settings` — POS-specific settings.
- `/api/home-tiles` — dashboard tile config.

### 4.3 Orders, POS & Delivery
- `/api/orders` — the core order lifecycle (largest/most business-critical single concern).
- `/api/deliveries` — dispatch board, assign/out-for-delivery/delivered/failed.
- `/api/drivers` — driver roster.
- `/api/driver-settlements` — cash settlement for batched deliveries.
- `/api/driver-shifts` — hourly driver labor clock-in/out.
- `/api/shifts` — cashier cash-drawer shift open/close/review.
- `/api/cash-sessions` — older/parallel daily cash tracking (see §7).
- `/api/branch-days` — end-of-day branch close with a readiness checklist.
- `/api/kds` — Kitchen Display live order board.
- `/api/order-ratings` — public post-order rating, token-gated.

### 4.4 Inventory, Recipes & Production
- `/api/inventory` — stock items, balances, adjustments, waste, batches, unit conversions.
- `/api/stocktake` — physical count sessions with preview/commit.
- `/api/recipes` — versioned recipe lifecycle (draft→approve→activate→archive).
- `/api/production` — manufacturing orders.
- `/api/packaging` — packaging stage (structurally a clone of `/api/production`).
- `/api/production-planning` — read-only MRP planning.
- `/api/kitchen-transfers` — inter-branch/CK stock transfer.
- `/api/kitchen-orders` — branch→CK requisition (distinct from KDS and from kitchen-transfers).

### 4.5 Procurement
- `/api/suppliers` — supplier master + price list + ledger view.
- `/api/purchase-requests` — internal pre-commitment request.
- `/api/purchase-orders` — formal PO.
- `/api/goods-receipts` — GRN (the only point inventory is actually posted for procurement).
- `/api/purchase-returns` — supplier returns.
- `/api/supplier-invoices` — invoice-vs-GRN variance matching.
- `/api/supplier-payments` — AP settlement.
- `/api/expenses` — branch operating expenses (own-daily cashier tier + review tier).
- `/api/purchases` — cash/informal purchases (parallel structure to expenses).

### 4.6 Accounting
- `/api/accounting` — chart of accounts, manual journal entries, period/year close.
- `/api/treasuries` — friendly view/transfer layer over cash accounts.
- `/api/banks` — bank/bank-account master data.
- `/api/payment-control` — payment locking, adjustment requests, external-statement reconciliation, exceptions, audit.

### 4.7 HR & Payroll
- `/api/hr` — shift scheduling, clock-in/out, employee records, warnings, leave, ~12 HR reports.
- `/api/payroll` — payroll engine: settings, fingerprint import, adjustments, runs, branch-sales feed.
- `/api/employee-self` — narrow self-service (own payslips/leave/attendance).
- `/api/attendance-sync` — biometric-device punch ingestion (local agent).

### 4.8 Printing
- `/api/printers` — printer registry.
- `/api/kitchen-stations` — prep-station + print-routing config.
- `/api/print-jobs` — print queue consumed by the local print-agent.

### 4.9 Customers, CRM & Communication
- `/api/customers` — customer directory, addresses, block/merge.
- `/api/crm` — post-delivery follow-up calls + complaints (CRM-1 phase).
- `/api/whatsapp` — WhatsApp bot webhook + staff review of bot-drafted orders/complaints.

### 4.10 Reporting
- `/api/reports` — the reporting/analytics hub (~50+ GET endpoints, ~3400 lines, spans 5+ distinct report domains in one file — see §7).
- `/api/audit-logs` — audit trail viewer.
- `/api/approvals` — generic approval-request workflow.

---

## 5. Database Schema by Domain

118 tables across ~15 domains. Full column-level detail lives in `db/schema.sql`; this section covers structure, purpose, and relationships.

### 5.1 Auth & Users
- **`users`** — staff login accounts. `role` enum, `branch_id` (NULL = all-branch access), `permission_grants`/`permission_revokes` JSONB override arrays, `pin_hash` for manager-approval PINs.
- **`audit_logs`** — append-only, polymorphic (`entity_type`/`entity_id`, no FK) action log with before/after JSONB.

### 5.2 Branches
- **`branches`** — physical branch or central-kitchen (flag `is_central_kitchen`). Scoped-to by `branch_id` on nearly every operational table.
- **`branch_days`** — daily close-out header, one per branch per business date.
- **`schema_migrations`** — applied-migration ledger (not a full migration framework).

### 5.3 Menu, Inventory & Recipes
- **Menu:** `menu_categories` → `menu_items` → `menu_item_variants` (branch price vs. Talabat price) → `menu_item_modifiers` (+ per-variant price overrides) → `menu_price_history` (audit trail) → `combos`/`combo_items`.
- **Inventory master:** `inventory_items` (raw/manufactured), `unit_conversions`, `branch_inventory_stock` (cached balance — source of truth is the movement ledger), `inventory_batches` (lot/expiry tracking, multi-stage parent linkage), `inventory_snapshots` (monthly valuation), `inventory_discrepancies` (balance-vs-ledger mismatch flags).
- **Recipe engine (versioned):** `recipes` (stable identity, linked to either a menu variant or a manufactured item) → `recipe_versions` (DRAFT→PENDING→APPROVED→ACTIVE→ARCHIVED, only one ACTIVE per recipe enforced at DB level) → `recipe_ingredients` (can reference sub-recipes recursively). `order_item_ingredient_costs` freezes the theoretical per-ingredient cost at sale time.
- **Legacy flat projections** (auto-generated, not directly editable — see §7): `menu_item_variant_ingredients`, `manufacturing_recipe_items`.

### 5.4 Orders & POS
- **`orders`** — central transaction record. Independent status dimensions: `status`, `payment_status`, `kitchen_status`, `dispatch_status` all vary separately rather than one state machine.
- **`order_items`** → **`order_item_modifiers`** (price/name snapshotted at sale) + **`order_item_excluded_ingredients`** (parallel exclusion mechanism — see §7).
- **`order_status_log`**, **`order_notifications`**, **`order_ratings`** (public, token-gated).
- **`payment_methods`** — `kind` (cash/card_or_wallet/credit) + `settlement_channel` (drives reconciliation matching).
- **`delivery_areas`**.
- **Cash-closing layers** (three, overlapping — see §7): `daily_cash_sessions` (oldest) → `pos_shifts` (per-cashier till session, the most rigorous) → `branch_days` (daily sign-off).
- **`pos_settings`** — global singleton config.
- **`home_tiles`** — dashboard tile config.

### 5.5 Delivery & Drivers
- **`drivers`** (optional `user_id`/`employee_id` links).
- **`driver_settlements`** — batch cash handover reconciliation, computed live from delivered-but-unsettled orders.
- **`driver_shifts`** — separate hourly-labor clock-in/out, auto-posts to `expenses`.

### 5.6 HR & Payroll
- **Login-account staff scheduling** (parallel system, see §7): `shifts`, `attendance_records`.
- **Full payroll HR system:** `employees` (`status` is source of truth; `is_active` trigger-derived for legacy compat; optional `user_id` self-service link), `employee_history` (append-only field-level change log), `employee_warnings` (append-only), `employee_leaves` (HR-recorded) vs `employee_leave_requests` (self-service, approval creates a `employee_leaves` row), `employee_fingerprint_codes` + `attendance_punches` (raw device data, no punch row = automatic absence), `central_kitchen_manual_attendance` (no-device fallback).
- **Payroll processing:** `payroll_settings`, `late_deduction_tiers`, `payroll_adjustments` (advance/penalty/bonus, optionally traced back to a shift/stocktake shortfall), `department_sales` (payroll-vs-sales comparison feed), `payroll_runs` (frozen monthly snapshot, DRAFT→APPROVED auto-posts a journal entry→CANCELLED reverses it, **UNIQUE(year,month) with no way to regenerate a month once any row exists for it — a real operational gap**), `payroll_run_employees` (per-employee frozen line + name snapshot), `payroll_payments` (actual disbursement).

### 5.7 Accounting (Double-Entry Ledger)
- **`accounts`** — chart of accounts, 6 fixed top-level types, `branch_id` NULL = shared.
- **`accounting_periods`** — month lock (OPEN/CLOSED).
- **`journal_entries`** → **`journal_entry_lines`** — DB-trigger-enforced balance (debit=credit) and immutability once POSTED (only reversal allowed, never edit/delete).
- **`fiscal_year_closings`** — year-end close, not reversible by design.
- **`treasuries`** — friendly naming layer 1:1 over `accounts` (MAIN/CASHIER/BANK), balance always derived live from `journal_entry_lines`.
- **`banks`**/**`bank_accounts`**.
- **`supplier_payments`**.
- **`approval_requests`** (generic async workflow) + **`approval_grants`** (single-use PIN-approval tokens, atomic claim-and-consume).

### 5.8 Payment Control & Reconciliation
- **`payments`** — one locked record per order (no split payments), method/channel frozen at lock time.
- **`payment_adjustment_requests`** — post-lock correction, gated by an approval-grant token.
- **`payment_reconciliation_records`** — manually entered external statement lines (Talabat/Visa/InstaPay/OrangeCash) vs. internal payments, deliberately manual-compare not auto-merge, batch-undo via `import_batch_id`.
- **`payment_audit_logs`** — payment-domain-specific audit log (overlaps `audit_logs` — see §7).
- **`payment_daily_report_log`** — idempotency guard for the scheduled owner report.

### 5.9 CRM & Customer Communication
- **`customer_followups`** — post-delivery QA call, upserted per order.
- **`customer_complaints`** — optionally linked to a followup, `category`/`status` lifecycle.
- **WhatsApp bot:** `whatsapp_conversations`, `whatsapp_messages` (append-only), `whatsapp_pending_orders` (AI-drafted, menu-validated, requires human confirmation before becoming a real order), `whatsapp_complaints` (near-duplicate shape of `customer_complaints` — see §7).

### 5.10 Customers & Loyalty
- **`customers`** — `phone` UNIQUE as primary identity, `loyalty_points`, optional online-account `password_hash`, block/unblock.
- **`customer_addresses`** — FK on `customer_phone` (not id), auto-accumulated from delivery orders.

### 5.11 Procurement
- **`suppliers`** — never hard-deleted (status instead).
- **Two parallel price-history tables** (see §7): `inventory_item_suppliers` (legacy, current-price-only) vs `supplier_items` (proper effective-dated history).
- **`purchase_requests`/`purchase_request_items`** → **`purchase_orders`/`purchase_order_items`** → **`goods_receipts`/`goods_receipt_items`** (the only point that posts inventory) → optional **`purchase_returns`/`purchase_return_items`**.
- **`supplier_ledger_entries`** — branch-vs-central-warehouse debt, relationship to the formal AP account (2100) not explicitly documented — needs investigation.
- **`supplier_invoices`/`supplier_invoice_lines`** — invoice document matched against GRN, posts only the variance.
- **Informal path** (parallel to the formal PO→GRN pipeline, see §7): **`purchases`/`purchase_items`**.

### 5.12 Production / Manufacturing
- **`production_orders`/`production_order_batches`** — formal lifecycle with variance tracking, multi-stage support via `parent_production_order_id`.
- **`packaging_orders`/`packaging_order_batches`** — deliberately mirrors production's shape (see §7).
- **`kitchen_orders`/`kitchen_order_items`** — branch→CK requisition (extended in place from a simple 3-state flow to a full DRAFT→...→RECEIVED lifecycle; both old and new status values remain valid).
- **`kitchen_transfers`/`kitchen_transfer_items`/`kitchen_transfer_item_batches`** — actual stock movement, batch-identity-preserving.
- **`transfer_discrepancies`** — receiving-side variance, corrections are new rows.

### 5.13 Stocktaking
- **`stocktakes`/`stocktake_lines`** — spot-check sessions, only non-zero-variance lines recorded; shortage can charge an account or a specific employee.
- **`stocktake_line_corrections`** — correction-of-a-correction pattern (never edit a posted line).

### 5.14 Printing
- **`kitchen_stations`** → **`printers`** → **`print_jobs`** (queue, atomic claim, idempotency-keyed, printing failure never blocks the order).

### 5.15 Inventory Ledger (cross-cutting backbone)
- **`inventory_movements`** — append-only, single source of truth, always written through a locking helper (`postInventoryMovement`) that computes before/after quantities to prevent races.

---

## 6. Cross-Cutting Architectural Patterns (worth keeping)

These recur throughout the schema and routes and represent genuinely sound design choices to preserve in a rebuild:

1. **Append-only ledgers, corrections-as-new-rows, never silent UPDATE/DELETE** — `inventory_movements`, `journal_entries`/lines (DB-trigger enforced), `audit_logs`, `employee_history`, `employee_warnings`, `order_status_log`, `whatsapp_messages`.
2. **Frozen-at-transaction-time snapshots** so later config changes never rewrite history — `cost_at_sale`, `loyalty_points_earned`, `vat_amount`, modifier `name_at_sale`/`price_at_sale`, `payments.method_kind`/`settlement_channel`, `payroll_run_employees` (whole row), `pos_shifts.expected_cash`.
3. **Never store a derived/summable balance — compute at read time**: supplier balance, treasury balance, payroll-payment remaining, PO remaining-quantity. Prevents drift between a cached number and its ledger source.
4. **Branch-scoping via `branch_id`** everywhere; NULL = company-wide/shared.
5. **Soft-delete/deactivation via status, never hard delete** for anything with transaction history: suppliers, menu categories, employees.
6. **Idempotency keys** on almost every write-once endpoint (orders, journal entries, payroll runs, print jobs, GRNs, stocktakes...) — nullable TEXT + partial unique index.
7. **Versioned/immutable-once-approved documents** (recipe_versions, journal_entries) — DB-enforced "only one active/posted state" via triggers and partial unique indexes.
8. **DB-level enforcement beyond CHECK constraints**: Postgres triggers for journal balance, POSTED immutability, `employees.is_active` derivation — a genuinely strong guarantee, not just application-level discipline.
9. **Atomic single-use claim tokens** (`approval_grants`, `print_jobs` claiming) via conditional `UPDATE ... WHERE status='ACTIVE'` — race-safe exactly-once consumption.
10. **Uniform, centrally-sanitized error handling** (`res.status(500).json({error: err.message})`, sanitized in production by `middleware/error-sanitizer.js`) — consistent across all 54 route files.
11. **"Own-daily" self-service permission convention** (`expenses.create_own_daily`, `shifts.open_own`, `payslips.view_own`, etc.) — a recurring, well-established "act on your own record only" pattern, currently reimplemented per-domain rather than as a shared primitive.

---

## 7. Duplication & Fragmentation Findings (consolidated)

Grouped by theme — several of these were independently spotted from the schema, routes, *and* pages angle, which is a strong signal they're real, not coincidental.

### 7.1 CRM / Complaints fragmentation (found from all three angles)
- **Schema:** `customer_complaints` and `whatsapp_complaints` are near-identical shape (same category/status/resolution enums), differing only by intake channel.
- **Routes:** `/api/crm` (phone follow-up complaints) and `/api/whatsapp` (bot-channel complaints) are two separate route files for what's largely the same concept.
- **Pages:** `satamoni-customers.html` is *both* a standalone page (5 roles, including cashier/accountant) *and* an iframe-embedded tab inside `satamoni-crm.html` (3 roles, including callcenter but not cashier/accountant) — two different role sets reaching overlapping functionality through two different entry points.
- **Recommendation:** one CRM/Complaints module with a `channel` column (phone/whatsapp/other), one route file, one page with role-appropriate views — not three parallel implementations.

### 7.2 Cash-closing layered over three eras
- **Schema:** `daily_cash_sessions` (oldest, simplest) → `pos_shifts` (per-cashier till, most rigorous — row-locked transactions, variance review workflow) → `branch_days` (daily sign-off checklist).
- **Routes:** `/api/cash-sessions` (role-based only, no transaction wrapping) looks like legacy/parallel to `/api/shifts` (full permission catalog, row-locked).
- **Recommendation:** audit whether `cash-sessions`/`daily_cash_sessions` is still live or dead weight; consolidate into one shift→day cash-closing model.

### 7.3 Expenses vs. Purchases (cash disbursements)
- **Routes:** `expenses.js` and `purchases.js` are near-identical in shape — categories, own-daily cashier tier, manager/accountant review→approve→post, cancel — down to the same permission-key naming convention.
- **Recommendation:** one "cash disbursements" module with a `type` discriminator instead of two parallel files/permission sets.

### 7.4 Production vs. Packaging
- **Routes:** `packaging.js`'s endpoints are structurally identical to `production.js` (same create→start→complete/cancel→approve lifecycle) and literally reuse `production.*` permission keys rather than defining their own.
- **Recommendation:** one parameterized "conversion order" concept (raw→intermediate = production, intermediate→packaged = packaging) instead of two route files/two schemas.

### 7.5 HR & Attendance spread thin across 5+ places
- **Schema:** `users`/`shifts`/`attendance_records` (login-account staff scheduling) vs. `employees`/`attendance_punches`/`employee_fingerprint_codes` (full payroll roster, mostly non-login staff) are explicitly documented as two **separate, parallel systems**.
- **Routes:** attendance/leave concerns are spread across `hr.js`, `employee-self.js`, `payroll.js` (punch import), and `attendance-sync.js` — five files with overlapping concepts.
- **Pages:** `satamoni-attendance.html` (personal clock-in/out) is separate from `satamoni-payroll.html` (attendance→payroll calculation) is separate from `satamoni-employee-self.html` (self-service attendance view).
- **Recommendation:** unify around `employees` as the one HR entity with `user_id` as an optional login attribute; one Attendance/HR domain with clear sub-resources (roster, attendance ingestion, leave, payroll processing) instead of phase-accumulated files.

### 7.6 Procurement's dual-path design (informal vs. formal)
- **Schema + Routes:** `purchases`/`purchase_items` (quick cashier cash purchase) runs parallel to the full `purchase_requests`→`purchase_orders`→`goods_receipts` pipeline, with an explicit duplicate-detection safeguard between them (checking supplier document numbers against GRNs) — acknowledged as intentional but real process duplication.
- **Recommendation:** consider modeling the informal path as a lightweight "PO-less GRN" rather than a wholly separate table/route/permission set.

### 7.7 Two supplier price-history tables
- **Schema:** `inventory_item_suppliers` (legacy, current-price-only, no history) vs. `supplier_items` (proper effective-dated price history) model the same relationship.
- **Recommendation:** drop `inventory_item_suppliers`, keep only `supplier_items`.

### 7.8 Recipe flat-projection tables
- **Schema:** `menu_item_variant_ingredients` and `manufacturing_recipe_items` are auto-generated read-model projections of the real versioned recipe engine (`recipes`/`recipe_versions`/`recipe_ingredients`), kept only for backward-compatible reads.
- **Recommendation:** drop the flat tables in a rebuild; read the recipe engine directly everywhere.

### 7.9 Ingredient-exclusion mechanism duplicated
- **Schema:** `order_item_modifiers.excluded_ingredient_item_id` and `order_item_excluded_ingredients` are two parallel mechanisms for excluding an ingredient from one order line's consumption/cost calc, both checked together in every consumption query.
- **Recommendation:** unify into one exclusion mechanism.

### 7.10 Reports: one 3400-line monolith + three overlapping report surfaces
- **Routes:** `/api/reports` spans at least 5 distinct domains (sales/ops, inventory, production/food-cost, purchasing, full accounting) in one file with mixed permission gating throughout.
- **Pages:** `satamoni-dashboard.html`, `satamoni-reports.html` (17 tabs), and `satamoni-accounting.html` (17 tabs, several overlapping with reports) each independently implement overlapping "sales"/"cost analysis" views for the same admin/accountant/branch_manager audience.
- **Recommendation:** one analytics/reporting layer, split by domain (`reports/sales`, `reports/accounting`, `reports/purchasing`, `reports/production`, `reports/inventory`) rather than one giant tab bar and one giant route file.

### 7.11 Frontend iframe-wrapping instead of real consolidation
- **Pages:** the team already recognized "too many screens" and "solved" it by literally `<iframe>`-embedding old standalone pages inside new tabbed wrapper pages, rather than merging code: `satamoni-procurement-hub.html` (99 lines) iframes 5 full pages (~6.2k lines total: requisitions, ck-requisitions, purchasing, manufacturing, production-planning); `satamoni-menu.html` iframes `satamoni-printing.html`; `satamoni-crm.html` iframes `satamoni-customers.html`. Migration comments explicitly say this was done "to avoid variable/function-name collisions between independently-written apps that all use the same globals" — a strong tell that this needs a real shared module system, not a workaround.
- **Recommendation:** genuine modular components/routes within one SPA with a shared session/auth module, not iframes of independent monoliths. This also fixes the silent-permission-mismatch problem where a role can open a wrapper page but have a tab inside it silently fail.

### 7.12 Auth/permission mechanism inconsistency
- Two coexisting authorization primitives (`requireRole` vs. `requirePermission`) across route files (see §2.2) — the newer, strictly-more-expressive `requirePermission` catalog should be the only one in a rebuild.

### 7.13 Transaction usage inconsistency
- Some mutating route files properly wrap writes in `BEGIN`/`COMMIT` with row locks (shifts, deliveries, orders, goods-receipts, accounting); others perform meaningful state mutations with bare `pool.query()` calls and no locking: `cash-sessions.js`, `crm.js`, `employee-self.js` (leave requests), `kitchen-stations.js`, `pos-settings.js`. Some of these are low-risk to leave as-is; `cash-sessions.js` (posts cash amounts) and `kitchen-stations.js` (multi-step routing writes) look like real concurrency gaps.

### 7.14 No shared frontend auth/session module
- All 28 pages duplicate the same `auth` object, `api()` fetch wrapper, login-overlay HTML/JS, and role-check/redirect logic independently. Any role/permission change requires editing up to 28 files consistently. This is the single biggest frontend argument for a rebuild as a real component framework with centralized auth/routing/permission-aware navigation.

### 7.15 Minor/naming issues
- `kitchen-orders.js` (branch→CK requisition) vs. `kitchen-transfers.js` (general stock transfer) vs. `kds.js` (live customer-order prep display) — three different "kitchen" concepts, easily confused names, flagged even in the codebase's own comments.
- `satamoni-ck-requisitions.html` layers a non-permission `isCentralKitchen` boolean flag on a branch — "central kitchen" arguably deserves to be a proper branch type/permission rather than an ad hoc flag special-cased in one screen.
- `satamoni-audit.html` bundles two fairly distinct concerns (audit-log viewer + stocktake-adjustment approval inbox) under one "audit" umbrella.
- `payroll_runs` has `UNIQUE(year, month)` with **no exemption for CANCELLED status and no delete/regenerate endpoint** — once any run (even a mistaken DRAFT or a cancelled one) exists for a month, that month can never get a new run. Confirmed live during this session's own testing — a genuine, currently-unaddressed operational gap.

---

## 8. Recommendations for a Clean Rebuild

Synthesizing everything above into concrete starting points:

### 8.1 Consolidated domain/module boundaries
Instead of today's ~15 route-file domains with several near-duplicates, a cleaner module map:

1. **Identity & Access** — staff auth, customer auth, roles, single permission-catalog mechanism (drop `requireRole`), centralized branch-scoping (middleware or query-builder concern, not copy-pasted per-handler).
2. **Catalog** — menu + combos + recipes (one versioned engine, no flat projection tables).
3. **Inventory & Ledger** — items, stock, movements, batches, stocktakes (the movement ledger stays the backbone).
4. **Orders & POS** — orders, payments (locked), one unified cash-closing model (replace the 3-layer daily_cash_sessions/pos_shifts/branch_days stack with one shift→day model).
5. **Delivery & Dispatch** — drivers, settlements, driver-shifts, delivery board.
6. **Procurement** — one pipeline: request→PO→GRN→returns→invoices→payments, with the informal cashier path modeled as a lightweight PO-less GRN instead of a separate `purchases` table.
7. **Production** — one parameterized "conversion order" (covers today's production + packaging).
8. **Accounting & Treasury** — chart of accounts, journal, treasuries, banks, AP (unify `supplier_ledger_entries` into the formal ledger once its actual usage is confirmed).
9. **Payment Control & Reconciliation** — as today, largely well-structured; keep.
10. **HR, Attendance & Payroll** — one `employees` entity (login optional via `user_id`), one attendance-ingestion path (manual/fingerprint/self-service all write the same underlying record), payroll processing, self-service view. Fix the payroll-run month-lock gap (allow delete of DRAFT, or a CANCELLED-exempt unique constraint).
11. **CRM & Communications** — one complaints/followups model with a `channel` column, covering both phone and WhatsApp intake; WhatsApp bot stays a separate ingestion adapter but writes into the same CRM tables.
12. **Customers & Loyalty** — as today; make sure it's reached through exactly one entry point (not standalone + iframe).
13. **Reporting & Analytics** — one reporting layer, split by domain, replacing the reports.js monolith and the dashboard/reports/accounting triple-overlap.
14. **Printing** — as today; reasonably well-scoped already.

### 8.2 Frontend architecture
- Build a **real SPA or component framework** with one shared auth/session/permission module and a role-aware navigation shell — eliminate the 28x-duplicated boot logic and the iframe-wrapping workaround entirely.
- Give every role a genuinely tailored landing view (not just cashier/callcenter/driver/employee) — `branch_manager` and `accountant` currently see the generic admin-shaped tile grid with tiles they can't use.
- Split the largest "kitchen sink" pages (accounting's 17 tabs, reports' 17 tabs, pos.html's 3049 lines) along the module boundaries in §8.1 rather than growing one more tab onto an existing pile.

### 8.3 Permission model
- Drop `requireRole` entirely; standardize on the permission-catalog mechanism (strictly more expressive, already supports per-user overrides).
- Formalize the "own-daily"/"view_own"/"manage_own" self-service pattern as a reusable ownership-check primitive instead of reimplementing it per domain.
- Consider promoting `isCentralKitchen` from an ad hoc branch flag to a real permission/branch-type concept.

### 8.4 Data model
- Drop the legacy flat projection tables (`menu_item_variant_ingredients`, `manufacturing_recipe_items`) and `inventory_item_suppliers`.
- Merge `customer_complaints`/`whatsapp_complaints` and `audit_logs`/`payment_audit_logs` into single tables with a discriminator column.
- Keep the strong patterns from §6 as-is: append-only ledgers, frozen snapshots, computed-not-stored balances, idempotency keys, DB-trigger-enforced immutability on posted financial records — these are genuinely good design, not something to "clean up."
- Investigate and resolve `supplier_ledger_entries`'s relationship to the formal AP ledger before carrying it forward.

### 8.5 What NOT to change
- The double-entry accounting core (`accounts`/`journal_entries`/`journal_entry_lines`) with its trigger-enforced balance and immutability — this is a genuinely strong foundation.
- The inventory movement ledger as the single source of truth for stock.
- The frozen-snapshot pattern for sale-time cost/price/tax data — critical for historical accuracy.
- The four-domain auth separation (staff/customer/sync/webhook) — these are legitimately different trust boundaries, not accidental duplication.
