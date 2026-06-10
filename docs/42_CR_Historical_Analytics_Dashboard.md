# Change Request — Historical Analytics Dashboard

**CR ID:** CR-2026-013
**Author:** Vincent Wilson · **Date:** 2026-06-10
**Status:** IMPLEMENTED (pending review/commit).
**Builds on:** CR-2026-005 (jobs/visits historical import) and CR-2026-006 (operational scope filtering).

---

## A. Objective
Surface management insight from the imported historical jobs (9,055; 2023-10-25 → 2026-06-09) **in-app, read-only**, without affecting live operations. Historical-only (`sourceType = HISTORICAL_IMPORT`).

## B. Approach (approved)
- Read-only `getHistoricalAnalytics({ from?, to? })` on `ReportingService` + `GET /reports/historical-analytics` (`REPORT_VIEW`, ADMIN/MANAGER).
- **Historical-only** via new inverse helpers beside the live ones: `historicalVisitWhere()` / `historicalVisitSql(alias)` in `common/helpers/operational-scope.ts` (reuse the marker constant; hard-coded SQL aliases; only date bounds bound).
- New **`/reports/historical`** page + Management nav item.

## C. Metrics (DB-derived) & deliberate omissions
- **Included:** date span; total jobs; completed (terminal CLOSED) / cancelled counts + rates; monthly volume trend (`date_trunc('month', created_at)`); technician workload (top 15, via `technician_assignments`); pause rate; rework rate (distinct historical orders with ≥1 pause/rework ÷ total historical orders); average job duration **with sample size**.
- **Omitted — service-family mix:** the historical import stored **0 structured order-items**, so a DB-derived mix isn't possible (docs/23 obtained it via an offline CSV keyword scan). The UI notes this.
- **Caveated — avg duration:** only a subset of orders have both `started_at` and `completed_at`, and many historical source timestamps are unreliable (some `completed_at` precede `started_at`). The query therefore restricts to **valid positive intervals** (`completed_at > started_at`) and reports the resulting sample size.

## D. Changes
- `common/helpers/operational-scope.ts` — `historicalVisitWhere()`, `historicalVisitSqlText()/historicalVisitSql()` (+ tests).
- `modules/reporting/reporting.service.ts` — `getHistoricalAnalytics()`; `reporting.controller.ts` — `GET /reports/historical-analytics` (`from`/`to` optional).
- `apps/web/app/(dashboard)/reports/historical/page.tsx` (NEW) — StatCards, monthly-volume bars, technician table, span + caveat notes, optional date range.
- `apps/web/components/sidebar.tsx` — "Historical Analytics" (Management; ADMIN/MANAGER).
- Tests: `modules/reporting/__tests__/historical-analytics.spec.ts`; extended `common/helpers/__tests__/operational-scope.spec.ts`.

## E. Guardrails honored
- Read-only; no schema migration, no writes. No change to live operational views, the `includeHistorical` toggles, scheduling, queue, ETA, Rule 3, dispatch, or resource compatibility. Raw SQL hard-coded aliases; only `from`/`to` parameterized. Managers-only (no customer PII; technician names only).

## F. Verification
- API: `vitest run reporting operational-scope` (21 passed) + `tsc --noEmit` 0; web `tsc` 0.
- Live read-only (`bsop_dev`): MANAGER sees total ≈9,055, span 2023-10-25→2026-06-09, monthly trend + technician workload populated, pause ≈17% / rework ≈0.3%, avg duration captioned with sample ≈702; FRONT_DESK → 403. Cross-checks `docs/23`/`docs/32`.

## G. Approval gate
Not a Mandatory Review Trigger: read-only reporting over already-imported data; no schema/Rule-3/ETA/queue change, no live-filter change. Normal feature CR.
