# CR-2026-108 — Customer Self-Service Booking hardening

Improves the existing self-service booking implementation (CR-2026-105c, CR-2026-106d)
without creating a second booking system. The canonical design is unchanged: a customer
booking IS an `Appointment` with `sourceChannel = CUSTOMER_SELF_SERVICE`, which then
follows the normal Appointment → ServiceVisit → Queue → ServiceOrder → Dispatch →
Completion workflow.

Delivered in stages, each with tests:

| Stage | Scope | Status |
| --- | --- | --- |
| 0 | Capacity evidence + reproducibility (§A) | complete |
| 1 | Safe notification / UAT handling (§B) | complete |
| 2 | Internal availability decision + reason model | not started |
| 3 | Admin Booking Simulator (FIXED vs SHADOW) | not started |
| 4 | Catalogue / self-service service configuration | not started |
| 5 | Resource-aware capacity engine (SHADOW only) | not started |
| 6 | Reservation semantics + end-to-end validation | not started |

---

## §A. Capacity analysis — evidence, inclusion criteria and its limits

Management asked for a capacity recommendation derived from configured resources and real
operating history rather than a guessed number, and for the analysis to be reproducible.

### A1. The decision taken

| Setting | Pilot value | Meaning |
| --- | --- | --- |
| total concurrency ceiling | **3** | hard safety limit on simultaneous booked positions |
| `booking_walkin_reserve_positions` | **1** | positions held back from online self-service |
| online self-service maximum | **2** | ceiling − reserve |
| `booking_online_capacity_ratio` | **1.0** (neutral) | the absolute reserve provides the restriction; a ratio is NOT also applied, so capacity is never double-reduced |

**3 is a controlled pilot ceiling, not a proven physical maximum.** It is an observed
*utilisation* figure from legacy data, and §A4 lists the reasons it may understate (or
misrepresent) true safe capacity. It must not be quoted as "the Service Centre's capacity".

### A2. Exact query criteria (reproducible)

Database `bsop_dev`, run 2026-09-16. A service order entered the sample only if **all** of:

```sql
started_at   IS NOT NULL
AND completed_at IS NOT NULL
AND completed_at > started_at
AND EXTRACT(EPOCH FROM (completed_at - started_at))/60 BETWEEN 5 AND 600
```

The 5–600 minute band excludes mis-keyed instant completions and multi-day job cards.

**Sample: 626 service orders, 337 distinct days, 2024-04-22 → 2026-09-01.**

Peak concurrency was computed as a running sum over start (+1) / completion (−1) events
ordered by timestamp, i.e. the maximum number of jobs open simultaneously:

```sql
WITH ev AS (
  SELECT started_at t, 1 d FROM service_orders WHERE <criteria above>
  UNION ALL
  SELECT completed_at t, -1 d FROM service_orders WHERE <criteria above>
), run AS (
  SELECT t, sum(d) OVER (ORDER BY t, d DESC ROWS UNBOUNDED PRECEDING) c FROM ev
)
SELECT max(c), percentile_cont(0.95) WITHIN GROUP (ORDER BY c), percentile_cont(0.5) WITHIN GROUP (ORDER BY c) FROM run;
```

### A3. Results

| Measure | Value |
| --- | --- |
| Median concurrent jobs | 1 |
| p95 concurrent | 3 (2 when computed over historical-import rows alone) |
| Peak concurrent, ever observed | 5 |
| Average visits per open day | 11.6 (787 days) |
| Jobs started per day, recent months | 12–17 |
| Actual job duration: median / mean / p90 | 95 / 140 / 332 minutes |

Configured resources, for contrast:

| Source | Implied capacity |
| --- | --- |
| `booking_max_concurrent_appointments` (pre-CR placeholder) | 2 |
| RESOURCES mode over `['BAY','OVERFLOW']` | **13** (11 BAY + 2 OVERFLOW) |
| Observed p95 | 3 |

Adopting 13 would have authorised roughly **4× the observed p95** and 2.6× the all-time
peak. That is the specific error this analysis exists to prevent.

### A4. Why this sample is weak evidence — read before reusing it

1. **Coverage is 6.9%.** Only 626 of 9,123 service orders had usable timing. Excluded:
   8,024 started but never completed, 378 never started, 32 non-positive durations,
   63 outside the 5–600 minute band.
2. **624 of the 626 are `HISTORICAL_IMPORT`.** Only 2 came from real application use
   (1 appointment, 1 walk-in). The figures therefore describe the *legacy SharePoint job
   sheet*, not this platform in operation.
3. **Imported timestamps may not mean bay occupancy.** `started_at`/`completed_at` may be
   job-card open/close times including pauses, parts waits and overnight holds — so
   *duration* is likely overstated and *concurrency* correspondingly distorted.
4. **Resource configuration contains placeholders.** `BAY-06`/`BAY-07` are named
   "Bay 6 (TBD)" / "Bay 7 (TBD)"; `MJACK-01/02` and `STAND-01/02` are mobile jacks and
   stands counted as full bays.
