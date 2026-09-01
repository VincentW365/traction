# CR-2026-102 — Technician Navigation, Vehicle Access & Ticket Details UX

**Status:** Implemented
**Date:** 2026-09-01

The governing principle (§9): data visibility, administrative permission and
navigation permission are three different things. A technician needs Vehicle
INFORMATION without Vehicle ADMINISTRATION, and customer CONTEXT without the
Customer DIRECTORY.

## Root cause of the vehicle permission error

Ticket Details linked every role to `/vehicles/:id`, whose page and API read
(`GET /vehicles/:id`) are guarded by `CUSTOMER_SEARCH` — the directory
permission technicians correctly do not hold. The link itself was the bug:
the correct destination for a technician did not exist.

## The technician-safe vehicle view (§1–§3, §10)

- **API**: `GET /vehicles/:id/operational` (QUEUE_VIEW) with a **contextual
  gate** in the service: a TECHNICIAN reads a vehicle only when one of their
  own assignments (any order on any of the vehicle's visits) ties them to it —
  otherwise a plain 403: *"This vehicle is not on your work. Open vehicles
  from your assigned jobs."* Advisors/managers pass through. The payload is a
  read model: vehicle facts (registration, make/model/year, classification,
  VIN, engine no., mileage, fuel/transmission/drivetrain), the customer
  **summary** (name/phone/service notes — no id, no gateway), the current live
  visit (concern, jobs with statuses/technicians/advisor notes, inspections,
  ticket reference) and the vehicle's dated service history (jobs performed,
  rework and waited-for-parts flags, inspection findings + recommendation
  outcomes). Nothing in it is writable.
- **Page**: `/technician/vehicles/[vehicleId]` — registration-first header,
  read-only fields, Current Visit with per-job workspace links, VIEW JOB
  SHEET + INSPECTION one tap each, Service History with always-visible
  inspection dates, and the Notes & Findings card (Report Incorrect
  Information = the CR-101 DATA_REPORT path). No edit control exists anywhere
  on the page — reporting, never editing (§3).

## Navigation corrections (§4, §7, §8, §12)

- **Ticket Details** (`/queue/[id]`): the vehicle link routes technicians to
  the technician-safe view (staff keep the admin record); the customer name is
  **plain text** for technicians and a directory link for staff. Advisor-only
  actions are now role-gated instead of 403 bait: queue Override
  (QUEUE_OVERRIDE), the Completion section (CHECKIN_PERFORM), and the whole
  Customer Communication card (NOTIFY_SEND). No-Show/Abandon was already
  role-gated.
- **Visit Record** (`/visits/[id]`): same adaptation — technician-safe vehicle
  link, customer as plain text.
- **Global search**: for technicians, customer rows are not shown at all
  (their only destination is a 403) and vehicle rows route to the
  technician-safe view. Visits/inspections rows were already safe.
- **Job workspace**: the registration in the header now opens the vehicle view.
- **Graceful direct access (§12)**: a technician who lands on
  `/vehicles/[id]` gets a clean card with **Open Vehicle (technician view)**
  for the same vehicle; on `/customers/[id]`, a clean card pointing back to My
  Jobs. Neither page fires the directory read for a technician. The API
  restrictions themselves are unchanged.

## Service Request prominence (§6)

Ticket Details now opens with a **Service Request** card — *Reason for visit*
(the appointment's stated reason or the walk-in intake note, verbatim),
*Requested services* (the server-resolved list) and the appointment slot —
before any administration. The Job Workspace already led with the concern
banner + services + advisor note (CR-2026-101); the two now tell one story.

## Permission architecture (§11)

Unchanged in shape, extended in coverage: technicians keep read/workflow
permissions only; the new vehicle read is CONTEXTUAL, not directory
(`CUSTOMER_SEARCH`, `VEHICLE_UPDATE` and friends remain advisor/manager).
Live-verified as technician: admin vehicle read 403, customer read 403,
vehicle directory search 403, vehicle PATCH 403, classification confirm 403,
customer PATCH 403 — while the operational view, ticket, job sheet,
inspections, vehicle history and Visit Record all return 200.

## Navigation audit findings (§8)

Dead ends found and fixed for technicians: Ticket Details vehicle + customer
links (the reported bug), Visit Record vehicle + customer links, global-search
customer rows and vehicle-row targets, queue Override button, Completion
section, Customer Communication card. Verified safe: job-sheet links, Visit
Record link, inspection links, queue board rows, My Jobs / workspace links,
sidebar (already role-filtered), home launcher tiles (already role-filtered).

## Validation

`technician-vehicle-view.spec` (contextual gate: assigned 200 / unassigned 403
/ no-record 403 / advisor pass-through; read-model shape) + web surface specs
(`cr-2026-102-surfaces`) + route inventory. **1043 API + 156 web tests**,
typecheck and production builds clean. §15 live flow (real technician login):
23/23 checks passed; validation records cancelled and abandoned afterwards.
