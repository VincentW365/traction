# CR-2026-078 — "Picked Up" close-out + queue board improvements

**Status:** Implemented.
**Requested by:** Vincent Wilson — "I need a final action after the ready for pickup to finish the process… make a Picked Up button/action to finish the process and close out the visit and efficiently clear the queue. The queue board looks like it is missing something — improve it and add essential stuff."

## A. "Picked Up" close-out (the missing final step)
After the pickup notification (SMS / Email / Call), each card in the **Ready for Pickup** panel now has a
one-click **✓ Picked Up** button. It:
- closes the visit (`ServiceVisit → CLOSED`),
- completes its queue ticket (`displayStatus → COMPLETED`) so it clears the board,
- frees any dispatch-board bay (`ResourceOccupancy → AVAILABLE`),
- logs a `PICKED_UP` queue event and **recomputes** (emits `queue:updated` → boards refresh).

Backend: `QueueService.markPickedUp` + `POST /queue/pickup/:serviceVisitId` (permission
`CHECKIN_PERFORM` — front desk / advisor / manager). Idempotent (already-closed = no-op). It's
deliberately lightweight — the full **Complete Visit** form (mileage/notes/payment gate) remains for
when that detail is needed; "Picked Up" is the fast everyday close.

## B. Queue board improvements
The stat row now shows the **full lifecycle** at a glance, not just the front of the line:
**Total in Queue · Waiting for Bay · Ready to Call · In Service · Ready for Pickup · Blocked**
(added **In Service** and **Ready for Pickup** counts; renamed "Ready" → "Ready to Call" for clarity).

## C. Impacted files
- API: `queue.service.ts` (markPickedUp), `queue.controller.ts` (route). No schema change.
- Web: `components/pickup-notification-panel.tsx` (Picked Up button + query invalidation),
  `app/(dashboard)/queue/page.tsx` (stat cards).

## D. Tests / validation
- New `queue/__tests__/picked-up.spec.ts`: closes visit + completes ticket + frees bay + recomputes;
  idempotent when already closed; 404 when missing. Full API suite — **568 passed**; web tsc + 74 tests green.

## E. Approval gate
Additive close-out endpoint + UI; frees the bay and recomputes (consistent with CR-2026-075). No
schema/RBAC change. Note: the quick "Picked Up" path does not run the payment gate (that stays on the
full Complete Visit form) — owner-directed for a non-tedious pickup. Reversible via git.
