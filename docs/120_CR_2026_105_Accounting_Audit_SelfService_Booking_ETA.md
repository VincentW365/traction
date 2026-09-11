# CR-2026-105 — Accounting Reporting Audit · Customer Self-Service Pre-Booking · Authoritative Estimated Completion

**Status:** APPROVED IN PART (2026-09-11). **Part 1 / Phase A (accounting close-out) is DEFERRED** by owner direction until requirements are gathered in a meeting with the accounts team — the audit in §D1 stands as the record of what is capturable today; nothing from §D1.5 is built. **Phases B (ETA read model) and C (self-service booking) proceed** under the assumptions in §C, in that order.
**Raised:** 2026-09-10, from management's three requirements.
**Umbrella for:** CR-2026-105a (Close-Out & Reconciliation report), CR-2026-105b (ETA read model), CR-2026-105c (Self-service booking). Each ships as its own commit + annotated tag on `master` (Render auto-deploys).
**Templates:** `templates/Change_Request_Template.md`, `templates/ADR_Template.md`; gates per `docs/21_Approval_Gates.md`.

---

## A. Objective

Deliver, on the existing ServiceVisit / Appointment / Queue / ServiceOrder / Resource / Audit / KPI architecture and without parallel workflows:

1. **Accounting reporting** — an honest audit of what financial reporting is possible from captured data, and closure of the *genuine* gaps (no fabricated values).
2. **Customer self-service pre-booking** — a public page where a customer finds the next available appointment and reserves it with no staff involvement, through the canonical `Appointment → ServiceVisit → Check-In → Queue` flow.
3. **One authoritative Estimated Completion** shared by the Customer Display, Dispatch, Visit Record, Technician workspace and Advisor views, with confidence classes, ranges where uncertain, and real-time updates.

Plus the supporting configuration (80-minute default duration and booking rules in `BusinessRuleConfig`), reporting impact, and tests — all reproducible from GitHub.

## B. Inputs used

- Five read-only code audits performed 2026-09-10 (financial data & reports; appointments/capacity/rules; ETA/queue/display/dispatch; notifications/auth/privacy; report-UX/config/test/seed/deploy conventions). Findings are cited below as `file:line`.
- `CLAUDE.md` (§2 truths, §5 scheduler pattern, §9 review triggers, §10 quality, §11 UX, §12 never-do); `Project.md` §4 scope (**"Direct payment processing replacement for POS" is out of scope**); `docs/03_Business_Rules.md` (SCH-001/004, ARR-001..005, NOT-001/002/003, GOV-001/002/003, **GOV-005 withdrawn — payment is settled in the external POS**); `docs/05_User_Roles_Permissions.md` (customer `create_own_appointment` / `cancel_own_appointment`; `export_reports` = Manager/Admin); `docs/08_Scheduling_Engine_Spec.md` §11 (Phase-1 deterministic ETA); `docs/21_Approval_Gates.md`; `docs/101` (durations), `docs/113` (FIFO-first, CR-099b), `docs/114`/`docs/115` (pause ledger, labour segments, two time bases), `docs/118` (report conventions), `docs/119` (deployment parity), `render.yaml` (Redis/BullMQ **not wired**; free plan cold-starts).

## C. Assumptions (numbered — each is a decision the owner can overturn)

1. **Money is not captured in Traction and will not be fabricated.** The external POS remains the financial source of truth (Project.md §4; GOV-005 withdrawal). What BSOP can honestly provide is an operational close-out that reconciles *to* POS, plus a surfaced decision (D1, §D1.4) on whether to start capturing invoice/payment facts.
2. **80 minutes is the planning duration for every self-service booking** (`default_appointment_duration_minutes = 80`), regardless of catalogue `ServiceType.baseDurationMinutes`, until management explicitly switches `appointment_duration_source` to `CATALOGUE`. Rationale: management said "use 80 minutes … unless a service has an explicitly configured duration approved by the business"; the seeded catalogue durations were never approved as booking durations (docs/101 §C2; docs/102: the activity tables are guidance, not a service list).
3. **Capacity is a configured number of concurrent service positions per site** (`booking_capacity_mode = FIXED`, `booking_max_concurrent_appointments`), because today there is **no capacity concept at all** (unlimited appointments per minute — `appointments.service.ts:106-111, 545-574`) and the seeded `WorkResource` set is DMAIC stands/jacks/power-wash/external, not bays (docs/119 §H). A `RESOURCES` mode that sums `WorkResource.capacity` for chosen categories is provided for when management wants it. **The same capacity keys drive the ETA "tracks"** — one concept, not two.
4. **Public identification is mobile number + licence plate** (two facts only the customer and the shop know). No OTP in v1: SMS is stub/TEST-routed in most environments (`notifications.module.ts:28-65`, `NOTIFICATION_MODE=TEST`), so an OTP would break the flow outside LIVE. Anything that does not match both facts becomes a **new** customer record (never attached to an existing one) — a duplicate is cheaper than a disclosure.
5. **No slot holds in v1.** Concurrency is guaranteed by re-checking capacity **inside** the confirming transaction under a per-site-per-day advisory lock (the primitive queue recompute already uses, `scheduling.service.ts:43`). Holds (`ScheduleHold` is staff-only, capacity-blind, no TTL — `schedule-holds.service.ts:21-52`) are a Phase-D option.
6. **A self-service booking is created directly as `CONFIRMED`** (the customer confirms on screen), via the existing `create` + `confirm` semantics in one transaction; `ServiceVisit` is still created at check-in, unchanged (`check-in.service.ts:161-316`).
7. **Same customer + same vehicle + same day:** the public flow **refuses** with the existing reference and a manage link (409), rather than silently merging into the staff appointment as `create()` does today (`appointments.service.ts:79-93`, SCH-004). Staff behaviour is untouched.
8. **ETA is computed after ranking and never feeds it.** The FIFO-first rule (CR-099b, `priority-position.calculator.ts:1-22, 176-181`) is not modified; ETA is a pure function of `queueRank`, order/pause/segment signals and durations.
9. **While a job is on hold the ETA clock is held** (the sub-decision deferred in docs/25 §109-117): remaining minutes do not shrink during a pause; completion is republished as `now + remaining` and classed **DELAYED** while the hold is open, recomputed on resume.
10. **No new runtime dependency in v1.** Anonymous rate limiting reuses the in-memory sliding-window pattern (`customer-notifications.service.ts:737-749`) keyed by IP + route; `@nestjs/throttler`/helmet are Phase-D (AG-05).
11. **Staff-created appointments also consume capacity**, but staff get a *warn-not-block* 409 (`acknowledgeCapacity: true` proceeds, audited) — mirroring the workload precedent (docs/114). Without this the public engine would be lying about availability.
12. **Reporting definitions** in §D1.5 and §D4 are proposed metric definitions (AG-09); none are live until approved.

---

## D1. Part 1 — Accounting reporting: audit first

### D1.1 Central finding

**Accounting reporting is not possible from captured data today, and this is by design.** No application flow writes a single transaction-level monetary value. Evidence:

