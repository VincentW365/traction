# CR-2026-091 — an unmapped service must never read as a technician's failure

**Status:** Implemented — schema, engine, backend, dashboard and review queue.
**Local commits only, not pushed**, per the standing directive.

Follows [CR-2026-090](104_CR_2026_090_KPI_Operational_Integration.md), which left four
services deliberately unmapped. Leaving them unmapped is acceptable **temporarily**.
This is what makes that true.

---

## 1. What was wrong

CR-2026-090 got two of the three properties right by accident of design and one wrong.

**Right already:** the adjusted rating was nulled for any job that was not formally
eligible, and every rating percentage — site-wide and per technician — divided by
`eligible` only. An unmapped-service job did not drag anyone's numbers down.

**Wrong:** two things.

### The absolute band still applied

`absoluteCompletionRating` was stored regardless of eligibility, because CR-2026-088
reasoned that the manager's fixed table "needs no benchmark" and so can always be
applied. That reasoning breaks precisely here. A job is in this state *because it
contained work nobody has accounted for* — and that unaccounted work is the most likely
reason it ran long. A 241-minute job would show **Below Standard**.

Nothing about that is a technician's result. It is an administrative gap wearing the
costume of one.

### One bucket for two opposite situations

`NOT_BENCHMARKED` covered both:

- *"This is a gearbox strip; it has no agreed standard."* — a finished answer.
- *"Nobody has mapped one of these services yet."* — somebody's outstanding task.

Identical in the data, so the second could never be found and cleared. "We'll map it
later" quietly meant "this job is never rated."

---

## 2. What changed

### A distinct state

`KpiEligibilityStatus` gains **`PENDING_BENCHMARK_REVIEW`**, alongside a
`pendingBenchmarkReview` flag on the snapshot.

Detection decides which it is, via a new `requiresBenchmarkReview` result field:

| Situation | Flagged for review? | Why |
|---|---|---|
| A service on the job is unmapped | **Yes** | Someone can supply the mapping |
| A brake line has no axle recorded | **Yes** | Someone can record the axle |
| A service is mapped `FORCES_CUSTOM_BENCHMARK` | No | A manager already answered this |
| Rear-only brake work | No | Rear brakes are not front brakes — a conclusion |
| Not one of the approved packages | No | No configuration turns it into one |

The line is precise: **something a person can supply is missing**, versus **the work
genuinely has no standard**.

### No rating of any kind

A job in this state carries **neither** rating — not the adjusted one, and not the
absolute band. It is not a bad result; it is not a result.

The absolute band is still kept for a genuine `NOT_BENCHMARKED` job, because there
CR-2026-088's reasoning does hold: the manager decided the work has no standard, and the
raw completion bands are still a fair thing to report against it. Only the
configuration-gap case is withheld.

### Out of every denominator, and said so

The rule — *only a formally `ELIGIBLE` job counts* — now lives in one place, in
`getDashboard`, and the per-technician roll-up is computed **server-side**.

It previously existed only as a filter line in the dashboard page. That was correct,
but it was one careless edit away from silently changing whose numbers looked good, it
had to be repeated by every other consumer, and it only ever covered the first 500 job
rows the table happened to fetch.

Each technician row now also reports what was left out:

```
excludedPendingReview        held for benchmark setup
excludedSharedOrReassigned   more than one technician
```

so a low job count reads as *"three jobs are waiting on a mapping"* rather than as a
quiet month.

A technician whose only jobs are held **does not appear in the ranking at all**. Ranking
them at 0% would be the worst version of this bug: a visible, permanent, undeserved bad
number.

### A queue, so "temporarily" is true

**Reports → Benchmark Review** lists every held job with the exact services blocking it,
grouped by which service is holding up the most — the shortest route to clearing the
queue is usually one mapping, not one job at a time.

`POST /kpi/orders/:id/resolve-benchmark-review` rates a held job once the configuration
exists.

**Why this is allowed when revising a finalised snapshot is not.** Those look alike and
are opposites. The immutability rule exists so a *known result* cannot be rewritten. A
held job has no result to protect — it was never rated. This produces its first rating
rather than replacing one.

The safeguards that stop it becoming a way to tune outcomes:

- It **refuses any job that already carries a rating**.
- It **re-detects** rather than accepting a supplied answer, so the rating comes from
  the mapping the manager configured for *all* jobs, not one chosen for this one.
