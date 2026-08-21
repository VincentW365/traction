# CR-2026-088 — Technician KPI framework

**Status:** Implemented — engine, backend, technician strip and manager dashboard.
Remaining gaps are listed in §9.
**Local commits only, not pushed**, per the directive.

---

## 1. What is measured

```
KPI time  =  first "Start Work"  →  first "Submit to QC"
             minus approved excluded minutes
```

It does **not** start at the appointment time, the customer's arrival, check-in,
queue entry, reception or pre-inspection. Those are real and they matter, but they
are the shop's problem, not the technician's; folding them in would rate a
technician on how busy the front desk was. They remain in total visit-cycle
reporting, which is a separate question.

It ends at the **first** submission to QC. If the job later fails QC, that rework is
timed separately and the original completion result is preserved — otherwise a
technician could improve a poor number by reworking, and a quality failure would
read as a slow job rather than a quality problem.

All arithmetic is **integer minutes**, rounded **up, once, at the end**. Rounding
each segment would let a job accumulate a minute per pause, and 2.5 hours as a float
is a rounding trap at exactly the boundary the manager's table turns on.

---

## 2. Two ratings, stored side by side

Neither overwrites the other.

**A. `absoluteCompletionRating`** — the manager's fixed table, applied to actual time:

| KPI completion time | Rating |
|---|---|
| ≤ 120 min | Excellent |
| 121–150 min | Meets Target |
| 151–180 min | Needs Improvement |
| > 180 min | Below Standard |

**B. `adjustedTechnicianRating`** — variance against the benchmark for *this* vehicle
class and package, where `variance = actual − standard`:

| Variance | Rating |
|---|---|
| ≤ 0 min | Excellent |
| 1–30 min | Meets Target |
| 31–60 min | Needs Improvement |
| > 60 min | Below Standard |

**Why both.** A single fixed band systematically punishes scope. An SUV general
service has a 120-minute standard, so on the absolute table the best a technician can
do is scrape into Excellent by finishing exactly on the standard, while a sedan
technician doing the smallest package starts two bands ahead. The adjusted rating is
the fair technician-comparison metric and is the primary one; the absolute rating is
kept alongside so management can still watch the raw completion bands they asked for.

`onTarget` is true when the **adjusted** rating is Excellent or Meets Target.

---

## 3. The benchmark matrix

| Vehicle class | Package | Standard |
|---|---|---|
| Sedan | General Service | 90 min |
| Sedan | General Service + Front Brakes | 120 min |
| Sedan | General Service + Front Brakes + Spark Plugs | 150 min |
| SUV | General Service | 120 min |
| SUV | General Service + Front Brakes | 150 min |
| SUV | General Service + Front Brakes + Spark Plugs | 180 min |

SUV is Sedan + 30 at every package. That is exactly what the manager's stated ranges
come to: **the first value of each range is the standard, and the next 30 minutes are
the Meets Target tolerance.** Sedan 1.5–2.0 h → standard 90, tolerance to 120. SUV
2.0–2.5 h → standard 120, tolerance to 150.

Values are seeded, not hard-coded. `KpiPolicy` is effective-dated and every job
snapshots the version it was rated under, so an administrator can retune future
standards without rewriting a single historical result.

---

## 4. Packages are detected by service ID, never by name

An administrator maps service types to one of three components — `GENERAL_SERVICE`,
`FRONT_BRAKES`, `SPARK_PLUGS` — in `KpiServiceComponent`. Default seeded mapping:

| Service | Component |
|---|---|
| `OIL-01` Oil Change | GENERAL_SERVICE |
| `DISC-01` Disc Pad Change | FRONT_BRAKES |
| `SPK-01` Spark Plug Replacement | SPARK_PLUGS |

> **Superseded by [CR-2026-090](104_CR_2026_090_KPI_Operational_Integration.md) §1.**
> The catalogue contains two plausible front-brake services (`DISC-01` and `BRK-02`
> Brake Pad Replacement), and `DISC-01` was seeded here only because the directive
> named it. The investigation found the shop's price list distinguishes axles by
> choosing a different line, while neither code encodes an axle — so *both* are
> ambiguous. Both are now mapped as aliases of one Front Brakes component, counted
> once, and both require an axle qualifier.

Matching on the displayed name would break silently the first time someone renamed a
service in the catalogue admin screen.

A job is benchmarked **only when its services map exactly onto one of the three
approved packages**. An extra unrelated service, brakes without a general service, or
plugs alone all fall out to `CUSTOM_UNBENCHMARKED` with a stated reason. There is
deliberately no "closest match" and no summing of catalogue times: that would invent a
standard nobody agreed to and then rate a technician against it. A manager may
approve a custom standard before work starts (`customStandardMinutes`, with reason,
approver and timestamp).

---

## 5. Delays and exclusions

Exclusions live in `KpiDelayEvent`, **separate from the existing pause ledger**. A
pause is a fact; an exclusion is a decision. Conflating them would make every tea
break silently improve someone's KPI. The two can be linked
(`serviceOrderPauseId`) so they never diverge.

- Only delays that are **both** `requestedForExclusion` **and** `APPROVED` are deducted.
- Unapproved time stays in the measurement.
- **A technician may record a delay; a technician may never approve their own** — the
  service refuses it explicitly.
- Overlapping delays are rejected on entry and merged before deduction, so the same
  twenty minutes can never be removed twice.
