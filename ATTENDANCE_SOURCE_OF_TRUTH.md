# Attendance — Source of Truth Decision

**Status**: Decision document only. No code was changed to produce this file. Any code implications listed under "Follow-up" are tracked separately in `HR_FOUNDATION_HARDENING.md` and were evaluated for risk before touching anything.

---

## 1) Current architecture (verified against code, not assumed)

There are **three** attendance data paths in this codebase today. Two of them are used by payroll; one is not.

### Path A — `attendance_records` (login-account clock-in/out) — **NOT used by payroll**
- **Table**: `attendance_records` (`db/schema.sql:1535`) — `id, user_id, branch_id, business_date, clock_in, clock_out`. No late/absence/overtime/status columns.
- **Routes**: `POST /api/hr/attendance/clock-in`, `POST /api/hr/attendance/clock-out`, `GET /api/hr/attendance` (`routes/hr.js:65-163`).
- **Frontend**: `public/satamoni-attendance.html` (self clock-in kiosk page), plus the `shifts` table it displays alongside.
- **Services**: none — no service module reads this table for any calculation.
- **Payroll dependency**: **none.** Confirmed by direct grep of `services/payroll-engine.js` — zero references to `attendance_records`.
- **Reports**: none.
- **Manual correction**: none exists (no PATCH endpoint for this table).
- **Device integration**: none — purely login-account self-reported clock times.
- **Existing data**: real rows exist wherever this feature has been used operationally; untouched by this document.

### Path B — `attendance_punches` (ZK device / manual import) — **the one payroll actually uses**
- **Table**: `attendance_punches` (`db/schema.sql:1735`) — `id, branch_id, device_code, punch_date, clock_in, clock_out, exempted`, `UNIQUE(branch_id, device_code, punch_date)`.
- **Mapping table**: `employee_fingerprint_codes` (`employee_id, branch_id, device_code`) — one employee can have different device codes per branch.
- **Routes**:
  - `POST /api/payroll/attendance-punches/import` — manual bulk import.
  - `POST /api/payroll/import-excel` — Excel workbook import (`db/payroll-excel-import.js`).
  - `PATCH /api/payroll/attendance-punches/:id` — manual single-record correction.
  - `GET /api/payroll/attendance-punches` — list/review.
  - `POST /api/attendance-sync/punches` (`routes/attendance-sync.js`) — near-real-time device sync target, consumed by the `attendance-agent/` local process.
