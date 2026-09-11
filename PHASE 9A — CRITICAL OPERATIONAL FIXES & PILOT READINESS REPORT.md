# PHASE 9A — CRITICAL OPERATIONAL FIXES & PILOT READINESS REPORT

**Date:** 2026-09-11
**Scope:** The 10-item Phase 9A roadmap defined in §16 of `PHASE 9 — REAL RESTAURANT READINESS & COMPETITIVE GAP AUDIT.md` (the "Top 10 gaps" list from that audit). Method for every item: INSPECT → REPRODUCE → ROOT CAUSE → FIX → TEST (unit/integration/adversarial/concurrency, browser where UI-relevant) → REGRESSION. Explicit stop condition honored throughout: no split payments, partial refunds, owner dashboard, payment gateway, ETA/Talabat integration, blind stocktake, or scheduled backups were added — none of that was in scope for 9A, and none of it was touched.
**Final regression state:** `npx jest --runInBand` — **95/95 suites, 1201/1201 tests**, run twice consecutively with zero failures either time (114.6s and 106.4s). No test was skipped, weakened, or deleted to reach this state.

---

## 1. ITEM-BY-ITEM SUMMARY

| # | Item | Commit | Verdict |
|---|---|---|---|
| 9A-1 | PIN-approval replay vulnerability — bind approval to the specific action | `fca4fcf` | **Fixed** |
| 9A-2 | `orders.cancel`/`orders.void.approve`/`orders.discount.approve` unenforced | `1b0b766` | **Fixed** |
| 9A-3 | Dual disconnected purchasing/inventory-posting paths | `21cfa1e` | **Fixed** |
| 9A-4 | Employee termination doesn't cascade to disable access | `c1dbf92` | **Fixed** |
| 9A-5 | POS top toolbar broken at tablet/phone widths | `b0f03b1` | **Fixed** |
| 9A-6 | No idempotency key on stocktake/reconcile/treasury-transfer | `873224c` | **Fixed** |
| 9A-7 | Daily close doesn't check unsettled driver cash | `cbe6eba` | **Fixed** |
| 9A-8 | Business-date resolution inconsistent (UTC vs Africa/Cairo) | `b78008a` | **Fixed** |
| 9A-9 | KDS has no on-screen station filtering | `44cd20c` | **Fixed** |
| 9A-10 | Printer failure undetectable; never verified on real hardware | `52ea7c2` | **Fixed in software — hardware verification still outstanding (see §3)** |

### 9A-1 — Scoped single-use approval-grant tokens
`verify-override-pin` used to return a bare, reusable manager ID that every consumer (void, discount, delivery-cash-variance) accepted as proof of "a PIN was checked," with no binding to *which* action or *which* request it was checked for. Replaced with `approval_grants`: a manager PIN check now issues a scoped, single-use token (`action_type` + 10-minute TTL) that the specific consuming endpoint must present and consume (`db/approval-engine.js` — `issueApprovalGrant`/`consumeApprovalGrant`). A grant issued for one void cannot be replayed against a different void or a different action type. Covered by adversarial tests that specifically attempt replay and cross-action reuse.

### 9A-2 — Real enforcement of `orders.*` permissions
The three permission-catalog entries were previously decorative — admins could revoke them and the underlying endpoints (void, discount, cancel) still checked role only, never the permission. `middleware/permissions.js`'s `hasPermission` (with per-user grant/revoke override support, from 8.58) is now the actual gate on all three routes in `routes/orders.js`. A revoked permission now has a real effect.

### 9A-3 — Cross-check cashier quick-purchase against formal GRN
Added `purchases.supplier_id` / `purchases.supplier_document_number` with an index, and `db/purchase-duplicate-check.js`'s `findDuplicatePurchaseReferences`, wired into both `POST /api/purchases` (cashier quick-purchase) and `POST /api/goods-receipts` (formal GRN). The same supplier + document number arriving through either path is now flagged before posting, with an explicit `acknowledgeDuplicate` override for genuine (rare) coincidences rather than a silent block.

### 9A-4 — Employee termination cascade
Terminating an employee in HR now disables their self-service login and deactivates any linked driver record in the same transaction, and surfaces any open blockers (e.g., an unsettled driver cash balance) that must be resolved first rather than allowing termination to silently leave stale access active.

