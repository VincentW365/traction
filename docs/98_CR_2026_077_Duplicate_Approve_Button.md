# CR-2026-077 — Remove duplicate "Approve" button on a draft service order

**Status:** Implemented.
**Requested by:** Vincent Wilson — "Why are there two approve buttons here?"

## A. Cause
On the queue ticket detail, a DRAFT service order rendered **two** Approve buttons: one from the
explicit `order.status === 'DRAFT'` block (→ `POST /service-orders/:id/approve`) and one from the
`ORDER_ACTIONS.DRAFT` state-machine map (→ `POST /service-orders/:id/status`). Both did the same
DRAFT → APPROVED transition.

## B. Fix
Set `ORDER_ACTIONS.DRAFT = []` so only the dedicated **Approve** button (the `/approve` endpoint)
renders. No behavior change beyond removing the duplicate.

## C. Impacted files
- Web: `apps/web/app/(dashboard)/queue/[id]/page.tsx` (one map entry). No API/schema change.

## D. Validation
- `pnpm --filter @bsop/web exec tsc --noEmit` — green; web tests — 74 passed.
