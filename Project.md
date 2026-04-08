# Project.md

# Bert's Service Operations Platform (BSOP)

## 1. Product Statement

Bert's Auto Parts Service Centre needs a **single unified service platform** that manages the full service lifecycle instead of two disconnected systems.

The platform must combine:

- customer appointments
- walk-in intake
- queue numbering and live queue transparency
- technician and bay assignment
- service order tracking
- parts reservation and transfer logistics
- customer notifications
- customer transport coordination
- reporting and operational intelligence

This is **not** just a queue application.

This is a **service operations platform** with one scheduling engine at its core.

## 2. North Star

> **One scheduling brain, many modules, one shared truth.**

Every major decision must protect:
1. fairness for customers
2. operational clarity for staff
3. high utilization of technicians and bays
4. auditability of every important action
5. future integration with POS, inventory, and customer communication channels

## 3. Business Goals

### Primary goals
- Fair and transparent customer numbering
- Unified management of walk-ins and appointments
- Reduce customer wait times by **40%**
- Increase servicing frequency by **35%**
- Reduce service completion time by **25%** through parts readiness
- Increase daily service capacity by **40%**
- Achieve **95% customer satisfaction**
- Eliminate service delays caused by parts unavailability

### Secondary goals
- Reduce no-show rate by **60%**
- Achieve **85–90% technician utilization**
- Support SMS / email notifications
- Support customer drop-off and pickup logistics
- Enable future mobile / remote queue visibility
- Generate management-ready reporting from day one

## 4. Product Scope

### In scope
- Appointment booking and slot management
- Walk-in registration and check-in
- Unified queue ticket generation
- Dynamic queue ranking
- Live queue board
- Service order / job card flow
- Technician and bay assignment
- Parts requests, reservation, and transfer tracking
- Customer transport requests
- Notification workflows
- KPI dashboards and exportable reporting
- RBAC, audit, configuration, and operational governance

### Out of scope for initial release
- Full native mobile apps
- Full route optimization for multi-stop driver dispatch
- AI-based diagnostics
- Deep supplier procurement automation
- Advanced loyalty / CRM / fleet contract billing
- Direct payment processing replacement for POS
- Multi-location balancing beyond pilot readiness

## 5. Product Principles

1. **Single shared operational model**  
   Queue, scheduling, service execution, parts, and transport all depend on the same operational visit truth.

2. **Immutable identifiers, dynamic ranking**  
   Ticket numbers do not change. Queue rank can change. This prevents chaos and broken references.

3. **Deterministic scheduling first**  
   The first production version should use explicit rules and auditable heuristics, not black-box ML.

4. **Human override, but always audited**  
   Managers can intervene. The system must record why.

5. **Staff speed beats decorative UI**  
   Front desk screens must optimize for rapid execution under pressure.

6. **Design for integrations early**  
   No hard-coding to the current POS or inventory tool.

7. **Capture timestamps from day one**  
   Reporting quality depends on timestamp discipline.

## 6. Canonical Operating Model

The most important modeling decision is this:

### Canonical aggregate: `ServiceVisit`

A **ServiceVisit** is the operational truth for a customer/vehicle service encounter.

It may originate from:
- a scheduled appointment
- a walk-in visit

It becomes the parent context for:
- queue ticket
- service order
- technician assignment
- parts activity
- transport activity
- notifications
- status history

This avoids duplicate status fields spread across separate queue and scheduling records.

## 7. Major Modules

### Module A — Customer Intake & Queue
- walk-in registration
- appointment check-in
- queue ticket generation
- queue board
- ETA updates
- current status visibility

### Module B — Scheduling Engine (core)
- slot generation
- service duration modeling
- appointment priority handling
- dynamic ranking
- technician / bay matching
- resequencing and ETA recomputation

### Module C — Service Operations
- job card / service order
- advisor review
- technician assignment
- progress statuses
- completion and QC

### Module D — Parts & Logistics
- parts requirement capture
- reservation / staging
- transfer requests
- parts-ready flags
- blocked-by-parts logic

### Module E — Notifications & Communication
- confirmations
- reminders
- late / delay alerts
- ready-for-pickup notices
- manual resend tools

### Module F — Reporting & BI
- wait times
- utilization
- no-shows
- parts-related delays
- transport performance
- customer satisfaction

### Cross-cutting Module G — Administration & Governance
- RBAC
- settings
- business rules configuration
- audit logs
- templates
- operating hours

## 8. Critical Business Rules

The complete catalogue is in `docs/03_Business_Rules.md`, but the platform must always preserve these rules:

- Appointments get priority over walk-ins when eligible.
- Grace period for late arrivals = configurable, default **15 minutes**.
- Arrivals more than **30 minutes early** are treated as walk-ins until their protection window opens.
- Multiple same-day services for the same customer/vehicle = **single active queue position**.
- Quick services may be fast-tracked only when they do not materially break promised appointment fairness.
- Complex repairs require qualified technicians.
- Parts-dependent services cannot move into service start without parts readiness or explicit override.
- Customer transport is an eligibility-driven convenience feature, not a default entitlement.
- Every override must be auditable.

## 9. Queue Numbering Strategy

### Recommended pattern
- **Internal immutable ticket ID**: `QTK-<SITE>-<YYYYMMDD>-<SEQUENCE>`
- **Customer-facing display token**: short sequence or masked token for queue board use

### Important design rule
**Ticket number is not queue rank.**

