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
| 4A | Catalogue capability, enforcement OFF (§E) | complete |
| 4B | Catalogue readiness audit (§F) | complete — awaiting review |
| 4C | Pilot catalogue configured (§G) | complete |
| 4D | Preflight + public preview (§G4) | complete — awaiting review |
| 4E | Enforcement ON — six-service public catalogue (§H) | complete |
| 4F | DEFAULT vs CATALOGUE impact analysis (§I) | complete — HOLD recommended |
| 5A | Resource truth audit (§J) | complete — MANAGEMENT REVIEW GATE |
| 5B | Resource registry bridge — DESIGN PROPOSAL (§K) | awaiting approval |
| 5C–5D | SHADOW engine, validation | blocked on 5B approval |
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

---

## §E. Stage 4A — catalogue capability, with enforcement OFF

### E1. The trap this avoids

`bookableOnline` has to default to **false**: a diagnostic or highly variable
repair must be enabled deliberately, never inherited from `isActive`. But that
same default would empty the public service list the instant the migration landed
— online booking silently offering nothing, with no error anywhere.

So the column and the behaviour are separated. Stage 4A ships the capability; a
configuration key decides when it bites.

### E2. What shipped

**Schema** (additive, no backfill, nothing a customer sees changes):

| Column | Default | Meaning |
| --- | --- | --- |
| `bookable_online` | `false` | may a CUSTOMER book this online |
| `customer_facing_name` | `null` | what a customer is shown; null = use `name` |
| `booking_buffer_minutes` | `0` | workshop turnaround, added to SCHEDULING occupancy only |

**Activation key** `booking_enforce_online_bookable`, seeded **false**. While
false, `listServices` applies exactly the pre-CR filter (`isActive`, not external,
not excluded). When true it additionally requires `bookableOnline`. The switch is
configuration — flipped from Settings, never by a redeploy.

**Admin controls** on Setup → Services: an Online column, the customer-facing name,
and the buffer, all editable inline and audited through the existing
`SERVICE_TYPE_UPDATE` path.

**Customer-facing name** is used by `/book` when set, falling back to the internal
name — and a blank/whitespace value counts as unset, so a half-filled field can
never render an empty service name to a customer.

### E3. Duration vs occupancy — kept separate (§9)

`bookingBufferMinutes` is workshop turnaround, not repair time. A 60-minute
service with a 15-minute buffer will occupy **75 minutes of capacity** while the
customer is still told **60**. Telling a customer their oil change takes 75
minutes because the bay needs cleaning afterwards would simply be untrue.

Stage 4A stores the value and shows it to administrators; nothing consumes it yet.
It is wired into the availability calculation in 4F, alongside the DEFAULT →
CATALOGUE duration switch, so that the two concepts —
`plannedServiceMinutes` (quoted) and `schedulingOccupancyMinutes` (reserved) —
are introduced together rather than half-applied.

### E4. Evidence

Live, after migrating and seeding, with **zero** services marked bookable and
enforcement off:

```
booking_enforce_online_bookable : false
bookable_online services        : 0  (of 31 active)
/book services offered          : 30   ← unchanged
```

10 tests: the rule is registered and defaults off; junk falls back to off; legacy
mode adds no `bookableOnline` filter at all; enforced mode adds it and still
honours the existing exclusions rather than replacing them; customer-facing name
used, falls back, and treats blank as unset. Full API suite: **1318 passed**.

### E5. Still to come (4B–4F)

4B readiness audit · 4C explicit configuration of approved services · 4D
activation preflight + public-catalogue preview · 4E enable enforcement · 4F
DEFAULT vs CATALOGUE duration preview, then the duration switch.

No service has been made bookable, and no starting set has been seeded — that is
management's decision after the readiness audit, not a default.

---

## §F. Stage 4B — Catalogue Readiness Audit

Read-only decision support at Setup → Services → Catalogue Readiness. It writes
nothing — not `bookableOnline`, not a name, not a duration. Tests assert that,
including a static guard that the service file contains no mutating Prisma call.

### F1. Cookie policy review (carried out first)

`SameSite=None` is no longer the production default. There is no cross-site
embedding and no cross-site booking flow, and https alone is not a reason to
widen a cookie. **Lax is now the default everywhere**, with `UAT_COOKIE_CROSS_SITE`
as an explicit opt-in for the one case that genuinely fails under it: web and API
deployed as separate services under a public-suffix host, where each subdomain is
its own registrable domain. Render's default `bsop-web.onrender.com` /
`bsop-api.onrender.com` pair is exactly that, so render.yaml sets it — with a note
to remove it on a shared custom domain.

The review also found a real gap: the cookie outlived the booking it was for. A
tester's NEXT booking in the same browser — a real one — would have been silently
tagged as test data and the customer never told anything. The cookie is now
cleared the moment a UAT booking completes.

### F2. What the audit found

31 active services · 30 offered to customers today · 0 marked bookable online.

| Readiness | Count |
| --- | --- |
| Ready for review | 16 |
| Needs configuration | 6 |
| Not suitable for direct self-service | 9 |

**The 31st service** is `MSHOP-01` Machine Shop Work, excluded by the existing
`isExternal` filter — nothing to do with the new flag.

**Nine of the 30 currently offered should not be.** The legacy behaviour is
exposing too much:

| Code | Name | Why not |
| --- | --- | --- |
| ENG-01, GEN-01, ELE-01, TRANS-01 | the four Diagnostics | Scope, and therefore duration, is unknown until the vehicle is examined |
| WIPER-01, AIR-FLT-01, OIL-FLT-01 | package sub-operations | `INCLUDED_NO_ADDITIONAL_BENCHMARK` — absorbed by a larger service, not a job a customer books alone |
| EST-01 | Estimate / Inspection | An assessment carried out before the work is known |
| MSHOP-01 | Machine Shop Work | External |

The package-component verdicts use the **existing** KPI component-role data, not
a new relationship model.

**Six need configuration**, all for reasons a customer would feel:

- `BEL-01` "Belt / Hose Replacement" vs `BELT-01` "Belt Replacement" — indistinguishable.
- `SHOCK-01` "Shocks Replacement" vs `SUSP-02` "Shock / Strut Replacement" — indistinguishable.
- `ENG-02`, `RACK-01`, `SUSP-02` at 180 minutes — long and likely variable. Flagged as
  a documented heuristic, explicitly not a business rule.

### F3. Evidence quality — the headline

**There is no per-service historical duration evidence at all.** All 9,055
imported job records carry zero service-type lines, so nothing can be attributed
to a service. The only per-service timing comes from 68 orders performed on this
platform, which is far too small to set a duration from.

Every service therefore shows `LIVE_PLATFORM: n=0..1` and
`HISTORICAL_IMPORT: n=0`, marked insufficient rather than printing a median next
to a sample of one. Catalogue durations must be reviewed by people who know the
work — they cannot be derived from this data, and the audit says so on screen.

### F4. Method

Deterministic rules, categorical verdicts, explicit reasons — **no numeric score**.
A score would average away the single fact that disqualifies a service: a perfect
name does not offset an unknowable three-hour scope.

Two refinements after the first run, both from reading real output:

- Structural unsuitability is decided **first**, so a service that will never be
  offered cannot make another look ambiguous. "Oil Change" was being flagged
  against "Oil Filter Change", which is a package component no customer will see.
- Crude singular/plural folding, without which "Shocks Replacement" and
  "Shock / Strut Replacement" did not compare.

### F5. Known limitation

`BRK-02` "Brake Pad Replacement" (90m) and `DISC-01` "Disc Pad Change" (60m) are
plausibly the same work at two durations, and the name heuristic does **not** catch
them — they share only one distinctive token. Raising the sensitivity enough to
catch it produced false positives elsewhere, so it is reported here for human
review rather than tuned for. Both appear in the proposed set; management should
decide whether both belong on a public page.

---

## §G. Stage 4C — pilot catalogue configured, and 4D preview

### G1. BRK-02 vs DISC-01 — the question was already settled in the codebase

