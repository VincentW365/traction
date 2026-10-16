# CR-2026-125 — A technician's clock stops when the work goes to Quality Check

**Date:** 2026-10-16
**Status:** Implemented, unit-tested, committed to `master`
**Requested by:** Product owner — "When techs send the work to QC there is still a working timer for the tech. Once the tech sends to QC there should be no effect on their time."

---

## A. What was actually happening

The server was already right. On **Finished and ready for review** the API (`readyForQc`) stamps the order's `completedAt`, closes every open labour segment (`SUBMITTED_TO_QC`), ends the assignments, frees the bay and freezes the KPI snapshot. The technician's *recorded* time — the workday total and every report — stopped at the hand-off.

What kept moving was the **screen**. Both technician screens computed "Elapsed" and "Working" in the browser as `now − startedAt` every second and never read `completedAt`, which the timing endpoint had been returning all along. A job left open on the tablet after the hand-off went on counting, and looked exactly like a clock still running against the technician.

## B. What changed

- **`apps/web/lib/job-clock.ts`** — one pure function, `jobClock(timing, now)`, now used by both screens. The end bound is `completedAt` when the job has one, and `now` only while it has none. Closed and open pauses come off the working figure as before. Never negative; unaffected by a tablet whose clock is behind the server.
- **Job workspace** (`/technician/jobs/:orderId`) — once finished, both figures read "· final", lose the amber/green live colouring, and a line says *Sent to Quality Check at HH:MM — your time on this job stopped there.* "Over expected" is a live warning and is not raised on a finished job.
- **My Jobs** — same clock; the "Working" tile says "· final" if the on-the-clock job has just been handed off.
- **Spec** — `lib/__tests__/job-clock.spec.ts`: live counting, pauses, the stop at hand-off regardless of screen time, a slow tablet clock, zero/bad-data cases.

## C. Not changed

Segments, assignments, KPI capture and the workday total — all already stopped at QC. The QC inspector's time has never counted against the technician; it is not labour-segment time.

## D. Verification

- `pnpm --filter @bsop/web typecheck`: clean. `job-clock.spec.ts`: all cases pass.

## E. Approval gate

Presentation arithmetic only; no rule, data or audit change. Recorded here.
