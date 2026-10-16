# CR-2026-123 — A technician's job page: the visit's records, add inspections, finish the job sheet

**Date:** 2026-10-16
**Status:** Implemented, verified locally, committed to `master`
**Requested by:** Product owner — "For the technicians, the job that they are assigned to, they should be able to see the Records and easily add inspections and finish the job sheet."

---

## A. Objective

From the job a technician is assigned to (`/technician/jobs/:orderId`), without leaving it: see every record on the visit, add a pre-inspection or a vehicle inspection in one tap, and finish the job sheet.

## B. What was true before

- Technicians already held every permission this needs: `INSPECTION_VIEW/CREATE/EDIT`, `QUEUE_VIEW` (which reads the visit record and reads/saves the job sheet). Nothing was blocked at the API.
- The job page offered the job sheet as **"VIEW JOB SHEET"** (no state shown) and at most **one** inspection (`inspections[0]`); with none, a grey "No inspection on this visit yet" and **no way to add one**. A technician at the car had to go to the Inspections page and pick their own ticket out of the board picker.
- The job sheet page had Save and Print; getting back to the job after saving was a separate step.

## C. What changed

**Job page — "Records for this visit"** (replaces the two-button grid, inside the action card):
- **Job sheet** with its real state: *START JOB SHEET* (not started) · *FINISH JOB SHEET* ("Saved 10:42 · not signed yet") · *JOB SHEET — SIGNED* (green). Opens with the way back set.
- **Every inspection on the visit** — pre-inspection and vehicle inspection, all of them, newest first — kind, number, state in plain words (In progress / Completed / Signed off / Closed / Skipped / Cancelled), each opening with the way back set.
- **+ PRE-INSPECTION / + VEHICLE INSPECTION** — creates the record against this visit (`POST /inspections {serviceVisitId, kind}`) and opens it. If one of that kind is still in progress the button becomes **CONTINUE …** and opens it instead: a second open copy of the same kind on the same visit is almost always a mistake.
- **Full visit record ›** — the complete visit (timeline, files, every record), with the way back set.

**Job sheet page** — a **Save & Done** button beside Save and Print: saves the draft and returns to wherever the sheet was opened from (the job, for a technician). The sheet itself — layout, fields, labels — is untouched (`forms-are-finished`).

**API** — `GET /service-orders/:id/context` now reports `visit.jobSheet.signed` (an existence check on the draft's signature, not the image itself, because the context is polled every 15 s). `kind` was already in the inspections select.

**Manual** — the technician inspection task now starts from the job; PDF rebuilt.

## D. Assumptions

- **A1.** "Records" means the records of the visit the technician is on: job sheet, inspections, and the visit record. The vehicle's service history was already on the page (collapsible) and stays.
- **A2.** "Finish the job sheet" means fill it in, save it and — when the customer is present — sign it. The sheet has no separate "finished" status; *signed* is the strongest state it has, and that is what the job page shows.
- **A3.** One open inspection per kind per visit is the normal case; a second one can still be started from the Inspections page.

## E. Verification (local, 2026-10-16)

- `pnpm --filter @bsop/web typecheck`, `pnpm --filter @bsop/api typecheck`: clean.
- Service-orders specs: 14 files / 104 tests pass; `job-context.service.spec` now asserts `savedAt` and `signed: false` for a saved, unsigned sheet.
- Live: `GET /service-orders/:id/context` on an open order returns `jobSheet: { savedAt: null, signed: false, jobSheetNumber: "JS-B01-261016-001" }` and `inspections: []`. The technician's create path (`POST /inspections` with `INSPECTION_CREATE`) is the same endpoint the Inspections page uses; no seeded technician had an open assignment locally to drive it end-to-end as that role.

## F. Approval gate

Navigation and presentation around existing, permissioned endpoints; one additive field on a read model. No rule, schema or audit change. Recorded here; no gate in `docs/21` is crossed.
