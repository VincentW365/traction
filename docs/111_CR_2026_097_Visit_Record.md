# CR-2026-097 — The Visit as the Authoritative Operational Record

**Status:** Implemented (local commits only)
**Date:** 2026-08-24
**Hierarchy:** Customer → Vehicle → Visit → operational records (job sheet, inspections, photos, services, assignments, queue identity, notifications, audit)

---

## 1. What was already true (verified before building)

The schema was ALREADY visit-centric — this CR did not invent the relationship,
it surfaced and enforced it:

- `VehicleInspection.serviceVisitId` is **required**, and create() derives
  `vehicleId`/`customerId` from the visit server-side (never client-supplied).
  Verified live: **0 mismatched rows** among existing inspections.
- `JobSheetDraft.serviceVisitId` is **unique + required** — orphaned job sheets
  are impossible by construction.
- `ServiceVisit` carries required `customerId` + `vehicleId`.

The duplicated `vehicleId`/`customerId` columns on inspections are kept (query
performance for archives) but are derived-only at write time; `deploy:check` now
verifies the invariant on every deploy and flags any divergence for
administrative review instead of hiding it.

## 2. Visit identity (migration `20260824200000_cr_2026_097_visit_number`)

`ServiceVisit.visitNumber` (unique, immutable once assigned):

- **Ticketed visits** — the ticket reference IS the visit number (`B01-260824-002`).
  One identity per visit, not two competing ones. Set at ticket issue in both
  creation paths (check-in + walk-in).
- **Pre-platform historical imports** (9,055 ticketless visits) — backfilled as
  `V-yymmdd-NNN` in visit-date order. The `V-` prefix cannot collide with
  ticket-based numbers (which start with a location code) and does not pretend a
  number was ever printed for the customer.
- **Job sheets** — 1:1 with the visit, so the number derives: `JS-<visitNumber>`.
  No second sequence to drift.
- Backfill result: **0 unnumbered visits** (verified by deploy:check).

## 3. New surfaces

- **`/visits/[id]` — the Visit Record** (works for live AND historical visits,
  which previously had no page at all): header facts (visit number, status,
  customer, vehicle, plate, check-in, completion), breadcrumbs
  `Customers / <name> / <plate> / Visit <number>`, and five sections:
  Overview (services requested vs performed, timing + work duration, queue &
  team, findings & recommendations, notes behind a disclosure) · Job Sheet ·
  Inspections (summary rows: "Completed 10:18 AM by X · 14 checks · 2
  observations · 6 images" + View) · Photos & Files (grouped by originating
  record, source link preserved) · Activity.
- **Activity timeline** (`GET /visits/:id/timeline`) — merged from EXISTING
  infrastructure only: StatusHistory (visit + orders), QueueEvents (re-rank noise
  dropped), AuditLog, NotificationLog, TechnicianAssignments, inspection/job-sheet
  lifecycle timestamps. No new history mechanism.
- **Consolidated files** (`GET /visits/:id/files`) — photos stay attached to
  their inspection; the group carries the source record and a link to it.
- **Global search** (`GET /search?q=` + topbar box) — name, customer #, phone
  (last-7-digit match), email, plate, VIN, vehicle code, visit/ticket number,
  inspection number, and job-sheet number (`JS-<visit>` resolves to the visit).
  Typed results with owner/date/status context. Sandbox test rows excluded;
  historical visits included — they are the archive.
- **Customer 360** — summary strip (vehicles / visits / last visit / next
  appointment), vehicle cards showing per-vehicle visit count + last service +
  one-click History filter, and the shared Service History table (filters:
  vehicle, status, date range, text, newest/oldest; rows show visit number,
  services, Inspection/Job Sheet availability chips, and Open Visit).
- **Vehicle page** — the same history table pinned to that vehicle.
- **Cross-links** — queue ticket → Visit Record; inspection workspace → Visit
  Record; job sheet → Visit Record (+ its JS- number in the toolbar, without
  altering the faithful paper layout).

## 4. Active queue vs history

The Inspections workspace's default **Active** list now also excludes
inspections whose VISIT is `CLOSED`/`ABANDONED`/`CANCELLED` — a finished visit's
paperwork is history, not work, whatever status it was left in. Nothing is
deleted, copied, or moved: an explicit status filter or the History tab still
reaches every record, as do the Visit Record, customer archive, vehicle history,
and search. The workspace search box additionally matches visit numbers.

**Fixed while here (real scope bug):** the technician assignment-scope and the
free-text search both built top-level `OR` fragments and were merged with
`Object.assign` — a technician who typed anything into the search box silently
escaped their scope. The scope now composes under `AND` and is pinned by test.

## 5. Integrity rules (server-side)

- Walk-in registration refuses a vehicle that does not belong to the customer
  (fails loudly; check-in inherits the appointment's validated pairing).
- Inspection create continues to derive vehicle/customer from the visit.
- `deploy:check` verifies: every visit numbered; no inspection disagrees with
  its visit about vehicle/customer (divergence is FLAGGED, never auto-"fixed").
- Historical records are never deleted or rewritten; the migration is additive.

## 6. Legacy data that could not be confidently linked

1,089 imported visits belong to the **"Historical — Unknown Customer"**
placeholder (their source rows carried `resolution=UNRESOLVED_LINKED` tags from
the CR-2026-094 import). Per the no-fabrication rule they remain on the
placeholder with their provenance in the visit notes — reachable via search and
the Visit Record — rather than being guessed onto real customers. They are the
standing queue for administrative review.

## 7. Tests

- `visits.service.spec` — aggregate (derived timing, JS- number, inspector name
  resolution, ticket-number fallback), timeline (chronological merge, actors,
  re-rank noise dropped), files grouping, number resolution. 7 tests.
- `search.service.spec` — plate/VIN clause shape, visit number, JS- prefix
  stripping, inspection→visit navigation, phone-digit + two-part-name search,
  test-row exclusion, minimum-length guard. 7 tests.
- `inspections-active-scope.spec` — closed-visit exclusion, explicit-status
  passthrough, visit-number search, technician-scope AND-composition. 4 tests.
- Updated fixtures: service-history (filters signature + availability flags),
  customers findById (360 aggregates), walk-in (visitNumber update), inspections
  OR-shape (5 identifiers).

## 8. Unchanged by design

Dispatch, queue ranking, KPI logic, permissions, audit mechanics, inspection
forms, and job-sheet capabilities are untouched; they now participate in the
Visit architecture through links and aggregation only.
