# CR-2026-079 — Service Centre Operations Display + Inspection Records UX

> **Umbrella planning doc.** Governs three initiatives, each shipped as its own CR:
> **CR-2026-079** (Customer Display) · **CR-2026-080** (Dispatch Board) · **CR-2026-081** (Inspection records).
> On approval this is saved verbatim to `docs/100_CR_2026_079_Operations_Display_Inspection_Records_UX.md`.
>
> **Numbering note:** the requested working title "CR-2026-035 / docs/58" is already taken by the
> Assignment Recommender (`docs/58_CR_2026_035_Assignment_Recommender.md`). Corrected to the next free
> identifiers: **CR-2026-079…081**, doc **100**.

## Problem statement
Three operational surfaces need improvement:
1. **Dispatch Board** is a passive resource display; it can't show who's working a bay, technician load,
   blocked/stale work, or unassigned work — so it's weak for real-time control.
2. **Customer Display** (`/display/:token`) is functional and PII-safe but plain; it should look premium
   and service-centre-themed on a lobby TV.
3. **Inspections** have no active-vs-history split (the tab shows every status), no per-customer archive,
   and no date/search filtering — completed inspections clutter the worklist and aren't easy to find later.

## Guardrails (apply to all phases)
No scheduling/ranking/ETA-engine changes · no auto-assignment (recommend + confirm only) · no customer
PII on the public display · no new deps unless justified · no destructive data changes · additive schema
only (one migration in Phase 3, adds nullable columns) · one CR at a time, verify → commit named files →
tag → push.

---

## Current-state audit (established by 3 read-only Explore passes)

### A. Dispatch Board
- UI `apps/web/app/(dashboard)/dispatch/page.tsx` — resource cards grouped BAY/OVERFLOW/LIGHT_SLOT
  (POWER_WASH/EXTERNAL dropped); stat cards Available/Occupied/Reserved; Call-Next, Release, up/down.
- Read-model `resources.service.ts::getDispatchBoard` → per WorkResource: status, capabilities,
  `currentJob {ticket, customer, vehicle, startedAt, expectedEndAt}` or `nextReservation`.
- **Central problem — two disconnected systems:** the board uses **System A** (`WorkResource` +
  `ResourceOccupancy`); job execution uses **System B** (`WorkBay` + `TechnicianAssignment` on the
  ServiceOrder). `ResourceOccupancy.technicianId`/`serviceOrderId` columns exist but call-next never
  populates them, so **the board can't show the technician, service, parts/blocked, or aging today.**
- Reusable endpoints: `/manager/alerts` (OVERDUE_JOB >2h, READY_FOR_QC, BLOCKED_PARTS, ABSENT_TECH),
  `/queue/board` (WAITING tickets + `partsReadiness` + `blockedReason` + `serviceDescription`),
  `/technicians/recommended/:orderId` (per-order ranked techs w/ load+score), resource actions.
- Missing (needs new read-models): site-wide **technician load**, unified **blocked/stale** panel,
  order-level **unassigned work**, and an **enriched board** (tech/service/parts/aging per resource).
- Gotchas: inconsistent assignment-status vocab (`ASSIGNED/IN_PROGRESS` vs `ASSIGNED/ACTIVE`); dispatch
  role check is `ADMIN`/`SERVICE_ADVISOR`; `WorkResource.showOnDispatchBoard` exists but is ignored.

### B. Customer Display
- `apps/web/app/display/[token]/page.tsx` (dark slate board, 3 columns) · payload from
  `queue.service.ts::getPublicDisplayBoard` = `{siteId, siteName, generatedAt, totalInQueue,
  inQueue[{ticketNumber, position}], inService[{ticketNumber, bay}], ready[{ticketNumber}]}` — **PII-free
  confirmed** (ticket numbers, positions, bay label, site name only).
- Live via socket `queue:updated` + 10s poll. `brand-mark.png` exists. Tailwind v4 (CSS config), no
  `next/font` yet; external assets allowed (normal route). `totalInQueue` is returned but **unused**
  (UI recomputes a smaller denominator). Site `timezone` is **not** in the payload (clock uses browser TZ).

