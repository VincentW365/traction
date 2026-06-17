# CR-2026-041 — Allow same-day scheduling at any future time (relax DMAIC Rule 1)

**Status:** IMPLEMENTED. **Type:** Appointment timing business-rule change — **§9 mandatory review trigger**; owner-approved before coding.
**Author:** Vincent Wilson · **Date:** 2026-06-17

## 1. Request
"I am not able to schedule an appointment on the day of the appointment, nor reschedule. It says it has to be in the future but it's in reference to the other day. Any time in the future should be bookable — any time in the future during business hours."

Owner decision (asked & answered before implementing): **"Allow any future slot today"** — drop the 10:00 AM cutoff + manager-override requirement; book/reschedule to any future time within business hours; keep only the guard that blocks a time already in the past.

## 2. Diagnosis
Two independent guards ran on create/reschedule:
1. **Future check** (`isBefore(scheduledStartAt, new Date())`, create §1 + update reschedule) — rejects any instant before *now*. Correct in principle, but the **web pre-filled a past time**: the reschedule modal seeded the appointment's *original* (often past) date/time, and the schedule's "new at this slot" deep-linked *whatever slot was clicked*. Submitting those unchanged tripped "must be in the future" — the user's "in reference to the other day" symptom.
2. **DMAIC Rule 1 — same-day cutoff** (`enforceSameDayCutoff`, create only): same-day appointments after 10:00 AM blocked unless a manager override is supplied. This is what actually blocked normal afternoon same-day booking.

The reschedule path never called the cutoff — its only blocker was the past-time pre-fill (#1).

## 3. Change
### API — `apps/api/src/modules/appointments/appointments.service.ts`
- **`create()`**: the `enforceSameDayCutoff(...)` call is **removed** (commented out with a restore note). Same-day future bookings now proceed with no cutoff / no manager override.
- The **`enforceSameDayCutoff` method is retained, unused**, so the rule can be re-enabled by restoring the single call. Its unit tests (`__tests__/same-day-cutoff.service.spec.ts`) are also retained and still pass (they exercise the method directly), proving it works if re-wired.
- **Kept:** the past-time guard (`isBefore(... , new Date())`) on both create and reschedule — message clarified to *"Scheduled start time must be in the future (a later time today is allowed)."* — and `validateOperatingHours` (business-hours + open-day enforcement) is unchanged.

### Web — never pre-fill / submit a past time
- `apps/web/app/(dashboard)/appointments/new/page.tsx`: date input `min` = today; a past-time guard disables **Create** and shows an inline hint when the chosen slot is already past.
- `apps/web/components/appointment-detail-modal.tsx` (reschedule): date input `min` = today; if the appointment's original slot is in the past, the form opens defaulted to **today** (not the past date); past-time guard disables **Save** with the same inline hint.

## 4. Effect on business rules
- **DMAIC Rule 1 (same-day cutoff)**: no longer enforced. Same-day appointments are allowed at any future time during operating hours, by any scheduling role, with no manager override and no `SAME_DAY_CUTOFF_OVERRIDE` audit (none is generated because none is needed).
- **Unchanged:** can't book in the past; must be within operating hours / open day; same-vehicle overlap rejection (P4); same-day merge (SCH-004); all other priority/queue logic.
- `BusinessRuleConfig` keys `same_day_appointment_cutoff_time` / `manager_override_required_after_cutoff` are left in the DB (dormant), so re-enabling is config + the one restored call.

## 5. Files
- `apps/api/src/modules/appointments/appointments.service.ts` — cutoff call removed; future-check message clarified.
- `apps/web/app/(dashboard)/appointments/new/page.tsx` — date min + past-time guard.
- `apps/web/components/appointment-detail-modal.tsx` — date min + future-safe default + past-time guard.
- `docs/63_CR_2026_041_SameDay_Scheduling_Relax.md` (this file).
- **Untouched (intentionally retained):** `enforceSameDayCutoff` method + `same-day-cutoff.service.spec.ts`.

## 6. Verification
- API + web typecheck green.
- API `vitest run` green (incl. retained same-day-cutoff specs — method behaviour unchanged).
- Manual: booking a slot **later today** during business hours succeeds (no manager override); selecting a **past** time disables submit with the inline hint; rescheduling a past appointment opens defaulted to today and saves to a future slot.

## 7. Governance
Appointment timing rule change → CLAUDE.md §9 mandatory review trigger. **Owner-approved before coding** (this session). Reversible: restore the single `enforceSameDayCutoff` call to reinstate Rule 1. No schema change, no auth change, no audit weakening (the cutoff override audit simply no longer occurs because the cutoff no longer fires).
