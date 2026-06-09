# 32 — Historical Baseline Milestone

**Date:** 2026-06-09 · **Status:** Baseline complete, local only. Feature work paused.

> Marks the point where the DMAIC rule work + the full SharePoint historical data (customers, vehicles, jobs) are integrated, committed locally, and tagged.

## Git state
- **HEAD:** `27a4f7d` (branch `master`) — `feat(import): load historical jobs as terminal visits`.
- **Checkpoint tags:**
  | Tag | Commit | Marks |
  | --- | --- | --- |
  | `save-point-post-jobs-historical-import` | `27a4f7d` | Full historical baseline (current) |
  | `save-point-post-contact-field-backfill` | `752820f` | Customers/vehicles + 5 backfilled fields |
  | `save-point-post-customer-vehicle-import` | `e5602ad` | Customers/vehicles imported |
  | `save-point-pre-ui-polish` | `4978011` | Pre-this-effort |

## What is implemented
- **DMAIC rule enforcement (Rules 1–7)** with dedicated tests (`docs/27`): same-day cutoff (site-local, audited), midday completion follow-up (idempotent), mobile-jack sedan gate (serviceClass), power-wash gate, mileage gate (check-in/completion/walk-ins), machine-shop isolation, service-due reminder calc.
- **ServiceOrder pause/resume + rework** recording (CR-2026-001, recording-only).
- **Vehicle serviceClass + mobile-jack gate** (CR-2026-002).
- **Public waiting-room display board** (token-gated, PII-safe).
- **SharePoint extraction tooling** (`scripts/sharepoint/`).
- **Customer + Vehicle import** (CR-2026-003) + **contact-field backfill** (CR-2026-004: loyalty, fuel, transmission, drivetrain, engine no.).
- **Historical jobs import** (CR-2026-005, terminal historical only).
- **Walk-ins Rule 5** aligned to shared gate (FOLLOW-UP-001 resolved).
- Real 12-technician roster seeded.

## Data now in `bsop_dev`
| Entity | Count | Notes |
| --- | ---: | --- |
| Customers | 6,857 | 6,856 real + 1 placeholder (`BERT-HIST-UNKNOWN`) |
| Vehicles | 8,246 | 7,157 real + 1,089 placeholder (`HIST-UNRESOLVED-*`) |
| Contact vehicle refs (`SHAREPOINT_CONTACT_DB`) | 7,157 | `contactId → Vehicle` |
| ServiceVisits | 9,055 | all `HISTORICAL_IMPORT` (CLOSED 8,971 / CANCELLED 84) |
| ServiceOrders | 9,055 | terminal historical |
| Technician assignments | 10,023 | resolved to the 12 real techs |
| Pause / Rework ledger rows | 1,564 / 30 | historical/audit-only |
| Job visit refs (`SHAREPOINT_JOB_SHEET`) | 9,055 | `jobId → ServiceVisit` |
| Technicians | 17 | 12 real + 5 retained placeholders |
| **QueueTickets / NotificationLogs** | **0 / 0** | no operational side effects from imports |

**DB import batches:** customer/vehicle = `10b5c669-06b7-4d14-937a-5aab95c2c013` (contact-field backfill preserved this lineage); jobs = `c6b22e3c-f33c-4119-bb1c-e777413137f3`.

## Rollback / recovery
- **Customer/vehicle import:** `tsx apps/api/scripts/import-customers.ts --rollback 10b5c669-06b7-4d14-937a-5aab95c2c013`
- **Jobs import:** `tsx apps/api/scripts/import-jobs.ts --rollback c6b22e3c-f33c-4119-bb1c-e777413137f3` (run this **before** the customer/vehicle rollback if removing both — jobs depend on vehicles)
- **Code baseline:** `git reset --hard <tag>` (see tags above).

## Verification status
- **API tests:** 179/179 pass · **typecheck:** clean (API + web).
- DB post-write verifications matched the approved dry-runs for both imports; side-effect guards confirmed (queue tickets = 0, notifications = 0).
- No raw PII/source data committed (all git-ignored).

## Known remaining follow-ups
See `docs/29` for the tracked register. Headlines:
- **Operational queries/metrics must exclude historical placeholders** (`HISTORICAL_IMPORT` visits + `BERT-HIST-UNKNOWN` / `HIST-UNRESOLVED-*`) so they don't skew customer-quality or operational dashboards.
- Imported vehicles have **null serviceClass/weightClass** → mobile-jack-blocked until classified at check-in.
- Imported customers **opt-in = false** (no reminders/marketing until consent).
- **Paused-clock scheduling behavior** still deferred (CR-2026-001 follow-up).
- 1,089 unresolved/unlinked jobs sit on placeholders — re-resolvable if SharePoint contact access expands.
- Historical free-text service detail is **header-only** (notes); catalogue classification is a later analytics task.
- Pre-existing WIP (technicians/maintenance/reporting/staff/availability/web admin/`permissions.ts`) risk-reviewed, **not line-by-line audited**.
- **NHTSA VIN decode** defaults live-unless-`STUB` (mitigated locally).
- SharePoint extraction is **manual + point-in-time** (snapshot 2026-06-09).

## Push state
**No git remote is configured. Nothing has been or can be pushed.** All commits, tags, and DB data are local to this machine.