### C. Inspections
- Model `VehicleInspection`: status `DRAFT → COMPLETED → SIGNED_OFF → CLOSED` (+`CANCELLED`); dates only
  `createdAt`, `signedOffAt`, `customerAckAt`, `updatedAt` — **no `completedAt`/`closedAt`**. Indexes
  include `@@index([customerId])` (unused by any endpoint).
- API `GET /inspections` filters **only** `siteId`, `serviceVisitId`, `status` — no `customerId`, no date,
  no search; returns **all** statuses. Immutability solid (DRAFT-only edits, write-once signatures,
  `INSPECTION_*` audit actions + StatusHistory). Print view exists (`[id]/print`).
- Active tab `inspections/page.tsx` = flat all-statuses table, one status `<select>`, no date/search,
  no active/history split. Customer profile has **no** inspection section.
- These asks are **not** in CR-2026-034's scope → genuine follow-up (CR-2026-081).

---

## Phase 1 — CR-2026-079: Customer Display redesign (dark premium)  — web-first
**Design:** elevate the existing dark board into a premium service-centre display.
- **Header:** brand mark + "Bert's Service Centre" / "Live Service Queue", right-aligned **date + time**
  and a Live pulse. Subtle automotive motif (gear/wrench accent, tasteful — not childish).
- **Three status lanes:** In Queue · In Service · Ready — larger type, stronger spacing, service icon per
  lane, coloured accents (blue/amber/emerald) on deep navy/graphite.
- **Cards:** big ticket number; **"Position #N of M"** using the payload's real `totalInQueue`
  (not the recomputed denominator); simple status badge; bay label on In-Service (customer-safe); **no
  time/ETA**. Ready lane keeps the highlighted ✓ style.
- **Footer:** "Please listen for your ticket number" + optional simple rotating service tip (static text
  array, no data) — Phase 4 if it risks clutter.
- **TV/responsive:** fluid type (`clamp`) for 1080p→4K, landscape-first, per-lane overflow scroll,
  optional `next/font` for a crisper display face. Keep socket + 10s poll.
- **Backend (small, optional):** add `timezone` to the display payload so the header clock/date is
  **site-anchored** (currently browser TZ). Reuse `totalInQueue` already returned.
- **Files:** `apps/web/app/display/[token]/page.tsx` (redesign), maybe a small `display/` subcomponent;
  `queue.service.ts::getPublicDisplayBoard` (+`timezone`, +expose `totalInQueue` to the typed client).
- **Privacy:** consumes only existing PII-free fields; **add no new selects** that could leak names/plates.

## Phase 2 — CR-2026-080: Dispatch Board resource-management (read-model + UI, no auto-assign)
**New read-model endpoint (single call, `QUEUE_VIEW`):** `GET /dispatch/overview?siteId=` returning:
- **resources[]** — enriched `getDispatchBoard`: also project the **assigned technician**, **service
  description**, **parts/blocked state**, and an **aging flag** (elapsed vs promised/2h). Honour
  `showOnDispatchBoard`; include POWER_WASH/EXTERNAL.
- **technicianLoad[]** — every active tech with open-assignment **count**, **current job**, **skills**,
  and **idle/busy/absent** (bridge `TechnicianAssignment` + `MechanicDayAvailability`; first **reconcile
  the status vocab** to one set, e.g. `['ASSIGNED','IN_PROGRESS']`).
- **needsDispatch[]** — WAITING/APPROVED work awaiting assignment (from `/queue/board` + APPROVED orders
  with no open assignment).
- **blocked[]** — unified: `WAITING_PARTS`/`PAUSED`/`WAITING_CUSTOMER` orders, open `ServiceOrderPause`,
  `partsReadiness=REQUIRED_NOT_READY`, BLOCKED tickets, open reworks.
- **readyForQc[]** + **overdue[]** — reuse `/manager/alerts` logic (QC orders; started >2h).