5. **17 technician accounts ≠ 17 technicians concurrently working.** No shift data exists.
6. **Technician skills are synthetic** — 13–14 technicians hold each of 10 skill codes, so
   skill-based filtering would currently be a no-op (`AC` and `COOLING`, 1 technician each,
   are the only discriminating values and are unverified).

### A5. What would make this authoritative

- An operational audit marking which resources are genuinely capacity-contributing service
  positions (Stage 5), rather than inferring it from category names.
- Real concurrent-shift data for technicians.
- A period of live operation so concurrency can be measured from this platform's own
  timestamps instead of imported ones.
- SHADOW-mode comparison logs (Stage 5) reviewed against what the shop actually did.

Until then the pilot ceiling stays conservative and RESOURCE_AWARE stays off.

---

## §B. Stage 1 — safe notification / UAT handling

### B1. The problem

UAT of the public booking flow has to run against a production-like environment,
and every booking sends a confirmation. The only protection that existed was
`NOTIFICATION_MODE=TEST`: a **global** switch that redirects *every* customer
message to one mailbox. Safe for a tester; silently harmful in production, where a
real customer simply stops being told their car is ready and nothing looks broken.

### B2. What changed — suppression is decided per RECORD

`TestRecordResolver` (apps/api/src/modules/notifications/) answers one question
before anything is sent: **is this message about a test record?** It resolves the
existing anchors — `testDataRunId` on Customer, Vehicle and ServiceVisit. An
Appointment carries no anchor of its own, so it is resolved through its customer /
vehicle / visit, which is exactly how a self-service booking made for a test
customer is caught.

When the answer is yes, `NotificationsService.queue` renders the message in full
and records it with status **CAPTURED** — it never reaches a provider. Everything
else delivers exactly as before.

- `CAPTURED` is a new, additive `NotificationDeliveryStatus` value. It is
  deliberately distinct from what already existed: `FAILED` (something went wrong),
  `simulated` (no provider configured), `testRouted` (global mode redirected it).
  Nothing was withheld in any of those cases; here it was, on purpose.
- The captured row stores channel, template, subject, body, `generatedBody` and
  the address it *would* have gone to (`intendedRecipient`).
- Rendering was extracted to `renderForChannel` and is shared with the send path,
  so UAT signs off the exact wording a customer would receive.
- `deliveryDisplayState` maps `CAPTURED` explicitly — a withheld message can never
  read as queued, sent or delivered.
- **Fails toward delivery.** If the test lookup itself errors, the message is
  treated as genuine and sent. Withholding a real customer's message is the worse
  failure: it is silent and it denies them information about their vehicle.

### B3. UAT results view

`GET /api/v1/notifications/captured?runLabel=<label>` (permission `CONFIG_VIEW`)
returns every withheld message with its full content and intended recipient. This
is what a tester reads instead of a mailbox. Unmasked on purpose — these are test
records by definition — and never publicly reachable.

### B4. The global mode is now guarded, not relied upon

`NOTIFICATION_MODE=TEST` still exists, but `deploy:check` now **fails** when
`NODE_ENV=production` and the mode is not `LIVE`, naming the consequence:

```
[FAIL] NOTIFICATION_MODE — is "TEST" in production — every customer message
       would be diverted. Set LIVE; UAT is covered per-record.
```

An administrator can no longer leave the whole shop's customer communication
diverted without the deployment refusing to pass.

### B5. Evidence

Unit/behaviour tests (`test-record-capture.spec.ts`, 14 tests) cover capture,
content preservation, attribution, all four resolver paths, the genuine-record
regression, fail-toward-delivery, and the no-resolver-wired case. Full API suite:
**1256 passed**.

Live proof against the running API, then cleaned up:

```
 3. booked as the TEST customer — reference BK-B01-260916-004
 4. sourceChannel = CUSTOMER_SELF_SERVICE
 5. 2 notification(s), all CAPTURED, none transmitted (no sentAt, no providerReference)
 6. withheld from: SMS -> 8765706813, EMAIL -> uat-70681302@example.com
 7. UAT view returns 2 captured message(s) for run "uat-booking-70681302"
 9. body 482 chars, would have gone to uat-70681302@example.com
10. genuine customer booked BK-B01-260916-005: SMS=SENT, EMAIL=SENT — NOT captured
```

Deployment UAT checklist for the owner's real-device test: `docs/123_Booking_UAT_Checklist.md`.

### B6. Known limitation, carried to Stage 3

A booking made by a **brand-new** customer through `/book` creates an untagged
record, so it is genuine and its confirmation is sent. That is correct behaviour,
but it means UAT of the first-time-customer path must either use a pre-tagged
customer or accept a real send to a tester-controlled address. Stage 3's simulator
is the natural place to make "book as a test customer" a first-class action.
