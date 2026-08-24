# CR-2026-094 — Deployment parity, customer database restoration, release process

**Status:** Implemented. **Local commit only, not pushed**, per the directive.
(docs/107 is reserved for CR-2026-093's inspection hub documentation.)

---

## 1. Root cause

**Local customer records came from a one-time controlled import — `apps/api/scripts/import-customers.ts` and `import-jobs.ts`, run on 2026-06-09 against the local database, reading gitignored SharePoint export files (`customers.csv`, `jobs.csv`) — while deployment receives only migrations plus the reference seed from `render.yaml`. The deployed database therefore has the full schema and reference data but zero customers, vehicles and visits: the import was simply never run against it, and no documented, operator-runnable path existed for anyone to do so.**

What it was **not**:

- Not a frontend bug — the Customers page and API deploy identically.
- Not environment gating — no approved module reads `NODE_ENV` (now enforced by a test).
- Not missing migrations — `render.yaml` runs `prisma migrate deploy` + `db:seed` on every push.
- Not a privacy failure — every real-data file at the repo root is untracked and gitignored; nothing needed flagging under §26.

Proof the local data came from the import: `pnpm customers:verify` lists the two batches on `ExternalSystemRef` — customers batch `10b5c669…` (7,157 refs, 2026-06-09 19:23 UTC) and jobs batch `c6b22e3c…` (9,055 refs, 20:33 UTC).

## 2. The three data classes, and where each now travels

| Class | Examples | Path to production |
|---|---|---|
| Schema | tables, enums, indexes | `prisma migrate deploy` (additive; runs on every deploy) |
| Reference data | catalogue, KPI policy + mappings, inspection templates, roles, site, rules | `pnpm db:seed` (idempotent, create-if-missing; runs on every deploy) |
| Operational data | customers, vehicles, visits, tickets, orders, inspections | **controlled import only** — dry-run, review, commit, verify; never seeded, never committed to git |

## 3. What was built

| Piece | Where | What it does |
|---|---|---|
| `pnpm deploy:check` | `scripts/deploy-check.mjs` | Read-only preflight: env presence, DB connection, migrations, reference counts, operational counts. PASS/FAIL, non-zero exit on failure. Also runs as the **last step of the Render build**, so a broken deploy fails instead of serving. |
| `pnpm deploy:bootstrap` | `scripts/deploy-bootstrap.mjs` | Env validation → `migrate deploy` → seed → preflight. No destructive path exists in it. |
| `pnpm customers:import[:commit]` | wraps `apps/api/scripts/import-customers.ts` | The **existing** proven importer (dry-run default, idempotent upserts on `customerNumber`/`vehicleCode`, batch-tagged, `--rollback <batchId>`). No second mechanism was built — §5 honoured. |
| `pnpm jobs:import[:commit]` | wraps `import-jobs.ts` | Same pattern for historical visits. |
| `pnpm customers:verify` | `scripts/customers-verify.mjs` | Read-only: totals, orphaned relationships, duplicate candidates, import batches. Exit 1 on empty or structural problems. |
| `GET /api/v1/health` | `modules/health` | Public-safe: status, **build commit** (`RENDER_GIT_COMMIT`/`BUILD_COMMIT`), environment, DB reachability, latest migration. No secrets, ever. |
| `GET /api/v1/health/deployment` | same module | Admin (`config:view`): reference/operational counts, configuration **presence**. |
| Admin → Deployment | `apps/web/.../admin/deployment` | The same facts as a page: answers "did the deploy get the customer database?" without terminal access. |
| Build stamp | `next.config.ts`, sidebar footer | `Build: <sha7>` shown to managers; blank locally rather than invented. |
| Customers empty-state diagnostic | customers page | Directory total 0 → amber "Customer database is currently empty" + link to Deployment, instead of "No customers match". |
| `db:reset` fence | `scripts/guard-not-production.mjs` | The one destructive command refuses non-local `DATABASE_URL`. |
| Env contract | `.env.example` | Every variable the code reads, grouped and marked required/prod/optional/dev-only. Startup already fails fast via `validateEnv` (zod) on missing `DATABASE_URL`/short `JWT_SECRET`. |

## 4. Feature parity matrix

Verified: no approved module is environment-gated (enforced by `production-parity.spec.ts`, which also keeps an allow-list of the two legitimate dev-only gates). Every area below deploys identically to local; the only variable is **data**.

| Area | Route | Role | Needs data from | Production expectation |
|---|---|---|---|---|
| Dashboard | `/admin/dashboard` | Manager | live use | available |
| Appointments | `/appointments` | Advisor+ | live use | available |
| Customers | `/customers` | Advisor+ (directory: Manager) | **import** | available; diagnostic empty state until import |
| Vehicles | `/vehicles` | Advisor+ | **import** | available |
| Check-in / Queue | `/check-in`, `/queue` | Advisor+ / all staff | seed + live use | available |
| Dispatch | `/dispatch` | Advisor+ | live use | available |
| Technician (My Work) | `/technician` | Technician | live use | available |
| KPI strip/reports | `/reports/technician-kpi` etc. | Manager | seed (policy+mappings) | available |
| Inspections | `/inspections` | all staff | seed (template) | available |
| Work orders | via queue/dispatch | Advisor+/Tech | live use | available |
| Customer display | `/display/<token>`, `/status/<token>` | public token | live use | available |
| Service catalogue | `/admin/service-catalogue` | Manager | seed | available |
| Reports | `/reports/*` | Manager | live use | available |
| Administration | `/admin/*` | Manager | seed | available |
| Audit | API + admin views | Manager | live use | available |
| Deployment status | `/admin/deployment` | Manager | — | available (new) |
| Dev login | `/dev-login` | — | — | **dev-only by design** (`ALLOW_DEV_LOGIN` + non-production) |
| Visual QA | `/dev/visual-qa/*` | — | — | **dev-only by design** (`ENABLE_VISUAL_QA` + non-production) |

## 5. Storage and workers, stated honestly

- **Inspection photographs** use the `local` disk driver; Render free tier has no
  persistent disk, so they do not survive a redeploy. Documented in
  `DEPLOYMENT.md` §9; the driver boundary exists precisely so production object
  storage is a driver change. An unknown driver value fails startup loudly.
- **Redis/BullMQ**: not wired in deployment (render.yaml deploys no worker; the API
  runs without Redis). Local Redis is a dev convenience. `DEPLOYMENT.md` §1 now says
  so, replacing the stale claim that Redis 7 was a production prerequisite.

## 6. Clean-checkout simulation

Performed from a fresh `git worktree` against an isolated database (`bsop_clean_test`),
per §24: checkout → `pnpm install --frozen-lockfile` → `prisma generate` →
`migrate deploy` → `db:seed` → `deploy:check` → full `pnpm build`. Result recorded in
the completion report; the working database was never touched.

## 7. Tests

27 new (health + parity specs): build identity from the platform stamp with fallback,
degraded-not-crashed on DB failure, **no secrets in any payload** (asserted against
planted secret values), empty-customer-DB reported as a note rather than a failure,
reference-vs-operational separation, permission on the admin tier and none on the
public tier, missing tables reported as null, and one spec per approved module
asserting no `NODE_ENV` gating plus an allow-list check that names why each permitted
gate exists.