- No Payment, Invoice, Transaction, Refund, CreditNote, Tax, Discount or LabourLine model exists among the 65 models in `prisma/schema.prisma`. `ServiceOrder` (`:1313-1360`) and `ServiceOrderItem` (`:1414-1450`) carry no price, cost, tax or discount field.
- `ServiceOrder.paymentStatus` (enum, default `UNPAID`, `schema.prisma:188-195, 1319`) is **never written by any application code** — only by the test-data seeder (`data-import/test-data/scenarios.ts:278`). It is read only as a close-out breadcrumb (`status.controller.ts:368-389`, `queue.service.ts:517-534`) and never rendered. Because it defaults to `UNPAID`, both close-out paths write a `RELEASED_PAYMENT_NOT_CLEARED` audit row on effectively every real close — the trail cannot distinguish real exceptions from the default.
- `PosReference` (`schema.prisma:1648-1661`: `externalRef`, `amount Decimal?`, `status`, `syncedAt`) is an **orphan table** — no writer, no reader. `docs/48:19` describes it as "synced from the external POS"; no sync code exists, and the Automate/Sage adapters were removed in CR-2026-095 (`docs/109:62-66`).
- The only currency values in the database are **imported catalogue list prices** (`ServiceCatalogItem.basePrice`/`priceTaxInclusive`, JMD, from an xlsx via `apps/api/scripts/import-catalog.ts:124`; `laborPrice`/`partsPrice` hard-coded null at `catalog.mapper.ts:184-185`). They feed one figure — Service Mix `estValue`, explicitly labelled *"Estimated catalog value only… Not invoice revenue"* (`reporting.service.ts:970`) — for historical text-matched jobs only; live jobs carry no value (`:881-889`).
- Governance agrees: Project.md §4 lists "Direct payment processing replacement for POS" as out of scope; GOV-005 was withdrawn (CR-2026-085) because "Payment is settled in the external POS, which is the source of truth… Traction only ever mirrored a `paymentStatus` field" (`docs/03_Business_Rules.md:389-408`).

### D1.2 Accounting Reporting Audit Matrix

Legend — **Available:** Yes / Partial / No. **Accurate/Complete** is only meaningful where Available ≠ No.

| Reporting requirement | Already available | Data source | Accurate / complete | Action required |
|---|---|---|---|---|
| Service revenue | **No** | none (POS) | — | Data-model/process gap → **Decision D1** (§D1.4). Do not fabricate. |
| Labour revenue | **No** | none; `ServiceCatalogItem.laborPrice` always null (`catalog.mapper.ts:184`) | — | Gap → D1 |
| Parts / material revenue | **No** | none; parts models carry quantity only (`schema.prisma:1501-1515`); parts module retired (`docs/113:95-97`) | — | Gap → D1 |
| Other service charges | **No** | none | — | Gap → D1 |
| Discounts | **No** | none (zero schema hits) | — | Gap → D1 |
| Taxes | **No** (transaction level) | only `ServiceCatalogItem.priceTaxInclusive` list price (`schema.prisma:1948`) | — | Gap → D1; keep the list-price label "GCT-inclusive" |
| Gross invoice / service-order value | **No** | `PosReference.amount` exists but is never written (`schema.prisma:1652`) | — | Gap → D1 (option B-lite can populate it) |
| Amount paid | **No** | none (only the `paymentStatus` enum, no amount) | — | Gap → D1 |
| Outstanding / unpaid amounts | **No** | none | — | Gap → D1 |
| Payment methods | **No** | `ON_ACCOUNT`/`WAIVED` are statuses, not methods (`schema.prisma:188-195`) | — | Gap → D1 |
| Refunds | **No** | none | — | Gap → D1 |
| Voids / cancellations | **Partial** (operational only) | `CANCELLED` appointment/visit/order states (`performance-report.service.ts:195-201`; KPI-07 `reporting.service.ts:197-202`) | accurate as counts; **no financial effect** | Include as counts in Close-Out (D1.5); financial void = D1 |
| Credit adjustments / credit notes | **No** | none | — | Gap → D1 |
| Daily transaction totals | **Partial** (operational) | daily trend buckets `performance-report.service.ts:424-454` | counts/minutes only | **Build Close-Out & Reconciliation report** (D1.5) |
| Weekly totals | **Partial** (operational) | presets `reports/page.tsx:181-208` | as above | D1.5 (week preset) |
| Monthly totals | **Partial** (operational) | monthly job volume `reporting.service.ts:837-844` | as above | D1.5 (month preset) |
| Transaction / service-order level detail | **Partial** (operational) | job rows `job-times.service.ts:139-195`; KPI rows `kpi-reporting.service.ts:52-116` (**row-capped** 2000/1000/200) | complete only within caps | D1.5 drill-down: **server-complete** rows for the period, no cap |
| Customer-level transaction history | **Partial** (no money) | `customers.service.ts:272-352` service history | accurate, non-financial | none financial; Visit Record (docs/111) already links visits |
| Revenue by service / category | **Estimate only** | Service Mix `estValue` = catalogue list price × historical matched jobs (`reporting.service.ts:902-922, 970`) | **not revenue**; historical only; coverage % shown | keep the label; **never** present as revenue. D1 for real values |
| Revenue by vehicle category | **No** (operational split exists) | `performance-report.service.ts:281-301` | — | D1 |
| Revenue by date / date range | **No** (all reports operational) | `reporting.controller.ts:25-37` | — | D1 |
| Revenue by technician | **No** (operational split exists) | `performance-report.service.ts:303-342` | — | D1 |
| Revenue by bay / resource | **No** — no bay dimension in any report | — | — | Close-Out adds an operational "jobs by resource" section |
| Export to Excel / CSV / PDF | **Yes** (CSV + PDF via print), client-side | `apps/web/lib/export.ts:62-91, 132-187`; `ExportMenu` | complete only within API row caps; no XLSX; no server-side export | Close-Out export serialises the full period payload (no cap); XLSX not required (CSV opens in Excel) |
| Daily reconciliation / close-out | **No** | only audit rows `PAYMENT_RELEASE_OVERRIDE` / `RELEASED_PAYMENT_NOT_CLEARED` (`audit.service.ts:34`) which fire on nearly every close (D1.1) | — | **Build** D1.5 |

### D1.3 Existing reports (classification)

All 23 endpoints require `REPORT_VIEW` (`permissions.ts:46`), held only by ADMIN (`:176`); every report page additionally hard-gates `ALLOWED_ROLES=['ADMIN']`. **Zero are Accounting/Financial.**

| # | Report | Route | Class |
|---|---|---|---|
| 1 | KPI dashboard (KPI-01..09) | `GET /reports/kpis` | Operational |
| 2 | Trends (check-ins / wait / no-shows / overrides) | `GET /reports/trends` | Operational |
| 3 | Technician utilization | `GET /reports/technician-utilization` | Operational |
| 4 | **Service Center Performance Report** (CR-104) | `GET /reports/performance-report` | Management |
| 5 | Job Times (two time bases) | `GET /reports/job-times` | Operational/Management |
| 6 | Service breakdown by family | `GET /reports/service-breakdown` | Operational |
| 7 | Maintenance retention | `GET /reports/maintenance-retention` | Operational |
| 8 | Queue performance | `GET /reports/queue-performance` | Operational |
| 9 | Historical analytics (imports) | `GET /reports/historical-analytics` | Management |
| 10 | Rework / first-time fix | `GET /reports/rework` | Operational |
| 11 | **Service Mix / Job Trends** (the only currency figure — an *estimate*) | `GET /reports/service-mix` | Management |
| 12 | Manager control centre | `GET /manager/dashboard` | Operational |
| 13 | Manager alerts | `GET /manager/alerts` | Operational |
| 14 | Technician efficiency | `GET /reports/technician-efficiency` | Operational |
| 15 | Technician performance detail | `GET /reports/technician-performance/:id` | Operational |
| 16 | Assignment history | `GET /reports/assignment-history` | Operational |
| 17 | Technician KPI dashboard | `GET /kpi/dashboard` | Management |
| 18 | KPI job rows (CSV feed) | `GET /kpi/dashboard/jobs` | Management |
| 19 | Shared / reassigned jobs | `GET /kpi/reports/shared-jobs` | Management |
| 20 | Benchmark review queue | `GET /kpi/reports/benchmark-review` | Operational |
| 21 | Additive-service evidence | `GET /kpi/reports/additive-evidence` | Management |
| 22 | Due vehicles → `/reports/due-for-contact` | `GET /maintenance/due-vehicles` | Operational/CRM |
| 23 | Classification stats / productivity | `GET /vehicles/classification/*` | Operational |

### D1.4 Decision D1 — how should financial facts enter Traction? (surfaced, not built)

