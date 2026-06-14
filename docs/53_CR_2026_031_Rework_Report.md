# CR-2026-031 — Rework / First-Time-Fix report

**Status:** IMPLEMENTED — pending review + commit (one-CR-at-a-time roadmap, Phase A / CR-C).
**Type:** Change Request (read-only report; **no schema change, no new dependency**).
**Author:** Vincent Wilson · **Drafted:** 2026-06-14
**Approval gate:** Not a CLAUDE.md §9 mandatory trigger (no schema/rule/dependency/auth change). Lightweight CR. Commit paused pending review.

---

## 1. Change Summary
A new manager-gated **Rework / First-Time-Fix report** that surfaces jobs which "came back" — service orders with one or more `ServiceOrderRework` records — over **live** operations, with a first-time-fix headline. New endpoint `GET /reports/rework` + page `Reports → Rework / FTF` + sidebar entry.

## 2. Why the Change Is Needed
Stakeholders asked to "track jobs that were done and had to come back to get serviced again because it wasn't done properly the first time." The rework *data* exists (`ServiceOrderRework`, populated by the QC-fail flow) but `reworkRate` was only computed inside historical-import analytics — there was **no live operational view** listing which jobs came back, why, and how often.

## 3. Scope decision (adjusted from the approved roadmap)
The roadmap's CR-C also proposed a "job duration per technician / throughput" report. Exploration confirmed that is **already built and surfaced** — `PerformanceService.getTechnicianPerformance` returns `avgJobMinutes` + per-assignment `durationMinutes`; `getTechnicianEfficiency` has `clockMinutes`; `getAssignmentHistory` has `durationMinutes`; all exposed via `PerformanceController` (`/reports/technician-efficiency`, `/technician-performance/:id`, `/assignment-history`) and shown on the **Admin → Performance** and **Admin → Assignments** pages. Rebuilding would duplicate truth, so **CR-C is scoped to the genuinely-missing Rework/FTF report only.** (Job-duration needs are already met; if a different cut is wanted later it's a separate CR.)

## 4. Files / Modules Impacted
**API**
- `apps/api/src/modules/reporting/reporting.service.ts` — `getReworkReport({ siteId?, from?, to? })` (live scope via `liveVisitWhere()`; summary + rework ledger).
- `apps/api/src/modules/reporting/reporting.controller.ts` — `GET /reports/rework` (`REPORT_VIEW`).
- `apps/api/src/modules/reporting/__tests__/rework-report.spec.ts` *(new)* — 5 tests.

**Web**
- `apps/web/app/(dashboard)/reports/rework/page.tsx` *(new)* — manager-gated; FTF%/rework-rate/reworked/total StatCards + rework ledger table; from/to date filter.
- `apps/web/components/sidebar.tsx` — "Rework / FTF" nav entry (Management, ADMIN/MANAGER).

**Docs**
- `docs/53_CR_2026_031_Rework_Report.md` *(this file)*.

## 5. Rule Impact
**None.** Read-only aggregation over existing `ServiceOrder` / `ServiceOrderRework`. No scheduling/queue/ETA/QC/parts logic changed.

## 6. Schema / API Impact
- **Schema:** none.
- **API:** one new read endpoint `GET /reports/rework?siteId&from&to` → `{ summary: { totalOrders, reworkedOrders, reworkRate, firstTimeFixRate }, items: [{ id, serviceOrderId, reasonCode, description, reworkCount, openedAt, closedAt, customerName, vehiclePlate, primaryTechnician }] }`. No permission changes (`REPORT_VIEW`).
- **Scope:** LIVE only — excludes `HISTORICAL_IMPORT` + test-data via `liveVisitWhere()`. `reworkRate = reworkedOrders / totalOrders`; `firstTimeFixRate = 100 - reworkRate`. Ledger capped at 200 rows, newest first.

## 7. Data Backfill
**Not needed** (read-only).

## 8. Risks
| Risk | Mitigation |
| --- | --- |
| Double-counting orders reworked multiple times | `reworkedOrders` uses `distinct serviceOrderId`; the per-order repeat count is shown as `reworkCount` in the ledger. |
| Mixing historical/test data into a live quality metric | `liveVisitWhere()` excludes both; covered by a test asserting the where-clause. |
| Large ledgers | Capped at 200 rows (newest first); summary rates use full counts. |

## 9. Tests / Verification
- **Unit (vitest, 5 tests):** live scope (excludes historical + test data; no site/date by default), siteId + date-window application (end-of-day), rate + FTF math, zero-orders guard, ledger mapping. Full reporting suite (20 tests) green.
- **Typecheck:** `@bsop/api` + `@bsop/web` green.
- **Live booted smoke:** DEFERRED — dev stack intentionally left stopped per the standing "don't restart unless asked" instruction. To run later: open **Reports → Rework / FTF**; the FTF/rework rates + ledger render over current data.

## 10. Proposed Effective Phase
Phase 1/2 (operational reporting). Third CR of Phase A "Quick Wins"; executed one CR at a time.

## 11. Approval Needed?
**Yes** (standard review), but **not** a §9 mandatory trigger — no schema/dependency/rule/auth change. Commit paused; only the 6 files in §4 will be committed, then an annotated checkpoint tag. No push, no remote.
