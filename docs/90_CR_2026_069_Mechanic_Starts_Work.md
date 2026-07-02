# CR-2026-069 — The mechanic starts the work, not the admin

**Status:** Implemented.
**Requested by:** Vincent Wilson — "it should be the mechanic who starts the work not the admin once assigned."

## A. Objective
Once an order is assigned, the assigned **technician** starts the work from their own device; the
front desk / manager no longer starts it.

## B. Change
- **Backend** `service-orders.service.ts`
  - `startAssignment()` now enforces ownership: it resolves the caller's technician
    (`userAccountId → technician`) and rejects (`ForbiddenException`) unless the caller **is the
    assigned technician**. Managers/non-technicians cannot start the work.
  - New `getMyAssignments(userId, status='ASSIGNED')` returns the logged-in technician's own
    assignments in a compact floor-friendly shape (ticket, customer, vehicle, bay, services).
- **Backend** `service-orders.controller.ts` — `GET /service-orders/mine/assignments`
  (permission `SERVICE_ORDER_STATUS`, which technicians hold).
- **Frontend**
  - `queue/[id]/page.tsx` — removed the "Start Work" action from `ASSIGNED` orders (the admin/advisor
    queue detail no longer starts work). Assignment still shows; Reassign (CR-2026-068) remains.
  - `technician/page.tsx` — new **"Ready to Start"** section listing the technician's assigned orders,
    each with a big **START WORK** button → `POST /service-orders/:orderId/assignments/:assignmentId/start`.
    After starting, the order flows into the existing current-job / pause / complete controls.

## C. Impacted files
- API: `service-orders.service.ts`, `service-orders.controller.ts` (+ new spec). No schema change.
- Web: `queue/[id]/page.tsx`, `technician/page.tsx`.

## D. Tests / validation
- New `__tests__/start-assignment.service.spec.ts`: the assigned tech can start; a different tech is
  rejected; a non-technician (manager) is rejected; `getMyAssignments` returns [] for non-techs and
  maps a technician's assignments. Full API suite — **543 passed**.
- `pnpm --filter @bsop/web exec tsc --noEmit` — green; web tests — 74 passed.

## E. Notes
- Enforcement is at the intended start path (`startAssignment`, owner-checked) plus the UI move. The
  generic `/service-orders/:id/status` endpoint is not hard-locked for ASSIGNED→IN_PROGRESS, but no UI
  drives it anymore. A manager "start on behalf" override was intentionally not added (per the request).

## F. Approval gate (§9 — workflow / who-can-act)
Restricts who can start work (assigned technician only) and moves the action to the technician —
surfaced per §9. No permission grants change; no schema change. Recorded as a Change Request;
reversible via git.
