# CR-2026-059 — Seed the active inspection template (fix "No active inspection template is configured")

**Status:** Implemented.
**Requested by:** Vincent Wilson — "No active inspection template is configured when I try to start a vehicle inspection."

## A. Objective
Make starting a vehicle inspection work out of the box by ensuring a fresh/seeded database has an
active Visual Inspection template.

## B. Root cause
`inspections.service.create()` requires an `InspectionTemplate` with `isActive: true` and at least
one item, else it throws **"No active inspection template is configured"**. The main `prisma/seed.ts`
**never created one** — the v1 template lived only in a standalone script
(`apps/api/scripts/seed-inspection-template.ts`) that `pnpm db:seed` did not run. So any freshly
seeded DB (including the deployed one) had zero templates.

## C. Change
- **New** `prisma/inspection-template-data.ts` — single source of truth: the v1 categories/items plus
  an idempotent `seedInspectionTemplate(prisma)` function, with **no side-effect imports** (Prisma
  client is passed in), so it's safe to import from anywhere.
- **`prisma/seed.ts`** now calls `seedInspectionTemplate(prisma)` as part of the normal seed → fresh
  databases get the active template automatically.
- **`apps/api/scripts/seed-inspection-template.ts`** reduced to a thin standalone runner over the
  shared module (kept for seeding an already-existing database without a full reseed).

## D. Fixing an EXISTING database (e.g. the current deployment)
The code change only affects future seeds. An already-seeded DB needs a one-time run:
```
pnpm --filter @bsop/api exec tsx scripts/seed-inspection-template.ts
```
(with `DATABASE_URL` pointing at that DB). Idempotent; prefer this over re-running the full
`pnpm db:seed` so existing business-rule/customer data isn't touched.

## E. Impacted modules / data
- `prisma/inspection-template-data.ts` (new), `prisma/seed.ts`, `apps/api/scripts/seed-inspection-template.ts`.
- Data only (adds one InspectionTemplate + items). No schema change, no app code change.

## F. Tests / validation
- `pnpm --filter @bsop/api exec tsc --noEmit` — green.
- Ran the seed against the local DB → `SEED_OK {version:1, itemCount:30, categories:4, isActive:true}`.
- `pnpm --filter @bsop/api exec vitest run src/modules/inspections` — 29 passed.

## G. Approval gate
Seed/data change (adds the active template). No schema/RBAC/logic change → **not a §9 trigger**.
Recorded as a Change Request; reversible via git.