| Option | What it is | Schema | Gate | Assessment |
|---|---|---|---|---|
| **A. Status quo (recommended now)** | POS is the ledger. Traction provides the operational Close-Out & Reconciliation list (D1.5) that the manager ticks against POS invoices. | none | AG-09 | Honest, zero data-quality risk, consistent with Project.md scope and the GOV-005 withdrawal. Produces no revenue figures. |
| **B-lite. Front-desk capture at close-out** | At "Close Visit", the front desk enters the **POS invoice number and total** (writes the existing orphan `PosReference` row) and sets the existing `ServiceOrder.paymentStatus`. Close-Out then reports gross invoice value per day/week/month and a payment-status breakdown, and "released before payment cleared" becomes meaningful. | **none** (both columns already exist) | AG-01 (process rule) + AG-09 | The smallest step that yields *real* daily totals reconcilable to POS. Depends on staff discipline; values are transcriptions, not the ledger. Recommend **optional** fields first, with "% of closed visits with invoice captured" reported. |
| **C. POS / accounting integration** | Import or sync invoices/payments from Sage/Automate. | new integration tables | AG-06 + AG-05 | The only route to labour/parts/tax/discount/refund detail. Adapters were removed (CR-095); needs vendor access and a contract. Roadmap item, not this CR. |

**Recommendation:** approve **A now**; decide **B-lite** as a separate yes/no; C stays on the roadmap.

### D1.5 Reports to add / modify (Phase A — CR-2026-105a)

**NEW — Daily Close-Out & Reconciliation** (`GET /reports/close-out?siteId&startDate&endDate`, `REPORT_VIEW`; page `/reports/close-out`; a new sidebar/hub group **"Accounting & Reconciliation"** kept visibly separate from Operational KPIs).
- Filters: Today / Yesterday / This week / Last week / This month / Last month / custom (the CR-104 preset block, extracted into a shared `components/ui/report-date-controls.tsx` used by both pages); site from `useSiteId()`; bounds via `localDayRange()`.
- **Totals (per day, then period):** visits closed · service orders closed · jobs completed (QC passed) · cancellations/voids (appointments, visits, orders) · walk-ins vs appointments closed · services performed by `ServiceType` and family · jobs by vehicle class · jobs by technician · jobs by resource (from `ResourceOccupancy` history) · "closed with payment status not cleared" audit count, labelled *payment status is not maintained in this system*.
- **Drill-down (server-complete, no row cap):** one row per closed visit — visit #, ticket, closed at, closed by, customer number (name hidden on print by default), vehicle class + masked plate, services, technician(s), source (appointment/walk-in), order statuses; `paymentStatus`/invoice columns appear **only if option B-lite is approved**.
- Letterhead: title, organisation, period + length, generated at/by, filters; print footer "Internal Management Use". CSV + PDF via `ExportMenu` (`meta: [['Generated', serverGeneratedAt]]`, `subtitle: Period …`).
- Reconciliation rule (AG-09): *a visit counts on the day its `ServiceVisit → CLOSED` StatusHistory row falls in site local time*; totals must equal drill-down row counts (asserted by tests).
- Banner: **"Financial values are not captured in this system. Use this list to reconcile against POS invoices."**

**NEW — Appointments & Bookings** (`GET /reports/appointments`, Phase C, §D4) — the Part-14 metrics.

**MODIFIED — `/reports` hub:** two groups, *Operational KPIs* and *Accounting & Reconciliation*. Service Mix keeps its "estimated catalogue value" label.

**Not modified:** all 23 existing endpoints.

**Fix alongside (code-only):** `HIDDEN_RULE_KEYS` dead code (`admin/settings/page.tsx:53-75`); `'SYSTEM'` written to the uuid `actorUserId` column at `maintenance-reminder.service.ts:250` and `service-orders.service.ts:1799` (Postgres rejects it — use `null`, the documented system-actor convention `audit.service.ts:5-6`).

---

## D2. Part 2 — Customer self-service pre-booking (CR-2026-105c)

### D2.1 Reuse vs build

| Capability | Today | Disposition |
|---|---|---|
| Appointment write path (`create`/`confirm`/`update`/`cancel`) with operating-hours check, service-code resolution, same-vehicle overlap, StatusHistory | `appointments.service.ts:54-159, 227-371, 377-413, 419-465` | **Reuse** via a public façade passing a null actor |
| `Appointment.sourceChannel String? @default("STAFF")`, `createdByUserId` nullable | `schema.prisma:926-928` — never written by code | **Reuse** — set `'CUSTOMER_SELF_SERVICE'`; **no schema change** |
| Check-in creates `ServiceVisit` + ticket (Serializable tx) | `check-in.service.ts:161-316` | **Unchanged** — a self-service booking is just an Appointment |
| `operating_hours` rule (site tz, missing day = closed) | seed `:155-168`; two divergent readers (`appointments.service.ts:586-603` skip-if-missing vs `schedule.service.ts:403-415` fallback 08–17) | **Unify** into `common/helpers/operating-hours.ts`, used by the engine, staff create and the schedule page |
| Public controller pattern (no `@UseGuards`), generic 404, token gating | `display.controller.ts:16-53`, `status.controller.ts:17-52` | **Reuse** |
| Customer status token (`randomBytes(16)`, 24 h, plaintext) | `check-in.service.ts:164-165`; `schema.prisma:1016-1017` | **Reuse the pattern, harden**: store a sha256 hash, longer life, bound to the appointment |
| `GET /service-types` already public, exposes operational fields | `config/service-types.controller.ts:12-47` | **Add** a customer-safe projection; leave the existing route alone |
| `NotificationsService.queueAppointmentConfirmation` (SMS template exists; zero callers; no opt-in check; email leg has no body under SMTP) | `notifications.service.ts:133-165`; `smtp.provider.ts:44-47` | **Wire + fix**: opt-in gating, pre-rendered email subject/body, reschedule/cancel messages |
| Appointment reminder sweep (24 h, hourly cron, rule-gated) | `notifications.service.ts:603-689` | **Reuse** unchanged |
| Ticket v2 atomic counter (`INSERT … ON CONFLICT … RETURNING`) | `common/helpers/ticket-allocator.ts:33-59` | **Reuse the pattern** for the booking reference |
| Availability / capacity engine | **Does not exist** (SCH-001 unimplemented; `availability` module = technician day CRUD; `ResourceReservation` never written; `ScheduleHold` staff-only) | **Build** (§D2.3) |
| Booking reference, manage token, closed dates, min notice, advance window, slot interval, default duration, cancellation cutoffs | **Do not exist** | **Build** (§E, §D5) |
| Anonymous rate limiting | none | **Build** in-memory (Assumption 10) |
| MISSED writer (no-show) | none — KPI-08 structurally zero | **Build** rule-gated cron (§D4) |

### D2.2 Customer journey and API

Public web route group `apps/web/app/book/` (outside `(dashboard)`/`(auth)`; plain `fetch`, no bearer; `resolveApiBaseUrl` extracted once into `lib/public-api.ts`; tolerant loading/retry for Render cold starts; `error.tsx` like `display/`):

1. **`/book` — Identify:** mobile number + licence plate (Assumption 4). The response reveals only "We found a vehicle ending in ***1234" or opens a new-customer form (first name, last name, mobile, email optional, SMS/email consent).
2. **Vehicle:** matched customer → their vehicles as masked plate + make/model/year, or "add a vehicle" (plate, make, model, year; class auto-classified as today `vehicles.service.ts:103-106`). New customer → one vehicle.
3. **Service:** from `GET /public/booking/services` (customer-safe projection; `isActive && !isExternal` minus `booking_excluded_service_codes`); shows "Planned time: 1 h 20 min".
4. **Availability:** `GET /public/booking/availability` — **Next available** first, then per-day slot lists across `booking_advance_window_days`.
5. **Confirm:** customer (first name + masked mobile), vehicle, service, date, arrival time, planned duration, site name/address, arrival instructions (`booking_arrival_instructions`). Confirm → `POST /public/booking/confirm`.
6. **Confirmed:** "Appointment Confirmed" — reference, date, arrival time, vehicle, service, duration, site info, instructions, manage link. SMS + email (NOT-001) through the existing provider.
7. **`/book/manage/[token]`:** view · cancel (before `booking_cancel_cutoff_hours`) · reschedule (before `booking_reschedule_cutoff_hours`, ≤ `booking_max_reschedules`). Each re-runs availability under the lock, writes StatusHistory + AuditLog, resends confirmation, and **immediately** frees the old window (capacity is computed from live appointment rows, so nothing needs releasing).

