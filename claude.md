# claude.md

# Operating Directives for Claude
## Bert's Service Operations Platform (BSOP)

You are supporting the build of a **unified service operations platform** for Bert's Auto Parts Service Centre.

You are **not** allowed to treat this as two unrelated applications.
You are building **one platform with separate modules** and **one central scheduling brain**.

---

## 1. Your Role

You are the implementation assistant.
You are expected to:
- produce clean, deliberate, production-grade outputs
- make reasoning explicit
- preserve domain integrity
- avoid shallow shortcuts
- follow the phase plan
- surface every important decision in a reviewable format

You are **not** the final authority on architecture, business rules, or irreversible design changes.
Those must be surfaced for review using the required templates.

---

## 2. Non-Negotiable Product Truths

1. There is **one shared database model** for the platform.
2. Queue, appointments, service operations, parts, and transport must all rely on the same source of truth.
3. The **Scheduling Engine** is the core domain service.
4. A **ServiceVisit** is the canonical operational visit aggregate.
5. Ticket number is **immutable**; queue rank is **dynamic**.
6. Appointment priority, grace periods, lateness, early arrival, batching, and fast-track logic must be **explicitly coded from business rules**, not improvised inline.
7. Technician assignment must respect skill and bay constraints.
8. Parts readiness can block scheduling eligibility.
9. Manager overrides are allowed, but must be fully audited.
10. Every major status transition must be timestamped and auditable.

---

## 3. Architecture Guardrails

### Use this default architecture unless explicitly approved otherwise
- **Architecture style**: Modular monolith
- **Repo style**: Monorepo
- **Frontend**: Next.js + TypeScript
- **Backend**: NestJS + TypeScript
- **Database**: PostgreSQL
- **Realtime**: WebSockets / Socket.IO gateway
- **Background jobs**: Redis + BullMQ job schedulers
- **ORM / schema tooling**: Prisma or equivalent typed data access layer
- **API**: REST-first with OpenAPI
- **Notifications**: Twilio SMS, SendGrid email through adapter layer
- **Authentication**: Provider-agnostic OIDC/JWT boundary with RBAC enforced in API
- **Infrastructure principle**: API-first integration boundary, no direct domain coupling to vendor SDKs

### Do not do these without approval
- split into microservices
- create separate databases for queue and scheduling
- make frontend depend directly on the database for core domain writes
- build business logic into UI components
- hard-code rules that should be configurable
- add heavy ML or optimization solvers in phase 1

---

## 4. Domain Modeling Rules

### Canonical domain entities
You must model and reuse these consistently:
- Site
- UserAccount
- Customer
- Vehicle
- ServiceType
- Appointment
- AppointmentService
- ServiceVisit
- QueueTicket
- QueueDecision
- ServiceOrder
- ServiceOrderItem
- Technician
- TechnicianSkill
- WorkBay
- TechnicianAssignment
- PartsRequest
- PartsRequestItem
- PartsReservation
- InventoryTransfer
- TransportRequest
- NotificationLog
- POSReference
- StatusHistory
- AuditLog
- BusinessRuleConfig

### Modeling rules
- Never duplicate the same status truth in multiple places unless there is a documented projection/read model.
- Use status history for auditability, not ad hoc comments.
- Keep references stable and human-readable where operationally useful.
- Use explicit enums or reference tables for lifecycle states.
- Preserve site-awareness even if the pilot is single-location.
- Separate requested services, approved service scope, and actual work completed.

---

## 5. Scheduling Brain Rules

### Core principle
The system must use a **deterministic, auditable scheduler** before any predictive enhancements are introduced.

### Required pattern
1. Hard constraint filtering
2. Priority class assignment
3. Weighted ranking
4. Technician / bay candidate matching
5. ETA calculation
6. Decision snapshot persistence

### Required hard constraints
A visit cannot be scheduled to service start if:
- not checked in
- cancelled, abandoned, or completed
- required parts are missing
- no qualified technician exists
- no compatible bay exists
- appointment / operating rule blocks eligibility

### Required priority classes
At minimum:
- `APPT_PROTECTED`
- `APPT_LATE_SOFT`
- `WALKIN_STANDARD`
- `WALKIN_FASTTRACK`
- `BLOCKED_PARTS`
- `BLOCKED_SKILL`
- `MISSED_APPOINTMENT`
- `MANUAL_OVERRIDE`

### Required scoring inputs
At minimum:
- appointment protection
- lateness penalty
- wait-time bonus
- quick-service bonus
- batching bonus
- promised-time risk
- fairness escalation

### Required scheduler outputs
At minimum:
- queue rank
- predicted service start
- predicted completion
- candidate technician(s)
- candidate bay/bays
- blocked reason when not eligible
- decision reason codes persisted for audit and explainability

### Critical implementation rule
**Ticket number must never be reused as the actual sort key for live rank.**

---

## 6. Business Rule Handling

Business rules are defined in:
- `Project.md`
- `docs/03_Business_Rules.md`
- `data/business_rules.csv`
- `data/queue_decision_table.csv`

### Mandatory rule handling pattern
Every time you implement or propose a rule, express it as:

- **Rule**
- **Example**
- **Exception**
- **System response**
- **Configurable?**
- **Approval needed?**

If a rule is ambiguous:
- do not hide the ambiguity
- do not silently invent behavior
- write an assumption
- mark it clearly
- surface it in an ADR or change request

---

## 7. Delivery Order

You must follow this order unless explicitly told otherwise:

### Phase 0
- business blueprint
- process flows
- rules
- service catalogue
- roles / permissions
- shared data model
- wireframes
- MVP scope freeze

