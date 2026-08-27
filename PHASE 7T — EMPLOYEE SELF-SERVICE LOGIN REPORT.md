# PHASE 7T — Employee Self-Service Login

## Executive Summary

Phase 7T adds an optional self-service login for employees — view payslips, request leave — closing
the "employee self-service login" item from the Phase 7D audit's List C (nice-to-have). This is the
final item in the Phase 7D operational-gap backlog (excluding Talabat API integration, which remains
explicitly deferred pending real credentials, per a prior agreement with the user).

## 1. Design

A new `employee` role, following the exact same posture already established for `driver` in Phase 7F:
the narrowest role in the system, scoped entirely to its own data, enforced both by permission strings
and by matching `employees.user_id` against `req.user.id` in code. `employees.user_id` is a new optional
column (mirrors `drivers.user_id`) — most employees have no login at all; an admin opts a specific
employee in via `POST /api/users` with `role: "employee"` and `employeeId`, which links the new account
to an existing HR employee record inside one transaction.

Payslips are visible only from `payroll_runs` with `status = 'APPROVED'` — a draft run isn't final and
could still change or be cancelled before an employee should see it.

Leave requests use a new table, `employee_leave_requests`, deliberately separate from the existing
`employee_leaves` (Phase 4D) — the latter is an already-approved official record entered by HR on the
employee's behalf; the former is a self-submitted request still awaiting review. Approving a request
(`POST /api/hr/leave-requests/:id/approve`) inserts a real `employee_leaves` row using the same logic as
the existing HR-side leave recording, and links back via `resulting_leave_id`. An employee can cancel
their own request only while it's still pending; approve/reject is restricted to the branch manager of
that employee's branch (or admin), same authorization scope as the existing `/api/hr/leaves` endpoints.

## 2. Frontend

- `public/satamoni-employee-self.html` (new): a standalone self-service portal — login, a payslips tab
  (per-month cards: gross/advances/penalties/bonuses/net/paid/remaining), and a leave-requests tab
  (submission form + list with cancel for pending requests).
- `public/satamoni-payroll.html`: the existing employee-profile modal (from Phase 4D) gets two new
  sections — self-service leave requests (approve/reject for pending ones) and, admin-only, a form to
  create a self-service login for that employee if one doesn't exist yet.
- `public/satamoni-admin.html` / `public/satamoni-payroll.html`: redirect an `employee`-role login to
  the new portal, matching the existing sparse per-role redirect convention already used for other roles.

## Files Changed

- `db/migrations/0012_employee_self_service.js` (new), `db/schema.sql`
- `middleware/permissions.js` (`employee` role permissions)
- `routes/users.js` (`POST /` accepts `role: "employee"` + `employeeId` linking)
- `routes/hr.js` (`e.user_id` column exposed, new `GET/POST /leave-requests` review endpoints)
- `routes/employee-self.js` (new)
- `server.js` (mount `/api/employee-self`)
- `public/satamoni-employee-self.html` (new)
- `public/satamoni-payroll.html`, `public/satamoni-admin.html`
- `tests/employee-self-service.test.js` (new, 15 tests)
- `docs/EMPLOYEE-SELF-SERVICE.md` (new)

## Testing

- Jest: 523/523 passing, stable across 2 consecutive full runs (508 pre-existing + 15 new).
- New tests cover: self-service account creation and linking (success / missing employeeId / unknown
  employee / already-linked employee), permission isolation for unrelated roles, payslip visibility
  (approved runs only), and the full leave-request lifecycle (submit → wrong-branch manager blocked →
  correct manager approves → official record created → re-review blocked → employee can't cancel after
  approval → a separate pending request can be self-cancelled → a separate request can be rejected with
  a reason).
- Migration 0012 applied to the dev database.
- Browser verification (Playwright) against the real dev server + dev database: created a self-service
  login from the employee profile in `satamoni-payroll.html`, logged in as that employee on
  `satamoni-employee-self.html`, confirmed a seeded approved payslip displayed with correct figures,
  submitted a leave request and confirmed its pending status, returned as admin to review it from the
  same employee profile modal, and confirmed the approval actually created the official
  `employee_leaves` record.

# PHASE 7T STATUS

**Implementation:** Complete — optional employee login role, payslip visibility scoped to approved
payroll runs, and a full leave-request submit/approve/reject/cancel workflow linked to the existing
official leave record.

**Tests:** 523/523 Jest tests passing, stable. 15 new tests cover account linking, data isolation, and
the leave-request lifecycle including cross-branch authorization.

**Browser Verification:** Passed — full flow confirmed end-to-end from account creation through leave
approval, against the real server and dev database.

**Render Staging:** Not applicable — no deployment step requested this phase.

**Operational Completeness Before → After:**
- Before: employees had no way to see their own payslip or request leave without going through a
  manager in person; `employee_leaves` was explicitly HR-entered-only, with no self-service path at all.
- After: any employee can optionally be given a login to view their approved payslips and submit leave
  requests, which flow into the same official leave record after manager/admin review.

**Remaining P1:** None identified for this phase's scope.

**Remaining Manual Workarounds:** Talabat/delivery-app API integration remains unaddressed (unchanged
from prior phases, explicitly deferred pending real API credentials).

**Recommended Next Step:** This closes the full Phase 7D operational-gap backlog (Lists A, B, and C)
except Talabat integration, which stays deferred as previously agreed. No further items remain queued
under the user's standing instruction — future work should resume from a fresh audit or explicit
direction from the user.
