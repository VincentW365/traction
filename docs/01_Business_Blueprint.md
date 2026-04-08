# 01_Business_Blueprint.md

## Objective

Define the future-state operating model for Bert's Auto Parts Service Centre as one unified service platform.

This document answers:
- how work moves through the business
- who touches each step
- where the scheduling brain decides
- where queue fairness and efficiency interact
- which operational events must be captured

---

## 1. Service Journey Overview

The end-to-end service journey is:

1. Appointment booking **or** walk-in arrival
2. Customer identification and vehicle context
3. Check-in and queue ticket creation
4. Scheduler eligibility and ranking
5. Service order confirmation / refinement
6. Technician and bay assignment
7. Parts staging or transfer if needed
8. Service execution and live status tracking
9. Quality check and invoice readiness
10. Pickup / customer transport coordination
11. Payment closure
12. Follow-up reminders and retention actions

The platform should make this journey visible as a **single connected flow**, not a chain of siloed spreadsheets, whiteboards, and memory.

---

## 2. User Types and Their Core Responsibilities

### Customer
- requests service
- books appointment or arrives as walk-in
- checks queue status
- confirms reminders
- chooses transport options where eligible
- completes pickup

### Front Desk / Cashier
- finds or creates customer and vehicle
- checks customers in
- registers walk-ins
- issues queue ticket
- updates customer-facing status
- handles payment close and release rules

### Service Advisor
- creates / edits appointments
- validates requested service scope
- creates / refines service orders
- promises times carefully
- communicates delays / changes
- assigns or approves work plans

### Technician
- sees assigned work queue
- updates status through service lifecycle
- records start, pause, waiting parts, and completion
- can request parts / escalation
- performs work and QC handoff

### Parts / Store Staff
- reserves or stages parts
- manages critical parts status
- opens and tracks inventory transfers
- marks parts-ready status
- handles substitution approvals through policy

### Manager / Admin
- monitors live operation
- resolves bottlenecks
- applies audited overrides
- configures business rules
- views KPIs and audit logs
- manages users / permissions

### Driver / Transport Coordinator
- manages eligible transport requests
- schedules drop-off / pickup legs
- confirms customer windows
- assigns driver and tracks completion

---

## 3. Future-State Operating Model

### 3.1 Booking path
A booking creates planned intent:
- customer
- vehicle
- requested services
- scheduled time window
- site
- confirmation state
- early indication of parts / skill needs

This is **planning truth**, not yet operational truth.

### 3.2 Operational activation path
When the customer actually arrives and checks in:
- appointment is activated into a `ServiceVisit`, or
- walk-in creates a `ServiceVisit` directly

That `ServiceVisit` is then used for:
- queue ticket
- service order
- technician assignment
- parts flow
- transport flow
- notifications
- timestamps and audit

### 3.3 Scheduling path
The Scheduling Engine looks at:
- policy rules
- arrival timing
- technician skill
- bay capacity
- parts readiness
- current queue state
- duration assumptions
- fairness considerations

It then determines:
- whether the visit is eligible
- its current priority class
- its current queue rank
- best technician / bay candidates
- predicted start and completion

### 3.4 Execution path
Once assigned:
- work starts
- status changes are captured
- delays and parts waits are visible
- completion triggers downstream actions
- customer gets clearer expectations

### 3.5 Closure path
At completion:
- QC passes
- invoice readiness status is set
- payment reference is attached or confirmed
- transport / pickup coordination happens
- visit is closed
- follow-up or retention reminder logic can begin later

---

## 4. Operational Lanes

The platform has several logical lanes that intersect:

### Lane A — Appointment planning lane
Time-slot, customer intent, requested service, confirmations.

### Lane B — Queue and arrival lane
Check-in, ticket, queue class, ranking, ETA.

### Lane C — Workshop execution lane
Technician assignment, bay assignment, work status, completion.

### Lane D — Parts lane
Requirement, reservation, transfer, blocked/ready status.

### Lane E — Transport lane
Drop-off, pickup, driver assignment, completion.

### Lane F — Reporting lane
Timestamps, audit logs, metrics, operational dashboards.

