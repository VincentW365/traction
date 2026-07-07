# CR-2026-076 — Schedule summary excludes cancelled appointments

**Status:** Implemented.
**Requested by:** Vincent Wilson — "On the Schedule when you cancel an appointment it still shows that there is an appointment in the summary banner up top."

## A. Root cause
The Schedule summary StatCards read `stats.appointments` from `GET /schedule/day`, whose
`todayAppointments` count included **every** appointment for the day — `CANCELLED` and `MISSED` too. So
a cancelled appointment kept inflating the "Appointments" tile even though the calendar (CR-2026-058)
already hides it. The same pattern was in the week view's `appointmentCount`.

## B. Change
`apps/api/src/modules/schedule/schedule.service.ts` — both appointment counts (day summary +
week per-day) now filter `status: { notIn: ['CANCELLED', 'MISSED'] }`, matching what the calendar
displays. The frontend already refetches `schedule-day` on cancel (`onScheduleChanged`), so the tile
updates immediately.

## C. Impacted files
- API: `schedule.service.ts` (two count where-clauses). No web/schema change.

## D. Tests / validation
- `schedule.scope.spec.ts`: asserts every `appointment.count` (day + week) uses
  `status: { notIn: ['CANCELLED','MISSED'] }`. `vitest run src/modules/schedule` — 15 passed.
- `pnpm --filter @bsop/api exec tsc --noEmit` — green.

## E. Approval gate
Count-filter fix to match existing calendar behavior; no schema/RBAC change → **not a §9 trigger**.
Recorded as a Change Request; reversible via git.
