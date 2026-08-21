# CR-2026-090 — KPI operational integration and technician work-segment capture

**Status:** Implemented — schema, engine, backend, admin screen, dispatch strip and
reports.
**Local commits only, not pushed**, per the directive.

Supersedes the three gaps left open in
[CR-2026-088 §9](102_CR_2026_088_Technician_KPI_Framework.md).

---

## 1. DISC-01 vs BRK-02 — resolved from evidence

The directive required this settled with documented evidence, and an axle qualifier
only if it turned out genuinely ambiguous. It did.

**What the catalogue says**

| Code | Name | Family | Duration | Times used on a work order |
|---|---|---|---|---|
| `DISC-01` | Disc Pad Change | Service | 60 min | **0** |
| `BRK-02` | Brake Pad Replacement | Brakes | 90 min | 3 |
| `BRK-01` | Brake Inspection | Brakes | 30 min | inspection only |

On usage alone the answer would be BRK-02. But usage is a thin sample — there are 11
service-order lines in total, because the historical import recorded work as free
text.

**What the price list says, and this is decisive.** The imported `service_catalog_items`
(BRAKES category) contains *both*:

- "To R/R DISC PADS — CAR/SUV/LARGE"
- "To R/R DISC PADS **rear** electronic — CAR/SUV/LARGE"
- "R/R BRAKE SHOE" (drums, typically rear)

The shop distinguishes axles by choosing a **different price-list line**. Neither
Traction code encodes an axle at all. So the question "is DISC-01 front-brake work?"
has no answer from the code alone — and neither does the same question about BRK-02.

**Decision.** Both codes are mapped as **aliases of one `FRONT_BRAKES` component**, and
**both require an axle qualifier**. This is the directive's third case, and it is what
the evidence supports rather than a preference between two codes.

Consequences, all tested:

- Either code alone satisfies Front Brakes — when qualified `FRONT`.
- Both on one order still count as **one** component. One set of pads earns one brake
  allowance; double-counting would show up as a technician beating the standard.
- **Rear-only work never satisfies the front-brake standard.**
- `FRONT_AND_REAR` satisfies it only where management approves, via the business rule
  `kpi_front_and_rear_satisfies_front_brakes` (default `false`). A both-axles job is
  more work than that standard was built for.

---

## 2. Component roles — a richer mapping model

The v1 map said only "this service IS front brakes". Two common cases had no
expression, and both produced wrong answers.

| Role | Meaning |
|---|---|
| `GENERAL_SERVICE_CORE` | Defines the General Service component |
| `FRONT_BRAKES` | Defines the Front Brakes component (subject to the axle qualifier) |
| `SPARK_PLUGS` | Defines the Spark Plugs component |
| `INCLUDED_NO_ADDITIONAL_BENCHMARK` | Work the general-service standard already contains |
| `FORCES_CUSTOM_BENCHMARK` | Substantial work the approved packages do not describe |

**Absorbed work** matters because under v1 an oil filter booked as its own line knocked
the job out of its benchmark, even though the 90-minute standard already contains it.
Only activities the manager's own general-service breakdown names — "oil change,
filters, wipers, fluid checks, paperwork" — are seeded as absorbed: `OIL-FLT-01`,
`AIR-FLT-01`, `WIPER-01`.

**Forcing a custom benchmark** matters for the opposite reason: a gearbox strip bolted
onto an oil change must never be measured against the General Service standard. Twelve
substantial services are seeded this way (major tune-up, rack and pinion, suspension,
diagnostics, machine-shop work, and so on).

### Why the seed under-claims on purpose

> **Extended by [CR-2026-091](105_CR_2026_091_Pending_Benchmark_Review.md).** An
> unmapped service now produces a job that is **unrated and flagged for benchmark
> review** — no adjusted rating and no absolute band either — held out of every
> technician denominator, listed in a review queue, and rateable for the first time once
> the mapping exists. The "safe direction" below was correct but incomplete: it still
> let the absolute band show a result on a job whose unaccounted work was the reason it
> ran long.

