# 11_API_Contracts_Integrations.md

## Purpose

This document defines the API surface and integration approach for the unified platform.

The machine-readable starter contract lives in:
- `api/openapi-outline.yaml`

---

## 1. API Design Principles

1. REST-first for domain operations and admin flows
2. WebSockets for live boards and real-time status
3. Explicit workflow endpoints for state changes
4. Idempotency for external-facing or retry-prone actions
5. Stable identifiers across integrations
6. Clear separation between internal domain actions and external vendor adapters

---

## 2. Endpoint Inventory

| tag | method | path | purpose |
| --- | --- | --- | --- |
| Customers | POST | /customers | Create customer |
| Customers | GET | /customers | Search customers by phone, plate-linked owner, name |
| Vehicles | POST | /vehicles | Create vehicle |
| Vehicles | GET | /vehicles | Search vehicles by plate, VIN, customer |
| Appointments | POST | /appointments | Create appointment |
| Appointments | PATCH | /appointments/{id} | Update / reschedule appointment |
| Appointments | POST | /appointments/{id}/confirm | Confirm appointment |
| Appointments | POST | /appointments/{id}/cancel | Cancel appointment |
| Check-In | POST | /appointments/{id}/check-in | Check in appointment and activate service visit |
| WalkIns | POST | /walk-ins | Create walk-in service visit and ticket |
| Queue | GET | /queue/board | Read live queue board |
| Queue | POST | /queue/recompute | Trigger recomputation (privileged/internal) |
| Queue | POST | /queue-tickets/{id}/override | Manager override with reason |
| Service Orders | POST | /service-orders | Create service order |
| Service Orders | PATCH | /service-orders/{id} | Update scope / promised time |
| Service Orders | POST | /service-orders/{id}/assign | Assign technician and bay |
| Service Orders | POST | /service-orders/{id}/status | Advance or change service status |
| Parts | POST | /parts-requests | Create parts request |
| Parts | POST | /parts-requests/{id}/reserve | Reserve parts |
| Parts | POST | /inventory-transfers | Create transfer |
| Parts | POST | /inventory-transfers/{id}/receive | Receive transfer |
| Transport | POST | /transport-requests | Create transport request |
| Transport | POST | /transport-requests/{id}/assign-driver | Assign driver |
| Transport | POST | /transport-requests/{id}/status | Advance transport status |
| Notifications | POST | /notifications/send-test | Admin/provider test |
| Reports | GET | /reports/kpis | Read KPI dashboard data |
| Config | GET | /config/business-rules | Read rule config |
| Config | PATCH | /config/business-rules/{key} | Update rule config |
| Audit | GET | /audit-logs | Read auditable changes |

---

## 3. API Boundary Rules

### Prefer explicit workflow endpoints
Examples:
- `/appointments/{id}/check-in`
- `/service-orders/{id}/assign`
- `/parts-requests/{id}/reserve`
- `/transport-requests/{id}/assign-driver`

This is better than vague “update everything” endpoints for operational workflows.

### Validate at write boundaries
Every write should validate:
- role permissions
- current state transition validity
- site context
- required fields
- concurrency / duplicate protection

### Keep command and query concerns explicit
Heavy dashboard queries should not pollute transaction-heavy command handlers.

---

## 4. WebSocket Channels

| channel | payload | consumers |
| --- | --- | --- |
| queue:site:{siteId} | board rows, rank changes, now-serving updates | front desk, public board, manager |
| visit:{serviceVisitId} | status, ETA, blocked reasons | customer view, advisor, manager |
| technician:site:{siteId} | my-work and assignment updates | technicians, advisors |
| parts:site:{siteId} | parts-ready, shortages, transfer status | parts staff, advisors, manager |
| transport:site:{siteId} | dispatch board updates | transport coordinator, manager |

### Realtime rules
- every event should be purposeful, not raw DB noise
- payloads should be small and relevant
- client boards can refetch details if needed
- multi-site rooms should stay isolated

---

## 5. Integration Event Catalogue

| event | direction | action |
| --- | --- | --- |
| appointment.confirmed | internal -> notification | send confirmation SMS/email |
| visit.checked_in | internal -> scheduler | recompute rank and ETA |
| parts.ready | internal -> scheduler | recompute blocked visit eligibility |
| service.delay_detected | internal -> notification | send delay alert |
| service.ready_for_pickup | internal -> transport/notification | trigger pickup coordination |
| payment.posted | POS -> platform | mark order payment-cleared |
| inventory.reservation_updated | Inventory -> platform | update parts request / readiness |

---

## 6. Integration Layer Strategy

### External systems expected
- POS / billing
- inventory / stock
- SMS
- email
- possibly payment gateway later
- optional CRM or WhatsApp later

### Adapter pattern
Each integration should use:
- provider adapter interface
- outbound job queue
- idempotency key
- provider reference tracking
- retry + dead-letter handling

### Why this matters
It keeps core domain logic clean and makes vendor swaps or partial rollouts much easier.

---

## 7. POS Integration Guidance

### Recommended data exchanged
Outbound to POS:
- service order reference
- amount if needed
- invoice request / close request
- customer and vehicle identifiers where allowed

Inbound from POS:
- invoice created
- payment posted
- payment failed / reversed
- account exception or on-account approval

### Design rule
The platform should **integrate with** POS, not become a hidden POS replacement in phase 1.

---

## 8. Inventory Integration Guidance

### Recommended data exchanged
Outbound:
- stock check request
- reserve part
- release reservation
- transfer request
- transfer receive confirmation

Inbound:
- stock availability changed
- reservation confirmed
- transfer shipped
- transfer delayed
- transfer received

### Design rule
If inventory integration is not fully available in phase 3, support manual status update with audit.

---

## 9. Notification Integration Guidance

### Channels
- SMS
- email
- optional WhatsApp later

### Required features
- queue or job scheduler-based delivery
- template keys
- delivery status logging
- retry handling
- customer preference / opt-out respect

### Important rule
A failed notification must not break the core operational transaction.

---

## 10. API Versioning and Stability

### Recommendation
- start with `/api/v1`
- version only when a contract materially changes
- keep domain DTOs explicit and stable
- avoid leaking internal database shape directly to clients

---

## 11. Security Controls

At minimum:
- JWT/OIDC auth
- RBAC in API
- site-aware access checks
- audit on sensitive routes
- rate limiting on public or customer-facing endpoints
- request validation
- idempotency for risky operations

---

## 12. Open Questions for Final Contract

- Will customers self-register or only staff create them in MVP?
- Will public customer status use authenticated access, magic link, or ticket lookup?
- Will POS push events by webhook, polling, or manual export/import?
- Does inventory system support reservation and transfer APIs?
- Does the business want payment links later?

These should be resolved before final production contracts are frozen.
