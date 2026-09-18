# CR-2026-111d — Cross-functional operational regression audit

**Status:** PASS — no regression found
**Date:** 2026-09-18
**Question:** did the customer-booking, resource-capacity, duration, catalogue and Job Sheet changes (CR-2026-108 → 111c) break or alter the existing technician, dispatch or job-management workflows?
**Answer:** No. Every operational area passes. One correctness gap in recently-added code was found and fixed; one pre-existing labelling ambiguity was observed and left unchanged.

---

## 1. How the audit was run

Three layers, because each catches what the others cannot:

| Layer | What it proves | Command |
|---|---|---|
| **Live operational audit** | The real HTTP API, driven as the roles that perform each action (advisor, manager, two technicians, an anonymous customer), through every §25 scenario, with results read back from the API and the database. Creates real records and removes them. | `pnpm audit:operational` — **80/80 checks pass** |
| **Pin tests** | Source-level boundaries that a reviewer could miss in one extra `where` clause or one extra import. | `cr-2026-111d-operational-boundaries.spec.ts` — 15 pass |
| **Static audits** | Exhaustive greps for the specific failure modes the directive names (partial selects, `bookableOnline` leakage, shadow authority, destructive resource writes). | recorded below |

Full suites after the audit: **API 1672 passed**, **web 309 passed**, both typechecks clean, no schema drift.

---

## 2. PASS / FAIL matrix

| § | Operational area | Result | Evidence |
|---|---|---|---|
| 1 | Technician assignment: view eligible techs, assign tech + bay, reflected on Dispatch Board and in technician workspace | **PASS** | S1 21/21 — no `RESOURCE_AWARE` activation required |
| 2 | WorkResource does not break WorkBay assignment | **PASS** | S5/S7; pin tests; assignment writes `bayId`, validates `WorkBay.bayType`, never reads `WorkResource` |
| 3 | Staff catalogue broader than public booking | **PASS** | S9: staff books BRK-02 and ENG-01 (not public); public API refuses BRK-02 with 400; pin test: no staff query filters on `bookableOnline` |
| 4 | No partial select feeds the duration resolver | **PASS** | every guarded call site traced (§3 below) |
| 5 | Technician workspace fields | **PASS** | S1: customer, vehicle, class, service, order, expected 90, source + appointment time, priority, bay, status, ETA, visit link all present |
| 6 | Start → Pause → Resume → QC → Complete; pause reasons; timing feeds | **PASS** | S1/S2/S3 full lifecycle; `WAITING_PARTS` pause; advisor refused QC (tech-only rule intact); `startedAt` stamped; segments closed at QC |
| 7 | Multiple jobs per technician | **PASS** | S6: warns (409 `TECHNICIAN_HAS_OPEN_WORK`) until acknowledged; both jobs visible; pausing one leaves the other `ASSIGNED`; second starts while first paused |
| 8 | Reassignment A → B, queued and after start | **PASS** | S4: one active assignment on B, prior ended, same order, estimate unchanged, B sees it / A does not, history rows present |
| 9 | Bay change during live work | **PASS** | S5: one active assignment on the new bay, job stays `IN_PROGRESS`, no duplicate |
| 10 | Resource → MAINTENANCE with a live job | **PASS** | S7: job untouched; overview flags `isOperational:false` + reason; `/operational-status` = `MAINTENANCE`; staff can still assign to the WorkBay |
| 11 | Customer booking → operational workflow | **PASS** | S2: `CUSTOMER_SELF_SERVICE` → check-in → Job Sheet pre-filled (concern verbatim, mileage) → order → assign → lifecycle → CLOSED |
| 12 | Staff appointment → operational workflow, converging with 11 | **PASS** | S1 vs S2: same ServiceVisit / ServiceOrder / assignment / lifecycle after check-in |
| 13 | Walk-in → operational workflow | **PASS** | S3: visit + ticket + auto DRAFT order → lifecycle → CLOSED |
| 14 | General Servicing parity: Sedan 90 / SUV 120 / Unknown 120 | **PASS** | S1 sedan order 90; S3 SUV walk-in 120; S10 unknown walk-in **and** staff order 120; reservation stays 80 (DEFAULT) by design |
| 15 | No package expansion / duplicate items | **PASS** | S1/S3: exactly one line; static: nothing turns `kpi_service_components` into order items |
| 16 | Job Sheet cohesion | **PASS** | S2: intake block + mileage on the visit field, distinct from staff directive |
| 17 | Inspection cohesion / historical retrieval | **PASS** | S1: Job Sheet retrievable after CLOSE; schema: inspections tied to visit/vehicle/customer with `onDelete: Restrict` |
| 18 | Queue and dispatch | **PASS** | S1: ticket on board as `WAITING` + `APPOINTMENT` after assignment → `IN_SERVICE` on start → gone after completion |
| 19 | ETA across states | **PASS** | S1: projected while queued; coherent after completion; `resolvePlannedMinutes` prefers the line estimate |
| 20 | KPI / reporting integrity | **PASS** | S2: ASSESS-01 mapped `SEPARATE_SLA`, not `GENERAL_SERVICE_CORE`; no 90/120 benchmark on its order |
| 21 | Cancellation before work | **PASS** | S8: `CANCELLED`; zero reservation rows |
| 22 | No silent deletion after work begins | **PASS** | static: no `serviceOrder.delete` / `technicianAssignment.delete` in resource or capacity code |
| 23 | Permission boundaries | **PASS** | S11 8/8: technician 403 on Settings/appointments/assign, 200 on own jobs; advisor/manager as expected; anonymous 401 on operational and queue APIs |
| 24 | RESOURCE_AWARE SHADOW has no operational authority | **PASS** | S12: mode `FIXED` throughout, every lifecycle completed with SHADOW observing; pin tests: no operational path imports the shadow engine, mode only changes the ETA capacity *number*, no reservation writes, mode switch guarded by preflight |
| 25 | End-to-end matrix (15 scenarios) | **PASS** | all covered by S1–S12; scenario 8 (waiting for parts) via `WAITING_PARTS` pause; scenario 13 via BRK-02 with DISC-01 never substituted |

