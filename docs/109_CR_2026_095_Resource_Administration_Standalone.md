# CR-2026-095 — Resources & Bays administration, standalone application

**Status:** Implemented. **Local commit only, not pushed**, per the directive.

The acceptance rule this CR answers: *"we opened Bay 6"*, *"Bay 3 is under
maintenance"*, and *"this bay can now take SUVs"* are handled in **Setup →
Resources & Bays**, take effect immediately in assignment and dispatch, and involve
no developer, no GitHub and no redeployment. Deleting a deactivated staff member
who never worked a job is handled the same way, from the Staff Directory.

---

## 1. Implementation finding (before changes)

- **`WorkResource` was already the database-backed model** — structured fields
  (category, lift type, equipment flags, dispatch visibility, display order),
  occupancy, reservations, and a CR-2026-065 boolean up/down toggle. The dispatch
  board already read it live. Nothing about resources was hard-coded in application
  logic.
- **What came from seed:** the initial 6 bays and 10 resources — via
  create-if-missing, so deployment already preserved admin edits (§34 was
  satisfied before this CR; verified and documented rather than rebuilt).
- **What previously required a developer:** everything beyond an active flag.
  Creating a resource took an untyped API call nobody had UI for; there was no
  graded status, no retirement, no vehicle-class compatibility, no validation, no
  impact warnings, no concurrency protection, no change history view.
- **`WorkBay` is legacy** — a thin parallel model still referenced by
  `TechnicianAssignment.bayId` alongside `resourceId`. Left functioning; no new
  capability was built on it.
- **Integrations were placeholder**: an API module with two endpoints nothing
  called, four stub adapter files for Automate and Sage, and an admin page
  advertising "External system connectivity" and "Last Sync" for synchronisation
  that never existed. No environment variables, no jobs, no runtime dependency.
- **Technicians** had deactivate/reactivate but no deletion of any kind.

## 2. What is now application-managed

| Change | Where | Effect |
|---|---|---|
| Add a bay/resource | Add Resource (validated: unique code per site, name, type from the supported set, capacity ≥ 1, at least one vehicle class) | Schedulable the moment it saves |
| Edit configuration | Edit drawer — name, code, classes, capabilities, capacity, scheduling, dispatch visibility, order, notes | Live immediately |
| Sedan/SUV compatibility | Structured `supportsSedan`/`supportsSuv`, never inferred from names | Assignment refuses incompatible vehicles by name and reason |
| Graded status | Set Status: Available / Temporarily Unavailable / Maintenance / Out of Service, with reason + expected return | Non-available resources refuse new work, stating why and when back |
| Retirement | Retire (reason required; blocked while occupied or booked) | Permanent; keeps every historical record; hidden from active screens |
| Reactivation | Explicit, audited | Returns Available |
| Deletion | Only a never-referenced resource | A typo'd creation can go; anything used must retire |
| Change history | History drawer per resource | Who put Bay 2 out of service yesterday, without developers |
| Concurrency | `expectedUpdatedAt` check | A stale save is refused with "changed by another user", never silently merged |
| Staff deletion | Staff Directory → Delete (INACTIVE only) | Removes never-used accounts entirely; anyone with recorded work or audited actions stays deactivated, with the blocking references named |

Resource **types** stay controlled system configuration (the five the application
has logic for); administrators create **instances** freely — "Mobile Jack 2" is a
row, not a code change. The mobile-jack DMAIC safety rule is untouched and pinned
by test: `supportsSuv` on a jack does not bypass it — only the audited manager
override does.

Historical KPI records are unaffected by any of this: snapshots were already
frozen at capture (CR-2026-088), and renames resolve through IDs.

## 3. Standalone conversion

Removed: the `IntegrationModule` (external-ref controller/service + 4 Automate/Sage
stub adapters), the Admin → Integrations page, its navigation entry, and the
route-inventory rows for it. Verified by test: no integrations module, no
registration, no page, no nav, no external-system environment variables.

Retained deliberately: **`ExternalSystemRef`** — it is the customer-import batch
audit trail (the thing `customers:verify` proves imports with), internal to the
application; and the notification provider abstraction (Twilio/SendGrid are the
platform's own outbound channels, stubbed by default, not business-system
integrations).

**Source-of-truth policy:** during the standalone phase, the Service Centre
application database is the authoritative operational data source for everything
created and maintained in the application — customers, vehicles, appointments,
queue tickets, work orders, resources, bays, inspections, KPI configuration and
operational configuration. Nothing is overwritten by any synchronisation process,
because none exists.

**Operational vs deployment configuration:** bays, resources, statuses,
capabilities, compatibility, KPI mappings and inspection templates are managed in
the application. Database connections, secrets, provider credentials and
infrastructure addresses remain environment configuration — deliberately not
editable from a screen.

## 4. Seed rules (§34)

Resources and bays were already create-if-missing. The one violation found was the
**technician roster**: `upsert` by email would have resurrected a deleted
technician on the next deploy. The roster is now seeded **only while the
technician table is empty** (first install); on later runs, existing technicians
still receive additive skill top-ups, and deleted ones stay deleted. Core system
logins (admin, advisor) remain always-ensured — they are infrastructure, not staff
decisions.

## 5. Migration

`20260822100000_cr_2026_095_resource_administration` — fully additive:
`ResourceOperationalState` enum; compatibility/scheduling/retirement columns on
`work_resources` (defaults preserve existing behaviour); graded `status` +
`expected_return_at` on `resource_operational_status`, with existing "down" rows
mapped to `TEMPORARILY_UNAVAILABLE` and existing mobile/power jacks stamped
sedan-only to match the standing rule. No IDs changed, no rows deleted.

## 6. Tests

40 new: 15 admin-service (validation, retired-code reuse refusal, audit diffs,
stale-edit conflict, status reasons, retirement guards, delete guards, overview
counts), 11 assignment-eligibility (maintenance/retired/deactivated/unscheduled
refusals with reasons, sedan/SUV both directions, mobile-jack rule pinned against
the capability checkbox, override audited), 7 staff-removal (active refusal,
history refusals naming counts, QC block, FK fallback, clean delete), 6 standalone
(module/page/nav/env absence, ExternalSystemRef presence), plus the pre-existing
mobile-jack spec updated to the new fixture shape.
