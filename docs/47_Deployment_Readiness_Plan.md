# 47 — Production Deployment Readiness Plan

**Author:** Vincent Wilson · **Date:** 2026-06-10
**Status:** Planning only. No code, infra, or environment changes are made by this document. Implementation of any item below requires explicit approval.
**Baseline:** tag `save-point-post-sharepoint-sync-runbook` and later (HEAD `2d85143`). Stack: modular monolith — NestJS API (`apps/api`) + Next.js web (`apps/web`), PostgreSQL (Prisma), Redis/BullMQ, pnpm/turbo monorepo.

> This is a checklist + procedure, not an execution. Items marked **[GAP]** do not exist yet and would each be a separate, approved change before go-live.

---

## 1. Environments
| Env | Purpose | Data | Notes |
| --- | --- | --- | --- |
| **local/dev** | development | seed + (optional) imported PII | `docker compose` Postgres 16 + Redis 7; VIN/notifications stubbed. |
| **staging** | pre-prod validation, UAT | seed + a sanitized/representative import | mirror prod config; run the fresh-clone reproducibility check (`HOW_TO_RUN.md`). **[GAP]** to provision. |
| **production** | live single site (`BERT-01`) | real customer/vehicle/job data | managed Postgres + Redis; secrets in a manager; backups on. **[GAP]** to provision. |
- Promote by git tag; never edit prod data by hand. Keep `staging` config byte-identical to `production` except endpoints/secrets.

## 2. Database — backups / restore
- **Engine:** PostgreSQL 16 (dev via `postgres:16-alpine`; prod → **managed Postgres** recommended for automated backups + PITR).
- **Backups:** nightly automated `pg_dump` (or managed snapshot) + WAL/PITR retained ≥ 14 days. Store encrypted, off-host. Test backups are restorable monthly.
- **Restore drill (documented procedure):** provision empty DB → restore latest dump → `pnpm db:migrate` (no-op if already current) → smoke-test login + one report. Record RTO/RPO targets (suggest RPO ≤ 24h, RTO ≤ 2h for a single-site pilot).
- **Before each deploy:** take an on-demand snapshot so a bad migration can be rolled back to a known-good DB.

## 3. Migration procedure
- Migrations are committed under `prisma/migrations/` with `migration_lock.toml` tracked (Pact-2 hygiene). Fresh-clone deploy verified (CR-2026-013 / Pass 4C).
- **Deploy flow:** (1) snapshot DB; (2) `pnpm db:migrate` (`prisma migrate deploy` — applies pending only, never resets); (3) deploy API/web; (4) smoke-test. Migrations are **additive/non-destructive** by project rule.
- **Rollback:** prefer forward-fix; for a failed migration, restore the pre-deploy snapshot. Never `migrate reset` in prod.
- **Caveat (from `docs/39`/`43`):** any DB that already applied the old `20260609_cr_2026_008_vehicle_classification` name needs the one-row `_prisma_migrations` rename (or `prisma migrate resolve`). A brand-new prod DB is unaffected.
- **Seed:** `pnpm db:seed` (idempotent) creates reference/users/config only. Production seed should set **real users + a strong rotation of seed passwords** (see §6). Imports/backfills are separate gated steps (§8).

## 4. Redis
- Dev: `redis:7-alpine`. Prod → **managed Redis 7** (BullMQ job schedulers + Socket.IO adapter). Enable auth (`REDIS_PASSWORD`), TLS in transit, and persistence (AOF) if job durability matters.
- The API requires Redis up to boot — include it in health checks and start ordering.

## 5. Secrets
- Config via env (`.env.example` documents all keys). **Never commit `.env`** (gitignored). In prod use a **secrets manager** (cloud KMS/Vault/parameter store) — **[GAP]**.
- Must be set/rotated for prod: `DATABASE_URL`, `REDIS_PASSWORD`, **`JWT_SECRET` (≥32 chars, unique, rotated)**, `API_CORS_ORIGIN`, `NEXT_PUBLIC_API_URL`/`WS_URL`.
- **Safe defaults confirmed:** `VIN_DECODE_PROVIDER=STUB` (live NHTSA is opt-in via `=LIVE`); `NOTIFICATION_PROVIDER=stub` (no Twilio/SendGrid wired). Real SMS/email requires wiring a provider + credentials — **[GAP]/decision** before any customer-facing notifications.

