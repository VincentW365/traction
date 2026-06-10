# 29 — Open Follow-ups Register

Tracking loose ends after the customer/vehicle import (baseline tag: `save-point-post-customer-vehicle-import`).
Owner: Vincent Wilson unless noted. Status: **Decision pending** / **Approved** / **Deferred** / **Open**.

---

## 1. Must decide before jobs/visits import

| # | Item | Status | Lean / Proposed approach |
| --- | --- | --- | --- |
| 1.1 | **Fallback for 10 unmatched customers / ~33 jobs** (jobs reference contact Ids absent from the Contact DB). | Decision pending | **Lean:** for those jobs only, attach a **historical-only placeholder** customer+vehicle, clearly flagged as an unresolved source reference (e.g. external ref marked `UNRESOLVED`). Do **not** block the whole jobs import for ~33 rows. |
| 1.2 | **Model/import the dropped contact fields** before layering job history. | ✅ **Approved → CR-2026-004** | **Add all, before jobs import:** `Loyalty No.`→Customer; `Fuel Type`, `Transmission`, `Drivetrain`, `Engine No.`→Vehicle. Additive nullable fields + idempotent backfill of the existing import. **`Engine No.` treated as sensitive** (authenticated-only, no logs, no raw values in dry-run/reports). See `docs/30`. |

## 2. Operational follow-ups before pilot

| # | Item | Status |
| --- | --- | --- |
| 2.1 | Imported vehicles have **null `serviceClass`/`weightClass`** → mobile-jack-blocked (Rule 3 fail-safe) until classified at check-in. Consider back-classification from make/model. | **Backend → CR-2026-008** (`docs/35`, committed): suggestion-assisted, **staff-confirmed** classification + 7,157 PENDING review rows (advisory only; vehicles stay blocked until confirmed; full audit). **Staff UI → CR-2026-009** (`docs/36`): Operations review queue with filter/search/paging, inline confirm + bulk-accept (read-only query enhancement; Rule 3 intact). **Progress reporting → CR-2026-010** (`docs/37`): manager Reports snapshot (remaining unclassified, confirmed-by-class, mobile-jack-eligible, remaining-by-confidence). Backlog clearing is operational and measurable. |
| 2.2 | All imported customers have **notification opt-in = false** → reminders/marketing won't reach them until consent is captured. | Open (by design) |
| 2.3 | **Paused-clock scheduling behavior** (bay hold / ETA / rank while paused) remains deferred (CR-2026-001 follow-up). | Deferred (scheduling). **Staff UI → CR-2026-011** (`docs/38`): pause/resume on Technician "My Work" + pause/resume/rework on Queue detail, over the existing recording-only endpoints. Pause/resume still do **not** affect scheduling/queue — that behavior stays deferred. |
| 2.4 | **Operational metrics & lookups must exclude HISTORICAL_IMPORT visits + placeholder customer/vehicles** (consequence of the 1.1 placeholder approach — they were silently inflating KPIs and surfacing "Historical — Unknown Customer" in search). | ✅ **Resolved → CR-2026-006** — shared `operational-scope` helper; default-exclude with `includeHistorical=true` opt-in on reporting/performance/customers/vehicles; manager-dashboard, schedule, and maintenance mileage are always-live. No schema/scheduling change. See `docs/33`. |
| 2.5 | **Queue board avg-service-minutes** (`queue.service.getAvgServiceMinutes`) aggregates *all* completed site service orders with no status/ticket scope, so HISTORICAL_IMPORT orders are currently included and may skew the figure. It feeds the live **ETA estimate**, so CR-2026-006 intentionally left it unchanged (ETA/queue changes need separate review per CLAUDE.md §9). | ✅ **Implemented → CR-2026-007** (`docs/34`, commit `99f0ef3`). Live orders by default; historical only as an explicit small-sample fallback (30-day window, 20-order threshold). **Deferred follow-ups only:** outlier trimming (`eta_avg_outlier_cap_minutes`) and threshold/window tuning once live volume accrues. |

## 3. Governance / environment follow-ups

| # | Item | Status |
| --- | --- | --- |
| 3.1 | Pre-existing WIP (technicians, maintenance reminders, reporting, staff, availability, NHTSA, web admin, `permissions.ts`, `app.module.ts`) was **risk-reviewed but not line-by-line audited**. | Open |
| 3.2 | **NHTSA VIN-decode should default to STUB** in all non-production environments (currently live-unless-`STUB`; mitigated locally only). | Open |
| 3.3 | **SharePoint extraction is manual + point-in-time** (snapshot 2026-06-09). No automated re-sync. | Open |

## 4. Data-quality follow-ups

| # | Item | Status |
| --- | --- | --- |
| 4.1 | 474 imported vehicles have **no VIN** (385 missing in source + 89 duplicate-nulled). | Open (acceptable) |
| 4.2 | **Name parsing** is best-effort; companies/joint owners kept whole in `lastName`, raw name retained in customer `notes`. | Open (acceptable) |
| 4.3 | Historical **mileage** values in the job sheet are unreliable (some > 400,000); relevant when jobs are imported. | Open |

---

> Next action: await approval of this register, then start the jobs/visits import CR. Items 1.1 and 1.2 should be resolved in/with that CR.
