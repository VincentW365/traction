# BSOP — Deployment Guide

Bert's Service Operations Platform (BSOP). This repository is the full application
source for a production deployment. It **excludes secrets, the database, and all
customer data** — see *What's in this repository* at the bottom.

**GitHub is the source of truth**: a clean checkout of the approved commit, plus the
environment variables documented in `.env.example`, reproduces the approved
application. The only legitimate differences between local and deployed are secrets,
operational data, URLs, and infrastructure providers.

> **Deploying after a `git pull`?** With the production env set, run
> **`pnpm deploy:bootstrap`** from the repo root (validate env → migrate → seed →
> preflight; non-destructive, idempotent), rebuild, restart the processes, then
> confirm `GET /api/v1/health` shows the commit you pushed.

---

## 1. Architecture
Monorepo (pnpm workspaces + Turborepo):
- **apps/api** — NestJS REST API (default port **3001**, base path `/api/v1`) + Socket.IO realtime.
- **apps/web** — Next.js 15 web app (default port **3000**).
- **PostgreSQL 16** — primary database (Prisma ORM; migrations included).
- **Redis 7** — *local development convenience only.* BullMQ workers are not wired in
  the current deployment; the Render blueprint deliberately runs without Redis. If
  background workers are introduced later, this section and `deploy:check` must gain
  a Redis requirement at the same time.

## 2. Prerequisites (on the target server)
- **Node.js 20+** and **pnpm 10+** (`npm install -g pnpm`, or `corepack enable`)
- **PostgreSQL 16** (managed service or self-hosted)
- *(Optional)* **Docker + Docker Compose** — the included `docker-compose.yml` starts Postgres + Redis for local use.

## 3. Configure environment
`.env.example` is the **complete environment contract** — every variable the
application reads, each marked required/optional/dev-only. In deployment, set
variables in the host's environment (e.g. the Render dashboard), never in a
committed file.

The non-negotiables:
- `DATABASE_URL` — Postgres connection string. Startup **fails without it**.
- `JWT_SECRET` — 32+ random characters (`openssl rand -base64 48`). Startup **fails on less**.
- `API_CORS_ORIGIN` — public URL of the **web** app.
- `NEXT_PUBLIC_API_URL` / `NEXT_PUBLIC_WS_URL` — public URL of the **API** (these are
  baked into the web build; set them **before** building).
- `NODE_ENV=production` and `ALLOW_DEV_LOGIN=false`.

## 4. Database — schema and reference data
```bash
pnpm install --frozen-lockfile
pnpm exec prisma generate

pnpm db:migrate          # prisma migrate deploy — additive, idempotent, never resets
pnpm db:seed             # reference data: site, catalogue, rules, KPI policy, templates
```
Or both plus validation in one step: **`pnpm deploy:bootstrap`**.

`pnpm db:seed` is idempotent and **never touches operational data** — it creates
missing reference rows and leaves everything an operator has edited alone. It also
creates the initial login **`admin@bert.local` / `admin123`** — **change this
password immediately after first login.**

> **Destructive commands are fenced.** `pnpm db:reset` refuses to run when
> `DATABASE_URL` is not local. There is no supported path that drops or wipes a
> deployed database.

## 5. Build + run (production)
```bash
pnpm build                          # builds api (nest) + web (next)
pnpm --filter @bsop/api start       # NestJS API on port 3001
pnpm --filter @bsop/web start       # Next.js web on port 3000
```
Run behind a process manager (pm2 / systemd) or containers, with a reverse proxy
(nginx / Caddy) over **HTTPS**: web to `:3000`, API (`/api/v1` + websocket upgrade)
to `:3001`.

**On Render**: `render.yaml` does all of the above automatically on every push to
master — install, generate, build, migrate, seed, and a final `deploy:check` that
fails the deploy if the environment is broken.

## 6. Loading customer data (the controlled import)
This repository contains **no customer data**. The local/approved customer database
was built with the controlled import tooling in `apps/api/scripts/`, and production
uses **exactly the same tooling** — never a database dump, never a seed script.

The source files (`customers.csv`, `jobs.csv`) are transferred to the deployment
environment **securely and separately** (never by email, never committed).

```bash
# 1. Dry-run (default — writes NOTHING, prints plan + writes a report):
pnpm customers:import -- --file /secure/path/customers.csv

# 2. Review the printed counts: create / update / duplicates / flagged rows.

# 3. Commit (idempotent upserts on customerNumber/vehicleCode; batch-tagged):
pnpm customers:import:commit -- --file /secure/path/customers.csv

# 4. Job history (same pattern):
pnpm jobs:import -- --file /secure/path/jobs.csv
pnpm jobs:import:commit -- --file /secure/path/jobs.csv

# 5. Verify:
pnpm customers:verify
```

Safety properties of the import: dry-run by default; idempotent (re-running updates
rather than duplicates, keyed on stable identifiers, so existing production records
are preserved); batch-tagged on `ExternalSystemRef` (auditable — `customers:verify`
lists every batch); `--rollback <batchId>` removes exactly one batch. It cannot wipe
anything: there is no delete-all path.

The application is **fully functional with an empty customer database** — the
Customers page shows administrators a diagnostic state pointing at the deployment
status page until the import runs.

## 7. Verify the deployment
```bash
pnpm deploy:check        # read-only preflight: PASS/FAIL with reasons
pnpm customers:verify    # after an import: totals, orphans, batches
```
- `GET https://<api>/api/v1/health` — status, **build commit**, environment,
  database reachability, latest migration. Confirm the commit matches what was pushed.
- **Admin → Deployment** in the web app — the same facts plus customer/vehicle
  counts and configuration presence, no terminal needed.
- The sidebar footer shows `Build: <sha>` to managers.

## 8. Rollback
- **Application code**: redeploy the previous commit (Render: "Rollback" on the
  service, or push a revert). The database is not touched by a code rollback.
- **Migrations**: never reverse a migration against a production database. This
  project's migrations are additive; an older application version runs safely
  against a newer schema. If a migration itself must be undone, restore from the
  database backup taken before the deploy — that is what the backup is for.
- **Customer import**: `pnpm customers:import -- --rollback <batchId>` removes one
  batch exactly.

## 9. Storage note (inspection photographs)
Inspection photos are stored through a driver boundary (`INSPECTION_PHOTO_DRIVER`,
currently `local` disk). On hosts without a persistent disk (Render free tier) they
**do not survive a redeploy**. Before production use of photo evidence matters,
attach a persistent disk or implement an object-storage driver — the boundary exists
so that is a driver change, not an application change.

---

## What's in this repository
**Included:** all source (`apps/`, `packages/`, `prisma/` schema + migrations + seed),
build config (`package.json`, `pnpm-lock.yaml`, `turbo.json`, `render.yaml`,
`docker-compose.yml`), `.env.example` (the environment contract), deployment tooling
(`scripts/deploy-*.mjs`, `scripts/customers-verify.mjs`), and documentation (`docs/`).

**Excluded (for security / size):** `.env` (secrets), `node_modules/`, build output,
database backups, uploaded photographs (`.data/`), and **all customer/import data
files** (`customers*.csv`, `jobs*.csv`, `*.xlsx`, `*.xml` — gitignored). Real
customer data moves only through the controlled import above.
