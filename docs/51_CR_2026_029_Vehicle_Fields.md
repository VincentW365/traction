# CR-2026-029 — Vehicle Fields: expose existing + add Drive Side

**Status:** IMPLEMENTED — pending review + commit (one-CR-at-a-time roadmap, CR-A).
**Type:** Change Request (additive schema: 1 new enum + 1 nullable column on `Vehicle`).
**Author:** Vincent Wilson · **Drafted:** 2026-06-12
**Approval gate:** Mandatory Review (CLAUDE.md §9 — schema change to a core entity). Additive, nullable, no rule/dependency/auth change → low risk. Migration already applied to `bsop_dev` under review; commit is paused pending approval.

---

## 1. Change Summary
Surface richer vehicle information requested by stakeholders:
- **Expose existing** (already on the `Vehicle` model since CR-2026-004, but absent from the write DTOs, the service create/update maps, and the web form): `transmission`, `drivetrain`, `fuelType`, `engineNo`.
- **Add new** nullable drive-side field: `enum DriveSide { RHD, LHD }` → `Vehicle.driveSide` (null = unknown).

## 2. Why the Change Is Needed
Stakeholders asked for engine number, transmission type, and whether a vehicle is **RHD or LHD**. Investigation found engine number, transmission, and drivetrain already existed in the schema but were unreachable from the API/UI; only drive-side was genuinely missing. This CR closes that gap end-to-end.

## 3. Decisions
- `DriveSide` modeled as a Prisma **enum** (consistent with `VehicleWeightClass` / `VehicleServiceClass`); **nullable**, no `UNKNOWN` value (null = unknown).
- `transmission` / `drivetrain` / `fuelType` stay **`String?`** — not converted to enums in this CR (converting a populated string column is non-additive/higher-risk; out of scope).
- `engineNo` remains **sensitive**: authenticated-only, never logged, never in any public/token projection.
- `vehicleCode` and `customerNumber` (and their generators) are **untouched**.

## 4. Files / Modules Impacted
- `prisma/schema.prisma` — new `enum DriveSide`; `Vehicle.driveSide DriveSide? @map("drive_side")`.
- `prisma/migrations/20260612192208_vehicle_drive_side/migration.sql` — `CREATE TYPE "DriveSide"` + `ALTER TABLE "vehicles" ADD COLUMN "drive_side"` (additive).
- `apps/api/src/modules/vehicles/dto/create-vehicle.dto.ts`, `dto/update-vehicle.dto.ts` — add validated optional `transmission`/`drivetrain`/`fuelType`/`engineNo` (`@IsString`) + `driveSide` (`@IsEnum(DriveSide)`).
- `apps/api/src/modules/vehicles/vehicles.service.ts` — plumb the five fields into `create()` (default null) and `update()` (conditional spread).
- `apps/web/app/(dashboard)/vehicles/[id]/page.tsx` — interface + edit state + read-only/edit grids for the five fields (drive side as a select; engine no marked "staff only").
- `apps/api/src/modules/vehicles/__tests__/vehicle-fields.spec.ts` — new test suite.
- **Untouched:** permissions, controllers, customerNumber/vehicleCode logic, any other module.

## 5. Rule Impact
**None.** No business-rule, scheduling, queue, ETA, parts, or transport logic is touched. The only invariant recorded/preserved is the **`engineNo` privacy rule** (authenticated-only; never logged; never in public/token projections), guarded by a regression test asserting the public `/status` projection selects only `plateNumber` for the vehicle.

## 6. Schema / API Impact
- **Schema:** additive only — `CREATE TYPE "DriveSide" AS ENUM ('RHD','LHD')`; `ALTER TABLE "vehicles" ADD COLUMN "drive_side" "DriveSide"` (nullable). No backfill, no destructive change.
- **API:** `POST /vehicles` and `PATCH /vehicles/:id` now accept the five fields (all optional). Reads are unchanged — `GET /vehicles/:id` already returns the full row, so the fields flow through automatically. No new endpoints, no permission changes (`VEHICLE_CREATE` / `VEHICLE_UPDATE` already gate writes).

## 7. Data Backfill
**Not needed.** `driveSide` is a new nullable column (existing rows = NULL = unknown). The four exposed fields already existed with their data intact. `vehicleCode` / `customerNumber` untouched.

## 8. Risks
| Risk | Mitigation |
| --- | --- |
| `engineNo` leaking to customer-facing surfaces | Kept out of `/status` and `/display` projections (explicit `select`); regression test asserts the public projection has no `engineNo`; service emits no logs of the DTO. |
| Enum migration on a live table | Additive `CREATE TYPE` + nullable `ADD COLUMN` only; no rewrite of existing rows; `pg_dump` taken before applying in any shared environment. |
| Scope creep (converting other fields to enums) | Explicitly out of scope; strings retained. |

## 9. Tests / Verification
- **Unit (vitest, 8 tests):** service create persists all five + defaults to null when omitted; update conditional-spread (omitted columns untouched, explicit values written); `DriveSide` enum validation on create + update DTOs (reject non-RHD/LHD, accept RHD/LHD); `engineNo` privacy — public `/status` projection selects only `plateNumber`.
- **Typecheck:** `@bsop/api` + `@bsop/web` `tsc --noEmit` green.
- **Migration:** `prisma migrate dev --name vehicle_drive_side` applied cleanly; client regenerated (`DriveSide` available).
- **Booted smoke (disposable, sandbox-tagged, cleaned up):** create a vehicle with all five fields → PATCH `driveSide` RHD→LHD → GET shows all five; confirm a public payload carries no `engineNo`.

## 10. Proposed Effective Phase
Phase 1 (data-model/UI foundation). First CR of the approved stakeholder-wishlist roadmap (Phase A "Quick Wins"), executed one CR at a time.

## 11. Approval Needed?
**Yes** — mandatory review under CLAUDE.md §9 (schema change to core entity `Vehicle`). Low risk (additive, nullable, no rule/dependency/auth change). Commit is paused pending approval; only the files in §4 will be committed, followed by an annotated checkpoint tag. No push, no remote.
