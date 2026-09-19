# HR / Personnel / Workforce — Current-State Audit

**Date**: 2026-09-19
**Scope**: Full repository audit (code, schema, routes, frontend, permissions, audit trail). No code was modified, no migrations were run, no routes or UI were added. This is a documentation-only deliverable.
**Method**: Every claim below is backed by a specific file/table/line found in this repository during this audit — not by filename assumption. Where end-to-end proof (frontend → API → DB → validation → permission → audit) was not fully traced, the item is marked **UNKNOWN — REQUIRES VERIFICATION**.

---

## PART 1 — Discovery Summary

Searched the full repo (routes/, services/, db/, public/, middleware/, tests/, schema, migrations) for every keyword group requested (HR, attendance, ZKTeco, payroll, penalties/rewards, recruitment, shifts, training, probation, performance/KPI, workforce planning, documents).

**Found and real (backed by code + schema + tests)**:
- Employee master data (`employees` table + `routes/hr.js` + `routes/payroll.js`)
- Attendance via three parallel mechanisms (see Part 4)
- A real ZKTeco local-agent integration (`attendance-agent/`), **never tested against a physical device**
- Shifts (two unrelated tables named `shifts`, both thin)
- Leave (request → approval workflow), explicitly **not** wired into payroll
- A genuine payroll calculation **engine** (`services/payroll-engine.js`), not just a screen
- Payroll run lifecycle (DRAFT → APPROVED → CANCELLED) with journal-entry posting
- Penalties/bonuses/advances as a single flat table (`payroll_adjustments`) — no workflow, no evidence, no acknowledgment
- Employee warnings (append-only) — a `Penalties` concept for HR write-ups, but separate from the payroll-money penalties
- Employee termination cascade with blocker-detection (open shifts, unpaid payroll, debt) — a genuinely well-built piece
- Employee self-service portal (payslips/leave/attendance, read-only + leave request)
- HR reports (9 report endpoints in `routes/hr.js`)

**Searched for and found NO trace of anywhere in code, schema, or migrations** (only in filename-adjacent false positives like generic "candidate"/"kpi" CSS class/variable names — verified and ruled out):
- Recruitment / candidates / vacancies / hiring pipeline
- Training / onboarding / SOP certification / trainer / training history
- Probation period tracking / confirmation / extension
- Performance reviews / KPI / scoring / goals (employee-level; the "kpi" hits found are dashboard sales-stat CSS classes, unrelated to people)
- The specific "Shift Manager KPI" system named in the request (`manager_shifts`, `shift_staffing`, `shift_incidents`, `shift_checklists`, `checklist_items`, handover, manager score, critical-incident gate) — **the exact phrase "Shift Manager KPI" does not appear anywhere in this repository, and none of those table names exist in `db/schema.sql`.** This system, if it was ever built, is not in this codebase. Treat it as **NOT IMPLEMENTED**, not partially implemented.
- Workforce planning / staffing plan / required-vs-actual headcount / backup pool / skills matrix / cross-training / position vacancy
- Position/Department as normalized entities (they are free-text columns on `employees`, not tables)
- Employee documents/attachments/personnel-file storage (contracts, ID scans, certificates, photos)
- National ID, date of birth, address, bank/wallet account, emergency contact — none of these columns exist on `employees`

---

## PART 2 — Employee Master Data

Table: `employees` (`db/schema.sql:1586`). Columns actually present: `id, user_id, name, department, job_title, attendance_system, hire_date, base_salary, working_days_per_month, shift, wage_type, hourly_rate, phone, notes, is_active, count_day_31, restricted_branch_id, employee_code, status, termination_date, termination_reason, created_at`.

| Field | Status | Evidence |
|---|---|---|
| Employee ID | **Implemented** | `employees.id` + auto `employee_code` (`EMP-000001…`, sequence-generated) |
| Name | **Implemented** | `employees.name` |
| Phone | **Implemented** | `employees.phone` |
| National ID | **Missing** | No column anywhere |
| Address | **Missing** | No column anywhere |
| Date of Birth | **Missing** | No column anywhere |
| Hire Date | **Implemented** | `employees.hire_date`, used in tenure/new-hires reports |
| Employment Status | **Implemented** | `status` enum (`active/suspended/resigned/terminated`) + trigger-derived `is_active`, full history table |
| Branch | **Partial** | Only `restricted_branch_id` — an *optional single-branch lock*, not a real "assigned branch." An employee with `NULL` here is valid for all branches by design (fingerprint attendance resolves branch via `employee_fingerprint_codes` per branch instead) |
| Department | **Partial** | Free TEXT column, no lookup table, no validation against a fixed list beyond convention in comments |
| Position / Job Title | **Partial** | Free TEXT column (`job_title`), same limitation |
| Shift | **Partial** | Enum `morning/evening/flexible` — a *category*, not a scheduled shift record |
| Manager | **Missing** | No `manager_id`/`reports_to` column on `employees` at all |
| Salary | **Implemented** | `base_salary`, `hourly_rate`, `wage_type` — feeds the real payroll engine |
| Payment Method | **Partial** | `payroll_payments.payment_method_id` exists at the *payment* level (cash/bank per payslip payment), but nothing on the employee record itself (no default/preferred method) |
| Bank/Wallet data | **Missing** | No column anywhere |
| Emergency Contact | **Missing** | No column anywhere |
| Documents | **Missing** | No table/column/upload path for employee documents |
| Notes | **Implemented** | `employees.notes` (free text) |
| Employee photo | **Missing** | No column, no upload endpoint |
| Skills | **Missing** | No table |
| Certifications | **Missing** | No table |

**API**: `GET/POST /api/payroll/employees`, `PATCH /api/payroll/employees/:id`, `GET/PATCH /api/hr/employees/:id` (see Part 16/17 for the duplication between these two).
**Frontend**: `public/satamoni-payroll.html` (employee list/edit tab).
**Permissions**: `routes/hr.js` gates its employee endpoints with `requireRole("admin","branch_manager")`; `routes/payroll.js` gates its (overlapping) employee endpoints with `requireRole("admin","accountant")`. Neither uses the fine-grained permission catalog.
**Audit trail**: `employee_history` (field-level, append-only) + `logAudit(... "EMPLOYEE_UPDATED"/"EMPLOYEE_HR_UPDATED")` on both PATCH paths — **implemented and real**.

---

## PART 3 — Organization Structure

Actual model: **Branch → Employee** only. There is no `departments` table, no `positions` table, and no manager hierarchy.

- Company: implicit (single tenant, not modeled as an entity — not needed for a single restaurant chain).
- Branch: real table (`branches`).
- Department: a free-text string on `employees.department`. No CRUD, no fixed enum enforced at the DB level (just comment convention: "بيتزا/فطير/تشغيل الفرع/الإدارة/حسابات/كول سنتر/المطبخ المركزي").
- Position/Job Title: free-text string on `employees.job_title`. Same limitation.
- Employee → Manager: **not modeled**. No column, no table.
- Multiple branches per employee: **not supported** structurally. `restricted_branch_id` is a single optional lock; the *actual* multi-branch reality (e.g., a driver or fingerprint-tracked employee clocking in at different branches) is handled per-branch via `employee_fingerprint_codes` (one row per branch per employee) — so an employee *can* have attendance at multiple branches, but this is an attendance-table side effect, not a modeled "assigned branches" concept.
- Temporary branch transfer: **not modeled** as a first-class concept (no start/end date transfer record). A permanent `restricted_branch_id` change is logged in `employee_history`, but there is no "temporary assignment expires on X date" feature.
- Secondary skills/positions: **Missing** entirely.