Investigated through catalogue relationships, KPI component configuration, order
usage and appointment references, as instructed — not from the names.

| | BRK-02 | DISC-01 |
| --- | --- | --- |
| Name | Brake Pad Replacement | Disc Pad Change |
| Duration | 90 min | 60 min |
| Component role | `FRONT_BRAKES` | `FRONT_BRAKES` |
| Axle qualifier required | yes | yes |
| Skill / batching family | BRAKE / BRAKES | BRAKE / BRAKES |
| Parts pre-position | yes | yes |
| **Order lines, all history** | **3** | **0** |
| **Appointment services** | **2** | **0** |

They are **aliases for the same work**, and the platform already treats them so.
`package-detection.ts` says it outright: *"DISC-01 and BRK-02 both describe front
pad work. Both map to FRONT_BRAKES, and the component counts ONCE even if both
are on the order — one set of pads earns one brake allowance."* The KPI seed adds
that DISC-01 was *"never used on a work order in the whole history, so it is
marked superseded to keep it out of new bookings while historical lines stay
intact"*, and that BRK-02 is *"the code actually used on work orders"*.

**Recommendation: BRK-02 is canonical. DISC-01 should never be publicly bookable**,
and is a candidate for `isActive = false` in a separate change. Nothing was
deleted or merged. Both remain `bookableOnline = false`.

The 30-minute duration gap (90 vs 60) is unresolved and cannot be settled from
data — there is no per-service evidence for either. It needs someone who does the
work.

### G2. The pilot — six services

Applied by `pnpm booking:pilot-catalogue --commit`: idempotent, audited
(`SERVICE_TYPE_UPDATE` with `reasonCode: SELF_SERVICE_PILOT_CATALOGUE`), and
kept in git so the same decision can be applied to the manager's deployment
rather than retyped.

It is **not** in the seed. `bookableOnline` is a management decision, and seeding
it would resurrect this list every deploy and silently overrule a manager who
later enabled or withdrew a service — the same defect class as CR-2026-095's
technician roster.

| Code | Customer sees | Catalogue | Buffer |
| --- | --- | ---: | ---: |
| OIL-01 | Oil Change | 30m | 0 |
| TIR-01 | Tire Rotation | 25m | 0 |
| BRK-01 | Brake Inspection | 30m | 0 |
| TIR-02 | Wheel Alignment | 60m | 0 |
| INSP-01 | Pre-Purchase Vehicle Inspection | 75m | 0 |
| CLEAN-01 | Vehicle Cleaning | 30m | 0 |

The script refuses to enable anything inactive, external, or without a usable
duration — a guard against a future edit of the list.

### G3. Verified state

```
active services                 : 31
bookableOnline = true           : 6   (exactly the approved codes)
booking_enforce_online_bookable : false
appointment_duration_source     : DEFAULT
BRK-02 bookable=false · DISC-01 bookable=false
live /book right now            : 30 services
after enforcement would be      : 6 services
```

**One visible change on /book**, and only one: `INSP-01` now displays
"Pre-Purchase Vehicle Inspection" instead of "Pre-Purchase Inspection". The
customer-facing name is used whenever it is set, independently of enforcement —
naming is presentation, not gating. The other five names are identical to their
internal ones, and the SET of services offered is unchanged at 30.

### G4. Stage 4D — preflight and public preview

Both on the Catalogue Readiness page.

**Preflight** refuses the failure it exists for — enforcement on with nothing to
offer — plus an enabled service with no usable duration, no name to fall back on,
or marked external. Current result: **passes**.

**Preview** shows exactly the six, with two duration columns side by side:

| Customer sees | Catalogue | Plans today | Plans if CATALOGUE |
| --- | ---: | ---: | ---: |
| Brake Inspection | 30m | **80m** | 30m |
| Vehicle Cleaning | 30m | **80m** | 30m |
| Pre-Purchase Vehicle Inspection | 75m | **80m** | 75m |
| Oil Change | 30m | **80m** | 30m |
| Tire Rotation | 25m | **80m** | 25m |
| Wheel Alignment | 60m | **80m** | 60m |

"Plans today" is what the scheduler actually reserves now. Configuring a catalogue
duration has **not** changed production scheduling and will not until
`appointment_duration_source` is switched separately (Stage 4F).

**CLEAN-01 is flagged** as §9 asked: it uses a GENERAL service bay, so cleaning
appointments would consume the same scarce mechanical capacity as repair work.
Flagged for assessment during resource-aware capacity — deliberately not solved
by inventing a resource type.

### G5. Live duration evidence (§10)

The platform already records what is needed: `TechnicianWorkSegment` (40 closed
segments) and `ServiceOrderPause`. What was missing is that the audit measured
**elapsed** time.

It now measures **active labour**: the UNION of a job's work segments. A segment
ends when work stops — a pause, a parts wait, the end of a shift — so the union is
time a technician was actually on the vehicle. The union and not the sum, because
two technicians working together is still one occupied bay-hour. Elapsed includes
every hold and would report a job that waited overnight for a part as a twelve-hour
job; it remains the fallback for orders with no segments, labelled `ELAPSED` so
the two bases are never silently mixed.

That is what makes the future review possible: `Oil Change · catalogue 30 · live
n=47 · median active 27 · p75 32`, rather than manual estimates indefinitely.

---

## §H. Stage 4E — enforcement ON

### H1. A gap found before activating

`listServices` filtered on `bookableOnline`, but `resolveServices` — the resolver
behind **availability and confirm** — did not. Enforcement would have been
cosmetic: the page would stop offering a diagnostic while the API still accepted
one posted directly. `resolveServices` now applies the same predicate when the
rule is on.

### H2. Grandfathering is structural, not a special case

`rescheduleByCustomer` takes its services from the appointment
(`appt.services.map((s) => s.serviceType)`) and never calls `resolveServices`;
`cancelByCustomer` and the manage view never re-validate either. So an existing
booking for a service that is no longer publicly offered can still be viewed,
moved and cancelled — without a grandfathering branch existing anywhere.

`bookableOnline = false` means **"a customer cannot START a new booking for
this"**, never "this appointment is now stuck". Tests pin the structure, because
the tempting tidy-up of routing reschedule through the shared resolver would
silently strand every such customer.

### H3. Verified live, end to end

```
 1. BEFORE: enforcement off, /book offers 30 services
 2. legacy booking BK-B01-260916-011 created for SPK-01 (about to become non-public)
 3. enforcement ON (configuration only — no redeploy, no restart)
 4. AFTER: /book offers exactly 6
 5. all six produce valid availability responses
 6. grandfathered manage page opens and still shows Spark Plug Replacement
 7. grandfathered RESCHEDULE works and keeps SPK-01 — not switched to another service
 8. grandfathered CANCEL works
 9. new booking for ENG-01 refused by the API: HTTP 400
10. availability for ENG-01 refused: HTTP 400
11. staff unaffected: 31 services internally, ENG-01 still schedulable (80m)
```

No diagnostics, no package components, no DISC-01, no BRK-02. Staff eligibility is
untouched — `bookableOnline` is a customer rule, and `appointments.service.ts`
never reads it (pinned by test).

---

## §I. Stage 4F — DEFAULT vs CATALOGUE impact

`pnpm booking:duration-impact`. Read-only: the two models are compared by handing
the **same production availability service** two in-memory rule sets. The database
rule is never touched, and production stayed on DEFAULT throughout.

### I1. Slot counts barely move — and that is misleading

| Service | Catalogue | Slots DEFAULT | Slots CATALOGUE | Δ |
| --- | ---: | ---: | ---: | ---: |
| Oil Change | 30m | 225 | 229 | +1.8% |
| Tire Rotation | 25m | 225 | 229 | +1.8% |
| Brake Inspection | 30m | 225 | 229 | +1.8% |
| Wheel Alignment | 60m | 225 | 227 | +0.9% |
| Pre-Purchase Vehicle Inspection | 75m | 225 | 225 | 0% |
| Vehicle Cleaning | 30m | 225 | 229 | +1.8% |

