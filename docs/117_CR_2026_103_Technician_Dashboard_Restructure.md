# CR-2026-103 — Technician Dashboard Restructure: Statistics Separate From Jobs

**Status:** Implemented
**Date:** 2026-09-01

Presentation-only restructure of the technician dashboard. The multi-job model
underneath (CR-2026-100/101: one open labour segment per person, measured
holds, acknowledged pauses, merged workday time) is untouched — every query,
mutation and bucket predicate survives verbatim (§15).

## Before → after

Before: a `PageHeader`, one dense statistics card, then job buckets whose
cards led with the ticket number and carried three equally-weighted buttons
each (Start/Job Sheet/Open Job) — statistics and work visually intermixed.

After, in fixed scan order (§16/§17 — "current job → next job → blockers →
actions → statistics"):

1. **Technician header** — "Good morning/afternoon/evening, {first name}" +
   date (§3).
2. **My Workday** (§1/§9) — compact left-accent stat cards: Active, Up Next,
   Waiting (with a parts/customer split as supporting text), Rework, QC, Done,
   and **Work Time** (the personal merged-labour clock, with "clock running"
   when a segment is open). No manager KPIs (§11). Cards wrap on small
   screens.
3. **My Jobs** (§2) — its own heading behind a divider, with the §14 filter
   row (All / Active / Up Next / Waiting / Rework / QC / Done), then:
   - **Working Now** — the hero card: emerald header, registration as the
     largest element, concern quote, services + chips, Elapsed/Working timers
     with the over-expected tint, KPI strip, and exactly two action buttons
     (Pause · FINISHED → QC) plus Open Job / View Job Sheet. Shared jobs the
     technician stepped off render beneath as "NOT ON YOUR CLOCK" cards with
     *Back to this job*.
   - **Up Next** — neutral cards, one primary action (**START WORK**), Open
     Job as the secondary link; qualifiers stay answerable on the card
     (CR-2026-092).
   - **Waiting / Held** — amber hold styling, reason + since + waiting time +
     acknowledgement state, primary **RESUME** (§3 — never active-looking).
   - **Rework** — red high-attention cards that now say **why** the job came
     back: `mine/assignments` rows gained `openRework {reasonCode,
     description}` (the only API change), rendered as "QC feedback: …";
     primary **ADDRESS REWORK**.
   - **Awaiting QC** — violet, compact, read-only.
   - **Completed Today** — muted and **collapsed by default** (`<details>`;
     auto-open under the Done filter).

## Job cards (§4/§5/§8)

Registration number is the primary element on every card (large black mono),
vehicle beside it, service second, context as small chips (appointment time /
walk-in, expected duration, priority, vehicle type, bay), the customer concern
as a short quote, a status badge per state (WORKING / UP NEXT / WAITING FOR
PARTS / WAITING FOR CUSTOMER / REWORK / AWAITING QC / DONE), and **one**
primary action per state with Open Job as the single secondary path
(progressive disclosure, §7 — depth lives in the Job Workspace). Job-level
timers stay on the job; the workday clock stays in My Workday (§6).

## Workshop friendliness (§10/§12)

Page width max-w-md → **max-w-2xl** for workshop terminals/tablets; single
column (no forced two-column, §12); large touch targets on primary actions;
useful empty states per §13 ("No job currently active. Select an assigned job
below to begin.", "No jobs currently on hold.", "No rework assigned.",
"Nothing awaiting QC.").

## §18 validation (live, three real technicians)

Scripted against the running stack — **31/31 checks**:
- **A** (o.josephs): 1 active + 2 upcoming + 1 waiting-parts + 1 awaiting QC +
  1 completed today — every count exact, the switch flow (hold for parts →
  start next) works after the restyle, workday clock running and physically
  bounded.
- **B** (m.walker): no active + 4 upcoming — empty Working Now state, all
  other sections empty.
- **C** (o.hamilton): 1 rework (card carries the QC reason + feedback text) +
  2 held + 0 upcoming — clock correctly NOT running.
- For all three: every assignment lands in exactly ONE section, no duplicates,
  held jobs never on the clock, completed work out of the active workload.
  Validation records cancelled/abandoned afterwards (plus two QC-stuck
  stragglers from the CR-101 run tidied via ticket completion).

Totals at ship: **1043 API + 169 web tests** (new `cr-2026-103-surfaces`
pinning the section order, registration-first cards, one-primary-action rule,
empty states, filter and collapsed Done list), typecheck + production builds
clean. No schema changes.
