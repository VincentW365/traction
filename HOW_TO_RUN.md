# BSOP — How to Run (Dev) & What to Remember

**Bert's Service Operations Platform (BSOP / "Traction")** — local development quick-start, login credentials, and operational notes.

> Last updated: 2026-06-10. If commands stop matching reality, check `package.json`, `docker-compose.yml`, and `prisma/seed.ts` — those are the source of truth.

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

From the repo root:

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
#    NOTE: seed = reference/demo data only. Customers, vehicles, historical jobs,
#    and the classification queue come from the gated import/backfill scripts —
#    see "Seed data vs. imported data" below.
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

### Access from other devices on the LAN (dev only)

To open the web app from another device on the same network (phone/tablet/laptop):

```powershell
pnpm --filter @bsop/api dev        # API already binds all interfaces (0.0.0.0:3001)
pnpm --filter @bsop/web dev:lan    # binds the web dev server to 0.0.0.0:3000
```

Then in your **gitignored** `.env`, set `API_CORS_ORIGIN` to a comma-separated list
including localhost and each LAN origin you'll use (find your IPv4 with `ipconfig`):

```
API_CORS_ORIGIN="http://localhost:3000,http://<LAN-IP>:3000"
```

- The browser auto-targets the API at the **same host** it loaded from, port `3001`
  (no `NEXT_PUBLIC_API_URL` needed); set `NEXT_PUBLIC_API_URL` only to force a specific host.
- Restart the API after changing `.env`. Restart `dev:lan` if you change `NEXT_PUBLIC_*`.
- The owner must allow **Windows Firewall inbound TCP 3000 and 3001** on the *Private* network profile.
- Open `http://<LAN-IP>:3000` on the device (it must share the subnet of that IP).
- **LAN access is HTTP/dev-only** — not TLS, not production. Production uses an
  explicit `NEXT_PUBLIC_API_URL` + proper hosting (see `docs/47`).

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

### Dev role switcher — one-click test login (CR-2026-022)

A dev-only page lets you sign in as any role **without typing credentials** — useful for quickly exploring the app as Admin / Manager / Service Advisor / Front Desk / Technician / Parts Staff / Transport Coordinator. It issues a **normal session token** (RBAC is fully enforced; only credential entry is skipped).

> ⚠️ **Development/Test Login Only — Disabled in Production.** It is **off by default** and is **always refused when `NODE_ENV=production`**, even if the flag is on.

**Enable it locally:** in your gitignored `.env`, set:

```
ALLOW_DEV_LOGIN=true
# and ensure NODE_ENV is not "production" (defaults to development)
```

Then **seed the DEVTEST users once** (gated; idempotent; creates the 6 non-admin profiles with no password — `admin` is reused, never duplicated):

```powershell
$env:ALLOW_DEV_LOGIN="true"; $env:NODE_ENV="development"; npx tsx apps/api/scripts/seed-dev-users.ts --commit
```

Restart the API, then open **http://localhost:3000/dev-login** and click a role card.

| Role | Mapped profile |
| --- | --- |
| ADMIN | `admin@bert.local` (existing admin, reused) |
| MANAGER | `devtest.manager@berts.local` |
| SERVICE_ADVISOR | `devtest.advisor@berts.local` |
| FRONT_DESK | `devtest.frontdesk@berts.local` |
| TECHNICIAN | `devtest.tech@berts.local` |
| PARTS_STAFF | `devtest.parts@berts.local` |
| TRANSPORT_COORDINATOR | `devtest.transport@berts.local` |

- DEVTEST users have **no password** (`passwordHash = null`) — they can only be reached through the gated `/auth/dev-login` endpoint, never the normal login form.
- If `ALLOW_DEV_LOGIN` is off (or in production), `/dev-login` shows a clear "disabled" state and the API endpoints return 403.
- Each successful dev-login writes a `DEV_LOGIN` AuditLog row (no tokens logged).
- **Never enable `ALLOW_DEV_LOGIN` in production.** There is no CUSTOMER card.

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
| `VIN_DECODE_PROVIDER` | `STUB` | Default `STUB` = no outbound calls (safe for local/dev, data import, offline). Live NHTSA vPIC VIN decode (`vpic.nhtsa.dot.gov`) is **opt-in**: set `VIN_DECODE_PROVIDER=LIVE`. Any other value/unset stays `STUB`. |

