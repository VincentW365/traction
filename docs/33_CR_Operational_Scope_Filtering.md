# Change Request — Operational Scope Filtering (exclude historical/placeholder by default)

**CR ID:** CR-2026-006
**Author:** Vincent Wilson · **Date:** 2026-06-09
**Status:** IMPLEMENTED (pending review/commit).
**Builds on:** CR-2026-003/004/005 (customer/vehicle + historical jobs imports). Resolves the docs/29 follow-up: "operational metrics must exclude historical placeholders."

---

## 1. Summary
Exclude historical and placeholder records from **live operational metrics and lookups by default**, with an **explicit opt-in** for historical reporting. No schema change, no backfill, no scheduling/queue behavior change.

Markers (existing): `ServiceVisit.sourceType='HISTORICAL_IMPORT'`, `Customer.customerNumber='BERT-HIST-UNKNOWN'`, `Vehicle.vehicleCode` startsWith `'HIST-UNRESOLVED-'`.

## 2. Approach (approved)
- Shared helper `apps/api/src/common/helpers/operational-scope.ts` — pure module exposing the markers as Prisma where-builders (`liveVisitWhere`/`liveCustomerWhere`/`liveVehicleWhere`/`serviceVisitIsLive`) and raw-SQL fragments (`liveVisitSql`/`liveVehicleSql`/`liveCustomerSql` + `*SqlText`). All default to exclusion; return `{}` / `Prisma.empty` when `includeHistorical` is true.
- **Opt-in:** `includeHistorical` boolean query param (default false) on **reporting / performance / customers / vehicles lookup** endpoints only, threaded controller→service→helper. Gated by each route's existing RBAC (no new permission).
- **Always-live (no opt-in):** manager-dashboard, schedule views, maintenance reminder mileage averaging — always exclude historical/placeholder.
- Raw-SQL aliases are hard-coded literals (validated in the helper); no user-controlled aliases.

## 3. Exemptions (intentionally NOT filtered — annotated in code)
- **By-id lookups** (`customers.findById`, `vehicles.findById`): explicit fetch by primary key — caller asked for that exact record. Annotated.
- **Appointment / audit_log aggregations** in reporting: no historical-import source (no appointments/audit rows were created by the imports), so they need no source filter. Annotated.
- **Live queue/dispatch/status surfaces** (`queue.service` boards, `resources.getDispatchBoard`, public `status` token endpoint): already safe (ticket-based / active-status / token-based — historical rows have no ticket and terminal status). Verified, unchanged (annotated `getReadyForPickup` + board ready-list as exempt).

## 3a. Deferred (found during implementation, intentionally NOT changed)
- **`queue.service.getAvgServiceMinutes`** aggregates *all* completed service orders for a site (no status/ticket scope), so HISTORICAL_IMPORT orders are currently included and may skew it. It feeds the **live queue board ETA estimate**, and this CR is barred from ETA/queue/scheduling changes (CLAUDE.md §9 requires a separate review). Left unchanged and annotated in code; tracked as docs/29 item 2.5.

## 4. Files changed
- NEW: `common/helpers/operational-scope.ts` (+ `__tests__/operational-scope.spec.ts`).
- `modules/reporting/reporting.service.ts` (+ `reporting.controller.ts`), `performance.service.ts` (+ `performance.controller.ts`).
- `modules/reporting/manager-dashboard.service.ts` (always live).
- `modules/schedule/schedule.service.ts` (completed-visit projections, always live).
- `modules/maintenance/maintenance-reminder.service.ts` (`calculateAverageDailyMiles`, always live).
- `modules/customers/customers.service.ts` (+ `customers.controller.ts`), `modules/vehicles/vehicles.service.ts` (+ `vehicles.controller.ts`).
- Tests under each module's `__tests__/`.

## 5. Guardrails honored
No schema migration/backfill · no scheduling/queue/ETA/ranking/bay/dispatch/reminder/notification/write-path change · no public endpoint exposes historical placeholders · no raw PII in logs or test fixtures · raw-SQL aliases hard-coded only.

## 6. Tests / verification
- Pure helper tests (predicates, where-builders default vs opted-in, SQL fragment text, unsafe-alias rejection).
- Mocked-Prisma service tests: reporting/customers/vehicles/performance assert the live filter is present by default and absent when `includeHistorical=true`; manager-dashboard/schedule/maintenance assert the filter is ALWAYS present.
- Full API test suite + typecheck. Grep audit that every visit/order/customer/vehicle aggregation either applies a `live*` helper or is annotated exempt.
