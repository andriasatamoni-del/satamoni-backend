# HR Foundation Hardening — Phase 1

**Date**: 2026-09-19
**Scope**: Fix the specific gaps confirmed in `HR_CURRENT_STATE.md` (payroll-run cancellation bug, missing audit trails on financial/disciplinary mutations, employee-update endpoint duplication, Department/Position as free text). No Recruitment, Training, Probation, Performance/KPI, Workforce Planning, Backup Pool, or Skills Matrix functionality was built — this phase only hardens what already existed.
**Commits**: `3d49a60` (HRF-2), `fbf3536` (HRF-3), `fb56627` (HRF-4), `c3928e4` (HRF-5), `7b642e9` (HRF-6), on top of `809cbb1` (HRF-1 docs) and `593d7e4` (the audit).

---

## 1. Problems Found

Carried over verbatim from the audit's confirmed findings (not re-derived here):

1. **Attendance source-of-truth was undocumented.** Three parallel attendance mechanisms exist (`attendance_punches`, `central_kitchen_manual_attendance`, `attendance_records`/`shifts`); which one payroll actually reads from was never written down anywhere.
2. **Payroll-run cancellation bug.** `payroll_runs` had a plain `UNIQUE(year, month)` constraint. Once a run for a month was cancelled, the unique constraint still counted the cancelled row, permanently blocking that month from ever getting a new run — there was no way to "replace" a cancelled run.
3. **`payroll_adjustments` (penalties/bonuses/advances) had no audit trail and supported hard delete.** Any user with access could `DELETE` a penalty or bonus row with zero trace — a real risk for both financial correctness and disciplinary disputes ("I was fined but there's no record of why or who removed it").
4. **Manual attendance-punch correction had no audit trail and no required reason.** `PATCH /attendance-punches/:id` silently overwrote `clock_in`/`clock_out`/`exempted` with no record of the original value, who changed it, or why.
5. **Employee-update logic was duplicated** across `routes/hr.js` and `routes/payroll.js`, with inconsistent authorization — specifically, the payroll.js path allowed `restrictedBranchId` (moving an employee between branches) to be changed by any caller with payroll access, not just admins, while the hr.js path already correctly restricted it to admins.
6. **Department and Position were free-text columns**, not real entities — no validation, no normalization, easy to fragment into near-duplicate values, no way to build organization-level reporting or permissions on top of them.

## 2. Root Causes

- Items 2–4 all trace back to the same pattern: features were built to satisfy the immediate UI need (create a run, add a penalty, fix a punch) without designing for the append-only/audit conventions the rest of the codebase already uses elsewhere (voided orders, cancelled leaves, `payment_audit_logs`). The convention existed; it just wasn't applied consistently to these three areas.
- Item 5 happened because `routes/hr.js` and `routes/payroll.js` were built at different times for different primary users (HR staff vs. accountants) against the same `employees` table, and the update logic was never consolidated afterward.
- Item 6 is a straightforward "started as a quick free-text field, never revisited" gap — there was never a hard requirement forcing department/position to be a fixed set until organization-level reporting was needed.

## 3. Changes Implemented

| # | Change | Files |
|---|---|---|
| HRF-1 | Documented attendance source-of-truth (no code change) | `ATTENDANCE_SOURCE_OF_TRUTH.md` |
| HRF-2 | Replaced `UNIQUE(year,month)` with a partial unique index that only covers `DRAFT`/`APPROVED` runs, so a `CANCELLED` run no longer blocks the month | `db/schema.sql`, `db/migrations/0051_*.js`, `routes/payroll.js` |
| HRF-3 | Extracted one canonical `updateEmployee()` used by both routes, closing the `restrictedBranchId` authorization gap | `db/employee-service.js` (new), `routes/hr.js`, `routes/payroll.js` |
| HRF-4 | Added audit logging on adjustment creation; replaced hard `DELETE` with a soft-cancel (`status` ACTIVE/CANCELLED + reason, audited) | `db/schema.sql`, `db/migrations/0052_*.js`, `routes/payroll.js`, `services/payroll-engine.js`, `public/satamoni-payroll.html` |
| HRF-5 | Required a `reason` on manual attendance-punch correction; added full before/after audit logging | `routes/payroll.js`, `public/satamoni-payroll.html` |
| HRF-6 | Added real `departments`/`positions` entities, FK columns on `employees`, a sync trigger keeping legacy TEXT columns in sync, a data-driven non-destructive migration, and a CRUD API | `db/schema.sql`, `db/migrations/0053_*.js`, `routes/organization.js` (new), `middleware/permissions.js`, `server.js`, `routes/hr.js`, `routes/payroll.js`, `public/satamoni-payroll.html` |