**UI** — restructure `dispatch/page.tsx` into clear grouped panels: **Needs Dispatch · In Progress ·
Blocked · Ready/QC · Technician Load · Bay/Resource View**, with operational **filters** (site, service
class, status, technician, resource, blocked/unblocked, priority) and **actions wired to existing
endpoints only**: Call-Next, Release, assign/reassign (recommend-then-confirm via
`/technicians/recommended/:orderId` — **no auto-assign**), pause/resume, mark-waiting-parts, open job,
open customer/vehicle, resource up/down. Aging/stale badges from the read-model.

**Guardrail:** read-model + UI + existing actions only. If a genuinely new action is required it is
proposed here first; nothing bypasses confirmation and nothing touches the ranking/ETA engine.

## Phase 3 — CR-2026-081: Inspection active/history lifecycle + customer archive
**Schema (additive migration — the only migration in this initiative):** add nullable
`completedAt` + `closedAt` to `VehicleInspection`, stamped on the COMPLETE and CLOSE transitions, so date
filtering/records are accurate. Backfill left null for historical rows (fall back to
`signedOffAt`/`customerAckAt`/`createdAt` in reads).
**API — extend `GET /inspections` (reuse the existing list; add to DTO + service):**
- `customerId` filter (index already exists), `dateFrom`/`dateTo` (on a chosen date basis),
  `q` search (inspectionNumber / plate / customer name, staff-auth only), `severity`/`decision`/`signoff`
  filters, and an **`active` shortcut** (status in DRAFT/COMPLETED/SIGNED_OFF; excludes CLOSED/CANCELLED).
  Keep default order newest-first. (Alternative: a thin `/customers/:id/inspections` mirroring
  `getServiceHistory` — but extending the existing list is less surface area.)
**UI:**
- **Active tab** (`inspections/page.tsx`) → default to **active-only** (needs action) with an
  "include completed/closed" toggle; completed/closed drop off the worklist automatically.
- **Inspection History** view/tab → date-grouped, newest first, with the full filter set +
  **day presets** (Today / Yesterday / This week / custom range) for per-day activity.
- **Customer profile** (`customers/[id]/page.tsx`) → new paginated **Inspections** card beside "Visit &
  Service History" (reuse that exact pattern): per row show **date, vehicle, visit ref, status, findings
  summary (immediate/future counts), sign-off status**, linking to the full record.
**Recordkeeping/immutability:** already enforced (DRAFT-only edits, write-once signatures). Keep completed
inspections locked; if post-close amendments are ever needed, do it via an **audited amendment** (new
`INSPECTION_AMENDED` action preserving the original) rather than silent edits — noted as a future rule,
not built now. Reuse the existing print view for Save-as-PDF.

## Phase 4 — optional enhancements (only if approved after 1–3)
Surface "recommended technician" inline on the dispatch assign action (reuse recommender) · rotating
service tips on the display · advanced dispatch filters/saved views · a daily **inspection activity**
mini-dashboard (counts by status/severity per day).

---

## API changes summary
- **New:** `GET /dispatch/overview?siteId=` (Phase 2 read-model; `QUEUE_VIEW`).
- **Extended:** `GET /inspections` DTO+service (+`customerId`,`dateFrom/To`,`q`,`severity`,`decision`,
  `signoff`,`active`) (Phase 3); `getPublicDisplayBoard` (+`timezone`) (Phase 1).
- **Schema (Phase 3 only, additive):** `VehicleInspection.completedAt?`, `closedAt?` + stamps on
  complete/close.
- **No changes** to scheduling/ranking/ETA, assignment auto-logic, or any existing endpoint's behaviour
  beyond additive fields/filters.

## UI changes summary
- Phase 1: `display/[token]/page.tsx` redesign (dark premium, N-of-M, TV-fluid).
- Phase 2: `dispatch/page.tsx` restructured into operational panels + filters + existing actions.
- Phase 3: `inspections/page.tsx` (active default + history), new inspection-history view, customer
  profile inspections card.

## Privacy rules
- Public display consumes only ticket number / position / bay / site name — **no names, phones, plates**.
  No new PII selects. Bay label is a facility name (customer-safe); flag operationally not to name bays
  with PII.
