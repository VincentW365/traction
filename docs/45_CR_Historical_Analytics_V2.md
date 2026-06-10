# Change Request — Historical Analytics v2

**CR ID:** CR-2026-016
**Author:** Vincent Wilson · **Date:** 2026-06-10
**Status:** IMPLEMENTED (pending review/commit).
**Builds on:** CR-2026-013 (Historical Analytics dashboard).

---

## A. Objective
Practical, low-risk enhancements to the existing Historical Analytics page. No new dashboards, no schema change, no backend change.

## B. Changes
- **Date filters:** already present (from/to inputs wired to the query, CR-2026-013) — confirmed, no change needed.
- **CSV export (NEW):** a "Download CSV" button exports the already-fetched historical summary + tables (span, headline counts/rates, pause/rework rates, avg-duration + sample, monthly volume, technician workload). **Client-side only** — built from the JSON already returned by `GET /reports/historical-analytics`; no new endpoint, no extra query. Filename reflects the active date range.
- **Technician drilldown:** evaluated and **not included** — a true per-technician time-series would require a new backend parameter/query; outside the "low-risk, zero-backend" bound of this pass. (Per-technician totals are already shown in the workload table.)

## C. Guardrails honored
- Historical-only, read-only. No schema migration; no backend/API change; no live-reporting change; no scheduling/queue/ETA/Rule-3 change.
- **No customer PII** in the export — counts + technician (staff) names only. The export is generated in the browser from data the manager already sees.
- Frontend-only: a single page changed (`reports/historical/page.tsx`).

## D. Verification
- `cd apps/web && npx tsc --noEmit` → 0. (API unaffected — no API change.) The underlying `/reports/historical-analytics` endpoint was live-verified in CR-2026-013.

## E. Approval gate
Not a Mandatory Review Trigger: read-only UI enhancement over an existing approved endpoint. Normal feature CR.
