# Change Request — Vehicle Classification UI (staff review queue)

**CR ID:** CR-2026-009
**Author:** Vincent Wilson · **Date:** 2026-06-10
**Status:** IMPLEMENTED (pending review/commit).
**Builds on:** CR-2026-008 (classification backend + 7,157 PENDING review rows). Advances `docs/29` item 2.1.

---

## A. Objective
Give staff a practical interface to confirm/correct imported vehicles' `serviceClass` (and `weightClass`) so the mobile-jack backlog can be cleared — **without weakening DMAIC Rule 3**. Confirmation remains required; make/model suggestions stay advisory and are never auto-applied; a vehicle stays mobile-jack blocked until a human confirms.

## B. Approach (approved decisions)
1. **Read-only query enhancements** to the existing `GET /vehicles/classification/queue` (no schema/Rule-3 change): filter by `confidence`, `search` (make/model/plate), "suggestable-first" ordering, and `offset`/`total` paging — to make 7k rows workable.
2. **Inline rows + bulk-accept** interaction: each row shows the suggestion with an editable serviceClass/weightClass select + a Confirm button; checkboxes drive "Confirm selected" via the existing bulk-confirm endpoint.
3. **Operations** placement, gated to the `vehicle:update` roles (FRONT_DESK, SERVICE_ADVISOR, MANAGER, ADMIN).

## C. Changes
**Backend (read-only):**
- `modules/vehicles/classification.service.ts` — `getQueue(opts)` now accepts `{ limit, offset, confidence, search }`, builds the filtered `where` (still `serviceClass: null` + `liveVehicleWhere` so placeholders/historical are excluded), orders `[{ classification: { confidence: 'asc' } }, { updatedAt: 'desc' }]` (enum HIGH→NONE), and returns `{ items, total, limit, offset }`.
- `modules/vehicles/classification.controller.ts` — `queue` accepts `limit`/`offset`/`confidence`/`search` query params; rejects an invalid `confidence`. RBAC unchanged (`vehicle:update`).

**Frontend (Next.js App Router):**
- `apps/web/app/(dashboard)/vehicle-classification/page.tsx` (NEW) — review queue: confidence filter, debounced search, paging, inline per-row confirm + bulk-accept, loading/empty/error states, and a role fallback message.
- `apps/web/lib/vehicle-classes.ts` (NEW) — option lists + confidence badge (web app can't import `@prisma/client`; mirrors the API enums).
- `apps/web/components/sidebar.tsx` — new "Vehicle Classification" nav item (Operations; `vehicle:update` roles).

## D. Guardrails honored
- No schema migration. `resource-compatibility.checker.ts` (Rule 3) and all scheduling/queue/ETA/dispatch code untouched.
- `Vehicle.serviceClass` is written ONLY by the existing `confirm`/`bulk-confirm` service path (staff action). The queue is read-only; suggestions are advisory.
- Queue excludes historical placeholder vehicles; no engine numbers / sensitive fields are selected or rendered.

## E. Tests / verification
- API: extended `classification.service.spec.ts` (filter/search/order/`{items,total}`/clamp/offset). `vitest run classification` + `tsc --noEmit` green.
- Web: `tsc --noEmit`.
- Manual E2E (local): log in as a `vehicle:update` role → Vehicle Classification → filter confidence=MEDIUM → confirm a row → it leaves the queue, `vehicle_classifications.status=CONFIRMED`, and an AuditLog/StatusHistory row exists; a non-sedan confirm keeps the vehicle mobile-jack blocked; bulk-accept shows a confirmed/failed summary.

## F. Approval gate
Not a Mandatory Review Trigger: no schema change, no business-rule/Rule-3/ETA/queue change — a read-only query enhancement plus a new UI over already-approved endpoints. Reviewed as a normal feature CR.
