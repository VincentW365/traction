# CR — GitHub Deployment Parity, Seedable Forms & Repository Completeness

**Status:** Implemented (audit + corrections + mandatory fresh-clone proof)
**Date:** 2026-09-07
**Baseline:** builds on CR-2026-094 (docs/108) and CR-2026-099 §8 (docs/113);
this audit re-verifies parity after everything CR-095 → CR-104b added.

## A. Missing deployment items found (and fixed)

1. **Service Mix analytics runbook gap** — the Reports → Service Mix page reads
   `service_catalog_items` (206 rows locally) + `service_job_mappings` (1,644),
   produced by `import-catalog.ts` / `map-jobs.ts`, which appeared in **no**
   deployment document. A fresh deploy would show that one report empty with no
   explanation. → Documented as the *optional* historical-analytics import
   (DEPLOYMENT.md §6, manifest "Data" step 3). All other reports are unaffected.
2. **Personal-machine default path** in `apps/api/scripts/import-catalog.ts`
   (`C:\Users\vwilson\Downloads\…`). → Removed; `--file` is now required with a
   clear usage error.
3. **Hard-coded repo path** in `tools/generate-inspection-docx.ps1`. → Paths now
   derive from `$PSScriptRoot`.
4. **Silent web-build fallback**: a production build without `NEXT_PUBLIC_API_URL`
   silently derives the API from the page host (correct for LAN, wrong on
   split-host platforms). → `next.config.ts` now prints a loud build warning
   (not a failure — the documented Render bootstrap intentionally builds once
   before the URLs exist).
5. **`PORT` precedence undocumented** (platform-injected `PORT` beats `API_PORT`;
   `apps/api/src/main.ts:54`). → Noted in `.env.example`.
6. **`docs/DEPLOYMENT_HANDOFF.md` was frozen at the CR-094 release.** → Rewritten
   as the standing §16 deployment manifest (repo/versions/services/setup/data/
   verification/limitations).
7. **No restore procedure** documented. → DEPLOYMENT.md §8b: `pg_dump`/`pg_restore`
   commands, photo-directory caveat, test-a-restore instruction.
8. **No schema-drift check** (§22). → `deploy:check` now runs a read-only
   `prisma migrate diff` (URL via the schema's `env()` — never on a command
   line); warn-only so a diff-engine hiccup can never block a deploy.

Postgres version pins corrected to 16+ (verified on 16 and 17).

## B. Forms & templates — how each is reproduced

| Form | Mechanism |
|---|---|
| Visual Vehicle Inspection (30 items, 4 categories) | seed → `InspectionTemplate` VEHICLE_INSPECTION **v1**, keyed `kind_version` (versioned, §13); app picks highest active version, so an operator's newer template always wins a reseed |
| Pre-Inspection (photo-first) | seed → PRE_INSPECTION v1, same mechanism |
| Job sheet / job card | application pages (code); blank printable card tracked at repo root (`Blank_Service_Centre_Job_Card-1_one_page.pdf`); drafts are operational data |
| Customer notification templates (12) | seed, create-if-missing — manager-edited wording survives every deploy; API self-heals a missing key from factory wording |
| KPI policy v1 + 6 benchmarks + service component mappings | seed (`kpi-seed-data.ts`) |
| Business rules (50 keys incl. queue rules, operating hours, oil presets, KPI bands) | seed, create-if-missing |
| Vehicle weight/class suggestions (23) | seed (idempotent reseed of the lookup) |
| Bays (6) + DMAIC work resources (stands, mobile jacks, power wash, external) | seed; further resources are in-app configuration (Setup → Resources & Bays) |
| Check-in / walk-in / appointment / intake forms | application code |

**Category-5 check (manually-created-only forms): none found.** The database diff
(§H) shows no template/form present locally that a fresh seed does not create.

## C. Scripts