**Conclusion**: Organization structure is minimal — Branch and Employee are real; Department/Position/Manager are conventions in a text field, not enforced structure.

---

## PART 4 — Attendance (Critical)

**This is the most fragmented area in the HR system: there are three separate, non-overlapping attendance data paths.**

### Path A — `attendance_records` (login-account clock-in/out)
- Table: `attendance_records` (`user_id, branch_id, business_date, clock_in, clock_out`) — no `late`, `early_leave`, `overtime`, `grace_period`, or `status` columns at all.
- Routes: `POST /api/hr/attendance/clock-in`, `POST /api/hr/attendance/clock-out`, `GET /api/hr/attendance` (`routes/hr.js:65-163`), open to `anyStaff` (admin/branch_manager/accountant/cashier/callcenter).
- Frontend: `public/satamoni-attendance.html` — a self-clock-in kiosk page tied to the `shifts` table for shift assignment display.
- **Verified fact: this path is never read by `services/payroll-engine.js`.** Grepped the engine directly — zero references to `attendance_records`. This entire attendance mechanism has **no effect on payroll, no late/absence computation, no lock, no correction workflow, no approval step**. It looks like an earlier/legacy attendance concept that was superseded by Path B but never removed.
- **Status: Implemented but functionally orphaned from payroll.** Real code, real table, real frontend page — but it does not feed the one thing attendance is supposed to feed.

### Path B — `attendance_punches` (ZK device / fingerprint import) — **this is the one payroll actually uses**
- Table: `attendance_punches` (`branch_id, device_code, punch_date, clock_in, clock_out, exempted`), `UNIQUE(branch_id, device_code, punch_date)`.
- Mapping: `employee_fingerprint_codes` (`employee_id, branch_id, device_code`) — lets one employee have different device codes per branch.
- Import path 1 (manual/bulk): `POST /api/payroll/attendance-punches/import`, `POST /api/payroll/import-excel` (Excel workbook import via `db/payroll-excel-import.js`).
- Import path 2 (device, near-real-time): `POST /api/attendance-sync/punches` (`routes/attendance-sync.js`), consumed by the `attendance-agent/` local process (see ZKTeco section below).
- Manual correction: `PATCH /api/payroll/attendance-punches/:id` — **verified: zero `logAudit` call, no "before" state captured, no reason field.** Anyone with payroll access can silently rewrite a punch's clock-in/out or flip `exempted` (which removes a late-deduction) with no trace of who did it or why. **This is the single most important audit-trail gap found in this system** — see Part 15/22.
- Computation: `services/payroll-engine.js:20,194` joins `attendance_punches` directly for late/absence/overtime/missed-punch calculation, driven by `payroll_settings` (grace period is implicit in `late_deduction_tiers`, standard shift hours, overtime multiplier) — **this is a real calculation engine**, not a placeholder.
- Missing punch handling: `missed_punch_deduction_fraction` in `payroll_settings` — **Implemented** (a day with no punch gets a configurable fractional deduction).
- Attendance lock: **Missing** — nothing prevents editing `attendance_punches` for a month that has already been included in an **APPROVED** `payroll_run` (the run snapshots the numbers into `payroll_run_employees`, so a post-approval punch edit doesn't retroactively corrupt the approved run's totals, but it does mean the *next* run for a corrected period could be recomputed inconsistently with no lock signal).
- Attendance approval workflow: **Missing** — punches are corrected directly, no request → approve step (unlike leave, which has one).

### Path C — `central_kitchen_manual_attendance` (non-fingerprint staff)
- Table: one row per employee per month (`present_days, absent_days, total_late_minutes, manual_deduction`), entered by hand.
- Routes: `GET/POST /api/payroll/central-kitchen-attendance`.
- Used by `services/payroll-engine.js:254` for employees with `attendance_system = 'manual'`.
- **Status: Implemented, and correctly wired into payroll** — but it is a manual monthly aggregate, not day-by-day punches, so it can't support the same late-deduction-tier granularity Path B gets.

### ZKTeco Integration — direct answer to the audit's specific question

| Question | Answer |
|---|---|
| Device integration? | **Yes, as code** — `attendance-agent/device-client.js` uses the `node-zklib` npm package, standard ZKTeco TCP/IP protocol on port 4370. |
| API? | Yes — `POST /api/attendance-sync/punches`, gated by permission `attendance.sync_device`. |
| ADMS? | **No.** This is agent-polls-device (pull), not device-pushes-to-server (ADMS/push-SDK). Default poll interval 300s (`attendance-agent/index.js`). |
| ZKBio integration? | **No** — talks to a raw device via `node-zklib`, not to a ZKBio Time server/API. |
| Attendance import? | Yes — both the live agent path and a manual Excel/CSV import path exist. |
| Employee/device mapping? | Yes — `employee_fingerprint_codes`. |
| Device logs? | Only a `console.log` from the agent process itself; nothing persisted server-side (no `device_sync_log` table). |
| Duplicate prevention? | Yes — `ON CONFLICT (branch_id, device_code, punch_date) DO UPDATE` upsert, both on manual import and agent sync. |
| Offline device handling? | Minimal — the agent catches errors per poll cycle and just logs + retries next interval; no backoff, no alert, no persisted failure state. |
| Sync status? | **Missing** — no "last synced at" timestamp or dashboard surfaced for attendance sync (unlike the unrelated `branches.last_synced_at` field, which is for a different subsystem — local POS sync, not attendance). |
| Failed sync handling? | **Missing** — failures are console-logged only; no admin-facing alert, no `talabat`-style integration-errors equivalent for attendance. |
| **Tested against a real device?** | **No — explicitly, in the code's own comment** (`attendance-agent/device-client.js:1-6`): *"معندناش جهاز ZK حقيقي نجربه عليه من هنا (بيئة sandboxed)"* — "we don't have a real ZK device to test this against, from this sandboxed environment." The field-name mapping (`deviceUserId`, `recordTime`) is based on the library's documented shape, not a verified real device response. **UNKNOWN — REQUIRES VERIFICATION against real hardware before production trust.** |

There is a real, passing test suite for the agent's own pure logic (`tests/attendance-agent-group-punches.test.js`, grouping raw punches into first/last per employee/day), but that only proves the grouping algorithm, not the device protocol against real firmware.

---

## PART 5 — Shifts

Two entirely separate tables both named "shift", covering different domains:

1. **`shifts`** (`db/schema.sql:1524`) — `user_id, branch_id, shift_date, start_time, end_time, notes`. A simple scheduled-shift record for login-account staff. CRUD via `GET/POST /api/hr/shifts`. No templates, no morning/night type field beyond free start/end times, no overnight-shift handling logic visible, no swap, no actual-vs-scheduled comparison, no shift status field.
2. **`pos_shifts`** — a *cashier cash-drawer session* (open/close, expected vs actual cash) — this is a POS/cash-control concept, unrelated to HR scheduling, but shares the word "shift." Referenced by `payroll_adjustments.shift_id` (a cash-shortfall becomes a payroll penalty).
3. `employees.shift` — a third, unrelated use of the word: just an enum category (`morning/evening/flexible`), not a schedule.