API module `apps/api/src/modules/public-booking/` — `@Controller('public/booking')`, no guards, class-validator DTOs on every body/query, generic 404s, in-memory rate limit:

| Endpoint | Body / query | Notes |
|---|---|---|
| `GET /public/booking/site` | — | site name, timezone, instructions, `booking_enabled` |
| `POST /public/booking/identify` | `{ phone, plateNumber }` | phone via `toE164Jamaica`, plate via the `vehicleCode` rule (`vehicles.service.ts:79-81`); match ⇒ opaque server-side `bookingSessionId` (30 min) + masked vehicles; no match ⇒ `{ known: false }` |
| `GET /public/booking/services` | — | customer-safe projection |
| `GET /public/booking/availability` | `serviceCodes[], from, days, bookingSessionId?` | §D2.3 |
| `POST /public/booking/confirm` | `{ bookingSessionId? \| newCustomer{…}, vehicleId? \| newVehicle{…}, serviceCodes[], scheduledStartAt, consent{sms,email} }` | §D2.4 |
| `GET /public/booking/manage/:token` | — | masked view |
| `POST /public/booking/manage/:token/cancel` | `{ reason? }` | rule-gated |
| `POST /public/booking/manage/:token/reschedule` | `{ scheduledStartAt }` | rule-gated |

**Privacy:** responses never contain a full plate, phone, email, notes, `engineNo`, or another customer's data; a new customer is never linked to an existing record unless phone + plate matched; the manage token is the only credential and is stored hashed. `GET /customers` / `/customers/:id` shapes are **not** reused (`customer-serializer.ts:26-53, 115-141`).

### D2.3 Availability / slot & capacity calculation

Pure function `computeAvailability(input) → { nextAvailable, days[] }` in `public-booking/availability.engine.ts` (unit-tested, no I/O), fed by a loader that fetches everything once per request:

```
for each date D in [today .. today + booking_advance_window_days] (site timezone):
  hours = operating_hours[site][weekday(D)]           // absent ⇒ closed
  if D ∈ booking_closed_dates                          ⇒ closed
  if D is today and !booking_same_day_allowed          ⇒ closed
  duration = resolvePlannedMinutes(serviceCodes)       // 80 unless appointment_duration_source = CATALOGUE
  earliestStart = max(open(D), now + booking_min_notice_minutes)
  candidates = earliestStart, +booking_slot_interval_minutes, … while start + duration ≤ close(D)
  capacity = booking_capacity_mode == FIXED
               ? booking_max_concurrent_appointments
               : Σ WorkResource.capacity where isActive && schedulingEnabled
                                            && category ∈ booking_capacity_resource_categories
  live = active appointments for the site on D
         (status ∈ DRAFT, CONFIRMED, RESCHEDULED, CHECKED_IN, IN_PROGRESS)
         window = [scheduledStartAt, scheduledEndAt ?? scheduledStartAt + default)
  slot t is AVAILABLE  iff  maxConcurrentOverlap(live, [t, t + duration)) < capacity
nextAvailable = first AVAILABLE slot scanning forward from now
```

- Same-vehicle overlap and "one active booking per vehicle per day" are enforced at confirm (409 with the existing reference), not in the slot list.
- Cost is O(days × slots × appointments-per-day) — trivial here; no cache.
- **Concurrency at final confirmation:** `POST /confirm` runs one `$transaction`: `SELECT pg_advisory_xact_lock(hashtext('booking:' || siteId || ':' || businessDate))` → recompute the chosen slot from `tx` reads → if not AVAILABLE, 409 `SLOT_TAKEN` with a fresh `nextAvailable` → allocate reference → create customer/vehicle if new → create Appointment (+ services, `CONFIRMED`) → StatusHistory → AuditLog. Two customers claiming the last slot serialise on the lock; the second sees the first's row. Staff `create()` takes the same lock and check (warn-not-block, Assumption 11).
- Technician-availability-aware capacity (`MechanicDayAvailability`) is Phase D (`booking_capacity_consider_technicians`).

### D2.4 What confirm writes

- `Customer` (if new): names, phone, email?, opt-ins; `customerNumber` via the existing allocator (`customers.service.ts:137-166`).
- `Vehicle` (if new): plate, make, model, year; class auto; a friendly 409 if the plate already belongs to *another* customer (today a raw unique error, `vehicles.service.ts:83-101`).
- `Appointment`: site, customer, vehicle, `scheduledStartAt`, `scheduledEndAt = start + plannedMinutes`, `status: CONFIRMED`, `confirmationStatus: 'CONFIRMED'`, `sourceChannel: 'CUSTOMER_SELF_SERVICE'`, `createdByUserId: null`, `appointmentNumber` (new), `manageTokenHash` + `manageTokenExpiresAt` (new), `AppointmentService` rows.
- `StatusHistory` null → CONFIRMED (`changedByUserId` omitted); `AuditLog` `APPOINTMENT_CREATED_ONLINE` with `actorUserId: null` and `afterJson: { actorType: 'CUSTOMER', appointmentNumber, source }`.
- Notification **after commit**: `queueAppointmentConfirmation(...)` gated by opt-in, with pre-rendered email subject/body; logged in `NotificationLog` (`entityType: 'Appointment'`).
- Reschedule → `update()` path + `AuditLog APPOINTMENT_RESCHEDULED` (before/after times) + resend. Cancel → `cancel()` path + `APPOINTMENT_CANCELLED_BY_CUSTOMER`. Today reschedule and confirm write **no** AuditLog (`appointments.service.ts:324-330, 386-406`); the façade adds them for staff and customer actors alike (GOV-001).

### D2.5 Booking reference and manage token

- Reference `BK-{LOC}-{YYMMDD}-{SEQ}` (e.g. `BK-B01-260910-003`): `ticket-generator-v2.ts` builders (`resolveBusinessDate(now, site.timezone)`, location from `Site.ticketCode`) + a new `daily_booking_counters` table with the same atomic upsert, allocated inside the confirming transaction. `BK-` cannot collide with `B01-…`, `V-…`, `INS-`, `JS-`; global search / `visits.service.resolveByNumber` gain a `BK-` branch.
- Manage token: 32 random bytes → base64url in the link; only `sha256(token)` is stored (`manageTokenHash @unique`); expiry = `scheduledStartAt + booking_manage_token_days_after` (default 7 days); lookup by hash; generic "This link has expired" copy. Never a committed literal (unlike `display_board_token`, `seed.ts:323`).

---

## D3. Part 3 — Authoritative Estimated Completion (CR-2026-105b)

### D3.1 What exists (why there must be one model)

Seven independent time-estimate computations run in production today with no shared source; the fields designed to hold an authoritative ETA exist and are **never written**:

| # | Computation | Where | Disposition |
|---|---|---|---|
| 1 | Staff board `estimatedWaitMinutes = queueRank × siteAvg` (three-tier historical average, config-driven) | `queue.service.ts:115-116, 796-872` | replace output; keep `getAvgServiceMinutes` only as last-resort duration |
| 2 | Engine `calculateEta` — **zero callers**; `QueueDecisionSnapshot.eta*` typed, never populated | `eta.calculator.ts:11-21`; `types.ts:173-174` | revive as the model core (N-track) |
| 3 | `expectedMinutes = Σ baseDurationMinutes` (inline, twice) | `service-orders.service.ts:893-896, 2287-2290` | delete; read from the model's duration resolver |
| 4 | Dispatch `aging` (120 min or past `promisedCompletionAt`) + `overdue[]` | `resources.service.ts:18, 448-467, 562-567` | derive from model confidence |
| 5 | Manager `OVERDUE_JOB` (hard-coded 2 h / 4 h) | `manager-dashboard.service.ts:260-289` | derive from model; constants → rules |
| 6 | Client `elapsed/working/overExpected` clocks | `technician/page.tsx:376-381`; `jobs/[orderId]/page.tsx:283-288` | keep the clocks (facts); confidence replaces `overExpected` |
| 7 | KPI `standardMinutes` / `minutesRemaining` (vehicle-class aware) | `kpi.service.ts:1039-1042, 1083-1086` | **feeds** the model as the preferred duration; stays a KPI figure |
| — | `sendDelayAlert` reads `ServiceVisit.currentEtaCompleteAt` — never written, zero callers | `notifications.service.ts:250-315` | wire in Phase D (§D3.7) |
| — | `ServiceVisit.currentEtaStartAt/CompleteAt`, `QueueDecision.etaStartAt/CompleteAt`, `ResourceOccupancy.expectedEndAt` | `schema.prisma:1003-1004, 1148-1149, 1879` | **columns exist, no writer** — the model writes them |