**+1.3% overall — and it means almost nothing.** The calendar is nearly empty, so
a shorter job only adds the few extra starts that still fit before closing. Slot
count is the wrong measure on an empty diary.

### I2. Saturation — the number that matters

How many bookings ONE day absorbs before refusing another:

| Scenario | DEFAULT | CATALOGUE | Change |
| --- | ---: | ---: | ---: |
| A short-service heavy | 12 | **22** | **+83%** |
| B mixed | 12 | **18** | **+50%** |
| C long-service heavy | 12 | **14** | +17% |

Peak concurrency stays at 2 in every case — the policy guard holds. What changes
is **throughput**: on a short-service day the shop would accept nearly twice as
many vehicles.

### I3. Slot-grid arithmetic — all checks pass

Durations are used as configured and never rounded to the 20-minute grid.

```
PASS  25m at 10:00 blocks an overlapping 10:20 start    FIXED_CAPACITY_REACHED
PASS  ...and 10:40 is free again (no over-blocking)     AVAILABLE
PASS  30m blocks 10:20
PASS  30m leaves 10:40 free
PASS  back-to-back does not overlap                     peak=0
PASS  75m never offers a start finishing after close    last start 20:40Z
PASS  ...and the tail is reported, not silently dropped 3 slots OUTSIDE_OPENING_HOURS
PASS  a 25m service occupies 25m, not rounded           25m
```

### I4. CLEAN-01

Vehicle Cleaning requires a **GENERAL** bay, and the FIXED model counts service
POSITIONS rather than bay types — so a cleaning booking consumes one of the same
positions a repair would. Under CATALOGUE it holds a full position for 30 minutes.
Whether that is acceptable is a resource question; no CLEANING resource type
exists and inventing one now is Stage 5.

### I5. ETA effect

| Service | Planned DEFAULT | Planned CATALOGUE | Initial ETA shifts |
| --- | ---: | ---: | ---: |
| Oil Change | 80m | 30m | −50m |
| Tire Rotation | 80m | 25m | −55m |
| Brake Inspection | 80m | 30m | −50m |
| Wheel Alignment | 80m | 60m | −20m |
| Pre-Purchase Vehicle Inspection | 80m | 75m | −5m |
| Vehicle Cleaning | 80m | 30m | −50m |

Planned duration is what the scheduler **reserves**. The ETA a customer sees after
arrival comes from the live model, which re-estimates from actual progress — this
is the starting input, not a promised finish time. Buffers stayed at 0; none were
derived.

### I6. Recommendation: **HOLD**

Not because the model is wrong. The arithmetic is correct, the grid handles
25/30/75-minute jobs properly, nothing is rounded, and no service loses slots.

The reason is §I2. CATALOGUE would let the shop accept **up to 83% more vehicles
per day**, and the ceiling that would absorb them —
`booking_max_concurrent_appointments = 2` — is the placeholder this CR already
declined to change, because its evidence turned out to be 6.9% coverage with 624
of 626 records from a legacy import (§A). Switching duration source now would
multiply throughput against a number nobody has validated.

The safe order is **Stage 5 resource audit → a validated capacity figure → then
CATALOGUE**. At that point re-run `pnpm booking:duration-impact`; it is repeatable
and costs nothing.

Production remains on `appointment_duration_source = DEFAULT`.

---

## §J. Stage 5A — Resource Truth Audit

Read-only. `GET /resources/truth-audit` (`RESOURCE_MANAGE`). It proposes a capacity
classification for every resource and states what only management can confirm.
Nothing here becomes production capacity on its own, and no schema was changed.

### J1. Three different capacity numbers are in play

| Source | Capacity |
| --- | ---: |
| Production today (`booking_max_concurrent_appointments`) | **2** |
| What RESOURCES mode would compute, unaudited | **13** |
| What this audit proposes, pending confirmation | **7** |

The 13 is the number this audit exists to stop anyone adopting by accident.

### J2. Two resource models, and scheduling uses the OTHER one

- `WorkResource` — 17 rows, **0** technician assignments have ever referenced one.
- `WorkBay` (legacy) — 6 rows, **62** assignments reference it.
- `ResourceReservation` — **0** rows.
- `ResourceOperationalStatus` — **0** rows; every resource reads `NOT CONFIGURED`.

**`ServiceType.requiredBayType` speaks the LEGACY vocabulary** (GENERAL, LUBE,
ALIGNMENT, DIAGNOSTIC, INSPECTION, TIRE) — not `WorkResource.resourceCategory`
(BAY, OVERFLOW, LIGHT_SLOT, POWER_WASH, EXTERNAL). A resource-aware engine built
on `WorkResource` would be reasoning about rows the shop has never used, in a
vocabulary the catalogue does not speak.

**This must be resolved before Stage 5B.** It is the single largest risk in Stage 5.

### J3. Proposed classification

| Resource | Category | Proposed role | Counts? |
| --- | --- | --- | --- |
| BAY-01/02/03 | BAY | PRIMARY_SERVICE_POSITION | yes |
| BAY-04 Mobile Lift | BAY | PRIMARY_SERVICE_POSITION | yes (SEDAN only) |
| BAY-05 Power Jack | BAY | SUPPORT_EQUIPMENT | no |
| BAY-06 / BAY-07 "(TBD)" | BAY | PLACEHOLDER_TBD | **no** |
| MJACK-01/02 | BAY | SUPPORT_EQUIPMENT | no |
| STAND-01/02 | BAY | SUPPORT_EQUIPMENT | no |
| OVF-01/02 | OVERFLOW | OVERFLOW_SERVICE_POSITION | yes |
| LT-01/02 | LIGHT_SLOT | SUPPORT_EQUIPMENT | no |
| PWASH-01 | POWER_WASH | PRIMARY_SERVICE_POSITION | yes |
| MSHOP-EXT | EXTERNAL | EXTERNAL | no |

**What inflates capacity today:** six rows in the `BAY` category are not vehicle
positions — two jacks, two stands, a power jack and two TBD placeholders. Counting
them is exactly how one vehicle on a jack with two stands becomes four bookings.
The SEDAN-only restriction on the mobile jacks is preserved as a vehicle-class
constraint regardless of how they are classified.

### J4. Bay-type coverage — the specialty bottleneck is real

| Required | Services | Pilot services | Active bays | |
| --- | ---: | ---: | ---: | --- |
| GENERAL | 23 | 3 | 2 | |
| ALIGNMENT | 1 | 1 | **1** | Wheel Alignment is a pilot service |
| LUBE | 1 | 1 | **1** | Oil Change is a pilot service |
| INSPECTION | 1 | 1 | **1** | Pre-Purchase Inspection is a pilot service |
| DIAGNOSTIC | 4 | 0 | 1 | |
| TIRE | 1 | 0 | **0** | required by a service, no bay exists |

Three of the six pilot services sit on a **single** position each. Under FIXED
capacity 2, two overlapping Wheel Alignments are accepted today with one alignment
bay — the exact failure Stage 5 is meant to prevent.

### J5. Technician data cannot be trusted as a constraint

- 17 active accounts, 1 inactive.
- **0 shift/attendance records.** The platform does not know who is on shift.
- 10 of 12 skill codes are held by 70%+ of technicians — seeded breadth, not a
  skill matrix. The only discriminating skills are `AC` and `COOLING`, one
  technician each, and both are unverified.

**The maximum simultaneous technician count the data can substantiate is UNKNOWN.**
A roster is not an attendance record. Technician capacity must not become a
limiting constraint until shift data is maintained.

### J6. Arrival capacity vs active-work capacity — they are conflated

Traced through `check-in.service.ts`: check-in creates a `ServiceVisit`
(`CHECKED_IN`) and a `QueueTicket`. **No bay or resource is assigned at booking
time or at check-in.** The vehicle joins the queue and waits for a technician.

So operationally the platform is model **B** — an arrival appointment that queues
before active service — while `booking_max_concurrent_appointments` is applied as
model **A**, holding a position for the whole planned duration. An 80-minute
booking "occupies" 10:00-11:20 in the engine even though the vehicle may not start
work until 10:40.

