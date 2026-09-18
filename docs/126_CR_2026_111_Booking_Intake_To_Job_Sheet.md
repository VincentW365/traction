# CR-2026-111 — Customer booking as the Job Sheet's intake layer

**Status:** Delivered
**Date:** 2026-09-18
**Scope:** Public booking UX, booking intake persistence, check-in propagation, Job Sheet display
**Production behaviour changed:** yes — see §7 and §8

---

## 1. The goal, and the gap it closed

> Customer enters information once → Appointment created → Job Sheet automatically
> pre-filled → staff do not retype the same information.

Before this change the customer's own words reached the database but stopped short
of the document the advisor actually reads. Two specific breaks:

| What the customer typed | Where it landed | Where the Job Sheet looked |
|---|---|---|
| Their concern | a `VisitNote` | the sheet did not read visit notes |
| Their mileage | `Appointment.customerReportedMileage` | `ServiceVisit.mileageIn` |

Nothing joined the two, so an advisor retyped a number the customer had already
given, and re-asked a question the customer had already answered.

---

## 2. The six-step flow

`apps/web/app/book/page.tsx`

**Customer → Vehicle → Service → Details → Appointment → Review**

- A visible stepper. A **completed step is a button** the customer can click to go
  back; a step they have not earned yet is inert rather than a link that half-works.
- A step is reachable once everything before it is answered
  (`STEPS.slice(0, i).every(complete)`).
- **Back** on every step after the first.
- Mobile-first: 44px minimum tap targets, numeric keypad for the mileage, a sticky
  action bar so Continue stays in reach of a thumb, no sideways scroll at 390px.

---

## 3. What the customer chooses

`apps/web/lib/booking-categories.ts` — pure data and pure functions, tested
independently of any rendering.

| Card | Books |
|---|---|
| General Servicing | `GEN-SERV-01` |
| Oil Change | `OIL-01` |
| Battery Test / Replacement | `BAT-01` |
| Brake Service / Inspection | `BRK-01` (inspection) · `BRK-02` (pads) · `ASSESS-01` (a concern) |
| Tire & Wheel Service | `TIR-01` · `TIR-02` · `ASSESS-01` (a concern) |
| Vehicle Inspection | `INSP-01` · `BRK-01` · `ASSESS-01` (a general check-over) |
| Vehicle Cleaning | `CLEAN-01` |
| Other / Describe My Issue | `ASSESS-01` |

Three rules hold this together:

1. **A described problem is not a diagnosis.** "Something is wrong with the brakes"
   books the **assessment**, never a pad replacement. Booking the repair would
   decide the job before anybody had looked at the car.
2. **`DISC-01` is never offered.** It is superseded by `BRK-02`; offering both would
   let a customer book the retired code and split reporting for the same work.
3. **Only cards whose services are actually bookable online are shown.** The card
   list is filtered against `/public/booking/services`, so a service that is
   approved but not yet activated simply does not appear — no customer reaches
   Review and fails at the last step. Activating a service makes its card appear
   with no code change.

If *no* card can be offered (a renamed code, a catalogue mid-edit) the page falls
back to the plain service list. A booking page with nothing on it is an outage.

---

## 4. Dependency-aware back navigation (§9)

Changing an earlier answer invalidates **only what depends on it**:

| Changed | Released | Kept |
|---|---|---|
| Customer (re-identify) | vehicle choice, chosen time | service, details |
| Vehicle | chosen time (class can change the length) | service, details |
| Service (card or option) | chosen time **only if the booked codes changed** | details |
| Details (mileage, concern, symptoms, comments) | nothing | everything |
| Appointment | nothing | everything |

Re-picking the **same** answer is not a change and releases nothing.

When a time is released the customer is told which change released it, naming the
time they had picked:

> The Fri, Sep 18, 2:40 PM appointment you picked has been released because the
> service you chose takes a different amount of time. Please choose a time again.

Silently clearing the time would be the worst outcome: they would reach Review,
find no appointment, and not know whether the system lost it or they never picked one.

Symptoms are cleared when the category changes — carrying "Noise when braking" into
a battery booking would put a false observation on the Job Sheet.

---

## 5. What reaches the Job Sheet

```
/book  ──confirm──▶  Appointment + BookingIntake   (one transaction)
                          │
                     check-in
                          ▼
                   ServiceVisit.mileageIn
                   VisitNote(CUSTOMER_CONCERN)
                          │
                          ▼
              Job Sheet — "FROM THE CUSTOMER'S BOOKING"
```

- `BookingIntake` is written **in the same transaction** as the appointment. A
  booking cannot exist without the customer's words, which is the failure this CR
  set out to end.
- At check-in the customer's **own sentence leads** the concern note; ticked
  symptoms follow as plain words (`BRAKE_NOISE` → "brake noise"), never as raw
  codes on a document an advisor reads.
- Mileage is promoted to `ServiceVisit.mileageIn` **only when that field is blank**.
  A reading taken at the desk is a physical observation; a customer's recollection
  is not. This can promote a customer's number into a blank, never overwrite a
  verified one — and the record says which it is.
- The Job Sheet renders it as a **read-only block, distinct from
  `CUSTOMER'S DIRECTIVE`**. The customer described it; the advisor authorised it.
  Merging them would let a description read as approved work scope.

---

## 6. Vehicle-class durations

Management approved **General Servicing at 90 minutes (sedan) / 120 (SUV)**.