The most important design rule is that these lanes must meet through shared entities, not duplicated records.

---

## 5. Event Model

The following business events should exist as first-class events in the system, even if they are initially implemented as DB writes plus status history:

- appointment_created
- appointment_confirmed
- appointment_rescheduled
- appointment_cancelled
- customer_checked_in
- walkin_registered
- queue_ticket_issued
- queue_rank_recomputed
- queue_override_applied
- service_order_created
- service_scope_approved
- technician_assigned
- service_started
- service_paused
- waiting_parts
- parts_requested
- parts_reserved
- transfer_created
- parts_ready
- qc_completed
- ready_for_pickup
- payment_confirmed
- transport_requested
- driver_assigned
- transport_leg_started
- transport_leg_completed
- delay_alert_sent
- visit_closed

This event discipline will later make integrations and analytics much stronger.

---

## 6. Business Process Narratives

### 6.1 Appointment booking narrative
1. Customer or staff requests a service.
2. System captures customer, vehicle, service type, and preferred time.
3. Scheduler validates available slots based on service duration, skill, bay capacity, and hours.
4. Appointment is created and confirmation is sent.
5. If critical parts are required, reservation or preparation workflow is opened.

### 6.2 Walk-in narrative
1. Customer arrives without appointment.
2. Front desk identifies or creates customer and vehicle record.
3. Service request is categorized.
4. Walk-in `ServiceVisit` and queue ticket are created.
5. Scheduler calculates rank and ETA based on current load and rules.

### 6.3 Check-in narrative
1. Customer arrives.
2. Staff finds the appointment or walk-in record.
3. Arrival timing is compared to appointment window.
4. Early / on-time / late rules are applied automatically.
5. Queue ticket is issued and displayed.
6. `ServiceVisit` becomes active in the scheduling engine.

### 6.4 Service execution narrative
1. Advisor confirms scope.
2. System creates or finalizes service order.
3. Scheduler or advisor assigns compatible technician and bay.
4. Technician starts work and updates statuses.
5. If parts become a blocker, job moves to waiting state and parts flow activates.
6. On completion, QC and invoice readiness steps occur.

### 6.5 Parts readiness narrative
1. Approved repair scope produces parts request.
2. Parts team reserves stock or triggers transfer.
3. Job remains blocked until mandatory parts are ready.
4. Once ready, scheduler can reconsider the visit for active service sequencing.

### 6.6 Transport narrative
1. Eligible customer chooses transport.
2. Drop-off destination and return preference are captured.
3. Coordinator assigns driver based on availability.
4. Return pickup is triggered near completion.
5. Completion is logged to measure service convenience quality.

---

## 7. Operating Policies That Must Stay Visible

The platform should never bury these policies:

- appointments are favored, not blindly absolute
- walk-ins must still be treated fairly
- quick-service efficiency cannot destroy trust
- parts readiness changes operational truth
- qualified people do qualified work
- managers can intervene, but intervention must be visible
- customer communication is part of the service, not a side effect

---

## 8. Handoffs and Failure Points

### Common handoffs
- customer to front desk
- front desk to service advisor
- advisor to technician
- technician to parts team
- parts team back to scheduler / advisor
- workshop to cashier
- workshop to transport coordinator
- manager across all lanes

### Common failure points the system must reduce
- customer arrival with no clear queue place
- appointment booked into impossible slot
- duplicate queue positions for same customer
- parts discovered too late
- technician assignment without skill fit
- customers not told about delays
- payment or release confusion
- manual override without traceability

---

## 9. Business Blueprint Outcomes

If implemented correctly, the future-state business model should create:

- faster, cleaner front-desk throughput
- fewer arguments about queue order
- better workshop flow
- earlier visibility of parts constraints
- measurable technician and bay utilization
- less customer uncertainty
- stronger follow-up and repeat business potential

---

## 10. Linked Documents

- `docs/02_Process_Flows.md`
- `docs/03_Business_Rules.md`
- `docs/08_Scheduling_Engine_Spec.md`
- `docs/09_Data_Model.md`
- `docs/12_UI_UX_Spec.md`
