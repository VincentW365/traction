# CR-2026-044 — Technician Performance: quality metrics + redesign

**Status:** IMPLEMENTED. **Type:** Reporting enhancement (metrics + UI) — owner-directed. Recorded here.
**Author:** Vincent Wilson · **Date:** 2026-06-17

## 1. Request
"For Technician Performance, update the page and explore the app's features and goals to add or improve metrics, layout and quality."

## 2. Gap found
The page measured a single dimension — **labour efficiency** (estimated ÷ actual minutes). The platform already tracks a **quality** signal the page ignored: `ServiceOrderRework` (CR-2026-031), which links a reworked order to its **primary technician**. A technician who is fast but whose jobs come back is not actually performing well — so productivity alone is misleading. Workload mix (primary vs helper) was also not surfaced.

## 3. Change — add quality + workload, keep efficiency
### Backend (`apps/api/src/modules/reporting/performance.service.ts`)
Both `getTechnicianEfficiency` (team list) and `getTechnicianPerformance` (individual) now also return, per technician:
- **`firstTimeFixRate`** — of the jobs the tech was **primary** on, the share that did **not** come back as rework: `(1 − reworkedPrimary / primaryJobs) × 100`. `null` when they led no jobs.
- **`reworkedJobs`** — count of their primary jobs that have ≥1 `ServiceOrderRework`.
- **`primaryJobs` / `helperJobs`** — workload split.
- **`avgJobMinutes`** — added to the list row (was detail-only).
The individual response also flags each assignment with **`reworked: boolean`** so the history can mark jobs that came back.
Implementation: the existing assignment include gains `serviceOrder._count.reworks`; the `where` clauses (and their always-live historical/test-data scope, CR-2026-006/020) are unchanged.

### Frontend
**Team list (`admin/performance/page.tsx`)** — rebuilt:
- KPI strip: Avg Efficiency, **Avg First-Time-Fix**, Jobs Completed, **Jobs Came Back**, Active Techs. Team averages are taken over techs who actually worked / led jobs (idle techs don't skew them).
- Sortable table (Technician, Jobs with primary/helper split, Avg job, Efficiency, **First-time-fix** with a "N came back" sub-line), colour-coded badges, per-row Detail link.
- Quick date presets (Today / 7d / 30d / 90d, default 30d), custom range, and a one-click **Export**. A short legend explains both metrics.

**Individual (`admin/performance/[id]/page.tsx`)** — rebuilt:
- Six stat cards: Efficiency, **First-Time-Fix**, Jobs Completed, Avg Job Time, Total Hours, **Came Back**; a caption shows the primary/helper split.
- Assignment history flags jobs that **came back** for rework; presets + Export added.

## 4. Files
- `apps/api/src/modules/reporting/performance.service.ts` — FTF/rework + workload metrics.
- `apps/api/src/modules/reporting/__tests__/performance.metrics.spec.ts` *(new)* — FTF/rework computation + null-when-no-primary.
- `apps/web/app/(dashboard)/admin/performance/page.tsx` — redesigned team view.
- `apps/web/app/(dashboard)/admin/performance/[id]/page.tsx` — redesigned individual view.
- `docs/66_CR_2026_044_Technician_Performance.md` (this file).

## 5. Verification
- API typecheck green; API `vitest run` green — **64 files / 507 tests** (incl. the new metrics spec 2/2 and the unchanged performance scope spec).
- Web typecheck green; route-smoke green (66/66).
- Metrics derive only from existing data (assignments, order items, `ServiceOrder.reworks`); no schema change, no new endpoints.

## 6. Governance
Reporting read-model enhancement. No schema change, no scheduling/priority rule change, no auth change, no API contract removal (fields added only). Not a §9 trigger. Recorded as a CR for traceability.
