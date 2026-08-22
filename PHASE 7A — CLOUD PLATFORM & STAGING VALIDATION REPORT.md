# PHASE 7A — Cloud Platform & Staging Validation Report

**Status of this report**: Platform evaluation and staging deployment **preparation** are complete.
**Actual cloud deployment has NOT been executed** — this session's network egress policy blocks outbound
access to every cloud provider dashboard/API tested (`render.com`, and by the same policy mechanism,
almost certainly the others too — confirmed concretely for Render via the proxy status endpoint, which
reported `gateway answered 403 to CONNECT (policy denial)` for `api.render.com`, `render.com`, and
`dashboard.render.com`). Provisioning a real service, a real managed database, and a real HTTPS URL
requires a human with dashboard access (or a session with an open network policy) to execute
[`docs/CLOUD-STAGING-RUNBOOK.md`](docs/CLOUD-STAGING-RUNBOOK.md). Nothing below is marked VERIFIED
unless it was actually run against real infrastructure or the local codebase.

---

## 1. Executive Summary

Satamoni's backend is a single stateless Node.js/Express process talking to one PostgreSQL database,
with no framework- or platform-specific code (confirmed by repo audit, Section 2). This means the
platform choice is a genuinely low-stakes, low-lock-in decision — any of the four evaluated platforms
can run it correctly. The deciding factors are therefore operational simplicity, cost at Satamoni's
actual current scale, and how directly the platform closes the one concrete open gap from Phase 6.5:
**scheduled backups are not yet automated anywhere**.

**Recommendation: Render**, for the staging deployment now and the single real branch pilot after it,
with DigitalOcean flagged as the natural step-up if/when Satamoni reaches ~10 branches and needs a more
mature managed-database product (PITR, HA). AWS is not recommended at this stage — its operational
overhead (VPC, IAM, load balancer, EC2/RDS lifecycle) is disproportionate to a small restaurant tech
team running one Express service, and one of its two simplest on-ramps (App Runner) is reported as
being phased out for new workloads.

No code redesign was needed to reach this recommendation. One real gap was found and fixed during the
audit (Section 2): the database connection pool had no SSL configuration at all, which would have made
the very first connection attempt to *any* managed cloud Postgres fail.

## 2. Current Architecture (repo audit)

Verified by reading the actual files, not assumed:

- **Entry point**: `server.js` — binds `process.env.PORT || 4000` (`server.js:104`), no hardcoded port.
- **Process model**: single stateless Express process. No in-memory session state; identity is JWT +
  a fresh permissions read from the DB on every request (`middleware/auth.js`). This is the property
  that makes horizontal scaling (multiple instances behind a load balancer) safe with zero coordination
  — already noted in `docs/DEPLOYMENT.md` §1.
- **Database**: single central PostgreSQL, accessed through one `pg.Pool` (`db/pool.js`). Pool size and
  timeouts are already env-configurable (`DB_POOL_MAX`, `DB_POOL_IDLE_TIMEOUT_MS`,
  `DB_POOL_CONNECTION_TIMEOUT_MS` — Phase 6G). **Finding, fixed in this phase**: the pool had *no* SSL
  option at all. Every managed cloud Postgres (Render, DigitalOcean, RDS) rejects non-SSL connections by
  default — without this fix, the very first deploy attempt against any of the four platforms would fail
  at the DB connection step. Added an explicit, opt-in `DB_SSL=true` env var (default `false`, zero
  behavior change locally) → `ssl: { rejectUnauthorized: false }`. Verified by a new mocked-`pg` test
  (`tests/pool-ssl.test.js`, 3/3 passing) and confirmed against current Render documentation (Section 3)
  that this is the standard pattern for managed Postgres with an intermediate CA not in Node's default
  trust store.
- **Schema/migrations**: **no migration framework** — `db/schema.sql` is a full-schema script for a
  fresh empty database only; re-running it against a populated database fails on `CREATE TABLE`
  (documented and accepted risk, `docs/DEPLOYMENT.md` §6). This is a real operational constraint on
  *any* platform choice, not specific to one — schema changes always require a manual `ALTER TABLE` step
  before deploying dependent code, everywhere.
- **Background jobs**: `db/backup.js` and `db/restore-drill.js` are one-shot scripts invoked with
  `node <script>.js` — no built-in scheduler in the app itself. **This means "scheduled backups" is
  entirely a platform-level requirement** (a cron primitive), not something the app provides.
