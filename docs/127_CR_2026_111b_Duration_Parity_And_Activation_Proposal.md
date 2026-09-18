# CR-2026-111b — Duration parity, and the production activation proposal

**Status:** Consistency fix delivered. Production activation **NOT performed** — proposal below awaits approval.
**Date:** 2026-09-18
**Scope:** One shared service-duration resolver across every scheduling path; activation gate
**Production duration policy:** unchanged — `appointment_duration_source` remains `DEFAULT`

---

## 1. What was wrong

A staff-created SUV General Servicing resolved to **90 minutes**; the identical
booking made by the customer resolved to **120**. Same vehicle, same work, two
answers, decided by which door the booking came through.

The cause was two copies of the rule and one permissive type. `booking-availability.service.ts`
declared the class columns **optional** — with a comment saying they were optional
"so every existing caller keeps compiling" — so the staff query that selected only
`baseDurationMinutes` compiled happily and silently produced the sedan figure for
every vehicle.

---

## 2. The shared resolver (§3)

`apps/api/src/modules/scheduling/availability/service-duration.ts` — pure, no I/O.

```ts
resolveAppointmentDuration({ services, vehicleClass, policy, defaultMinutes })
  → { plannedMinutes, catalogueMinutes, policy, classBasis, underPlannedByMinutes, explanation }
```

Every path now calls it:

| Path | Resolves class from | Status |
|---|---|---|
| Public availability | `?vehicleId` → vehicle record | ✅ |
| Public booking confirmation | `dto.vehicleId` → vehicle record | ✅ |
| Customer reschedule | the appointment's vehicle | ✅ |
| Staff availability | `?vehicleId` → vehicle record | ✅ **new** |
| Staff appointment creation | `dto.vehicleId` → vehicle record | ✅ **new** |
| Staff reschedule | the appointment's vehicle | ✅ **new** |
| Booking simulator | shared select | ✅ **new** |
| ETA initialisation (queue projection) | the waiting visit's vehicle | ✅ **new** — see below |
| Reporting (planned duration) | reads the stored start/end | ✅ inherits |

Reporting derives from `scheduledStartAt`/`scheduledEndAt` on the row, so it
inherits whatever the booking path wrote, and must not grow its own copy of the rule.

### The ETA path was NOT merely inheriting

Checking rather than assuming found a fourth copy of the rule. `resolvePlannedMinutes`
projects a checked-in visit that has no service order yet from its **booked
services**, and that branch summed `baseDurationMinutes × qty` with no knowledge of
the vehicle. A waiting SUV general service was therefore projected at 90 minutes —
wrong for that customer, and wrong for everyone behind them in the queue, because
the queue projection cascades.

Fixed: the branch now calls `catalogueMinutesFor`, `scheduling.service.ts` loads the
waiting visit's `vehicle.serviceClass`, and the class columns are required on that
input too. A fixed KPI standard still wins where one exists — it is already
vehicle-class aware (CR-2026-088).

### How divergence is prevented, not just fixed

Three mechanisms, in order of strength:

1. **`MeasurableService` requires the class columns.** A query that omits them
   fails to compile. Making them required is what surfaced every divergent call
   site — the compiler found all of them, rather than a person having to.
2. **`SERVICE_DURATION_SELECT`** is the one Prisma select. Hand-listing columns is
   how Defect A happened; naming the constant is how it cannot happen again.
3. **A runtime guard** distinguishes `undefined` (never selected — throws, naming
   the service) from `null` (selected, no class-specific figure — fine). This
   catches paths that reach the resolver through `any`.

`sourceChannel` is not an input to the resolver and must never become one (§4).

---

## 3. Unknown vehicle class — the implemented behaviour (§5)

**An unclassified vehicle now resolves to the LONGEST configured duration.**

General Servicing with no class on the vehicle record plans at **120 minutes**, not 90.

This reverses the first cut, which fell back to the base (sedan) figure. The two
errors are not symmetrical: over-planning costs a little capacity, while
under-planning holds a bay past the slot and into the next customer's appointment.
Missing classification data is not resolved in the shop's favour.

The reason is reported, not hidden — `classBasis` is one of `SEDAN`, `SUV`,
`NOT_APPLICABLE`, or `UNKNOWN_ASSUMED_LONGEST`, so a preflight or report can tell
"120 because it is an SUV" from "120 because nobody knows what it is".

Classification is **not** required before booking. Requiring it would block a new
customer at the first step over a field they cannot answer, to avoid a 30-minute
over-plan. The conservative default carries that risk instead.

---

## 4. ⚠ The architectural limitation, stated plainly (§7)

**`DEFAULT` means exactly the flat default for every service. There is no
per-service exception, and none was added.**

