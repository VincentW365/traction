# CR-2026-053 — Remove sandbox sessions; add real test logins (live-like testing)

**Status:** IMPLEMENTED. **Type:** Dev/test environment change — owner-directed. Recorded here.
**Author:** Vincent Wilson · **Date:** 2026-06-19

## 1. Request
"Remove the sandbox sessions. Give me logins for three roles (e.g. manager@test.com / manager123). I want to test everything like the live environment."

## 2. Change
### Sandbox sessions removed
- **Disabled dev-login** — set `ALLOW_DEV_LOGIN="false"` in `.env` (gitignored, local config). With dev-login off, no new sandbox sessions can be created and `POST /auth/dev-login` returns 403 — exactly how production behaves. The app now uses the **normal login form only** with role-scoped permissions (no full-access override).
- **Cleaned up the 9 existing ACTIVE DEV_LOGIN_SESSION runs** via the canonical, safety-gated sandbox cleanup engine (`cleanup-dev-sessions.ts --commit`): removed their tagged data (7 rows total) and marked the runs CLEANED_UP. Only DEV_LOGIN_SESSION runs were touched; the BATCH seeded-demo run and all real/imported data are untouched. A `pg_dump` backup was taken first.

### BATCH demo data removed
- Cleaned the seeded demo run (`test-walkthrough-2026-06-15`, BATCH) via `test-data cleanup --run <id> --commit` (safety PASS; pg_dump taken first) — **392 rows** removed (25 demo customers/vehicles/visits + orders/tickets/etc.).
- **Engine fix** (`data-import/test-data/cleanup.ts`): the cleanup engine predated visual inspections (CR-2026-034), which carry no test-run tag/manifest and FK-blocked visit deletion. `executeCleanup` now removes any `VehicleInspection` hanging off the run's manifested visits before deleting the visits/vehicles/customers (its items/wheels/recommendations/signatures cascade). Covered by the existing cleanup spec (mock updated).
- Result: **0 ACTIVE test runs, 0 sandbox-tagged rows, 0 VWTEST customers** — the DB now holds only real/imported data plus the three login accounts.

### Real test logins (role-scoped, like live)
Created three password logins via `create-test-logins.ts` (idempotent — re-run to reset passwords). A `Technician` record is also created for the technician user so workshop flows work.

| Role (display) | Email | Password |
|---|---|---|
| Manager (full access) | `manager@test.com` | `manager123` |
| Service Advisor | `advisor@test.com` | `advisor123` |
| Technician | `technician@test.com` | `technician123` |

## 3. Files
- `apps/api/scripts/cleanup-dev-sessions.ts` *(new)* — clean ACTIVE DEV_LOGIN_SESSION runs (dry-run default; `--commit`).
- `apps/api/scripts/create-test-logins.ts` *(new)* — upsert the three role logins (+ technician record).
- `.env` — `ALLOW_DEV_LOGIN="false"` (local, not committed).
- `docs/75_CR_2026_053_Remove_Sandbox_Add_Test_Logins.md` (this file).

## 4. Verification
- `auth/dev-login` → **403** (blocked); the dev-login page reports disabled.
- Normal login `manager@test.com` → **201**, role `ADMIN`, token issued (role-scoped, no sandboxRunId).
- DB: 0 ACTIVE DEV_LOGIN_SESSION runs remain; the three users exist with hashed passwords; technician linked.
- Dev server restarted on web `:3000` / API `:3001`.

## 5. Governance / notes
Environment + data-maintenance change; no schema, rule, or API-contract change. The cleanup is destructive but scoped to dev-login sandbox runs only, backed up first, via the audited cleanup engine. **Re-enable dev-login** anytime by setting `ALLOW_DEV_LOGIN="true"` and restarting. These test accounts are dev convenience — they must not exist in a real production database.
