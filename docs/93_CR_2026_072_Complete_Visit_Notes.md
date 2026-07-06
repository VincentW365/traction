# CR-2026-072 — Complete Visit: notes + always-optional mileage, drop oil fields

**Status:** Implemented.
**Requested by:** Vincent Wilson — "For the complete visit section, have a notes part to it and make the mileage and notes optional all the time. The oil and grade here is not needed."

## A. Change
- **Notes:** Complete Visit now has an optional **Notes** textarea. On submit it's appended to the
  visit's notes (`ServiceVisit.notes`). `recordCompletion` accepts a new optional `notes` field.
- **Mileage optional always:** removed the required-mileage gate at the completion boundary
  (`assertMileageGate`), so completion never requires a mileage reading. A provided value must still
  be **≥ mileage in** (data sanity) — that check is kept.
- **Oil dropped:** removed the Oil Brand / Oil Grade inputs from the Complete Visit section (not needed
  here). The backend fields remain but are no longer sent from this form.

## B. Impacted files
- Web: `apps/web/app/(dashboard)/queue/[id]/page.tsx` (Complete Visit UI + mutation body/state).
- API: `apps/api/src/modules/status/status.controller.ts` (`recordCompletion` — accept/append notes,
  drop the completion mileage gate + its override-audit; removed the now-unused `assertMileageGate`
  import).
- No schema change (`ServiceVisit.notes` already exists).

## C. Note on the mileage gate (§9-adjacent, owner-directed)
This relaxes DMAIC Rule 5 **at the completion boundary only** — mileage is now optional there per the
owner's explicit request. The **check-in** mileage gate is unchanged (still enforced for
mileage-required services). Reversible via git.

## D. Tests / validation
- `mileage-gate-boundaries.spec.ts` updated: check-in cases unchanged; completion now **optional**
  (completes without mileage even for a service job; accepts optional mileage; accepts notes).
- `pnpm --filter @bsop/api exec tsc --noEmit` + `--filter @bsop/web` — green; status + appointments +
  web tests pass.
