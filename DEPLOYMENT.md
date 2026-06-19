# BSOP — Deployment Guide

Bert's Service Operations Platform (BSOP). This package is the full application
source for a production deployment. It **excludes secrets, the database, and all
customer data** — see *What's in this package* at the bottom.

---

## 1. Architecture
Monorepo (pnpm workspaces + Turborepo):
- **apps/api** — NestJS REST API (default port **3001**, base path `/api/v1`) + Socket.IO realtime.
- **apps/web** — Next.js 15 web app (default port **3000**).
- **PostgreSQL 16** — primary database (Prisma ORM; migrations included).
- **Redis 7** — background jobs (BullMQ) + caching.

## 2. Prerequisites (on the target server)
- **Node.js 20+** and **pnpm 10+** (`npm install -g pnpm`)
- **PostgreSQL 16** (managed service or self-hosted)
- **Redis 7**
- *(Optional)* **Docker + Docker Compose** — the included `docker-compose.yml` starts Postgres + Redis for you.

## 3. Configure environment
1. Copy the template: `cp .env.example .env`
2. Edit `.env`:
   - `DATABASE_URL` — your Postgres connection string.
   - `REDIS_HOST` / `REDIS_PORT` / `REDIS_PASSWORD` — your Redis.
   - `JWT_SECRET` — a strong random secret, 32+ chars (e.g. `openssl rand -base64 48`).
   - `API_CORS_ORIGIN` — public URL of the **web** app (e.g. `https://shop.example.com`).
   - `NEXT_PUBLIC_API_URL` — public URL of the **API** including `/api/v1` (e.g. `https://api.example.com/api/v1`).
   - `NEXT_PUBLIC_WS_URL` — public URL of the API (for websockets).
   - `ALLOW_DEV_LOGIN="false"` — **must be false in production.**
3. Set **`NODE_ENV=production`** in the runtime environment (process manager / host), not just `.env`.

## 4. Install + database
```bash
pnpm install

# If using the bundled data stores:
docker compose up -d            # starts postgres:16 + redis:7

# Schema + reference data:
pnpm exec prisma generate
pnpm exec prisma migrate deploy   # creates all tables (idempotent)
pnpm db:seed                      # site, service catalogue, business rules, bays, etc.
```
`pnpm db:seed` also creates an initial admin login:
- **`admin@bert.local` / `admin123`** — **change this password immediately after first login.**

## 5. Build + run (production)
```bash
pnpm build                          # builds api (nest) + web (next)

# Run each app behind a process manager (pm2 / systemd) or in containers:
pnpm --filter @bsop/api start       # NestJS API on port 3001
pnpm --filter @bsop/web start       # Next.js web on port 3000
```
Put a reverse proxy (nginx / Caddy) in front over **HTTPS**: route the web app to `:3000`
and the API (`/api/v1` + the websocket upgrade) to `:3001`.

## 6. Loading existing data (customers / vehicles / job history)
This package contains **no customer data (PII)**. After the schema + seed are in place,
the production data is transferred **separately and securely** — e.g. a `pg_dump`
restored into the production database by whoever holds the data. **Never email database
dumps.** The app is fully functional without it (it starts with the seeded reference data).

## 7. Smoke test
- API: `GET https://<api>/api/v1/service-types` returns the service catalogue.
- Web: open the site, log in as the admin, confirm Dashboard / Queue / Schedule / Appointments load.
- *(Optional)* `pnpm test` runs the unit/integration suite.

## 8. Useful scripts
- `apps/api/scripts/create-test-logins.ts` — creates per-role test logins (dev/staging only).
- `apps/api/scripts/seed-dev-users.ts` — dev-login DEVTEST users (dev only).
- `HOW_TO_RUN.md` — local development quick-start.

---

## What's in this package
**Included:** all source (`apps/`, `packages/`, `prisma/` schema + migrations + seed),
build config (`package.json`, `pnpm-lock.yaml`, `turbo.json`, `docker-compose.yml`),
`.env.example`, and documentation (`docs/`).

**Excluded (for security / size):** `.env` (secrets), `node_modules/`, build output
(`.next/`, `dist/`), database backups, and **all customer/import data files**. Recreate
dependencies with `pnpm install` and the database with the steps above.