## 6. Roles / users
- RBAC roles (server-enforced, `common/constants/permissions.ts`): **ADMIN, MANAGER, SERVICE_ADVISOR, FRONT_DESK, TECHNICIAN, PARTS_STAFF, TRANSPORT_COORDINATOR**.
- **Go-live:** replace all seeded `@bert.local` dev accounts/passwords; create real staff accounts with least-privilege roles; enforce a password policy; rotate `JWT_SECRET`. Confirm the 12-tech roster maps to real technicians.
- JWT: 15m access / 7d refresh (tune for prod). Auth boundary is provider-agnostic OIDC/JWT — decide IdP if SSO is required.

## 7. Monitoring / logging / audit
- **Logging:** structured (`LOG_FORMAT=json`, set `LOG_LEVEL=info`/`warn` in prod). Ship to a log aggregator — **[GAP]**.
- **Health checks:** **[GAP]** — no `/health` endpoint yet; add a readiness/liveness probe (DB + Redis) for the orchestrator/load balancer before go-live.
- **Metrics/alerting:** **[GAP]** — add uptime + error-rate + queue-depth/job-failure alerts.
- **Audit (already built):** `AuditLog` + `StatusHistory` capture overrides, status transitions, classification confirmations, etc. Ensure audit rows are retained per policy and included in backups. Manager overrides are audited (project rule).

## 8. SharePoint sync cadence
- Per **CR-2026-014 / `docs/43`**: imports are idempotent (no duplicate customers/vehicles/jobs) and preserve staff classification + consent; **removals are ignored** (insert/update only).
- **Cadence (manual, controlled):** re-extract `customers.csv` / `jobs.csv` (gitignored) → **dry-run review** → `--commit` (customers then jobs) → `verify-*` → record the batch id (`--rollback <batchId>` for recovery). Suggested cadence: weekly or on-demand; run with `VIN_DECODE_PROVIDER=STUB`. Automated re-sync remains out of scope (`docs/29` §3.3).

## 9. Go-live checklist
- [ ] Staging + production provisioned (managed Postgres 16 + Redis 7); secrets in a manager.
- [ ] `JWT_SECRET` rotated; real staff accounts created; **all seed dev passwords removed**.
- [ ] `VIN_DECODE_PROVIDER` set deliberately (STUB unless NHTSA approved); notifications provider decided (stub or wired + creds).
- [ ] DB backups enabled + a **restore drill** completed; pre-deploy snapshot automation in place.
- [ ] Migration deploy rehearsed on staging from a fresh DB (`migrate deploy` + `seed`); fresh-clone reproducibility confirmed.
- [ ] **[GAP]** Health endpoint + readiness/liveness probes added.
- [ ] **[GAP]** Build/deploy artifacts (Dockerfile(s) / CI pipeline) created and reviewed.
- [ ] Log aggregation + uptime/error/queue alerts wired.
- [ ] `API_CORS_ORIGIN` / `NEXT_PUBLIC_*` URLs set to prod hosts; TLS terminated.
- [ ] First data load: customers → jobs imports + (optional) classification backfill run as gated steps with dry-run review; counts verified.
- [ ] RBAC smoke test per role; audit logging verified writing on overrides/confirmations.
- [ ] Rollback plan rehearsed (restore snapshot; redeploy previous tag).

---

## 10. Open decisions for the owner (not blockers to this plan)
- Hosting target (managed PaaS vs VM/Kubernetes) — drives the **[GAP]** Dockerfile/CI shape.
- Notifications: go-live with stub (log-only) or wire Twilio/SendGrid?
- SSO/IdP for staff auth, or local accounts?
- Backup retention / RPO-RTO targets for a single-site pilot.

> The **[GAP]** items (staging/prod provisioning, secrets manager, health endpoint, Dockerfile/CI, log aggregation, notification provider) are infrastructure/feature work to be scheduled and approved separately — none are implemented by this document.
