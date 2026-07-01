# CR-2026-067 — Every technician can do everything + easier skill management

**Status:** Implemented.
**Requested by:** Vincent Wilson — "technicians are missing brake skills… All technicians should be able to do everything. And if we have a skills system have the admin able to add skills to technicians."

## A. Objective
Eliminate "Technician lacks required skill(s)" assignment errors by giving every technician the full
skill set, while keeping the skills system so Managers can still manage per-technician skills.

## B. Background
`assign()` requires a technician to hold **all** of an order's required skills. CR-2026-061 seeded
only a *spread* (each skill on ≥2 techs), so picking a tech without BRAKE still failed. The owner
wants every technician able to do everything.

## C. Change
- **`prisma/seed.ts`** — every technician is now seeded with the **full skill set**
  (`GENERAL, LUBE, ELECTRICAL, BRAKE, SUSPENSION, TIRE, ALIGNMENT, DIAG, ENGINE, TRANSMISSION`).
  Seeding stays idempotent/additive, so **re-running the seed grants existing technicians any missing
  skills** (verified: all 12 roster techs now hold all 10 skills). Supersedes the CR-2026-061 spread.
- **`apps/web/.../admin/staff/[id]/page.tsx`** — the admin skill manager (which already existed:
  add/remove per technician, permission `TECHNICIAN_MANAGE` = Manager) is improved:
  - the "Skill Code" free-text box is now a **dropdown** of known skills (derived from the service
    catalogue's `requiredSkillCode` values + GENERAL/LUBE), excluding skills the tech already has;
  - an **"Add all (N)"** button grants every remaining skill at once.

Skill enforcement in `assign()` is unchanged — the constraint still exists (product truth #7); every
technician simply now satisfies it.

## D. Applying to the live database
Re-run the seed (`pnpm run db:seed`, idempotent) to give existing technicians all skills, **or** use
Staff → Technician → Skills → **Add all** per technician. Either works.

## E. Impacted files
- `prisma/seed.ts`; `apps/web/app/(dashboard)/admin/staff/[id]/page.tsx`. No schema/API change.

## F. Tests / validation
- Ran `pnpm db:seed`; verified every specialized skill now held by all roster techs.
- `pnpm --filter @bsop/web exec tsc --noEmit` — green; web tests — 74 passed.

## G. Approval gate
Seed/data + UI only; assignment skill/bay constraints unchanged → **not a §9 trigger**. Recorded as a
Change Request; reversible via git.