The single key is doing two jobs. The honest split is:

- **arrivals per interval** — how many vehicles the front desk can receive and
  process at once;
- **concurrent work positions** — how many vehicles can physically be worked on.

Recommended before Stage 5B: confirm which the current `2` was meant to express.
No new key has been introduced — that is the decision being returned.

### J7. Proposed minimal changes (none applied)

1. **Decide the authoritative resource model** (J2). Everything else depends on it.
2. **A capacity role on the resource** — the smallest addition that makes J3
   durable. `WorkResource.capacityRole` as an enum
   (`PRIMARY | OVERFLOW | SUPPORT_EQUIPMENT | PLACEHOLDER`), defaulting to
   `SUPPORT_EQUIPMENT` so nothing counts until someone says it does. No existing
   field carries this: `resourceCategory` is a type, not a capacity contract, and
   `schedulingEnabled` means "may receive work", which a jack legitimately can.
3. **Populate `ResourceOperationalStatus`**, currently empty for all 17 — Case 8
   (out-of-service immediately reduces capacity) cannot work without it.
4. **Possibly split the capacity key** (J6) — only after the arrival-vs-work
   question is answered, not before.

### J8. Confirmations required from management

Returned in the audit payload and on the verification sheet: simultaneous vehicle
count; which bays are operational; whether Bays 6 and 7 physically exist and are
commissioned; whether the overflow slots are genuine positions and under what
circumstances; whether mobile jacks and stands are positions or equipment;
alignment / tire / lube position counts; where Vehicle Cleaning happens (a
mechanical bay, or PWASH-01); where Pre-Purchase Inspections happen; which
resources may substitute for GENERAL work; and whether any resource is unavailable
at particular times.

None of these may be inferred from historical throughput.

### J9. Production controls unchanged (§19)

```
booking_enforce_online_bookable     : true
appointment_duration_source         : DEFAULT
booking_capacity_mode               : FIXED
booking_max_concurrent_appointments : 2
```

---

## §K. Stage 5B — resource registry bridge: DESIGN PROPOSAL

Nothing in this section is implemented. It is the "smallest safe bridge" proposal
requested before any resource-model change.

**Capacity 7 has NOT been applied anywhere.** It was evidence that the existing
resource data is internally inconsistent, and the physical expansion makes it
stale as well. Production remains `booking_max_concurrent_appointments = 2`.

### K1. Most of the operational requirements already exist

Before proposing anything, what is already built and audited in
`resource-admin.service.ts`, usable today with no redeploy:

| Requirement | Status |
| --- | --- |
| §3 Add Resource through Setup → Resources & Bays | `create()` — exists |
| §4 Take out of service / decommission, never delete | `setStatus()`, `retire()`, `reactivate()` — exists |
| §4 Status vocabulary | `AVAILABLE`, `TEMPORARILY_UNAVAILABLE`, `MAINTENANCE`, `OUT_OF_SERVICE` + `retiredAt` — already matches what was asked for |
| §4 Hard delete only when unused | `deleteIfUnused()` — exists |
| §13 Downtime without deployment | `setStatus()` — exists, audited with actor, timestamp, previous status and reason |
| §14 Impact warning before taking out of service | `impact()` — exists, **but see K4** |
| §18 Lifecycle audit history | `history()` reading `AuditLog` — exists |
| §17 Immediate cache invalidation | **No cache exists.** Rules and capacity are read from the database on every availability call, so a manager's change applies to the very next request. Nothing to invalidate. |

So Stage 5B is not "build resource administration". It is "make the registry mean
something to capacity", which is a much smaller change.

### K2. The bridge — one nullable link, nothing deleted

The mismatch found in §J2 is a **vocabulary** problem, not a data problem:

- `ServiceType.requiredBayType` → GENERAL, LUBE, ALIGNMENT, DIAGNOSTIC, INSPECTION, TIRE
- `WorkBay.bayType` → the same vocabulary (6 rows, 62 assignments)
- `WorkResource.resourceCategory` → BAY, OVERFLOW, LIGHT_SLOT, POWER_WASH, EXTERNAL

`resourceCategory` describes **what a thing is**. `requiredBayType` describes
**what work it supports**. Forcing one field to carry both is what created the
split, and §7 rightly says not to.

Proposed bridge, smallest version:

```
WorkResource.legacyBayId  String? @unique   -> WorkBay.id
```

One nullable, unique foreign key, pointing from the canonical registry at the
legacy row it supersedes. That gives:

- **assignments keep writing `bayId`** — the 62 existing rows and the whole dispatch
  workflow are untouched, and `WorkBay` is not deleted;
- **capacity reads `WorkResource`** — one authoritative inventory;
- **reconciliation links the two** so the same physical bay is one record with two
  access paths, rather than two records that can disagree.

The link is set during the reconciliation walk-through (K5), by a person, never
inferred from matching codes — `BAY-01` exists in both tables and they are
**not** the same thing: the legacy `BAY-01` is a GENERAL bay, the resource
`BAY-01` is "Heavy Lift 1".

### K3. Schema proposal — three additive changes

All additive, all defaulting so that **nothing gains capacity by migrating**.

**1. Capacity contract**

```
enum ResourceCapacityRole { PRIMARY_SERVICE_POSITION OVERFLOW_SERVICE_POSITION SUPPORT_EQUIPMENT PLACEHOLDER }
WorkResource.capacityRole ResourceCapacityRole @default(SUPPORT_EQUIPMENT)
```

Defaulting to `SUPPORT_EQUIPMENT` means derived capacity is **zero** until a
person classifies each resource. That is deliberate: after an expansion the
database is known-stale, so the safe default is "counts for nothing" rather than
"counts for something we have not checked". No existing field can carry this —
`resourceCategory` is a type, and `schedulingEnabled` means "may receive work",
which a jack legitimately can.

**2. Work capabilities** (§7, §12)

```
model WorkResourceCapability { resourceId, capability String, @@unique([resourceId, capability]) }
```

A join table rather than a column, because one bay supports several work types —
and because a capability must never imply a capacity unit. Bay 4 supporting
`GENERAL + INSPECTION` is still **one** physical position; the solver allocates
resource identities and then checks capability, never sums category counts.
`capability` reuses the `requiredBayType` vocabulary so the catalogue and the
registry finally speak the same language.

**3. The bridge**

```
WorkResource.legacyBayId String? @unique
```

Nothing is dropped, nothing is renamed, no existing row changes meaning.

### K4. A real gap in the existing impact warning

`impact()` counts `ResourceReservation` and `TechnicianAssignment.resourceId` —
both of which are **empty** (§J2). So taking an alignment bay out of service
today reports "no impact" however many alignment appointments are booked.

§14 asks for exactly the warning that would not appear. The fix is for `impact()`
to count **upcoming appointments whose services require a capability this resource
provides**, which only becomes possible once capabilities exist. It should land
with K3, not before.

### K5. Reconciliation, and how the expansion gets counted

§9's three-way split, on the existing audit page:

- **Currently configured** — the 17 rows, each with its proposed role and a
  confirm/correct action;
- **Needs confirmation** — everything the audit flagged, which right now is
  everything except `MSHOP-EXT`;
- **Add newly installed** — the expansion bays, entered through the existing
  `create()` with the new role + capability fields.

`Verified active vehicle positions` is then **derived**: active, not retired,
operational status `AVAILABLE`, `capacityRole` in (PRIMARY, OVERFLOW). Adding a
bay raises it; putting one into maintenance lowers it; no configuration key is
edited and no deploy occurs (§10, §11).

`booking_max_concurrent_appointments` stays as the safety ceiling while SHADOW is
proven, exactly as §10 describes — a guard, not the source.

### K6. Open question, carried from the truncated §20

The Stage 5A finding that arrival capacity and active-work capacity are conflated
was accepted, and the requirement text ends mid-sentence on the split. The
proposal above deliberately models only **physical work positions**.

Before 5C, confirm the other half: what should govern *arrivals* — how many
customers should be scheduled to arrive or start around the same time, given the
front desk, check-in, and how long a vehicle may reasonably wait in the queue?
That is a different number from "how many bays exist", and the proposal does not
guess it.

