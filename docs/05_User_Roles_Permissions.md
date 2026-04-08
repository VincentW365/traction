# 05_User_Roles_Permissions.md

## Purpose

This document defines who does what inside the platform and what each role is allowed to do.

The full matrix is in:
- `data/roles_permissions_matrix.csv`

---

## 1. Role Definitions

### Customer
External user viewing or requesting service for their own vehicle.

### Front Desk / Cashier
High-speed operator managing check-in, walk-ins, status visibility, and payment closure steps.

### Service Advisor
Operational planner responsible for appointments, service scope, technician matching, and customer expectation management.

### Technician
Executes work, updates job status, requests escalation, and completes assigned labor.

### Parts / Store Staff
Ensures stock, reservation, transfer, and parts-ready state visibility.

### Transport Coordinator
Manages courtesy transport requests, driver assignment, and transport window communication.

### Manager
Runs the floor, sees operational KPIs, applies overrides, monitors fairness, and tunes operations.

### Admin
Controls system-level users, permissions, configuration, and governance functions.

---

## 2. Permissions Matrix

| permission | Customer | Front Desk / Cashier | Service Advisor | Technician | Parts / Store Staff | Transport Coordinator | Manager | Admin |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| view_own_appointments | Yes | No | No | No | No | No | Yes | Yes |
| create_own_appointment | Yes | No | No | No | No | No | Yes | Yes |
| cancel_own_appointment | Yes | No | No | No | No | No | Yes | Yes |
| view_own_queue_status | Yes | No | No | No | No | No | Yes | Yes |
| create_walkin_visit | No | Yes | Yes | No | No | No | Yes | Yes |
| checkin_customer | No | Yes | Yes | No | No | No | Yes | Yes |
| create_staff_appointment | No | Yes | Yes | No | No | No | Yes | Yes |
| reschedule_appointment | No | Yes | Yes | No | No | No | Yes | Yes |
| confirm_appointment | No | Yes | Yes | No | No | No | Yes | Yes |
| override_queue_order | No | No | No | No | No | No | Yes | Yes |
| create_service_order | No | No | Yes | No | No | No | Yes | Yes |
| edit_service_scope | No | No | Yes | No | No | No | Yes | Yes |
| assign_technician | No | No | Yes | No | No | No | Yes | Yes |
| start_pause_update_service | No | No | No | Yes | No | No | Yes | Yes |
| complete_service_work | No | No | No | Yes | No | No | Yes | Yes |
| request_parts | No | No | Yes | Yes | Yes | No | Yes | Yes |
| reserve_parts | No | No | No | No | Yes | No | Yes | Yes |
| approve_parts_substitution | No | No | Yes | No | No | No | Yes | Yes |
| create_inventory_transfer | No | No | No | No | Yes | No | Yes | Yes |
| create_transport_request | No | Yes | Yes | No | No | Yes | Yes | Yes |
| assign_driver | No | No | No | No | No | Yes | Yes | Yes |
| send_manual_notifications | No | Yes | Yes | No | No | Yes | Yes | Yes |
| process_payment_or_close_order | No | Yes | No | No | No | No | Yes | Yes |
| view_kpi_dashboard | No | No | No | No | No | No | Yes | Yes |
| edit_business_rules | No | No | No | No | No | No | Yes | Yes |
| manage_users_roles | No | No | No | No | No | No | No | Yes |
| view_audit_logs | No | No | No | No | No | No | Yes | Yes |
| export_reports | No | No | No | No | No | No | Yes | Yes |

---

## 3. Access Design Rules

1. Customers should only see their own appointments, visits, and notifications.
2. Front desk and advisors need speed-oriented operational permissions, not system-wide configuration rights.
3. Technicians should not edit global scheduling rules.
4. Parts staff should not be able to reorder the queue.
5. Managers can intervene operationally.
6. Admins manage platform governance and security controls.
7. Overrides and sensitive actions must always be audited.

---

## 4. Sensitive Actions Requiring Audit

At minimum:
- queue override
- service scope changes after approval
- technician reassignment after work start
- parts substitution approval
- transport override
- user role changes
- business-rule changes
- payment-release exceptions

---

## 5. UI Consequences

The platform UI should be role-shaped:

- **Front desk:** rapid check-in, search, queue issue resolution
- **Advisor:** schedule planner, service order editor, assignment tools
- **Technician:** my work, status buttons, parts escalation
- **Parts:** upcoming jobs, shortage board, transfer board
- **Transport:** dispatch board
- **Manager:** live operations + KPI dashboard
- **Admin:** configuration and governance panels

Do not expose a giant universal menu to everyone.