The class is read from `Vehicle.serviceClass` **on the server**, never from the
request — a public caller must not be able to claim "sedan" and buy a shorter slot
than the work needs. A vehicle being added for the first time has no class yet and
plans at the service's base duration, which is the approved configuration's own
default rather than a guess made at booking time.

Threaded through `availability()`, `confirm()` and `rescheduleByCustomer()`, so a
customer who **moves** an SUV general service keeps its 120 minutes.

---

## 7. ⚠ Standing caveat: the duration source

`appointment_duration_source` is currently **`DEFAULT`** at this site.

Under `DEFAULT` every online booking is planned at the flat default length
(80 minutes) and **every catalogue duration — including the approved 90/120 split —
changes nothing.** Under `CATALOGUE` the approved per-service figures apply.

The mechanism is built, tested and ready. **It was not switched on**, because
changing that rule alters the planned length of every online booking for every
service, which is a business decision with shop-wide effect and not a side effect
of this change. Two tests in
`public-booking/__tests__/cr-2026-111-intake.spec.ts` assert both behaviours, so the
caveat cannot quietly stop being true.

**Decision needed:** whether to switch `appointment_duration_source` to `CATALOGUE`.

---

## 8. Two defects found and fixed during the work

1. **`resolveServices` did not select the class columns.** It selected only
   `baseDurationMinutes`, so `sedanDurationMinutes` / `suvDurationMinutes` were
   always `undefined` and the 90/120 split would have been dead on arrival — the
   feature would have looked complete and done nothing. The same omission in
   `appointmentInclude()` would have shrunk an SUV general service from 120 to 90
   minutes when a customer rescheduled it.

2. **The mileage provenance note did not check the channel.** It stated "from the
   online booking" for any appointment carrying a reported mileage. Only
   self-service bookings populate that column today, but the note's entire purpose
   is provenance, and asserting it from an assumption that could stop being true is
   the wrong place to guess. Now gated on `sourceChannel`.

---

## 9. Verification

| Check | Command | Result |
|---|---|---|
| Mapping rules (pure) | `pnpm --filter @bsop/web exec vitest run lib/__tests__/booking-categories.spec.ts` | 16 passed |
| Booking scenarios §16 | `pnpm --filter @bsop/api exec vitest run src/modules/public-booking/__tests__/cr-2026-111-intake.spec.ts` | 18 passed |
| Job Sheet pre-fill | `pnpm --filter @bsop/api exec vitest run src/modules/appointments/__tests__/cr-2026-111-job-sheet-prefill.spec.ts` | 12 passed |
| UX surfaces §8/§9/§20 | `pnpm --filter @bsop/web exec vitest run __tests__/cr-2026-111-surfaces.test.ts` | 34 passed |
| Full API suite | `pnpm --filter @bsop/api exec vitest run` | 1602 passed, 17 skipped |
| Full web suite | `pnpm --filter @bsop/web exec vitest run` | 309 passed |
| **End-to-end demonstration (§17)** | `pnpm booking:demonstrate` | DEMONSTRATED |
| Visual QA at 390×844 | `pnpm booking:visual-qa` | no problems |

### The §17 demonstration

`pnpm booking:demonstrate` runs the whole journey against a live stack — the public
HTTP API a customer would hit, a staff login, a real check-in, and the Job Sheet
endpoint the advisor's screen reads — then prints what the customer typed beside
what the advisor sees. Nothing is asserted from inside the application; every fact
is read back out of the API. It creates real records and removes them afterwards
(`--keep` to leave them).

Confirmed on 2026-09-18:

```
✓ their concern, word for word
✓ their extra note
✓ the mileage they read off the dashboard
✓ the mileage landed on the visit's own field (ServiceVisit.mileageIn)
✓ what they ticked, in plain words rather than codes
✓ booked an assessment, not a repair decided on their behalf
```

---

## 10. Catalogue state

`pnpm booking:customer-catalogue [--commit] [--activate]`

Activated 2026-09-18 (`--commit --activate`). **9 services bookable online:**
`BRK-01`, `CLEAN-01`, `BAT-01`, `INSP-01`, `OIL-01`, `TIR-01`, `TIR-02`,
`GEN-SERV-01`, `ASSESS-01`.

| Code | Duration | KPI classification |
|---|---|---|
| `GEN-SERV-01` | 90 base / 90 sedan / 120 SUV | `GENERAL_SERVICE_CORE` / `PACKAGE_COMPONENT` |
| `ASSESS-01` | 30 | `INCLUDED_NO_ADDITIONAL_BENCHMARK` / `SEPARATE_SLA` |

`ASSESS-01` exists **precisely so an assessment is not booked as a General Service**.
Reusing a general-service code would measure a 30-minute look-over against the
90-minute general-service benchmark and report the shop as far ahead of standard.

**`BRK-02` is not bookable online**, so the "Brake pad replacement" option is hidden.
That was not in the approved activation list. Activating it would make the option
appear with no code change.

---

## 11. Out of scope / not done

- **The duration source was not switched** (§7) — decision required.
- **Staff-side duration resolution is unchanged.** `appointments.service.ts` and
  `walk-ins.service.ts` still select only `baseDurationMinutes`, so the 90/120 split
  applies to customer bookings but not to a staff-created appointment. Changing
  staff scheduling behaviour was outside this CR; worth a follow-up so the two
  paths agree.
- **CR-2026-110** (public/internal access split) remains NOT STARTED — see `docs/125`.