An unmapped service is **not** neutral — it forces `CUSTOM_UNBENCHMARKED`. That is the
safe direction, because the failure modes are not symmetric:

- Marking real extra work as "included" leaves the job benchmarked at a standard that
  never accounted for it, and **rates the technician slow for doing more**.
- Leaving a service unmapped costs one adjusted rating on one job.

So four services are deliberately left unmapped and surfaced in the admin screen's
review list rather than guessed (`KPI_UNMAPPED_FOR_REVIEW`):

| Service | Question for the manager |
|---|---|
| `FUEL-FLT-01` Fuel Filter Change | Part of your standard general service, or extra work? The activity breakdown says "filters" without saying which. |
| `BRK-01` Brake Inspection | Absorbed by the general service, or does a job including it need its own standard? |
| `EST-01` Estimate / Inspection | Is a booked estimate technician work that should be benchmarked? |
| `TIR-01` Tire Rotation | Part of your standard general service? |

---

## 3. The axle qualifier in practice

`ServiceOrderItem.axlePosition` — `FRONT | REAR | FRONT_AND_REAR | NOT_APPLICABLE`,
nullable so historical lines stay as they were.

Detection reports the axle situation precisely rather than as a flat failure:

| Field | Meaning |
|---|---|
| `awaitingAxleQualifierServiceTypeIds` | Qualifier-requiring lines with no axle recorded |
| `disqualifiedByAxleServiceTypeIds` | Lines whose axle does not satisfy the component |
| `resolvableByAxleQualifier` | The axle is the **only** thing blocking a benchmark |

That last flag exists so the UI can prompt for the one field that would fix the job.
Telling staff "record the axle" when it would not help — because an unmapped service is
also present — is worse than saying nothing.

Every blocker is reported at once rather than one at a time. Fixing one problem only to
be shown the next is how "why is this job not rated?" becomes a support ticket.

**Recording the axle later is allowed**, through `PATCH /service-orders/:id/items/:itemId/axle`,
because the axle is often only settled once the vehicle is on the ramp, and a job
permanently unbenchmarked because a dropdown was missed at booking helps nobody. It is
audited, and it re-evaluates the package through the same path as any other scope
change — which `reevaluatePackage` refuses once the snapshot is finalised. A completed
job's terms cannot be revised after its result is known.

---

## 4. Technician work segments

### The problem this solves

CR-2026-088 could not answer "how long did Marcus spend on this job?" for any job more
than one person touched, and said so rather than guessing. The reason was structural:
one assignment row per technician with a single start and end, and a pause ledger
recorded per **order**. When two technicians overlap, nothing in that data says who was
working when.

`TechnicianWorkSegment` records it directly — one row per continuous period a named
technician was working on a named order. Nothing is inferred.

### Lifecycle

| Moment | Effect |
|---|---|
| Technician starts work | Segment opens (`TECHNICIAN_START`) |
| Pause | **Every** open segment closes (`PAUSED`), in the pause transaction |
| Resume | Segments reopen for everyone **still assigned** (`TECHNICIAN_RESUME`) |
| Assistant joins | Their own segment opens (`ASSISTANCE_START`) |
| Assistant leaves | Only their segment closes (`ASSISTANCE_COMPLETE`) |
| Reassignment | Outgoing closes `REASSIGNED`, incoming opens `REPLACEMENT` — one transaction |
| Submit to QC | Every open segment closes (`SUBMITTED_TO_QC`) |
| Cancellation | Every open segment closes (`JOB_CANCELLED`) |

Two details that are easy to get wrong and are tested:

- **Resume reopens only for technicians still assigned.** Someone taken off the job
  while it sat paused must not silently start accruing labour again.
