# CR-2026-073 — Technician workspace: live timers, pause/resume/ready-for-QC, inspection

**Status:** Implemented.
**Requested by:** Vincent Wilson — "When a technician is assigned a work and starts the work, there should be the option to pause the job, resume, and end the job, with a time from the start and a working time that shows how long they were actually working. Make it aesthetically appealing. Also the technician should see the vehicle inspection of that work. When the tech says a job is ready it should notify managers/admins that the tech is finished and ready for QC."

## A. Change
**Technician page** (`apps/web/app/(dashboard)/technician/page.tsx`) — the current-job card is redesigned:
- **Live timers** (tick every second): **Elapsed** (since work start) and **Working** (elapsed − paused
  time), so the sheet shows both wall-clock and *actual* working time. Shows "Started at HH:MM".
- **Pause / Resume** (existing endpoints) and a big **READY FOR QC** button that ends the job.
- **Vehicle inspection** for the job is listed with links to `/inspections/[id]` (technicians hold
  `INSPECTION_VIEW`).
- Cleaner mobile-first layout (blue ticket header, two timer tiles, clear touch targets).

**Backend** (`service-orders.service.ts` + controller):
- `GET /service-orders/:id/work-timing` → `{ startedAt, completedAt, status, pausedMs, openPauseStartedAt }`
  derived from `ServiceOrder.startedAt/completedAt` + `ServiceOrderPause` intervals — the client computes
  the live timers.
- `POST /service-orders/:id/ready-for-qc` → the **assigned technician** finishes: guarded to
  `IN_PROGRESS` (resume first if paused) and to the assigned tech; transitions `IN_PROGRESS → QC`
  (via `changeStatus`, which stamps `completedAt`, syncs the visit to QC, recomputes) and ends the
  technician's active assignment(s). Both endpoints under `SERVICE_ORDER_STATUS`.
- **The tech's "end" now correctly goes to QC** instead of the old "Mark Work Complete" which called
  `/queue-tickets/:id/complete` and skipped QC (jumped to READY_FOR_PICKUP). That path is removed from
  the technician page. The resulting QC state surfaces to managers via CR-2026-074.

## B. Impacted files
- API: `service-orders.service.ts`, `service-orders.controller.ts` (+ new spec). No schema change
  (`ServiceOrder.startedAt/completedAt`, `ServiceOrderPause` already exist).
- Web: `technician/page.tsx`.

## C. Tests / validation
- New `__tests__/ready-for-qc.service.spec.ts`: assigned tech → QC + ends assignment; non-assigned tech
  rejected; not-IN_PROGRESS rejected; `getWorkTiming` sums closed pauses + reports the open pause; 404
  when missing. `vitest run src/modules/service-orders` — 33 passed.
- `pnpm --filter @bsop/web exec tsc --noEmit` — green; web tests — 74 passed.

## D. Approval gate (§9 — workflow)
Moves the tech's "finish" to the proper QC handoff (assigned-tech-only) and adds read-only timing —
surfaced per §9. No schema/permission/queue-ranking change. Recorded as a Change Request; reversible.
