# CR-2026-104 — Professional KPI Reporting: the Service Center Performance Report

**Status:** Implemented
**Date:** 2026-09-02

## A. Report design

One shared reporting model (§25): `GET /reports/performance-report` composes
the already-verified engines — `getKpis` (throughput + queue wait),
`JobTimesService` (elapsed vs technician-work from the merged labour ledger,
with the hold breakdown), `getReworkReport` (quality) — and adds visit-flow
counts, daily trend buckets and explicit-threshold attention items. Screen,
print and CSV all render this single payload; there is no second business-
logic path to disagree with.

The `/reports` page is restructured into two areas (§34): a sticky, never-
printed **Report Controls** toolbar (presets Today/Yesterday/This Week/Last
Week/This Month/Last Month + custom range, technician / vehicle-type /
source / service filters, Time Basis toggle, Compare-previous-period, Reset
Filters, Export CSV, **Print Report**) and the **report document** itself:

1. Letterhead (logo, title, period + length, compare period, time basis,
   active filters, generated at/by) — printed and on-screen identically.
2. **Executive Summary** — eight KPI cards with comparison deltas + the
   deterministic Performance Summary paragraph (§4; the "largest source of
   delay" sentence appears only when delay data supports it).
3. **Service Time** — Average/Median/Maximum × Elapsed/Technician-Work (§5/§6).
4. **Operational Flow** — Arrivals → Jobs Started → Completed → Visits Closed
   → Ready for Pickup, with appointments/walk-ins/missed/cancelled (§7).
5. **Appointments vs Walk-Ins** (§8) and **Vehicle Type Analysis** (§9,
   Unclassified shown, never dropped).
6. **Operational Delays** (§12) with the Waiting-for-Parts drill (§13).
7. **Trends** (§17, ranges > 1 day): jobs/day + avg-time/day (basis-aware) +
   arrivals/day + parts-delay/day — plain SVG line/bar charts, grayscale-safe.
8. **Technician Performance** (§10) with per-technician job drill-down to the
   Visit Record (§11 — screen-side, so print stays compact).
9. **Service Type Performance — Target vs Actual** (§15/§16, single-service
   jobs vs the booked catalogue time; multi-service jobs counted separately,
   never split dishonestly) and **Quality — QC & Rework** (§14).
10. **Items Requiring Attention** (§18) — every item states its threshold.
11. **Metric Definitions** appendix (§26) + print footer (§23:
    generated/by · "Internal Management Use"; page numbers via the browser).

## B. KPI definitions (source records)

- **Vehicles Serviced** — distinct `serviceVisitId` among jobs started in the
  period (several jobs on one car count once).
- **Jobs Started / Completed** — service orders with `startedAt` in the period
  (non-cancelled, live visits); completed = those with `completedAt` (first
  submit to QC).
- **Elapsed** — `startedAt → completedAt` wall clock, holds included.
- **Technician Work** — union-merged `TechnicianWorkSegment` intervals.
- **Waiting for Parts/Customer/Other** — sums of `ServiceOrderPause` intervals
  by reason on those jobs.
- **Rework Rate / First-Time Fix** — `getReworkReport` over `ServiceOrderRework`.
- **Arrivals / Appointments / Walk-Ins / Avg Wait / Missed / No-Show** — the
  existing KPI engine (KPI-01/02/03/05/06/08 from check-ins + status history).
- **Target** — booked `ServiceType.baseDurationMinutes`, labelled as such.

## C. Time measurement

Elapsed and Technician Work are ALWAYS both in the payload and never renamed
into each other. The Time Basis selector chooses which figure leads
basis-dependent displays (avg-service-time card, trend line, service-variance
column); counts and volumes never change with the basis (§35). The selected
basis is printed in the report header.

## D. Comparison logic

`compare=true` recomputes the summary engines over the previous period of
equal length ending the day before the range. Each compared KPI carries
`{value, prev, diff, pct}` — and `pct` is **null when the previous value is
zero** (the diff carries the story; no misleading percentages). The compare
window is printed in the header.

## E. Print / PDF

**Print Report** swaps `document.title` to the §32 name
(`Berts-Service-Center-Performance-<start>_to_<end>`, or
`…-Technician-Performance-…` when technician-filtered) so Save-as-PDF names
the file, prints, then restores. The controls toolbar and drill-downs are
`print:hidden`; the letterhead + footer print; major section groups take
`break-before: page` (Exec Summary / Operational / Delays / Technicians /
Service+Quality ≈ the §24 5-page default) and cards/tables/charts carry
`break-inside: avoid`; the existing A4 `@page` rules and row-keeping CSS from
CR-2026-100 apply. Charts are stroke-based SVG and survive grayscale.

## F. Data reconciliation (live-verified, §36)

Against the real dev dataset (Aug 1 – Sep 2): jobsStarted 12 = job-times rows
12; jobsCompleted 12 = 12; waiting-for-parts total 97,544 ms = the pause-
ledger sum exactly; vehicles 10 = distinct visits (multi-job visits counted
once); three technicians' productive ms identical to the merged ledger;
rework 3.1% = QC records; appointment/walk-in/arrival volumes = the KPI
engine; vehicle-type buckets and source buckets each partition the 12 jobs;
trend buckets sum to 12; elapsed ≥ technician work. The live run also caught
and fixed a real partition bug: `UNKNOWN_REQUIRES_REVIEW` vehicles now land
in the Unclassified bucket instead of vanishing (unit-pinned).

## G. Tests

`performance-report.spec.ts` — 11 reconciliation tests (distinct-vehicle
counting, avg/median/max both bases, delay sums, source/vehicle partitions,
zero-base comparison guard, explicit attention thresholds, empty dataset
without NaN, trend bucketing) + `cr-2026-104-surfaces` web checks (section
hierarchy, one-payload rule, presets/filters/reset, print naming, break
handling, CSV). Totals: **1054 API + 184 web tests**, typecheck + production
builds clean. Live §35/§36 run: **26/26 checks** including Today/custom/empty
ranges, 400 on garbage dates, and technician 403 on the report.

## H. Git

Branch `master`, pushed to `origin/master` (commit in the completion report).

## Addendum — CR-2026-104b: Executive Insights & Exceptions

Core functionality, not an enhancement: the report now opens its Executive
Summary with **Performance Highlights** (up to 4) and **Management Attention**
(up to 4) — deterministic findings computed server-side from the SAME
aggregates as the KPI cards, each carrying the value, the comparison and a
traceable evidence object. The engine states WHAT changed and BY HOW MUCH,
never why.

- **Ranking is business significance, never percentage**: score ≈ minutes of
  impact × jobs/vehicles affected, so a 100% jump from 1 to 2 events cannot
  outrank a 20-minute shift across 40 vehicles (unit-pinned exactly so).
- **Candidates**: service-time movement (avg, with median quoted), queue-wait
  movement, parts-delay frequency+duration movement, waiting-customer load,
  rework movement, throughput movement, appointment-vs-walk-in gap
  (within-period), services materially over booked target (within-period),
  and an operational-exceptions rollup of the attention list.
- **Explicit minimums** (published in the payload as `insightMinimums`):
  e.g. time movement needs ≥5 completed jobs per period AND ≥10% AND ≥5min;
  rework needs ≥2pts on ≥10 orders; delay insights need ≥3 affected jobs or
  ≥2h total. Small samples are suppressed, not dramatized.
- **No comparison → no fabricated movement**: only within-period insights
  (delay load, source gap, over-target, exceptions) appear, and the screen
  hints that Compare unlocks movement insights.
- Live-verified on real data: highlights/attention populated, ranked
  descending by significance, all sentences human-formatted durations.