Check-in and walk-in responses hard-code `etaStartAt: null` and the front desk shows "Estimated Start: Pending" forever (`check-in.service.ts:419-424`; `check-in/page.tsx:318-323`).

### D3.2 Design — one service, one presentation function

- **`EtaService`** (`apps/api/src/modules/scheduling/eta/`): a pure `computeSiteEta(snapshot, config, now)` (`eta.model.ts`, no I/O) and a thin writer, invoked at the end of `recomputeQueue` **after** `calculatePriorityPositions`, inside the existing per-site advisory lock and **before** the `queue.recomputed` emit (`scheduling.service.ts:151-226`).
- **Writes (existing columns only):** `ServiceVisit.currentEtaStartAt` / `currentEtaCompleteAt` every recompute; `QueueDecision.etaStartAt/etaCompleteAt` whenever a decision row is written; `ResourceOccupancy.expectedEndAt` for occupied resources. `QueueTicket.lastRankedAt` (already stamped every recompute) is `lastEtaUpdateAt` — hence the rule: **every ETA change goes through `recomputeQueue`**.
- **Read side:** one pure `presentEta(visit, orders, pauses, now, config)` in `common/helpers/eta-presentation.ts` returning `{ estimatedStart?, estimatedStartRange?, estimatedCompletion?, estimatedCompletionRange?, confidence: ON_TRACK|AT_RISK|DELAYED, basis, lastUpdatedAt, publicState: ON_TIME|DELAYED }`. Every consumer — display, status page, dispatch overview, visit record, technician endpoints, advisor ticket view, queue board — calls it. Public projections drop `basis` and reasons.
- **Never touches** `queueRank`, `displayStatus`, `overrideRankPosition`, `checkinSequence` or `blockedReason` (Assumption 8).

### D3.3 Methodology (deterministic — `docs/08` §11)

**Planned minutes per visit** (`resolvePlannedMinutes`, first hit wins): (1) KPI standard minutes when a benchmark applies (vehicle-class aware, `kpi.service.ts:1039-1042`); (2) Σ `ServiceOrderItem.estimateMinutes` (populated at `service-orders.service.ts:174-175`); (3) Σ `ServiceType.baseDurationMinutes` of the appointment services; (4) `default_appointment_duration_minutes` (80); (5) site historical average (existing three-tier) only when the services are unknown.

| State | estimatedStart | estimatedCompletion |
|---|---|---|
| Appointment, not arrived | `scheduledStartAt` | `scheduledStartAt + planned` (`plannedStart + plannedDuration`) |
| Waiting, ranked (`queueRank` set) | N-track simulation: `tracks = capacity` (§D5 keys); each track's `freeAt` = completion of its in-service visit (or `now`); in rank order assign to the earliest-free track: `start = max(now, freeAt) + eta_transition_overhead_minutes` | `start + planned`; track `freeAt := completion` |
| Waiting, blocked (`queueRank null`: parts/skill) | none | none — public state `DELAYED`, no reason exposed |
| In service (IN_PROGRESS) | actual `startedAt` | `now + max(planned − worked, eta_min_remaining_minutes)` where `worked = elapsed − Σ closed pause intervals − open pause` (ledger, docs/114) |
| On hold (PAUSED / WAITING_PARTS / WAITING_CUSTOMER) | as above | clock held (Assumption 9): `now + remaining`, republished each recompute; confidence **DELAYED** |
| QC | as above | `now + eta_qc_minutes`; public copy "Finishing up" |
| Rework (order back to APPROVED, `startedAt` nulled) | treated as waiting again; `remaining = planned × eta_rework_factor` | confidence AT_RISK; `ServiceOrderRework.closedAt` gets a writer so `hasOpenRework` is truthful |
| Reassignment / additional technician | unchanged (elapsed is per order; segments are per technician) | unchanged; recompute fires |
| READY_FOR_PICKUP / CLOSED / ABANDONED / CANCELLED (visit) or READY_TO_INVOICE / CLOSED / CANCELLED (order) | — | **no ETA published**; the last value is frozen (not nulled) for variance reporting |

**Confidence:** `DELAYED` if an open hold exists, or `now > promisedCompletionAt`, or `worked > planned + eta_delayed_grace_minutes`, or `estimatedCompletion > (promisedCompletionAt ?? scheduledEndAt) + eta_at_risk_margin_minutes`; `AT_RISK` if `worked > planned × eta_at_risk_ratio` or `estimatedCompletion` is within `eta_at_risk_margin_minutes` of the promised/planned end, or the position-derived range is at its cap; else `ON_TRACK`.

**Ranges (no false precision):** half-width = `eta_range_base_minutes` + `eta_range_per_position_minutes × positionsAhead`, capped at `eta_range_max_minutes`; all times rounded to 5 minutes; a **range** is shown when the half-width ≥ `eta_range_point_threshold_minutes`, otherwise a single time. In-service ON_TRACK jobs show a single time. Public copy: "Estimated Completion", "Updated Estimated Completion" (after a change), "Delayed".

### D3.4 Triggers to close (all call the existing `recomputeQueue(siteId)`)

| Action | Today | Cite |
|---|---|---|
| Check-in / walk-in registration (QUE-002 requires recompute on check-in) | **never recomputes** — ticket sits `PENDING_RANK` until an unrelated action | `check-in.service.ts:233-247`; `walk-ins.service.ts:265-266` |
| Pause / resume from PAUSED | explicitly skipped ("must not affect rank/ETA — deferred") | `service-orders.service.ts:1290-1291, 1344` |
| `assignAdditional` / `removeAssignment` / `updateAssignment` / `endAssignment`; `assignToResource` / `releaseResource` | no recompute | `service-orders.service.ts:1772-2084`; `resources.service.ts:106-261` |
| `changeStatus → CLOSED`; front-desk visit completion; pause approve/reject/correct | no recompute | `service-orders.service.ts:100-112`; `status.controller.ts:322-440`; `:1525-1689` |

None of these change *ranking* (IN_SERVICE tickets already carry `queueRank: null`, `service-orders.service.ts:2684`); they change when the ranker runs and what the ETA sees. Surfaced under AG-03 regardless.

### D3.5 Real-time

Keep the single unauthenticated `queue:updated` poke on `/queue` (`queue.gateway.ts:11-46`) — it carries no payload and the room is shared with the lobby TV, so **no per-visit ETA or PII ever rides it**. Add a `useQueueSocket(siteId, refetch)` hook and subscribe the dispatch board, queue board, visit workspace, technician pages, advisor ticket view and admin dashboard (today only the display subscribes; staff pages poll every 5–30 s — polling stays as the fallback). The customer status page subscribes too. Every trigger in §D3.4 therefore updates every surface without a manual refresh.

### D3.6 Surfaces

