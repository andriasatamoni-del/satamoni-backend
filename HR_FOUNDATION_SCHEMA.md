# HR Foundation — Relationship Diagram

Companion to `HR_FOUNDATION_HARDENING.md`. Shows only the relationships touched or introduced by the Phase 1 hardening — not a full ERD of the system.

## 1. Employee → Department → Position

```
┌───────────────┐        ┌───────────────┐        ┌───────────────┐
│  departments  │◄───────│   positions   │        │   employees   │
│───────────────│  FK    │───────────────│        │───────────────│
│ id            │(nullable)│ id           │        │ id            │
│ code (unique) │        │ code (unique) │        │ name          │
│ name (unique) │        │ name          │        │ department    ◄──┐ legacy TEXT,
│ description   │        │ department_id │        │ job_title      ◄─┤ kept in sync by
│ status        │        │ description   │        │ department_id ───┤ trg_sync_employee_
│ (active/      │        │ status        │───FK──►│ position_id   ───┘ department_position
│  inactive)    │        │ (active/      │        │ ...           │  (BEFORE INSERT/UPDATE)
└───────────────┘        │  inactive)    │        └───────────────┘
        ▲                └───────────────┘                ▲
        │ FK (nullable)                                   │
        └─────────────────────────────────────────────────┘
                    employees.department_id
```

- `department_id` / `position_id` are the **new source of truth** going forward; `department` / `job_title` (TEXT) are **derived automatically** by the trigger for backward compatibility with every existing consumer (payroll engine GROUP BYs, HR reports, `department_sales`).
- A `position` may have `department_id = NULL` — a job title shared across departments is never forced onto one (see migration details in the hardening doc, §8).
- Both FKs on `employees` are nullable — the legacy free-text path (no `departmentId`/`positionId` supplied) remains fully functional.

## 2. Attendance → Payroll → Accounting

```
┌─────────────────────────┐     ┌──────────────────────────────┐
│   attendance_punches     │     │ central_kitchen_manual_      │
│   (fingerprint/ZKTeco)   │     │ attendance (manual entry)    │
└───────────┬──────────────┘     └───────────┬───────────────────┘
            │                                 │
            └───────────────┬─────────────────┘
                             ▼
                 services/payroll-engine.js
              (computePayrollSummary, computeLatenessReport,
               computePayrollCostByBranch — reads ONLY these
               two sources, documented canonical in
               ATTENDANCE_SOURCE_OF_TRUTH.md)
                             │
                             ▼
                    payroll_adjustments  ◄── status ACTIVE/CANCELLED
                    (penalties/bonuses/    (HRF-4: soft-cancel,
                     advances)              never hard-deleted)
                             │
                             ▼
                    payroll_runs (DRAFT → APPROVED → CANCELLED)
                    unique **active** period enforced by
                    idx_payroll_runs_active_period
                    ON (year, month) WHERE status IN
                    ('DRAFT','APPROVED')   ◄── HRF-2 fix: a
                                                CANCELLED run no
                                                longer blocks its
                                                month forever
                             │
                             ▼
                    Accounting journal entries
                    (posted on payroll approval — unchanged
                     by this phase)
```

- `attendance_records` / `shifts` (legacy kiosk path) are explicitly **not** in this chain — documented as non-canonical in `ATTENDANCE_SOURCE_OF_TRUTH.md`, untouched by this phase.
- The partial unique index is enforced at the database level: two concurrent `POST /runs` for the same month can race, and Postgres guarantees exactly one wins (verified by a real `Promise.all` concurrency test).

## 3. Penalty/Reward → Audit Log

```
┌────────────────────┐   create    ┌───────────────────────────────────┐
│ payroll_adjustments │────────────►│ audit_logs                        │
│ status: ACTIVE      │             │ action: PAYROLL_ADJUSTMENT_CREATED│
└──────────┬──────────┘             │ new_values: {amount, type, reason}│
           │                        └───────────────────────────────────┘
           │ POST .../:id/cancel
           │ (reason required)
           ▼
┌────────────────────┐   cancel    ┌───────────────────────────────────┐
│ payroll_adjustments │────────────►│ audit_logs                        │
│ status: CANCELLED   │             │ action: PAYROLL_ADJUSTMENT_CANCELLED│
│ cancelled_by        │             │ old_values: {status: ACTIVE}      │
│ cancelled_at        │             │ new_values: {status: CANCELLED}   │
│ cancellation_reason │             │ metadata: {reason}                │
└─────────────────────┘             └───────────────────────────────────┘
```

- The row is **never deleted**. `services/payroll-engine.js` filters `WHERE status = 'ACTIVE'` when summing penalties/bonuses into payroll, so a cancelled adjustment stops affecting money **without** losing its historical trace.

## 4. Manual Attendance Correction → Audit Log

```
┌─────────────────────┐  PATCH .../attendance-punches/:id  ┌───────────────────────────────────┐
│ attendance_punches   │  (reason REQUIRED — 400 if absent) │ audit_logs                        │
│ clock_in, clock_out, │────────────────────────────────────►│ action: ATTENDANCE_PUNCH_CORRECTED│
│ exempted             │  FOR UPDATE OF ap (row-locked)      │ old_values: {clock_in, clock_out,  │
└─────────────────────┘                                     │             exempted}              │
                                                              │ new_values: {clock_in, clock_out,  │
                                                              │             exempted}              │
                                                              │ metadata: {reason, source: MANUAL, │
                                                              │           employeeId}              │
                                                              └───────────────────────────────────┘
```

- Two sequential corrections on the same punch produce **two separate** audit rows — the full correction history is reconstructable, not just the latest state.
