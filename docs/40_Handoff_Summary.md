# 40 — Handoff Summary (pre-remote)

**Author:** Vincent Wilson · **Date:** 2026-06-10
**Baseline checkpoint:** tag **`save-point-pre-remote-reproducible`** (commit `b7cacbe`).
**Purpose:** One-page orientation for a new developer / reviewer before the repo is moved to a private remote.

---

## 1. Current repo state
- **Bert's Service Operations Platform (BSOP / "Traction")** — a modular monolith: **NestJS API** (`apps/api`) + **Next.js web** (`apps/web`), shared **PostgreSQL** (Prisma), Redis/BullMQ, turbo monorepo (pnpm).
- Branch **`master`** only; linear history; **no remote configured**; working tree clean.
- Quality gates green at baseline: `pnpm typecheck` 5/5 packages; API tests **235/235**; web suite passes.
- **10 save-point tags** mark rollback points (see §10). Current HEAD = `save-point-pre-remote-reproducible`.

## 2. What has been built
A unified service-operations platform with one scheduling brain and shared source of truth:
- Customer / vehicle / appointment / walk-in / check-in, queue ticketing + ranking, deterministic scheduling engine (priority classes, scoring, ETA), technician/bay assignment, service orders, parts readiness, dispatch + public display board, notifications (stubbed), reporting/KPIs, manager dashboard, RBAC + audit/status-history.
- DMAIC business rules enforced server-side (e.g. Rule 3 mobile-jack sedan gate, Rule 5 mileage gate); business-rule values live in `BusinessRuleConfig` (DB), not code.

## 3. Major implemented CRs / features
| CR | Summary | Commit/tag |
|---|---|---|
| Customer/Vehicle import | SharePoint customers + vehicles loaded | `save-point-post-customer-vehicle-import` |
| Contact-field backfill (CR-2026-004) | additive contact fields | `save-point-post-contact-field-backfill` |
| Jobs/visits historical import (CR-2026-005) | 9,055 historical jobs as terminal visits | `save-point-post-jobs-historical-import` |
| Operational scope filtering (CR-2026-006) | exclude HISTORICAL_IMPORT/placeholders from live metrics; `includeHistorical` opt-in | `save-point-post-operational-scope-filtering` |
| ETA average isolation (CR-2026-007) | live-by-default ETA avg w/ historical small-sample fallback | `save-point-post-eta-average-isolation` |
| Vehicle ServiceClass classification (CR-2026-008) | suggestion-assisted, **staff-confirmed** classification + 7,157 PENDING review rows; Rule 3 fail-safe preserved | `save-point-post-vehicle-classification` |
| Classification UI (CR-2026-009) | Operations review queue (filter/search/paging, inline + bulk confirm) | `save-point-post-vehicle-classification-ui` |
| Classification progress report (CR-2026-010) | manager Reports snapshot (remaining/confirmed-by-class/jack-eligible) | `save-point-post-classification-progress-report` |
| Pause/Resume/Rework UI (CR-2026-011) | staff controls over existing recording-only endpoints | `save-point-post-pause-resume-rework-ui` |
| Pre-share cleanup | hygiene, VIN opt-in, config typecheck fix, reproducibility docs, migration-order fix | up to `save-point-pre-remote-reproducible` |

Full CR records: `docs/25`–`docs/38`; audit `docs/39`.

## 4. How to run locally
See **`HOW_TO_RUN.md`** (authoritative). Quickstart from the repo root:
```bash
corepack enable && corepack prepare pnpm@10.33.0 --activate
pnpm install
cp .env.example .env           # set DATABASE_URL + JWT_SECRET (Windows: Copy-Item)
docker compose up -d           # Postgres 16 + Redis 7
pnpm db:migrate && pnpm db:seed
pnpm dev                       # web :3000, API :3001/api/v1, Swagger :3001/api/docs
```
Seeded logins (dev only, `@bert.local`): `admin/admin123`, `manager/manager123`, `frontdesk/frontdesk123`, `advisor/advisor123`, `parts/parts123`, technicians `tech123`.