- **Health/shutdown/logging**: `GET /health` (DB round-trip check, no internal detail leaked),
  `SIGTERM`/`SIGINT` graceful shutdown with a 10s hard-exit safety net, structured single-line JSON logs
  to stdout/stderr with explicit secret redaction (`middleware/request-logger.js`) — all platform-neutral,
  work identically wherever the process runs, already verified live in Phase 6.5.
- **CORS / security headers / error sanitization**: all gated on `NODE_ENV === "production"` *exactly*
  (`middleware/cors.js`, `middleware/security-headers.js`, `middleware/error-sanitizer.js`) — confirmed
  by grep across the whole codebase. **This directly affects the staging env var choice**: `NODE_ENV`
  must be literally `production` for these protections to activate, regardless of which platform is used
  or what the environment is *called*. Documented in `docs/CLOUD-STAGING-RUNBOOK.md`.
- **Frontend**: `public/*.html` served by the same Express process (`express.static`) — no separate CDN
  or frontend host needed. API base URL already resolves to same-origin at runtime
  (`window.SATAMONI_API_URL || (same-origin, or localhost:4000 only under file://)` —
  `public/satamoni-pos.html:330`), so no cloud-specific frontend rewiring is required on any platform.

**Infrastructure dependency list** (minimum, in order of necessity):
1. A place to run one long-lived Node.js process, reachable over HTTPS, that can read `PORT` from the
   environment.
2. One managed PostgreSQL 13+ instance, reachable from that process, with SSL.
3. A way to set environment variables (`DATABASE_URL`, `DB_SSL`, `JWT_SECRET`, `NODE_ENV`,
   `CORS_ORIGINS`) without committing them to git.
