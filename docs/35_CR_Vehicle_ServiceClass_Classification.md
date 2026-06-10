# Change Request — Vehicle ServiceClass Classification Workflow (suggestion-assisted, staff-confirmed)

**CR ID:** CR-2026-008
**Author:** Vincent Wilson · **Date:** 2026-06-09
**Status:** **APPROVED IN PRINCIPLE (2026-06-09) — implementation pending; data backfill gated.** Approved by Vincent Wilson with the three open questions resolved (see §J). Code to be implemented and reviewed; the backfill write is a separate gated step (dry-run + counts + explicit approval) under `docs/21_Approval_Gates.md`.
**Builds on:** the customer/vehicle + jobs imports (CR-2026-003/004/005) and CR-2026-006 (operational scope). Resolves `docs/29` item **2.1** (imported vehicles have null `serviceClass`/`weightClass` → mobile-jack-blocked until classified).

> ⚠️ **Mandatory Review Trigger** (CLAUDE.md §9): schema change affecting a core entity (`Vehicle`) **and** the area of the DMAIC Rule 3 mobile-jack safety gate. Documented for approval **before** any code. No implementation done.

---

## A. Objective
Give staff a way to classify the imported (and any future unclassified) vehicles' operational `serviceClass` — and `weightClass` — so they stop being mobile-jack-blocked, **without** ever silently writing the safety field. The system *suggests* a class from make/model; **staff confirm or adjust** each vehicle before the value becomes operational. Until confirmed, the vehicle stays blocked (Rule 3 fail-safe preserved).

## B. Inputs Used
- `prisma/schema.prisma` — `Vehicle.serviceClass`/`weightClass` (nullable, lines 317–319); enums `VehicleServiceClass` (191–199, incl. `UNKNOWN_REQUIRES_REVIEW`) and `VehicleWeightClass` (183–187); `VehicleWeightSuggestion` lookup (1165–1175); `AuditLog`/`StatusHistory` (885+/867+).
- `apps/api/src/modules/scheduling/engine/resource-compatibility.checker.ts` (128–133, `MOBILE_JACK_NON_SEDAN_REASON`) — the Rule 3 gate: only `SEDAN_CLASS` may use mobile jacks; null/`UNKNOWN` blocked unless overridden. **Unchanged by this CR.**
- `apps/api/src/modules/appointments/check-in.service.ts` (227–240) — the only existing path that writes `serviceClass`/`weightClass` (via intake).
- `apps/api/src/modules/vehicles/vehicles.service.ts` — `update()` does **not** expose the class fields today.
- `prisma/seed.ts` (324–341) — `VehicleWeightSuggestion` seeded with **11** common make/model→weight rows; **weight only**, and **no application code reads the table**.
- `apps/api/src/common/constants/permissions.ts` — `VEHICLE_UPDATE` (`vehicle:update`) available to reuse.

## C. Assumptions
1. Most imported vehicles have `make`/`model` populated but many will not match the thin 11-row lookup → expect a large share of **LOW/NONE** confidence requiring manual entry. The queue must work fully without a suggestion.
2. Operational truth stays on `Vehicle.serviceClass`/`weightClass`. The new classification record is a **review projection + audit trail**, not a second source of operational truth (CLAUDE.md §4: no duplicated status truth).
3. `weightClass` may be suggested alongside `serviceClass`, but it is also only written on confirm (kept consistent and auditable; less safety-critical than serviceClass but same flow for simplicity).
4. Placeholder/historical vehicles (`vehicleCode` startsWith `HIST-UNRESOLVED-`) are **excluded** from the review queue (reuse `liveVehicleWhere`, CR-2026-006).

## D. Proposed Design / Change

