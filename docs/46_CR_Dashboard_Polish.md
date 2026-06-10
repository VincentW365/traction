# Change Request — Dashboard Polish Pass

**CR ID:** CR-2026-017
**Author:** Vincent Wilson · **Date:** 2026-06-10
**Status:** IMPLEMENTED (pending review/commit).

---

## A. Objective
Unify the reporting/navigation UX for visual + state consistency. **No new business logic, no new metrics, no new endpoints, no new dashboards.**

## B. Findings & changes
- **Navigation (verified, no change):** the Management section is already cleanly grouped/ordered — Control Center → Reports → Classification Progress → Historical Analytics → Settings (report sub-pages grouped under Reports; Settings last).
- **Permission state — standardized:** `/reports` (KPIs) used a bespoke "Permission Denied" card that only appeared after a failed request. It now uses the **same in-component role gate + amber card** as the two report sub-pages (`useAuth` + `ALLOWED_ROLES = ['ADMIN','MANAGER']`, query `enabled: allowed`, early amber card when not permitted). Consistent and avoids an unnecessary failing request.
- **Error state — standardized:** all three report pages (`/reports`, `/reports/classification`, `/reports/historical`) now render the identical red error card with the same copy ("Failed to load this report.").
- **Loading / empty:** already consistent (`LoadingState` / `EmptyState`) — unchanged.

## C. Scope / guardrails
- Frontend-only, presentation/state consistency only. No new metrics or endpoints; no schema/API/scheduling/queue/ETA/Rule-3 changes; no data changes. The `/reports` role gate mirrors the existing nav restriction (ADMIN/MANAGER) — no new permission.

## D. Files changed
- `apps/web/app/(dashboard)/reports/page.tsx` (permission gate + standardized error card)
- `apps/web/app/(dashboard)/reports/classification/page.tsx` (error copy)
- `apps/web/app/(dashboard)/reports/historical/page.tsx` (error copy)

## E. Verification
- `cd apps/web && npx tsc --noEmit` → 0. API unaffected.

## F. Approval gate
Not a Mandatory Review Trigger: presentation-only consistency. Normal CR.