While `appointment_duration_source = DEFAULT`, every online booking is planned at
`booking_default_duration_minutes` (80) regardless of what any service is
configured to take. General Servicing's approved 90/120 **cannot** be honoured
under DEFAULT without introducing exactly the kind of hidden special case §7
forbids.

So the answer to §7 is **option A**: keep GEN-SERV-01 non-public until the duration
policy is switched to CATALOGUE. Option B — a named per-service override policy —
was **not** built. It would add a third concept to a system that now has exactly
two, to serve one service, ahead of a decision that may make it unnecessary.

The resolver still computes and reports the correct configured duration under
DEFAULT (§6), which is what makes the comparison in §6 below possible.

---

## 5. Action taken on GEN-SERV-01 (§2)

GEN-SERV-01 was made publicly bookable on 2026-09-18 during CR-2026-111, before
this analysis existed. **It has been withdrawn from the public catalogue.**

The activation script's preflight now blocks it, and would block any service in the
same position:

```
GEN-SERV-01   BLOCKED — must not be offered to the public
              • would be UNDER-PLANNED for a sedan vehicle: production plans 80
                minutes, the approved duration is 90 (10 short)
              • would be UNDER-PLANNED for a suv vehicle: production plans 80
                minutes, the approved duration is 120 (40 short)
              • would be UNDER-PLANNED for a unclassified vehicle: production
                plans 80 minutes, the approved duration is 120 (40 short)
              WITHDRAWN from the public catalogue
```

The service **definition remains** — correct, validated, KPI-mapped, and not
offered. The booking page's card list is filtered against what is actually
bookable, so the General Servicing card simply does not appear. Nothing breaks and
no customer reaches a dead end. Verified: 7 category cards offered, no visual
problems, end-to-end demonstration still passes.

**BAT-01 and ASSESS-01 remain public.** Both are 30-minute services planned at 80 —
*over*-planned, which spends a little capacity but cannot overrun a slot. Their
catalogue durations stay truthful at 30 (§8); they were not inflated to match the
temporary production setting.

---

## 6. §10 — Production activation proposal

**Not executed.** This is the proposal, with the `?` values resolved.

### Current production duration policy

`appointment_duration_source = DEFAULT` → every booking planned at **80 minutes**.

### The table

| Service | Public | Catalogue duration | Current production planned duration | Resource path | Verdict |
|---|---|---:|---:|---|---|
| General Servicing — Sedan | Proposed | 90 | **80** | GENERAL | ❌ **BLOCKED** — 10 min short |
| General Servicing — SUV | Proposed | 120 | **80** | GENERAL | ❌ **BLOCKED** — 40 min short |
| General Servicing — unclassified | Proposed | 120 | **80** | GENERAL | ❌ **BLOCKED** — 40 min short |
| Battery Test / Replacement | Proposed | 30 | **80** | GENERAL | ✅ safe (over-planned 50) |
| Service Assessment | Proposed | 30 | **80** | GENERAL | ✅ safe (over-planned 50) |

Already public and unaffected: `BRK-01` (30), `CLEAN-01` (30), `INSP-01` (75),
`OIL-01` (30), `TIR-01` (25), `TIR-02` (60) — all planned at 80, all over-planned.

### Recommended sequence

**Step 1 — decide the duration policy.** This is the gate; nothing else moves
until it is settled. Stage 4F found that switching to CATALOGUE materially
increases accepted daily throughput, which is the upside; the cost is that every
service's planned length changes at once.

**Step 2a — if CATALOGUE is approved:**

1. Switch `appointment_duration_source` to `CATALOGUE` in production, as its own
   change with its own approval. Not part of this activation.
2. Re-run `pnpm booking:customer-catalogue` against production (report only) and
   confirm the preflight shows no blockers.
3. Run `pnpm booking:customer-catalogue --commit` — creates GEN-SERV-01 and
   ASSESS-01 in production with `bookableOnline = false`, and maps them for KPI.
   **Production does not yet contain these services** (§9); they exist only in
   development.
4. Re-run report-only and read the proposed catalogue.
5. Run `pnpm booking:customer-catalogue --commit --activate`.
6. Confirm the resulting catalogue is 9 services and spot-check a General
   Servicing booking resolves 90 (sedan) / 120 (SUV).

**Step 2b — if DEFAULT is retained:**

1. Run `pnpm booking:customer-catalogue --commit` in production — creates the
   definitions, publishes nothing.
2. Run `pnpm booking:customer-catalogue --commit --activate`. The preflight will
   activate BAT-01 and ASSESS-01 and **block GEN-SERV-01 by itself**. No manual
   care is required; the gate enforces it.
3. General Servicing remains unavailable online until the policy changes.

Steps 2a and 2b are both idempotent and safe to re-run.

