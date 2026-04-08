# 07_Phased_Delivery_Plan.md

## Purpose

This document defines the build sequence.
The platform must be delivered in phases to maximize value early and avoid overbuilding.

---

## 1. Phase Summary

| phase | name | goals | exit_gate |
| --- | --- | --- | --- |
| 0 | Discovery & Design | Lock business rules, operating model, data model, wireframes, MVP scope. | Signed-off rules, service catalogue, ERD, module map, screen inventory. |
| 1 | Core Scheduling & Queue | Appointments, walk-ins, check-in, queue tickets, queue board, audit, settings. | Staff can book, check in, and manage live queue with explainable ordering. |
| 2 | Service Operations | Service orders, technician/bay assignment, work statuses, batching, utilization dashboards. | Workshop flow and assignment work end-to-end with status history. |
| 3 | Parts Readiness & Transfer | Parts requests, reservation, transfer tracking, parts blocking, prep dashboard. | Parts-dependent jobs are visible and controllable before service delays occur. |
| 4 | Notifications & Transport | Reminders, delay alerts, pickup notices, transport request flow. | Customers receive timely updates and transport can be coordinated operationally. |
| 5 | Analytics & Optimization | Advanced reports, recurring maintenance, predictive candidates, optimization suggestions. | Managers get actionable trend and optimization insights from reliable data. |

---

## 2. Why This Order Is Correct

### Phase 0 first
Without rules, service catalogue, and data model discipline, development will drift.

### Phase 1 second
Queue + appointment management already creates major business value and operational visibility.

### Phase 2 next
Once demand intake is clean, the workshop execution model can be digitized.

### Phase 3 after that
Parts readiness only works well when service order scope and scheduling discipline already exist.

### Phase 4 after operational core
Notifications and transport become meaningful once real statuses and ETAs exist.

### Phase 5 last
Optimization without clean data is noise.

---

## 3. Detailed Phase Plan

### Phase 0 — Discovery & Design
**Deliver**
- business blueprint
- process flows
- rules catalogue
- service catalogue
- roles / permissions
- ERD and schema outline
- wireframe inventory
- backlog and scope ranking

**Do not leave this phase until**
- core policies are explicit
- assumptions are documented
- MVP is scoped
- no ambiguous ownership exists for queue, scheduling, or parts truth

---

### Phase 1 — Core Scheduling & Queue
**Must-have**
- customer and vehicle master basics
- appointment creation and reschedule
- walk-in registration
- check-in
- immutable queue ticket generation
- dynamic queue ranking
- live queue board
- settings for grace period / early arrival / operating hours
- audit logs and status history
- basic confirmation messaging
- KPI data capture foundations

**Acceptance bar**
- reception can operate without spreadsheets
- queue order can be explained
- appointments and walk-ins coexist cleanly
- timestamps are reliable

**Deferrals**
- technician optimization depth
- parts reservation
- transport
- advanced analytics

---

### Phase 2 — Technician & Service Operations
**Must-have**
- service order creation
- advisor-approved work scope
- technician and bay assignment
- status transitions
- pause and waiting-parts handling
- batching / quick-lane execution logic
- utilization dashboards
- payment close control hooks

**Acceptance bar**
- work moves through workshop digitally
- assignments respect skill and bay fit
- manager can see bottlenecks by technician / bay / status

---

### Phase 3 — Parts Readiness & Transfer
**Must-have**
- parts requests
- critical parts flags
- reservation workflow
- transfer workflow
- receiving workflow
- parts-ready status
- blocked-by-parts handling
- next-day preparation dashboard

**Acceptance bar**
- parts-driven delays become visible before customer promise is missed
- scheduler treats parts readiness as real eligibility data

---

### Phase 4 — Notifications & Transport
**Must-have**
- reminder jobs
- confirmation / cancellation links if approved
- delay alerts
- ready-for-pickup notices
- transport eligibility checks
- transport request board
- driver assignment and completion tracking

**Acceptance bar**
- customer communication is proactive
- transport adds convenience without destabilizing operations

---

### Phase 5 — Analytics & Optimization
**Must-have**
- dashboard maturation
- recurring maintenance outreach logic
- demand trend views
- candidate predictive models for no-show and duration
- optimization suggestions

**Acceptance bar**
- insights are explainable and trusted
- predictive logic is optional, measurable, and not embedded blindly in the core

---

## 4. Pilot Strategy

### Recommended rollout
1. one site
2. limited staff cohort
3. real queue board in production
4. shadow-mode reporting for 1–2 weeks
5. tune rules
6. expand to full team

### Pilot success checks
- check-in speed improved
- queue disputes reduced
- manual overrides acceptable and traceable
- appointment handling stable
- no major blocked-by-parts surprise in phase 3 pilot

---

## 5. Release Governance

Each phase requires:
- feature acceptance checklist
- scenario test pass
- training notes
- rollback consideration
- metrics collection plan
- open issues log

No phase should be considered complete because code exists.
It is complete when operations can trust it.
