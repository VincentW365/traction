# CR-2026-100 — Technician Multi-Job Workflow, Pause Approval, Vehicle Classification & KPI/Reports

**Status:** Implemented
**Date:** 2026-09-01

The business rule, verbatim: *a technician can own several pieces of work, but
the platform must accurately distinguish what they are assigned to, what they
are actively working on, what is waiting, and how much actual productive labour
occurred* — and when work stops, staff must see *when, why, who reported it,
who acknowledged it, and how it affected elapsed and productive time.* One set
of operational records feeds the technician screen, the advisor workspace, the
dispatch board, the Control Center, the job sheet and the reports.

## 1. Multiple assigned jobs (§1)

- `GET /service-orders/mine/assignments` now returns EVERY open assignment —
  including `WAITING_PARTS` / `WAITING_CUSTOMER` (which used to make a job
  vanish from the technician's screen) — plus work finished today (QC/closed,
  read-only). Each row carries customer, vehicle + registration, vehicle type,
  visit number, services, priority class, bay, order status, the technician's
  OWN labour time (`myWorkMs`, from their segments), pause state with
  acknowledgement status, and `hasOpenSegment` — whether THIS job is on their
  clock.
- The **My Jobs** screen (renamed from My Work) renders buckets: Working Now ·
  Waiting / On Hold (per-card resume) · Ready to Start · Also In Progress (on
  the job but not on the clock — e.g. after switching away from a shared job) ·
  Finished Today. Every card links **View Job Sheet** →
  `/inspections/job-sheet/<visitId>` (§4); the sheet itself was already
  technician-accessible and shows the work-relevant record.

## 2. No double-counted labour (§2)

The labour ledger (`TechnicianWorkSegment`, CR-2026-090) is the source of
truth; what was missing was a guard across ORDERS: nothing stopped one
technician holding open segments on two jobs at once.

- `startAssignment` now refuses to start job B while the technician has an open
  segment on job A: **409** `ACTIVE_WORK_ELSEWHERE` naming the active job. The
  technician switches explicitly (`holdReasonCode`/`holdNotes`):
  - sole worker on A → A is held through the real pause flow (first-class
    status, measured interval, acknowledgement);
  - colleagues still working A → only this technician's segment closes, with
    the new honest end reason `SWITCHED_JOB`; A stays IN_PROGRESS.
  - Every switch is audited (`WORK_SWITCHED`).
- Reporting merges each technician's intervals (union) before summing — one
  person can never total more labour than the clock (see §12/§15 below).

## 3. Workload-aware dispatch, not one-job-only (§3)

- The assign guard ("has an active assignment on another visit → refuse") is
  now a **workload warning**: the first attempt returns 409
  `TECHNICIAN_HAS_OPEN_WORK` carrying the open jobs (active vs held, tickets,
  plates); `acknowledgeWorkload: true` proceeds and is audited
  (`ASSIGNMENT_WORKLOAD_ACKNOWLEDGED`). Applied to `assign`, `assign-all`, and
  `assign-additional`; same-visit orders remain one job (CR-2026-068).
- The dispatch board's technician cards show the breakdown — `activeJobs`,
  `heldJobs`, and each held job with its reason — and BUSY now means an
  IN_PROGRESS job, not merely "has an assignment": two jobs waiting on parts
  read as ASSIGNED-with-held-work, i.e. available for more.

## 4–9. Pause acknowledgement workflow

`ServiceOrderPause` gained: `technicianId` (whose labour stopped),
`enteredOnBehalf`, `approvalStatus` (PENDING/APPROVED/REJECTED),
`reviewedBy/At/Notes`, `originalStartedAt` + correction fields
(migration `20260901150000`; existing rows backfill as APPROVED history).

- **Effective immediately (§5/§6):** a technician's pause stops the labour
  clock at the moment they press it (`startedAt`, unchanged semantics — every
  existing duration calculation still reads the same field). Approval records
  who acknowledged and when and NEVER moves the clock: paused 10:42, approved
  10:49 ⇒ effective from 10:42. Rejection requires a reason, keeps the original
  request (marked REJECTED, never deleted), and resumes the stopped work — the
  interval closes honestly at rejection time.