- **Cancellation stops the clock.** An open segment on a cancelled order otherwise
  accrues against "now" every time a report runs, and the labour grows indefinitely
  for a job nobody is doing.

### Constraints

Enforced in the database, not only in the service:

- **At most one open segment per technician per order** — a partial unique index
  (`WHERE ended_at IS NULL`). This is what makes a retried Start request safe; a race
  loses rather than corrupts.
- **A segment cannot end before it starts** — a `CHECK`. A negative labour figure is
  the kind of thing a report believes long after the code that wrote it changed.

`startSegment` is additionally idempotent at the service level: a double-tapped button
returns the existing open segment rather than fragmenting one period of work into two
rows.

### Corrections

Segments are captured from live actions, so they inherit every way a live action goes
wrong — a technician who forgot to press Start, a tablet that lost signal, a segment
the system closed at end of day. `POST /kpi/segments/:id/correct` fixes them. A reason
is **required**, the actor is recorded, and before/after values are audited. An
editable labour record with no trail is not a labour record.

---

## 5. Job time and labour time are different quantities

This is the distinction the whole model turns on.

> **JOB time** is wall-clock and there is one of it: first Start Work to first Submit
> to QC. This is what the benchmark table rates. **Unchanged by this CR.**
>
> **LABOUR time** is per person, and there can be more of it than the job lasted. Two
> technicians working one hour side by side is one hour of job time and two hours of
> labour.

Four measures, because managers ask four different questions:

| Measure | Question it answers |
|---|---|
| `technicianActiveMinutes` | How long did Marcus spend on this? |
| `teamLabourMinutes` | What did this job cost in labour? |
| `activeCoverageMinutes` | How long was anyone working on it? (union) |
| `concurrentAssistMinutes` | How long were two or more on it at once? (overlap) |

On a solo job with no pauses, active = team = coverage, and concurrent = 0.

### Delay and pause interaction

An approved **job-wide** exclusion comes off coverage **once**. Deducting a 30-minute
parts wait from each of three technicians would erase 90 minutes of labour that 30
minutes of delay cannot justify.

Per-technician minutes have the exclusion deducted only where it actually overlaps
**that** technician's own segments. Usually there is no overlap at all, because pausing
closes segments — the delayed time was never inside anyone's segment. The intersection
is taken anyway, for a delay approved retrospectively over time a segment was left open.

---

## 6. No attribution formula for shared jobs

The directive is explicit, and it is followed: **no per-technician split of a shared
job's elapsed time is invented.** The data cannot support one, and a formula would
present a guess as a measurement.

What is reported instead is measured: who was on the job, how long each was actually
working, and how much of that was side by side.

The **Shared and Reassigned Jobs** report (`GET /kpi/reports/shared-jobs`) is its own
report rather than a dashboard filter. These jobs are excluded from individual
comparison by design, and the surest way to have them compared anyway is to leave them
in the ranking view behind a checkbox.

The sentence **"Informational only — not included in individual KPI comparison."**
appears on the report, on the technician KPI page's shared-jobs section, and on **every
row** — so it survives a CSV export. A caveat that only lives in a heading is the
caveat that gets lost the moment someone downloads the data and mails it round.

---

## 7. Package-mapping administration

CR-2026-088 shipped the mapping as seed data with no screen, which made the one
genuinely configurable part of the framework the one part only a developer could
change. **Admin → KPI Mapping** is that screen.

Two rules shape it:

1. **Mappings supersede; they are never edited in place or deleted.** Changing one
   retrospectively would alter what a completed job was rated against — the exact
   failure effective-dating exists to prevent. The old row is closed off and a new one
   opens.
2. **Exactly one active mapping per service.** Two would make detection depend on row
   order.

Backdating is refused. Snapshots protect finalised results, but in-flight jobs
re-detect on scope changes, so a backdated mapping would still be a way to alter a
live measurement after seeing how it is going.