- The times are the stored ones. Only the standard was ever missing.
- Who resolved it and when are recorded on the snapshot and audited
  (`KPI_BENCHMARK_REVIEW_RESOLVED`).

---

## 3. Data model

| Field | Purpose |
|---|---|
| `KpiEligibilityStatus.PENDING_BENCHMARK_REVIEW` | Held, not judged |
| `WorkOrderKpiSnapshot.pendingBenchmarkReview` | The fact, recorded at open and refreshed on scope changes |
| `WorkOrderKpiSnapshot.benchmarkResolvedAt` / `...ByUserId` | Who gave the job its first rating |
| `PackageDetectionResult.requiresBenchmarkReview` | Gap vs. answer |

The flag is recorded **when the snapshot opens**, while the mapping that produced it is
the one in force. Deciding it at the finish line would classify the job against a
mapping that may have changed while the work was under way.

`reevaluatePackage` refreshes it in its own right — recording an axle or mapping a
service closes the gap without necessarily moving the package, and a job would otherwise
stay flagged after the thing it was waiting for arrived.

### Migration

`20260821180000_cr_2026_091_pending_benchmark_review` — fully additive. Existing
snapshots keep their status and default to `false`: they were rated under the old rules,
and retrospectively reclassifying them would rewrite results that are already known.

---

## 4. Endpoints

| Method | Path | Permission |
|---|---|---|
| GET | `/kpi/reports/benchmark-review` | `report:view` |
| POST | `/kpi/orders/:id/resolve-benchmark-review` | `report:view` |

`GET /kpi/dashboard` gains `pendingBenchmarkReviewJobs` and `byTechnician`.
`GET /kpi/dashboard/jobs` gains `pendingBenchmarkReview` and `benchmarkResolvedAt` on
each row, so a CSV keeps the distinction.

---

## 5. Tests

19 new (**790 API tests green**).

| Suite | Covers |
|---|---|
| `benchmark-review.spec.ts` (12) | Gap vs. answer for all six detection cases; held job gets neither rating; job still recorded with its times; a genuine no-standard job keeps its absolute band; resolution rates for the first time and stamps who; refuses an already-rated job; refuses while configuration is still missing |
| `kpi-denominators.spec.ts` (7) | Held jobs excluded from site and per-technician denominators; `onTarget: false` on an unrated job does not read as a miss; exclusions reported; held distinguished from no-standard; shared/reassigned still excluded; a technician with only held jobs is absent rather than 0%; rework rate still spans every job |

---

## 6. Verified against the running stack

A real 241-minute job with `OIL-01` (mapped) + `TIR-01` (one of the four deliberately
unmapped services):

```
AFTER SUBMIT TO QC
  eligibilityStatus        PENDING_BENCHMARK_REVIEW
  adjustedTechnicianRating null
  absoluteCompletionRating null          <- previously BELOW_STANDARD
  rawElapsedMinutes        241           <- job kept, not lost

DASHBOARD
  pendingBenchmarkReviewJobs  1
  this technician in byTechnician: absent (no eligible jobs)

REVIEW QUEUE
  blocking: TIR-01 Tire Rotation — "Not mapped to a benchmark component"

RATE BEFORE MAPPING  → 400  "Still awaiting configuration: 1 service(s)…"
MAP TIR-01           → 201
RATE AFTER MAPPING   → 201  ELIGIBLE, GENERAL_SERVICE_ONLY, standard 90, resolvedBy recorded
RE-RATE AGAIN        → 400  "…already carries a rating is never re-rated."
```

Note the job rated `BELOW_STANDARD` *after* resolution, and that is correct: once
`TIR-01` is mapped as absorbed there **is** an agreed standard, and 241 minutes against
90 is a real result. The difference is that it is now earned rather than implied by an
administrative gap.

All test data was removed afterwards.

---

## 7. A consequence worth stating

How a held job rates on resolution depends on how the manager maps the blocking service
— absorbed (no extra allowance), a benchmark component (a bigger package and a longer
standard), or forcing a custom benchmark (stays unrated).

That is the correct place for the decision, and it is exactly why
[CR-2026-090 §2](104_CR_2026_090_KPI_Operational_Integration.md) seeds conservatively
and leaves the four ambiguous services for the owner. The four questions there are still
open.