| Surface | Adds |
|---|---|
| **Customer Display** (`/display/:token`) | In Queue: "Est. start 2:00–2:15 PM · Est. done 3:20–3:35 PM"; In Service: "Estimated completion 3:20 PM" or **"DELAYED · Updated est. 4:10 PM"**; QC: "Finishing up · est. 3:25 PM"; Ready: unchanged. Payload gains `estimatedStart{min,max}`, `estimatedCompletion{min,max}`, `publicState` — no reasons, names, plates, amounts |
| Customer status page (`/status/:token`) | same fields beside the existing text tiers |
| **Dispatch** | per bay/technician "Est. done 3:20 PM · On Track / At Risk / Delayed" replacing the ⚠ aging heuristic; Needs-Dispatch rows show est. start; Overdue panel = `DELAYED`; workload = Σ remaining minutes per technician |
| **Visit Record** | Scheduled start · Actual start · **Estimated completion** (+ range, confidence, last update) · Actual completion |
| **Technician** | "Planned 1 h 20 · Target 3:20 PM" chip; over-expected tint driven by confidence |
| **Advisor** (`queue/[id]`) | "Customer-facing ETA 3:20–3:35 PM · updated 14:02" card |
| Check-in response / front desk | real `etaStartAt` after recompute (replaces the permanent "Pending") |
| Queue board | est. start / completion replace `~N min` |

### D3.7 Delay alerts (NOT-003, Phase D)

Wire `sendDelayAlert` when `estimatedCompletion − promisedCompletionAt > eta_delay_alert_minutes` (15) for opted-in customers, gated by `delay_alert_enabled = false` (deliberate enable, like maintenance reminders). Needs a `NotificationReason` member or reuse of `QUEUE_UPDATE`.

### D3.8 Schema

**None required** for Phase B. Optional later: `ServiceVisit.etaConfidence` enum if dashboards must filter on it (today derived at read time); `NotificationReason.DELAY`.

---

## D4. Reporting impact — Appointments & Bookings (Phase C; AG-09 definitions)

| Metric | Definition | Source |
|---|---|---|
| Total appointments | rows with `scheduledStartAt` in the period, any status | `Appointment` |
| Staff-created vs self-service | split by `sourceChannel` (`STAFF` / `CUSTOMER_SELF_SERVICE`) | `Appointment.sourceChannel` (finally written) |
| Cancellation rate | `CANCELLED ÷ total`; lead time = `cancelledAt − scheduledStartAt` from StatusHistory | `StatusHistory` |
| Reschedule rate | appointments with ≥ 1 `→ RESCHEDULED` StatusHistory row ÷ total | `StatusHistory` |
| No-show rate | `MISSED ÷ (MISSED + checked-in)` (KPI-08 — meaningful once MISSED is written) | `Appointment.status` |
| Appointment utilisation | Σ planned minutes of non-cancelled appointments ÷ (capacity tracks × open minutes) | engine capacity + `operating_hours` |
| Available capacity | slots still AVAILABLE per day (engine, read-only) | `computeAvailability` |
| Booking lead time | median / p90 of `scheduledStartAt − createdAt` | `Appointment` |
| On-time service starts | visits whose first `ServiceOrder.startedAt ≤ scheduledStartAt + protected_window_late_min` | `ServiceOrder`, rule |
| Estimated vs actual completion variance | `completedAt − currentEtaCompleteAt` (frozen last value) and `completedAt − (scheduledStartAt + planned)` — median / p90, plus % within range | `ServiceVisit`, `ServiceOrder` |

**MISSED writer (ARR-005):** hourly `AppointmentsCronService.markMissed()` — status ∈ DRAFT/CONFIRMED/RESCHEDULED, `scheduledStartAt + missed_threshold_min < now`, no `ServiceVisit` → `MISSED` + StatusHistory + AuditLog `APPOINTMENT_MISSED` (constant exists, unused — `audit.service.ts:25`). Gated `appointment_auto_missed_enabled = false` (deliberate enable). AG-01.

## D5. Configuration (all `BusinessRuleConfig`, snake_case, seeded create-if-missing, site `BERT-01`; new admin-settings tab **"Booking & ETA"** in `RULE_CATEGORIES`)