The screen surfaces aliases explicitly, because that is its most confusing aspect: a
manager needs to see that DISC-01 and BRK-02 are two doors into one room, not two
separate time allowances. Unmapped active services are flagged as outstanding work.

---

## 8. Data model

| Model / field | Purpose |
|---|---|
| `AxlePosition` enum | FRONT / REAR / FRONT_AND_REAR / NOT_APPLICABLE |
| `KpiComponentRole` enum | The five roles above |
| `KpiServiceComponent` (upgraded) | Aliases (unique dropped), `requiresAxleQualifier`, `isActive`, effective dating, `updatedByUserId`, notes |
| `ServiceOrderItem.axlePosition` | The qualifier on the line |
| `TechnicianWorkSegment` | Per-technician periods of work + correction trail |
| `TechnicianSegmentRole` | PRIMARY / ASSISTING / REPLACEMENT, snapshotted per segment |
| `SegmentStartSource` / `SegmentEndReason` | Why a segment opened and closed |

The role is **snapshotted** on each segment because a technician can be promoted from
assisting to primary mid-job, and earlier segments must keep saying what they were at
the time.

### Migration

`20260821160000_cr_2026_090_kpi_mapping_v2_and_work_segments`.

Additive apart from one column replacement, which is done **in place**: the generated
diff would have dropped `component` and re-added `component_role` NOT NULL, losing the
three seeded mappings. The migration converts the values instead. Existing
`FRONT_BRAKES` mappings pick up `requires_axle_qualifier = true` automatically, since a
brake mapping is ambiguous without one.

Nothing historical is deleted. Mappings are superseded rather than removed, because
completed KPI snapshots were produced under them and must stay reproducible.

---

## 9. Endpoints added

| Method | Path | Permission |
|---|---|---|
| GET | `/kpi/orders/:id/segments` | `service_order:status` |
| GET | `/kpi/orders/:id/labour` | `service_order:status` |
| POST | `/kpi/segments/:id/correct` | `report:view` (manager) |
| GET | `/kpi/reports/shared-jobs` | `report:view` |
| GET | `/kpi/mappings` | `config:edit` |
| GET | `/kpi/mappings/:serviceTypeId/history` | `config:edit` |
| POST | `/kpi/mappings` | `config:edit` |
| POST | `/kpi/mappings/:mappingId/deactivate` | `config:edit` |
| PATCH | `/service-orders/:id/items/:itemId/axle` | `service_order:status` |

---

## 10. Tests

61 new automated tests; **771 API tests green**.

| Suite | Covers |
|---|---|
| `kpi-package-detection.spec.ts` (24) | Aliases counted once; each axle value; unqualified lines; management approval of front-and-rear; absorbed work; forced-custom work; deliberate vs unmapped; all blockers reported together |
| `labour-measures.spec.ts` (16) | Solo equivalence; shared labour vs coverage; concurrency at three depths; reassignment; exclusion deducted once not per technician; overlapping exclusions merged; never negative |
| `work-segment.service.spec.ts` (18) | Idempotent start; one open segment per technician; end-never-before-start; close-all; resume only for still-assigned; reassignment atomicity and instant; corrections require a reason and are audited |
| `work-segment-lifecycle.service.spec.ts` (11) | The order state machine drives the labour clock at start, pause, resume, QC, assistant end, removal, cancellation; axle recording, audit, no-op and validation |

---

## 11. Verified against the running stack

Not only unit-tested. Each case below was exercised against the live API and the real
seeded catalogue, using real work orders created and then removed.

### Detection

