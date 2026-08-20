# Deploy BSOP to Render (free) — a stable test link without waiting for your boss

This uses **`render.yaml`** (a Render "Blueprint") to create everything straight from
your GitHub repo: a **PostgreSQL** database, the **API** (NestJS), and the **web app**
(Next.js). No Redis is needed. You don't need any admin rights on your own PC for this —
it all runs on Render.

## Prerequisites
- The repo is on GitHub (`claudesdisciple/bsopplatform`) — already done.
- A free **Render** account → https://render.com (sign in with GitHub).

## Step 1 — Create the Blueprint
1. Render Dashboard → **New ► Blueprint**.
2. Connect the repo **`claudesdisciple/bsopplatform`** and select branch `master`.
3. Render reads `render.yaml` and proposes three resources: **bsop-db**, **bsop-api**, **bsop-web**.
4. It asks for the values marked "sync:false" (`API_CORS_ORIGIN`, `NEXT_PUBLIC_API_URL`,
   `NEXT_PUBLIC_WS_URL`). **Leave them blank for now** — you'll set them in Step 3. Click **Apply**.
5. Wait for the first build + deploy, then note the two URLs Render gives you, e.g.:
   - API: `https://bsop-api.onrender.com`
   - Web: `https://bsop-web.onrender.com`
   *(If a name was taken, yours may have a random suffix — use whatever Render shows.)*

## Step 2 — Seeding (automatic — nothing to do)
Migrations **and the seed** both run in the API's *build* command, so every deploy loads the
reference data by itself. That creates the site, service catalogue, business rules, work bays,
the active **inspection template**, technician **skills**, and the login
**`admin@bert.local` / `admin123`**.

The seed is idempotent and never touches operational data (customers, visits, orders, queue).
It runs at build rather than at start because the free plan spins down when idle, and seeding
on every wake would add ~10s to each cold start.

> **Why this matters:** seeding is how *new* reference data reaches an **already-seeded**
> database on a later deploy. Skip it and you get failures like
> *"No active inspection template is configured"* when starting a vehicle inspection, or
> specialised services (brakes, electrical) that no technician is eligible for.

> **Free tier has no Shell.** Render only offers the Shell tab on paid instance types, which is
> exactly why seeding is wired into the build instead. If you ever do need to run it by hand,
> use the **External Database URL** from **bsop-db ► Connect** on your own machine:
> `$env:DATABASE_URL="<external url>"; pnpm db:seed`

## Step 3 — Wire the two services together, then redeploy the web
The web app bakes the API address in at **build** time, so set these once the URLs exist:
- **bsop-api ► Environment** → set `API_CORS_ORIGIN` = the **web** URL
  (e.g. `https://bsop-web.onrender.com`) → Save (it redeploys automatically).
- **bsop-web ► Environment** → set:
  - `NEXT_PUBLIC_API_URL` = `<API URL>/api/v1`  (e.g. `https://bsop-api.onrender.com/api/v1`)
  - `NEXT_PUBLIC_WS_URL`  = `<API URL>`         (e.g. `https://bsop-api.onrender.com`)
  → Save, then **Manual Deploy ► Deploy latest commit** on **bsop-web** so it rebuilds with the URL.

## Step 4 — Share + log in
- Send your tester the **web** URL (e.g. `https://bsop-web.onrender.com`).
- Log in with `admin@bert.local` / `admin123` → **change this password immediately** (the site is public).

## Good to know (free tier)
- **Sleeps when idle:** free services spin down after ~15 min; the next visit takes ~30–60s to wake. Fine for testing.
- **Free Postgres expires (~30 days):** create a fresh DB when it lapses, then re-seed.
- **No customer PII in the cloud:** the database starts with **seed/demo data only** — this is the safe setup for sharing externally. To test against the real customer list, restore a `pg_dump` into `bsop-db` (that data is PII — handle accordingly).
- **If the web build runs out of memory** on the free instance, temporarily switch **bsop-web** to the Starter instance ($7/mo) just for the build, then switch back — or ask me to add a Dockerfile-based build.
- The API base path is `/api/v1`; Swagger docs are at `<API URL>/api/docs`.