4. A way to run `node db/backup.js` on a schedule (a real cron primitive — not "the app happens to still
   be running", since the app has no internal scheduler).
5. Log output visible somewhere (stdout/stderr capture — all four platforms provide this natively).

Nothing here requires Kubernetes, microservices, a message queue, or a different database engine — the
audit does not surface a reason to add any of that, and Phase 7A's own instructions rule it out anyway.

## 3. Cloud Requirements

| Requirement | Why | Satisfied by |
|---|---|---|
| Node.js hosting from GitHub, HTTPS included | Zero-effort TLS termination — the app itself speaks plain HTTP (`docs/DEPLOYMENT.md` §4) | Any of the four |
| Managed PostgreSQL 13+, SSL | Hard schema requirement (`gen_random_uuid()` default) + now-fixed `db/pool.js` SSL support | Any of the four |
| Real cron primitive | `db/backup.js` needs to run unattended, daily, without the web process babysitting it | Render (dedicated Cron Job service, confirmed via current docs), Railway (per-service cron, 5-min min interval), DigitalOcean App Platform (scheduled jobs, billed only for run time) — **not native on AWS** without assembling EventBridge + Lambda/ECS Task, extra moving parts |
| Explicit env var config, no secrets in git | Matches existing `db/env-validation.js` contract exactly | Any of the four |
| Horizontal scaling headroom (future, not now) | Stateless design already supports it | All four support multiple instances; only meaningfully differs in complexity to configure |

## 4. Platform Comparison

| Platform | Satamoni Fit | Setup Complexity | Managed PostgreSQL | HTTPS | Native Backups | Native Cron | Scaling | Monitoring | Est. Cost (small) | Main Risks |
|---|---|---|---|---|---|---|---|---|---|---|
| **Render** | **Strong** — matches current stateless single-service design exactly; repo already has a `render.yaml` Blueprint from earlier prep | **Lowest** — GitHub-connected Blueprint or dashboard, auto TLS | Yes, dedicated product, $6/mo (256MB) and up | Automatic | Daily automated backups on paid Postgres plans (point-in-time restore on higher tiers — confirm exact retention at signup) | **Yes — dedicated Cron Job service type**, guarantees no overlapping runs, up to 12h runtime | Vertical easy; horizontal via multiple web service instances | Built-in logs/metrics dashboard, external webhook alerts | ~$13/mo (Starter web $7 + Basic Postgres $6) | Free-tier Postgres auto-expires after 30 days (must upgrade before pilot data matters); smaller company than AWS/DO, less enterprise track record |
| **Railway** | **Good** — same simplicity class as Render | Lowest, usage-based billing model takes a bit more reading to predict cost | Yes, usage-billed (storage/CPU/memory) | Automatic | Available, less standardized documentation on retention/PITR than Render/DO in what's publicly verifiable right now | Yes, per-service cron, **5-minute minimum interval**, skips (does not queue) overlapping runs, UTC only | Vertical easy; horizontal supported | Built-in logs/metrics | ~$15–30/mo realistic for small Node+Postgres app (per current published estimates) | Usage-based billing is less predictable than flat tiers; younger platform, backup guarantees less clearly documented publicly than Render/DO |
| **DigitalOcean App Platform** | **Good, more headroom for growth** | Low — GitHub-connected, resource-based sizing (fixed tiers were removed in 2026) | Yes, more mature managed-DB product line (same team as DO's broader Droplet/Kubernetes offerings), **from $15/mo single-node, $60/mo HA** | Automatic | DO Managed Databases include automated daily backups as a standard managed-DB feature (general DO product behavior — confirm exact PITR window at signup) | Yes — scheduled jobs alongside deploy-time jobs, billed only for actual run time | Vertical + horizontal, more mature autoscaling controls than Render/Railway | Solid built-in + integrates with standard external tooling | ~$20/mo (small web service ~$5 + Postgres $15) | Higher floor cost than Render/Railway for the DB specifically; still simpler than raw AWS but a step up in dashboard complexity from Render |
| **AWS (Elastic Beanstalk + RDS)** | **Overkill at current scale** | **Highest** — VPC, security groups, IAM roles, load balancer, EB environment, RDS instance/subnet group all need explicit setup | Yes — RDS PostgreSQL, the most mature/battle-tested option of the four, automated backups + PITR built in | Requires explicit ACM cert + load balancer listener config (not automatic like the other three) | Yes, RDS automated backups + snapshots, very mature | **No native simple primitive** — needs EventBridge Scheduler + Lambda/ECS Fargate task, real extra infrastructure to build | Best-in-class if genuinely needed (auto-scaling groups, multi-AZ) | CloudWatch — powerful but requires real setup effort to get equivalent visibility to the other three's out-of-box dashboards | ~$40–80+/mo minimum (EC2 + ALB + RDS, before any HA) | Highest operational burden by far for a small team; App Runner (the "simple" AWS on-ramp) is reported as being deprioritized for new workloads — Elastic Beanstalk is the only reasonable AWS entry point right now, and it still needs real AWS operations knowledge |

*(Pricing figures above are current-as-of-search published estimates gathered via web search during
this phase, not live quotes from a signed-in account — verify exact current numbers on each platform's
own pricing page before committing a card. Labelled as estimates throughout Section 5.)*

## 5. Cost Estimate (labelled estimates, not quotes)

| Stage | Render | DigitalOcean | Notes |
|---|---|---|---|
| **A — dev/staging** | ~$13/mo (Starter web $7 + Basic Postgres $6) | ~$20/mo (small web ~$5 + Postgres $15) | Railway comparable to Render here (~$5–15/mo); AWS has no meaningfully cheaper floor than ~$40/mo even for staging because RDS + ALB have fixed minimums regardless of traffic |
| **B — one real branch** | ~$20–35/mo (Standard web $25 + Postgres $6–15 depending on data volume) | ~$25–40/mo | Traffic from one branch (dozens of orders/day, a handful of concurrent staff) does not stress any of the four platforms' entry tiers |
| **C — ~10 branches, 100 users, 100k+ orders, 1M+ inventory movements** | Postgres storage: a few GB of relational data at this row count is well within Render's mid Postgres tiers (e.g. Pro-4gb class) — **rough estimate $85–150/mo total** (web Standard/Pro tier + a mid Postgres tier + storage overage) | **Rough estimate $100–180/mo total** — DO's managed Postgres HA tier ($60/mo base) plus a larger web instance becomes attractive here for the PITR/HA maturity | AWS at this stage becomes genuinely competitive on raw compute/DB pricing at scale, but the operational overhead argument (needs a person who knows AWS well) still applies unless the team has grown to support it — reassess at this stage, don't pre-decide now |

These are **not exact prices** — they are directional estimates from currently published pricing pages,
meant to answer "does this stay economically reasonable as Satamoni grows," not to be quoted to anyone
as a committed bill.

## 6. Selected Platform: Render

**Why Render over the alternatives, specifically for Satamoni:**

1. **Lowest setup friction for the exact architecture that exists today** — one GitHub-connected web
   service + one managed Postgres, matching the stateless single-process design confirmed in Section 2.
2. **Directly closes the one concrete open gap from Phase 6.5** — a dedicated Cron Job service type
   (verified from current Render documentation) is the correct primitive for `node db/backup.js` on a
   real schedule, which is exactly what "SCHEDULED BACKUPS: NOT VERIFIED" has been waiting on.
3. **Lowest cost at Stages A and B**, which are the stages Satamoni is actually at right now (staging,
   then one controlled pilot branch) — no reason to pay AWS's ~$40+/mo floor for capability the app
   doesn't need yet.
4. **Existing prep investment**: `render.yaml` already exists in the repo (from an earlier phase),
   reducing the actual work left to "create the Blueprint resources," not "design the deployment from
   zero."
5. **Operational simplicity matches team size** — "a small restaurant technology team" (Phase 7A's own
   framing) is the deciding factor against AWS specifically: Elastic Beanstalk + RDS requires real,
   ongoing AWS operations knowledge (VPC, security groups, IAM, EB environment health) that has no
   corresponding payoff at Satamoni's current or Stage-C-projected scale.

**What could cause a switch later:**
- Genuine need for point-in-time-recovery / high-availability Postgres beyond what Render's tiers offer
  → DigitalOcean's managed database product is the more mature option, and is the natural Stage-C
  candidate.
- A dedicated ops/DevOps hire and genuine need for VPC-level network isolation, multi-region, or
  compliance requirements that specifically demand AWS → revisit AWS then, not before.
- Render-specific reliability or support issues in practice (cannot be known until real usage — nothing
  observed here, since nothing has been deployed yet).

**Vendor lock-in assessment: low.** The application has zero platform-specific code — no proprietary
SDKs, no platform-specific storage APIs, `DATABASE_URL` is a standard Postgres connection string, and
`pg_dump`/`pg_restore` (already the backup mechanism) work identically against any Postgres instance
anywhere. Migrating from Render to Railway, DigitalOcean, or AWS later is realistically a day of
re-pointing environment variables and re-running `db/schema.sql` (or restoring a `pg_dump`) against the
new database — not a redesign. This was a deliberate design property confirmed during the audit
(Section 2), not something added for this phase.

## 7. Deployment Architecture

```
GitHub (claude/restaurant-erp-system-jctgj5)
   ↓
Render Web Service (satamoni-staging) — auto-deploy on push, PORT auto-injected
   ↓ HTTPS (Render-terminated TLS, automatic)
Node.js / Express (server.js)
   ↓ DATABASE_URL (Internal URL) + DB_SSL=true
Render Managed PostgreSQL (satamoni-staging-db) — isolated from local/test/production DBs
```

Full click-by-click setup: [`docs/CLOUD-STAGING-RUNBOOK.md`](docs/CLOUD-STAGING-RUNBOOK.md).

## 8–24. Deployment, PostgreSQL, HTTPS, CORS, Authentication, Rate Limiting, Health, Logging, Graceful
Shutdown, Branch Isolation, ERP Workflow Tests, Concurrency, Retry Safety, Performance, Backup, Restore,
Frontend

**All NOT VERIFIED** — no live cloud instance exists yet. Every one of these has a fully specified,
ready-to-execute test procedure waiting in `docs/CLOUD-STAGING-RUNBOOK.md` (Steps 4–15), written against
this exact codebase (not generic), with explicit `<<املأ هنا>>` fill-in points for real results. What is
already true independent of deployment:

- **PostgreSQL / SSL readiness**: code-level fix shipped and tested locally (Section 2) — the *code* is
  ready; the *live connection* is not yet attempted.
- **Frontend cloud-readiness**: audited (Section 2) — no hardcoded localhost dependency blocks cloud
  use; confirmed by grep, not assumed.
- **Automated test suite**: 311/311 passing locally (308 pre-existing + 3 new for the SSL config) —
  this validates application logic, not cloud behavior.

## 25. NOT VERIFIED

Cloud deployment, HTTPS in a real cloud environment, multi-instance behavior, scheduled backups
(no scheduler exists anywhere yet — platform-level cron has not been configured), cloud-scale
performance, CORS against a real second origin, rate limiting over a real network path, JWT lifecycle
against a live deployed token issuer, branch isolation over the real API, cloud concurrency, network
retry/double-submit over a real network, backup/restore against a real managed Postgres instance,
external backup storage strategy (not yet decided or implemented — `db/backup.js` currently writes to
local filesystem only, wherever it runs), printing (not implemented), KDS (not implemented).

## 26. Remaining Risks

- **Network policy blocker is environment-specific, not platform-specific** — even after picking Render,
  this exact session cannot execute the deployment; it requires the runbook to be run by someone/somewhere
  with real network access.
- **`DB_SSL=true` / `rejectUnauthorized: false` is the standard pattern for managed Postgres but was not
  confirmed against a live Render connection in this phase** — first real deploy attempt is also the
  first real test of this.
- **No migration framework** remains a standing operational risk for any future schema change, on any
  platform (Section 2) — unchanged by this phase, already documented in `docs/DEPLOYMENT.md` §6.
- **Backup storage location undecided** — `db/backup.js` writes locally; a real external storage
  destination (separate from the database server itself) has not been chosen or implemented. Flagged
  explicitly in the runbook (Step 13) rather than assumed solved.

## 27. Final Recommendation

Execute `docs/CLOUD-STAGING-RUNBOOK.md` against a real Render account to move every item in Section 25
from NOT VERIFIED to an actual result. Do not skip the `NODE_ENV=production`-for-staging decision
(Section 2/runbook) — using `NODE_ENV=staging` literally would silently disable CORS lockdown, HSTS, and
error sanitization. Once the runbook's results come back, this report will be extended with real
Sections 8–24 outcomes and a real Overall classification. Until then, the honest classification is
below.

---

## FINAL STATUS BLOCK

```
PHASE 7A STATUS:

Recommended Cloud Platform:
Render (see Section 6 for full rationale)

Platform Alternatives:
Railway (close second, comparable simplicity/cost, less-documented backup guarantees)
DigitalOcean App Platform (natural Stage-C step-up — more mature managed Postgres, higher floor cost)
AWS Elastic Beanstalk + RDS (most capable, disproportionate operational overhead for current team size;
App Runner specifically not recommended — reported deprecated for new workloads)

Cloud Deployment:
NOT VERIFIED

HTTPS:
NOT VERIFIED

PostgreSQL:
NOT VERIFIED (SSL support code-level fix VERIFIED locally — 3/3 new tests passing; live cloud connection NOT VERIFIED)

CORS:
NOT VERIFIED

Authentication:
NOT VERIFIED

Rate Limiting:
NOT VERIFIED

Health:
NOT VERIFIED

Logging:
NOT VERIFIED

Graceful Shutdown:
NOT VERIFIED

Branch Isolation:
NOT VERIFIED

ERP Workflows:
NOT VERIFIED (no live cloud instance to run them against)

Cloud Concurrency:
NOT VERIFIED

Retry Safety:
NOT VERIFIED

Performance:
NOT VERIFIED

Backup:
NOT VERIFIED

Restore:
NOT VERIFIED

Scheduled Backup:
NOT VERIFIED

Frontend:
PARTIALLY VERIFIED (code audit confirms no hardcoded localhost/cloud-blocking dependency; not tested against a live cloud URL)

Printing:
NOT IMPLEMENTED

KDS:
NOT IMPLEMENTED

Automated Tests:
311/311

Overall:
NOT VERIFIED

Critical Issues:
None found in the application code itself. The blocker is purely environmental: this session cannot reach any cloud provider's network.

High Issues:
db/pool.js had no SSL configuration — would have failed the first connection attempt to any managed cloud Postgres. Fixed and tested in this phase (tests/pool-ssl.test.js, 3/3 passing).

NOT VERIFIED:
Everything in Section 25 — full list there. Summary: all cloud-dependent validation (deployment, HTTPS, CORS, auth-over-network, rate limiting, health, logging, shutdown, branch isolation, ERP workflows, concurrency, retry safety, performance, backup, restore, scheduled backup) plus external backup storage strategy.

Exact blockers:
This session's network egress policy denies all outbound access to render.com (confirmed: 403 policy denial on api.render.com, render.com, dashboard.render.com via the proxy). No credentials or API access to any of the four evaluated platforms exist in this session either way. Real deployment requires a human with dashboard access, or a session with an open network policy, to execute docs/CLOUD-STAGING-RUNBOOK.md.

Recommendation:
Platform decision is made (Render) and is low-risk to revisit later given confirmed low vendor lock-in (Section 6). Next concrete action: a human executes docs/CLOUD-STAGING-RUNBOOK.md against a real Render account and reports results back, at which point Sections 8-24 of this report get filled in with real outcomes and Overall gets reclassified honestly. Do not proceed to Printing, KDS, multi-branch rollout, or Phase 7B/7C until that happens.
```
