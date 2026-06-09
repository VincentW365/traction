# BSOP — How to Run (Dev) & What to Remember

**Bert's Service Operations Platform (BSOP / "Traction")** — local development quick-start, login credentials, and operational notes.

> Last updated: 2026-06-09. If commands stop matching reality, check `package.json`, `docker-compose.yml`, and `prisma/seed.ts` — those are the source of truth.

---

## 1. Prerequisites

| Tool | Version | Notes |
| --- | --- | --- |
| Node.js | >= 20 | Required by root `package.json` engines. |
| pnpm | 10.33.0 | The package manager (`packageManager` field). Install with `corepack enable` then `corepack prepare pnpm@10.33.0 --activate`. |
| PostgreSQL | 16 | Via Docker (recommended) or local install. |
| Redis | 7+ | Via Docker, **or** the bundled Windows build in `.local/redis/`. |

---

## 2. First-Time Setup (run once)

From the repo root (`c:\Users\vwilson\Desktop\Projects\Traction`):

```powershell
# 1. Install dependencies
pnpm install

# 2. Create your env file (if not already present)
Copy-Item .env.example .env

# 3. Start Postgres + Redis (Docker — easiest)
docker compose up -d

# 4. Apply database migrations
pnpm db:migrate

# 5. Seed the database (creates site, users, services, rules, techs, bays)
pnpm db:seed
```

> **No Docker?** Start the bundled Redis with `scripts\start-redis.bat`, and point `DATABASE_URL` in `.env` at your local Postgres instance.

---

## 3. Launch in Dev Mode

```powershell
# Runs BOTH the API and the web app together (turbo)
pnpm dev
```

| Service | URL |
| --- | --- |
| Web app (Next.js) | http://localhost:3000 |
| API (NestJS) | http://localhost:3001/api/v1 |
| Swagger / API docs | http://localhost:3001/api/docs |

The login page lives at **http://localhost:3000/login**. After a successful login you are redirected to **/check-in**.

To run just one app:

```powershell
pnpm --filter @bsop/api dev    # API only  (nest start --watch)
pnpm --filter @bsop/web dev    # Web only  (next dev)
```

---

## 4. Login Credentials (seeded)

All seeded accounts use the domain `@bert.local`. Passwords are seeded in plain form below (hashed with bcrypt in the DB). **These are dev-only credentials — never use them in production.**

| Role | Email | Password |
| --- | --- | --- |
| **Admin** | `admin@bert.local` | `admin123` |
| Manager | `manager@bert.local` | `manager123` |
| Front Desk | `frontdesk@bert.local` | `frontdesk123` |
| Service Advisor | `advisor@bert.local` | `advisor123` |
| Technician (demo) | `o.josephs@bert.local` | `tech123` |
| Parts Staff | `parts@bert.local` | `parts123` |

> The real technician roster (12 techs, extracted from the SharePoint job sheet) is seeded with emails in the form `firstinitial.surname@bert.local` (e.g. `m.walker@bert.local`, `o.hamilton@bert.local`), all with password `tech123`. See `technicianRoster` in `prisma/seed.ts`.

> **Admin login → `admin@bert.local` / `admin123`.**

To change a password, edit `prisma/seed.ts` and re-run `pnpm db:seed` (it upserts by email, so existing users keep their password unless you reset — see below).

---

## 5. Database Commands

```powershell
pnpm db:migrate    # Apply pending migrations (prisma migrate deploy)
pnpm db:seed       # Seed reference + demo data (idempotent upserts)
pnpm db:reset      # DROP + recreate + re-migrate + re-seed (DESTRUCTIVE)
pnpm db:studio     # Open Prisma Studio GUI to browse/edit the DB
```

> `db:seed` uses upserts, so it's safe to re-run — but it **won't overwrite an existing user's password**. If you change a password in the seed, run `pnpm db:reset` to apply it cleanly (this wipes all data).

---

## 6. Key Environment Variables (`.env`)

| Var | Default | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | `postgresql://bsop:bsop_dev@localhost:5432/bsop_dev` | DB connection. User/pass `bsop` / `bsop_dev` matches docker-compose. |
| `REDIS_HOST` / `REDIS_PORT` | `localhost` / `6379` | Redis for BullMQ jobs + Socket.IO adapter. |
| `JWT_SECRET` | `change-me-...` | **Must be 32+ chars. Change for any non-local use.** |
| `API_PORT` | `3001` | API listen port. |
| `API_CORS_ORIGIN` | `http://localhost:3000` | Allowed web origin. |
| `NEXT_PUBLIC_API_URL` | `http://localhost:3001/api/v1` | Where the web app calls the API. |
| `NEXT_PUBLIC_WS_URL` | `http://localhost:3001` | WebSocket endpoint. |
| `NOTIFICATION_PROVIDER` | `stub` | SMS/email are stubbed in Phase 1 (no Twilio/SendGrid needed). |
| `VIN_DECODE_PROVIDER` | `STUB` | `STUB` = no outbound calls (recommended local/dev, incl. data import/testing). Any other value/unset = live NHTSA vPIC VIN decode (`vpic.nhtsa.dot.gov`). |

---

## 7. Important Things to Remember

- **Infra must be running first.** The API needs both Postgres and Redis up, or it won't boot. Start `docker compose up -d` (or the Redis batch script) before `pnpm dev`.
- **Default site is `BERT-01`** ("Bert's Auto Parts Service Centre — Main"), timezone `America/Jamaica`. Operating hours: Mon–Fri 08:00–17:00, Sat 08:00–13:00, closed Sunday.
- **Seeded operational data:** 31 service types, 5 technicians (with skills), 6 work bays, work resources (2 stands, 2 mobile jacks, power wash, external machine shop), and ~40 business-rule configs.
- **Business rules live in the DB**, not in code — edit them via `BusinessRuleConfig` (Prisma Studio or admin settings), keyed per site. Don't hard-code rule values.
- **Notifications are stubbed** in dev (`NOTIFICATION_PROVIDER=stub`). No real SMS/email is sent; logs are written to `NotificationLog`.
- **Login redirect:** successful login always lands on `/check-in`. Use the role-appropriate account to see the right screens (front desk vs. technician vs. manager).
- **JWT tokens** are short-lived (`15m` access, `7d` refresh). If the UI logs you out quickly, that's expected in dev.
- **Tests:** `pnpm test` (turbo) runs all; `pnpm --filter @bsop/api test` for API only (vitest).
- **Lint / typecheck before committing:** `pnpm lint` and `pnpm typecheck`.

---

## 8. Common Troubleshooting

| Symptom | Fix |
| --- | --- |
| API won't start / connection refused | Confirm Postgres + Redis are up (`docker compose ps`). |
| "Cannot login" / no users | You skipped `pnpm db:seed`, or the DB was reset. Re-seed. |
| Password change not taking effect | Seed upserts don't overwrite passwords — run `pnpm db:reset`. |
| Port 3000/3001 in use | Stop the other process or change `API_PORT` / Next.js port. |
| Web app can't reach API | Check `NEXT_PUBLIC_API_URL` and `API_CORS_ORIGIN` match your ports. |
| Prisma client out of date | Re-run `pnpm db:migrate` (and restart `pnpm dev`). |

---

## 9. Project Phase Context

Per the project blueprint, BSOP is built in phases (0 → 5). This is a **modular monolith** (NestJS API + Next.js web, shared Postgres, one scheduling brain). Core domain truth lives in the API + DB — never write core domain logic in the UI or bury business-rule values in frontend code.
