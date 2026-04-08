# 12_UI_UX_Spec.md

## Purpose

Define the interaction design priorities for the platform.

This is operational software.
The main UX job is to reduce confusion and time waste under pressure.

---

## 1. UX Principles

### P1. Speed for frontline staff
Common actions should be possible in very few clicks.
Front desk staff should not have to hunt for controls.

### P2. Clear state over pretty state
Users must always see:
- what status a visit is in
- whether it is blocked
- what is expected next
- who owns the next action

### P3. High visibility of exceptions
Late arrivals, blocked parts, missing skills, and manual overrides should stand out immediately.

### P4. Role-shaped interfaces
Do not make staff dig through irrelevant screens.
Every role should see what matters most to them.

### P5. Mobile-friendly where needed
Customers and technicians may use smaller screens.
The front desk may use desktop or tablet.
Design responsively from the start.

### P6. Accessible status cues
Never rely on color alone.
Color + label + icon where appropriate.

---

## 2. Screen Inventory

| screen | primary_users | purpose | phase |
| --- | --- | --- | --- |
| Customer Booking Page | Customer, Front Desk | Create appointment, choose service, see valid slots, receive confirmation. | 1 |
| Front Desk Check-In | Front Desk / Cashier | Find customer/vehicle, apply arrival rules, issue ticket, show ETA. | 1 |
| Live Queue Board | Front Desk, Customers, Manager | Show current queue, now-serving, blocked reasons, ETA. | 1 |
| Schedule Planner | Service Advisor, Manager | View slots, book/reschedule, inspect capacity and constraints. | 1 |
| Service Order Workbench | Service Advisor | Approve scope, set promise time, assign tech/bay, monitor status. | 2 |
| Technician Work Queue | Technician | See assigned jobs, start/pause/complete work, raise parts needs. | 2 |
| Parts Readiness Dashboard | Parts / Store Staff | See upcoming jobs needing parts, reserve, transfer, receive. | 3 |
| Transport Dispatch Board | Transport Coordinator | Manage drop-off/pickup requests, driver assignment, time windows. | 4 |
| Manager Dashboard | Manager | View KPIs, bottlenecks, fairness alerts, overrides, and live operations. | 2+ |
| Admin Settings Panel | Admin, Manager | Manage roles, rules, operating hours, templates, service durations. | 1 |

---

## 3. Detailed Screen Guidance

### Customer Booking Page
Must show:
- service selection
- available time slots only
- clear duration expectations
- customer and vehicle entry
- confirmation success
- appointment instructions

Should avoid:
- too many optional fields up front
- exposing internal workshop complexity

---

### Front Desk Check-In
Must show:
- search by phone, plate, name
- appointment lookup
- walk-in register action
- arrival rule result (early / on-time / late)
- ticket number
- ETA
- visible blocked or special conditions

Must optimize for:
- minimal typing
- fast repeat-customer lookup
- large actionable buttons

Target:
- routine check-in in under 60 seconds

---

### Live Queue Board
Must show:
- ticket or safe identifier
- current rank / now-serving state
- ETA or wait estimate
- service state
- blocked reason if relevant
- possibly separate quick-lane area if used

Must not show:
- full customer names publicly
- confusing reordering without explanation in internal view

---

### Schedule Planner
Must show:
- day / week view
- available slots
- constrained slots hidden or marked unavailable
- technician / bay capacity summary
- parts risk indicator where known
- late / no-show handling controls

---

### Service Order Workbench
Must show:
- visit context
- requested services
- approved scope
- parts readiness
- technician and bay assignment
- promised time
- current status history

Must support:
- easy scope edits before work begins
- auditable changes after work approval

---

### Technician Work Queue
Must show:
- my jobs
- next jobs
- required service items
- start / pause / waiting parts / complete actions
- notes or escalation path
- simple timers or timestamps

Must avoid:
- dense admin fields
- finance clutter
- schedule editing powers

---

### Parts Dashboard
Must show:
- today and next-day parts demand
- critical shortages
- transfer ETAs
- blocked jobs
- ready flags
- substitution requests needing approval

---

### Manager Dashboard
Must show:
- live queue
- wait-time trend
- no-show count
- late arrivals
- technician utilization
- bay utilization
- parts delay hotspots
- manual override log
- fairness alerts

Managers need visibility first, aesthetics second.

---

## 4. Core Interaction Patterns

### Pattern A — Fast search
Support:
- phone number
- license plate
- customer name
- ticket number

### Pattern B — Status badges
Use explicit labels such as:
- Checked In
- Waiting
- Blocked: Parts
- Blocked: Skill
- Called
- In Service
- QC
- Ready for Pickup

### Pattern C — Action clustering
Group actions by decision stage:
- arrival actions
- assignment actions
- status actions
- closure actions

### Pattern D — Exception banners
Use strong visual banners for:
- late arrival
- no qualified tech
- missing critical parts
- overdue wait time
- payment hold
- manual override active

---

## 5. Suggested Responsive Priorities

### Desktop priority
- front desk
- schedule planner
- manager dashboard
- parts dashboard

### Tablet priority
- technician queue
- queue board control
- transport dispatch

### Mobile priority
- customer booking / status
- technician minimal updates if needed
- driver confirmation pages later

---

## 6. UX Acceptance Criteria

A screen is not done unless:
1. primary user can complete core task quickly
2. status is unambiguous
3. blocked conditions are visible
4. permissions are respected
5. keyboard / touch workflow is considered
6. edge cases have UI states
7. error messages are actionable

---

## 7. Suggested Wireframe Order

1. Front Desk Check-In
2. Live Queue Board
3. Schedule Planner
4. Technician Work Queue
5. Service Order Workbench
6. Parts Readiness Dashboard
7. Manager Dashboard
8. Transport Dispatch Board
9. Customer Booking Page
10. Admin Settings Panel

The front desk flow should be designed first because it is the gateway into the whole system.
