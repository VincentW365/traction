# CR-2026-068 — Assign one technician to all a visit's orders + edit before start

**Status:** Implemented.
**Requested by:** Vincent Wilson — "when… assigning service orders if there is more than one I am seeing 'assign' twice to do two assignments. Have it assign once to both tasks. And have the option to edit the assignment if work has not started."

## A. Objective
Let staff assign one technician to all of a visit's approved service orders in a single action, and
edit (reassign) an assignment while work has not started.

## B. Root cause found
The double-booking guard blocked a technician from being assigned to a **second order of the same
visit** ("already has an active assignment"). So even doing it per-order failed — a visit's multiple
orders (same vehicle) could not go to one technician.

## C. Change
- **Backend** `service-orders.service.ts`
  - **Same-visit fix:** the double-booking check in `assign()` (and `assignAdditional`) now excludes
    assignments on the **same** visit (`serviceOrder.serviceVisitId != order.serviceVisitId`). A tech
    can hold every order of one visit; cross-visit double-booking is still blocked.
  - **Batch assign:** new `assignAllForVisit(visitId, technicianId, userId)` assigns the technician to
    every `APPROVED` order of the visit (reuses `assign()` → auto-bay + validation per order).
  - **Edit-before-start guard:** `updateAssignment()` now rejects edits once the assignment's status
    is not `ASSIGNED` ("work has already started").
- **Backend** `service-orders.controller.ts` — `POST /service-orders/by-visit/:visitId/assign-all`
  (`AssignAllDto`, permission `SERVICE_ORDER_ASSIGN`).
- **Frontend** `queue/[id]/page.tsx`
  - "Assign all N approved orders to one technician" control (shown when ≥2 approved orders) → batch
    endpoint; each order auto-gets a compatible free bay.
  - "Reassign" button on `ASSIGNED` (not-started) orders → inline technician picker → `PATCH
    /assignments/:id` (blocked server-side once started).

## D. Impacted files
- API: `service-orders.service.ts`, `service-orders.controller.ts`, new `dto/assign-all.dto.ts`.
- Web: `queue/[id]/page.tsx`. No schema change.

## E. Tests / validation
- New `__tests__/assign-multi.service.spec.ts`: same-visit excluded from the guard (multi-order on one
  visit allowed); cross-visit still blocked; `assignAllForVisit` assigns every approved order / throws
  when none; `updateAssignment` allowed when ASSIGNED, blocked once IN_PROGRESS. `vitest run
  src/modules/service-orders` — 17 passed.
- `pnpm --filter @bsop/api exec tsc --noEmit` + `--filter @bsop/web` — green; web tests — 74 passed.

## F. Notes
- Reassign uses `updateAssignment` (a tech swap); with every tech holding all skills (CR-2026-067)
  skill compatibility is a non-issue. Full re-validation on edit can be added later if needed.

## G. Approval gate (§9 — assignment logic)
Changes assignment behavior (same-visit double-booking) — surfaced per §9. It **loosens** an overly
strict guard while preserving cross-visit protection and all skill/bay checks; adds a batch convenience
and an edit guard. No schema/queue-ranking change. Recorded as a Change Request; reversible via git.