- **Attribution:** assigned technician → PENDING; advisor/manager recording it
  → APPROVED immediately, `enteredOnBehalf`, audited
  (`PAUSE_RECORDED_ON_BEHALF`) — it never looks like the technician pressed
  the button (§7). The advisor button is labelled "Pause on behalf".
- **Retroactive correction (§8):** `POST …/pauses/:id/correct-start`
  (SERVICE_ORDER_ASSIGN, i.e. advisor/manager) moves the effective start
  **earlier only** (the recorded press proves work had stopped by then; later
  would fabricate labour). Reason required; the original timestamp is kept on
  the row; the labour segments the pause closed are trimmed through the audited
  segment-correction path; `PAUSE_TIME_CORRECTED` audit with before/after.
- **Visibility (§9):** pending requests surface on the dispatch board (panel
  with Approve / Reject / open-job link), the Control Center (stat +
  `PAUSE_APPROVAL` alerts, click-through to the visit), and the visit
  workspace (banner with Approve / Reject / Adjust start time). Approving or
  rejecting clears them. `GET /service-orders/pause-approvals/pending` backs
  all three.
- **Shared story (§18):** `GET /service-orders/:id/pauses` returns the full
  hold ledger (who reported, who entered it, who acknowledged, effective from
  when, corrections with originals); the visit workspace renders it as "Hold
  details", and the technician card shows the same acknowledgement state.

## 10. Vehicle type is automatic

Classification was already vehicle-authoritative (`Vehicle.serviceClass`,
confirmed once, auto-suggested from make/model, audited via
`VehicleClassification` + AuditLog + StatusHistory) — no per-visit copies
exist, so nothing stale can carry between visits (the KPI snapshot's copy is a
deliberate frozen-terms snapshot at start of work). What was missing:

- the class now FLOWS visibly: technician job cards, the job sheet, and the
  Job Times report all show Sedan/SUV from the vehicle record;
- a wrong class was previously uncorrectable anywhere in the UI — the vehicle
  page now shows **Vehicle Type** with an audited Set/Correct control (the
  existing `POST /vehicles/classification/:vehicleId/confirm`, which accepts
  reclassification and writes the full audit trail).

The one-time classify prompt (floating queue for unclassified vehicles) and
the start-work gate are unchanged.

## 11. Reports/KPI page failure — TWO root causes

**(a) The page-killing 400.** `assertDateRange` (CR-2026-099) shipped with the
regex `/^d{4}-d{2}-d{2}$/` — the backslashes were lost in transit, so it
matched only the literal string "dddd-dd-dd" and **every valid date was
rejected with 400**, which killed all nine `/reports/*` endpoints and the
Reports page with them. No test covered the accept path, which is how it
survived. Fixed (`/^\d{4}-\d{2}-\d{2}$/`) and pinned in both directions by
`report-date-guard.spec.ts` (valid range passes through; garbage, reversed
range and missing siteId still 400).

**(b) The empty "today".** Every report parsed its bounds as
`new Date('YYYY-MM-DD')` (midnight **UTC**) then `end.setHours(23,59,59,999)`
(**local** time). West of UTC that end lands on the PREVIOUS local day, so a
single-day range covered only the first ~5 hours of the working day — caught
by the CR-100 live validation when a job started at 13:30 local was missing
from a same-day report. All nine parse sites (ReportingService,
PerformanceService, JobTimesService) now share `localDayRange()`:
[local 00:00:00.000 → local 23:59:59.999], the calendar day the operator
actually picked. Pinned by test.

Additionally: report pages now print the API's actual error message in their
failure cards, `technician-kpi` no longer renders a failure as "No completed
jobs", and `benchmark-review` no longer renders one as a clean queue.

## 12–17. Job Times report

