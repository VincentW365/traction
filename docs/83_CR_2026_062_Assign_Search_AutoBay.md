# CR-2026-062 — Assign flow: searchable technician + bay, auto-assign bay

**Status:** Implemented.
**Requested by:** Vincent Wilson — "the technician drop down should be searchable along with the bay option, or if the bay option is not selected auto assign a bay."

## A. Objective
Make assigning a technician fast and forgiving: searchable technician + bay pickers, and a bay that
auto-assigns when left blank.

## B. Problems fixed
- Technician was a plain `<select>`; **bay was a raw UUID text box** (staff had to paste a UUID).
- `AssignTechnicianDto.bayId` was `@IsNotEmpty()` (required) while the UI sent `undefined` when blank
  — so "assign without a bay" actually 400'd. Now optional + auto-assigned.

## C. Change
- **Backend** `dto/assign-technician.dto.ts`: `bayId` → `@IsOptional() @IsUUID()` (strictly looser; the
  UI already omitted it; `assignAdditional`/`updateAssignment` already treated it optional).
- **Backend** `service-orders.service.ts`:
  - New private `pickCompatibleFreeBay(order)` — first ACTIVE bay at the order's site whose `bayType`
    matches the order's required bay type(s) (or any active bay if none required) **and** has no active
    `TechnicianAssignment` (mirrors the existing double-booking guard).
  - `assign()`: when `dto.bayId` is omitted, resolve via the helper; throw a clear
    `BadRequestException('No compatible free bay is available …')` if none. Provided-bay path unchanged
    (validates existence/active/bay-type). Assignment + logs now use the resolved `bay.id`.
- **Frontend** new reusable `components/ui/searchable-select.tsx` (dependency-free combobox: filter +
  pick). Used in the queue assign form for **technician** (from `techsQuery`) and **bay** (from
  `recommendationsQuery.compatibleBays`, with a leading "Auto — first free compatible bay" option +
  "leave blank to auto-assign" hint).

## D. Impacted modules / data
- API: `assign-technician.dto.ts`, `service-orders.service.ts` (+ new spec). No schema change.
- Web: `components/ui/searchable-select.tsx` (new), `queue/[id]/page.tsx` (assign form).

## E. Tests / validation
- New `__tests__/assign-autobay.service.spec.ts`: auto-assigns first compatible **free** bay (skips a
  busy one); throws when none free; with no required bay type auto-assigns any active free bay; an
  explicit `bayId` still works (no auto-pick path). `vitest run src/modules/service-orders` — 11 passed.
- `pnpm --filter @bsop/api exec tsc --noEmit` and `--filter @bsop/web` — green. Web tests: 74 passed.

## F. Notes / dependency
- Auto-assign relies on technicians actually having the required skills — see CR-2026-061 (skill spread)
  which unblocks specialized-service assignment.

## G. Approval gate
Technician assignment still respects skill + bay-type + double-booking constraints (product truth #7).
No schema change, no queue-ranking/priority change; DTO is strictly looser → **not a §9 trigger**.
Recorded as a Change Request; reversible via git.
