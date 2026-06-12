# CR-2026-026 — Schedule Quick-Book "Holds"

**Status:** APPROVED AS PLAN — implementation NOT started.
**Type:** Separate Change Request (new entity + additive schema + new API + web).
**Author:** Vincent Wilson · **Drafted:** 2026-06-12
**Approval gate:** Mandatory Review — additive schema migration must be approved **before** it is applied.

> This document is a plan of record. **No schema, API, or web code has been implemented.** The
> migration in H-a must be reviewed and approved before it is applied (take a `pg_dump` first).

---

## 1. Problem Statement

When a staff member clicks an empty time block on the Schedule, they want to **reserve that slot
immediately without entering any details** ("quick book without details") — e.g. "someone is coming
at 2:00 PM for an oil change" — and fill in the customer/vehicle/services later.

Today this is impossible: an `Appointment` legally requires a **customer**, a **vehicle**, and **at
least one service**. There is no way to hold a slot with little or no information.

A **hold** provides a fast "reserve now, fill in later" path while keeping appointment data integrity
fully intact.

---

## 2. Approved Decision Summary

- **Architecture:** Introduce a **new `ScheduleHold` entity**. Do **not** relax `Appointment`.
- `Appointment.customerId` / `Appointment.vehicleId` stay **required** (non-null). Holds are **not**
  appointments.
- **Holds are isolated from the scheduling brain:** they do **not** enter the queue, ETA, priority,
  resource/bay matching, check-in, or any scheduling-engine logic. They render **only** as advisory
  reserved blocks on the Appointments lane.
- **Resolved open decisions:**
  1. **Duration:** quick picker **30 / 60 / 90 minutes**, **default 30**.
  2. **Permission:** reuse **`APPOINTMENT_CREATE`** in v1 (no new permission unless a technical
     blocker appears).
  3. **Convert:** when a hold is converted into an appointment, automatically mark the hold
     **`CONVERTED`**, link it via **`convertedAppointmentId`**, and the hold **drops off the lane**.
  4. **Expiry:** include optional **`expiresAt`** in the schema now; **manual release only** in v1;
     **no auto-expiry jobs** in v1.
  5. **Minimum fields:** required = **site, start time, duration/end time**; optional = **label,
     notes**; **no customer / vehicle / service** required.

---

## 3. Why `ScheduleHold` Is Preferred Over Relaxing `Appointment`

Two approaches were considered:

**Approach A — relax `Appointment`** (make `customerId`/`vehicleId` nullable, allow zero services,
add a `HELD` status). **Rejected** because:
- `customerId` is a required FK today; making customer + vehicle + services all optional **weakens a
  core aggregate** across the entire platform (`findBySite`, the appointments page, the detail modal,
  check-in, overlap/same-day-merge logic, reporting).
- It collapses two genuinely different concepts (a *reserved slot* vs a *booked appointment*) into one
  entity with a "messy status field" — explicitly an anti-pattern under the platform operating rules.
- It would drag in the separately **deferred** vehicle-optional appointment decision.

**Approach B — new `ScheduleHold` table (APPROVED)** because:
- `Appointment` invariants stay **untouched** (customer/vehicle/service remain required).
- It is **additive** (new table + enum only), backward-compatible, and low-ripple.
- It models the real concept: *a reserved slot that is not yet a booking*.
- It sidesteps the deferred appointment-relaxation question entirely.

---

## 4. Proposed Schema (additive — applied only after approval in H-a)

```prisma
enum ScheduleHoldStatus {
  ACTIVE
  CONVERTED
  RELEASED
}

model ScheduleHold {
  id                     String             @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  siteId                 String             @map("site_id") @db.Uuid
  scheduledStartAt       DateTime           @map("scheduled_start_at") @db.Timestamptz
  scheduledEndAt         DateTime           @map("scheduled_end_at") @db.Timestamptz   // start + (30|60|90)
  status                 ScheduleHoldStatus @default(ACTIVE)
  label                  String?            // optional short label, e.g. "Oil change - walk-up"
  notes                  String?
  // SOFT reference (plain UUID, no Prisma relation) so the Appointment model is NOT modified.
  convertedAppointmentId String?            @unique @map("converted_appointment_id") @db.Uuid
  expiresAt              DateTime?          @map("expires_at") @db.Timestamptz          // optional; manual release only in v1
  createdByUserId        String?            @map("created_by_user_id") @db.Uuid
  createdAt              DateTime           @default(now()) @map("created_at") @db.Timestamptz
  updatedAt              DateTime           @updatedAt @map("updated_at") @db.Timestamptz

  site Site @relation(fields: [siteId], references: [id])

  @@index([siteId, scheduledStartAt])
  @@index([status])
  @@map("schedule_holds")
}
```

**Notes**
- `scheduledEndAt` is **required** (derived from the chosen 30/60/90 duration) — a hold always has a
  concrete block on the lane.
- `convertedAppointmentId` is a **soft reference** (no relation field added to `Appointment`), so the
  migration is purely "add enum + add table" and the `Appointment` model is **not** changed.
- `Site` gains a back-relation `scheduleHolds ScheduleHold[]` (additive, reference-only).
- Migration = `CREATE TYPE "ScheduleHoldStatus"` + `CREATE TABLE schedule_holds`. No data backfill,
  no destructive change.

---

## 5. API Endpoints

New module `apps/api/src/modules/schedule-holds/` (controller + service + DTOs). All gated by
`APPOINTMENT_CREATE` (v1).

