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
| 2 | Internal availability decision + reason model (§C) | complete |
| 3 | Admin Booking Simulator + UAT session (§D) | complete |
| 4 | Catalogue / self-service service configuration | not started |
| 5 | Resource-aware capacity engine (SHADOW only) | not started |
| 6 | Reservation semantics + end-to-end validation | not started |

---

## §A. Capacity analysis — evidence, inclusion criteria and its limits

Management asked for a capacity recommendation derived from configured resources and real
operating history rather than a guessed number, and for the analysis to be reproducible.

### A1. The decision taken — NO capacity change

**`booking_max_concurrent_appointments` stays at its current production value.**

An earlier draft of this document proposed a pilot ceiling of 3, derived from the p95
concurrency below. Management withdrew that on reviewing §A4: the sample turned out to
cover **6.9% of service orders**, and **624 of its 626 records are `HISTORICAL_IMPORT`**
— only 2 reflect this platform actually operating. That is not a basis for authorising
how much work the shop accepts.

So the analysis is retained as a **historical observation only**. It may be used to
design and validate the shadow model. It is **not authoritative capacity data** and must
never be cited as evidence that the live Service Centre can safely run three concurrent
appointments.

A new production capacity value will be set only after both of:

1. the Resources & Bays operational audit (which resources are genuinely
   capacity-contributing service positions — Stage 5), and
2. an operational staffing review (how many technicians actually work concurrently).

Until then: keep building FIXED / SHADOW / RESOURCE_AWARE capability, and **do not
activate RESOURCE_AWARE**.

The reserve/ratio design below still stands for when a value IS set — in particular that
an absolute reserve and a ratio must never both bite, or capacity is double-reduced:

| Setting | Intended meaning when eventually configured |
| --- | --- |
| total concurrency ceiling | hard safety limit on simultaneous booked positions |
| `booking_walkin_reserve_positions` | positions held back from online self-service |
| `booking_online_capacity_ratio` | left neutral at **1.0** while an absolute reserve provides the restriction |

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
peak. That is the specific error this analysis exists to prevent — and §A4 is why the
observed figures were not adopted as a production value either.

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

Until then the existing production capacity value stays unchanged and RESOURCE_AWARE stays off.

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

### B7. Stage 1 hardening (post-review)

Applied after management's review of the Stage 1 delivery.

**Observable classification failures (§3).** The verdict is now three-valued:
`TEST` / `GENUINE` / `UNKNOWN`. `UNKNOWN` means the lookup itself failed — which is
*not* the same as "this is a genuine customer", and is no longer recorded as if it
were. It still delivers (a real customer must not be silently cut off), but it
also writes a structured error log and an `AuditLog` row
(`NOTIFICATION_TEST_CLASSIFICATION_UNAVAILABLE`) carrying the notification id, the
entity, the customer/vehicle ids, the channel, the template and the failure
reason. An audit-write problem never blocks the customer message.

**Explicit test context takes precedence (§3).** `QueueNotificationInput.testContext`
travels with the request and wins outright — including over a database lookup that
failed — because the caller already knows it is a test. This is the mechanism
Stage 3's UAT booking session will use, and it is the long-term direction:
propagate a known test context through the workflow rather than rediscovering it
from related rows on every message.

**Authorization boundary (§4).** Reading captured content means reading what a
customer would have been told, including their address. It moved off `CONFIG_VIEW`
(semantically "view configuration", and a boundary that would silently widen if it
were ever granted to advisors) onto a dedicated `NOTIFY_CAPTURED_VIEW`. ADMIN
holds every permission, so the effective audience is unchanged today — Manager
only — but the boundary is now the right one. Access is audited
(`NOTIFICATION_CAPTURED_VIEWED`: who, which run, when) and paginated
(`take` 1–200, default 50, plus `skip`). Content is deliberately **not** masked:
an authorised tester has to verify the exact wording a customer would receive.