- **Deployment-required:** `scripts/deploy-check.mjs`, `deploy-bootstrap.mjs`,
  `guard-not-production.mjs`, `customers-verify.mjs`;
  `apps/api/scripts/import-customers.ts`, `import-jobs.ts`, `verify-import.ts`,
  `verify-jobs.ts`. All committed, documented, path-independent.
- **Optional (Service Mix analytics):** `import-catalog.ts`, `map-jobs.ts`.
- **Dev-only / one-time (headers state their CR and purpose):** `start-redis.bat`
  (local Redis; not needed in deployment), `verify-kpi-contributions.mjs` (CI
  guard), `capture-kpi-screenshots.mjs` (review evidence),
  `scripts/sharepoint/*` (one-time extraction analysis), and the api-scripts
  backfills/`migrate-role-consolidation`/`seed-dev-users`/`create-test-logins`/
  `cleanup-dev-sessions`/`test-data` (env-gated)/`match-exported-mileage`
  (one-off)/`reseed-weight-suggestions`+`seed-inspection-template` (superseded by
  the main seed, kept as targeted tools).

## D. Database

- **Empty DB → migrations → seed → app starts**: proven end-to-end (§G) with zero
  manual SQL. Latest migration `20260901210000_cr_2026_101_visit_notes`.
- **Upgrade path**: the long-lived local database (every CR since Phase 1) shows
  **zero schema drift** against `prisma/schema.prisma` — additive migrations only.
- **Seed** is idempotent and create-if-missing throughout; technician roster is
  first-install-only (deleted staff stay deleted); reseeds never overwrite
  operator edits. §12: the seed creates **no** fake customers, vehicles, queue
  tickets or jobs (fresh DB operational tables all 0); demo/test tooling is
  env-gated (`ALLOW_TEST_DATA_TOOLS`, refused in production).
- **Business data** arrives only by the controlled import (dry-run → commit →
  verify, batch-tagged, rollback-able). FK integrity is checked by
  `customers:verify` (orphan counts) and `deploy:check` (inspection↔visit
  integrity, visit numbering).

## E. Assets

Tracked and verified rendering after a production build: `apps/web/public/`
(`logo.png`, `brand-mark.png`, `berts-logo.png`, `body-damage.png` — smoke-tested
200 from the fresh clone), root reference PDFs/images (blank job card, inspection
form, `car.webp`/`tire.webp`/`prior-body-damage.png`). No runtime path points at
`C:\…`, a user directory, or a hard-coded host; the API base is env-derived per
call. The source `.docx`/`.xlsx`/SharePoint exports at the repo root remain
**deliberately untracked** (PII/raw sources; their digitized equivalents live in
seed + code + tracked PDFs).

## F. Environment (names only — see `.env.example` for the full annotated contract)

- **Required:** `DATABASE_URL`, `JWT_SECRET` (32+; startup fails without both).
- **Production:** `API_CORS_ORIGIN`, `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_WS_URL`
  (build-time), `NODE_ENV=production`, `ALLOW_DEV_LOGIN=false`.
- **Optional:** `PORT`/`API_PORT`, `JWT_ACCESS_EXPIRY`, `JWT_REFRESH_EXPIRY`,
  `LOG_LEVEL`, `LOG_FORMAT`, `DEFAULT_SITE_CODE`, `NOTIFICATION_PROVIDER`,
  `NOTIFICATION_MODE` (+ `NOTIFICATION_TEST_SMS_TO`/`_EMAIL_TO`), `TWILIO_*`,
  `EMAIL_PROVIDER` + `SMTP_*`, `VIN_DECODE_PROVIDER`, `INSPECTION_PHOTO_DRIVER`/
  `INSPECTION_PHOTO_ROOT`, `REDIS_*` (dev only in practice), `BUILD_COMMIT`/
  `BUILD_TIMESTAMP` (platform metadata).
- **Dev-only:** `ALLOW_DEV_LOGIN`, `ALLOW_TEST_DATA_TOOLS`, `ENABLE_VISUAL_QA`.
- Startup fails fast via zod (`packages/config/src/env.ts`); `deploy:check`
  verifies presence without echoing values.