- Raw, excluded and adjusted minutes are all stored, so any result can be checked.

Reason codes: waiting for parts, waiting for customer authorisation, bay or equipment
unavailable, manager/QC hold, system outage, safety hold, exceptional thermal safety
hold, technician reassignment, other. **Avoidable technician delays, ordinary work
difficulty, tool searching, poor preparation and rework are not excludable.**

### Cooling

There is no "hot vehicle" checkbox, no automatic 15/20/30-minute addition, and cooling
is not a service. Routine cooling and normal workflow variation are already absorbed
by the Sedan/SUV benchmark and the 30-minute Meets Target tolerance. Many jobs can
proceed without waiting for anything to cool, so heat alone must never change a KPI.

`EXCEPTIONAL_THERMAL_SAFETY_HOLD` exists for the genuine case: the temperature makes
the work unsafe or impractical, the technician cannot get on with another part of the
approved job, a reason is recorded, and a supervisor approves. It is an exception, not
a routine step, and it stays in total visit-cycle time even when deducted from KPI.

---

## 6. Eligibility

A job carries a formal adjusted rating only when the vehicle class is confirmed, a
benchmarked package or approved custom standard exists, a primary technician is
recorded, both timestamps exist, and the timer data is valid. Otherwise the snapshot
carries a named `eligibilityStatus` and reason and **no adjusted rating** — a
misleading rating is worse than none. The absolute band still applies wherever a time
exists, since it needs no benchmark.

**Vehicle class is required before work can start.** `startAssignment` refuses with a
message naming the plate. The point of starting is the last honest moment to ask:
afterwards the clock is running and any classification looks chosen to suit the result.

---

## 7. Data model

| Model | Purpose |
|---|---|
| `KpiPolicy` | Effective-dated standards + tolerances + absolute bands |
| `KpiBenchmark` | One standard per (policy, vehicle class, package) |
| `KpiServiceComponent` | Administrator mapping: service type → component |
| `WorkOrderKpiSnapshot` | Frozen per-job result, incl. policy version |
| `KpiDelayEvent` | Delay + approval trail |

Reuses rather than duplicates: `ServiceOrder.startedAt` is first-start-wins and
written in exactly one place, so it *is* the first Start Work; `ServiceOrder.completedAt`
is stamped on entry to QC, so it *is* the first Submit to QC.

**The snapshot is taken at submit-to-QC and never recomputed from live rows.** This is
required for correctness, not an optimisation: `openRework()` nulls `startedAt` and
`completedAt` so the next attempt times only itself, so a KPI derived on demand would
silently erase the first attempt's result the moment QC failed.

---

## 8. Dashboard

Reports **median and 75th/90th percentiles alongside averages**. A mean is easy to
wreck — one job that sat overnight waiting for a part drags a technician into Below
Standard and hides an otherwise steady month.

No technician is ranked without their eligible job count being shown. Shared or
reassigned jobs are flagged and kept out of individual comparison while remaining in
the detail: attributing a whole elapsed time to whoever happened to finish it would be
a lie. Every job-level row carries its policy version, so a CSV reconciles months later
even after standards change.

Ratings are **never exposed on the customer display**, which continues to show neutral
progress only.

---

## 9. Not yet built

**All three items below were delivered by
[CR-2026-090](104_CR_2026_090_KPI_Operational_Integration.md).** They are kept here
because the reasoning for deferring them is still the reasoning for how they were
eventually built.

- ~~**Per-technician work segments for shared jobs.**~~ The schema had one assignment
  row per technician and the pause ledger was per **order**, so an exact per-technician
  split was not computable when two people overlapped on one job. Rather than guess,
  such jobs were flagged `isSharedOrReassigned` and excluded from individual
  comparison. `TechnicianWorkSegment` now records who was working when. It still does
  **not** split a shared job's elapsed time between technicians — it reports measured
  labour alongside job time instead.
- ~~**Dispatch-board KPI column.**~~ Now carried on every occupied bay and every
  technician with an active job, driven by the board's existing 5-second poll.
- ~~**A UI for the package-component mapping.**~~ Now at **Admin → KPI Mapping**.

### Built since first draft

- Snapshot now OPENS at start of work (fixing the terms before the outcome is known)
  and is finalised at submit-to-QC.
- Scope changes re-evaluate the package and record the revision.
- Manager-approved custom standards, refused once a job is finalised.
- Live technician strip with countdown to the next tolerance boundary.
- Manager dashboard at **Reports → Technician KPI**, with CSV/PDF export including
  the job-level calculation and the policy version each row was rated under.

---

## 10. Endpoints

| Method | Path | Permission |
|---|---|---|
| GET | `/kpi/orders/:id/live` | `service_order:status` |
| GET | `/kpi/orders/:id/package` | `service_order:status` |
| GET | `/kpi/orders/:id/delays` | `service_order:status` |
| POST | `/kpi/orders/:id/delays` | `service_order:status` |
| POST | `/kpi/delays/:id/end` | `service_order:status` |
| POST | `/kpi/delays/:id/decision` | `report:view` (supervisor) |
| GET | `/kpi/dashboard` | `report:view` |
| GET | `/kpi/dashboard/jobs` | `report:view` |
| POST | `/kpi/orders/:id/custom-standard` | `report:view` (manager) |
