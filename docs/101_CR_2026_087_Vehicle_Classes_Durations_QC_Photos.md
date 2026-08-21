# CR-2026-087 — Vehicle classes, per-class durations, senior-tech QC, and inspection photos

**Status:** DRAFT — awaiting owner decisions. Nothing in this document has been built.
**Raised:** 2026-08-21, from the service manager's requirements.
**Companion:** CR-2026-086 (shipped) covered the parts of the same request that needed no
schema change or new infrastructure — see §G.

---

## A. Objective

Four requirements from the manager that each cross a governance line in `claude.md` §9
(core-entity schema change, business-rule change, or a new third-party dependency), so
they are surfaced here rather than implemented directly:

1. Reduce vehicle categories to **Sedan** and **SUV** only.
2. **Service durations that differ per category** (sedan vs SUV activity tables).
3. **Quality control assigned to a Senior Technician in advance**, and verified as done.
4. The assigned technician can **upload a photo of the vehicle from their tablet** for
   pre-inspection.

---

## B. Inputs used

- The manager's sedan and SUV activity/time tables, and the KPI benchmark tables.
- Current code, audited 2026-08-21. Findings are stated with file references below.

---

## C. Findings — what exists today

### C1. Vehicle classes

`VehicleServiceClass` (`prisma/schema.prisma:191-199`) has **seven** members:
`SEDAN_CLASS`, `SUV_LIGHT`, `SUV_HEAVY`, `PICKUP`, `VAN`, `TRUCK`, `UNKNOWN_REQUIRES_REVIEW`.

The value is load-bearing for **DMAIC Rule 3** (mobile jacks are sedan-only), enforced in two
live places — `resources/resources.service.ts:132-152` (explicit assignment, manager override
available) and `queue/queue.service.ts:329` (auto-dispatch, silent skip). A third copy of the
rule in `scheduling/engine/resource-compatibility.checker.ts` has **no production caller**.

The enum is mirrored by hand in four more places that must be changed together:
`apps/web/lib/vehicle-classes.ts:6-27`, `resource-compatibility.checker.ts:13-20`, the Swagger
description string in `appointments/dto/check-in.dto.ts:51`, and the seeded
`VehicleWeightSuggestion` list — which itself exists **twice** (`prisma/seed.ts:348-372` and
`apps/api/scripts/reseed-weight-suggestions.ts:12-34`, already out of sync: the script is
missing the VAN row).

**Note:** `VehicleWeightClass` (LIGHT/STANDARD/HEAVY) is a *separate, orthogonal* axis used for
lift ratings. It is not affected by this change and should not be collapsed with it.

### C2. Durations

`ServiceType.baseDurationMinutes` (`schema.prisma:695-725`) is a **single flat integer**. There
is no per-vehicle-class, per-weight-class or per-anything duration mechanism anywhere — no join
table, no override column, no multiplier. `ServiceType` has no relation to `Vehicle` or either
class enum.

The only per-job duration slot is `ServiceOrderItem.estimateMinutes` (`schema.prisma:1047`),
which is always populated as a straight copy of `baseDurationMinutes` at three sites
(`service-orders.service.ts:143`, `:259`, `walk-ins.service.ts:259`) and **never recomputed
afterwards**. That field is the natural seam for a class-varying duration.

Duration consumers: appointment end-time arithmetic (`appointments.service.ts:96`, `:254`,
`:278`, `:754`), technician performance (`performance.service.ts:65`, `:94`, `:180`) and the
service-mix report (`reporting.service.ts:433-450`). Notably the **scheduling engine reads
durations nowhere at all**.

**There is no concept of a service package or bundle** anywhere in the schema — no
`ServicePackage`, no parent/child service types, no composition table. `ServiceType.family` is a
plain grouping label with no duration semantics. So "General Service + Front Brakes" cannot be
expressed today.

### C3. Senior technician and QC

There is **no notion of seniority**. `Technician` (`schema.prisma:926-942`) has only
`employeeCode`, `homeSiteId` and `status`. The only competence signal is
`TechnicianSkill.proficiencyLevel` (per skill, 1-5) and **no code reads it as a gate**. There
are four roles only; there is no SENIOR_TECHNICIAN.

"Senior technician sign-off" on an inspection is currently **RBAC standing in for seniority**:
`INSPECTION_SIGNOFF` is held only by ADMIN, so in practice *only a manager* can sign as senior
technician — a real senior technician cannot. This was a deliberate v1 shortcut
(`docs/57:44`, `docs/68:12`).