| Method & path | Purpose | Body / params |
| --- | --- | --- |
| `POST /schedule-holds` | Create a hold | `{ siteId, scheduledStartAt, durationMinutes (30\|60\|90), label?, notes? }` → server computes `scheduledEndAt` |
| `GET /schedule-holds?siteId&date` | List **ACTIVE** holds for the day | query params |
| `DELETE /schedule-holds/:id` | Release a hold (`status = RELEASED`) | — |
| `POST /schedule-holds/:id/convert` | Mark `CONVERTED` + set `convertedAppointmentId` | `{ appointmentId }` |

- **Validation:** `durationMinutes ∈ {30,60,90}`; `scheduledStartAt` required; `siteId` required.
- **Audit:** create / release / convert each write an `AuditLog` entry (timestamped, actor-attributed).
- **No** customer/vehicle/service fields are accepted or required.

---

## 6. UI Behavior

- **Empty-slot popover** (existing "New appointment at HH:MM" popover on the Appointments lane) gains a
  **"Quick Hold"** action alongside "Schedule Appointment", with a **30 / 60 / 90** duration picker
  (default 30) and optional label.
- **Appointments lane** also renders holds, with **distinct "HELD" styling** (e.g. dashed/striped,
  muted) so a hold is never mistaken for a booked appointment.
- **Hold click** opens a small **hold modal** showing time/duration/label/notes with two actions:
  - **Convert to appointment** → opens the booking wizard prefilled with the hold's slot
    (`/appointments/new?date=&time=&holdId=`); on successful booking the hold is converted + linked and
    drops off the lane.
  - **Release hold** → `DELETE /schedule-holds/:id`; the block disappears.
- **Wizard** (`appointments/new`) reads `?holdId=`; after the appointment is created it calls
  `POST /schedule-holds/:id/convert`.

---

## 7. Lifecycle: Create / Show / Convert / Release

1. **Create** — click empty slot → "Quick Hold" → pick 30/60/90 (default 30) + optional label →
   `ScheduleHold(status=ACTIVE)` with computed `scheduledEndAt`.
2. **Show** — renders on the Appointments lane as an advisory "HELD" block (visually distinct).
3. **Convert** — from the hold modal → booking wizard prefilled with the slot → on booking success the
   hold is marked **`CONVERTED`**, `convertedAppointmentId` is set, and it **drops off the lane**.
4. **Release** — manual release → **`RELEASED`** (block removed). `expiresAt` exists in the schema for a
   future auto-release job but **no auto-expiry runs in v1**.

---

## 8. Permission Decision

- **v1 reuses `APPOINTMENT_CREATE`** for create / release / convert (a hold is a scheduling action,
  available to the same roles that book appointments: Front Desk, Service Advisor, Manager, Admin).
- A dedicated `SCHEDULE_HOLD_MANAGE` permission is **not** added in v1 unless a technical blocker
  appears.

---

## 9. Rule-Engine Impact

**None.** Holds are isolated from the scheduling brain:
- They never enter the **queue**, **ETA**, **priority class**, **fairness/weighting**, **resource/bay
  matching**, **parts readiness**, or **check-in** flows.
- They are advisory time markers only (consistent with appointments not reserving a bay until
  dispatch).
- No change to appointment priority, grace/lateness, fast-track, batching, transport, or parts rules.

This isolation is the key safety property: a hold cannot corrupt scheduling/queue/ETA logic.

---

## 10. Risks and Mitigations

| Risk | Mitigation |
| --- | --- |
| Two concepts on one lane (appointment vs hold) | Distinct "HELD" styling + label; never share appointment styling. |
| Stale / cluttering holds | Manual release in v1; `expiresAt` reserved for a future auto-release job; optionally hide past holds in the UI. |
| Convert race / double-show | Mark `CONVERTED` + link `convertedAppointmentId` as part of the convert call; hold filtered out of the ACTIVE list immediately. |
| Scope creep toward capacity enforcement | v1 holds are advisory only (no hard capacity block), consistent with appointments not reserving bays at booking. Capacity enforcement would be a separate, scheduler-touching CR. |
| Accidental coupling to the scheduling engine | Holds live in their own module; no reads/writes from queue/ETA/dispatch code. Covered by tests asserting exclusion. |

---

## 11. Build Phases (each: verify → pause → commit named files)

- **H-a** — Schema + **additive migration** (`ScheduleHold` model + `ScheduleHoldStatus` enum + `Site`
  back-relation). **Applied only after approval, with a `pg_dump` first.**
- **H-b** — API module: `ScheduleHoldsController` + service + DTOs (`POST` / `GET` / `DELETE` /
  `convert`), `APPOINTMENT_CREATE` gating, audit on create/release/convert, unit tests.
- **H-c** — Web: lane renders holds; empty-slot popover gains "Quick Hold" + 30/60/90 picker; hold
  modal (Convert / Release); wizard `?holdId=` → convert linkage.
- **H-d** — Tests / verify: create / convert / release; holds excluded from queue/ETA/scheduling;
  permission gating; web typecheck + tests.

---

## 12. Guardrails

- This is a **separate CR (CR-2026-026)**, distinct from the appointments/schedule work already
  committed.
- **Implementation has NOT started.** This document is plan-only.
- The **schema migration (H-a) requires explicit approval before it is applied** (take a `pg_dump`
  first; apply via the normal migration flow after a paused review).
- In v1, **`Appointment`, `ServiceVisit`, check-in, queue, ETA, and the scheduling engine remain
  untouched.** Holds are additive and isolated.
- No new third-party dependency. No change to existing permissions beyond reusing `APPOINTMENT_CREATE`.
- No auto-expiry job in v1. No capacity enforcement in v1.