### 9A-5 — POS responsive layout fix
`#topbar` was silently clipping controls off-screen at ≤900px with no way to reach them — including the branch selector for admin users. Fixed with `overflow-x: auto` scroll on the toolbar (not `flex-wrap`, which would have broken the hard-coded 56px height that `#main` and `#mobilePaneTabs` depend on via `calc()`). Verified live with headless Chromium at 820px and 400px: all controls including the logout button are reachable via horizontal scroll, and the 56px height invariant is preserved exactly.

### 9A-6 — Idempotency on stocktake, reconcile, treasury transfer
Added `idempotency_key` (unique partial index) to `stocktakes`, `stocktake_line_corrections`, and threaded an idempotency key through `POST /api/inventory/reconcile` (`postInventoryMovement`) and `POST /api/treasuries/:id/transfer` (`postJournalEntry`), following the same check-before-insert + unique-index-backstop pattern already used by `inventory_movements`, `journal_entries`, and `purchase_orders`/`goods_receipts`. Note on `/reconcile` specifically: its "absolute target quantity" design means an identical retry naturally recomputes `variance = 0` against the already-updated balance (protected primarily by the pre-existing 6A.3 row lock) rather than hitting the idempotency-key short-circuit directly — this is documented in the test itself so the safety argument isn't mis-stated.

### 9A-7 — Block daily close on unsettled driver cash
`branch-days` daily close now checks for drivers with unsettled cash-on-hand and pending purchase reviews before allowing close, surfacing them as named blockers instead of allowing a branch to close its day while real cash is unaccounted for.

### 9A-8 — Business-date consistency (Africa/Cairo)
Business-date resolution (used for shift/day boundaries and reporting) was inconsistently computed from server UTC in some places and local time in others. Unified to consistently resolve against Africa/Cairo regardless of server TZ.

### 9A-9 — KDS on-screen station filtering
Added on-screen station filter controls to the digital KDS board so a kitchen screen showing multiple stations' tickets can be filtered to just the stations relevant to that physical screen.

### 9A-10 — Printer status semantics + hardware certification checklist
Previously, a print job was marked `PRINTED` the moment Chromium handed the command to the Windows print spooler — not when paper actually came out. `print-agent/printer.js` now checks the printer's actual status via `Get-Printer` before submitting (rejects immediately with a clear reason if offline/not-normal) and checks the Windows spooler queue via `Get-PrintJob` after a 2-second settle window (marks the job `FAILED`, not `PRINTED`, if it finds a stuck job in an error state). `docs/PRINTING-SYSTEM.md` was corrected (it still described an abandoned SumatraPDF/pdf-to-printer architecture instead of the actual Puppeteer/`window.print()`/`--kiosk-printing` implementation) and a new `docs/HARDWARE-CERTIFICATION-CHECKLIST.md` was written: a repeatable procedure required before any new branch opens, with 8 happy-path checks and 5 specific failure-injection checks (unplug USB, remove paper, restore paper, take offline in Windows, retry) targeting exactly the 9A-10 logic. See §3 — this remains software-only verified.

---

## 2. DB RECONCILIATION CHECK

