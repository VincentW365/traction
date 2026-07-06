# CR-2026-074 — Notify managers/admins when a job is ready for QC

**Status:** Implemented.
**Requested by:** Vincent Wilson — "when the tech says a job is ready it should notify manager and admins in the system that the technician is finished and is ready for QC."

## A. Objective
When a technician finishes and hands a job to QC (CR-2026-073), managers/admins should be notified
in-system.

## B. Change
Added a **`READY_FOR_QC`** alert to the Manager Control Center alerts feed
(`reporting/manager-dashboard.service.ts` `getAlerts`). It's a **derived** alert — on each poll it
finds live-visit `ServiceOrder`s in status `QC` and pushes an alert with the ticket + customer +
vehicle (`entityId` = order id). This matches the existing alert pattern (overdue / blocked-parts /
absent-tech): no new schema, socket, or push plumbing.

The Manager dashboard already renders any alert type generically, so **"Ready for QC — <ticket>"**
appears automatically (amber, `warning`) and refreshes on the alerts poll (~30s). The
`DashboardAlert.type` union gained `READY_FOR_QC`.

## C. Flow (end to end)
Technician taps **Ready for QC** (CR-2026-073) → order `IN_PROGRESS → QC` → the manager's Control
Center shows a **Ready for QC** alert → manager reviews and moves it on (Ready to Invoice / Rework).

## D. Impacted files
- API: `apps/api/src/modules/reporting/manager-dashboard.service.ts` (type + one query block). No web
  change (generic alert rendering); no schema change.

## E. Tests / validation
- New `__tests__/manager-alerts-qc.spec.ts`: a QC order yields a `READY_FOR_QC` alert with ticket +
  customer; none when nothing is in QC. Full API suite — **563 passed**; both apps typecheck green.

## F. Approval gate
Additive derived alert; no schema/RBAC change (feed already `REPORT_VIEW`-gated) → **not a §9
trigger**. Recorded as a Change Request; reversible via git.
