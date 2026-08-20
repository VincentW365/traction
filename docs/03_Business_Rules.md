# 03_Business_Rules.md

## Purpose

This is the formal rule catalogue for the platform.

Each rule uses:
- rule
- example
- exception
- system response

This format must be preserved in design, code, tests, and training.

The CSV version lives in `data/business_rules.csv`.

## Rule Summary by Category

| category | count |
| --- | --- |
| Scheduling | 4 |
| Arrival & Check-In | 7 |
| Queue | 7 |
| Technician & Bay | 4 |
| Parts | 5 |
| Transport | 4 |
| Notifications | 3 |
| Governance | 5 |

---

## Scheduling

### SCH-001 — Appointment slots must be generated from operating hours, bay capacity, technician availability, and service duration templates.

- **Category:** Scheduling
- **Example:** An A/C repair cannot be offered into a 30-minute slot or outside the A/C specialist's shift.
- **Exception:** Manager may open a manual slot with explicit override reason.
- **System response:** Reject or suppress invalid slots; log overrides.
- **Phase introduced:** 1


### SCH-002 — Appointments requiring specialist skills must only be booked into slots where at least one qualified technician is scheduled.

- **Category:** Scheduling
- **Example:** Transmission diagnostics only appear on days when a transmission-qualified technician is present.
- **Exception:** Diagnostic-only holding slot may be created if policy allows later reassignment.
- **System response:** Offer only compatible slots or require override.
- **Phase introduced:** 1


### SCH-003 — Critical-parts services should not be confirmed unless mandatory parts are available, reservable, or a manager override is recorded.

- **Category:** Scheduling
- **Example:** Brake pad replacement is not confirmed without reserved pads and rotors if required.
- **Exception:** Diagnostic-only booking may proceed without parts reservation.
- **System response:** Flag as parts-pending or require override with reason.
- **Phase introduced:** 3


### SCH-004 — Multiple services requested for the same customer/vehicle in the same visit must be grouped under one appointment and one operational visit.

- **Category:** Scheduling
- **Example:** Oil change + tire rotation uses one appointment and one queue position.
- **Exception:** Separate days or separate vehicles create separate visits.
- **System response:** Merge requested lines into one visit plan.
- **Phase introduced:** 1


## Arrival & Check-In

### ARR-001 — A customer only enters the active queue after check-in is completed by staff or approved self-check-in.

- **Category:** Arrival & Check-In
- **Example:** Booked customer arrives but is not eligible for ranking until check-in is done.
- **Exception:** Pre-arrival status may be visible for operational awareness but is not rankable.
- **System response:** Create or activate service visit and queue ticket at check-in.
- **Phase introduced:** 1


### ARR-002 — An appointment checked in from 30 minutes before to 15 minutes after its scheduled start retains protected appointment priority.

- **Category:** Arrival & Check-In
- **Example:** 9:00 AM appointment checked in at 8:45 AM or 9:10 AM remains protected.
- **Exception:** If parts or qualified technician are unavailable, visit becomes blocked rather than scheduled.
- **System response:** Assign priority class APPT_PROTECTED.
- **Phase introduced:** 1


### ARR-003 — Arrivals more than 30 minutes early are treated as walk-ins until the appointment protection window opens.

- **Category:** Arrival & Check-In
- **Example:** 10:00 AM appointment arriving at 9:00 AM may be served early only if walk-in rules permit.
- **Exception:** Manager may manually honor early protected treatment.
- **System response:** Assign temporary walk-in class until T-30 minutes.
- **Phase introduced:** 1


### ARR-004 — Appointments checked in 16 to 30 minutes late lose protected slot priority and enter the dynamic queue with a lateness penalty.

- **Category:** Arrival & Check-In
- **Example:** 9:00 AM appointment checked in at 9:22 AM no longer preempts all walk-ins.
- **Exception:** Manager may restore protected status for valid reasons.
- **System response:** Assign priority class APPT_LATE_SOFT and recompute ETA.
- **Phase introduced:** 1


### ARR-005 — Appointments more than 30 minutes late without approved exception become missed appointments and must be rescheduled or converted to walk-in service based on capacity.

