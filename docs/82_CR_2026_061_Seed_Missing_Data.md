# CR-2026-061 — Seed crucial data missing on a fresh deploy

**Status:** Implemented.
**Requested by:** Vincent Wilson — "For anything crucial that needs to be seeded that would not have been when the app is deployed, can you fix it?"

## A. Objective
Ensure a freshly-seeded database has the config + technician-skill data the app needs to run its
core flows, so the deployed build behaves correctly without hidden hardcoded fallbacks or dead-ends.

## B. Gaps found & fixed
1. **5 BusinessRuleConfig keys** the code reads with a hardcoded fallback but the seed never created
   (so they weren't visible/tunable in Business Settings). Seeded at the exact code-default values:
   - `eta_avg_live_window_days` = 30, `eta_avg_min_live_sample` = 20, `eta_avg_outlier_cap_minutes` = 0
     (queue ETA average — `queue.service.ts:41-44`)
   - `classification_daily_target` = 50 (`classification.service.ts:228`)
   - `complaint_sla_hours_by_severity` = `{LOW:120, MEDIUM:72, HIGH:24, CRITICAL:4}` (`complaints.service.ts:13`)
2. **Technician skill spread.** Seeded technicians only had `GENERAL`+`LUBE`, but services require
   `ELECTRICAL/BRAKE/SUSPENSION/TIRE/ALIGNMENT/DIAG/ENGINE/TRANSMISSION`. Since `assign()` requires a
   technician to hold **all** of an order's required skills, specialized services (e.g. Brake Pads,
   Shocks) **could not be assigned to anyone**. Added a demo-baseline specialized spread so every
   required skill is held by ≥2 technicians (verified: BRAKE 4, SUSPENSION 5, TRANSMISSION 2, etc.).
   Real per-technician matrices remain a pending data-collection item — this is representative data.

## C. Change
- `prisma/seed.ts`: added the 5 rules to the rules array; added `specializedSpread` (per-tech skills)
  and made technician + skill seeding **idempotent/additive** (technician `upsert`, skills created
  only if missing) so **re-running the seed applies the spread to already-seeded technicians** (the
  prior code skipped skill creation whenever the technician already existed).

## D. Impacted modules / data
- `prisma/seed.ts` only. Data/seed change; no schema change, no app-code change.

## E. Applying to an existing / deployed DB
Re-run `pnpm db:seed` (idempotent) — it now adds the missing rules and the specialized skills to
existing technicians without disturbing other data.

## F. Tests / validation
- Ran `pnpm db:seed` locally → "Business rules: 17 seeded", "Technicians: 12 seeded with baseline +
  specialized skills", "Seed complete."
- Verified in DB: all 5 rules present with the expected values; skill coverage per specialized skill ≥2.

## G. Approval gate
Seed/data only. No schema/RBAC/logic change → **not a §9 trigger**. Recorded as a Change Request;
reversible via git.
