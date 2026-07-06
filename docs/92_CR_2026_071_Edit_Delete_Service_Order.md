# CR-2026-071 — Edit and delete service orders

**Status:** Implemented.
**Requested by:** Vincent Wilson — "Make it where you can add service orders you can actually delete and edit as well."

## A. Objective
Beyond creating a service order (CR-2026-057), let staff **edit** its services and **delete** it —
before work is assigned.

## B. Change
- **Backend** `service-orders.service.ts`
  - `updateOrder(id, {items?, notes?})` — replaces the order's line items (resolving service-type
    codes, reusing `resolveServiceTypeCodes`) and/or notes, in a transaction; audits
    `SERVICE_ORDER_UPDATED` and recomputes the queue (items drive duration).
  - `deleteOrder(id)` — hard-deletes the order (items cascade), audits `SERVICE_ORDER_DELETED`,
    recomputes.
  - Both guarded by `assertEditableStatus`: **only `DRAFT` / `APPROVED`** (before a technician is
    assigned). Delete additionally refuses if any active assignment exists.
- **Backend** `service-orders.controller.ts` — `PATCH /service-orders/:id` and
  `DELETE /service-orders/:id` (permission `SERVICE_ORDER_UPDATE`), new `UpdateServiceOrderDto`.
- **Frontend** `queue/[id]/page.tsx` — on `DRAFT`/`APPROVED` orders, **Edit** (inline service
  checklist from the catalogue, prefilled with the order's current services → PATCH) and **Delete**
  (confirm → DELETE) buttons for Manager/Service Advisor.

## C. Impacted files
- API: `service-orders.service.ts`, `service-orders.controller.ts`, new `dto/update-service-order.dto.ts`.
- Web: `queue/[id]/page.tsx`. No schema change (ServiceOrderItem already cascades on order delete).

## D. Safety / scope
- Editing/deleting is blocked once a technician is assigned or work has started (`ASSIGNED`+), so
  in-flight work and its skill/bay validation are never invalidated.
- Delete is a hard delete of an order that has no assignments (only its items cascade); it's audited.

## E. Tests / validation
- New `__tests__/edit-delete-order.service.spec.ts`: update replaces items on DRAFT; blocked when
  ASSIGNED; empty items rejected; delete removes a DRAFT order; blocked for IN_PROGRESS; blocked with
  an active assignment. Full API suite — **556 passed**.
- `pnpm --filter @bsop/api exec tsc --noEmit` + `--filter @bsop/web` — green; web tests — 74 passed.

## F. Approval gate
Additive endpoints guarded to pre-assignment statuses; no schema change; reuses existing permission →
**not a §9 trigger**. Recorded as a Change Request; reversible via git.