**Quality control today is an unattributed, unguarded status transition.** Passing QC is a
generic `POST /service-orders/:id/status` with `toStatus: READY_TO_INVOICE`, gated only by
`SERVICE_ORDER_STATUS` — which technicians also hold. There is:

- no QC assignee (`TechnicianAssignment` has no role/purpose column),
- no `qcByUserId` / `qcAt` (they do not exist anywhere in the schema),
- **no rule stopping the technician who did the work from passing their own QC.**

Ironically a *failed* QC is attributed (`ServiceOrderRework.openedByUserId`) while a *passed*
one is not. The only trace is a generic `StatusHistory` row, which nothing reads back.

> This self-approval hole is worth fixing regardless of which option below is chosen.

### C4. Photo upload

**No file upload capability exists.** No multer, no `FileInterceptor`, no S3/Cloudinary/GCS
SDK, no attachment/photo/media model, and no file input anywhere in the web app.

Two hard constraints:

- **No persistent disk.** `render.yaml` declares no `disk:` block, and Render's free plan does
  not offer one. The API container's filesystem is wiped on every redeploy and every cold
  start — and the free plan spins down when idle. **Anything written to local disk is lost.**
- **The default body limit is 100 kB.** `main.ts` sets no override. A tablet photo is 1-5 MB
  (≈1.4-7 MB base64) and would be rejected by the body parser before any validation ran.

There *is* a precedent for images: `InspectionSignature.imageData` stores a base64 data URL in
an unbounded Postgres `TEXT` column (`schema.prisma:579`, migration `:137`), captured by
`signature-pad.tsx:45` via `canvas.toDataURL()` and rendered straight back into `<img src>`.
That works only because signature PNGs are a few kB.

---

## D. Proposed design — and the decisions needed

### D1. Vehicle classes → Sedan and SUV

Reducing a Postgres enum is not an in-place edit: values cannot be dropped while rows reference
them. The migration is create-new-type → backfill → swap → drop-old.

**The decision is a data one, not a technical one: where do the other five classes go?**
There are 8,247 vehicles in the database. `PICKUP`, `VAN` and `TRUCK` are not SUVs in any normal
sense, and mapping them to SUV would silently make them mobile-jack-ineligible (correct today,
by accident) while also telling staff a pickup is an SUV.

| Option | Effect |
|---|---|
| **A. Map everything non-sedan to SUV** | Simplest. Two categories exactly as asked. Loses the pickup/van distinction permanently, and the SUV duration table would then be applied to a 3-ton truck. |
| **B. Sedan + SUV, keep UNKNOWN** | Two *working* categories plus the existing "needs review" state, so an unclassified vehicle stays mobile-jack blocked rather than being guessed into SUV. **Recommended.** |
| **C. Keep the enum, hide the extras in the UI** | No migration, fully reversible, and the historical distinction survives. Staff only ever see two choices. |

Rule 3 keeps working unchanged under all three (the gate tests `=== 'SEDAN_CLASS'`).

### D2. Per-category durations

Minimal additive change, no change to `ServiceType.baseDurationMinutes`:

```
model ServiceTypeDuration {
  serviceTypeId  String
  serviceClass   VehicleServiceClass
  durationMinutes Int
  @@unique([serviceTypeId, serviceClass])
}
```

Resolution order: class-specific row → `baseDurationMinutes` fallback. The single place this
needs wiring is the three sites that populate `ServiceOrderItem.estimateMinutes`, plus
appointment end-time arithmetic.

**Blocked on input:** the manager's tables give totals for a *general service* (sedan 1.5-2.0h,
SUV 2.0-2.5h) broken into activities, but the platform stores duration per **service type**,
and the activity list (reception, cooling allowance, oil change, filters, wipers, fluid checks,
paperwork) does not map onto the existing 33 service types. The owner has said **"the service
list will be provided"** — that list is the missing input. Two sub-questions come with it:

- The tables are **ranges** (15-20 min); the schema holds a single integer. Store the upper
  bound (safer promises), the midpoint, or add min/max?
- "Cooling allowance (hot vehicle)" is conditional on the vehicle arriving hot. Is that a
  service line staff add, or padding built into every job?

### D3. Senior-technician QC

Two layers, and they can ship independently:

**Layer 1 — attribute and protect QC (small, no decision needed).** Add `qcByUserId` and
`qcAt` to `ServiceOrder`; record who passed QC; **refuse to let the technician who performed the
work pass their own QC.** This closes the self-approval hole in C3 and is worth doing whatever
is decided about seniority.

**Layer 2 — a real senior technician.** Needs one decision:

| Option | Effect |
|---|---|
| **A. `Technician.isSenior` boolean** | Simplest and readable. A manager ticks it on the staff page. **Recommended.** |
| **B. Derive from `TechnicianSkill.proficiencyLevel ≥ N`** | No schema change, reuses existing data — but seniority becomes per-skill and implicit, and the field is currently unused/untrusted. |
| **C. A fifth role, SENIOR_TECHNICIAN** | Most explicit, but the role model was deliberately consolidated to four in CR-2026-048 and re-expanding it touches every permission list. |

"Assigned in advance" then means a nullable `qcAssignedTechnicianId` on `ServiceOrder`, set when
the job is assigned, with the QC-pass action checking it.

### D4. Inspection photos

| Option | Effect |
|---|---|
| **A. Base64 into Postgres, downscaled client-side** | Follows the existing signature precedent. No new dependency, no new infrastructure, survives redeploys. Requires raising the body limit in `main.ts` and downscaling on the tablet (e.g. longest edge 1280px, JPEG q0.7 → ~150-300 kB). Bloats the database and every row read; fine for a few photos per inspection, not for hundreds. **Recommended to start.** |
| **B. Object store (S3 / Cloudflare R2 / Cloudinary)** | The correct long-term answer: cheap, scalable, keeps images out of the database. It is a **new third-party dependency in a core flow** — a governance trigger — plus credentials and a bucket. |
| **C. Local disk** | **Not viable.** No persistent disk on Render's free plan; files vanish on redeploy and cold start. |

Either way the photo belongs on `VehicleInspection` (which already has
`priorBodyDamageNotes` as text-only), captured by the assigned technician, before work starts.

---

## E. Impacted modules and data

- **Schema:** `VehicleServiceClass` (D1), new `ServiceTypeDuration` (D2), `ServiceOrder.qcByUserId`
  / `qcAt` / `qcAssignedTechnicianId` (D3), `Technician.isSenior` (D3), inspection photo storage (D4).
- **Data migration:** 8,247 vehicles reclassified (D1). Backup required; reversible only from backup.
- **API:** resources, queue callNext, classification, check-in, service-orders, inspections, appointments.
- **Web:** `vehicle-classes.ts`, unclassified-alert, check-in, service catalogue admin, inspection form.
- **Seeds:** two duplicated `VehicleWeightSuggestion` lists — worth collapsing to one source while here.

## F. Risks / tradeoffs

1. **The enum migration is the only irreversible step.** Once `PICKUP`/`VAN`/`TRUCK` are collapsed,
   the distinction is gone from live data. Option C (D1) avoids this entirely.
2. **Rule 3 fail-safe must be preserved.** Anything not positively a sedan must stay mobile-jack
   blocked. Losing `UNKNOWN_REQUIRES_REVIEW` would mean a never-classified vehicle silently
   becomes SUV, which is a *safer* outcome for the jack gate but a *worse* one for data honesty.
3. **Photos in Postgres grow the database and the backups.** Acceptable at low volume; revisit
   before it becomes the primary evidence store.
4. **Blocking QC self-approval will interrupt current practice** if technicians are passing their
   own work today. That is the point, but it should be flagged to staff before it ships.

## G. Already shipped (CR-2026-086), for contrast

Everything from the same request that needed no schema change or new infrastructure:
the lobby display now advances through In Service and Ready and no longer disappears during
QC; the display copy no longer tells customers to listen for a number nobody calls; the
due-for-service reminder sweep is wired to an hourly cron (off by default behind
`maintenance_reminder_enabled`); and the manager's KPI rating bands and package standard times
are seeded as tunable business rules and surfaced on the technician performance report.

## H. Approval gate

**Required.** This CR contains core-entity schema changes, a business-rule change (Rule 3
inputs), a destructive data migration, and a potential new third-party dependency — four
separate triggers under `claude.md` §9 and `docs/21_Approval_Gates.md`.

**Decisions needed before any build:** D1 option · the service list and duration handling (D2)
· D3 Layer 2 option · D4 option.
