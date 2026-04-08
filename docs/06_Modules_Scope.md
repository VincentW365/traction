# 06_Modules_Scope.md

## Purpose

Break the unified platform into manageable modules while preserving one operational truth.

---

## 1. Module Map

### Module A — Customer Intake & Queue
**Purpose:** Create and activate service visits and keep customers/staff informed about place and status.

**Capabilities**
- customer search / create
- vehicle search / create
- walk-in registration
- appointment lookup
- check-in
- queue ticket generation
- live queue board
- ETA display
- customer status view

**Phase**
- Phase 1

**Dependencies**
- customer / vehicle data
- scheduling engine
- business rules configuration

---

### Module B — Scheduling Engine
**Purpose:** Central decision service for slot validity, visit ranking, ETA, and resource-aware sequencing.

**Capabilities**
- slot generation
- hard constraint checks
- appointment priority logic
- lateness / early-arrival handling
- dynamic queue ranking
- quick-service fast-track logic
- batching logic
- ETA recomputation
- technician / bay candidate selection

**Phase**
- Foundation in Phase 1, extended in Phase 2 and Phase 3

**Dependencies**
- service catalogue
- technician skills
- bay inventory
- parts readiness
- business rules configuration

---

### Module C — Service Operations
**Purpose:** Convert queued demand into executed work.

**Capabilities**
- service order / job card
- service scope approval
- technician assignment
- bay assignment
- work status updates
- pause / waiting parts
- QC state
- ready-for-invoice / close state

**Phase**
- Phase 2

**Dependencies**
- scheduling engine
- technician and bay data
- parts module
- POS integration layer

---

### Module D — Parts & Logistics
**Purpose:** Make parts availability visible before it becomes a workshop delay.

**Capabilities**
- parts request generation
- parts reservation
- shortages and blocking
- transfer request creation
- transfer ETA tracking
- parts-ready flags
- next-day prep dashboard

**Phase**
- Phase 3

**Dependencies**
- service orders
- inventory integration
- scheduling engine

---

### Module E — Notifications & Communication
**Purpose:** Keep customers informed and reduce no-shows and uncertainty.

**Capabilities**
- booking confirmation
- reminder jobs
- delay alerts
- ready-for-pickup notices
- manual resend
- delivery logging
- communication preferences

**Phase**
- Basic confirmation in Phase 1, full communication in Phase 4

**Dependencies**
- appointments
- service visits
- service completion status
- provider adapters

---

### Module F — Reporting & BI
**Purpose:** Turn operational events into measurable performance.

**Capabilities**
- KPI dashboards
- exports
- time-based analytics
- no-show monitoring
- utilization reporting
- parts delay analysis
- recurring maintenance opportunity lists

**Phase**
- Foundations in Phase 1, richer dashboards in Phase 2–5

**Dependencies**
- disciplined timestamps
- audit and status history
- clean service catalogue and entity status model

---

### Cross-Cutting Module G — Administration & Governance
**Purpose:** Keep the platform safe, configurable, and operable.

**Capabilities**
- RBAC
- user management
- business-rule configuration
- service catalogue maintenance
- operating hours
- notification templates
- audit log viewer
- site configuration

**Phase**
- Phase 1 foundation

---

## 2. Dependency Order

The dependency spine is:

`Administration / Config`  
→ `Customer / Vehicle`  
→ `Scheduling Engine`  
→ `Intake & Queue`  
→ `Service Operations`  
→ `Parts & Logistics`  
→ `Notifications`  
→ `Reporting`

This means the Scheduling Engine is not “just another module.”
It is the **center of gravity** for the platform.

---

## 3. What Must Not Be Split

Do **not** split these truths across separate modules:

- appointment lifecycle truth
- service visit lifecycle truth
- queue ticket ownership
- service order status truth
- technician assignment truth
- parts-ready truth
- transport request truth

Read models can exist, but ownership must stay singular.

---

## 4. Scope Discipline Rules

### Phase 1 must include
- appointment creation
- walk-in creation
- check-in
- ticketing
- queue board
- rules configuration for core timing policies
- audit and timestamps

### Phase 1 must not try to perfect
- advanced dispatch optimization
- route planning
- predictive no-show models
- complex CRM features
- deep supplier automation

### Module boundary rule
When a feature touches more than one module, keep:
- ownership clear
- APIs explicit
- duplicated data avoided
- shared identifiers stable

---

## 5. Recommended “Do Not Build Yet” List

Defer these until the core flows are stable:

- native driver navigation app
- geo-fencing remote check-in
- AI voice assistant
- algorithmic route optimization
- full fleet billing
- deep marketing automation
- warranty claim automation
- machine-learning ETA prediction

---

## 6. Module Completion Criteria

A module is not complete until:
1. business rules are mapped
2. statuses are defined
3. API surface exists
4. role-based UI exists
5. audit requirements are met
6. tests exist for happy + edge cases
7. operational metrics are captured
