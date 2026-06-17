# CR-2026-045 — Show walk-ins on the appointment schedule

**Status:** IMPLEMENTED. **Type:** Schedule UX fix — owner-reported. Recorded here.
**Author:** Vincent Wilson · **Date:** 2026-06-17

## 1. Request
"Walk-ins do not show on the appointment schedule — they should."

## 2. Cause
The Appointments calendar rendered only `Appointment` records (`GET /appointments?date=`) plus advisory holds. Walk-ins are **`ServiceVisit`s with `sourceType = WALKIN`** and have **no `Appointment`** row, so they never appeared on that calendar — even though the day's Walk-Ins **stat** was shown. Walk-ins also have no scheduled slot; their natural position on a time grid is their **arrival time** (`checkedInAt`).

## 3. Change
### Backend — `apps/api/src/modules/schedule/schedule.service.ts` (`getDaySchedule`)
- Added a `walkIns` projection: live, non-test-data `ServiceVisit`s with `sourceType = WALKIN` and `checkedInAt` within the selected day, each `{ serviceVisitId, ticketId, ticketNumber, customerName, vehiclePlate, checkedInAt, status }`.
- The **Walk-Ins stat** now counts all walk-ins that checked in that day (matches the calendar), instead of only those still queued.
- Placed after the `completedVisits` / `readyForPickup` queries so the always-live scope test (asserts `serviceVisit.findMany[0]` = completedVisits) is unaffected. The query filters `sourceType: 'WALKIN'` (excludes historical) + `testDataRunId: null` (excludes sandbox), matching the queue-rail scope.

### Frontend
- `components/schedule/appointments-lane.tsx` — new `WalkInBlock` type.
- `components/schedule/appointment-calendar.tsx` — accepts `walkIns` + `onWalkInClick`; walk-ins are packed into the same non-overlapping column layout as appointments/holds, placed at arrival time with a nominal 20-min block, in a **distinct emerald style** (legend entry added). Clicking one navigates to its queue ticket.
- `app/(dashboard)/schedule/page.tsx` — passes `data.walkIns` to the calendar and routes a walk-in click to `/queue/{ticketId}`.

## 4. Behaviour
- The Appointments view now shows, on one time axis: appointments (blue/grey/amber by status), advisory holds (dashed), and **walk-ins (emerald) at their arrival time**. The Bays view already surfaced walk-ins via the queue rail and bay occupancy — unchanged.
- No scheduling-engine, ranking, or appointment-creation change; this is a read/display addition.

## 5. Files
- `apps/api/src/modules/schedule/schedule.service.ts` — walk-in projection + stat.
- `apps/api/src/modules/schedule/__tests__/schedule.walkins.spec.ts` *(new)* — mapping, stat, scope.
- `apps/web/components/schedule/appointments-lane.tsx` — `WalkInBlock` type.
- `apps/web/components/schedule/appointment-calendar.tsx` — render walk-ins.
- `apps/web/app/(dashboard)/schedule/page.tsx` — wire walk-ins + click.
- `docs/67_CR_2026_045_WalkIns_On_Schedule.md` (this file).

## 6. Verification
- API typecheck green; API `vitest run` green — **65 files / 509 tests** (incl. new walk-ins spec 2/2 and the unchanged schedule scope spec).
- Web typecheck green; route-smoke green (66/66).

## 7. Governance
Read-model/display addition. No schema change, no scheduling-rule/priority change, no auth change, no API contract removal (field added). Not a §9 trigger. Recorded as a CR for traceability.
