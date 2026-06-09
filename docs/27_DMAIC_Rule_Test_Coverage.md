# 27 — DMAIC 7-Rule Test Coverage

> Tracks automated test coverage of the DMAIC "Scheduling Rule Summary for Developer"
> (the 7 rules the web app must enforce). Status as of 2026-06-09.
> Run all API tests: `pnpm --filter api test` (vitest).

| # | Rule | Enforced in | Tests | Status |
| --- | --- | --- | --- | --- |
| **1** | No same-day scheduling after 10:00 AM without manager override | `appointments.service.ts` `enforceSameDayCutoff` (site-local, config-driven, audited) | `appointments/__tests__/same-day-cutoff.service.spec.ts` (6) | ✅ Covered |
| **2** | Job completed before 12:00 PM triggers a follow-up email (idempotent) | `notifications.service.ts` `sendMiddayCompletionFollowUp` | `notifications/__tests__/midday-followup.service.spec.ts` (4) | ✅ Covered |
| **3** | Mobile jack only for sedan-class vehicles (override + audit) | `resource-compatibility.checker.ts`, `resources.service.ts` `assignToResource`, `queue.service.ts` `callNext` | `scheduling/__tests__/resource-compatibility.checker.spec.ts` (Rule 3 block), `resources/__tests__/mobile-jack-gate.service.spec.ts` (5) | ✅ Covered |
| **4** | Cleaning jobs only to power-wash bay, only if operational | `resource-compatibility.checker.ts` | `scheduling/__tests__/resource-compatibility.checker.spec.ts` (power-wash gate) | ✅ Covered |
| **5** | Mileage only for service-category jobs (override + audit) | `common/helpers/mileage-gate.ts`, check-in.service, completion controller | `common/helpers/__tests__/mileage-gate.spec.ts` (5) + `appointments/__tests__/mileage-gate-boundaries.spec.ts` (6) | ✅ Covered (helper + both boundaries) |
| **6** | External machine-shop jobs never bay-scheduled | `resource-compatibility.checker.ts` (`isExternal` isolation) | `scheduling/__tests__/resource-compatibility.checker.spec.ts` (machine-shop isolation) | ✅ Covered |
| **7** | Service-due reminder = last service date + interval | `maintenance/engine/recommendation.calculator.ts` | `maintenance/__tests__/recommendation.calculator.spec.ts` (9) | ✅ Covered |

## Status

**All 7 DMAIC rules now have dedicated automated test coverage** (closed 2026-06-09). Full API suite: 135 tests passing.

Defects fixed while wiring the tests:
- **Rule 1** was using server-local time and did not audit overrides → fixed to **site-local** (`toZonedTime`) with the override **audited** (`SAME_DAY_CUTOFF_OVERRIDE`). Cutoff value confirmed sourced from `BusinessRuleConfig`, not hard-coded.

Optional future depth (not blocking pilot): end-to-end (HTTP) tests for the cutoff/mileage endpoints; reschedule-path cutoff enforcement in `appointments.update` (currently only `create`).
