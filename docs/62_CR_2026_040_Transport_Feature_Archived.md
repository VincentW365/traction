# CR-2026-040 — Transport feature archived (customer drop-off / request pick-up)

**Status:** IMPLEMENTED. **Type:** Feature removal (reversible archive) — owner-directed. Recorded here.
**Author:** Vincent Wilson · **Date:** 2026-06-17

## 1. Request
"For the Transport section we do not have the option for customers to drop off and request pick up. Remove the feature and any and all reference to it, but keep it stored away safely in case the option becomes available — so it is easily implemented."

Bert's does not currently offer customer drop-off / pick-up transport. The transport request + driver-dispatch feature is therefore removed from the live app, **but no transport code, schema, role, or data is deleted** — it is unregistered and archived so it can be turned back on with a small, mechanical change.

## 2. What "transport" was (and the dispatch disambiguation)
"Dispatch" is overloaded in this codebase. Two distinct things:
- **Transport feature (REMOVED):** customer drop-off / pick-up requests, a transport request form on the visit, a transport board (`/transport`) with pending/scheduled/in-progress requests and **driver assignment**, and the `/transport-requests` API.
- **Bay/queue dispatch (KEPT — core):** the `/dispatch` page is the **resource/bay board + ready-for-pickup notifications** (`/queue/ready-for-pickup`, `PickupNotificationPanel`). The queue `readyForDispatch` / `callNext` bay logic is core scheduling and is **untouched**. "Pickup" on `/dispatch` means *vehicle ready for the customer to collect*, not transport pickup.

## 3. Changes (live surface removed)
| Area | File | Change |
|---|---|---|
| Web nav | `apps/web/components/sidebar.tsx` | Removed the **Transport** nav entry (kept the **Dispatch** entry). |
| Web route | `apps/web/app/(dashboard)/transport/page.tsx` | **Renamed** to `page.archived.tsx` → no longer a route, file kept in tree. |
| Web visit detail | `apps/web/app/(dashboard)/queue/[id]/page.tsx` | Removed the Transport section: `TRANSPORT_ROLES`/`TRANSPORT_ACTIVE` consts, `TransportRequestRow` interface, transport form state, `transportQuery` (`/transport-requests/by-visit/...`), `createTransport` mutation, derived `transportRequests`/`hasActiveTransport`, and the `{/* Transport Section (P2) */}` JSX block. |
| API | `apps/api/src/app.module.ts` | Commented out the `TransportModule` import + registration (so `/transport-requests` is not served). |

## 4. Kept intentionally (the "stored safely" part — do NOT delete)
These are infrastructure the restore depends on, or are destructive to remove:
- **API module files** `apps/api/src/modules/transport/**` (controller, service, dto, module, `__tests__/transport.service.spec.ts`) — kept and still typecheck + pass (6/6). Just unregistered.
- **Schema** `model TransportRequest` (+ any related fields/enums) in `prisma/schema.prisma` — kept (removing is destructive; no data loss).
- **Role** `TRANSPORT_COORDINATOR` (enum + permissions in `permissions.ts`, staff role labels, dev-login profile) — part of the org/role model, kept.
- **Status labels** for the transport lifecycle in `apps/web/components/status-badge.tsx` — harmless, kept.
- **Test-data** transport scenario (`data-import/test-data/**`) — writes `TransportRequest` directly via Prisma (not the API), so it still works; kept.
- The archived page `apps/web/app/(dashboard)/transport/page.archived.tsx`.

## 5. Restore steps (how to turn it back on)
1. `apps/api/src/app.module.ts` — uncomment the `TransportModule` import and the `TransportModule` entry in the module array.
2. `apps/web/app/(dashboard)/transport/page.archived.tsx` — rename back to `page.tsx`.
3. `apps/web/components/sidebar.tsx` — re-add the **Transport** nav entry (see tag below for the exact block).
4. `apps/web/app/(dashboard)/queue/[id]/page.tsx` — re-add the Transport section. This block was **deleted from the tree** (not archived), so recover it from the restore tag:
   `git show transport-feature-archived:"apps/web/app/(dashboard)/queue/[id]/page.tsx"`
5. Clear stale Next route types if present: delete `apps/web/.next/types/app/(dashboard)/transport/` and `apps/web/.next/types/validator.ts`, then typecheck.
6. Verify: API + web typecheck, `vitest run` (API), web route-smoke.

## 6. Restore reference tag
- **`transport-feature-archived`** (commit `4dce17f`) — the full transport feature intact, immediately before this removal. Use it to recover any deleted code (esp. the queue-detail Transport section in step 4).

## 7. Verification
- API typecheck green; web typecheck green (after clearing stale `/transport` route types).
- API `vitest run` green — **63 files / 505 tests**, including the kept `transport.service.spec.ts` (6/6) and the test-data `runner.spec.ts` transport-scenario test.
- `/dispatch` (bay/resource board + ready-for-pickup) and queue `readyForDispatch`/`callNext` confirmed untouched.

## 8. Governance
Feature removal, reversible. No schema change, no rule change, no auth/permission removal, no audit weakening (CLAUDE.md §9 triggers not hit — schema, role, permissions, and audit all preserved). Recorded as a Change Request for traceability; no ADR required.
