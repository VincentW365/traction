# Deployment Manifest — handing BSOP to the Manager

For the person deploying. Everything here is copy-paste; no source files need
editing. The full reference is `DEPLOYMENT.md` at the repo root. Last verified by
the fresh-clone parity test of 2026-09-07 (docs/119): a clean clone of
`origin/master`, an empty database and the steps below reproduced the working
application with zero manual intervention.

## Repository

| Item | Value |
|---|---|
| Repo | `github.com/claudesdisciple/bsopplatform` |
| Branch | `master` (Render auto-deploys every push) |
| Expected commit | the tip of `master` you were given — verify after deploy: the *Build* line on **Admin → Deployment** (or `GET /api/v1/health`) must show the same short hash as `git log -1 --format=%h` |
| Node | 20+ (parity test ran on 24) |
| Package manager | pnpm 10+ (`corepack enable`) |

## Services

| Service | Requirement |
|---|---|
| PostgreSQL | 16+ (verified on 16 and 17) |
| Redis | **not required** in the deployed topology (local dev convenience only) |
| bsop-api | NestJS, port 3001 (or platform `PORT`), base path `/api/v1` |
| bsop-web | Next.js, port 3000; `NEXT_PUBLIC_API_URL`/`NEXT_PUBLIC_WS_URL` are baked at **build** time |

## Required setup (in order)

```bash
pnpm install --frozen-lockfile
pnpm exec prisma generate
pnpm db:migrate            # additive, idempotent — safe on any database state
pnpm db:seed               # reference data; create-if-missing, never overwrites operator edits
pnpm build                 # API + web (set NEXT_PUBLIC_* first)
pnpm deploy:check          # read-only preflight — must end PASS
```

Or `pnpm deploy:bootstrap` for validate → migrate → seed → preflight in one
non-destructive command. On **Render**, `render.yaml` runs all of it on every push.

Environment: `.env.example` is the complete contract. Non-negotiables:
`DATABASE_URL`, `JWT_SECRET` (32+ chars), `API_CORS_ORIGIN`, `NEXT_PUBLIC_API_URL`,
`NEXT_PUBLIC_WS_URL`, `NODE_ENV=production`, `ALLOW_DEV_LOGIN=false`.

**First login:** the seed creates `admin@bert.local` / `admin123` (and the staff
logins). **Admin → Deployment lists every account still on a seed password —
change them all immediately** (self-service under Account, or Staff → Reset
Password). The page shows the list until it is empty; that is the confirmation.

## Data (never through Git)

1. **Back up first** (Render: dashboard → bsop-db → backup, or `pg_dump`).
2. **Customer database** — the controlled import, dry-run first
   (`pnpm customers:import -- --file …`, then `:commit`; expect ≈6,858 customers /
   8,247 vehicles). Then job history (`pnpm jobs:import` → `:commit`, ≈9,000
   visits) and `pnpm customers:verify` → must end `RESULT: OK`.
   Source files `customers.csv` / `jobs.csv` come from Vincent by a secure
   channel — they are never in GitHub.
3. **Optional — Service Mix analytics**: price-list catalog + job mapping
   (`import-catalog.ts --file … --commit`, then `map-jobs.ts --commit`). Only the
   Service Mix report reads these; skip freely. See DEPLOYMENT.md §6.
4. **Backups from day one**: Render free tier has none — schedule
   `pg_dump --format=custom "$DATABASE_URL"` daily off-platform. See
   DEPLOYMENT.md §8b for restore.

## Optional setup

- SMS: `NOTIFICATION_PROVIDER=twilio` + `TWILIO_*`
- Email: `EMAIL_PROVIDER=smtp` + `SMTP_*`
- Going live to real customers additionally requires an explicit
  `NOTIFICATION_MODE=LIVE`; until then every send is recorded, not delivered,
  and the UI says so.
- VIN decode: `VIN_DECODE_PROVIDER=LIVE` (NHTSA vPIC).

## Verification

- `pnpm deploy:check` → PASS (env, migrations, schema drift, reference data,
  templates; empty customers is a warning until the import).
- `GET <api>/api/v1/health` → build commit matches the push.
- **Admin → Deployment** → Build hash, Database connected, Seeded yes,
  default-credential list empty, customer/vehicle counts after import.
- Spot-check as in the parity test: log in as Manager / Advisor / Technician;
  Queue Board, Dispatch, Technician My Jobs, Inspections, Reports (KPIs + the
  Service Center Performance Report + Print), Customers, the public display
  board (`/display/<token>`).

## Known limitations

- Inspection **photographs** live on local disk (`.data/inspection-photos`); on
  hosts without a persistent disk they do not survive a redeploy — attach a disk
  or object storage before photo evidence matters (DEPLOYMENT.md §10).
- Render free-tier services **sleep when idle** — first request after a quiet
  spell takes ~30–60 s.
- Import commands run from a checkout with production `DATABASE_URL`; there is
  deliberately no in-app upload for the source files.

## Required forms — why a deploy can look seeded and still fail (CR-2026-106)

The Pre-Job Inspection and Service Inspection forms are **seeded reference data**
(`inspection_templates`); the Job Sheet is code-defined and needs no seed. The
current repository reproduces both templates on a fresh database (proven in
docs/121 §C2), so if the deployed site reports *"No … template is configured"*
one of these happened outside the repository:

1. The `bsop-api` service's **dashboard Build Command is detached from
   `render.yaml`** (a service created from an older Blueprint keeps its old value;
   see AGENTS.md). Compare Render → bsop-api → Settings → Build Command with
   `render.yaml`; the deploy log must show `Required forms — … PASS`.
