# CR-2026-111c — Service-duration consolidation (final)

**Status:** Complete. Consistency work only — no production configuration changed.
**Date:** 2026-09-18
**Scope:** `ServiceOrderItem.estimateMinutes`, walk-in order lines, two missed appointment paths, downstream displays

---

## 1. The divergence that remained

`ServiceOrderItem.estimateMinutes` was assigned `baseDurationMinutes` directly, so
an SUV General Servicing became a **90-minute line** on the work order while the
same vehicle's appointment was planned at 120. Walk-ins had the same flaw, which
made "drove in off the street" a quietly different duration policy.

---

## 2. What now resolves through `service-duration.ts`

No sedan/SUV logic was copied anywhere. Every site below calls
`catalogueMinutesFor(service, vehicleClass)` from the existing resolver.

| Path | File | Class from |
|---|---|---|
| Service order — create | `service-orders.service.ts` | the visit's vehicle |
| Service order — edit lines | `service-orders.service.ts` | the visit's vehicle |
| Walk-in order lines | `walk-ins.service.ts` | the registered vehicle |
| **Appointment — services changed** | `appointments.service.ts` | the appointment's vehicle |
| **Appointment — services merged** | `appointments.service.ts` | the appointment's vehicle |

The two appointment rows in bold were **gaps left by CR-2026-111b**. Both recompute
`scheduledEndAt` and both did it from `baseDurationMinutes × qty`, so editing an SUV
general service would have shrunk it from 120 back to 90 — the very defect that
work set out to remove. Found by auditing every remaining `baseDurationMinutes`
reference rather than assuming the previous pass was complete.

Both service-type queries now use `SERVICE_DURATION_SELECT`, so the compiler and
the runtime guard cover these paths exactly as they cover the booking paths.

### One query saved

The vehicle lookup is skipped when **no** service on the order varies by class,
which is most of the catalogue. The class cannot change the answer, so asking the
database for it would be a query whose result is discarded. Asserted by test.

---

## 3. Estimate ≠ reservation (§4)

These are deliberately different numbers, and the difference is not a bug:

| | Today |
|---|---|
| Booking reservation (calendar) | **80 minutes** — the flat `DEFAULT` booking policy |
| Service estimate (work order) | **90 sedan / 120 SUV** — the configured duration |

The calendar reserves what the booking policy says to reserve. Once the order
exists, what the work actually takes is a separate and more specific fact, and the
order should carry it.

**This mismatch is exactly why GEN-SERV-01 remains non-public**, and it is not
hidden or papered over. The activation preflight still blocks it and still exits
non-zero. Nothing about the duration policy changed here.

---

## 4. Downstream consumers (§5)

Audited every read of `estimateMinutes` and every remaining operational use of
`baseDurationMinutes`.

**Nothing overwrites the resolved estimate.** The two other
`serviceOrderItem.update` calls set qualifiers only — axle position, brake work
type, tire operation, unit quantity — and never touch `estimateMinutes`.

Three places were quoting a *contradicting* number, summing catalogue base
durations instead of the line estimates. A Dispatch Board reading "90 minutes"
beside a 120-minute SUV general service is the same inconsistency wearing a
different hat, so they now read the estimate with the catalogue value as fallback:

| Consumer | File | Change |
|---|---|---|
| Dispatch Board — expected time | `service-orders.service.ts` | uses the line estimate |
| Technician workspace — expected time | `service-orders.service.ts` | uses the line estimate |
| Technician workspace — per-service duration | `service-orders.service.ts` | uses the line estimate |
| Job-times report — expected time | `job-times.service.ts` | uses the line estimate |

**Left alone, correctly:**

- **ETA** (`resolvePlannedMinutes`) already prefers `estimateMinutes` over the
  catalogue base — priority 2 ahead of priority 3 — so it inherits the fix.
- **KPI** resolves its standard from `kpi_benchmarks`, which is already
  vehicle-class aware (CR-2026-088). Its `catalogueMinutes` field is a labelled
  reference input to that calculation, not an estimate, and changing it would
  corrupt a measurement rather than fix one.
- **Job Sheet** reads `ServiceVisit.mileageIn` and the visit notes; it does not
  compute a duration.
- **Test-data generation** (`data-import/test-data/scenarios.ts`) writes synthetic
  figures and is not an operational path.

---

## 5. Regression tests (§6)

`service-orders/__tests__/cr-2026-111c-order-estimate-parity.spec.ts` — 18 tests.
`scheduling/availability/__tests__/cr-2026-111b-duration-parity.spec.ts` — extended
to 37, covering the two appointment paths found here.

| | Sedan | SUV | Unknown |
|---|---|---|---|
| Service order — create | 90 ✅ | 120 ✅ | 120 ✅ |
| Service order — edit lines | 90 ✅ | 120 ✅ | 120 ✅ |
| Walk-in | 90 ✅ | 120 ✅ | 120 ✅ |
| Appointment — services changed | 90 ✅ | 120 ✅ | 120 ✅ |

Plus: a non-class-specific service keeps its catalogue duration on every path and
for every class; an advisor's explicit estimate still wins (the resolver supplies a
default, not a ceiling); walk-in and staff-raised orders agree with each other.

**Select-aware mocks are retained** from CR-2026-111b. The fixtures honour the
Prisma `select`, so a query that stops naming the class columns returns rows
without them and the runtime guard throws — rather than the test passing on a
fixture that over-supplies.

### Mutation-verified

| Mutation | Result |
|---|---|
| Walk-in reverts to `baseDurationMinutes` | **3 tests fail** |
| Order create/edit reverts to `baseDurationMinutes` | **5 tests fail** |
| Appointment service-edit reverts to `baseDurationMinutes` | **3 tests fail** |

---

## 6. Verification

| Check | Result |
|---|---|
| API typecheck | clean |
| Web typecheck | clean |
| API tests | **1657 passed**, 17 skipped |
| Web tests | **309 passed** |
| Visual QA (390×844) | no problems — 7 cards |
| End-to-end demonstration | DEMONSTRATED |
| Schema drift | none |

---

## 7. Production configuration — unchanged (§7)

Confirmed after the change:

- `appointment_duration_source` = **`DEFAULT`** (flat 80 minutes)
- Public catalogue = **8 services**; GEN-SERV-01 still withdrawn
- Resource model, concurrency, `FIXED` capacity — untouched
- No migration; no schema change

---

## 8. Observed, not changed

When the services on an appointment are **changed**, the end time is recomputed
from the catalogue sum rather than through the booking policy, while a plain
reschedule goes through the policy. That inconsistency predates this work, is
independent of vehicle class, and altering it would change planned durations in
production — which §7 forbids. Class-awareness was fixed; the policy behaviour was
left exactly as it was.

Worth a decision alongside the `DEFAULT` → `CATALOGUE` question, since switching
the policy makes the two paths agree by itself.

---

## 9. Consolidation status

Every operational duration path — appointment planning, ETA, rescheduling, staff
booking, customer booking, service-order estimates and walk-in estimates — resolves
vehicle-class-aware durations from `service-duration.ts`.

The service-duration implementation is **fully consolidated**.