---

## 7. §9 — the activation script

`pnpm booking:customer-catalogue [--commit] [--activate] [--withdraw]`

Every run, in order:

1. **Names the database** — host and database from `DATABASE_URL`, credentials
   stripped, with a warning when it is not localhost.
2. **Shows the current public catalogue**, flagging anything already unsafe.
3. **Shows what it proposes** to create, correct, map or publish.
4. **Preflights** every proposed service: active, has a required capability, has a
   usable duration, has a customer-facing name, and — the check added here — is not
   under-planned by the production policy.
5. **Is idempotent** — matched by code, correct rows left alone.
6. **Writes only under `--commit`**, publishes only under `--activate`. Default is
   report-only.
7. **Reports the resulting customer-facing catalogue**, with catalogue duration
   beside planned duration so the two can never be confused.

`--withdraw` takes an already-public service back out when it fails preflight. The
script exits non-zero when anything is blocked, so a deployment pipeline cannot
mistake a blocked activation for a successful one.

These services are **never** added by an ordinary deployment seed. What the shop
offers the public is an operational decision, not a consequence of shipping code.

---

## 8. §12 — permanent regression tests

`apps/api/src/modules/scheduling/availability/__tests__/cr-2026-111b-duration-parity.spec.ts`
— 33 tests driving the **real** services through the **real** shared engine. A
stubbed engine would prove only that the stub agrees with itself.

| Requirement | Sedan | SUV |
|---|---|---|
| Customer create | 90 ✅ | 120 ✅ |
| Customer reschedule | 90 ✅ | 120 ✅ |
| Staff create | 90 ✅ | 120 ✅ |
| Staff reschedule | 90 ✅ | 120 ✅ |

Plus: staff and customer never differ; a reschedule never changes the length; an
unclassified vehicle gets 120; DEFAULT has no per-service escape hatch; the
shortfall is reported.

**Defect A** — `catalogueMinutesFor` throws, naming the service, when the class
columns were not selected. Both real queries are asserted to request them.

**Defect B** — the reschedule tests use a mock that **honours the Prisma select**,
so dropping the columns from the include actually reproduces the defect.

### Mutation-verified

A test that cannot fail is decoration. Both were checked by reintroducing the bug:

| Mutation | Result |
|---|---|
| Staff create ignores the vehicle class | **4 tests fail** |
| Defect B reintroduced (include drops the class columns) | **2 tests fail**, naming GEN-SERV-01 |

The second mutation initially passed — the mock ignored the `include` and returned
every column regardless. That gap was found and fixed; without it the Defect B
tests would have been decorative.

---

## 9. Verification

| Check | Result |
|---|---|
| API typecheck | clean |
| Web typecheck | clean |
| API tests | **1635 passed**, 17 skipped |
| Web tests | **309 passed** |
| Duration parity spec | 33 passed |
| Visual QA (390×844) | no problems — 7 cards, General Servicing correctly absent |
| End-to-end demonstration | DEMONSTRATED |
| Schema drift | none |

---

## 10. §11 — the two Job Sheet behaviours, retained

Unchanged and covered by
`appointments/__tests__/cr-2026-111-job-sheet-prefill.spec.ts`:

- **Concern:** customer wording → `BookingIntake` → `CUSTOMER_CONCERN` VisitNote at
  check-in → Job Sheet. Not forced through `ServiceOrder.notes`.
- **Mileage:** `Appointment.customerReportedMileage` → `ServiceVisit.mileageIn`
  **only when blank** → Job Sheet. A staff-measured reading always wins, and the
  record says which is which.

---

## 11. Observed, not changed — service-order estimates

`ServiceOrderItem.estimateMinutes` defaults to `serviceType.baseDurationMinutes`
with no vehicle-class awareness:

- `service-orders.service.ts:194`, `:321`
- `walk-ins.service.ts:314`

So a **walk-in** SUV General Servicing would take a 90-minute item estimate rather
than 120. This is the same family of problem, and it is flagged rather than fixed
for three reasons: §3's list names the appointment paths and not service orders; an
item estimate is the *work order's* figure, a different concept from the
appointment's planned duration, and an advisor can override it per item; and §13
says not to start another redesign.

**Recommended as the next follow-up**, sized at roughly the same as this change: a
service order created for a classified vehicle should take its estimate from the
same resolver. Not actioned here.

---

## 12. Open decisions

1. **`appointment_duration_source`** — DEFAULT or CATALOGUE. Blocks General
   Servicing going public. Stage 4F's throughput finding is the case for CATALOGUE.
2. **Production catalogue activation** — §6 above, once (1) is settled.

Neither is actioned. Production remains on `DEFAULT`, and production still does not
contain GEN-SERV-01 or ASSESS-01.