Why:
- rank can change when parts become ready
- rank can change when a specialist becomes available
- rank can change when a protected appointment checks in
- rank can change after an approved manual override

If the number itself represented rank, every resequence would create confusion.

## 10. Scheduling Engine Strategy

The engine should use a **two-stage model**:

### Stage 1 — Hard constraint filtering
A visit is eligible only if:
- checked in
- not cancelled / abandoned / completed
- required parts ready, unless exception
- required skill available
- compatible bay exists
- visit is within valid business / appointment policy window

### Stage 2 — Weighted operational ranking
Rank eligible items using:
- appointment protection class
- lateness penalty
- waiting time
- quick-service bonus
- batching bonus
- promised-time risk
- fairness escalation
- manager override flags

This preserves both fairness and operational efficiency.

## 11. Phase Plan

### Phase 0 — Discovery & Design
- future-state process model
- business rules sign-off
- shared data model
- service catalogue
- wireframes
- MVP scope freeze

### Phase 1 — Core Scheduling & Queue
- appointments
- walk-ins
- check-in
- queue tickets
- queue board
- basic service order tracking
- business-rule configuration
- audit logging
- reporting foundations

### Phase 2 — Technician & Service Operations
- technician assignment
- bay matching
- progress statuses
- batching rules
- utilization reporting
- payment close controls

### Phase 3 — Parts Readiness & Transfer
- parts requests
- reservation
- transfers
- parts-ready blocking
- next-day preparation workflows

### Phase 4 — Notifications & Transport
- reminders
- confirmations
- delay alerts
- ready-for-pickup notices
- drop-off / pickup coordination

### Phase 5 — Analytics & Optimization
- demand trends
- recurring maintenance
- no-show reduction logic
- duration model refinement
- optimization recommendations

## 12. Technical Direction

### Recommended implementation model
- **Architecture**: modular monolith
- **Frontend**: Next.js + TypeScript
- **Backend**: NestJS + TypeScript
- **Database**: PostgreSQL
- **Realtime**: WebSocket gateway with room-based broadcasts
- **Jobs / scheduling**: Redis-backed worker queue
- **Notifications**: Twilio + SendGrid
- **Auth**: provider-agnostic OIDC/JWT boundary with RBAC in API
- **API**: REST-first with OpenAPI and event/webhook support
- **Repo**: monorepo

Rationale:
- simpler than microservices for an early operational system
- keeps business logic in one place
- supports real-time updates and integration growth
- easier to test and reason about than split systems

## 13. Definition of Success

The platform is successful when:
- queue order is explainable at any moment
- check-in is fast and predictable
- appointment handling is consistent
- technicians spend more time in productive work
- parts delays become visible before they hurt the day
- transport adds convenience instead of chaos
- managers can measure performance from reliable timestamps
- the system can pilot in one location and scale without redesign

## 14. Non-Negotiables for Claude

Claude must not:
- split queue and scheduling into separate truth stores
- use ticket number as the live rank
- bypass audit trails for overrides
- hard-code POS assumptions into core domain logic
- start with microservices
- skip discovery artifacts and jump straight into coding
- invent business rules without marking them as assumptions
- produce undocumented schema changes

Claude must:
- follow `claude.md`
- respect the approval gates in `docs/21_Approval_Gates.md`
- use the templates in `templates/`
- build phase-by-phase
- keep the scheduling engine central to all modules

## 15. Required Deliverables in this pack

- Process flow diagrams
- Business rules document
- Service types catalogue
- Roles and permissions matrix
- KPI list
- Scheduling engine specification
- Shared data model
- API outline
- SQL schema outline
- UX spec
- Testing and acceptance criteria
- Risk register
- Backlog
- Approval and change templates

## 16. Immediate Next Action

Give Claude:
1. `Project.md`
2. `claude.md`
3. `docs/03_Business_Rules.md`
4. `docs/08_Scheduling_Engine_Spec.md`
5. `docs/09_Data_Model.md`
6. `docs/21_Approval_Gates.md`

Then require Claude to respond with:
- the proposed repo structure
- the phase 1 implementation plan
- the initial database schema draft
- the API contract draft
- the wireframe plan

Use the provided templates so every major decision is reviewable.

## 17. File Map

| file | purpose |
| --- | --- |
| Project.md | Master product requirements document and executive blueprint. |
| claude.md | Hard directives, architecture guardrails, delivery protocol, and approval gates for Claude. |
| docs/00_Assumptions_Open_Questions.md | Explicit assumptions, dependencies, and unanswered business decisions. |
| docs/01_Business_Blueprint.md | Operating model, service journey, and future-state process narrative. |
| docs/02_Process_Flows.md | Mermaid process flow diagrams for service, queue, parts, and transport. |
| docs/03_Business_Rules.md | Formal rule catalogue with rule / example / exception / system response format. |
| docs/04_Service_Catalogue.md | Service types, durations, skills, bay types, and eligibility rules. |
| docs/05_User_Roles_Permissions.md | Role definitions, responsibilities, and permissions matrix. |
| docs/06_Modules_Scope.md | Module decomposition, boundaries, dependencies, and out-of-scope items. |
| docs/07_Phased_Delivery_Plan.md | Phase-by-phase delivery sequence, scope, exit gates, and rollout plan. |
| docs/08_Scheduling_Engine_Spec.md | Core queue/scheduling brain, scoring model, pseudocode, and decision table. |
| docs/09_Data_Model.md | Shared domain model, entity relationships, status lifecycles, and data integrity rules. |

See `README.md` for the full map.