---

## 7. Important Things to Remember

- **Infra must be running first.** The API needs both Postgres and Redis up, or it won't boot. Start `docker compose up -d` (or the Redis batch script) before `pnpm dev`.
- **Default site is `BERT-01`** ("Bert's Auto Parts Service Centre — Main"), timezone `America/Jamaica`. Operating hours: Mon–Fri 08:00–17:00, Sat 08:00–13:00, closed Sunday.
- **Seeded operational data** (verified from a clean `pnpm db:seed`): **17 users** (incl. the **12-technician roster** `BERT-T01`–`BERT-T12`), **32 service types**, **39 business-rule configs** (17 core + 22 v4.1), **6 work bays**, **10 work resources** (incl. 2 stands, 2 mobile jacks, power wash, external machine shop), **10 resource occupancies**, and **23 vehicle weight/serviceClass suggestions**.
- **Business rules live in the DB**, not in code — edit them via `BusinessRuleConfig` (Prisma Studio or admin settings), keyed per site. Don't hard-code rule values.
  - Optional: `classification_daily_target` (`valueJson` `{ "target": <number> }`) sets the daily classification target shown on Reports → Classification Progress → Productivity. Absent → default **50/day**.
  - Optional: `eta_avg_outlier_cap_minutes` (`valueJson` a positive number) trims queue-board ETA outliers — orders with duration ≤0 or above the cap are excluded from the ETA average. Absent → **no trimming** (default). Also: `eta_avg_live_window_days` (30), `eta_avg_min_live_sample` (20).
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

---

## 10. Seed data vs. imported data

`pnpm db:seed` is **reference/demo data only** and is all a fresh clone needs to boot and log in.

**Seed includes:**
- Site `BERT-01`, all login users (incl. the **12-technician roster**), service types, work bays, work resources, business-rule configs, and the **23 vehicle weight/serviceClass suggestions** (advisory lookup for classification).

**NOT in seed — only present after running the gated scripts below:**
- **Customers & vehicles** → `import-customers`
- **Historical jobs / service visits** → `import-jobs`
- **The ~7,157 `PENDING` `VehicleClassification` rows** → `backfill-vehicle-classifications --commit`

> Consequence on a fresh clone: **Customers search, the Vehicle Classification queue, and the Classification Progress report will be empty / zero** until the relevant import + backfill are run. The **source data files for the imports are gitignored and are NOT in the repo** (they contain real customer PII), so imports can only be run where that source data is available.

---

## 11. Optional data scripts (advanced)

Run from the repo root with `VIN_DECODE_PROVIDER=STUB` (default). All default to a **dry-run** (no writes); pass `--commit` to write.

| Script | Purpose | Modes |
| --- | --- | --- |
| `apps/api/scripts/import-customers.ts` | Import customers + vehicles from the SharePoint export | dry-run / `--commit` / `--rollback <batchId>` |
| `apps/api/scripts/import-jobs.ts` | Import historical jobs as terminal service visits/orders | dry-run / `--commit` / `--rollback <batchId>` |
| `apps/api/scripts/backfill-vehicle-classifications.ts` | Seed `PENDING` classification rows w/ advisory suggestions | dry-run / `--commit` / `--rollback` (deletes only unreviewed PENDING rows; preserves CONFIRMED) |

Example (dry-run, then commit):

```powershell
npx tsx apps/api/scripts/backfill-vehicle-classifications.ts            # dry-run report
npx tsx apps/api/scripts/backfill-vehicle-classifications.ts --commit   # write PENDING rows
```

> Read-only verification helpers also exist: `verify-import.ts`, `verify-jobs.ts`, `verify-classification-backfill.ts`. None of these scripts change `Vehicle.serviceClass` or scheduling behavior.

> **Repeat sync:** the imports are idempotent (re-running `--commit` updates in place; no duplicate customers/vehicles/jobs) and preserve staff classification + notification consent. For the controlled re-import/update runbook, see **`docs/43_CR_Manual_SharePoint_Sync.md`**.