---

## §L. Stage 5B — resource registry bridge: IMPLEMENTED

Approved in principle with 25 amendments. Built to those amendments, with two
findings that correct the Stage 5A report — recorded in L2 and L3.

### L1. What was built

**Schema** (`20260916160000_cr_2026_108_resource_capacity_role`) — additive only:

| Change | Purpose |
| --- | --- |
| `ResourceCapacityRole` enum | UNVERIFIED / PRIMARY_SERVICE_POSITION / OVERFLOW_SERVICE_POSITION / SUPPORT_EQUIPMENT / PLACEHOLDER |
| `WorkResource.capacityRole` | `NOT NULL DEFAULT 'UNVERIFIED'` — every existing row lands on "counts for nothing" |
| `WorkResource.legacyBayId` | nullable, **unique**, `ON DELETE SET NULL` — the manual bridge |
| `work_resource_capabilities` | `(resourceId, capability)` unique; reuses the `requiredBayType` vocabulary |

The relation is named `serviceCapabilities`, not `capabilities`: `WorkResource`
already carries a `capabilities Json?` extensibility column, and two fields of the
same name meaning different things is the kind of thing that costs an afternoon
eighteen months from now.

**Derived capacity** (`resource-truth-audit.service.ts`) — `derivedCapacity()`
computes `verifiedActivePositions` from confirmed role plus usable-today status,
and `capabilityPools` per kind of work. Nobody types a number. While any resource
is UNVERIFIED the payload carries `configurationIncomplete: true`, an explicit
warning, and `confidence: 'LOWER_BOUND'` on every pool.

**Admin surface** — `capacityRole` joins the existing concurrency-guarded, audited
`update()`; `POST /resources/:id/capabilities` replaces the capability set; `POST
/resources/:id/legacy-bay` links or unlinks; `GET /resources/reconciliation`
returns both inventories with link state.

**UI** — `/admin/resources/reconciliation`, "Confirm Work Positions", reached from
a badge on Resources and Bays showing the unconfirmed count.

### L2. §3 resolved — and a Stage 5A correction

Stage 5A reported operational status as "NOT CONFIGURED" for all 17 resources.
That reading was wrong.

`resource-admin.setStatus()` does upsert `ResourceOperationalStatus` and audits
`RESOURCE_OPERATIONAL_STATUS_CHANGE`. It writes only when a status *changes*, so
an empty table means **nobody has ever taken a resource out of service** — absence
is AVAILABLE, not unconfigured. It is already the single authoritative
current-status mechanism, and Stage 5B added no rival: a test asserts the three new
methods never touch that table.

The audit and the reconciliation view now both read absence as AVAILABLE.

### L3. §23 resolved — `ResourceReservation` semantics

`ResourceReservation.resourceId` is `String?`, carrying the comment
`null = "any compatible resource"`, with a PENDING / ACTIVE / CLAIMED / EXPIRED /
CANCELLED lifecycle.

So the table **already supports abstract capacity reservation** — it was designed
for it. The gap is narrower than Stage 5A suspected, and more specific: there is no
capability column, so "compatible with **what**?" is unanswerable. A null-resource
reservation cannot be counted against a pool, because nothing says which pool it
belongs to.

That is a Stage 5C decision — a `requiredCapability` column, or resolution through
the appointment's services — and no `ResourceReservation` rows are written by this
stage.

### L4. §14 — the impact warning was broken, and is now fixed

`impact()` counted `ResourceReservation` and `TechnicianAssignment` rows keyed on
`resourceId`. **No technician assignment in this database has ever referenced a
`WorkResource`** — all 62 reference the legacy bay. So the warning returned "no
impact" for every resource, including the only alignment bay, in a week with
alignment appointments booked.

`capabilityImpact()` asks the question that actually matters: if this stopped being
usable, how many positions could still do this kind of work, and what is already
booked that needs it? Booked work is counted through `appointment_services` join
`service_types.required_bay_type`, not through assignments.

Proven live on BAY-01:

```
rows keyed on this resource : 0 active / 0 reserved   <- the old answer, "no impact"
capability view             : ALIGNMENT 1 -> 0, severity LAST_POSITION
warning                     : "This is the only position currently able to do ALIGNMENT
                               work. Taking it out leaves none. PHYSICAL CAPACITY REQUIRES
                               CONFIRMATION — 15 resources are still unclassified, so the
                               remaining count is a lower bound."
```

Per §15 it refuses false precision. It does not claim an appointment will be
delayed; it reports positions before and after, the count of appointments needing
that capability within 30 days, and says in words that timing and dispatch are not
modelled.

### L5. §17 — specialty double-booking risk under FIXED

Unchanged from Stage 4F and 5A, and worth stating plainly because it is live today.

`booking_max_concurrent_appointments = 2` is a single number covering the whole
site. The catalogue disagrees with the inventory:

| Kind of work | Active bays | Services | Offered online |
| --- | --- | --- | --- |
| ALIGNMENT | 1 | 1 | 1 (TIR-02 Wheel Alignment) |
| LUBE | 1 | 1 | 1 (OIL-01 Oil Change) |
| INSPECTION | 1 | 1 | 1 (INSP-01 Pre-Purchase) |
| TIRE | **0** | 1 | 0 |
| GENERAL | 2 | 23 | 3 |
| DIAGNOSTIC | 1 | 4 | 0 |

Two customers can book the same 20-minute slot. If both choose Wheel Alignment, the
platform has accepted two vehicles for one alignment bay. The same holds for OIL-01
and INSP-01. This is a **present-tense** exposure, not a Stage 5 forecast.

**Recommendation, not implemented (§17).** Do *not* set the affected services
`bookableOnline = false`. The exposure is real but narrow — it needs two customers
choosing the same specialty in the same slot — and withdrawing three of the six
pilot services would gut the pilot to fix a problem the manager may resolve in a
sentence ("we have three alignment bays now"). The bay inventory is known-stale,
and acting on a stale count is how the capacity-of-7 error nearly happened.

Two lower-cost options, in preference order:

1. **Confirm the inventory first** — the walk this stage exists to enable. If
   ALIGNMENT genuinely has one position, the decision changes and is then based on
   fact rather than on a table nobody has checked.
2. If the risk must be closed before that walk, prefer a **per-capability cap** over
   withdrawing services. That is Stage 5C work and should not be rushed in.

Meanwhile the risk is surfaced on the reconciliation screen and in the audit
payload, so it is visible rather than latent.

### L6. §20 — arrival control: documented, inactive

Stage 5A found arrival capacity and active-work capacity conflated in one setting.
The concept, for the record and for 5C:

- **Physical work capacity** — how many vehicles can be worked on at once. Derived
  from confirmed resources. Modelled in this stage.
- **Arrival control** — how many customers should be scheduled to arrive around the
  same time, given the front desk, check-in, and a tolerable queue wait. A different
  number, governed by different facts.

`booking_max_concurrent_appointments = 2` is today doing both jobs. Nothing here
changes that, and per §19 **no `booking_max_arrivals_per_slot` key was created and
no arrival number was guessed.** The arrival number is a question for management,
carried into Stage 5C alongside the K6 question.

### L7. Verification

Against the live database, every write rolled back:

```
 1. all 17 existing resources migrated to UNVERIFIED — none became production capacity
 2. derived capacity = 0 with 16 unclassified — reported as "configuration incomplete"
 3. confirming BAY-01 raised derived capacity 0 -> 1 immediately — no config key, no restart
 4. BAY-01 into maintenance: 1 -> 0, and its role is STILL PRIMARY_SERVICE_POSITION
 5. BAY-01 back to available: capacity returns to 1 without reclassifying anything
 6. BAY-05 (Power Jack) as equipment: capacity unchanged at 1
 7. BAY-01 given GENERAL + ALIGNMENT + LUBE: total positions still 1, pools 1/1/1
 8. BAY-01 linked to bay BAY-01; a second claim refused by the database;
    all 39 historical assignments untouched
 9. production controls unchanged: FIXED / 2 / DEFAULT / enforcement ON with 6 services
10. rolled back — all 17 UNVERIFIED again, derived capacity 0, database as found
```