**Regressions found: 0.**

---

## 3. §4 in detail — every guarded call site, traced

The shared resolver's runtime guard **throws** on a service loaded without its class columns, so a partial select still feeding it would be a live 500. Every call site was enumerated and its data source traced:

| Call site | Source of the service rows | Columns |
|---|---|---|
| `appointments.service.ts` create / edit-services / merge | `resolveServiceTypeCodes` | `SERVICE_DURATION_SELECT` |
| `appointments.service.ts` reschedule (both branches) | `findById` → `serviceType: true` | all |
| `public-booking.service.ts` list / confirm / reschedule | `resolveServices`, `appointmentInclude` | `SERVICE_DURATION_SELECT` |
| `booking-simulator.service.ts` | own query | `SERVICE_DURATION_SELECT` |
| `scheduling.service.ts` queue ETA | `serviceType: true` | all |
| `service-orders.service.ts` create / edit lines | `resolveServiceTypeCodes` | `SERVICE_DURATION_SELECT` |
| `walk-ins.service.ts` | own query | `SERVICE_DURATION_SELECT` |

The `orderItems` branch of `resolvePlannedMinutes` (ETA priorities 2–3) reads `estimateMinutes` and `baseDurationMinutes` directly and is **not** guarded — correctly, because it never resolves by class.

---

## 4. The one thing found and fixed

**`VehicleServiceClass` has three values; my `VehicleClass` type modelled two.**

`UNKNOWN_REQUIRES_REVIEW` is carried by **5,251 vehicles**. Five sites cast `serviceClass as VehicleClass`, so the type was a lie. Behaviour happened to be right — anything that is not sedan/SUV falls to the longest duration — but only by accident of the resolver's `else` branch.

Fixed with one normaliser in the resolver module, `toVehicleClass(raw)`, used at every cast site; the intent is now explicit and pinned: a vehicle flagged for review plans General Servicing at **120, never 90**. Not a regression in behaviour; a correctness gap in typing that would have hidden a future mistake.

---

## 5. Observed, not changed

**The resources overview row has two "status" vocabularies.** `status: "AVAILABLE"` means *not occupied* (it sits beside `currentJob: null`); `isOperational: false` + `operationalReason` carry the graded operational state; the word `MAINTENANCE` itself is on `/resources/:id/operational-status`. The warning surface works — the audit asserts it — but a reader could take `status: "AVAILABLE"` to mean the bay is fine. Predates CR-108; a labelling question for the resources UI, outside this audit's no-unrelated-changes rule.

---

## 6. Behaviours confirmed as designed (not regressions)

The first audit run surfaced three refusals that turned out to be existing rules working correctly. Recorded so nobody "fixes" them:

- **"Only the assigned technician can send this work to QC."** — CR-2026-101. An advisor cannot; the harness now asserts the 403 *and* completes as the technician.
- **409 `TECHNICIAN_HAS_OPEN_WORK`** — workload warn-not-block. A second job needs `acknowledgeWorkload: true`; the harness pins the warning and then the acknowledgement.
- **"Bay type 'GENERAL' does not match required bay type(s): LUBE."** — bay compatibility (CLAUDE.md §2.7). Pinned as a passing check.

---

## 7. Production state after the audit

| Setting | Value |
|---|---|
| `booking_capacity_mode` | `FIXED` — unchanged |
| `appointment_duration_source` | `DEFAULT` — unchanged |
| Public catalogue | 8 services; GEN-SERV-01 still withdrawn |
| WorkResource BAY-01 | restored `AVAILABLE` |
| Audit records | 0 remaining |

---

## 8. Acceptance (§26)

Technician assignment ✅ · reassignment ✅ · bay assignment ✅ · staff service selection intact ✅ · internal-only services usable by staff ✅ · customer jobs converge into the normal path ✅ · walk-ins functional ✅ · workspace correct ✅ · Start/Pause/Resume/QC/Complete ✅ · multi-job ✅ · Job Sheet + inspections connected ✅ · queue + dispatch functional ✅ · ETA coherent ✅ · KPI classification correct ✅ · SHADOW has no authority ✅ · no duplicate records ✅ · tests/typecheck/deploy checks green ✅

**The cohesion audit passes.**
