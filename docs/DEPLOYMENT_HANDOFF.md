# Release Handoff — Deployment Parity Release (CR-2026-094)

For the person deploying. Everything here is copy-paste; no source files need
editing. The full reference is `DEPLOYMENT.md` at the repo root — this page is just
the steps for **this** release.

**Commit:** the tip of `master` you were given. Verify after deploy: the *Build*
line on **Admin → Deployment** (or `GET /api/v1/health`) must show the same short
hash as `git log -1 --format=%h` on that commit.

---

## What this release changes for deployment

- The deploy now **verifies itself**: a read-only preflight runs at the end of the
  Render build and fails the deploy if migrations or reference data did not land.
- New **Admin → Deployment** page and `/api/v1/health` endpoint show the running
  commit, database state, and customer/vehicle counts.
- The **customer database is loaded by a controlled import** — this is the step
  that has never been run against the deployed database, and it is why the deployed
  site has no customers today.

## Steps

### 1. Deploy the commit
Render auto-deploys on push to master. Wait for **both** services (bsop-api,
bsop-web) to go live. The API build now ends with a preflight — if the deploy
fails there, read its log: it names exactly what is missing.

### 2. Confirm environment (one-time check)
In the Render dashboard, confirm these are set (values are already there from the
blueprint; nothing new is required this release):

| Service | Variable | Expectation |
|---|---|---|
| bsop-api | `DATABASE_URL` | from the managed database (automatic) |
| bsop-api | `JWT_SECRET` | generated (automatic) |
| bsop-api | `API_CORS_ORIGIN` | the bsop-web URL |
| bsop-api | `ALLOW_DEV_LOGIN` | `false` |
| bsop-web | `NEXT_PUBLIC_API_URL` | `https://<bsop-api>/api/v1` |
| bsop-web | `NEXT_PUBLIC_WS_URL` | `https://<bsop-api>` |

### 3. Migrations and reference data
**Nothing to do** — the build runs them (`prisma migrate deploy` + seed, both
non-destructive and idempotent, then the preflight).

### 4. Back up the database
Before the first customer import: Render dashboard → bsop-db → create a backup
(or `pg_dump`). Takes a minute; skip nothing.

### 5. Load the customer database (the missing step)
The import needs the two approved source files — **`customers.csv`** and
**`jobs.csv`** (the SharePoint exports used locally). They are NOT in GitHub
(customer data never is); get them from Vincent by a secure channel.

From a machine that has the repo checked out, with `DATABASE_URL` pointed at the
**production** database for these commands only:

```bash
# Dry run first — writes NOTHING, prints what would happen:
pnpm customers:import -- --file <path>/customers.csv
```

Review the printed counts (expect roughly: **6,858 customers, 8,247 vehicles**
created or matched; a small flagged list is normal). Then:

```bash
pnpm customers:import:commit -- --file <path>/customers.csv

pnpm jobs:import -- --file <path>/jobs.csv          # dry-run, review (~9,000 visits)
pnpm jobs:import:commit -- --file <path>/jobs.csv

pnpm customers:verify                                # must end: RESULT: OK
```

Safe to re-run: the import updates matched records instead of duplicating them,
and it never deletes anything. Existing records in the deployed database are
preserved.

### 6. Verify
- Open **Admin → Deployment** (log in as the manager account):
  - *Build* = the release commit's short hash
  - *Database* = connected; *Seeded* = yes
  - *Customers* ≈ 6,858+ and *Vehicles* ≈ 8,247+ after the import
- Open **Customers** — the directory should list customers (before the import it
  shows an amber "Customer database is currently empty" notice; that notice
  disappearing is the confirmation).
- Spot-check: Queue Board, Dispatch, Inspections, Reports → Technician KPI all load.

## Known limitations (this release)
- Inspection **photographs** are stored on local disk; on Render's free tier they
  do not survive a redeploy. Fine for evaluation; needs a persistent disk or object
  storage before photo evidence matters in production.
- Render free-tier services **sleep when idle** — first request after a quiet spell
  takes ~30–60 s.
- The import commands run from a checkout with production `DATABASE_URL`; there is
  no in-app upload for the source files (deliberate — the files are sensitive).