| Key | Default | Purpose |
|---|---|---|
| `default_appointment_duration_minutes` | `80` | planning duration (management's instruction) |
| `appointment_duration_source` | `"DEFAULT"` | `DEFAULT` = always 80; `CATALOGUE` = `ServiceType.baseDurationMinutes` when > 0 |
| `booking_enabled` | `true` | public booking kill-switch |
| `booking_slot_interval_minutes` | `20` | candidate start grid |
| `booking_min_notice_minutes` | `120` | earliest bookable start from now |
| `booking_advance_window_days` | `30` | how far ahead |
| `booking_same_day_allowed` | `true` | subject to min notice |
| `booking_capacity_mode` | `"FIXED"` | `FIXED` \| `RESOURCES` (Assumption 3) |
| `booking_max_concurrent_appointments` | `2` | **management must set** |
| `booking_capacity_resource_categories` | `["BAY","OVERFLOW"]` | used by `RESOURCES` mode |
| `booking_closed_dates` | `[]` | `YYYY-MM-DD[]` (public holidays, closures) |
| `booking_excluded_service_codes` | `[]` | hide services from the public list |
| `booking_cancel_cutoff_hours` | `2` | customer cancellation window |
| `booking_reschedule_cutoff_hours` | `2` | customer reschedule window |
| `booking_max_reschedules` | `3` | per appointment |
| `booking_manage_token_days_after` | `7` | manage-link life after the slot |
| `booking_arrival_instructions` | text | shown on confirm/confirmed/SMS |
| `booking_rate_limit_per_10_min` | `10` | per IP per route |
| `staff_capacity_warning_enabled` | `true` | Assumption 11 |
| `appointment_auto_missed_enabled` | `false` | §D4 |
| `eta_transition_overhead_minutes` | `5` | between jobs on a track |
| `eta_min_remaining_minutes` | `5` | floor for in-service remaining |
| `eta_qc_minutes` | `10` | QC stage allowance |
| `eta_rework_factor` | `0.5` | remaining share after rework |
| `eta_at_risk_ratio` | `0.85` | worked ÷ planned |
| `eta_at_risk_margin_minutes` | `15` | vs promised / planned end (NOT-003 threshold) |
| `eta_delayed_grace_minutes` | `0` | tolerance past planned |
| `eta_range_base_minutes` / `eta_range_per_position_minutes` / `eta_range_max_minutes` / `eta_range_point_threshold_minutes` | `10` / `5` / `45` / `10` | range presentation |
| `overdue_job_minutes` / `overdue_job_critical_minutes` | `120` / `240` | replaces hard-coded constants (`resources.service.ts:18`, `manager-dashboard.service.ts:260-289`) |
| `delay_alert_enabled` / `eta_delay_alert_minutes` | `false` / `15` | Phase D |

Existing keys reused unchanged: `operating_hours`, `protected_window_*`, `missed_threshold_min`, `appointment_reminder_*`, `eta_avg_*`. Retired keys (`reservation_*`, `eta_band_*`) stay hidden. GOV-002: only managers/admins edit any of these (`CONFIG_EDIT`).

---

## E. Impacted modules and data

**Schema (AG-02, Phase C only):**
- `Appointment` + `appointmentNumber String? @unique`, `manageTokenHash String? @unique`, `manageTokenExpiresAt DateTime?` (nullable; historical rows untouched).
- New `daily_booking_counters` (`siteId`, `businessDate @db.Date`, `lastSequence`, unique `(siteId, businessDate)`), mirroring `DailyTicketCounter`.
- Migration `prisma/migrations/2026MMDDHHMMSS_cr_2026_105c_self_service_booking/migration.sql` — additive, idempotent guards, no backfill; `schema.prisma` updated to match (drift check in `deploy:check`). `sourceChannel` stays a free string (no enum change).
- **Phases A and B: no schema change.**

**API:** new `modules/reporting` close-out service + endpoint; new `modules/scheduling/eta`; `modules/public-booking` (new); `modules/appointments` (façade, capacity check, cron, audit on reschedule/confirm); `modules/notifications` (opt-in gating, email body, reschedule/cancel templates); `modules/queue` (display payload, board), `modules/resources` (dispatch confidence), `modules/visits`, `modules/service-orders` (context/assignments ETA fields, rework `closedAt`), `modules/status`; `common/helpers/{operating-hours,eta-presentation,public-masking}.ts`; `AUDIT_ACTIONS` additions.

**Web:** `/reports/close-out` + hub grouping + shared date controls; `/book/**` (public); display, status, dispatch, visits/[id], technician, queue/[id], queue board, check-in, admin settings (new tab); `hooks/use-queue-socket.ts`; `lib/public-api.ts`; `route-smoke` inventories.

**Entities touched at runtime:** Appointment, AppointmentService, Customer, Vehicle, ServiceVisit (ETA columns), QueueTicket (unchanged fields), QueueDecision (ETA columns), ResourceOccupancy (`expectedEndAt`), StatusHistory, AuditLog, NotificationLog, BusinessRuleConfig.

## F. Risks / tradeoffs

- **Capacity number is a management input.** With `FIXED = 2` the engine is only as truthful as the setting; the report's "available capacity" makes drift visible.
- **Phone + plate identification** trades OTP strength for reliability in TEST/stub environments; the leak surface is limited to masked make/model/plate-last-4 of a customer's *other* vehicles after both facts match (AG-07 decision).
- **Public write endpoint without a throttler dependency** — in-memory limiting resets on Render cold start; adequate for pilot volume, upgrade path is AG-05.
- **Staff warn-not-block** means staff can still over-book; the audit trail records every acknowledgement.
- **Held-clock ETA** can under-promise during long holds; the DELAYED label and "Updated Estimated Completion" copy are the mitigation.
- **Adding recompute calls** to check-in, pause/resume and assignment paths increases recompute frequency (advisory-locked, per site; today it already runs on every status change) — measured in Phase B tests; no ranking change.
- **Historical appointments** have no reference number (nullable column) — search by reference covers new bookings only.
- **Render free tier cold starts** can make the first public page load slow; the page shows a warm-up state and retries.
- Duplicate customers from unmatched public bookings are possible by design; the customer directory's existing search surfaces them for merge.

## G. Tests / validation (maps management's §16)

- **Booking** (`public-booking/__tests__/`): new customer · existing customer (phone+plate) · existing vehicle · new vehicle · next available · fully booked day · closed day (`operating_hours` absent, `booking_closed_dates`) · capacity conflict (409 `SLOT_TAKEN`) · **concurrent confirm** (two `confirm` calls against a mocked lock serialise; second gets 409 — plus a live Postgres check in the parity run) · cancel returns capacity · reschedule frees old / consumes new · 80-minute duration applied · `appointment_duration_source = CATALOGUE` switches durations · min-notice/advance-window/same-day rules · manage-token hash + expiry + revocation on cancel · rate limit · privacy of every public response (no full plate/phone/email/name) · staff warn-not-block.
- **ETA** (`scheduling/eta/__tests__/`, pure-function tests on `computeSiteEta` / `presentEta`): appointment not arrived · waiting customer (N-track) · starts early / late · pause (clock held, DELAYED) · resume · delay past promised · reassignment (no reset) · rework · QC · completion (no ETA; frozen last value) · ranking inputs unchanged (assert `queueRank` untouched) · range widths and rounding · confidence thresholds from rules.
- **Customer Display** (`queue/__tests__/display-board.spec.ts`): correct ETA fields and `publicState` · no reasons/PII in payload · surface test asserts the page subscribes to `queue:updated` (updates without refresh) · terminal statuses carry no ETA.
- **Accounting** (`reporting/__tests__/close-out.spec.ts`): totals reconcile to drill-down row counts · `localDayRange` boundaries · cancelled/void visits excluded from "closed" and counted separately · no financial field is emitted when B-lite is off · CSV export contains every row (no cap) · date validation guard.
- **Appointments report:** each metric definition against fixture StatusHistory/Appointment rows; MISSED cron idempotency.
- **Web:** `cr-2026-105-surfaces.test.ts` (static assertions for `/book`, `/reports/close-out`, settings tab, display copy); `route-smoke.test.ts` inventories extended.
- Full suites (`pnpm typecheck && pnpm test`) green per phase; `pnpm build`; `deploy:check` PASS; docs/119 §G fresh-clone procedure repeated before Phase C is pushed.

## H. Approval gate

This CR crosses the following gates in `docs/21_Approval_Gates.md` and CLAUDE.md §9. **Implementation starts only after the owner approves each phase.**

| Gate | Decision | Phase |
|---|---|---|
| **AG-09** Reporting definitions | Close-Out "closed on day of CLOSED StatusHistory (site local)"; Appointments & Bookings metric definitions (§D4) | A, C |
| **Decision D1** (AG-01/AG-09) | A (status quo) now; B-lite (front-desk invoice # + total + payment status at close, existing columns) yes/no; C (POS integration) roadmap | A |
| **AG-03** Scheduling/ETA model | one ETA read model computed after ranking inside `recomputeQueue`; held-clock during holds; new recompute triggers (check-in, pause/resume, assignment, close); confidence/range rules | B |
| **AG-01** Business rules | `default_appointment_duration_minutes = 80` + `appointment_duration_source`; slot interval, min notice, advance window, same-day, capacity mode/number, closed dates, cancel/reschedule cutoffs; staff capacity warn-not-block; auto-MISSED cron | C (80-min key also seeded in B for ETA fallback) |
| **AG-02** Core schema | `Appointment.appointmentNumber`, `manageTokenHash`, `manageTokenExpiresAt`; `daily_booking_counters` | C |
| **AG-07** Security / permission model | first unauthenticated **write** endpoints; phone + plate identification; listing a matched customer's other vehicles (masked); hashed manage tokens; in-memory rate limiting | C |
| Deferred (Phase D) | AG-05 `@nestjs/throttler`/helmet, OTP; NOT-003 delay alerts; slot holds; technician-aware capacity; `etaConfidence` column; AG-06 POS integration | D |

Owner decisions requested: (1) approve Phase A; (2) D1 option B-lite yes/no; (3) approve Phase B incl. Assumption 9 (held clock); (4) approve Phase C incl. Assumptions 2–7, 10–11 and the capacity number; (5) confirm the phase order **A → B → C** (B underpins the "estimated duration" shown at booking and the variance metric; management listed accounting first, so A leads).

## I. Migrations, seeds, deploy parity

- **Migrations:** none (A, B); one additive migration (C, §E).
- **Seeds (`prisma/seed.ts`, create-if-missing, never updates operator values):** rule keys in §D5 (a `cr105Rules` array using the existing loop); no new users/sites/service types. No deploy-critical row counts change, so `deploy-check.mjs` needs no new `tableCheck`; add a `booking_enabled` presence check only if the owner wants the public page verified at deploy.
- **Env:** none new. `API_CORS_ORIGIN` unchanged (public page is served by the same Next app). Redis not required (cron via `@nestjs/schedule`, as today).
- **Assets:** none beyond `apps/web/public/brand-mark.png` already present.
- **Reproducibility confirmation (delivery item 13):** each phase is pushed only after `deploy:check` PASS, `pnpm build` clean, and — for C — the docs/119 §G fresh-clone run (clone → install → generate → migrate → seed → deploy:check → build → smoke incl. `/book`). Render then re-runs migrate + seed + check on deploy.

## J. Phasing and delivery checklist (management's §17)

| Phase | Ships | Delivery items |
|---|---|---|
| **A — CR-2026-105a** | Close-Out & Reconciliation report; hub separation; shared date controls; audit-row/`'SYSTEM'` fixes | 1 matrix (§D1.2), 2 existing reports (§D1.3), 3 added/modified (§D1.5), 10 tests, 13 parity |
| **B — CR-2026-105b** | ETA read model + rules; display/status/dispatch/visit/technician/advisor/board surfaces; recompute triggers; socket subscriptions | 7 methodology (§D3.3), 8 display screenshots, 9 staff screenshots, 10 tests, 12 seeds, 13 parity |
| **C — CR-2026-105c** | Public booking (identify → vehicle → service → availability → confirm → confirmed; manage link); availability engine; reference + token; notifications wiring; staff capacity warning; MISSED cron; Appointments & Bookings report; admin tab | 4 architecture (§D2), 5 booking screenshots, 6 slot/capacity explanation (§D2.3), 10 tests, 11 migration, 12 seeds, 13 parity |
| **D — optional** | throttler/OTP, delay alerts, holds, technician-aware capacity, POS capture (D1 B-lite/C) | separate approval |

**Flow preserved end-to-end:** Customer self-booking → Appointment (`CUSTOMER_SELF_SERVICE`) → ServiceVisit (check-in, unchanged) → Queue (FIFO-first, unchanged) → Dispatch → Technician work → Estimated Completion (one model) → Customer Display → Completion → Service History → Close-Out / Appointments reporting. Same customer, vehicle, visit, orders and audit history throughout.

---

## K. Implementation record — Phase B (CR-2026-105b: authoritative ETA read model) — **Implemented 2026-09-11**

**No schema change.** The model writes the columns that existed unused since the initial migration.

### K1. What was built
- **Pure model** `apps/api/src/modules/scheduling/eta/eta.model.ts` — `resolvePlannedMinutes` (KPI standard → Σ item estimates → Σ catalogue durations → Σ appointment services × qty → `default_appointment_duration_minutes` = 80), `workedMinutes` (holds excluded, docs/114 time model), `computeSiteEta` (N-track projection: tracks = max(capacity, cars actually in service); in-service completion = now + remaining; QC = now + allowance; **held clock** during holds; waiting cars placed in ranked order on the earliest-free track + transition overhead; blocked = no time; rework = configured share). Emits only times — never anything the ranker reads.
- **Rules** `eta.config.ts` — 16 `BusinessRuleConfig` keys (§D5 subset) with typed defaults; site rows win over global; invalid values fall back. Seeded create-if-missing (`prisma/seed.ts` `cr105Rules`) and editable under **Settings → Booking & ETA**. The capacity keys (`booking_capacity_mode`, `booking_max_concurrent_appointments`, `booking_capacity_resource_categories`) are shared with Phase C.
- **Service** `eta.service.ts` — loads rules (RESOURCES mode sums `WorkResource.capacity`), loads in-service visits **scoped to live visits** (`serviceVisitIsLive()`) and **skips visits with no live order** (lifecycle leftovers — three were found on the pilot data and are logged as a warning rather than costing a customer a track), runs the model.
- **Integration** `scheduling.service.ts` — after `calculatePriorityPositions`, inside the advisory lock and the same transaction: `ServiceVisit.currentEtaStartAt/currentEtaCompleteAt` for ranked **and** in-service visits, `QueueDecision.etaStartAt/etaCompleteAt` on every snapshot, `ResourceOccupancy.expectedEndAt` for the occupied bay. A projection failure never stops ranking (tested). `QueueTicket.lastRankedAt` is the "last ETA update".
- **One presentation** `apps/api/src/common/helpers/eta-presentation.ts` — `presentEta` derives **On Track / At Risk / Delayed**, ranges (half-width = base + per-position, capped; shown only above the point threshold), 5-minute rounding, terminal suppression (READY_FOR_PICKUP/CLOSED/ABANDONED/CANCELLED carry no estimate; the last value stays on the row for variance reporting); `toPublicEta` strips reasons. Every surface calls it: queue board (`eta` per row; the rank × average guess is no longer displayed), lobby display (`estimatedStart/estimatedCompletion/publicState/showRange` + `stage`), customer status page (`eta`), ticket detail (`eta`), dispatch overview (`currentJob.eta` + `confidence`; `aging` now also honours DELAYED; threshold from `overdue_job_minutes`), Visit Record (`derived.scheduledStartAt`, `derived.eta`), technician reads (`plannedMinutes`, `eta` on `mine/assignments` and job context), check-in / walk-in responses (`etaStartAt` is now real).
- **Triggers closed** — check-in and walk-in registration now call `recomputeQueue` (QUE-002; tickets no longer sit PENDING_RANK); pause and resume recompute (**docs/25 sub-decision taken: rank untouched, estimate republished with the clock held**); add/remove/end assignment, bay assign/release, front-desk close-out and `CLOSED` orders recompute. Manager `OVERDUE_JOB` thresholds moved to `overdue_job_minutes` / `overdue_job_critical_minutes`.
- **Real-time** — `apps/web/hooks/use-queue-socket.ts` subscribes staff pages (dispatch, queue board, visit record, technician list + job workspace, advisor ticket) to the existing PII-free `queue:updated` poke and invalidates their queries; polling stays as the fallback. The lobby display already subscribed.
- **Web** — shared `lib/eta-format.ts` (window/range formatting in the site zone, confidence labels/colours); display cards show *Est. start / Est. done* (queue), *Est. completion* / *Finishing up · est.* (in service / QC) or **DELAYED · Updated est.**; status page shows the same; dispatch shows *Est. done + On Track/At Risk/Delayed*; Visit Record shows **Scheduled start · Actual start · Estimated completion (+confidence, updated at) · Actual completion**; technician cards/workspace show *Target hh:mm*; advisor ticket has a **Customer-facing ETA** card.
- **Fixed alongside** — `'SYSTEM'` written to the uuid `actorUserId` column (`maintenance-reminder.service.ts`, `service-orders.service.ts`) → `null`.

### K2. Deviations from the plan
- KPI-standard minutes are read from the persisted `WorkOrderKpiSnapshot` (fixed at start of work) rather than by calling the KPI service, to avoid a module cycle; the precedence is otherwise as planned.
- `updateAssignment` (edit before work starts) does not recompute — it changes who, not capacity.
- Delay alerts (NOT-003) remain Phase D as planned.

### K3. Verification
- `@bsop/api` + `@bsop/web` `tsc --noEmit` clean. API suite **1098/1098** (120 files; +36 new: `eta.model.spec` 19, `eta-presentation.spec` 13, `recompute-eta.spec` 2, `eta.service.spec` 4 — covering normal appointment, waiting customer, early/late start, pause (clock held), resume, delay, reassignment, rework, QC, completion suppression, blocked, tracks, rounding, public projection, ranking untouched, failure isolation, live scoping). `pause-rework.service.spec` updated to the new rule. Web **191/191** (+6 `cr-2026-105b-surfaces`). `deploy:check` **PASS** (21 ok, no drift).
- **Runtime (local, seeded rules):** `POST /queue/recompute` → 201; `GET /display/:token` now returns `estimatedStart {at,min,max}`, `estimatedCompletion`, `publicState`; the lobby screen rendered *"#1 of 1 · Est. start 2:45–3:05 PM · Est. done 3:15–3:35 PM"* in site time; the queue board column *Est. start → done* and the advisor ticket's *Customer-facing ETA* card (On Track, "updated 2:38 PM") matched it exactly. After the leftover-visit fix the projected start is one transition overhead after the recompute. No console/page errors.
- **Not exercised live:** an occupied bay's ETA on Dispatch (no live in-service car on the pilot data; the mapping is typed and the presentation is unit-tested).

### K4. Operational notes for the owner
- Three live visits at BERT-01 read WAITING_PARTS/QC with no open order (tickets `B01-260901-008`, `B01-260901-010`, `B01-260821-003`): the model now ignores them, but they should be closed in-app.
- `booking_max_concurrent_appointments` is seeded at **2** and must be set to the real number of concurrent service positions — it now drives every estimate.
- Files: `modules/scheduling/{scheduling.service,scheduling.module}.ts`, `modules/scheduling/eta/*`, `common/helpers/eta-presentation.ts`, `modules/{queue,status,visits,resources,service-orders,appointments,walk-ins}/…` (services + modules), `modules/reporting/manager-dashboard.service.ts`, `modules/maintenance/maintenance-reminder.service.ts`, `prisma/seed.ts`, web `lib/eta-format.ts`, `hooks/use-queue-socket.ts`, display/status/dispatch/visits/technician/queue pages, admin settings, tests. Committed as `CR-2026-105b`, annotated tag, pushed.
