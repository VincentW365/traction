# Change Request — Vehicle Service Class + Mobile-Jack Gate (DMAIC Rule 3)

**CR ID:** CR-2026-002
**Author:** Vincent Wilson · **Date:** 2026-06-09
**Status:** ✅ IMPLEMENTED — approved by direct instruction (recorded for the §9 audit trail).
**Governance:** Triggers `CLAUDE.md` §9 (core-entity schema change on `Vehicle`; hard-constraint scheduling-eligibility change). Scope was explicitly limited to the **hard eligibility gate** — no change to queue ranking, ETA, priority scoring, or broader scheduling.

---

## Change Summary

Make DMAIC Rule 3 ("mobile jacks are sedan-only") explicit and serviceClass-driven:

1. New `VehicleServiceClass` enum + nullable `Vehicle.serviceClass` column.
2. Capture `serviceClass` at check-in (intake).
3. Enforce server-side at **both** resource-assignment paths:
   - explicit assignment (`ResourcesService.assignToResource`) — block non-sedan on a mobile jack unless a **manager override** is supplied (audited via `AUDIT_ACTIONS.MOBILE_JACK_OVERRIDE`);
   - auto-dispatch (`QueueService.callNext`) — simply skips mobile jacks for non-sedan/unknown vehicles (no override in auto-dispatch).
4. Canonical rule encoded in the pure `resource-compatibility.checker` (`SEDAN_CLASS` required for `liftType==='mobile'`, with reason code `MOBILE_JACK_NON_SEDAN`).

Fail-safe: `UNKNOWN_REQUIRES_REVIEW` and missing/null class are treated as **ineligible** (blocked) — a mobile jack is only used when the vehicle is positively known to be sedan-class.

## Why

DMAIC Rule 3 (mobile jacks limited to sedan-class by weight). The prior implementation only blocked `HEAVY` by weight, which let SUVs/pickups classed as `STANDARD` onto mobile jacks. A dedicated service class makes the operational rule explicit and safe.

## Files / Modules Impacted

- `prisma/schema.prisma` — `VehicleServiceClass` enum, `Vehicle.serviceClass`; migration `20260609173013_vehicle_service_class` (applied, additive).
- `scheduling/engine/resource-compatibility.checker.ts` — serviceClass field + `MOBILE_JACK_NON_SEDAN_REASON` + sedan-only rule.
- `resources/resources.service.ts` (+ `dto/assign-resource.dto.ts`, controller) — assignment gate + override + audit.
- `queue/queue.service.ts` — `callNext` auto-dispatch skip.
- `appointments/dto/check-in.dto.ts`, `appointments.controller.ts`, `check-in.service.ts` — serviceClass capture at intake.
- `audit/audit.service.ts` — `MOBILE_JACK_OVERRIDE` action.

## Rule / Scheduling Impact

- **Hard eligibility gate only.** Ranking, ETA, priority scoring, batching, bay-preference logic untouched.
- Override is the sole human bypass and is fully audited (satisfies §9 / non-negotiable truth #9).

## Tests

- `resource-compatibility.checker.spec.ts` — Rule 3 block: sedan eligible; SUV_HEAVY / PICKUP / VAN / TRUCK ineligible; UNKNOWN ineligible; null ineligible; non-mobile unaffected. (38 tests pass.)
- `resources/__tests__/mobile-jack-gate.service.spec.ts` — eligible sedan; non-sedan blocked; unknown blocked; **manager override assigns + audits**; non-mobile unaffected. (5 tests pass.)

## Risks / Rollback

- Existing vehicles have `serviceClass = NULL` → they are **blocked from mobile jacks** until classified (fail-safe, intended). Front desk sets the class at check-in; a manager override covers urgent cases. Migration is additive/reversible (unused column/enum if rolled back).

## Follow-ups (not in this CR)

- Walk-in intake serviceClass capture.
- Optional make/model → serviceClass suggestion at intake (VIN/lookup), with human confirmation.
- Backfill serviceClass for known vehicles if identity data is ever unlocked.