- **Frontend**: `public/satamoni-payroll.html` (import/review/correct tab), `public/satamoni-employee-self.html` (own history, read-only).
- **Services**: `services/payroll-engine.js:20,194` — joins this table directly (via `employee_fingerprint_codes`) for late/absence/overtime/missed-punch computation, driven by `payroll_settings` and `late_deduction_tiers`.
- **Payroll dependency**: **primary source** for `attendance_system = 'fingerprint_auto'` employees.
- **Reports**: feeds `repeated-lateness`, payroll summary, and payroll run generation.
- **Manual correction**: exists, direct overwrite (no audit trail today — tracked as a separate finding, fixed under HRF-5, not this document).
- **Device integration**: `attendance-agent/` — real `node-zklib`-based TCP/IP client, poll-based (not ADMS push), never tested against physical hardware (see the code's own comment in `attendance-agent/device-client.js`).
- **Existing data**: real production data for every branch running fingerprint-based attendance.

### Path C — `central_kitchen_manual_attendance` (non-fingerprint staff) — **also used by payroll**
- **Table**: `central_kitchen_manual_attendance` (`db/schema.sql:1748`) — one row per employee per month (`present_days, absent_days, total_late_minutes, manual_deduction`).
- **Routes**: `GET/POST /api/payroll/central-kitchen-attendance`.
- **Services**: `services/payroll-engine.js:254` — used for `attendance_system = 'manual'` employees.
- **Payroll dependency**: **primary source** for manual-attendance employees (central kitchen staff without a fingerprint device).
- This path is a coarse monthly aggregate, not day-by-day punches — it cannot support the same late-deduction-tier granularity Path B gets, by design (there is no device to derive minute-level lateness from).

---

## 2) Where divergence happens

Path A and Path B/C never interact. There is no shared key that would let them reconcile even if someone wanted to — Path A is keyed by `user_id` (a login account), Path B/C are keyed by `employee_id`/`device_code` (a payroll master record). An employee can have a `user_id` (optional, `employees.user_id UNIQUE`) but the two attendance tables are never joined or cross-checked anywhere in the codebase. **There is no code path where these two systems disagree about the same fact, because they never look at the same fact.** Path A simply isn't part of the payroll calculation at all — it's not that it's wrong, it's that it's irrelevant to pay.

---

## 3) Canonical system — decision

**`attendance_punches` (device/manual-import, Path B) and `central_kitchen_manual_attendance` (Path C) are declared the canonical attendance source of truth for payroll purposes.** This is not a change — it is the existing, already-correct behavior of `services/payroll-engine.js`, made explicit and documented so it stops being an implicit fact buried in code comments.

**`attendance_records`/`shifts` (Path A) is declared legacy / non-canonical for payroll.** It remains fully functional for its current, narrow purpose (a self-service clock-in kiosk and shift-schedule display) but must not be presented, in any future work, as "the" attendance record — it is not, and should not become, a payroll input without a deliberate, separately-scoped decision.

No code changes were required to make Path B/C canonical, because they already are. What this document changes is **clarity**, not **behavior**.

---

## 4) Migration strategy

There is no data migration needed to make Path B/C canonical — they already are, and have been since `services/payroll-engine.js` was written. Path A's data is **not migrated, not merged, not deleted**. It stays exactly where it is, serving exactly the feature it currently serves (self clock-in kiosk).

If a future decision is made to retire Path A or merge it into Path B, that is out of scope for this hardening phase (explicitly forbidden by the governing instructions: no speculative changes, no refactor of unrelated modules) and would need its own scoped plan, including: how a login-account employee's self-reported clock time would map to a `device_code` (they may not have one), and what happens to historical Path A rows (they would need to be preserved, not deleted, per this project's standing data-integrity discipline).

---

## 5) Historical data handling

- No historical row in any of the three tables was touched, moved, or deleted while producing this document.
- Path A's historical rows remain queryable exactly as before via `GET /api/hr/attendance`.
- Path B/C's historical rows remain the payroll engine's input exactly as before.

---

## 6) Payroll integration strategy

**No change requested or made.** The payroll engine already reads only from the canonical sources (Path B/C). This document's job was to prove that with evidence and write it down, not to change how payroll reads attendance.

Two follow-up items were identified as separate, narrower fixes (tracked in `HR_FOUNDATION_HARDENING.md`, not here):
- Add an audit trail to Path B's manual correction endpoint (currently silent) — a data-integrity fix, not a source-of-truth change.
- Make it visually unambiguous in the frontend that Path A ("سجل الحضور والانصراف" in `satamoni-attendance.html`) is a self-service kiosk log, not the payroll attendance record — a documentation/labeling matter, evaluated separately for risk before any UI text is touched.

---

## 7) Risks

- **Perception risk**: staff or managers using Path A's clock-in feature may believe it affects their pay. It does not. This is a real, pre-existing risk that this document surfaces but does not fix (fixing it means either wiring Path A into payroll — a real feature change, out of scope — or relabeling/deprecating it — a UI change requiring its own careful, separately-authorized pass).
- **No technical risk from this document itself** — zero code was changed.

---

## 8) Tests required (for this document specifically)

None — this is a documentation deliverable with no behavior change. The claims in this document (payroll never reads `attendance_records`; payroll reads `attendance_punches`/`central_kitchen_manual_attendance`) are independently verifiable by grepping `services/payroll-engine.js`, which is exactly how they were established here (not assumed).