## 5. Fresh-clone reproducibility status
**Verified ✅** (Pass 4B–4D) on a clean scratch DB: `migrate deploy` + `db:seed` succeed end-to-end; `typecheck` 5/5; tests pass. Verified seed counts: **17 users, 12 technicians, 32 service types, 39 business-rule configs (17 core + 22 v4.1), 6 work bays, 10 work resources, 10 resource occupancies, 23 vehicle weight/serviceClass suggestions.**

## 6. Safe defaults (offline-friendly)
- **VIN decode = STUB by default** (no outbound calls). Live NHTSA vPIC is **opt-in only** via `VIN_DECODE_PROVIDER=LIVE`.
- **Notifications stubbed** — `notifications.module.ts` wires only `StubNotificationProvider`; no Twilio/SendGrid is wired, so no real SMS/email can be sent. `.env.example` has no real secrets.

## 7. Data / import status & rollback
- **Seed = reference/demo data only.** Customers, vehicles, historical jobs, and the 7,157 PENDING classification rows come from **gated scripts**, not seed; their **PII source files are gitignored and not in the repo** → on a fresh clone, Customers search and the classification queue/report are empty until imports/backfill run where source data exists.
- Scripts (dry-run default; `--commit` to write):
  - `apps/api/scripts/import-customers.ts` — `--commit` / `--rollback <batchId>`
  - `apps/api/scripts/import-jobs.ts` — `--commit` / `--rollback <batchId>`
  - `apps/api/scripts/backfill-vehicle-classifications.ts` — `--commit` / `--rollback` (deletes only unreviewed PENDING; preserves CONFIRMED)
  - read-only verifiers: `verify-import.ts`, `verify-jobs.ts`, `verify-classification-backfill.ts`
- Current local `bsop_dev`: historical jobs **already imported** (6,857 customers, 7,157 vehicle classifications).

## 8. Known deferred work
- **ETA tuning** (CR-2026-007 follow-ups): outlier trimming (`eta_avg_outlier_cap_minutes`) + window/threshold tuning once live volume accrues.
- `docs/29` open items: notification opt-in capture (2.2, by design), pre-existing WIP not line-audited (3.1), manual SharePoint re-sync (3.3), data-quality acceptables (4.1–4.3).
- Optional: add `.nvmrc`; later phases (advanced reporting/forecasting, recurring maintenance, transport dispatch enhancements).

## 9. Remote setup recommendation
- **Private repository only** (customer-data lineage) — GitHub/GitLab/Bitbucket per org standard.
- Push **`master`**, then push **all save-point tags** (`git push origin --tags`).
- **No LICENSE yet** — proprietary/internal; root `package.json` is `private: true`.
- Least-privilege collaborators. Run a final secret/PII re-scan before the first push.

## 10. ⚠️ Migration caveat for any EXISTING database
The CR-2026-008 migration was renamed to fix fresh-deploy ordering:
`20260609_cr_2026_008_vehicle_classification` → **`20260609210000_cr_2026_008_vehicle_classification`** (commit `66e67ac`; `migration.sql` content unchanged). The local `bsop_dev._prisma_migrations` was repaired with a one-row name update.
**Any other DB that already applied the OLD name** must, after pulling this rename, apply the same one-row `_prisma_migrations` name update **or** run `prisma migrate resolve --applied 20260609210000_cr_2026_008_vehicle_classification` (after clearing the old row) to avoid drift. **A brand-new clone is unaffected** — it deploys cleanly.

## 11. Save-point tags (rollback points)
`save-point-pre-ui-polish`, `…-post-customer-vehicle-import`, `…-post-contact-field-backfill`, `…-post-jobs-historical-import`, `…-post-operational-scope-filtering`, `…-post-eta-average-isolation`, `…-post-vehicle-classification`, `…-post-vehicle-classification-ui`, `…-post-classification-progress-report`, `…-post-pause-resume-rework-ui`, `save-point-pre-remote-reproducible` (HEAD).
