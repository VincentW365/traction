# CR-2026-101 — Technician Read-Only Customer Context & Workday View

**Status:** Implemented
**Date:** 2026-09-01

The principle, applied throughout: the technician role is not a restricted
manager interface — it is a purpose-built workspace with LESS administrative
authority and MORE operational visibility. A technician opening the platform
answers immediately: what am I working on, what is next, what does the customer
say is wrong, what has been done to this vehicle before, what am I authorized
to do, and is anything stopping the work.

## The Technician Job Workspace (`/technician/jobs/<orderId>`)

Every job card on My Jobs opens a dedicated workspace backed by one read model,
`GET /service-orders/:id/context` (SERVICE_ORDER_VIEW — read access, no write
path anywhere in the payload):

- **Header**: registration LARGE, vehicle, customer, ticket + visit number,
  status, bay, appointment/walk-in (+ slot time), priority, expected service
  time, mileage in, REWORK banner where applicable (§4/§11/§17).
- **Customer — read only (§1)**: name, account number, phone, email, preferred
  contact derived from the opt-ins, loyalty, service notes. No edit control
  exists; the page states that corrections go through **Report Incorrect
  Information** (a DATA_REPORT note — see below).
- **Vehicle — read only (§3)**: make/model/year, registration, VIN, engine
  number, mileage, fuel/transmission/drivetrain, colour, oil requested, and
  the authoritative Sedan/SUV classification (never re-asked here).
- **Customer concern prominent (§12)**: the appointment's stated reason or the
  walk-in intake note renders as its own banner, never buried — and rides
  every My Jobs card too.
- **Authorized work (§15)**: inspection recommendations with their live
  customer-decision state — Authorization pending / Approved / Declined — with
  the page stating the advisor owns the authorization. No decision endpoint is
  reachable from this screen.
- **Job sheet (§5)**: a prominent VIEW JOB SHEET (with the JS- number) plus the
  current inspection, one tap each.
- **Service history (§6)** via `GET /service-orders/:id/vehicle-history`:
  previous visits for THIS vehicle straight from the job — date, mileage, jobs
  performed, visit notes, came-back-for-rework and waited-for-parts flags, and
  each visit's inspections **always dated** (§7 — an old inspection must never
  read as current) with their findings and recommendation outcomes. Drill-down
  to the full Visit Record (already QUEUE_VIEW-readable).
- **Actions**: Start (with the CR-100 switch guard), Pause/Resume, Finished →
  QC — the technician-owned workflow, nothing else.

## Typed operational notes (§13/§14) — `VisitNote`

New model + endpoints (`GET/POST /service-visits/:id/notes`,
`GET /visit-notes/attention`, `POST /visit-notes/:id/resolve`). Six kinds,
each row carrying author, role and timestamp — never one anonymous blob:
Customer concern · Advisor note · Manager instruction · Technician note ·
Safety concern · Incorrect information (DATA_REPORT).

**Role separation is enforced server-side (§2)**: a technician may record
TECHNICIAN / SAFETY / DATA_REPORT (403 on the rest); an advisor adds
CUSTOMER_CONCERN / ADVISOR (+ safety/data); only a manager writes a MANAGER
instruction. SAFETY and DATA_REPORT always require attention and are audited
(`SAFETY_CONCERN_RAISED` / `DATA_CORRECTION_REPORTED`); a TECHNICIAN note can
request attention explicitly. Resolution (advisor/manager only) records who,
when and what was done — nothing is deleted.

**Report Incorrect Information (§1/§3)** is exactly this DATA_REPORT path: the
technician who notices a wrong phone number or vehicle detail files a report
instead of editing master data, and it surfaces on the dispatch board's
**Needs Attention** panel (with Mark Handled + open-job link), the Control
Center (stat + `NEEDS_ATTENTION` alerts, safety = critical), and the visit
workspace notes card.

## My Jobs workday view (§8–§11)

- **Summary strip (§10)**: Active / Up Next / Waiting / Rework / In QC / Done
  counts plus the technician's REAL labour today from
  `GET /service-orders/mine/workday` — the segment ledger, union-merged, so it
  is physically bounded by the clock. No manager KPIs.
- **Buckets (§8)**: Working Now · Waiting/On Hold · **Rework** (returned jobs,
  own bucket until restarted) · Up Next · Also In Progress · **Awaiting QC** ·
  **Completed Today** (split per the directive).
- **Anticipation (§9/§11)**: rows now carry expected service time (booked
  durations), appointment slot time, walk-in/appointment source, priority,
  vehicle type and the concern; the workspace elapsed timer tints amber when a
  job runs past its expected time. No alarm theatre beyond that.

## Backend enforcement (§2/§19)

- `role-separation.spec.ts` pins the TECHNICIAN permission set: reads +
  technician-owned workflows only — no customer/vehicle create/update (which
  also gates classification confirm), no appointments/check-in/walk-in, no
  order create/update/assign, no queue override/abandon, no config/staff/
  reports/notifications. Advisor/manager keep the administrative side.
- Verified LIVE with hand-built technician requests: PATCH /customers, PATCH
  /vehicles, classification confirm, POST /customers, order edit, assign,
  attention-queue read and note resolution — all 403.
- One real hole found and closed during validation: **resuming** a held job
  reopened labour segments for every assignee — including a technician
  currently on the clock for ANOTHER job, creating overlapping labour.
  `resumeForOrder` now skips any technician with an open segment elsewhere
  (same one-open-segment physics as the CR-100 start guard); they return
  through the explicit switch. Unit-pinned and live-verified.

## §16 parts visibility

No fake statuses: the Parts Request module remains retired (CR-2026-099), so
the workspace shows the real signals that exist — Waiting for Parts state,
the pause ledger interval, and the visit's parts-readiness projection.

## §20 end-to-end validation

Scripted live run (real manager + technician logins), 41 checks, all passing:
the full workday (see both jobs → concern on card → open A → customer/vehicle
read-only → job sheet → history → start → record finding → hold for parts →
switch to B → advisor resumes A with NO segment reopening while B runs → B to
QC → back to A → A to QC → both out of active work) plus the §2 lockdown
matrix and the note-kind gating. Validation records cancelled/abandoned after.

Totals at ship: **1038 API + 143 web tests**, typecheck + production builds
clean, migration `20260901210000` applied with zero drift.
