# CR-2026-070 — Allow check-in of RESCHEDULED appointments

**Status:** Implemented.
**Requested by:** Vincent Wilson — "I am not getting the option to check in a rescheduled appointment. Please fix this."

## A. Root cause
A rescheduled appointment has status `RESCHEDULED`, but check-in was hard-limited to
`CONFIRMED` / `DRAFT` in three places, so the option never appeared and the API would have rejected it:
- backend guard `check-in.service.ts` (`['CONFIRMED','DRAFT']`),
- the check-in page list filter and the per-row "Check In" button gate (`=== 'CONFIRMED'`),
- the customer-detail "Check In Today's Appointment" shortcut (queried `status=CONFIRMED`).
- **(follow-up)** the **Appointment Detail modal** (opened by clicking an appointment on the
  Appointments page or the Schedule) gated its inline "Check In" button on `['CONFIRMED','DRAFT']`, so
  a rescheduled appointment showed only **Reschedule** + **Cancel** — this was the actual entry point
  the user hit. Fixed by adding `RESCHEDULED` to `CHECKIN_STATUSES` in
  `apps/web/components/appointment-detail-modal.tsx`.

## B. Change
Include `RESCHEDULED` (an active, upcoming appointment) everywhere check-in eligibility is decided:
- **`apps/api/.../check-in.service.ts`** — allow `['CONFIRMED','DRAFT','RESCHEDULED']`.
- **`apps/web/.../check-in/page.tsx`** — list filter and the "Check In" button now include
  `CONFIRMED`/`DRAFT`/`RESCHEDULED` (the button previously showed only for `CONFIRMED`, so `DRAFT`
  was also un-checkable — now consistent with the backend).
- **`apps/web/.../customers/[id]/page.tsx`** — the shortcut fetches the day's appointments and treats
  `CONFIRMED`/`DRAFT`/`RESCHEDULED` as checkable-in.

## C. Impacted files
- API: `check-in.service.ts` (+ new spec). Web: `check-in/page.tsx`, `customers/[id]/page.tsx`.
- No schema change.

## D. Tests / validation
- New `__tests__/checkin-status.spec.ts`: check-in allowed for CONFIRMED/DRAFT/RESCHEDULED; rejected
  for CANCELLED/COMPLETED/CHECKED_IN/MISSED. 7 passed.
- `pnpm --filter @bsop/api exec tsc --noEmit` + `--filter @bsop/web` — green; appointments (23) + web
  (74) tests pass.

## E. Approval gate
Widens the check-in eligibility set by one active status; terminal statuses still blocked. No schema/
RBAC change; not an appointment-priority/lateness/grace change → **not a §9 trigger**. Recorded as a
Change Request; reversible via git.
