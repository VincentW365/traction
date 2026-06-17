# CR-2026-043 — Unified Reports page (merge Rework/FTF in, retire Historical Analytics)

**Status:** IMPLEMENTED. **Type:** Reporting UI consolidation — owner-directed. Recorded here.
**Author:** Vincent Wilson · **Date:** 2026-06-17

## 1. Request
1. "Remove the Historical Analysis page — no longer needed."
2. "Add the rework/FTF metrics and KPIs to the Reports section so it is no longer a page by itself. Merge them and create the ultimate Reports page with the metrics and a perfect layout and design."

## 2. Change
### New unified `/reports` page (`apps/web/app/(dashboard)/reports/page.tsx`)
One page, one shared date range, three sections:
- **Operations** — the operational KPIs (`GET /reports/kpis`), responsive StatCard grid.
- **Quality — Rework & First-Time-Fix** — the four headline metrics (First-Time-Fix rate, Rework rate, Reworked orders, Total orders) plus the "jobs that came back" detail table, sourced from `GET /reports/rework`. Previously the standalone `/reports/rework` page.
- **More reports** — link cards to the still-standalone **Service Mix** and **Due for Contact** pages.

Layout/UX polish:
- A single date range drives **both** KPI and rework queries, with quick presets (Today / 7d / 30d / 90d) and custom from/to inputs (min/max bounded, local-date based). Defaults to the **last 30 days** so both sections show meaningful data on open.
- One **Export** menu produces a combined document: KPI table + rework summary + rework detail.
- Per-section loading / error / empty states.

### Removed
- **Historical Analytics page** — `apps/web/app/(dashboard)/reports/historical/page.tsx` deleted; sidebar entry removed.
- **Standalone Rework/FTF page** — `apps/web/app/(dashboard)/reports/rework/page.tsx` deleted (content merged into `/reports`); sidebar entry removed.
- Stale `.next/types` for both routes cleared.

### Kept
- `service-mix` and `due-for-contact` remain their own pages + sidebar entries (linked from the hub).
- Backend endpoints are untouched: `/reports/kpis` and `/reports/rework` are consumed by the merged page. `/reports/historical-analytics` now has **no UI consumer** — left in place (dead, harmless); can be removed in a later backend cleanup if desired.

## 3. Files
- `apps/web/app/(dashboard)/reports/page.tsx` — rewritten as the unified page.
- `apps/web/app/(dashboard)/reports/historical/page.tsx` — **deleted**.
- `apps/web/app/(dashboard)/reports/rework/page.tsx` — **deleted**.
- `apps/web/components/sidebar.tsx` — removed Historical Analytics + Rework/FTF nav entries.
- `docs/65_CR_2026_043_Reports_Merge.md` (this file).

## 4. Verification
- Web typecheck green.
- Web route-smoke green (66/66) — `/reports` resolves; removed routes are not referenced.
- No dangling links to `/reports/historical` or `/reports/rework` in the app.
- Built entirely from existing, proven UI components (PageHeader, StatCard, ExportMenu, table styles) for visual consistency.

## 5. Governance
UI consolidation only — no schema change, no business-rule/scheduling change, no auth change, no API contract change. Not a §9 trigger. Recorded as a CR for traceability. Reversible via git (deleted pages recoverable from history).