### D1. Schema (additive, non-destructive — Prisma migration)
1. **Extend the existing lookup:** add `suggestedServiceClass VehicleServiceClass?` (nullable) to `VehicleWeightSuggestion`. Expand the seed: add `suggestedServiceClass` to existing rows and broaden make/model coverage. Lookup stays **advisory only**.
2. **New per-vehicle review/audit record:** `VehicleClassification`
   - `vehicleId` **@unique** (one current review per vehicle) → relation to `Vehicle`
   - `status` → new enum `ClassificationStatus { PENDING_REVIEW, CONFIRMED }`
   - `suggestedServiceClass VehicleServiceClass?`, `suggestedWeightClass VehicleWeightClass?`
   - `confidence` → new enum `ClassificationConfidence { HIGH, MEDIUM, LOW, NONE }`
   - `source` → new enum `ClassificationSource { MAKE_MODEL_LOOKUP, MANUAL, CHECK_IN }`
   - `confirmedServiceClass VehicleServiceClass?`, `confirmedWeightClass VehicleWeightClass?` (null until confirmed)
   - `reviewedByUserId String?` → relation to `UserAccount`; `reviewedAt DateTime?`
   - `createdAt`, `updatedAt`; indexes on `status` and `vehicleId`
   - Captures exactly the audit set requested: **suggestion, confidence, source, reviewer, reviewedAt, final confirmed class**.

### D2. Suggestion engine (pure, unit-testable)
`apps/api/src/common/helpers/vehicle-classification.ts` — given `{ make, model, modelYear }` and the set of `VehicleWeightSuggestion` rows, return `{ suggestedServiceClass, suggestedWeightClass, confidence, source }`:
- **HIGH** = make + model match (and year within `[yearFrom,yearTo]` when specified)
- **MEDIUM** = make + model match, no year specificity
- **LOW** = only make matches
- **NONE** = no match → null suggestions (still reviewable)
Case-insensitive `contains` match, mirroring existing search patterns. No I/O in the helper (rows passed in), so it tests like `mileage-gate.ts`/`operational-scope.ts`.

### D3. Service + API (new `VehicleClassificationService`; reuse `VEHICLE_UPDATE` RBAC)
- `GET /vehicles/classification-queue?siteId?&limit` — list **live** vehicles with `serviceClass IS NULL` (or `VehicleClassification.status = PENDING_REVIEW`), each with its stored/computed suggestion + confidence. Excludes historical/placeholder via `liveVehicleWhere`.
- `POST /vehicles/:id/classification/confirm` `{ serviceClass, weightClass?, notes? }` — **staff confirm/adjust**. In one transaction: write `Vehicle.serviceClass` (+`weightClass` if given), set `VehicleClassification` → `CONFIRMED` with `confirmed*`, `reviewedByUserId`, `reviewedAt`; write an **`AuditLog`** row (`action: 'VEHICLE_CLASSIFIED'`, `before/afterJson` of the class fields, actor, optional notes) and a `StatusHistory` (`entityType: 'Vehicle'`). Validates enum values.
- `POST /vehicles/classification/bulk-confirm` `{ items: [{ vehicleId, serviceClass, weightClass? }] }` — **explicit staff-reviewed bulk accept**: each item carries the class the reviewer chose (no blanket/auto acceptance of suggestions). Audited per item.
- **No auto-apply anywhere.** Suggestions are never written to `Vehicle.serviceClass` without an explicit confirm.

### D4. Backfill (additive, idempotent, non-destructive)
A one-off command (mirrors prior import idempotency) that, for existing **live** unclassified vehicles, creates `VehicleClassification` rows in `PENDING_REVIEW` populated with computed suggestions + confidence + `source: MAKE_MODEL_LOOKUP`. It **does not touch** `Vehicle.serviceClass`. Re-runnable (upsert by `vehicleId`). Run separately, gated, after approval.

### D5. Check-in parity (optional, recommended)
When check-in (227–240) sets the class, also upsert a `CONFIRMED` `VehicleClassification` with `source: CHECK_IN` so the audit trail is complete regardless of entry point. Behaviorally identical to today otherwise.

