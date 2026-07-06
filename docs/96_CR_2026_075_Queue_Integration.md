# CR-2026-075 — Queue / board integration for the technician + QC flow

**Status:** Implemented.
**Requested by:** Vincent Wilson — "make sure all of these integrate properly with the queuing system and operational transparency."

## A. Audit finding (primary defect)
CR-2026-073 moved the technician's "finish" from `POST /queue-tickets/:id/complete` (which released the
dispatch-board `ResourceOccupancy` and recomputed) to `readyForQc` → `changeStatus(QC)` (which released
neither). Result: a dispatched **bay stayed OCCUPIED on the dispatch board through QC and CLOSED** with
no auto-release, and a couple of transitions didn't refresh the boards promptly.

## B. Change
- **Free the bay when the tech finishes** — `readyForQc` (`service-orders.service.ts`) now releases the
  visit's `ResourceOccupancy` (status → AVAILABLE), mirroring the old `completeTicket`. It only frees
  when **no other active order on the same visit** still holds it (multi-order visits, CR-2026-068).
  The `changeStatus(QC)` recompute already emits `queue:updated`, so the dispatch board refetches and
  shows the bay free.
- **Free the bay at final completion** — `recordCompletion` (`status.controller.ts`) also releases any
  `ResourceOccupancy` the visit still holds when it closes (belt-and-braces for non-QC completion paths).
- **Prompt board refresh at "ready for pickup"** — added `READY_TO_INVOICE` to `RECOMPUTE_TRIGGERS`, so
  `QC → READY_TO_INVOICE` (which syncs the visit to READY_FOR_PICKUP) recomputes and emits `queue:updated`
  → the public/staff boards' "ready" list updates immediately instead of on the next poll.

## C. Verified integration (already correct)
- `readyForQc`/`startAssignment` recompute via `changeStatus` (QC / IN_PROGRESS ∈ triggers).
- `updateOrder`/`deleteOrder` (CR-2026-071) recompute.
- Visit-status sync: `QC → visit QC`, `READY_TO_INVOICE → READY_FOR_PICKUP`.
- `queue.recomputed → queue:updated` gateway broadcast on every recompute.

## D. Known behaviors left as-is (documented, not defects after this CR)
- A visit in **QC** does not appear on the live queue / public display board (it's post-service, awaiting
  a quality check) — managers are notified via the **Ready-for-QC alert** (CR-2026-074) instead. With the
  bay now freed, there's no longer a "board shows bay busy while job vanished" contradiction.
- **Paused** jobs are recording-only (CR-2026-011): the visit stays IN_SERVICE and boards don't show a
  paused flag. The paused state is visible on the technician view (CR-2026-073). Adding a board-level
  "paused" indicator would be a separate change.

## E. Impacted files
- API: `service-orders.service.ts` (readyForQc release + trigger), `status.controller.ts` (completion
  release). No schema change.

## F. Tests / validation
- `ready-for-qc.service.spec.ts`: frees the bay when no other active order; does NOT free while another
  order is active. `payment-release-gate.spec.ts` harness updated for the new occupancy write.
- Full API suite — **564 passed**; web typecheck — green.