16 unclassified of 17: `MSHOP-EXT` is `EXTERNAL`, excluded from capacity by
category, so leaving it unclassified is not a gap in this shop's configuration.

Through the HTTP surface, same rollback discipline: the reconciliation view
reported 17 resources / 6 bays with 4 unmatched bays carrying job history;
confirming a bay and assigning capabilities moved the derived count; an invalid
role and a misspelled capability were both refused with 400; a second claim on a
linked bay was refused with 409; the linked bay kept all 39 historical jobs; and
`RESOURCE_UPDATE`, `RESOURCE_CAPABILITIES_SET` and `RESOURCE_LEGACY_BAY_LINK` all
appear in the resource's history.

Tests: `capacity-role.spec.ts`, 32 cases covering unverified defaults, migration
additivity, role/status separation, one status mechanism, bridge exclusivity and
non-destructiveness, no code-based inference, capability validation and
replace-semantics, capabilities never touching `capacity`, derived capacity never
reading a config key, the impact fix, and the reconciliation view. Full API suite:
1381 passed, 17 skipped.

### L8. Production controls unchanged (§24)

```
booking_enforce_online_bookable     : true   (six pilot services)
appointment_duration_source         : DEFAULT
booking_capacity_mode               : FIXED
booking_max_concurrent_appointments : 2
```

No customer-visible behaviour changed. A test asserts the public booking engine,
the public booking service and the booking availability service reference neither
`capacityRole` nor the capability relation. Verified live: the public catalogue
still offers six services and Wheel Alignment still returns availability.

### L9. Stop point

Per the amendment closing §25: **stop here.** Stage 5C does not begin until the
actual expanded Service Centre inventory has been entered and verified through
`/admin/resources/reconciliation`, because a SHADOW engine run against 17
unclassified rows would measure the same stale inventory that produced the
withdrawn capacity-of-7 recommendation.

Carried into 5C: the arrival-control number (§20 / L6), the `ResourceReservation`
capability question (§23 / L3), the specialty double-booking decision once the
inventory is real (§17 / L5), and re-running the Stage 4F comparison against
confirmed capacity.

---

## §M. The Stage 5C hold — what exists during it, and what may not

Stage 5B is accepted. The next activity is **operational, not developmental**: the
expanded Service Centre is reconciled in person through
`/admin/resources/reconciliation`. No Stage 5C code is written until that is done
and reviewed.

Two things were built during the hold, both read-only, because the alternative was
to start engineering the report on the day management asked for it.

### M1. The reconciliation summary — the Stage 5C entry gate

`GET /resources/reconciliation-summary` and `pnpm resources:summary`
(`reconciliation-summary.service.ts`). It writes nothing, classifies nothing,
links nothing and infers no capacity number.

It returns the thirteen items management specified — the position census
(primary, overflow, support equipment, placeholders, temporarily unavailable,
remaining UNVERIFIED), capability counts for GENERAL / LUBE / ALIGNMENT /
INSPECTION / TIRE plus any capability the shop has added, vehicle restrictions,
unmatched legacy bays, expansion resources with no legacy counterpart, where
Vehicle Cleaning physically happens, and every customer-bookable service whose
capability has one verified position or none.

It also returns `readyForStage5C` with a list of `blockers`, so the answer to "is
the walk finished" is a field rather than a judgement call.

**The arithmetic rule is enforced, not just documented.** Capability pools are
never summed into a shop total. The report publishes both numbers side by side:

```
Sum of the pool column ......... 9   <- NOT shop capacity
Distinct physical positions .... 7   <- the real ceiling
Positions carrying >1 capability 2
```

Publishing the wrong number next to the right one is deliberate. Someone will add
that column up; this is the line that stops them acting on it.

### M2. A flaw the dry run exposed

Running the report against a temporarily classified inventory (rolled back
immediately) produced:

> BAY-01, OVF-01, OVF-02, PWASH-01 carry GENERAL and nothing else, so a booked
> cleaning does not consume a repair position.

That was wrong, and wrong in a way that would have mattered. The first
implementation asked "does this position do anything besides cleaning?" — but
CLEAN-01 requires `GENERAL`, and so do **22 other active services**. A bay carrying
only `GENERAL` is not a dedicated wash position; it is a repair bay with a hose.

The question belongs to the catalogue, not the bay. The corrected verdict:

> Vehicle Cleaning requires GENERAL, and 22 other active services require the same
> capability. Every position that can take a wash can therefore be called on for
> repairs instead — a booked cleaning occupies repair capacity, and Stage 5C must
> model it that way. To give cleaning a position of its own it needs a capability
> of its own, not just a bay.

That last sentence is the actionable part: a dedicated wash position is a
**catalogue change** (give CLEAN-01 its own required capability), not a bay
assignment. It is recommended, not implemented — changing the public catalogue is
management's call.

Note the shape of this finding. Cleaning cannot be given a dedicated position by
classifying bays, which is the only thing the walk changes. So this one does not
resolve itself when the inventory is confirmed.

### M3. The hold, expressed as tests

`stage5c-hold.spec.ts` — 18 cases. The risk is not that someone defies these
constraints; it is that a change six months from now makes one true by accident,
with nobody reading this document. A failure there is a prompt to ask, not to edit
the assertion.

| Constraint | How it is held |
| --- | --- |
| No new production capacity number inferred | Nothing in the application writes `booking_max_concurrent_appointments`; `verifiedActivePositions` reaches no booking path |
| RESOURCE_AWARE not activated | Nothing writes `booking_capacity_mode`; no default other than FIXED |
| No CATALOGUE durations | Nothing writes `appointment_duration_source` |
| Pilot services not withdrawn | Nothing in the application sets `bookableOnline`; the risk is reported, never acted on |
| No auto-classification | **Exactly one file writes a `WorkResource` at all** — the audited admin service. Creation defaults to UNVERIFIED; update takes the caller's value. The audit proposes a role and never writes one |
| No auto-linking by code or name | The bridge is written in one place as `data: { legacyBayId }` — the caller's id, never a lookup result. No migration back-fills the column |
| No `ResourceReservation` rows | Nothing in the resources module creates one; `requiredCapability` is deliberately absent from the schema, because adding it *is* the Stage 5C decision |
| Corrected `impact()` retained | `capabilityImpact` still reports pool loss, still counts booked work through the catalogue, still refuses to predict a delay |

`booking_max_arrivals_per_slot` does not exist anywhere in the codebase, and a test
keeps it that way until management supplies the number.

### M4. State at the start of the hold

```
capacity roles   : 17 x UNVERIFIED
legacy links     : 0
capability rows  : 0
status rows      : 0
reservations     : 0
capacity mode    : FIXED
concurrency      : 2
duration source  : DEFAULT
enforcement      : true, 6 pilot services
```

Every dry run in this section rolled back to exactly that.

### M5. What the summary says today

NOT READY, with three blockers: 16 resources unclassified (MSHOP-EXT is EXTERNAL
and excluded by category), 6 legacy bays unmatched — four of them carrying real job
history (BAY-01: 39, BAY-03: 16, BAY-02: 6, BAY-05: 1) — and no confirmed vehicle
positions at all.

One design note worth recording. An early version reported all six pilot services
as `CANNOT BE FULFILLED`, because their capability pools were empty. That is an
alarm about the data dressed up as an alarm about the shop: the pools were empty
because nobody had classified a bay, not because nobody can change oil. Each
finding now carries a `basis` of `VERIFIED` or `INCOMPLETE_CONFIGURATION`, and the
"no position" blocker is only raised once the walk is actually complete.

---

## §N. Reconciliation semantics — resolved is not the same as linked

Two changes to the gate, made during the hold. Both read-only in effect: no
capacity number moves, no customer sees anything, no historical row is touched.

### N1. A legacy bay is resolved by a link OR by being accounted for