- Inspection search by plate/customer name is **staff-authenticated only** (behind the dashboard guard),
  never on the public display.

## Risks / tradeoffs
- **Two-model bridge (Phase 2)** is the main risk — reconcile `ResourceOccupancy` vs
  `TechnicianAssignment` carefully; prefer a read-only join in the new endpoint over populating
  `occupancy.technicianId` (which would touch the dispatch write path). No engine change.
- Aging/overdue thresholds reuse the existing 2h/promised-time logic — no new ETA math.
- Display redesign is low-risk (web-first); the only backend touch is an additive `timezone` field.
- Phase 3 migration is additive/nullable; historical rows read from fallback dates.

## Tests / verification (per phase)
- **Unit (vitest):** Phase 2 read-model (tech-load counts, blocked unification, aging flag, active-tech
  filter); Phase 3 list filters (customerId/date/search/active shortcut) + complete/close stamping.
- **Typecheck:** `pnpm --filter @bsop/api exec tsc --noEmit` + `--filter @bsop/web`, both green each CR.
- **Web:** `route-smoke` green; manual dark-display render at 1080p/4k landscape.
- **Manual E2E (booted, sandbox, cleaned up):**
  - Display: open `/display/<token>` → premium dark board, correct "#N of M", live socket update, PII-free.
  - Dispatch: panels populate; a job shows its technician + parts/blocked + aging; assign via
    recommend-then-confirm; call-next/release/up-down all work; no auto-assign anywhere.
  - Inspections: completing a visit removes it from the active tab; the record appears under the customer
    profile with its date; history date filters + Today/Yesterday/This-week presets work; completed
    inspections remain locked; print/PDF works.
- Each CR: only named files committed, annotated tag, pushed.

## Deliverable & pause
On approval: save this content to `docs/100_CR_2026_079_Operations_Display_Inspection_Records_UX.md`,
then **pause** and report the file path, a short summary, and `git status --short`. No implementation
until each phase-CR is separately approved.

---

## Implementation record — Phase 1 (CR-2026-079: Customer Display redesign) — **Implemented**
Owner-approved; shipped web-first with one additive backend field.
- **Backend** `queue.service.ts::getPublicDisplayBoard` — added `timezone` (from `Site.timezone`,
  default `America/Jamaica`) to the PII-free payload so the lobby-TV clock/date are **site-anchored**
  rather than device-local. No schema change (`Site.timezone` already exists). `totalInQueue` was already
  returned; it is now consumed by the UI.
- **Frontend** `app/display/[token]/page.tsx` — full premium dark redesign on a navy→graphite gradient
  with a faint gear watermark:
  - Header: brand mark + site name + "Live Service Queue", right-aligned **site-timezone clock + full
    date** and an animated **Live** pulse.
  - Three lanes **In Queue · In Service · Ready**, each with an accent strip, tinted lane icon
    (clock / wrench / check-badge), subtitle, and a count chip (blue / amber / emerald).
  - Cards show a large ticket number; In-Queue shows **"#N of {totalInQueue}"** using the real payload
    denominator (replaces the old client-recomputed `queueRanked`); In-Service shows the bay label
    (customer-safe) with a "Service Bay/Please proceed" caption; Ready keeps the ✓ highlight.
  - **TV-fluid** via `clamp()` typography/spacing (1080p→4K, landscape-first), per-lane overflow scroll.
    Socket (`queue:updated`) + 10s poll retained. No `next/font` added (kept dependency-free).
- **Privacy:** consumes only ticket number / position / bay / site name / timezone — **no new PII
  selects**; still names-, phones-, plates-free (CLAUDE.md §10).
- **Verification:** `@bsop/api` + `@bsop/web` `tsc --noEmit` clean; queue suite **19/19**; web suite
  **74/74** (route-smoke incl.). Manual lobby-TV render deferred to owner sign-off.
- **Files:** `apps/api/src/modules/queue/queue.service.ts`, `apps/web/app/display/[token]/page.tsx`,
  this doc. Committed as `CR-2026-079`, annotated tag, pushed.