**Cleanup participation (§5) — no schema change needed.** A CAPTURED row holds the
full rendered message and the real recipient address, so it must leave with its
test run. It already does: `NotificationLog` is polymorphic on `entityId`, the
manifest collects it over every id the run created (including the run's
Appointments, which are collected from the run's customers), and it is deleted
first in `CLEANUP_DELETE_SEQUENCE`. Tests now pin each link in that chain so it
cannot be broken silently. Retained UAT evidence, if we ever want it, must be an
explicit export — not database residue left behind by an incomplete cleanup.

**Migration (§2).** `ALTER TYPE ... ADD VALUE IF NOT EXISTS` is idempotent and
re-runnable; PostgreSQL 12+ permits it inside Prisma's transaction, and the value
is not used in that same transaction. Deployment order (migrate → generate →
start) means no running process writes `CAPTURED` before the type carries it. The
rollback procedure is documented in the migration file, together with the reason
the preferred rollback is to leave the unused value in place: rewriting captured
rows to `FAILED` would misrepresent withheld test messages as failures.

**`CAPTURED` display (§2).** Added to the web status maps
(`communication-history.tsx`, `notification-composer.tsx`) as "Test capture — not
sent". The duplicate-contact guard and "last contacted" queries filter on
`SENT`/`DELIVERED`/`MANUAL` and therefore already exclude it — a captured message
correctly does not count as having contacted anybody.

**Global mode coverage (§7).** The production/non-LIVE deployment failure now has
automated coverage asserting it fails rather than warns, names the consequence,
and defaults to `TEST` when unset so an unconfigured production deploy still fails.

### B8. Carried into Stage 3 scope — UAT booking session

The first-time-customer gap is **not** accepted as permanent. Booking as a
pre-tagged customer converts the scenario into an existing-customer workflow and
therefore does not test the brand-new-customer path at all.

Stage 3 will add an administrator-generated **UAT booking session**: from the
Booking Simulator, an authorised tester launches the *real* `/book` flow carrying
a signed, unguessable, short-lived test context. A completely new customer and
vehicle created through that flow receive the `testDataRunId`, the appointment
stays associated with the test context, its notifications are CAPTURED, the
records are excluded from operational KPIs, and standard test-run cleanup removes
them.

Constraints fixed now so Stage 3 cannot drift:

- no simple `?test=true` parameter;
- customers and the public must not be able to manufacture a test session;
- the token is signed, unguessable and expiring;
- `/book` behaves exactly as today when no valid UAT context is present;
- it uses the real public booking controllers and services — never a
  simulator-only parallel booking path.

`testContext` on the notification input (§B7) is the first piece of that
mechanism, delivered early because it also hardens the resolver-failure case.

---

## §C. Stage 2 — internal availability decision / reason model

### C1. The defect

The engine answered `available: boolean`, and slots it rejected on timing were
**never returned at all**: a `continue` for anything inside the minimum notice, a
`break` at the customer cutoff, and the loop simply stopped before close. So when
a customer said "there was nothing on Tuesday", the reason had not merely been
discarded — it had never been computed. Nothing in the system could answer it.

### C2. The model

`scheduling/availability/slot-decision.ts` defines the internal vocabulary:

- **`SlotReasonCode`** — the full set, declared once even though later stages emit
  some of it, so consumers, tests and the simulator are written against a stable
  vocabulary instead of string literals that grow stage by stage. Each entry
  records which stage produces it.
- **`SlotDecision`** — `startAt`, `endAt`, `available`, `reasonCode`,
  `plannedMinutes`, `capacity { before, after, limit, reserved?, resourceCapacity? }`,
  `rule` (the setting that decided, e.g. `booking_min_notice_minutes=120`) and
  optional `diagnostics`.
- **`DayDecision`** — carries its own `reasonCode`, so `CLOSED_WEEKDAY`,
  `CLOSED_DATE` and `SAME_DAY_NOT_ALLOWED` are three distinct answers rather than
  one `closed: true`. They are three different conversations with a customer.
- **`AvailabilityDecision`** — the window, with the first available slot called out.

`computeDayDecision` is now the primary computation and **walks the whole grid to
close** — the early `break` is exactly how the reason went missing. `PAST` is kept
distinct from `MINIMUM_NOTICE`: for staff (no notice requirement) "too soon" really
is just "in the past", and conflating them would misreport the staff view.

### C3. The boundary

`toCustomerAvailability` is the only route to a customer surface, and it projects
down to exactly the shape `/book` already consumed — built field by field, never
spread, so no future diagnostic anyone adds to `SlotDecision` can ride along.

Two deliberate rules:

1. **No reason codes, capacity, rules or diagnostics reach a customer.** A customer
   is told a time is unavailable, never that the shop is full, how full, which bay
   is missing or which policy stopped them. Publishing that would let anyone map
   the workshop's load and staffing from a public page.
2. **Timing-excluded slots stay omitted** (a past slot was never a candidate, and
   greying it out is noise on a phone); **capacity-blocked slots stay listed** so
   the customer can read the shape of the day and pick another time. That is the
   pre-CR behaviour, preserved exactly.

`BookingAvailabilityService.availability()` returns the projection for both the
public page and staff; `availabilityDecision()` returns the rich form for admin
tooling. Stage 3's simulator calls the latter — the *same* computation, not a
re-implementation of it.

### C4. Evidence

- 14 new tests: every reason code emitted, capacity arithmetic, the three day-level
  reasons, PAST vs MINIMUM_NOTICE, plus a leak test asserting no reason code,
  capacity value, rule string or `diagnostics` key appears anywhere in the
  customer payload.
- An equivalence test pins `computeAvailability` ≡ `toCustomerAvailability(decision)`,
  so the public answer cannot drift from the rich one.
- All 13 pre-existing engine tests pass untouched.
- Live, against the running API — both surfaces byte-identical to before:

```
/book   top keys : audience, days, latestStartLabel, nextAvailable, plannedMinutes, range, timezone
        day keys : availableCount, closed, date, slots
        slot keys: available, endAt, startAt
        leaks    : NONE
staff   (identical)
```

Full API suite: **1284 passed**.

---

## §D. Stage 3 — Admin Booking Simulator and the UAT booking session

### D1. The simulator

`Setup → Booking Simulator` (`/admin/testing/booking`), API under
`/admin/testing/booking`, gated on a dedicated **`BOOKING_SIMULATE`** permission.

It calls `BookingAvailabilityService.availabilityDecision` — the **production**
service — and renders the internal decision for every candidate slot: the reason
code, a plain-language explanation, capacity before/after against the limit, and
the rule that decided (`booking_min_notice_minutes=120`). It holds no availability
logic of its own; a simulator that re-implemented the rules would be explaining a
system that does not exist.

Verified live — 54 slot decisions over 2 days returning `AVAILABLE`,
`MINIMUM_NOTICE`, `CUSTOMER_LATEST_START` and `OUTSIDE_OPENING_HOURS`, each with
its capacity arithmetic. Advisor gets 403, anonymous 401.

### D2. FIXED vs SHADOW — an honest empty column

The page shows **Production model: FIXED** and **Shadow model: Not yet available**,
with the reason stated on screen.

The resource-aware engine is Stage 5 and does not exist. Populating the shadow
column with a partial calculation would be worse than leaving it empty: it would
*look* like evidence, and shadow mode exists precisely to decide whether the real
model can be trusted. The presentation contract is built now, so Stage 5 fills it
in without the interface changing.

### D3. The UAT booking session — closing the brand-new-customer gap

Stage 1 suppressed notifications by resolving `testDataRunId` from the customer,
vehicle or visit a message was about. That covers a RETURNING test customer and
**not at all** the case most worth testing: a genuinely brand-new customer, who
has no anchor to resolve. Booking as a pre-tagged customer does not close it
either — that is the existing-customer code path.

So an administrator mints a session from the simulator and launches the **real**
`/book` flow inside it:

```
Simulator → Start UAT session → signed token (30 min)
          → /book?uat=<token>   ← the real public page, unchanged
          → brand-new Customer + Vehicle tagged to the test run
          → confirmation CAPTURED, never transmitted
          → standard test-run cleanup removes everything
```

Constraints honoured:

- **No `?test=true`.** The capability is a JWT signed with the server secret,
  carrying the run id, the label and the issuing user, with its own `kind` so a
  customer booking session can never be used as one.
- **Unverifiable means ABSENT.** A bad signature, an expired token, the wrong
  kind or missing claims all resolve to "no UAT context", and the booking proceeds
  as a real one. That is the safe direction: a tester's booking behaving like a
  real booking is loud and recoverable, whereas honouring a forged token would let
  a stranger book invisibly — never notified, outside operational reporting, and
  deletable by a cleanup that believed the records were disposable.
- **The real controllers.** `/book` is untouched apart from reading the token from
  the URL and passing it through; there is no simulator-only booking path.
- **Attributable.** Every session writes `UAT_BOOKING_SESSION_STARTED` naming who
  authorised it.

The notification carries `testContext` explicitly rather than waiting for a lookup
to rediscover a tag written moments earlier in the same request — the §B7
mechanism, now used end to end.

Verified live: brand-new customer booked, customer and vehicle tagged, 2
notifications CAPTURED with nothing transmitted; the same booking without a token
produced `SMS=SENT, EMAIL=SENT` untagged; **a forged token was ignored and the
booking stayed genuine**.

### D4. Shadow comparison table — schema agreed, migration DEFERRED to Stage 5

Management's decision: a dedicated table, not application logs, because the
purpose is analytical review before RESOURCE_AWARE can ever be trusted. The
migration is deliberately **not** created here — the resource-aware fields cannot
be pinned before the Stage 5 engine exists, and guessing them would mean altering
a core table twice. The agreed shape:

| Column | Notes |
| --- | --- |
| `id`, `siteId`, `observedAt` | |
| `slotStartAt`, `slotEndAt` | the decision's window |
| `serviceTypeCode` | never the customer's service *request* text |
| `vehicleClass` | nullable; class only, never the vehicle |
| `plannedMinutes` | |
| `fixedAvailable`, `fixedReasonCode` | production answer |
| `shadowAvailable`, `shadowReasonCode` | resource-aware answer |
| `fixedCeiling` | the concurrency limit applied |
| `resourceCapacity` | computed capacity-contributing positions |
| `fallbackUsed`, `fallbackReason` | resource configuration incomplete |
| `bookingConfigHash`, `resourceConfigHash` | so a disagreement is attributable to the configuration that produced it |
| `source` | `SIMULATOR` or `AVAILABILITY` |

**No customer PII** — no name, phone, email or plate. A shadow row describes a
capacity decision, not a person.

**Recorded selectively.** Persisting every candidate slot of every availability
request would be millions of identical rows. Only materially interesting rows are
written: FIXED available / SHADOW blocked, FIXED blocked / SHADOW available, both
blocked for different operational reasons, a material capacity difference, or a
resource-aware fallback. Aggregate agreement rates come from counters, not from
retaining every identical decision.

**Retention: 90 days**, sufficient for an operational review window, with a
scheduled purge. This is diagnostic data, not an operational record.

### D5. Stage 3 hardening — launch/exchange, and no silent downgrade

Applied after management's review.

**The token no longer lives in the URL.** A launch token is a privileged
capability: it makes bookings disposable and silences customer notifications. In
an address bar it is copied into history, bookmarks, referrers and screenshots,
and stays valid for anyone who finds it. So it is now redeemed once and exchanged:

```
launch token (single use, <= 30 min, in the URL for ONE request)
  -> POST /public/booking/uat/redeem
  -> bsop_uat cookie: HttpOnly, Secure + SameSite=None in production
  -> window.history.replaceState -> clean /book
  -> the rest of the booking runs on the cookie
```

`ConfirmBookingDto` has **no** UAT field at all — the context can only come from
the cookie, never from a body the page could set. The cookie is read from the raw
`Cookie` header rather than adding `cookie-parser`: it is the only cookie the
platform reads, and a new dependency in a core flow needs approval it does not
warrant.

**Single use is enforced in the audit log, not in memory.** Redemption records the
token's `jti`; a second attempt is refused. Recording it in the database means a
restart cannot re-open the window — and the redemption is evidence in its own
right, which a fingerprint in a process would not be.

**An invalid attempt is refused, never downgraded.** This is the dangerous case
the review identified: an expired link, a tester who believes UAT is active, and a
booking that quietly becomes a real customer who is really texted and really
counted. So `/book` now blocks:

> This test booking session is invalid or has expired. Return to the Booking
> Simulator and start a new UAT session.

…with a separate link for anyone who actually meant to book. No token or
cryptographic detail is exposed — the endpoint must not become an oracle for
token validity, so every rejection returns one message while the reason goes to
the log. Absent token still means an ordinary booking; that path is unchanged.

An active session is also unmistakable on the page: a banner naming the run and
stating that nothing reaches a real customer. A tester who cannot tell whether
they are in a session is exactly how a real customer gets contacted.

**Evidence (live, then cleaned up):**

```
 2. redeemed -> bsop_uat cookie; attrs: Path=/, Expires=…, HttpOnly, SameSite=Lax
 3. replay refused: HTTP 400 UAT_SESSION_INVALID
 4. booked BK-B01-260916-009 on the cookie alone — records tagged, 2 CAPTURED
 5. no cookie => genuine: SMS=SENT, EMAIL=SENT, untagged
 6. forged / malformed / empty tokens all refused, no cookie set, one safe message
```

(`SameSite=Lax` above is the local-development value; production uses
`Secure; SameSite=None`, which is the only combination a browser accepts for the
cross-origin hop between the booking page and the API. Pinned by test.)

24 token tests including the mandated replay test. Full API suite: **1308 passed**.