## G. Fresh clone parity test (§17 — mandatory)

Procedure (nothing reused: no existing `node_modules`, builds, database, uploads):

1. `git clone https://github.com/claudesdisciple/bsopplatform.git C:\Users\vwilson\bsop-fresh`
   → tip `6336bb6` = `origin/master`.
2. Fresh empty `bsop_parity` database (Postgres 17).
3. `.env` per the contract (isolated ports 3002/3010, generated secret,
   `ALLOW_DEV_LOGIN=false`).
4. `pnpm install --frozen-lockfile` → clean, 15.5 s (isolated linker: any phantom
   dependency would have failed here — none did).
5. `prisma generate` → `db:migrate` (full chain on empty DB) → `db:seed`
   (17 users, 30 service types, 50 rules, 12 technicians + skills, 6 bays,
   10 resources, both inspection templates, KPI policy + 6 benchmarks +
   30 mappings, 12 notification templates) → **`deploy:check` PASS (18 ok /
   2 expected empty-customer warnings / 0 failures)**.
6. `pnpm build` → API + web production builds, 39.4 s, zero cache.
7. Booted API (3002) + web (3010) from the build outputs.
8. Scripted smoke: **33/33 PASS** — health + migration identity; Manager,
   Advisor and Technician (seeded roster) logins; catalogue ≥28; queue board;
   KPI / performance-report (honest `hasData:false`, technician 403) /
   job-times / service-mix; technician My Jobs + workday; pause-approvals
   queue; dispatch resources overview naming the DMAIC stands/jacks;
   12 notification templates; public display board by token; customer
   directory; web pages `/login /reports /technician /queue /dispatch
   /inspections /customers /appointments /check-in`; `berts-logo.png`; public
   display page.
9. Teardown: processes stopped, `bsop_parity` dropped, clone deleted.

## H. Local vs fresh differences (§3/§18) — all dispositioned

| Difference | Disposition |
|---|---|
| Operational tables (customers 6,899, vehicles 8,288, visits 9,117, orders, tickets, audit, pauses, segments…) local-only | Correct by design — travel via controlled import / live use, never Git |
| `service_types`: local extra `AC-01`, `AC-02`, `BEL-01` (+3 KPI mappings) | Discontinued/legacy codes deliberately removed from seed (CR-2026-042); the KPI seed's skip-list names them. Kept locally for historical rows; a fresh deploy correctly starts without them |
| `business_rule_configs`: local extra `pre_noon_followup_*` | Dead legacy keys — code reads only `midday_followup_*` (seeded). No action |
| `work_resources`: local extra `BAY-01…07` | Pre-CR-095 leftovers; the seed ships the DMAIC-confirmed capacity (stands, mobile jacks, power wash, external — category `BAY` where dispatchable). Further resources are in-app configuration |
| Local extra staff/user accounts; local *missing* MANAGER/FRONT_DESK logins | In-app staff management on the local side (including deliberate deletions); fresh deploy has the full core login set |
| Templates, notification wording, KPI policy, bays, rules otherwise | **Identical** |

No feature visible locally disappears in the fresh clone for lack of repository
configuration.

## I. Remaining external requirements (outside GitHub)

1. Render cross-service URLs after the first deploy (`API_CORS_ORIGIN`,
   `NEXT_PUBLIC_*` + one web redeploy) — DEPLOY_RENDER.md.
2. Secure transfer of `customers.csv` / `jobs.csv` (and optionally the price-list
   workbook) for the controlled imports.
3. Change every seed password — Admin → Deployment lists the affected accounts
   until none remain.
4. Schedule the off-platform `pg_dump` (DEPLOYMENT.md §8b) — biggest open
   operational risk.
5. Persistent disk / object storage before inspection photographs matter.
6. Go-live notification envs (`NOTIFICATION_MODE=LIVE`, provider credentials)
   when the shop decides to message real customers.

## J. Git

Branch `master`, pushed to `origin/master` (commit hash in the completion report).
