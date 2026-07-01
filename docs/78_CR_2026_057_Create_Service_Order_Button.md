# CR-2026-057 — "Create Service Order" button (unblocks technician assignment)

**Status:** Implemented.
**Requested by:** Vincent Wilson — "Once an appointment is made and checked in… how do we assign a technician? I am stuck here with no option to apply a technician."

## A. Objective
Let front-desk/manager staff create a service order for a checked-in visit from the queue ticket
detail page, so the existing **Approve → Assign technician** flow is reachable from the UI.

## B. Root cause (why the user was stuck)
Technician assignment lives on the queue ticket detail page (`/queue/[id]`) → "Service Orders"
section → **Assign** button, which only appears once a ServiceOrder is **APPROVED**. But the web app
had **no way to create a ServiceOrder**: check-in / walk-in do not auto-create one, and no
"Create Service Order" control existed anywhere in the frontend. The backend `POST /service-orders`
endpoint existed and worked — only the UI affordance was missing. So the section was permanently
stuck at "No service orders created yet," and Approve/Assign were unreachable.

## C. Design / change (frontend only)
Add a **"+ Create Service Order"** button to the Service Orders card header (gated to ADMIN/Manager
and Service Advisor — the roles holding `service_order:create`; the API still enforces it):
- **Appointment visits** — one click: prefills line items from the appointment's requested services
  (`appointment.services[].serviceType.code`) and creates the DRAFT order immediately. Button reads
  `+ Create Service Order (N)`. (This is the owner-selected "prefill from requested services" UX.)
- **Walk-ins / no requested services** — appointments are the only structured source of requested
  services (walk-ins don't persist a service list), so the button opens a small **catalogue picker**
  (`GET /service-types`, checkboxes) to choose services, then creates the order.

After creation the order shows as DRAFT with the existing **Approve** button → then **Assign**.

## D. Impacted modules / data
- Web only: `apps/web/app/(dashboard)/queue/[id]/page.tsx` — new state, `service-types` query,
  `createOrder` mutation (`POST /service-orders`), header button + fallback picker.
- No backend, DTO, schema, or permission change (reuses `POST /service-orders`).

## E. Risks / tradeoffs
- Walk-ins require picking services (one extra step) because the walk-in flow never stored a
  structured service list — out of scope to change here.
- The button lets staff create multiple orders per visit (matches backend allowance); typical use is
  one. No new guard added.

## F. Tests / validation
- `pnpm --filter @bsop/web exec tsc --noEmit` — green.
- `pnpm --filter @bsop/web exec vitest run` — 74 passed (route-smoke + dev-sandbox).
- Manual click-path now works end to end: check in → open queue ticket → **Create Service Order**
  → **Approve** → **Assign** (technician + bay) → **Start Work**.

## G. Approval gate
Frontend affordance over an existing, permission-guarded endpoint. No schema/RBAC/auth/queue-ranking
change → **not a §9 trigger**. Recorded as a Change Request; reversible via git.