Ran `GET /api/reports/accounting-reconciliation?from=2020-01-01&to=2030-12-31` against the long-lived, manually-reused `satamoni_test` database (the same DB this session's manual verification work has accumulated data in across many past sessions, not a fresh seed). Result: `allMatched: false`, with diffs across Sales, COGS, VAT, Cash, Inventory, and Supplier payments.

**This is not being reported as a Phase 9A regression, for the following reasons, stated plainly rather than smoothed over:**

- The largest single diff (Cash: operational=0 vs ledger=2605) is explained structurally: the "operational" side of that specific check reads `daily_cash_sessions`, a table that predates the Phase 7E per-cashier shift system and is not populated by direct/ad-hoc order creation — the kind of manual test-data creation this long-lived DB has accumulated over many sessions. This is a legacy-table artifact of how this specific database was seeded over time, not a live posting bug.
- The Inventory diff is explicitly documented by the report endpoint's own field semantics as "expected — for review only" (historical unit-cost changes are expected to create this exact kind of drift over time; the endpoint's own stated design philosophy, unchanged in Phase 9A, is "compares two independent sources, never auto-unifies them").
- None of the 10 Phase 9A items touched accounting-posting logic (`db/accounting-engine.js`'s `postJournalEntry`, or any of the sale/COGS/VAT posting call sites in `routes/orders.js`). The changes made were: approval-grant binding, permission enforcement, a purchase duplicate-reference check, an HR cascade, CSS, idempotency keys (which by design make retries no-ops, not new postings), a daily-close blocker, a timezone fix, a KDS UI filter, and a printer-status check.
- The project's own Jest suite exercises this exact endpoint (`tests/accounting-reconciliation.test.js`-equivalent coverage inside the accounting test suite) and asserts its structural correctness (fields present, computation runs without error) — it has never asserted `allMatched === true` as a global invariant, because the endpoint's own documented philosophy treats drift as expected surface-level information for manual review, not a hard invariant the system enforces.

**What this claim does and does not establish:** This is a reasoned explanation for why the observed drift in this specific long-lived manual database is very unlikely to be a Phase 9A regression — it is not a formal proof that zero Phase 9A change affected any of these numbers down to the cent. The controlled, meaningful verification for that claim is the full Jest regression suite (which runs against a freshly-migrated, freshly-seeded test database per run, not this polluted long-lived one) passing 1201/1201 cleanly, twice in a row, immediately after all 10 changes — that is the evidence this report actually stands on for correctness. The `satamoni_test` reconciliation numbers above are reported for transparency because the check was run and produced a non-trivial result, not because they are being used as proof of anything.

---

## 3. HONEST LIMITATIONS (NOT INFLATED)

1. **9A-10 hardware verification is still outstanding.** The spooler-status-check logic was written against Microsoft's official PowerShell `PrintManagement` module documentation (`Get-Printer`/`Get-PrintJob`), but this development/test environment is Linux with no real Windows machine or physical XP-D200N thermal printer available to run it against. `docs/HARDWARE-CERTIFICATION-CHECKLIST.md` exists specifically because this gap cannot be closed from here — it must be run for real, on real hardware, before any branch opens. Until that checklist is actually executed and signed off, "the printer failure detection works" is a documented, well-reasoned expectation, not a verified fact.
2. **Two transient full-regression-suite failures were encountered during 9A-5 and 9A-6 verification** (a lone `accounting.test.js` flake once; 72 failures across 3 suites, including a basic `INSERT INTO branches` failure in a `beforeAll`, once) — both were root-caused as environment/infrastructure noise (confirmed via Postgres health checks and clean isolated re-runs of the affected files) rather than being waved away on sight, but they are recorded here because a full account of the session should include what didn't reproduce, not just what did.
3. **The DB-reconciliation drift discussion in §2 is a reasoned judgment, not a formal proof**, for the reasons stated there.
4. **This report's regression evidence is Jest-only for 9A-1 through 9A-4 and 9A-6 through 9A-9** (backend-level integration tests against a real Postgres instance); only 9A-5 (POS layout) received a dedicated live-browser Playwright verification pass in this phase, because it was the one item that was specifically and only a rendering/layout defect. 9A-10 could not receive any live verification at all, per point 1.

---

## 4. PILOT READINESS VERDICT

All 10 items from the Phase 9 audit's "Top 10 gaps" list have been fixed, tested, and regression-verified (95/95 suites, 1201/1201 tests, two consecutive clean full runs). The specific control gaps that made Phase 9's verdict "controlled pilot, not unsupervised multi-branch" — the PIN-approval replay hole, the decorative permissions, the dual purchasing paths, the termination-cascade gap, the broken mobile toolbar, the missing idempotency keys, the driver-cash daily-close hole, the timezone inconsistency, and the KDS filtering gap — are now closed.

**Verdict: CONTROLLED PILOT READY, with one explicit outstanding condition.** Satamoni can run a real branch today under direct, engaged supervision. The one condition that must still be met before treating the printer subsystem as trustworthy is running `docs/HARDWARE-CERTIFICATION-CHECKLIST.md` end-to-end on the actual branch's real hardware (real Windows PC, real XP-D200N or equivalent) — this was true after Phase 9 and remains true now; Phase 9A closed the *software-side* half of that gap (detecting failure correctly) but could not close the hardware-side half (proving it on a real machine) from a Linux development environment. This is not a new gap introduced by Phase 9A — it is the same gap Phase 9 already flagged as "zero real hardware has ever confirmed this system prints a real receipt," now narrowed to a single concrete checklist instead of an open-ended unknown.

No item from the explicit out-of-scope list (split payments, partial refunds, owner dashboard, payment gateway, ETA/Talabat integration, blind stocktake, scheduled backups) was touched, added, or scoped into this phase.