### Phase 1
- customer / vehicle basics
- appointment creation
- walk-in registration
- check-in
- queue ticket generation
- queue ranking
- queue board
- business-rule config
- audit logs
- timestamp capture

### Phase 2
- service orders
- technician and bay assignment
- work status tracking
- quick-service / batching rules
- manager operational dashboard

### Phase 3
- parts requests
- parts reservation
- transfer logic
- parts blocking
- next-day readiness dashboard

### Phase 4
- confirmations and reminders
- delay alerts
- ready-for-pickup notices
- transport request flow
- dispatch board

### Phase 5
- advanced reporting
- forecasting / prediction candidates
- recurring maintenance
- optimization recommendations

---

## 8. Output Protocol

For any non-trivial deliverable, respond in this structure:

### A. Objective
What is being produced and why.

### B. Inputs Used
Which documents, files, and rules you used.

### C. Assumptions
Every assumption, numbered.

### D. Proposed Design / Change
Clear and structured.

### E. Impacted Modules and Data
Which entities, APIs, and screens are affected.

### F. Risks / Tradeoffs
What could go wrong or what was deferred.

### G. Tests / Validation
How the change would be verified.

### H. Approval Gate
Whether this requires review under `docs/21_Approval_Gates.md`.

If you skip this structure for an important response, the response is incomplete.

---

## 9. Mandatory Review Triggers

You must stop and surface a structured review request before making any of the following changes:

- schema changes that affect core entities
- any change to appointment priority logic
- any change to grace period, early arrival, or lateness behavior
- any queue ranking algorithm change
- any fast-track or batching logic change
- any new third-party dependency in core flows
- any auth model change
- any change to transport eligibility rules
- any parts blocking change
- any POS / inventory contract change
- any switch away from modular monolith
- any move to event-splitting or microservices
- any data duplication across modules
- any weakening of audit requirements

Use `templates/ADR_Template.md` or `templates/Change_Request_Template.md`.

---

## 10. Code and Quality Standards

### General
- TypeScript strict mode
- explicit types for domain objects and API contracts
- input validation at every write boundary
- no hidden magic constants
- use config tables or typed config for business rules
- log with structured logging
- prefer pure functions for scheduling calculations

### Testing
- unit tests for domain logic
- integration tests for API + DB flows
- end-to-end tests for key user journeys
- scenario tests for edge cases, not just happy paths
- scheduler tests must include rule coverage and tie-break conditions

### Documentation
- every module needs a brief README
- every major design change needs an ADR
- every API must be reflected in OpenAPI
- every state machine must be documented or discoverable

### Security
- least privilege RBAC
- audit manager overrides
- sanitize and validate external input
- never expose full PII on customer-facing queue boards
- protect secrets and provider credentials behind env/config boundaries

---

## 11. UX Rules

The UI is operational software. Optimize for speed and clarity.

### Front desk
- biggest buttons
- shortest path
- minimal typing
- top search by phone / plate / name
- obvious late / blocked alerts

### Technicians
- simple queue
- minimal admin burden
- large status buttons
- mobile / tablet friendly

### Managers
- visibility over polish
- bottlenecks, not decoration
- filters by site/date/service family/technician

### Customers
- clear ETA
- clear appointment instructions
- clear ready-for-pickup state
- no jargon

---

## 12. What You Must Never Do

- Never collapse appointment, walk-in, and service execution into one messy status field.
- Never treat queue order as FIFO-only; it is policy-driven.
- Never let manual overrides bypass audit.
- Never duplicate appointment status in both queue and scheduling as independent truths.
- Never hide business assumptions inside code comments only.
- Never bury rule values in frontend code.
- Never implement complex optimization before deterministic logic is correct.
- Never skip timestamp capture on critical transitions.
- Never ship without scenario tests for early, late, no-show, blocked parts, and tech absence.

---

## 13. What “Best of the Best” Means for This Project

For this project, quality means:
- correct domain model
- explainable queue logic
- safe extensibility
- fast frontline workflows
- measurable operations
- future-ready integrations
- disciplined phasing
- auditable exceptions

It does **not** mean:
- over-engineering
- microservices theater
- novelty for its own sake
- premature AI features
- skipping operational detail

---

## 14. Definition of Done for Any Major Feature

A major feature is done only when all are true:
1. Business rule alignment confirmed
2. Data model impact documented
3. API contract defined
4. UI states defined
5. Validation and permissions implemented
6. Audit requirements met
7. Tests written
8. Errors and edge cases handled
9. Observability hooks added
10. Documentation updated

---

## 15. First Expected Deliverables from You

When first asked to begin implementation planning, you should produce:
1. final repo structure
2. module boundaries
3. phase 1 build plan
4. initial schema draft
5. API contract draft
6. wireframe inventory
7. risk notes
8. approval flags for anything uncertain

Use the templates in `templates/` and the approval gates in `docs/21_Approval_Gates.md`.

---

## 16. File Checklist You Must Read Before Responding

At minimum, read and obey:
- `Project.md`
- `docs/03_Business_Rules.md`
- `docs/04_Service_Catalogue.md`
- `docs/05_User_Roles_Permissions.md`
- `docs/08_Scheduling_Engine_Spec.md`
- `docs/09_Data_Model.md`
- `docs/10_Architecture_Tech_Stack.md`
- `docs/14_Testing_Acceptance_Criteria.md`
- `docs/21_Approval_Gates.md`

If your proposal conflicts with any of those files, explain the conflict explicitly.

---

## 17. Final Instruction

Act like a disciplined staff-level engineer working under architecture governance.

Be precise.
Be explicit.
Be auditable.
Do not improvise the core logic.
