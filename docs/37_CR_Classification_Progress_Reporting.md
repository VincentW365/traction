# Change Request — Vehicle Classification Progress Reporting

**CR ID:** CR-2026-010
**Author:** Vincent Wilson · **Date:** 2026-06-10
**Status:** IMPLEMENTED (pending review/commit).
**Builds on:** CR-2026-008 (classification backend) and CR-2026-009 (review queue UI). Advances `docs/29` item 2.1.

---

## A. Objective
Give managers a read-only snapshot to track the classification burn-down: remaining unclassified vehicles, the confirmed breakdown by service class, the mobile-jack-eligible count (Rule 3 = `SEDAN_CLASS`), and how much of the remaining backlog is suggestable (by confidence). Counts only — no PII.

## B. Approach (approved)
- Read-only `getStats()` on `ClassificationService` + `GET /vehicles/classification/stats`, gated `REPORT_VIEW` (ADMIN/MANAGER).
- New Reports subsection page `/reports/classification`; Management sidebar nav item (ADMIN/MANAGER).
- Snapshot of current state (no date range). Live-only (`liveVehicleWhere`) — historical placeholders excluded. Built from parallel `prisma.vehicle.count` calls (no schema change, no raw SQL).

## C. Changes
**Backend:**
- `modules/vehicles/classification.service.ts` — `getStats()` returns `{ totalLive, classified, unclassified, percentClassified, mobileJackEligible, confirmedByClass[], pendingByConfidence[] }`, all live-only.
- `modules/vehicles/classification.controller.ts` — `@Get('stats')` (`REPORT_VIEW`), no params.

**Frontend:**
- `apps/web/app/(dashboard)/reports/classification/page.tsx` (NEW) — StatCards (live / classified+% / remaining / jack-eligible) + two breakdown tables (confirmed-by-class with SEDAN highlighted; remaining-by-confidence). Role fallback for non-ADMIN/MANAGER.
- `apps/web/components/sidebar.tsx` — "Classification Progress" nav (Management; ADMIN/MANAGER).
- Reuses `StatCard`, `PageHeader`, `LoadingState`, `EmptyState`, `lib/api-client.ts`, `lib/vehicle-classes.ts`.

## D. Guardrails honored
- Read-only; no writes. No schema migration. Rule 3 (`resource-compatibility.checker.ts`), scheduling, queue, ETA, bay/dispatch all untouched.
- Live-only counts (placeholders excluded). Counts only — no plates/VINs/engine numbers returned or rendered.

## E. Tests / verification
- API: extended `classification.service.spec.ts` — `getStats` live filtering, `percentClassified`, mobile-jack count, breakdown shapes, zero-vehicle case. `vitest run classification` + `tsc --noEmit` green.
- Web: `tsc --noEmit`.
- Live (read-only): MANAGER sees the report; numbers cross-check the queue endpoint (total live 7157, remaining 7157, MEDIUM 1906, NONE 5251, mobile-jack eligible 0 before any confirmations); FRONT_DESK gets 403 and no nav item.

## F. Approval gate
Not a Mandatory Review Trigger: read-only reporting over existing data, no schema/Rule-3/ETA/queue change. Normal feature CR.