- **Category:** Arrival & Check-In
- **Example:** 9:00 AM appointment arriving at 9:40 AM becomes MISSED unless staff override.
- **Exception:** Customer notified ahead due to emergency and manager approves same-day fit-in.
- **System response:** Mark appointment MISSED and offer reschedule or walk-in conversion.
- **Phase introduced:** 1


### ARR-006 — Walk-ins receive the next available immutable ticket number at the moment of completed check-in.

- **Category:** Arrival & Check-In
- **Example:** Two walk-ins arriving minutes apart receive ticket 014 and 015 even if rank later changes.
- **Exception:** None.
- **System response:** Create queue ticket and compute dynamic rank separately.
- **Phase introduced:** 1


### ARR-007 — If the same customer has multiple same-day services or appointments for the same vehicle, only one active queue position is allowed.

- **Category:** Arrival & Check-In
- **Example:** Brake inspection followed by oil change stays in one queue position with multiple order lines.
- **Exception:** Different vehicles may have separate visits.
- **System response:** Merge or link visits and prevent duplicate queue entries.
- **Phase introduced:** 1


## Queue

### QUE-001 — Ticket number is immutable; queue rank is dynamic and recalculated as operating conditions change.

- **Category:** Queue
- **Example:** Ticket 018 may move from rank 6 to rank 4 after parts become ready.
- **Exception:** None.
- **System response:** Store sequence and rank as separate fields.
- **Phase introduced:** 1


### QUE-002 — Queue rank must be recomputed on check-in, technician availability changes, service completion, parts readiness changes, and manager override.

- **Category:** Queue
- **Example:** When a technician finishes a brake job, all eligible brake-family tickets may be resequenced.
- **Exception:** System maintenance mode may pause recomputation.
- **System response:** Trigger scheduler and persist decision snapshot.
- **Phase introduced:** 1


### QUE-003 — Eligible protected appointments rank ahead of eligible walk-ins.

- **Category:** Queue
- **Example:** An on-time 10:00 AM appointment outranks a 9:50 AM walk-in when both are ready and compatible.
- **Exception:** Quick-service fast-track lane may take qualifying walk-ins if no protected appointment is delayed beyond policy threshold.
- **System response:** Base priority class weighting enforces appointment preference.
- **Phase introduced:** 1


### QUE-004 — The system must surface long-wait walk-ins for manual review once wait time breaches the fairness threshold.

- **Category:** Queue
- **Example:** A walk-in waiting 90+ minutes triggers manager alert.
- **Exception:** None.
- **System response:** Create fairness alert and optional override suggestion.
- **Phase introduced:** 2


### QUE-005 — Quick-service visits may be fast-tracked only when a dedicated quick lane exists or when insertion will not delay any protected appointment by more than 10 minutes.

- **Category:** Queue
- **Example:** An oil change can jump ahead if a lube bay is idle.
- **Exception:** Manager may force insertion for strategic/VIP reasons with audit.
- **System response:** Apply quick-service bonus subject to delay constraint.
- **Phase introduced:** 2


### QUE-006 — Batching similar service families is allowed when it increases operational efficiency without violating protected appointment delay thresholds.

- **Category:** Queue
- **Example:** Three tire rotations may be grouped for one technician if promised times still hold.
- **Exception:** Safety-critical or customer-promised expedite jobs may bypass batch.
- **System response:** Apply batching bonus and record reason code.
- **Phase introduced:** 2


### QUE-007 — Every manual queue override requires a reason code, actor identity, and before/after snapshot.

- **Category:** Queue
- **Example:** Manager pushes a fleet customer ahead due to commercial SLA.
- **Exception:** None.
- **System response:** Persist audit log and status history.
- **Phase introduced:** 1


## Technician & Bay

### TECH-001 — A technician may only be assigned when the required skill set is met.

- **Category:** Technician & Bay
- **Example:** Electrical diagnostic cannot be assigned to a lube-only technician.
- **Exception:** Trainee shadowing is allowed only with a qualified primary technician.
- **System response:** Block incompatible assignment.
- **Phase introduced:** 2


### TECH-002 — Complex repairs must be assigned to named specialists or technicians meeting the configured proficiency threshold.