2. The **database was replaced or restored after the last build** (free-tier
   Postgres expiry, or a `pg_dump` restore). Migrate runs at start; seed and check
   run only at build. After ANY database replacement run, from a HEAD checkout:

   ```
   DATABASE_URL=<External Database URL> pnpm db:seed
   DATABASE_URL=<External Database URL> pnpm deploy:check
   ```

Since CR-2026-106 the API start command runs `deploy-check --forms` before
serving, `pnpm deploy:check` has a **Required form configuration** section that
FAILS when a form is unusable, and Admin → Deployment shows Job Sheet /
Pre-Job Inspection / Service Inspection as PASS/FAIL from the live database.

### CR-2026-107 — the deployment now repairs itself

Everything above still holds, but **none of it is load-bearing any more**, and
that is the point. Both remedies above lived in `render.yaml` or in this runbook
— exactly the things a detached Build Command or a restored database skips. So
the guarantee moved inside the application:

**The API creates any missing inspection template at every start**
(`RequiredFormsBootstrap`). It is idempotent, non-destructive, writes nothing
when the database is already correct, and runs regardless of how the service was
built, who deployed it, or which database it was pointed at. A deploy log line
records the outcome every time:

```
[RequiredForms] Required forms — Job Sheet: PASS · Pre-Job Inspection: PASS · Service Inspection: PASS
```

If it had to repair something, the line above it says exactly what and why.

**To repair an existing deployment without redeploying or wiping anything:**

```
DATABASE_URL=<External Database URL> pnpm forms:ensure
```

It adds only what is missing. It never deletes a template, an inspection, a
visit, a photograph or any customer data, and completed inspections keep the
exact template version they were performed against. Running it twice is safe —
a healthy database reports `Already correct — no changes were needed.`

`pnpm db:seed` still works and is still the right command for first-install
reference data; `forms:ensure` is the narrow, safe subset for a live site.


## CR-2026-106 — go-live settings the deployed site needs (owner steps)

These cannot be done from the repository; each is a Render dashboard setting or a command run against the deployed database.

1. **Public app URL (customer links).** On `bsop-api` set `PUBLIC_APP_URL` to the public `bsop-web` address (https, e.g. `https://bsop-web.onrender.com`). Every customer-facing link — status page, booking manage link, booking link — is built from it. `deploy:check` FAILS in production when it is missing, not https, or an internal host; Admin → Deployment shows the verdict under **Public app URL (customer links)**.
2. **Email.** Keep `EMAIL_PROVIDER=smtp` with `SMTP_HOST/PORT/SECURE/USER/PASS/FROM`. Set `NOTIFICATION_MODE=LIVE` to stop redirecting customer messages to the test recipient. Then open Admin → Deployment → **Prove outbound email works**, type a real mailbox, and read the mail server's own reply (accepted / rejected / response line). Every notification screen now shows the server's state — *Sent* means the provider accepted it, never "composed".
3. **Required forms.** After any deploy or database change, Admin → Deployment must show **Job Sheet / Pre-Job Inspection / Service Inspection: PASS**. If not, run `DATABASE_URL=<External URL> pnpm db:seed` and re-check (the API refuses to start when a form is missing).
4. **Customer data.** Reconcile before you trust any count:
   ```
   DATABASE_URL=<External URL> pnpm customers:reconcile -- --file /secure/customers.csv
   DATABASE_URL=<External URL> pnpm customers:reconcile:master -- --file /secure/Customer_List_Master.xlsx
   ```
   "Would be created" > 0 means the deployed database is missing those rows: run `pnpm customers:import:commit -- --file …` and read the post-commit table. Admin → Deployment shows the last run under **Last customer import**. The 1,653 Peachtree-only customers are a separate decision (docs/121 §F6).
5. **Booking rules.** Settings → Booking & ETA: `customer_booking_latest_start` (15:00), `staff_latest_start_enforced` (off), `booking_share_message_template`. The seed creates them; they are editable there.
6. **Prove it from outside Bert's network.** On a phone on mobile data (Wi-Fi off): open a customer status link from a ticket, open the booking link from a customer page ("Send booking link" → WhatsApp), book a slot, receive the confirmation, open the manage link. A link that works on the office PC proves nothing about customer reach.


## CR-2026-108 — resource capacity (owner steps)

The scheduling platform now works capacity out from the bays you have configured
rather than from a stored number. Full handbook: **`docs/124_Resource_Capacity_Operations.md`**.

Production is deliberately left on the safe settings — online catalogue ON with six
services, standard 80-minute appointments, a fixed limit of 2 overlapping bookings,
and the resource-aware model running for diagnostics only. Leave them there until
the steps below are done and separately approved.

1. **Assign the three outstanding kinds of work.** Setup → Resources & Bays →
   Confirm Work Positions. Oil Change needs a bay marked *Oil & lube*, Wheel
   Alignment needs *Wheel alignment*, Pre-Purchase Inspection needs *Inspection*.
   One bay each is enough if one is what exists.
2. **Tick off the eight heavy-lift bays** as you check each one in the building.
   The count of eight is confirmed; which record is which bay is currently a
   reasonable guess and is labelled as such. Nothing is blocked while they are
   outstanding.
3. **Re-run the shadow check** after any of that: `pnpm booking:shadow-validate`.
   Target: 0 oversold, 0 incomplete.
4. **Bring the readiness result back for a decision** before switching
   `booking_capacity_mode` to `RESOURCE_AWARE`. Do not change
   `appointment_duration_source` at the same time — one change at a time.
5. **Classify the seven optional resources** (overflow slots, light-task slots, the
   wash bay, the two jacks) whenever you know what they are. They contribute zero
   until then, which is safe — it can only understate capacity, never overstate it.

Adding a bay, taking one out for maintenance or changing what work it can do all
take effect immediately and need no deployment.
