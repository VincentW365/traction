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

## Step 2 — Seed the database (one time)
Migrations run automatically on the API's start. To load the reference data + an admin login:
- Open **bsop-api ► Shell** and run:
  ```
  pnpm db:seed
  ```
  This creates the site, service catalogue, business rules, work bays, and the login
  **`admin@bert.local` / `admin123`**.

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