- **Category:** Technician & Bay
- **Example:** A/C repair requires AC skill and proficiency level >= configured minimum.
- **Exception:** Manager temporary assignment with explicit supervision flag.
- **System response:** Filter assignment candidates by skill and level.
- **Phase introduced:** 2


### TECH-003 — A technician cannot be double-booked across overlapping active work unless one job is paused and the system records the pause.

- **Category:** Technician & Bay
- **Example:** Tech cannot be shown as actively performing two repairs at once.
- **Exception:** Inspection plus admin note tasks do not count as active wrench time.
- **System response:** Prevent overlapping active assignments.
- **Phase introduced:** 2


### TECH-004 — Work bay type must match the service requirement.

- **Category:** Technician & Bay
- **Example:** Wheel alignment must be assigned to an alignment-capable bay.
- **Exception:** No exception for mandatory bay requirements.
- **System response:** Exclude incompatible bays from scheduling.
- **Phase introduced:** 2


## Parts

### PART-001 — Mandatory parts requests must be created no later than advisor approval of the repair scope.

- **Category:** Parts
- **Example:** Brake replacement approval creates a request for pads, clips, and optional sensors.
- **Exception:** Diagnostic visits with unknown required parts.
- **System response:** Generate parts request and line items.
- **Phase introduced:** 3


### PART-002 — For next-day appointments, missing critical parts must generate transfer or procurement action before the previous-business-day cutoff.

- **Category:** Parts
- **Example:** A 10:00 AM next-day appointment missing AC compressor triggers transfer by 3:00 PM prior day.
- **Exception:** Weekend/holiday cutoff uses preceding business day rules.
- **System response:** Open inventory transfer or procurement task and alert parts team.
- **Phase introduced:** 3


### PART-003 — A job cannot move into Ready for Service when mandatory parts are unavailable, unless it is flagged diagnostic-only or overridden by manager.

- **Category:** Parts
- **Example:** Shock replacement remains BLOCKED_PARTS until shocks are reserved.
- **Exception:** Customer approves partial work order.
- **System response:** Block service-start state transition.
- **Phase introduced:** 3


### PART-004 — Parts substitutions require advisor or manager approval and must be auditable.

- **Category:** Parts
- **Example:** Alternative oil filter brand used due to stock issue.
- **Exception:** Pre-approved equivalent substitute list can auto-approve.
- **System response:** Record substitution approval and update request item.
- **Phase introduced:** 3


### PART-005 — Inventory transfers must track origin, destination, ETA, received timestamp, and exception reason if delayed.

- **Category:** Parts
- **Example:** Pads transferred from branch A to service center.
- **Exception:** None.
- **System response:** Expose transfer status in parts dashboard.
- **Phase introduced:** 3


## Transport

### TRANS-001 — Customer transport is available only to eligible services, eligible geography, and available transport capacity.

- **Category:** Transport
- **Example:** A 3-hour AC repair within the service zone qualifies for work drop-off.
- **Exception:** Manager may approve courtesy transport manually.
- **System response:** Eligibility checked at booking and reconfirmed at check-in.
- **Phase introduced:** 4


### TRANS-002 — Drop-off destination and pickup preference must be confirmed before vehicle service start.

- **Category:** Transport
- **Example:** Customer chooses office drop-off and home pickup.
- **Exception:** Customer declines return pickup.
- **System response:** Store transport legs and required contact details.
- **Phase introduced:** 4


### TRANS-003 — Return pickup coordination starts when predicted remaining service time is 30 minutes or less or when vehicle reaches Ready for Pickup.

- **Category:** Transport
- **Example:** System prompts dispatcher to contact customer near completion.
- **Exception:** Customer opted out of transport notifications.
- **System response:** Create dispatch alert and notification job.
- **Phase introduced:** 4


### TRANS-004 — Driver assignment cannot occur without confirmed customer time window.

- **Category:** Transport
- **Example:** Dispatcher cannot assign driver until customer accepts 5:30 PM pickup window.
- **Exception:** Internal shuttle moves without customer if vehicle-only transfer.
- **System response:** Hold request in CONFIRMATION_PENDING.
- **Phase introduced:** 4


## Notifications

### NOT-001 — Booking confirmation must be sent immediately after appointment creation or reschedule.