The gate previously demanded that every legacy `WorkBay` be matched to a
`WorkResource` before Stage 5C could begin. On a floor that has been physically
reorganised that is sometimes impossible — a bay may have been demolished,
absorbed, or replaced by an arrangement corresponding to no single resource.

The failure mode is what matters. A gate that can only be cleared by linking does
not stop at inconveniencing the person doing the walk; it **pushes them into
pairing a demolished bay with whichever new one stands nearest**, because that is
the only way to make the screen go green. And that invented link is then a fact
the resource-aware engine reasons from — a fabricated premise introduced by the
very process meant to establish the truth.

So a bay is now resolved when it is **either** linked to its current resource
**or** explicitly dispositioned:

| Disposition | Means |
| --- | --- |
| `UNRESOLVED` | Nobody has said anything. Blocks readiness. |
| `HISTORICAL_ONLY` | Gone or absorbed. Its jobs are real history and stay put. |
| `REPLACED` | Superseded by the expansion, but by no single resource. |
| `RETIRED` | Formally out of service, kept for its record. |

Migration `20260916170000_cr_2026_108_legacy_bay_disposition` — additive, four
columns on `work_bays`, every existing bay landing on `UNRESOLVED`.

Design points worth recording:

- **Not folded into `work_bays.status`.** That column says whether a bay is active
  for scheduling; disposition says how the walk accounted for it. One column
  answering both would let a reconciliation note silently change what the
  scheduler sees.
- **A note is mandatory.** `REPLACED` on its own tells a future reader nothing.
  The write is refused without one.
- **Link and disposition are mutually exclusive, in both directions.** Linking a
  dispositioned bay is refused rather than silently clearing the finding;
  dispositioning a linked bay is refused for the same reason. Two answers to one
  question means the next reader has to guess which won.
- **Reversible.** Setting `UNRESOLVED` clears the note, timestamp and actor, so a
  mistake during the walk is not permanent.
- **Audited** as `LEGACY_BAY_DISPOSITION`, recording the historical job count in
  the entry — a number the operation reports and never changes.

The blocker text now says so explicitly: *"Each needs either a link to the resource
that IS that position, or a note saying it is history — do not invent a link to
clear this."*

Verified live, rolled back:

```
 1. starting point: 6 of 6 bays unresolved; BAY-01 carries 39 jobs, no resource
 2. no reason -> HTTP 400; unknown value -> HTTP 400
 3. BAY-01 recorded HISTORICAL_ONLY — resolved WITHOUT a link, still 39 jobs, still unlinked
 4. unresolved 6 -> 5; dispositioned 1; linked pairs unchanged at 0
 5. linking a bay already recorded as history -> HTTP 409
 6. gate moved it out of "unresolved" into "resolved without a link"
 7. remaining blocker: "...do not invent a link to clear this."
11. rolled back — 6 unresolved again, 39 jobs intact
```

### N2. CLEAN-01 stays open as a management-confirmation item

Configuration says cleaning shares a mechanical position: CLEAN-01 requires
`GENERAL`, and so do 22 other active services. The building may say otherwise, and
**classifying bays cannot settle it** — the answer lives in the catalogue.

So the finding no longer resolves itself. `vehicleCleaning.managementConfirmation`
carries `open: true` and `status: AWAITING_PHYSICAL_CONFIRMATION` on every verdict
except the one where cleaning already has a capability of its own, and it stays
open even when `readyForStage5C` is true. Those are two different questions and
the report says both.

The proposal, held until confirmed:

> If the walk confirms a dedicated cleaning position: add CLEANING as an additive
> service/resource capability, assign it to that position only, and remap CLEAN-01
> from its current capability to CLEANING. Additive — no existing capability,
> service or historical record changes, and the remap is a public-catalogue change
> requiring approval. NOT implemented: proposed only, and only after physical
> confirmation.

`CLEANING` is deliberately absent everywhere. The capability vocabulary is derived
from what the catalogue actually asks for, so it cannot appear in the UI as an
assignable option before the remap is approved — verified live, the vocabulary is
still `ALIGNMENT, DIAGNOSTIC, GENERAL, INSPECTION, LUBE, TIRE`. A guard test keeps
it that way.

### N3. The hold is otherwise unchanged

`stage5c-hold.spec.ts` grew to 22 cases: the disposition path cannot create a link
or touch an assignment, nothing remaps CLEAN-01, and CLEANING is not seeded into
the vocabulary.

State at the end of this change, unchanged from acceptance:

```
capacity roles : 17 x UNVERIFIED       dispositions : 6 x UNRESOLVED
legacy links   : 0                     bay assignments : 62 (untouched)
capacity mode  : FIXED                 concurrency  : 2
duration source: DEFAULT               enforcement  : true, 6 pilot services
CLEAN-01       : still requires GENERAL
```

Full API suite: 1458 passed, 17 skipped.

---

## §O. Stage 5C + 5D — the resource-aware engine, in SHADOW

The hold was lifted with instructions to finish the platform on what is confirmed
today and let management fill in the rest later without redevelopment. This is
what was built.

### O1. The solver — identity, not arithmetic

`resource-capacity.engine.ts`, pure and I/O-free.

The obvious implementation counts pools and compares: `GENERAL = 8,
INSPECTION = 3, LUBE = 2` → thirteen jobs at once. That is wrong in the direction
that oversells the shop, because the same bay appears in several pools. A heavy
lift that does general work, inspections and oil changes is counted three times
and is still **one vehicle at a time**. Sum the pools and eight bays become
thirteen promises.

So capacity is not a number here. It is a question about **identity**: can the
jobs overlapping at some instant each be given a *different* physical resource
eligible for that job? That is a maximum bipartite matching — jobs on one side,
position nodes on the other, an edge where the resource can do the work — and a
slot is offerable only when every overlapping job, including the one being placed,
matches simultaneously.

Kuhn's augmenting-path algorithm, deliberately rather than anything cleverer: the
graph is a handful of jobs against tens of positions, and a matching a reader can
check by hand is worth more than an asymptotic improvement nobody will measure.

Two details that matter:

- **Every instant, not just the start.** A matching that works at 09:00 can fail
  at 10:00 when a third job begins, so the check runs at each event point.
- **Greedy would be wrong.** If the only alignment-capable bay is also the only
  free general bay, handing it to the general job first reports a false BLOCKED.
  The augmenting path re-assigns instead.

Eligibility covers capacity role, active/retired/scheduling flags, operational
status, capability, vehicle class, and the DMAIC Rule 3 mobile-jack sedan gate. A
resource with `capacity: 2` becomes two nodes; a resource with three capabilities
stays one.

### O2. INCOMPLETE is not a kind of BLOCKED — and this caught a real bug

A pool of zero has two entirely different causes: the shop genuinely cannot do the
work, or nobody has finished classifying the bays. The engine reports the second as
`INCOMPLETE`, never as a capacity limit.

The first shadow validation run showed why this matters. It reported **708 slots
"oversold"** — the fixed limit offering work no position could cover, which is the
dangerous direction and the one the production preflight blocks on. Every one of
them was actually "nobody has said which bay does oil changes yet".

The categorisation was wrong: an INCOMPLETE slot has `available: false`, so a naive
comparison counted it as the fixed model overselling. The four outcomes are now
mutually exclusive with INCOMPLETE taking precedence, and they partition the
compared slots. After the fix: **0 oversold, 0 undersold, 708 incomplete.**

An unfinished configuration must not be able to raise a critical safety finding.

### O3. The eight-bay baseline

`pnpm resources:baseline [--commit]`, driven through `ResourceAdminService` so
every change is validated and audited exactly as from the screen.

| Code | Source | Role |
| --- | --- | --- |
| BAY-01, BAY-02 | existing heavy lifts | PRIMARY + GENERAL |
| BAY-03 | existing lift — **flagged**, recorded as `sedan`/STANDARD | PRIMARY + GENERAL |
| BAY-06, BAY-07 | were "(TBD)", renamed to Heavy Lift 6/7 | PRIMARY + GENERAL |
| BAY-08, BAY-09, BAY-10 | created — not in the pre-expansion inventory | PRIMARY + GENERAL |
| MJACK-01/02, STAND-01/02 | jacks and stands | SUPPORT_EQUIPMENT |
| BAY-04, BAY-05, OVF-01/02, LT-01/02, PWASH-01, MSHOP-EXT | ambiguous | left UNVERIFIED |