New `GET /reports/job-times?siteId&startDate&endDate[&technicianId]
[&vehicleClass][&sourceType][&serviceTypeId]` (REPORT_VIEW), backed by
`JobTimesService`. One payload carries BOTH bases, so the on-screen toggle and
the printed report can never disagree (§17 — there is no second reporting
path):

- per job: **elapsed** (startedAt → completedAt wall clock, holds included) ·
  **technician work** (labour segments, per-technician union then summed —
  two people at once IS 2× labour; one person twice is not) · waiting-parts /
  waiting-customer / other-paused breakdown (§13);
- per technician (§15): jobs assigned, jobs completed, **productive time**
  (union of their segments across ALL jobs — physically bounded by the clock),
  held time, elapsed job time;
- summary with averages per completed job in both bases.

The Reports page adds the **Time Basis** toggle (Elapsed | Technician Work —
time-based figures recalculate, non-time KPIs untouched), filters (technician,
Sedan/SUV, appointments/walk-ins), the breakdown tables, and **Print Report**:
browser Print / Save-as-PDF with a print-only letterhead (logo, title, period,
filters, time basis, generated timestamp), app chrome hidden
(`print:hidden` on sidebar/topbar/controls), A4 `@page` rules, rows kept
whole across page breaks. Page numbers come from the browser's print
header/footer. `getWorkTiming` also gained `waitingCustomerMs`/`otherPausedMs`
and the open pause's acknowledgement state.

## 19. Audit

New audited actions: `PAUSE_APPROVED`, `PAUSE_REJECTED`,
`PAUSE_RECORDED_ON_BEHALF`, `PAUSE_TIME_CORRECTED` (before/after),
`WORK_SWITCHED`, `ASSIGNMENT_WORKLOAD_ACKNOWLEDGED` — alongside the existing
assignment/start/resume/completion/classification trails. Segment trims ride
the existing `KPI_WORK_SEGMENT_CORRECTED` audit.

## 20. Regression coverage

- `pause-approval.service.spec.ts` — attribution (own vs on-behalf), approval
  preserves the timestamp (Scenario C), rejection reasoned + resumes + keeps
  the request, correction earlier-only + original kept + segments trimmed +
  audited (Scenario E), on-behalf identification (Scenario D).
- `start-switch.service.spec.ts` — Scenario B: 409 without a hold reason;
  sole-worker hold; colleague case closes only the switcher's segment.
- `job-times.spec.ts` — Scenario G (same job: 2h18m elapsed vs 1h14m work vs
  42m parts + 22m customer) and Scenario H (overlapping segments merge; two
  real technicians still count twice on the job).
- `report-date-guard.spec.ts` — the §11 regression, both directions.
- `assign-multi.service.spec.ts` — workload 409 payload + acknowledged assign
  audited; dispatch-overview spec — held-vs-active breakdown + pending panel.
- Web `cr-2026-100-surfaces.test.ts` — the load-bearing UI surfaces.

Totals at ship: **1022 API + 130 web tests**, typecheck and production builds
clean, migration applied with zero drift.

## Live validation

A scripted end-to-end run against the running stack (real logins:
manager + technician O. Josephs) walked the whole workflow — 44 checks, all
passing: workload 409 → acknowledged assign (audited) · start guard 409 →
switch (B's own gates verified BEFORE holding A — the first run caught a
half-applied switch and the sequencing was fixed) · pause PENDING attributed
to the technician · technician cannot approve (403) · approval preserves the
timestamp · correction earlier-only with original kept + labour segment
trimmed · on-behalf APPROVED + flagged + named · rejection reasoned, kept,
work resumed · My Jobs carries both jobs with class/visit/labour fields ·
dispatch workload breakdown + pause-approvals panel · manager dashboard stat ·
job-times (elapsed > work, parts breakdown, per-technician bounds, filters,
enum guards) · `/reports/kpis` accepts valid dates. All validation
tickets/orders were cancelled and abandoned afterwards — the boards are clean.