- **Category:** Notifications
- **Example:** Customer receives SMS/email with date, time, service summary, and instructions.
- **Exception:** Customer opted out or channel unavailable.
- **System response:** Queue notification with fallback channel if configured.
- **Phase introduced:** 1


### NOT-002 — Reminder cadence should default to 24 hours and 2 hours before appointment time.

- **Category:** Notifications
- **Example:** Reminder sent day before and same morning.
- **Exception:** Same-day bookings skip 24-hour reminder.
- **System response:** Create scheduled jobs using job scheduler.
- **Phase introduced:** 4


### NOT-003 — Delay alerts must be sent when predicted start or completion breaches promised window by more than 15 minutes.

- **Category:** Notifications
- **Example:** Technician delay pushes expected completion from 3:00 PM to 3:30 PM.
- **Exception:** Internal-only note when customer has no preferred channel.
- **System response:** Send proactive update and record delivery status.
- **Phase introduced:** 4


## Governance

### GOV-001 — Every state change for appointments, visits, queue tickets, service orders, parts requests, and transport requests must be timestamped and auditable.

- **Category:** Governance
- **Example:** Service order moved from IN_PROGRESS to WAITING_PARTS.
- **Exception:** None.
- **System response:** Write to status_history automatically.
- **Phase introduced:** 1


### GOV-002 — Only managers and admins may edit global business rules, service durations, grace periods, or operating hours.

- **Category:** Governance
- **Example:** Technician cannot change 15-minute grace period.
- **Exception:** Feature-flagged delegated admin role may be introduced later.
- **System response:** Enforce RBAC and audit change.
- **Phase introduced:** 1


### GOV-003 — Operational records should be soft-deleted only when legally and operationally safe; otherwise use cancel/void states.

- **Category:** Governance
- **Example:** Cancelled appointment remains in history.
- **Exception:** PII deletion requests may require anonymization.
- **System response:** Use status-based lifecycle, not hard delete, for operational entities.
- **Phase introduced:** 1


### GOV-004 — External integration calls must be idempotent and retryable with dead-letter handling.

- **Category:** Governance
- **Example:** POS sync retries after temporary outage without creating duplicate invoices.
- **Exception:** None.
- **System response:** Use idempotency key and outbox/integration job tracking.
- **Phase introduced:** 2


### GOV-005 — ~~Vehicle release should require payment cleared or approved account exception before final closure.~~ **WITHDRAWN**

- **Category:** Governance
- **Status:** **Withdrawn 2026-08-20 (CR-2026-085), by owner direction.**
- **Rationale:** Payment is settled in the external POS, which is the source of truth
  for it. Traction only ever mirrored a `paymentStatus` field, so gating close-out on
  it stalled the front desk on data this system does not own, and every real release
  became a manager override — an exception that fires every time is not a control.
- **System response now:** Closing a visit is a purely operational action and is never
  blocked by payment. `ServiceOrder.paymentStatus` is still recorded and still
  reportable. If a visit is closed while payment is not cleared, an `AuditLog` row is
  written (`reasonCode: RELEASED_PAYMENT_NOT_CLEARED`) so the question "was this car
  released before payment cleared?" stays answerable after the fact.
- **Applies to both close-out paths:** the one-click *Picked Up* on the boards and
  *Close Visit* on the ticket now behave identically.
- **Re-introducing a gate is a business-rule decision, not a code tweak** — it needs a
  change request under `docs/21_Approval_Gates.md`, and ideally a real POS integration
  rather than a mirrored field.
- **Phase introduced:** 2 · **Withdrawn:** CR-2026-085



---
## Implementation Notes

### Configurable values that should live in business-rule configuration
- late grace period minutes
- early-arrival threshold minutes
- fairness escalation threshold
- quick-service delay tolerance
- batching delay tolerance
- transport minimum service duration
- next-day parts cutoff time
- reminder cadence
- site operating hours
- service duration templates

### Test design expectation
Every rule above should map to at least:
- one unit or domain test
- one integration or E2E test if it affects workflow

### Governance expectation
If any rule changes:
1. update this document
2. update `data/business_rules.csv`
3. update tests
4. update configuration seed or admin settings
5. raise an approval request if the rule is covered by `docs/21_Approval_Gates.md`