Phase 3 (CR-2026-081 Inspections) remains **not started** — it returns for separate approval before
implementation.

---

## Implementation record — Phase 2 (CR-2026-080: Dispatch Board resource-management) — **Implemented**
Owner-approved. Read-model + UI + existing actions only; no auto-assignment, no scheduling/ranking/ETA
change, no schema change.
- **Backend — new read-model** `GET /resources/overview?siteId=` (`QUEUE_VIEW`), method
  `ResourcesService.getDispatchOverview`. A single read-only call that **bridges the two resource systems
  the platform grew** — System A (`WorkResource`/`ResourceOccupancy`, the physical bay board) and System B
  (`ServiceOrder`/`TechnicianAssignment`, job execution) — which share only the `ServiceVisit`. It joins
  them read-side (no writes, no populating `occupancy.technicianId`) and returns, in one payload:
  - `resources[]` — enriched bay cards: **assigned technician** (preferred from the System-B primary
    assignment, falling back to `occupancy.technicianId` via a site-tech name map), **service description**,
    **parts-blocked** flag, and an **aging** flag (elapsed > 2h **or** past `promisedCompletionAt` — reuses
    the manager-dashboard threshold, no new ETA math). Honours `showOnDispatchBoard`; includes all
    categories (POWER_WASH/EXTERNAL no longer dropped).
  - `technicianLoad[]` — every active tech with **open-assignment count**, **current job**, **skills**, and
    a derived **state** (BUSY / ASSIGNED / IDLE / ABSENT). Open assignments use a **vocab-agnostic**
    predicate (`endedAt: null` + non-terminal status) that reconciles the inconsistent
    `ASSIGNED/ACTIVE/IN_PROGRESS` writes across the codebase.
  - `needsDispatch[]` — checked-in WAITING/PENDING_RANK tickets awaiting a bay, with service description +
    parts readiness + wait time.
  - `blocked[]` — unified & deduped by visit: `WAITING_PARTS`/`PAUSED`/`WAITING_CUSTOMER` orders **and**
    BLOCKED tickets.
  - `readyForQc[]` + `overdue[]` — reuse the manager-alerts logic (QC orders; in-flight > 2h).
  - `summary` — counts across all sections. Live-scope filtered (`serviceVisitIsLive()`), excluding
    historical/test rows exactly like the manager dashboard.
- **UI** `app/(dashboard)/dispatch/page.tsx` — rebuilt from a flat resource grid into a **panelized ops
  console**: summary chips (Needs Dispatch · In Service · Blocked · Ready-QC · Overdue · Techs idle/busy);
  a **search + resource-category filter** bar; panels for **Needs Dispatch**, **Technician Load**,
  **Bay & Resource View** (enriched cards with tech/service/parts + an aging highlight), **Blocked**,
  **Ready for QC**, and **Overdue**. Actions are **existing endpoints only** — Call-Next
  (`/queue/call-next`), Release (`/resources/:id/release`), up/down toggle
  (`/resources/:id/operational-status`), and **deep links** to the existing ticket-detail page
  (`/queue/:queueTicketId`) where assignment already lives (recommend-then-confirm). **No inline
  auto-assign** — that (surfacing the recommender inline) stays Phase 4.
- **Verification:** `@bsop/api` + `@bsop/web` `tsc --noEmit` clean; **9** new read-model unit tests
  (showOnDispatchBoard filter, tech bridge, aging, parts-blocked, tech load/state, needs-dispatch, blocked
  dedup, QC/overdue, occupancy fallback); full API suite **577/577**; web **74/74** (route-smoke incl.).
- **Files:** `resources.service.ts`, `resources.controller.ts`,
  `resources/__tests__/dispatch-overview.spec.ts`, `app/(dashboard)/dispatch/page.tsx`, this doc.
  Committed as `CR-2026-080`, annotated tag, pushed.

Phase 3 (CR-2026-081 Inspections) remains **not started** — it returns for separate approval before
implementation.