Two judgement calls, both correctable on screen without code:

- **BAY-03 is counted as one of the eight** and flagged. It is recorded as a
  `sedan` lift at STANDARD weight, not `heavy`, but it accepts both vehicle classes
  and is a full lift position. If it is not one of the eight management means,
  change its role and add the eighth.
- **BAY-04 (Mobile Lift) and BAY-05 (Power Jack) were NOT classified as equipment**
  despite reading like jacks, because they sit in the BAY code series. Ambiguous
  stays UNVERIFIED.

**No `capacity = 8` exists anywhere.** The derived count is eight because eight
verified resources exist. Adding a ninth made it nine, live, in the acceptance run.

### O4. Shadow comparison and its persistence

`booking_shadow_comparisons` — migration `20260918100000`, additive.

Only **meaningful differences** are written: agreement is the expected case and
storing it would bury the signal. Only slots where the fixed engine reached a
*capacity* decision are compared at all — a slot excluded because it is in the past
is not a disagreement about capacity.

No PII. No customer, vehicle, plate, appointment id or token. A vehicle *class* is
stored because a class is not identifying; a plate would be. A test asserts the
absence of each forbidden field.

`configFingerprint` ties a finding to the inventory it was measured against —
without it a row from last week is uninterpretable the moment somebody commissions
a bay. Retention 90 days.

### O5. Readiness split, and the activation guard

§13's two bars, because holding shadow to the production bar meant no evidence
could be gathered until the configuration was already perfect — and the evidence is
how you find out what still needs configuring.

**READY FOR SHADOW** — currently READY. At least one confirmed position, at least
one capability assigned, inventory readable. Eight unclassified resources mean the
figures carry a lower-bound caveat, which is a caveat on the numbers rather than a
reason to withhold them.

**READY FOR PRODUCTION RESOURCE_AWARE** — currently NOT READY, 2 of 7 checks
failing. All seven of §14's requirements are named checks, so a failure tells a
manager what to go and do.

The guard is on the one path that writes `booking_capacity_mode`: setting it to a
resource-aware value runs the preflight and throws `RESOURCE_AWARE_PREFLIGHT_FAILED`
with the blockers named. Verified live — HTTP 400, two blockers.

### O6. Reservations — abstract, and the race

`ResourceReservation.requiredCapability` added. A booking reserves **"one
compatible ALIGNMENT position"**, not ALIGN-01: a customer picking a time three
weeks out must not be handed a dispatch decision, and pinning a bay would break the
moment it went into maintenance.

The race — `availability says yes → another booking lands → appointment created` —
is guarded by the **same per-site-per-day advisory lock every other writer already
takes**. Re-check and reserve inside that lock and the second writer serialises,
sees the reservation, and loses cleanly.

Reschedule is release-then-reserve in **one** transaction. Split across two and the
old interval is free for an instant — exactly long enough for a concurrent booking
to take the position, leaving a customer who merely moved their time with no bay.

Under FIXED this writes nothing, so shadow cannot affect production. The
architecture exists now so the concurrency design is reviewed while the stakes are
a test database.

### O7. Stage 5D — 22 validation cases

`stage5d-validation.spec.ts`, 55 assertions across all twenty-two, numbered to
match. Deterministic on purpose: several describe a configuration that does not
exist yet (there is no alignment bay), and the point is to prove the engine is
correct when it does — the live measurement is the shadow validation run.

Full API suite: **1545 passed, 17 skipped.**

### O8. §23 — expansion is configuration, live

Every change made through the API, every one rolled back:

```
 1. baseline: 8 confirmed primary positions, 0 overflow, 4 equipment, 7 unconfirmed
 2. GENERAL pool: 8 eligible positions (derived, not entered)
 3. ADD BAY:        8 -> 9 positions, GENERAL pool 8 -> 9     (no deployment)
 4. MAINTENANCE:    9 -> 8                                     (immediate)
 5. RESTORE:        8 -> 9, role never changed                 (immediate)
 6. ADD OVERFLOW:   overflow 0 -> 1, GENERAL pool -> 10        (automatic)
 7. Wheel Alignment before: 13 slots "cannot tell", 0 positions
 8. after adding ALIGNMENT to BAY-01: 13 slots agree, 1 eligible position (immediate)
 9. ALIGNMENT pool now 1 — a single point of failure the dashboard reports
10. shadow READY; production NOT READY (2 of 7 checks failing)
11. activation refused: HTTP 400 RESOURCE_AWARE_PREFLIGHT_FAILED, 2 blockers named
12. rolled back to 8 primary / 0 overflow / GENERAL 8 / ALIGNMENT 0
```

### O9. §20 — Stage 4F re-run: still HOLD, for a narrower reason

`pnpm booking:duration-impact-resource`. Each duration model measured twice: once
against the fixed limit that decides bookings today, once against the resource model.

| Service | Needs | DEF | CAT | FIXED slots | RES slots |
| --- | --- | --- | --- | --- | --- |
| Oil Change | LUBE | 80m | 30m | 235 → 239 (+1.7%) | not evaluable |
| Tire Rotation | GENERAL | 80m | 25m | 235 → 239 (+1.7%) | 235 → 239 (+1.7%) |
| Brake Inspection | GENERAL | 80m | 30m | 235 → 239 (+1.7%) | 235 → 239 (+1.7%) |
| Wheel Alignment | ALIGNMENT | 80m | 60m | 235 → 237 (+0.9%) | not evaluable |
| Pre-Purchase Inspection | INSPECTION | 80m | 75m | 235 → 235 (0%) | not evaluable |
| Vehicle Cleaning | GENERAL | 80m | 30m | 235 → 239 (+1.7%) | 235 → 239 (+1.7%) |

**The eight confirmed positions genuinely do weaken the original concern.** A +83%
saturation increase against a ceiling of 2 is a different proposition from the same
increase against 8.

**But the recommendation stays HOLD**, for a reason Stage 4F did not have: the
services that shorten most under CATALOGUE are the specialty ones, and **three of
the six have no configured position at all**. Switching now would increase the rate
of bookings flowing toward pools whose size nobody has established. That is not a
bigger version of the old risk — it is an unmeasured one.

Re-run after the specialty capabilities are assigned. If each has two or more
positions, the case for CATALOGUE becomes straightforward.

### O10. §15 — CLEANING, configurable now

The capability column is plain text, so extending the vocabulary needs no enum
migration. `resource_additional_capabilities` (default `['CLEANING']`) makes it
assignable **before** any service requires it — which has to be possible, because a
wash bay must be configurable before CLEAN-01 can be remapped to need it.

Assigning CLEANING today changes no availability: the solver only matches a job's
required capability against a resource's list, and nothing requires CLEANING. The
remap itself stays a public-catalogue decision, and a test asserts nothing in the
application performs it.

### O11. §16 — arrival smoothing, still separate

Unchanged and unsolved, deliberately. Resource capacity asks *can the workshop
physically service the vehicle*; arrival policy asks *how many customers should be
invited to arrive in the same period*. `booking_max_concurrent_appointments = 2`
remains the temporary arrival/throughput safety control. No new arrival limit was
invented and `booking_max_arrivals_per_slot` still does not exist.

### O12. Final production state (§25)

```
customer catalogue enforcement : ON, 6 pilot services
duration source                : DEFAULT
production capacity model      : FIXED
concurrency safety control     : 2 (unchanged)
RESOURCE_AWARE                 : functioning in SHADOW
resources                      : 8 PRIMARY + 4 SUPPORT_EQUIPMENT + 8 UNVERIFIED
capabilities                   : GENERAL x8
shadow comparison rows         : 708 (all INCOMPLETE — configuration gaps)
resource reservations          : 0
```

`deploy:check` PASS — 25 ok, 1 warning, 0 failures.
