# CR-2026-065 — Resource up/down button on the dispatch board

**Status:** Implemented.
**Requested by:** Vincent Wilson — workflow-gap audit ("Resource up/down button (dispatch)").

## A. Objective
Let dispatch staff mark a bay/stand/jack **down for maintenance** and back **up** from the UI. The
endpoint existed but was API-only.

## B. Change
- **Backend**
  - `permissions.ts`: new narrow `RESOURCE_OPERATIONAL_TOGGLE` permission, granted to
    `SERVICE_ADVISOR` (ADMIN gets it via `Object.values`). Chosen over widening `CONFIG_EDIT` so
    advisors — who run dispatch — can toggle without gaining broad config rights.
  - `resources.controller.ts`: `POST /resources/:id/operational-status` now requires
    `RESOURCE_OPERATIONAL_TOGGLE` (was `CONFIG_EDIT`) and validates the body via a new
    `SetOperationalStatusDto` (`isOperational: boolean`, `reason?: string ≤500`). Still audits
    `RESOURCE_OPERATIONAL_STATUS_CHANGE`.
  - `resources.service.ts` (dispatch board): include `operationalStatus` and expose `isOperational`
    + `operationalReason` per resource so the board can show and toggle state.
- **Frontend** `dispatch/page.tsx`: each resource card shows a red "Down for maintenance" banner
  (with reason) when down; Manager + Service Advisor see **Mark down for maintenance** (reason input)
  / **Back up** controls. Uses the existing board refresh.

## C. Impacted modules / data
- API: `permissions.ts`, `resources.controller.ts`, `resources.service.ts` (board), new
  `dto/set-operational-status.dto.ts`. No schema change (the `ResourceOperationalStatus` model exists).
- Web: `dispatch/page.tsx`.

## D. Tests / validation
- `pnpm --filter @bsop/api exec tsc --noEmit` + `--filter @bsop/web` — green.
- Full API suite — **532 passed** (RBAC change verified non-breaking); web tests — 74 passed.

## E. Approval gate (§9 — auth model)
This adds one **narrow, additive** permission (`RESOURCE_OPERATIONAL_TOGGLE`) to SERVICE_ADVISOR +
ADMIN — surfaced per §9 as an auth-model touch, and pre-approved in the plan (recommended option;
the alternative was Manager-only with no RBAC change). No other role loses access; nothing else in
the auth model changes. Recorded as a Change Request; reversible via git.
