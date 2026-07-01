# AGENTS.md — instructions for automated / AI deployment agents

**If you are an automated agent (or AI assistant) deploying this repo after a
`git pull` from GitHub, follow this file.** It is the source of truth for the
post-pull deploy sequence. Human guide: `DEPLOYMENT.md`.

## Deploy after pulling from GitHub — one command

From the repo root, with the production environment variables set (see below), run:

```bash
pnpm run deploy
```

That single script is **idempotent** and does everything needed to make a fresh pull live:

1. `pnpm install --frozen-lockfile` — installs dependencies. **Required:** new
   dependencies land this way (e.g. `@nestjs/schedule` for appointment reminders).
   A deploy that skips install will **crash on boot**.
2. `pnpm exec prisma generate` — regenerates the Prisma client.
3. `pnpm run db:migrate` (`prisma migrate deploy`) — applies pending DB migrations.
4. `pnpm run build` — builds `apps/api` (NestJS) and `apps/web` (Next.js) via Turborepo.
5. `pnpm run db:seed` — seeds/refreshes reference + config data (see "Seeding" below).

Then **restart the two long-running processes** (environment-specific — pm2 / systemd /
Docker / your process manager):
- **API**: `pnpm --filter @bsop/api start` (listens on `$PORT` or `API_PORT`, base path `/api/v1`)
- **Web**: `pnpm --filter @bsop/web start` (listens on port `3000`)

## Seeding is idempotent and REQUIRED

`pnpm run db:seed` is safe to run on every deploy. It **does not touch operational data**
(customers, visits, queue, orders, occupancy are create-if-missing / upsert). The only reset
is the `vehicle_weight_suggestions` reference lookup, which is immediately recreated. Running
it is **required** so that, on an already-seeded database, these land:
- **Technician skills** — without the seeded skill spread, specialized services
  (brake/suspension/electrical/etc.) cannot be assigned to any technician.
- **Active inspection template** — without it, starting a vehicle inspection fails
  ("No active inspection template is configured").
- **Business-rule config keys** that otherwise fall back to hardcoded defaults.

The default admin login it ensures is `admin@bert.local` / `admin123` — **change this
immediately** on any internet-reachable deployment.

## Required environment variables
- `DATABASE_URL` — PostgreSQL connection string (required).
- `JWT_SECRET` — min 32 chars (required).
- `NODE_ENV=production`.
- `API_CORS_ORIGIN` — the web app's URL.
- `NEXT_PUBLIC_API_URL` — `<api-url>/api/v1` (baked into the web build; rebuild web if it changes).
- `NEXT_PUBLIC_WS_URL` — `<api-url>`.
- To actually send SMS/email: `NOTIFICATION_PROVIDER=twilio` + `TWILIO_*` (otherwise notifications
  are logged via the stub, not sent).

**Redis is NOT required** — BullMQ is present but not wired; background reminders use an in-app
cron (`@nestjs/schedule`). Only PostgreSQL + the two Node processes are needed.

## Post-deploy health checks
- API up: `GET <api-url>/api/v1` reachable; Swagger at `<api-url>/api/docs`.
- Web up: the site loads and login works.
- Migrations current: `pnpm exec prisma migrate status` reports no pending migrations.

## Cloud (Render) note
`render.yaml` already runs install → prisma generate → build, and `prisma migrate deploy` on start.
It does **not** auto-seed — run `pnpm run db:seed` once in the service shell after the first deploy
(and again after pulling changes that add seed data). See `DEPLOY_RENDER.md`.

## Rollback
Each change is a tagged commit (`cr-YYYY-NNN-*`). To roll back, check out the previous tag and
re-run `pnpm run deploy`. Migrations are additive; do not `prisma migrate reset` on production.
