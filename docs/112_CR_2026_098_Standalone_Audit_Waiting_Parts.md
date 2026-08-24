# CR-2026-098 — Standalone Audit, Technician Workflow & Waiting for Parts

**Status:** Implemented and pushed
**Date:** 2026-08-24

---

## 1. Waiting for Parts as a measured operational state

`WAITING_PARTS` was already a first-class `ServiceOrderStatus` (correct — parts
blocking has scheduling-eligibility semantics), but three things were missing:

1. **Technicians could not report it.** The pause menu had no parts option and
   the technician screen said "the front desk will release this". Parts arrive
   at the bench; the technician is the first to know — both directions now
   belong to them.
2. **Intervals were never measured.** Entering/leaving WAITING_PARTS only wrote
   StatusHistory rows; nothing recorded a duration.
3. **The dashboard metric didn't come from the state.** The tile pair was
   "Blocked Orders" (the right query under a wrong name) and "Parts Pending"
   (a count of parts-request rows no UI flow ever creates — permanently zero).

### The mechanism now

- `PauseReason` gains `WAITING_PARTS` (+ `FURTHER_DIAGNOSIS`); migration
  `20260824230000_cr_2026_098_waiting_parts_ledger`.
- **Trigger:** technician (or advisor) picks *Waiting for parts* in the pause
  menu → `pause()` routes it through the status machine to the first-class
  `WAITING_PARTS` status — never a generic PAUSED the parts views can't see.
- **Storage:** entering WAITING_PARTS/WAITING_CUSTOMER opens a row in the
  existing append-only `service_order_pauses` ledger (reason, actor, optional
  note) and stops every open labour segment. The visit syncs to WAITING_PARTS
  and the queue ticket stays in step (pre-existing sync).
- **Resume:** one Resume gesture regardless of how work stopped —
  `resume()` handles PAUSED *and* the waiting states, closes the open interval
  (`endedAt`, `resumedByUserId`), restarts labour segments, returns the visit
  to IN_SERVICE.
- **Duration:** `endedAt − startedAt` per interval; multiple periods on one job
  sum. `getWorkTiming` now returns `waitingPartsMs` (parts share) alongside
  `pausedMs`, plus the open interval's reason and note.
- **Cancellation closes open intervals** — fixed a real pre-existing bug where a
  job cancelled mid-pause kept an open interval accruing "paused time" forever.
- **KPI:** Control Center `waitingParts` = count of orders in WAITING_PARTS on
  live visits (traceable to records); `pausedJobs` = orders in PAUSED. A
  WAITING_PARTS alert lists each waiting job with its live wait minutes and
  links to the visit. Rework does not duplicate waiting time (rework re-opens
  via APPROVED; old intervals stay closed).
- **History:** the visit Activity timeline shows every stop/resume with reason,
  note, and measured minutes; it survives visit completion.

## 2. Technician workflow

Pause reasons reviewed against what actually stops work in this shop
(most-common first): Waiting for parts · Waiting for authorization · Waiting
for technician assistance · Waiting for bay / equipment · Needs further
diagnosis (new) · At external machine shop · Break / end of day · Other.
"Rework required" is deliberately NOT a pause reason — rework is the QC-failure
flow and re-opens work through APPROVED. "Safety issue" folds into Other with a
note (rare in a quick-service shop; a tight list beats a long one).

Every pause takes an **optional short note** (hinted, not forced, for Other).
The note lands in the ledger, the status history, and the visit timeline where
manager/advisor can read it.

Technician screen ("My Work"): the waiting banner now shows the reason, since
when, a live waiting clock, and the note; the resume button reads "PARTS
ARRIVED — RESUME". An ordinary pause shows its reason and start time too.

## 3. State-machine audit

`VALID_TRANSITIONS` was already sound (no Completed+Paused, no double-active
pause, QC self-approval guarded, rework → APPROVED so nobody resumes an
unassigned job). Verified by test and by live E2E: pause-after-QC → 400,
double WAITING_PARTS → 400, cancel closes intervals, control job that never
pauses flows start→QC→close with zero paused time. WAITING_CUSTOMER retains
its distinct meaning (car parked pending customer decision) vs. the
CUSTOMER_AUTHORIZATION short pause (advisor on the phone) — both are now
interval-measured.

## 4. Standalone cleanup