**Direct answers**:
- Shift Templates: **Missing**.
- Morning/Night Shift: **Partial** — only as the `employees.shift` category, not as a real template with defined hours (though `payroll_settings.morning_shift_start`/`evening_shift_start` give a *company-wide* pair of start times used somewhere in payroll logic — **UNKNOWN — REQUIRES VERIFICATION** exactly how these two settings interact with per-employee `shift` category in `payroll-engine.js`, not traced in this pass).
- Scheduled Start/End: **Implemented** for the `shifts` table (per-instance, not template-driven).
- Overnight Shift: **UNKNOWN — REQUIRES VERIFICATION** (no explicit handling seen in `shifts`; payroll's late/overtime math around midnight-crossing shifts was not traced in this pass).
- Employee/Manager Assignment: **Partial** (assignment yes via `shifts.user_id`; no manager-of-shift concept).
- Shift Swap: **Missing**.
- Temporary Assignment: **Missing**.
- Branch Assignment: **Implemented** (`shifts.branch_id`).
- Actual Start/End vs scheduled: **Missing** (no actual clock times linked back to a specific `shifts` row).
- Shift Attendance/Status: **Missing**.

**Conclusion**: "Shifts" as scheduling is a thin, disconnected table; it is not the same system that drives payroll (that's attendance_punches), and it is not the same system as `pos_shifts` (cash-drawer sessions) despite the name overlap.

---

## PART 6 — Leaves & Absences

Tables: `employee_leaves` (approved/recorded record) and `employee_leave_requests` (pending → approved/rejected/cancelled, with `resulting_leave_id` linking to the leave it created on approval).

| Item | Status |
|---|---|
| Annual/Sick/Unpaid/Casual leave types | **Implemented** (`leave_type` enum: `annual, sick, unpaid, casual`) — no separate "emergency" or "permission/short leave" type. |
| Leave Balance | **Partial** — `GET /api/hr/reports/leave-balance` exists, but the schema comment states it explicitly: *"تقرير رصيد الإجازات تقديري بس"* ("the leave-balance report is an estimate only") — there is no `leave_balance` ledger/accrual table, it's computed ad hoc from usage. |
| Leave Request | **Implemented** — full request table with status lifecycle. |
| Approval Workflow | **Implemented** — `POST /api/hr/leave-requests/:id/approve` / `/reject` (`routes/hr.js:493-570`), self-service submission via `POST /api/employee-self/leave-requests`. |
| Leave Calendar | **Missing** (no calendar view found; only list/table reports). |
| Absence Reason (unexcused) | **Partial** — absence itself is *derived* (a day with no attendance punch and no matching leave record = absence, inside the payroll engine's math), not a first-class "absence record" with its own reason field. |
| Attachment / Medical Document | **Missing** — no file upload on leave requests. |
| **Leave impact on payroll** | **Confirmed NOT integrated.** The schema comment on `employee_leaves` says so explicitly: *"عمدًا وصراحة: مش متصل بمحرك الرواتب (services/payroll-engine.js) ولا بيأثر على حساب الراتب"* — and this was independently verified by grepping `payroll-engine.js` for `employee_leaves`: **zero references**. An employee on an approved 3-day annual leave with no attendance punches for those days will be treated by the payroll engine the same as an unexcused absence unless something else compensates — this was not found. |

---

## PART 7 — Payroll

**Direct answer to the audit's core question: this is a real payroll engine, not just a calculation screen.**

### Earnings
- Basic Salary: **Implemented** (`base_salary`, or `hourly_rate × hours` for hourly wage type).
- Fixed/Variable Allowances: **Missing** as a distinct concept (no allowance table/column separate from base salary).
- Overtime: **Implemented** (`overtime_multiplier`, `min_overtime_hours` in `payroll_settings`, computed from punches).
- Bonuses/Incentives: **Implemented** via `payroll_adjustments` (`adjustment_type = 'bonus'`) — flat manual entry, no rules engine.
- Commission: **Missing**.

### Deductions
- Late: **Implemented** — tiered (`late_deduction_tiers`: minute ranges → fraction of day's pay), a genuinely designed feature, not hard-coded flat numbers.
- Absence: **Implemented** (derived from missing punches).
- Penalties: **Implemented** via `payroll_adjustments` (`adjustment_type = 'penalty'`) — same flat-entry caveat as bonuses.
- Loans/Advances: **Implemented** (`adjustment_type = 'advance'`).
- Damage/Other: **Implemented indirectly** — stocktake and cash-shortfall shortfalls can post as a `payroll_adjustments` penalty via `stocktake_id`/`shift_id` linkage (`db/schema.sql:1841-1843`), a genuinely well-designed cross-module link.

### Payroll Process
- Payroll period: **Implemented** (`year, month` on `payroll_runs`).
- Calculation: **Implemented** — real engine (`computePayrollSummary`), reads attendance + adjustments + settings.
- Approval: **Implemented** — DRAFT → APPROVED, posts a real double-entry journal entry (debit 6100 Salaries per branch / credit 2400 Accrued Payroll).
- Lock: **Partial** — approving a run doesn't lock the *source* attendance data from further edits (see Part 4), only the run's own snapshot.
- Adjustment: **Partial** — adjustments (`payroll_adjustments`) can be added/deleted any time, independent of run status, with no link enforcing "this adjustment was/wasn't included in run X" beyond the snapshot already taken.
- Payment: **Implemented** — `payroll_payments`, supports partial payments, posts its own journal entry, remaining balance computed live (no stored balance to drift).
- Payslip: **Partial** — `GET /api/employee-self/payslips` returns data; **UNKNOWN — REQUIRES VERIFICATION** whether there is a printable/PDF payslip format (not found in this pass; likely just a JSON/table view in `satamoni-payroll.html`/`satamoni-employee-self.html`).
- Payroll history: **Implemented** (`GET /api/payroll/runs`, `/runs/:id`).
- Recalculation: **Partial** — `GET /api/payroll/summary` recomputes live at any time (good for preview), but there is no explicit "recalculate an existing DRAFT run" endpoint distinct from creating a new one.
- Audit trail: **Implemented** for run creation/approval/cancellation (`logAudit` calls at `routes/payroll.js:407,739,809,859,953`); **NOT implemented** for individual adjustment create/delete (see Part 15).

### Confirmed data-integrity bug
`payroll_runs` has `UNIQUE(year, month)` with **no exemption for `CANCELLED` runs** (`db/schema.sql:1867-1877`), and `POST /api/payroll/runs` catches the resulting `23505` conflict and returns a flat 409 "already exists" (`routes/payroll.js:713-723`) with no check of the existing row's `status`. **Verified: once a payroll run for a given month is cancelled, a new run for that same month can never be created again.** This matches a bug already flagged in `docs/ARCHITECTURE-REFERENCE.md`'s DDD-rebuild plan as a known, real, unresolved issue — confirmed still present in the live schema/route pair. **Critical.**

---

## PART 8 — Penalties & Rewards

There is **no dedicated Penalties & Rewards system**. What exists:

1. `payroll_adjustments` (`adjustment_type IN ('advance','penalty','bonus')`) — a flat money entry. **No** approval step, **no** automatic rules (all manual), **no** evidence attachment, **no** employee acknowledgment, **no** appeal/review process. Rules are **not configurable** because there are no rules — every entry is a manual amount typed by an admin/accountant.
   - `POST /api/payroll/adjustments`: **no audit log**.
   - `DELETE /api/payroll/adjustments/:id`: **hard delete, no audit log, no reason required, no confirmation of impact on an already-approved run.** This directly contradicts this codebase's own established "no silent delete" convention used everywhere else (warnings are append-only; leaves are cancelled not deleted; payment_audit_logs is never deleted from). **Critical finding.**
2. `employee_warnings` (`severity: verbal/written/final`) — a genuine append-only HR write-up log, separate from the money-penalty concept above. This has no monetary link, no automatic escalation rule (e.g., "3 verbal → 1 written"), and no employee acknowledgment field.

There is **no "Rewards" concept beyond `bonus`** as an adjustment type — no separate rewards catalog, no non-monetary recognition tracking.

**Verdict**: rules are entirely manual/human-decided, not configurable *because there is no rules engine to configure* — the honest description is "a manual ledger," not "a hard-coded rules system."

---

## PART 9 — Recruitment

**Not implemented. Confirmed absent.** No candidate, application, vacancy, interview, trial-shift, scorecard, or hiring-decision table/route/page exists anywhere in this repository. The only path from "a new person" to "an employee record" is a direct `POST /api/payroll/employees` by an admin/accountant — there is no pipeline before that point.

---

## PART 10 — Performance / KPI

**Not implemented — including the specific "Shift Manager KPI" system named in the request.**

Searched explicitly for: `manager_shifts`, `shift_staffing`, `shift_incidents`, `shift_checklists`, `checklist_items`, `handover`, "manager score", "critical incident gate", and the literal phrase "Shift Manager KPI" (case-insensitive). None of these table names exist in `db/schema.sql`. The only "handover"-adjacent matches in the repo are about **delivery driver** handover/dispatch (`db/delivery-engine.js`, driver-related tests and docs) — a completely different domain (Delivery & Dispatch, not shift-manager performance). The only "kpi" hits are CSS class names (`.kpi`, `.kpiRow`) on the general sales dashboard (`satamoni-dashboard.html`), showing business numbers like revenue — not an employee/manager KPI system.

**If a "Shift Manager KPI" specification exists, it exists only outside this codebase** (a separate document/conversation) — it was never built here, not even partially, not even as a UI shell.

There is no employee performance review, evaluation period, score, rating, or goals system of any kind.

---

## PART 11 — Workforce Planning

**Not implemented.** No table or route computes required-vs-actual headcount by branch/department/position/shift/date. No position-vacancy tracking, no staffing plan, no approved-headcount concept, no backup pool, no cross-trained-employee flag, no staffing-shortage alerting. The closest adjacent things in the codebase are:
- `department_sales` — sales-vs-payroll-cost ratio per department/branch/month, a *cost* comparison, not a headcount/staffing tool.
- `payroll_settings.payroll_to_sales_warn_ratio` — a single warning threshold on payroll cost as a % of sales, again cost not headcount.

Neither of these answers "do we have enough people scheduled for Saturday night at Branch X."

---

## PART 12 — Training & Probation

**Not implemented.** No onboarding, training plan/checklist, SOP certification, trainer, training-result, or training-history table/route exists. No probation-period tracking (start/end/evaluation/confirmation/extension) exists as its own concept.

The only lifecycle-adjacent things that do exist are general employee lifecycle fields already covered in Part 2/7: `hire_date`, `status` (`active/suspended/resigned/terminated`), and the termination-cascade blocker system (Part 2). There is no "still in probation" state distinct from `active`.

---

## PART 13 — Documents & Personnel File

**Not implemented.** No file/document storage table for employees (contract, ID, certificates, medical/insurance documents, photos) exists anywhere in the schema, and no upload endpoint for employee-linked files was found (the codebase does have file upload elsewhere — e.g., Excel import via `multer` for payroll — but nothing that stores a persistent per-employee document).

What *does* function as a de facto "personnel file," spread across several tables/screens rather than a single consolidated view:
- `employee_history` (field-change log)
- `employee_warnings` (write-ups)
- `employee_leaves` (leave history)
- `attendance_punches`/`central_kitchen_manual_attendance` (attendance history)
- `payroll_run_employees`/`payroll_payments` (payroll history)

There is **no single "Employee Profile" screen** that assembles all of the above into one file view — **UNKNOWN — REQUIRES VERIFICATION**, since `public/satamoni-payroll.html` was not read end-to-end pixel-by-pixel in this pass to confirm whether its employee-detail view already stitches these together or shows only the base `employees` row. Based on the route list (`GET /api/hr/employees/:id` returns the base row only; `.../history` and `.../warnings` are separate calls), a single unified fetch does not exist server-side even if the frontend tab-switches between them.

---

## PART 14 — Permissions & Security

**Two parallel authorization systems co-exist for HR, and this is worth treating as a structural inconsistency, not just a detail:**

1. **Coarse role-based** (`middleware/auth.js requireRole(...)`) — used by `routes/hr.js` (`admin, branch_manager` for management; `+accountant, cashier, callcenter` for shift/clock-in viewing) and `routes/payroll.js` (`admin, accountant` for everything, `admin`-only for settings/late-tiers/run-cancel).
2. **Fine-grained permission catalog** (`middleware/permissions.js requirePermission(...)`) — used only by `routes/employee-self.js` (`payslips.view_own`, `leave_requests.manage_own`, `attendance.view_own`) and `routes/attendance-sync.js` (`attendance.sync_device`). These are the **only 4 HR-related keys in the entire fine-grained permission catalog** — none of the actual HR/payroll admin operations (create/edit employee, approve leave, run payroll, add/delete adjustment) are governed by it.

Practical consequence: you cannot grant one specific branch manager narrower or broader HR permissions than "the whole `branch_manager` role gets"; it's all-or-nothing per role for the core HR/payroll operations.

### Permission matrix (verified from code, not assumed)

| Role | Employees (view/edit) | Attendance (view/edit) | Payroll (calc/run/pay) | Penalties/Adjustments | Recruitment | KPI | Reports |
|---|---|---|---|---|---|---|---|
| admin | Full (both hr.js + payroll.js paths) | Full | Full | Full | N/A (doesn't exist) | N/A | Full |
| branch_manager | View/edit via `hr.js` only (department/status/termination) — **no** salary/wage access | View/manual-correct **only via `payroll.js` path if also accountant** — otherwise no punch-correction access; can clock-in/out self and view own branch's `shifts`/`attendance_records` | **No access** (payroll.js requires admin/accountant) | **No access** | N/A | N/A | HR reports: yes (`canManageStaff`); the `employees-by-branch` report is admin-only |
| accountant | Full via `payroll.js` (including salary/wage, restricted-branch reassignment — **with no admin-only gate**, unlike the equivalent field in `hr.js`) | Full punch correction, no audit log | Full | Full (including undocumented hard delete) | N/A | N/A | Not checked for HR reports (`canManageStaff` = admin+branch_manager only — **accountant is excluded from HR reports**, an inconsistency given accountant has full payroll access) |
| cashier / callcenter | No employee edit; can clock in/out self only | Self clock in/out only | No access | No access | N/A | N/A | No access |
| employee (self-service role) | View own profile only | View own attendance only | View own payslips only | N/A | N/A | N/A | N/A |

**Direct answers to the audit's specific questions**:
- Manager (branch_manager) can edit Attendance? **Only the orphaned Path A (`attendance_records`) implicitly via clock-in/out for self**; cannot correct Path B punches (payroll.js-gated to accountant/admin).
- Manager can edit Payroll? **No.**
- Manager can delete a Penalty? **No** (payroll.js-gated to accountant/admin) — but **accountant/admin can, with zero audit trail** (see Part 8/15).
- HR (branch_manager acting as HR) can edit raw attendance? **No**, only accountant/admin can (via payroll.js), and that edit is unaudited.
- Accountant can edit employee salary? **Yes**, and it **is** audit-logged (old/new full row).
- Owner/admin can override? **Yes**, admin passes every `requireRole`/`requirePermission` check in this codebase by design (established pattern across the whole system).
- Does every edit have an audit log? **No — confirmed gaps**: `payroll_adjustments` create/delete has none.

---

## PART 15 — Audit Log

`audit_logs` table captures: `user_id, branch_id, action, entity_type, entity_id, old_values (JSONB), new_values (JSONB), metadata (JSONB), ip_address, user_agent, created_at` — structurally this **does** cover WHO/WHAT/WHEN/BEFORE/AFTER/IP, and `metadata` is used for a free-text `reason` where callers pass one.

Verified coverage for the operations the audit explicitly asked about:

| Operation | Audit logged? | Evidence |
|---|---|---|
| Salary change | **Yes** | `routes/payroll.js:199` `EMPLOYEE_UPDATED`, full before/after row |
| Attendance correction (manual punch edit) | **No** | `routes/payroll.js` `PATCH /attendance-punches/:id` — no `logAudit` call at all |
| Manual attendance entry (central kitchen) | **UNKNOWN — REQUIRES VERIFICATION** (not traced in this pass; `POST /central-kitchen-attendance` was read for structure but its audit-call presence/absence was not confirmed line-by-line) |
| Penalty/Bonus/Advance create | **No** | `routes/payroll.js:568-583` — no `logAudit` call |
| Penalty/Bonus/Advance delete | **No** | `routes/payroll.js:587-593` — hard `DELETE`, no `logAudit`, no soft-delete |
| Employee status change (incl. termination) | **Yes** | Both `hr.js` and `payroll.js` PATCH paths call `logAudit` (`EMPLOYEE_HR_UPDATED`/`EMPLOYEE_UPDATED`), plus a dedicated `EMPLOYEE_TERMINATION_CASCADE` log with the full cascade result |
| Branch transfer (`restricted_branch_id`) | **Yes**, captured as part of the same `EMPLOYEE_UPDATED`/`EMPLOYEE_HR_UPDATED` log — but see Part 14: the *authorization* for who can do this differs by endpoint even though both log it |
| Position/department change | **Yes**, same as above, plus per-field `employee_history` row |
| Payroll run create/approve/cancel | **Yes** | `routes/payroll.js:407,739,809,859` |
| Payroll payment | **Yes** | `routes/payroll.js:953` |
| Leave approval/rejection | **UNKNOWN — REQUIRES VERIFICATION** (`routes/hr.js:493-570` was listed but `logAudit` presence inside those two handlers specifically was not individually confirmed in this pass — treat as unverified, not assumed present) |
| Employee deletion | **N/A** — there is no hard-delete endpoint for employees (deactivation via `status` is the only path, which is correctly a soft state change, not a delete) |

**Bottom line**: the audit *infrastructure* is solid and used correctly for the highest-stakes actions (salary, termination, payroll runs). The gap is specifically **`payroll_adjustments`** (penalties/bonuses/advances) and **manual attendance-punch correction** — exactly the two areas most exposed to abuse (an employee's pay can be silently docked or credited, and the attendance basis for that pay can be silently rewritten), which is the single most important finding of this whole audit.

---

## PART 16 — Database Inventory (HR-relevant tables)

| Table | Purpose | Key fields | FKs | Used by frontend? | Used by API? | Used by reports? | Duplicate/overlap concern |
|---|---|---|---|---|---|---|---|
| `employees` | Master employee record | department, job_title (free text), status, base_salary | `user_id→users`, `restricted_branch_id→branches` | Yes | Yes (both hr.js & payroll.js) | Yes | Edited from two route files with different auth gates |
| `employee_history` | Append-only field-change log | field_name, old/new value | `employee_id→employees`, `changed_by→users` | Yes (history tab) | Yes | No | — |
| `employee_warnings` | HR write-ups | severity, reason | `employee_id`, `issued_by→users` | Yes | Yes | Yes (`/reports` implied via `/warnings`) | Conceptually overlaps with `payroll_adjustments(type=penalty)` but no data link between the two |
| `employee_leaves` | Approved leave record | leave_type, dates, status | `employee_id`, `branch_id`, `cancelled_by/created_by→users` | Yes | Yes | Yes (leave-balance) | — |
| `employee_leave_requests` | Pending leave workflow | status, resulting_leave_id | `employee_id`, `reviewed_by→users`, `resulting_leave_id→employee_leaves` | Yes (self-service + admin approval) | Yes | No | — |
| `employee_fingerprint_codes` | Device-code↔employee↔branch mapping | device_code | `employee_id`, `branch_id` | Partial (fingerprint-codes edit form) | Yes | No | — |
| `attendance_punches` | ZK/manual raw attendance (payroll source of truth) | punch_date, clock_in/out, exempted | `branch_id` (device_code resolved via fingerprint_codes) | Yes | Yes | Yes (payroll engine) | **Duplicate concept vs `attendance_records`** — the two never reconcile |
| `attendance_records` | Login-account clock-in/out (legacy/orphaned) | clock_in/out | `user_id→users`, `branch_id` | Yes (`satamoni-attendance.html`) | Yes | No | **Not read by payroll at all** — orphaned duplicate of the attendance concept |
| `central_kitchen_manual_attendance` | Monthly manual attendance for non-fingerprint staff | present/absent days, late minutes | `employee_id` | Yes | Yes | Yes (payroll engine) | — |
| `shifts` | Scheduled shift (login-account staff) | shift_date, start/end time | `user_id→users`, `branch_id` | Yes | Yes | No | Name collision with `pos_shifts` (cash-drawer session) and `employees.shift` (category enum) — three unrelated things sharing the word "shift" |
| `payroll_settings` | Global payroll parameters (single row) | overtime multiplier, grace tiers reference, shift start times | — | Yes | Yes | Indirectly | — |
| `late_deduction_tiers` | Minute-range → deduction fraction | from/to minute, fraction | — | Yes | Yes | Indirectly | — |
| `payroll_adjustments` | Advance/penalty/bonus flat entries | adjustment_type, amount | `employee_id`, `created_by→users`, `shift_id→pos_shifts`, `stocktake_id→stocktakes` | Yes | Yes | Yes | No audit log on create/delete (see Part 15) |
| `department_sales` | Dept sales-vs-payroll ratio input | sales_amount by month | `branch_id` | Yes | Yes | Yes | — |
| `payroll_runs` | Monthly payroll run header | status, year/month (UNIQUE) | `created_by/approved_by/cancelled_by→users`, `journal_entry_id→journal_entries` | Yes | Yes | Yes | **`UNIQUE(year,month)` bug — see Part 7/22** |
| `payroll_run_employees` | Per-employee snapshot in a run | gross/net pay, advances/penalties/bonuses | `payroll_run_id`, `employee_id` | Yes | Yes | Yes | — |
| `payroll_payments` | Actual disbursement against a run-employee | amount, payment_method_id | `payroll_run_employee_id`, `branch_id`, `payment_method_id`, `journal_entry_id` | Yes | Yes | Yes | — |
| `users` | Login accounts (role incl. `employee` for self-service) | role, branch_id | — | Yes | Yes | No | Distinct from `employees` by design (most employees have no login) — correctly modeled as optional 1:1 via `employees.user_id` |
| `audit_logs` | Central audit trail | action, old/new JSONB | `user_id→users`, `branch_id→branches` | Yes (admin audit screen) | Yes | Partial | See Part 15 for coverage gaps |

### Logical Relationship Map (as it actually exists today)

```
branches ──< employees >── users (optional 1:1 via employees.user_id)
   │            │  │
   │            │  ├──< employee_history
   │            │  ├──< employee_warnings
   │            │  ├──< employee_leaves ──< employee_leave_requests
   │            │  ├──< employee_fingerprint_codes >── attendance_punches
   │            │  ├──< central_kitchen_manual_attendance
   │            │  ├──< payroll_adjustments (also → pos_shifts, stocktakes)
   │            │  └──< payroll_run_employees >── payroll_runs
   │            │                              └──< payroll_payments
   │            └── restricted_branch_id (self-referential lock, not a real assignment table)
   │
   ├──< shifts >── users            (UNRELATED to payroll; disconnected island)
   └──< attendance_records >── users (UNRELATED to payroll; disconnected island)

audit_logs ──> (user_id, entity_type/entity_id) generic pointer to any of the above
```

There is **no** `departments`, `positions`, `manager`, `recruitment_*`, `training_*`, `probation_*`, `performance_*`, or `workforce_planning_*` node in this graph — they don't exist.

---

## PART 17 — API / Backend Audit (representative sample, not exhaustive)

The full HR-adjacent surface is ~40 endpoints across `routes/hr.js` (27), `routes/payroll.js` (23), `routes/employee-self.js` (6), `routes/attendance-sync.js` (1). A line-by-line security audit of every one is beyond what was verified in this pass; the following are the ones directly checked, plus the file-level auth gates that apply to everything else in each file.

| Endpoint | Auth | Permission | Notable issue |
|---|---|---|---|
| `PATCH /api/payroll/employees/:id` | `requireAuth` + file-level `requireRole(admin,accountant)` | none finer | Allows `restrictedBranchId` (branch transfer) change with **no admin-only restriction**, unlike... |
| `PATCH /api/hr/employees/:id` | `requireAuth` + `canManageStaff` (admin,branch_manager) | none finer | ...this near-duplicate endpoint, which **does** restrict `restrictedBranchId` changes to admin only (`routes/hr.js:217-220`). Same field, two endpoints, two different rules. |
| `POST /api/payroll/adjustments` | file-level role gate only | none finer | No audit log (Part 15) |
| `DELETE /api/payroll/adjustments/:id` | file-level role gate only | none finer | Hard delete, no audit log, no reason field, no confirmation — highest-risk endpoint found in this audit |
| `PATCH /api/payroll/attendance-punches/:id` | file-level role gate only | none finer | No audit log (Part 15) |
| `POST /api/attendance-sync/punches` | `requireAuth` | `attendance.sync_device` | Correctly scoped/least-privilege for the agent account; branch auto-derived server-side for non-admin, cannot be spoofed |
| `POST /api/hr/employees/:id/warnings` | `requireAuth` + `canManageStaff` | none finer | Append-only by design (no PATCH/DELETE route exists for warnings at all — verified by absence, not just assumption) |
| `POST /api/hr/leave-requests/:id/approve`/`reject` | `requireAuth` + `canManageStaff` | none finer | **UNKNOWN — REQUIRES VERIFICATION** whether branch-ownership is checked (i.e., can a branch_manager approve another branch's leave request?) — not traced line-by-line in this pass |
| `router.use(requireAuth, payrollAccess)` (whole `payroll.js` file) | — | — | Correctly locks the entire module to admin/accountant; no branch scoping at all (a payroll-access accountant sees/edits every branch's employees — by design, per the schema comment, since payroll is company-wide) |

**Endpoints allowing delete**: only `DELETE /api/payroll/adjustments/:id` was found in the HR surface — and it is the one flagged above with no audit log.
**Endpoints relying on frontend-only validation**: not confirmed either way in this pass for the full set — **UNKNOWN — REQUIRES VERIFICATION**.

---

## PART 18 — Frontend Audit

| Page | Purpose | Backend | Completed? |
|---|---|---|---|
| `public/satamoni-payroll.html` | Combined HR admin + Payroll (employees, warnings, leave approval, adjustments, runs, payments, all 9 reports) — calls both `/api/hr/*` and `/api/payroll/*` (53 distinct `api()` calls found) | Real | **REAL** — the primary, most-developed HR screen in the system |
| `public/satamoni-attendance.html` | Self clock-in kiosk + own shift/attendance view, tied to the orphaned `shifts`/`attendance_records` path | Real (but feeds a payroll-disconnected table) | **REAL, but disconnected from payroll** — functions end-to-end for its own narrow purpose, just not the purpose most people would assume ("attendance" here ≠ "the attendance payroll is computed from") |
| `public/satamoni-employee-self.html` | Employee self-service: payslips (view), leave requests (submit/cancel/view), attendance history (view, correctly reads the payroll-connected `attendance_punches`) | Real | **REAL** |

No mock/placeholder data or dead links were found in the HR-related pages checked. No recruitment/training/probation/KPI/workforce pages exist to audit (they were not built) — this is consistent with Part 1/9-12's findings, not a separate gap.

**Not checked in this pass** (would require a live browser session, out of scope for a document-only audit): pixel-level completeness of every tab, exact error-message wording, mobile responsiveness. Marked **UNKNOWN — REQUIRES VERIFICATION** where relevant above.

---

## PART 19 — Reports

All 9 HR reports live in `routes/hr.js` (not `routes/reports.js`, which has none HR-adjacent):
`employees-by-branch`, `employees-by-department`, `employees-by-job-title`, `employee-status`, `average-tenure`, `turnover`, `new-hires`, `terminations`, `leave-balance`, `repeated-lateness`.

Plus payroll-side: `GET /api/payroll/summary` (live payroll preview), `GET /api/payroll/branch-sales` (payroll-cost-vs-sales ratio).

**Present**: Employee status/turnover/tenure/new-hires/terminations, leave balance (estimate), repeated lateness, payroll-to-sales cost ratio, payroll run history.
**Missing** (explicitly asked about, not found anywhere): a dedicated daily Attendance Report, a dedicated Late Report (distinct from the repeated-lateness monitor), a dedicated Absence Report, an Overtime Report, a formatted Payroll Report/payslip export, Employee Cost by branch (beyond the sales-ratio comparison), a Penalties Report, a Rewards Report, a general Leave Report (as opposed to just balance), a Staffing Deficit report (no workforce planning exists to report on), and any Employee Performance report (no KPI system exists).

---

## PART 20 — Data Integrity

Checked directly:

- **Duplicate payroll runs for the same month**: prevented by `UNIQUE(year,month)` — **but this same constraint creates the opposite bug**: a cancelled month can never be re-run (Part 7). Confirmed via `routes/payroll.js:713-723`.
- **Duplicate attendance punches**: prevented at the DB level (`UNIQUE(branch_id, device_code, punch_date)` + upsert). Confirmed correct.
- **Duplicate penalties/rewards**: **no constraint prevents this** — `payroll_adjustments` has no uniqueness guard, so the same penalty could be entered twice by mistake with nothing catching it (consistent with the "no audit, no workflow" finding in Part 8).
- **Orphan attendance-vs-payroll**: `attendance_records` (Part 4, Path A) is not literally an orphan foreign-key problem (its FKs are valid), but it is a **semantic orphan** — attendance data that never reaches payroll.
- **Employee deletion data loss**: not a risk — there is no hard-delete endpoint for employees; termination is a status change, and `employee_id` FKs use `ON DELETE CASCADE` on some child tables (`employee_history`, `employee_warnings`, `employee_leaves`) which would only matter if an employee row were ever hard-deleted directly in the DB (not through the app) — **UNKNOWN — REQUIRES VERIFICATION** whether any script/migration ever does this outside the app layer; not found in this pass.
- **Timezone/overnight-shift issues**: **UNKNOWN — REQUIRES VERIFICATION** — not traced in payroll-engine.js's late/overtime math in this pass; flagged as a real risk area given `shifts.end_time`/`start_time` are plain `TIME` (not `TIMESTAMPTZ`), which is a classic overnight-shift bug source (a shift ending at 02:00 the next calendar day).
- **Branch/shift mismatch**: not directly tested; the `employee_fingerprint_codes` design (per-branch device code) appears to correctly handle an employee attending different branches.

Not independently re-verified in this pass (would require live data, not schema/code reading): actual duplicate employee records, actual orphan rows, actual invalid status values in production data. These are **UNKNOWN — REQUIRES VERIFICATION against real data**, not "clean" — a schema audit cannot prove data cleanliness.

---

## PART 21 — HR Maturity Score

Scored by verified feature presence (not impression), per requested category:

| # | Category | Status | Approx. Completion |
|---|---|---|---|
| 1 | Employee Master Data | Partial | ~45% (core identity/employment fields solid; personal/contact/document fields almost entirely absent) |
| 2 | Organization | Partial | ~20% (Branch↔Employee real; Department/Position/Manager not modeled) |
| 3 | Attendance | Partial | ~50% (one real, working, engine-connected path; two disconnected/legacy paths; ZK integration unverified against real hardware) |
| 4 | Shifts | Partial | ~20% (thin scheduling table, no templates, no swap, no actual-vs-scheduled) |
| 5 | Leave | Partial | ~55% (solid request/approval workflow; explicitly not integrated with payroll; no balance ledger, no calendar) |
| 6 | Payroll | Partial→Strong | ~70% (a genuine calculation + run + journal-posting engine; missing allowances/commission concepts, has a confirmed month-lock bug) |
| 7 | Penalties & Rewards | Partial | ~25% (flat manual ledger only; no workflow, no audit on create/delete) |
| 8 | Recruitment | Missing | 0% |
| 9 | Workforce Planning | Missing | 0% |
| 10 | Training | Missing | 0% |
| 11 | Probation | Missing | 0% |
| 12 | Performance | Missing | 0% |
| 13 | Personnel File | Missing | ~10% (data exists scattered across tables; no unified file/profile, no document storage) |
| 14 | Permissions | Partial | ~35% (works, but coarse role-based only for the highest-value operations; fine-grained catalog barely touches HR) |
| 15 | Audit | Partial | ~60% (excellent coverage on salary/termination/payroll-run events; confirmed zero coverage on penalty/bonus/advance and manual attendance correction — the two highest-abuse-risk actions) |
| 16 | Reports | Partial | ~40% (9 solid reports exist; several commonly-expected ones — attendance/overtime/penalties/rewards/cost-by-branch — don't) |
| 17 | Integrations (ZKTeco) | Partial | ~35% (real protocol-level code exists and has unit-tested grouping logic; never verified against physical hardware; no sync-status/failure visibility) |

**Overall HR system maturity**: a solidly-built payroll-and-attendance core (categories 3, 6, 15 carry real weight) sitting inside a system that has **no** recruitment, training, probation, performance, workforce-planning, or personnel-file layer at all, and **no** organization-structure modeling beyond branch+employee. This is a payroll-and-basic-HR system, not a full HR/Workforce Management system.

---

## PART 22 — Critical Gaps (no new features proposed — fixes only, ranked by severity)

**Critical**
1. `DELETE /api/payroll/adjustments/:id` — hard delete of a financial record (penalty/bonus/advance) with zero audit trail and no reason requirement.
2. `PATCH /api/payroll/attendance-punches/:id` — manual attendance correction (directly affects pay) with zero audit trail.
3. `payroll_runs UNIQUE(year,month)` has no exemption for `CANCELLED` status — a cancelled month can never be re-run. Confirmed reproducible from the code path, not theoretical.
4. `attendance_records`/`shifts` (Path A) is a fully-built, frontend-connected attendance feature that has **zero effect on payroll** — anyone relying on it to reflect real attendance-for-pay purposes is being misled by the UI. This is a correctness risk, not just unused code.
5. ZKTeco device integration has never been exercised against real hardware — the field-mapping assumptions in `device-client.js` are unverified. Deploying this to a real branch without a hardware test first is a real operational risk.

**High**
6. `PATCH /api/payroll/employees/:id` allows branch reassignment with no admin-only restriction, while the near-duplicate `PATCH /api/hr/employees/:id` does restrict it — an authorization inconsistency between two endpoints doing the same thing.
7. Leave has no integration with payroll absence/deduction calculation — an approved leave day can still be treated as an unpaid absence.
8. No approval workflow for `payroll_adjustments` (penalty/bonus/advance) — a single person can both create and later delete a financial adjustment with no second reviewer, unlike almost every other financially-sensitive flow in this codebase (which use PIN-based approval grants).
9. Fine-grained permission catalog covers only self-service + the sync-agent account for HR — the core HR/payroll admin surface can't be permission-tuned per user, only per whole role.

**Medium**
10. No leave-balance ledger (accrual/entitlement) — the balance report is an estimate, not a source of truth.
11. `employee_leave_requests`/warning approval branch-ownership checks not independently confirmed in this pass — needs direct verification before relying on branch isolation for these two flows.
12. Overnight-shift / timezone handling in payroll's late/overtime math not verified — `TIME`-only columns on `shifts` are a known bug shape for shifts crossing midnight.
13. No duplicate-guard on `payroll_adjustments` (same penalty could be double-entered).
14. Accountant is excluded from HR reports (`canManageStaff` gate) despite having full payroll data access — an odd, likely unintentional, permission gap (denies visibility, not a security hole, but worth reconciling).

**Low**
15. No sync-status/failure visibility for the attendance ZK agent (console-log only).
16. No printable/exportable payslip format confirmed.
17. Naming collision across three unrelated "shift" concepts (`shifts`, `pos_shifts`, `employees.shift`) — not a bug, but a real source of future developer/AI confusion.

---

## PART 23 — Next Phase Readiness

### CURRENT HR SYSTEM

**موجود فعليًا (Real, end-to-end)**
- Employee master record (core identity/employment fields), lifecycle (active/suspended/resigned/terminated), field-level history
- Termination blocker-detection + cascade (open shifts, unpaid payroll, company debt)
- Attendance via ZK/manual punches → real payroll engine (late tiers, absence, overtime, missed punch)
- Leave request → approval workflow (not payroll-integrated)
- Employee warnings (append-only HR write-ups)
- Payroll calculation engine, run lifecycle (DRAFT/APPROVED/CANCELLED) with double-entry journal posting, partial payments
- Employee self-service (payslips, leave requests, attendance history)
- 9 HR reports + payroll summary/branch-sales report
- Central audit log, well-used for salary/termination/payroll-run events

**موجود جزئيًا (Partial)**
- Penalties/Bonuses/Advances (flat manual ledger, no workflow/audit/evidence)
- Shifts (thin scheduling table, disconnected from actual worked hours)
- Leave balance (estimate, not a ledger)
- Permissions (role-based only, fine-grained catalog barely covers HR)
- ZKTeco integration (real code, unverified against hardware)
- Personnel file (data exists, scattered, no unified view or document storage)

**UI فقط (UI-only, no real backend effect)**
- `attendance_records`/`shifts`-based clock-in (Path A) — real UI, real API, real DB writes, but **the payroll engine ignores it entirely**, so functionally it's a UI feature that produces no downstream effect anyone cares about.

**غير موجود (Missing entirely)**
- Recruitment / hiring pipeline
- Training / onboarding / certification
- Probation management
- Performance / KPI (including the specifically-asked-about "Shift Manager KPI" system — confirmed absent, not partial)
- Workforce planning (headcount, staffing deficit, backup pool, skills matrix, cross-training)
- Position/Department as normalized entities; manager hierarchy
- Employee documents/contracts/photo storage
- National ID, DOB, address, bank/wallet, emergency contact fields

**يحتاج إصلاح قبل البناء (Must-fix before building on top of this)**
- Add audit logging to `payroll_adjustments` create/delete and `attendance-punches` correction
- Fix the `payroll_runs UNIQUE(year,month)` cancellation bug
- Decide the fate of `attendance_records`/`shifts` (Path A): either wire it into payroll for real, or retire it and stop presenting it to users as attendance
- Reconcile the two `employees` edit endpoints' authorization rules (hr.js vs payroll.js) so branch-transfer is consistently gated
- Test the ZK agent against real hardware before trusting it in any branch

---

## DATABASE

**Number of HR-relevant tables**: 19 (`employees`, `employee_history`, `employee_warnings`, `employee_leaves`, `employee_leave_requests`, `employee_fingerprint_codes`, `attendance_punches`, `attendance_records`, `central_kitchen_manual_attendance`, `shifts`, `payroll_settings`, `late_deduction_tiers`, `payroll_adjustments`, `department_sales`, `payroll_runs`, `payroll_run_employees`, `payroll_payments`, plus `users` and `audit_logs` shared with the rest of the system). Total tables in the whole database: 122.

**Most important tables**: `employees` (master record), `attendance_punches` (payroll's real attendance source), `payroll_runs`/`payroll_run_employees`/`payroll_payments` (the payroll engine's output trail), `payroll_adjustments` (penalties/bonuses/advances), `employee_leaves`/`employee_leave_requests`.

**Schema problems found**: (1) three unrelated "shift" concepts sharing naming; (2) two live, non-overlapping attendance paths, one of which is functionally dead weight; (3) `payroll_runs.UNIQUE(year,month)` doesn't account for cancellation; (4) no Department/Position/Manager tables — everything is a free-text convention.

---

## ATTENDANCE

**Status**: Partial. One real path (`attendance_punches` → payroll engine) works and is genuinely well-engineered (tiered late deductions, missed-punch fraction, manual central-kitchen fallback). A second path (`attendance_records`/`shifts`) is fully built end-to-end but produces no payroll effect. A third, manual-monthly path exists for central-kitchen staff.

**ZKTeco**: Real integration code exists (`node-zklib`, correct TCP/IP protocol, agent architecture identical to the already-proven print-agent pattern), with duplicate-prevention and a passing unit test for punch-grouping logic — but it has **never been run against a physical ZK device**, by the code's own admission. Treat as "built, not proven" until a real-hardware test happens.

---

## PAYROLL

**Status**: The strongest part of this system. A real calculation engine (not a static screen) drives a full DRAFT→APPROVED→CANCELLED run lifecycle with correct double-entry journal posting and idempotent partial payments. One confirmed, reproducible bug (cancelled-month lock) and one confirmed audit gap (adjustments have no audit trail) need fixing before this can be called production-hardened.

---

## RECRUITMENT

**Status**: Not implemented. Zero code, zero schema, zero UI.

---

## WORKFORCE PLANNING

**Status**: Not implemented. No headcount/staffing/backup-pool/skills concept exists anywhere.

---

## TRAINING & PROBATION

**Status**: Not implemented. No onboarding, training, certification, or probation-tracking concept exists anywhere.

---

## PERFORMANCE / KPI

**Status**: Not implemented — including, specifically, the "Shift Manager KPI" system named in the request. Confirmed absent from the codebase by exhaustive keyword search (table names, route names, and the literal phrase). If this was built, it was built somewhere else, not here.

---

## PERMISSIONS & SECURITY

**Status**: Partial. Functionally correct role gating for the big-ticket items (payroll is admin/accountant-only; HR is admin/branch_manager-only), but split across two incompatible authorization mechanisms (coarse role checks vs the fine-grained permission catalog used elsewhere in the app), with one confirmed real inconsistency (branch-transfer restriction differs between two endpoints editing the same field).

---

## AUDIT

**Status**: Partial, trending toward good. Strong, consistent coverage for salary changes, employee status/termination, and payroll run lifecycle events. Confirmed zero coverage for the two highest-risk manual-entry operations: penalty/bonus/advance adjustments, and manual attendance-punch correction.

---

## PROPOSED NEXT PHASES

*(Titles only — none of these are built or scoped here, per your instruction. Readiness note included per item since you asked specifically about these ten.)*

1. **Workforce Planning** — not ready; there is no headcount/position/shift-template foundation to build a planning layer on top of yet.
2. **Position Vacancy** — not ready; requires a real Position entity first (doesn't exist).
3. **Recruitment Pipeline** — not ready; zero existing foundation, would be built from scratch.
4. **Candidate Scorecard** — depends entirely on #3 existing first.
5. **Trial Shift** — could reuse the existing (currently-disconnected) `shifts`/`attendance_records` tables conceptually, but has no recruitment context to attach to yet.
6. **Onboarding** — not ready; no training/checklist foundation exists.
7. **Training & Certification** — not ready; build from scratch.
8. **Probation Management** — partially ready in the sense that `employees.status`/`hire_date` exist as a base, but no probation-specific state or workflow exists yet.
9. **Cross-training / Skills Matrix** — not ready; no Skill entity, no Position entity to map skills against.
10. **Backup Employee Pool** — not ready; depends on Workforce Planning (#1) and Skills Matrix (#9) existing first.

**Recommended order if/when this work begins**: fix the Critical/High items in Part 22 first (they affect trust in the *existing* system), then Position/Department as real entities (unlocks #2, #9, #10), then Recruitment (#3→#4→#5→#6), then Training/Probation (#7→#8), then Workforce Planning (#1) last since it benefits most from everything else already existing.

---

## EXECUTIVE SUMMARY

**أين نحن الآن**: عندنا نواة Payroll + Attendance حقيقية وشغالة (مش مجرد شاشة) — حساب رواتب فعلي من بيانات بصمة حقيقية، مع قيود محاسبية تلقائية ودورة اعتماد كاملة. حواليها HR أساسي (بيانات موظف، إجازات، إنذارات، إنهاء خدمة بحماية جيدة). لكن: (1) فيه تكرار حقيقي — نظامين حضور منفصلين وواحد منهم مالوش أي تأثير على الرواتب رغم إنه شغال بالكامل وله واجهة، (2) فيه ثغرتين تدقيق (Audit) حقيقيتين في أخطر جزئين (تعديل الجزاءات/السلف وتصحيح البصمة اليدوي)، (3) باج مؤكد في قفل تشغيلة الرواتب الملغاة، (4) تكامل جهاز البصمة (ZKTeco) مكتوب بس **متأكدش منه فعليًا على جهاز حقيقي أبدًا**. وبعيدًا عن كل ده: **مفيش Recruitment، مفيش Training، مفيش Probation، مفيش Performance/KPI (ولا حتى Shift Manager KPI اللي اتسأل عنها بالاسم)، ومفيش Workforce Planning خالص** — صفر كود لأي واحد فيهم.

**اللي المفروض نبنيه بعد كده**: قبل أي Feature جديد في التوظيف/التدريب/التخطيط، لازم أولًا نصلح التكرار والثغرات في الموجود (القفل، التدقيق، تعارض الصلاحيات بين الـendpoints)، ونثبّت Position/Department كـentities حقيقية (مش نص حر) — لأن كل حاجة مقترحة في الأسئلة العشرة الأخيرة (Vacancy, Scorecard, Skills Matrix, Backup Pool...) محتاجة الأساس ده الأول عشان تُبنى صح من المرة الأولى.