## E. Impacted Modules and Data
- **Schema:** `VehicleWeightSuggestion` (+1 column), new `VehicleClassification` + 3 enums; relations on `Vehicle` and `UserAccount`. Additive migration only.
- **API:** new `vehicles/classification.*` (service/controller/dtos); `prisma/seed.ts` (expand mapping). Optional touch to `check-in.service.ts` (parity).
- **Helpers reused:** `liveVehicleWhere` (operational-scope), `AuditLog`/`StatusHistory` patterns.
- **Unchanged:** `resource-compatibility.checker.ts` (Rule 3), scheduling, ranking, dispatch, bay/tech assignment, parts.

## F. Rule Impact (CLAUDE.md §6)
- **Rule:** A vehicle becomes mobile-jack eligible only when its `serviceClass` is **`SEDAN_CLASS`**, set by **staff confirmation**.
- **Example:** Imported "Toyota Corolla" → suggested `SEDAN_CLASS` (HIGH); staff confirms → eligible. "Toyota Hilux" → suggested `PICKUP`; confirms → stays jack-blocked (correct).
- **Exception:** No make/model match → NONE confidence, staff sets manually.
- **System response:** suggest (advisory) → require confirm → write operational field + audit → Rule 3 evaluates as today.
- **Configurable?** Suggestions yes (lookup table/seed). The gate itself is unchanged.
- **Approval needed?** **Yes** (schema + safety-gate area).

## G. Risks / Tradeoffs
- **Schema migration on a core entity** — additive/non-destructive, but a review trigger; run as a separate approved step.
- **Thin lookup coverage** → many LOW/NONE; mitigated by a fully functional manual queue and easy lookup expansion.
- **Bulk-confirm misuse** — mitigated: each item must carry an explicit reviewer-chosen class; every confirm is audited.
- **No regression to scheduling** — Rule 3 logic untouched; vehicles stay blocked until confirmed (fail-safe preserved).
- **RBAC:** reuses `VEHICLE_UPDATE`; if a distinct `vehicle:classify` permission is preferred, that's a small additive option (open question below).

## H. Tests / Validation
- **Pure helper:** HIGH/MEDIUM/LOW/NONE selection, year-boundary and case-insensitive matching.
- **Service (mocked Prisma):** confirm writes operational fields **and** the audit record + AuditLog, and sets reviewer/reviewedAt; **never** writes `serviceClass` without confirm; queue excludes historical/placeholder and already-confirmed; bulk-confirm audits each item; invalid enum rejected.
- **Migration** applies cleanly; **full API suite + `tsc --noEmit`** green.
- **Manual (if seeded DB):** queue lists unclassified live vehicles with suggestions; confirm flips one to eligible; verify a blocked non-sedan stays blocked; verify AuditLog entry exists.

## I. Proposed Effective Phase
**Phase 2** (technician/bay assignment & service ops) — classification unblocks bay/jack eligibility; foundational data quality for scheduling.

## J. Approval Gate
**Yes — required.** Schema change to a core entity + DMAIC Rule 3 safety-gate area → Mandatory Review Trigger (CLAUDE.md §9). Use this CR (and `templates/Change_Request_Template.md`) as the review artifact; implement as a separate, reviewable change with its own tests after sign-off.

### Open questions — RESOLVED (2026-06-09, Vincent Wilson)
1. **RBAC:** ✅ Reuse `VEHICLE_UPDATE` for v1. No new permission added yet.
2. **Backfill timing:** ✅ Include PENDING-row creation in this CR, but as a **gated data step**: implement **dry-run first**, show counts, **do not write until approved**, make it **idempotent**, and **exclude historical placeholder vehicles by default**.
3. **Check-in parity (D5):** ✅ Include in v1. When staff set or change `serviceClass` at check-in, write the **same audit/status trail** (AuditLog + StatusHistory + a `CHECK_IN`-sourced `VehicleClassification`) as the classification queue.