| Order | Result |
|---|---|
| `OIL-01` + `BRK-02`, no axle | `CUSTOM_UNBENCHMARKED`, `resolvableByAxleQualifier: true`, "1 brake service(s) have no axle recorded" |
| …then `PATCH …/axle {FRONT}` → HTTP 200 | **`GENERAL_SERVICE_FRONT_BRAKES`** |
| `OIL-01` + `BRK-02` qualified `REAR` | `CUSTOM_UNBENCHMARKED` — rear does not satisfy the front standard |
| `OIL-01` + `BRK-02` + `DISC-01`, both `FRONT` | `GENERAL_SERVICE_FRONT_BRAKES` — **components counted once**, not twice |
| `OIL-01` + `OIL-FLT-01` | `GENERAL_SERVICE_ONLY` — absorbed, package intact |
| `OIL-01` + `ENG-02` | `CUSTOM_UNBENCHMARKED` — "additional work outside the approved packages" |
| `OIL-01` + `BRK-02` qualified `FRONT_AND_REAR` | `CUSTOM_UNBENCHMARKED` with the rule off; **`GENERAL_SERVICE_FRONT_BRAKES` with it on**; back to custom once restored |

### Segment lifecycle

A real technician (`BERT-T01`) through the real endpoints:

```
1. START WORK     201   [TECHNICIAN_START → OPEN]
2. PAUSE          201   [TECHNICIAN_START → PAUSED]
3. RESUME         201   [TECHNICIAN_START → PAUSED, TECHNICIAN_RESUME → OPEN]
4. SUBMIT TO QC   201   [TECHNICIAN_START → PAUSED, TECHNICIAN_RESUME → SUBMITTED_TO_QC]
5. LABOUR         technicianCount 1, segmentCount 2, shared false
```

Two segments, the paused gap outside both — which is exactly why per-technician
minutes rarely need an exclusion deducted at all.

### Screens

`/admin/kpi-mapping`, `/reports/shared-jobs`, `/reports/technician-kpi`, `/dispatch`,
`/technician` and `/queue` all render (HTTP 200). The mapping API reports DISC-01 and
BRK-02 each listing the other as an alias, both with `requiresAxleQualifier: true`, and
13 active services flagged as needing review.

All test data created for these checks was removed afterwards, and the front-and-rear
rule was restored to `false`.

## 12. Issues found during build and fixed

Three were real defects in this CR's own first cut, found by reviewing the API from the
client side:

- **Notes-only mapping edits were silently discarded.** `upsert` compared only the role
  and the qualifier, so correcting a rationale returned success with no effect. Notes
  now update in place and are audited — no supersede, because the classification did
  not move.
- **The shared-jobs technician filter was applied after the row cap.** A wide date
  range would take the most recent 300 shared jobs and *then* filter, reporting "4
  shared jobs" for someone who worked forty. The filter is now resolved into the query.
- **`totals` reported three of the four labour measures**, forcing clients to
  reconstruct the other two from rows. All four are returned, and the empty-result path
  returns the same shape.

Also tidied: the mapping history endpoint now returns the same shape as the list rows
(with role label and resolved author name) instead of raw Prisma rows, so a client does
not need two code paths; and `list()`'s parameter was renamed to match what it does.

## 13. What was deliberately not done

- **No per-technician attribution formula for shared jobs.** Stated above; required by
  the directive and correct on its own terms.
- **No change to how a job is rated.** Segments add labour measures alongside the
  existing measurement; they do not become a new way to score an individual.
- **No automatic axle inference from service names.** Names get edited; a hard-coded
  list of "brake-ish" codes in the UI would drift from the admin screen the first time
  someone added a service.
- **Four services left unmapped**, listed in §2, with the question each needs answered.

## 14. Legacy review list

Existing data that predates this CR and may need attention:

- **Historical `service_order_items` have `axle_position = NULL`.** Brake lines among
  them will read as awaiting a qualifier. They are historical, so no live measurement
  depends on them; no backfill is proposed, because inventing an axle for completed
  work is exactly what the qualifier exists to prevent.
- **Completed jobs carry no work segments.** Labour measures are empty for them, and
  the shared-jobs report only covers jobs worked after this CR. `isSharedOrReassigned`
  on older snapshots still flags them for exclusion from individual comparison.
- **The four unmapped services in §2** need a management decision.