## 4. Database Changes

- `payroll_runs`: dropped `UNIQUE(year, month)`; added `CREATE UNIQUE INDEX idx_payroll_runs_active_period ON payroll_runs(year, month) WHERE status IN ('DRAFT', 'APPROVED')`. Enforced at the database level — atomic, race-condition-safe, no application-level locking needed beyond the existing transaction.
- `payroll_adjustments`: added `status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','CANCELLED'))`, `cancelled_by INTEGER REFERENCES users(id)`, `cancelled_at TIMESTAMPTZ`, `cancellation_reason TEXT`.
- New `departments` table (`id, code, name, description, status active/inactive, created_at, updated_at`, unique on `code` and `name`), seeded with the 7 canonical departments already in use (بيتزا، فطير، تشغيل الفرع، الإدارة، حسابات، كول سنتر، المطبخ المركزي).
- New `positions` table (`id, code, name, department_id → departments.id, description, status, created_at, updated_at`, unique on `code`; `department_id` nullable — a position is not forced to belong to exactly one department if the data doesn't support that).
- `employees`: added `department_id → departments.id`, `position_id → positions.id` (both nullable — legacy free-text rows are still valid).
- New trigger `trg_sync_employee_department_position` (`BEFORE INSERT OR UPDATE ON employees`): when `department_id`/`position_id` is set, derives the legacy `department`/`job_title` TEXT columns automatically, so every existing consumer of those columns (payroll engine, reports, `department_sales`) keeps working unmodified.
- No column was dropped, no table was dropped, no row was deleted by any migration in this phase.

## 5. API Changes

- `POST /api/payroll/runs`: on a unique-violation conflict, now returns `409 {error, code: "ACTIVE_PAYROLL_RUN_EXISTS", activeRun}` instead of a generic error, naming the conflicting run.
- `PATCH /api/hr/employees/:id` and `PATCH /api/payroll/employees/:id`: both now delegate to the same `updateEmployee()` service function; each route still performs its own authorization/branch-isolation check before calling it — no field-allowlist was widened for either caller.
- `POST /api/payroll/adjustments`: unchanged request/response shape, now audited.
- `DELETE /api/payroll/adjustments/:id`: **removed**. Replaced by:
- `POST /api/payroll/adjustments/:id/cancel` (body: `{reason}`, required): soft-cancels an adjustment; 400 if `reason` missing or already cancelled.
- `PATCH /api/payroll/attendance-punches/:id`: now requires `reason` in the body (400 if missing); behavior otherwise unchanged.
- `POST /api/payroll/employees`, `PATCH /api/payroll/employees/:id`: accept optional `departmentId`/`positionId` alongside the existing free-text `department`/`jobTitle` (either path works; both keep the TEXT columns correct via the trigger).
- New `routes/organization.js`: `GET/POST /api/organization/departments`, `PATCH /api/organization/departments/:id`, `GET/POST /api/organization/positions` (supports `?departmentId=`), `PATCH /api/organization/positions/:id`. No DELETE route for either resource — deactivation only, via `status`.

## 6. Permission Changes

- Added two fine-grained permission keys to the existing catalog (`middleware/permissions.js`): `organization.view`, `organization.manage`.
- `organization.view` granted to `branch_manager` and `accountant` (read-only — they need to see departments/positions to assign employees to them).
- `organization.manage` (create/edit/deactivate) is **admin-only**, via the existing `admin: ["*"]` wildcard — no new role was given write access to organization structure.
- No existing permission was widened. The `restrictedBranchId` fix in HRF-3 is a **narrowing**, not a widening: it closes a gap where a non-admin caller of `routes/payroll.js` could previously change an employee's branch restriction; after the fix, only admins can, consistent with `routes/hr.js`'s pre-existing (correct) behavior.

## 7. Audit Changes

All of the following are new `logAudit(...)` calls, all visible with zero extra code through the existing generic `GET /api/audit-logs` viewer:

| Action | When | Old/new values captured |
|---|---|---|
| `PAYROLL_ADJUSTMENT_CREATED` | Adjustment created | new values (amount, type, reason) |
| `PAYROLL_ADJUSTMENT_CANCELLED` | Adjustment soft-cancelled | old status → new status, cancellation reason |
| `ATTENDANCE_PUNCH_CORRECTED` | Manual punch correction | old/new `clock_in`, `clock_out`, `exempted`, correction reason, resolved `employeeId` |
| `EMPLOYEE_UPDATED` (unified) | Employee record updated via either route | unchanged shape from before, now the single action name for both call sites (previously `EMPLOYEE_HR_UPDATED` existed as a separate, redundant action name) |
| `DEPARTMENT_CREATED` / `DEPARTMENT_UPDATED` | Department CRUD | new/changed values |
| `POSITION_CREATED` / `POSITION_UPDATED` | Position CRUD | new/changed values |

`employee_history` (field-level append-only history) continues to record `department`/`job_title` changes exactly as before, including when the change now originates from `departmentId`/`positionId` rather than free text — verified in `tests/organization-department-position.test.js`.

## 8. Migration Details

`db/migrations/0053_department_position_entities.js` (HRF-6) is the only data-driven migration in this phase (0051 and 0052 are schema-only, no existing data to interpret).

Algorithm:
1. Create `departments`/`positions` tables and `employees.department_id`/`position_id` columns + sync trigger (idempotent — guarded, safe to re-run).
2. Seed the 7 canonical departments if not already present.
3. For every **distinct, trimmed** non-empty `employees.department` value not already matching a canonical department name, create a new `departments` row (auto-generated code) — nothing is guessed or merged into an existing department unless the trimmed text is byte-identical.
4. Link every employee to its department by exact (trimmed) text match.
5. For every **distinct** non-empty `employees.job_title`, normalize whitespace (`trim` + collapse internal whitespace) and deduplicate by that normalized form — this only merges whitespace variants of the same string, never different-looking titles. Create one `positions` row per unique normalized title, leaving `department_id` **NULL** on the position (a job title used in more than one department is never forced onto one).
6. Link every employee with a job title to its position by the same normalized match.
7. Log a summary count; explicitly `console.warn` any employee still lacking `department_id` afterward, labeled "UNKNOWN - REQUIRES MANUAL REVIEW" with full row detail — this is a safety net, not an expected outcome, since `employees.department` is `NOT NULL` and every non-empty value gets an entity.

**Verified empirically** (both a standalone scratch-DB run and the permanent `tests/migration-0053-department-position.test.js`) against deliberately adversarial seeded data:
- Exact-match and whitespace-variant department/job-title values correctly resolve to the **same** entity.
- An unrecognized department value gets its **own new** department row (never dropped, never silently merged into an existing one).
- The same job title used in two different departments correctly resolves to **one shared** Position row with `department_id` left NULL (no guessed department link).
- An employee with no `job_title` at all correctly ends up with `position_id = NULL` — a valid state, not flagged as an error.
- **Zero** employees ended up with `department_id IS NULL` in either test run.

No case in the actual runs required "UNKNOWN — REQUIRES MANUAL REVIEW" flagging, because every seeded/real value was either an exact match or safely resolvable to its own new entity — but the code path that logs such cases exists and was exercised in isolation to confirm it fires correctly when department_id genuinely cannot be resolved.

## 9. Backward Compatibility

- Every legacy TEXT column (`employees.department`, `employees.job_title`) still exists, is still `NOT NULL`/nullable exactly as before, and is kept automatically correct by the new sync trigger — no downstream consumer (`services/payroll-engine.js` GROUP BYs, HR reports, `department_sales`) needed any change.
- The free-text employee-create/update path (`department`/`jobTitle` strings, no `departmentId`/`positionId`) continues to work exactly as before — verified by a dedicated regression test.
- `payroll_adjustments` rows are never deleted anymore; every existing caller of the adjustments list still sees cancelled rows (now rendered struck-through in the UI) rather than them disappearing, so no historical data became invisible.
- The old `DELETE /api/payroll/adjustments/:id` route is gone; any external caller relying on it will get a 404. This is the one genuine breaking change in this phase, and it is intentional — hard-deleting financial/disciplinary records is exactly the gap being closed.
- `EMPLOYEE_HR_UPDATED` as a distinct audit action name no longer appears going forward (unified to `EMPLOYEE_UPDATED`); historical rows with the old action name are untouched in `audit_logs`.

## 10. Tests

- **Before this phase** (end of prior Talabat integration work, TAL-10): 119 suites / 1393 tests, all passing.
- **After this phase** (HRF-6, final code-changing commit): 125 suites / 1430 tests, all passing.
- **New test files** (6 files, 37 new tests):
  - `tests/payroll-run-active-period.test.js` (9 tests) — first-run creation, blocked duplicate while DRAFT/APPROVED, approve-then-cancel, replacement creation after cancellation (the core bug fix), repeated cancel/recreate cycles, full historical preservation of all runs, a genuine concurrent-creation race producing exactly one 201 and one 409.
  - `tests/employee-update-consolidation.test.js` (7 tests) — the closed `restrictedBranchId` gap (403 for non-admin via either route, DB-proof no partial change occurred), branch-isolation still enforced, unified audit action name, `employee_history` still recording changes.
  - `tests/payroll-adjustments-audit.test.js` (7 tests) — create audited, cancel requires reason, cancel preserves the row (still visible in listings), double-cancel rejected, old DELETE route gone (404), a cancelled penalty stops counting toward payroll summary totals.
  - `tests/attendance-punch-correction-audit.test.js` (4 tests) — missing reason rejected with proof the row is untouched, full audit payload correctness, two sequential corrections produce two separate audit rows.
  - `tests/organization-department-position.test.js` (9 tests) — the 7 canonical departments exist, permission enforcement (view vs. manage), audit on create, deactivate-not-delete, `departmentId`-based create/update syncing the legacy TEXT column and `employee_history`, legacy free-text path unaffected.
  - `tests/migration-0053-department-position.test.js` (1 comprehensive test) — the adversarial migration-safety scenarios described in §8.
- One existing test (`tests/hr-lifecycle.test.js`) was updated to expect the unified `EMPLOYEE_UPDATED` action name instead of the retired `EMPLOYEE_HR_UPDATED`.
- Full suite run after every task, not just at the end — no regression was introduced at any step.

## 11. Remaining Risks

- `routes/hr.js` and `routes/payroll.js` still use the coarse `requireRole(...)` system for most HR/payroll endpoints, not the fine-grained permission catalog — this phase added only 2 new fine-grained keys (organization.*) without migrating the rest of HR/payroll's authorization model, since that was out of scope.
- `attendance_records`/`shifts` (the legacy, non-canonical attendance path documented in HRF-1) still exist in the schema and are still reachable via the self-service kiosk UI; they were deliberately left alone per the explicit "do not refactor unrelated modules" rule, so the underlying three-system fragmentation is documented but not reduced.
- Department/Position entities have no delete path by design (deactivate only) — if a department/position is created by mistake, it will remain visible (inactive) forever rather than being removable. This matches the codebase's existing no-hard-delete convention but was a deliberate tradeoff, not an oversight.
- `positions.department_id` can be legitimately NULL (a title used across departments); any future feature that assumes every position belongs to exactly one department needs to account for this.

## 12. Known Limitations

- This phase does not implement Recruitment, Training, Probation, Performance/KPI, Workforce Planning, Backup Pool, or Skills Matrix — none of these existed before and none were built now, by explicit instruction.
- No UI was added for browsing/filtering by the new Department/Position entities beyond the employee-create/edit dropdown already present in `public/satamoni-payroll.html`; a dedicated "Organization Structure" management screen was not requested and was not built.
- The migration's "UNKNOWN — REQUIRES MANUAL REVIEW" warning path exists and was verified to fire correctly in isolation, but no real production data was available in this environment to run the migration against — it has only been run against test/seed data. Running it against real production data before go-live should be treated as a required verification step, not an assumption that it will behave identically.