CR-2026-095 removed the integrations UI; this CR removed the last trace: the
dead `INTEGRATION_ERROR` alert type (no generator ever produced it). The
repurposed-internal `IntegrationSystem.TEST_DATA_RUN` tag, the notification
provider adapters (the app's own SMS/email), and VIN decode remain — they are
the platform's own operation, not external-platform coupling. `PosReference`
remains as dormant schema (no UI, no flows) — removal would be a core-entity
schema change with no operational payoff.

## 5. Terminology

One vocabulary for the condition everywhere: **Waiting for Parts** (status
badge, pause option, dashboard tile, alert, timeline, technician banner).
The old strings ("Wait Parts", "Blocked Orders", "Parts Pending",
"Waiting on parts") are gone.

## 6. Audit results (2026-08-24)

- **Route sweep** as Manager (28 routes), Advisor (9), Technician (3): zero
  runtime errors, zero error boundaries. `/transport` (archived page) and bare
  `/vehicles` have no index route by design and are not linked anywhere.
- **Permission probes** against the API (not hidden buttons): technician denied
  template editing, notification send, resource creation, customer update,
  manager dashboard, staff, business rules, audit logs, reports (all 403);
  technician allowed own assignments and search; anonymous 401 everywhere.
- **KPI reconciliation:** dashboard `waitingParts` tile == alert count ==
  underlying WAITING_PARTS orders (verified live at 1/1/1, and 0 after resume).
- **E2E critical workflow** (real API): advisor walk-in → approve → assign
  (skill gate verified: a non-LUBE technician is correctly refused) → start →
  pause Waiting-for-Parts w/ note → dashboard + alert show it → double-pause
  refused → resume → QC → pause-after-QC refused → manager (not tech) passes
  QC → close → timeline retains the delay with duration. Control job without a
  pause is unaffected.

## 6b. CR-2026-098b — verification round (2026-08-24, post-push)

Five directed verifications on the pushed range surfaced and fixed three real
defects:

1. **Multi-job visits (fixed):** visit and queue-ticket status were last-write-
   wins per order. Live repro: with job A in WAITING_PARTS, job B passing QC
   drove the visit to READY_FOR_PICKUP. Both syncs now derive from ALL of the
   visit's orders (active work > parts block > QC > ready); a rework on one job
   no longer sends an actively-worked car back to the waiting line. Verified
   live end-to-end and pinned by tests. Single-order visits reduce exactly to
   the old mapping.
2. **WAITING_CUSTOMER vs CUSTOMER_AUTHORIZATION (resolved by unification):**
   the pause reason now routes into the first-class WAITING_CUSTOMER state
   exactly like WAITING_PARTS — one operational condition, one representation,
   unambiguous ledger intervals.
3. **Dispatch load (fixed):** the recommender weighed a parts-blocked job like
   active work. Held jobs (WAITING_PARTS/WAITING_CUSTOMER/PAUSED) now carry a
   reduced weight and `available` is driven by ACTIVE assignments only —
   a technician at an idle bench is dispatchable.
4. **Pushed-range audit (b11c3b3..8fe521e, 20 commits, 143 files):** no secrets,
   no real customer data, no tracked data files; all phone numbers in design
   assets are the 876-000-0000 placeholder; binaries are the intentional brand/
   design assets plus the blank job-card PDF (a template, no PII).
5. **Fresh-start smoke from pushed origin/master** (new clone → empty database →
   full migration chain → seed → built API): PASSED end-to-end, and caught a
   genuine boot-breaker — `express` was imported directly by main.ts but never
   declared (a phantom dependency; a truly fresh machine could not start the
   built API). Now declared. Also removed a hard-coded dev-seed site UUID
   fallback in `useSiteId` that would have silently scoped queries to a
   nonexistent site for any siteless user. A healing migration zeroes the four
   long-standing cosmetic schema-drift items so `migrate diff` is clean on
   fresh and existing databases. Guards observed working during the smoke:
   skill gate, bay gate, double-booking gate, technician-only start (admin
   correctly 403), KPI vehicle-class gate.

## 7. Validation

- API tests: **979 passed** (new `waiting-parts.service.spec` covering routing,
  intervals, resume, cancellation closure, illegal transitions, multi-period
  timing math; 2 existing fixtures updated — one had used WAITING_PARTS as a
  cast-through pause reason before it existed).
- Web tests: **110 passed**. Typecheck clean both apps. Production build green.
- Lint: no-op by design in this repo (typecheck is the enforced gate).
